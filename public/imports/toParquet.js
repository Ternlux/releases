/**
 * Conversion for the formats DuckDB cannot read.
 *
 * CSV, JSON and Parquet are queried where they sit and never come through
 * here. Excel and Avro are converted to Parquet exactly once, when the file is
 * added, so everything downstream sees one uniform thing: a path DuckDB can
 * read. That also avoids DuckDB's `excel` and `avro` extensions, which
 * autoload over the network and so can't be relied on in a desktop app.
 *
 * The readers are the same streaming ones the old SQLite importer used — rows
 * are pulled a few thousand at a time and handed straight to the Parquet
 * writer, so a workbook is never held twice.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const avro = require('avsc');

const duck = require('../duckdb');
const { buildHeaders } = require('./chunkedWriter');

const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb']);
const AVRO_EXTENSIONS = new Set(['.avro']);

/** Does this file need converting before DuckDB can read it? */
const needsConversion = (filePath) => {
  const ext = path.extname(String(filePath)).toLowerCase();
  return EXCEL_EXTENSIONS.has(ext) || AVRO_EXTENSIONS.has(ext);
};

const isSupported = (filePath) =>
  duck.isReadable(filePath) || needsConversion(filePath);

const sanitize = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

/**
 * Stable per-source folder, so re-adding the same file reuses its conversion
 * rather than accumulating copies.
 */
function conversionDir(filePath, userDataDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 10);
  const base = sanitize(path.basename(filePath, path.extname(filePath)));
  return path.join(userDataDir, 'converted-files', `${base}-${hash}`);
}

/** Rows of one worksheet as objects, streamed. */
async function* worksheetRows(worksheet) {
  const stream = XLSX.stream.to_json(worksheet, { header: 1, defval: null, raw: false });
  let headers = null;
  for await (const row of stream) {
    if (!headers) { headers = buildHeaders(row); continue; }
    const record = {};
    headers.forEach((name, i) => { record[name] = row ? row[i] : null; });
    yield record;
  }
}

/**
 * Convert a workbook. One Parquet file per non-empty sheet, mirroring the
 * old importer's one-table-per-sheet behaviour.
 */
async function convertWorkbook(filePath, outDir, onProgress) {
  // `dense` keeps the parsed workbook in packed arrays rather than an object
  // per cell. The container still has to be parsed up front — that is a limit
  // of the xlsx format, and the reason Excel is converted once rather than
  // read repeatedly.
  const workbook = XLSX.readFile(filePath, { cellDates: true, raw: false, dense: true });
  const sheetNames = workbook.SheetNames.filter((name) => Boolean(workbook.Sheets[name]?.['!ref']));
  if (sheetNames.length === 0) throw new Error('No data found in spreadsheet');

  const tables = [];
  for (const sheetName of sheetNames) {
    const outPath = path.join(outDir, `${sanitize(sheetName)}.parquet`);
    try {
      const { rowCount } = await duck.ingestRows(worksheetRows(workbook.Sheets[sheetName]), outPath, {
        onProgress: onProgress && ((info) => onProgress({ ...info, sheet: sheetName, phase: 'converting' })),
      });
      tables.push({ name: sheetName, path: outPath, rowCount });
    } catch (error) {
      // A sheet with a header and no rows is normal in a real workbook; don't
      // fail the whole import for it.
      console.warn(`[toParquet] Skipped sheet "${sheetName}": ${error.message}`);
    } finally {
      delete workbook.Sheets[sheetName]; // release before the next sheet
    }
  }

  if (tables.length === 0) throw new Error('No data found in spreadsheet');
  return tables;
}

/** Avro records, streamed straight off the decoder. */
async function* avroRecords(filePath) {
  // createFileDecoder opens the path itself — handing it a stream throws.
  yield* avro.createFileDecoder(filePath);
}

async function convertAvro(filePath, outDir, onProgress) {
  const name = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(outDir, `${sanitize(name)}.parquet`);
  const { rowCount } = await duck.ingestRows(avroRecords(filePath), outPath, {
    onProgress: onProgress && ((info) => onProgress({ ...info, phase: 'converting' })),
  });
  return [{ name, path: outPath, rowCount }];
}

/**
 * Convert a file DuckDB can't read into one or more Parquet files.
 *
 * @param {string} filePath
 * @param {string} userDataDir - app userData; conversions live under it
 * @param {{ onProgress?: (info: object) => void }} options
 * @returns {Promise<Array<{ name: string, path: string, rowCount: number }>>}
 */
async function convertToParquet(filePath, userDataDir, { onProgress = null } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const outDir = conversionDir(filePath, userDataDir);
  fs.rmSync(outDir, { recursive: true, force: true }); // re-adding replaces
  fs.mkdirSync(outDir, { recursive: true });

  if (EXCEL_EXTENSIONS.has(ext)) return convertWorkbook(filePath, outDir, onProgress);
  if (AVRO_EXTENSIONS.has(ext)) return convertAvro(filePath, outDir, onProgress);
  throw new Error(`No converter for "${path.basename(filePath)}"`);
}

/**
 * Everything the app needs to record a local file as a connection.
 *
 * Readable formats are registered as-is — nothing is copied or imported, the
 * connection simply remembers the path. Others are converted first.
 *
 * @returns {Promise<{ success, format, converted, tables: Array<{name, path, rowCount, schema}> }>}
 */
async function registerLocalFile(filePath, userDataDir, { onProgress = null } = {}) {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: `File not found: ${filePath}` };
  }
  if (!isSupported(filePath)) {
    return { success: false, message: `Unsupported file type: ${path.extname(filePath) || filePath}` };
  }

  try {
    const converted = needsConversion(filePath);
    const tables = converted
      ? await convertToParquet(filePath, userDataDir, { onProgress })
      : [{ name: path.basename(filePath, path.extname(filePath)), path: filePath, rowCount: null }];

    // Schemas come from DuckDB itself rather than our own inference, and are
    // what the node chats and prompts read later.
    for (const table of tables) {
      try {
        table.schema = await duck.fileSchema(table.path);
        table.schema.tableName = table.name;
      } catch (error) {
        console.warn(`[registerLocalFile] Could not describe ${table.path}: ${error.message}`);
        table.schema = null;
      }
    }

    return {
      success: true,
      converted,
      format: converted ? 'parquet' : duck.detectFormat(filePath),
      tables,
    };
  } catch (error) {
    console.error('[registerLocalFile]', error);
    return { success: false, message: error.message };
  }
}

module.exports = {
  registerLocalFile,
  convertToParquet,
  needsConversion,
  isSupported,
  conversionDir,
};
