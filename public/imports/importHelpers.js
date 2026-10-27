/**
 * File → local store importers.
 *
 * All of these stream: rows are pulled from the source in chunks, written to
 * SQLite in transactional batches, and the event loop is released between
 * batches. Nothing builds an array of every row in the file, so import cost is
 * bounded by the batch size rather than the file size — a 5 GB CSV imports in
 * the same memory as a 5 MB one, and the window stays responsive throughout.
 *
 * Column types are inferred from the first `TYPE_SAMPLE_ROWS` rows. A streamed
 * read cannot rewind, so that sample is all we get; values that later
 * contradict it are stored as text rather than dropped (see coerceValue).
 */

const fs = require('fs');
const path = require('path');
const parquet = require('parquetjs');
const avro = require('avsc');
const XLSX = require('xlsx');
const Papa = require('papaparse');

const {
  SampledTableWriter,
  buildHeaders,
  buildSchemaFromInferredTypes,
  dedupeHeaders,
  fileSizeOf,
  normalizeHeader,
  yieldToEventLoop,
} = require('./chunkedWriter');

// Bytes of CSV text Papa hands us per chunk callback.
const CSV_CHUNK_BYTES = 1024 * 1024;

// Rows pulled from a sheet/record stream between event-loop yields.
const STREAM_YIELD_ROWS = 5000;

// XLSX names the single sheet of a CSV workbook "Sheet1"; the CSV fast path
// keeps that name so table names match what the workbook path would produce.
const CSV_SHEET_NAME = 'Sheet1';

const DELIMITED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

/** Wrap a caller's progress callback so every event carries file-level context. */
const progressReporter = (onProgress, base, getDynamic) => {
  if (typeof onProgress !== 'function') return null;
  return (info) => {
    try {
      onProgress({ ...base, ...(getDynamic ? getDynamic() : {}), ...info });
    } catch {
      // Never let a progress listener break an import.
    }
  };
};

/**
 * Import a delimited text file (CSV/TSV) into SQLite.
 *
 * Papa parses off a read stream a megabyte at a time; each chunk is paused
 * while its rows are written, so the reader never runs ahead of the writer.
 */
async function importCsvToSqlite(filePath, sanitizedTableName, db, dbPath, options = {}) {
  const { onProgress = null, sampleSize, batchSize } = options;
  const totalBytes = fileSizeOf(filePath);
  const readStream = fs.createReadStream(filePath);

  const report = progressReporter(
    onProgress,
    { phase: 'writing', file: path.basename(filePath), totalBytes },
    () => ({ bytesRead: readStream.bytesRead }),
  );

  const table = new SampledTableWriter(db, {
    tableName: sanitizedTableName,
    sampleSize,
    batchSize,
    onProgress: report,
  });

  return new Promise((resolve) => {
    let settled = false;
    let sawHeaderRow = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (message) => {
      readStream.destroy();
      finish({ success: false, message });
    };

    readStream.on('error', (err) => fail(`Failed to read CSV: ${err.message}`));

    Papa.parse(readStream, {
      header: false,
      skipEmptyLines: 'greedy',
      chunkSize: CSV_CHUNK_BYTES,

      chunk: (results, parser) => {
        if (settled) { parser.abort(); return; }
        parser.pause();
        (async () => {
          const rows = results.data || [];
          let start = 0;
          if (!sawHeaderRow) {
            if (rows.length === 0) return;
            table.setHeaders(buildHeaders(rows[0]));
            sawHeaderRow = true;
            start = 1;
          }
          for (let i = start; i < rows.length; i++) {
            await table.addRow(rows[i]);
          }
        })().then(
          () => { if (!settled) parser.resume(); },
          (err) => fail(`Failed to import CSV: ${err.message}`),
        );
      },

      complete: () => {
        if (settled) return;
        (async () => {
          if (!sawHeaderRow) {
            finish({ success: false, message: 'No data found in CSV file' });
            return;
          }
          const { rowCount, schema } = await table.finish();
          finish({
            success: true,
            dbPath,
            tableName: sanitizedTableName,
            tables: [sanitizedTableName],
            rowCount,
            message: `Imported ${rowCount} rows from CSV file`,
            schema,
          });
        })().catch((err) => finish({ success: false, message: `Failed to import CSV: ${err.message}` }));
      },

      error: (err) => fail(`Failed to read CSV: ${err.message}`),
    });
  });
}

/**
 * Import one worksheet into its own table, streaming rows out of the sheet
 * rather than materialising them as one array.
 */
async function importWorksheet(worksheet, tableName, db, { onProgress, sampleSize, batchSize }) {
  const table = new SampledTableWriter(db, { tableName, sampleSize, batchSize, onProgress });

  const rowStream = XLSX.stream.to_json(worksheet, { header: 1, defval: null, raw: false });
  let sawHeaderRow = false;
  let sinceYield = 0;

  for await (const row of rowStream) {
    if (!sawHeaderRow) {
      table.setHeaders(buildHeaders(row));
      sawHeaderRow = true;
      continue;
    }
    await table.addRow(row);
    if (++sinceYield >= STREAM_YIELD_ROWS) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }

  if (!sawHeaderRow) return null;
  return table.finish();
}

/**
 * Import a CSV/Excel file into SQLite, one table per sheet.
 *
 * CSV takes the streaming text path; only real workbooks go through XLSX,
 * which has to parse the container up front. Each sheet is released as soon as
 * it is written so a many-sheet workbook does not hold them all at once.
 *
 * @param {string[]} sheets - sheet names to import; empty means all of them.
 */
async function importSpreadsheetToSqlite(filePath, sanitizedTableName, db, dbPath, sheets = [], options = {}) {
  const { onProgress = null, sampleSize, batchSize } = options;

  // A CSV is a single-sheet workbook as far as XLSX is concerned, so route it
  // to the streaming reader while keeping the table name the same.
  if (DELIMITED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    if (sheets.length > 0 && !sheets.includes(CSV_SHEET_NAME)) {
      return { success: false, message: 'No data found in spreadsheet' };
    }
    const result = await importCsvToSqlite(
      filePath,
      `${sanitizedTableName}_${CSV_SHEET_NAME}`,
      db,
      dbPath,
      options,
    );
    if (!result.success) return result;
    return {
      ...result,
      tableName: sanitizedTableName,
      message: `Imported ${result.rowCount} rows into 1 table(s)`,
      schemas: result.schema ? [result.schema] : [],
    };
  }

  try {
    const report = progressReporter(onProgress, { file: path.basename(filePath), totalBytes: fileSizeOf(filePath) });
    if (report) report({ phase: 'reading', rows: 0 });

    // `dense` keeps the parsed workbook in packed arrays instead of one object
    // per cell — a large sheet costs a fraction of the memory that way.
    const workbook = XLSX.readFile(filePath, { cellDates: true, raw: false, dense: true });
    await yieldToEventLoop();

    // A sheet with no dimension reference has no cells; checking `!ref` avoids
    // converting every sheet to JSON just to find out whether it is empty.
    let sheetsToProcess = workbook.SheetNames.filter((name) => Boolean(workbook.Sheets[name]?.['!ref']));
    if (sheets && sheets.length > 0) {
      sheetsToProcess = sheetsToProcess.filter((name) => sheets.includes(name));
      console.log('[importSpreadsheetToSqlite] Importing only selected sheets:', sheets);
    } else {
      console.log('[importSpreadsheetToSqlite] Importing all sheets:', sheetsToProcess);
    }

    if (sheetsToProcess.length === 0) {
      return { success: false, message: 'No data found in spreadsheet' };
    }

    const tables = [];
    const schemas = [];
    let totalRows = 0;

    for (const sheetName of sheetsToProcess) {
      const sanitizedSheetName = String(sheetName)
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^[0-9]/, '_$&')
        .substring(0, 64);
      const tableNameForSheet = `${sanitizedTableName}_${sanitizedSheetName}`;

      const sheetReport = report
        ? (info) => report({ ...info, phase: 'writing', sheet: sheetName })
        : null;

      try {
        const result = await importWorksheet(workbook.Sheets[sheetName], tableNameForSheet, db, {
          onProgress: sheetReport,
          sampleSize,
          batchSize,
        });
        if (!result) continue; // header-less sheet — nothing to import
        tables.push(tableNameForSheet);
        totalRows += result.rowCount;
        if (result.schema) schemas.push(result.schema);
      } catch (sheetErr) {
        console.error(`[importSpreadsheetToSqlite] Sheet "${sheetName}" failed:`, sheetErr);
      } finally {
        // Release the sheet before moving to the next one.
        delete workbook.Sheets[sheetName];
        await yieldToEventLoop();
      }
    }

    if (tables.length === 0) {
      return { success: false, message: 'No data found in spreadsheet' };
    }

    return {
      success: true,
      dbPath,
      tableName: sanitizedTableName,
      tables,
      rowCount: totalRows,
      message: `Imported ${totalRows} rows into ${tables.length} table(s)`,
      schemas,
    };
  } catch (error) {
    console.error('Import to SQLite error:', error);
    return { success: false, message: `Failed to import spreadsheet: ${error.message}` };
  }
}

/**
 * Import a Parquet file into SQLite, reading through the row cursor instead of
 * collecting every record first.
 */
async function importParquetToSqlite(filePath, sanitizedTableName, db, dbPath, options = {}) {
  const { onProgress = null, sampleSize, batchSize } = options;
  let reader = null;

  try {
    reader = await parquet.ParquetReader.openFile(filePath);

    // Leaf field names double as the row keys, but the sanitized version is
    // what SQL sees — look values up by the original path, write them under
    // the safe name.
    const fields = reader.schema.fieldList.map((field) => ({
      path: Array.isArray(field.path) ? field.path : [field.name],
      name: field.name,
    }));
    const headers = dedupeHeaders(fields.map((field, index) => normalizeHeader(field.name, index)));

    if (headers.length === 0) {
      return { success: false, message: 'No columns found in Parquet file' };
    }

    const report = progressReporter(onProgress, {
      phase: 'writing',
      file: path.basename(filePath),
      totalBytes: fileSizeOf(filePath),
    });

    const table = new SampledTableWriter(db, {
      tableName: sanitizedTableName,
      sampleSize,
      batchSize,
      onProgress: report,
    });
    table.setHeaders(headers);

    const valueAt = (record, fieldPath) => {
      let value = record;
      for (const key of fieldPath) {
        if (value === null || value === undefined) return null;
        value = value[key];
      }
      return value === undefined ? null : value;
    };

    const cursor = reader.getCursor();
    let sawRow = false;
    let sinceYield = 0;
    let record = await cursor.next();

    while (record) {
      sawRow = true;
      await table.addRow(fields.map((field) => valueAt(record, field.path)));
      if (++sinceYield >= STREAM_YIELD_ROWS) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
      record = await cursor.next();
    }

    if (!sawRow) {
      return { success: false, message: 'No data found in Parquet file' };
    }

    const { rowCount, schema } = await table.finish();
    return {
      success: true,
      dbPath,
      tableName: sanitizedTableName,
      tables: [sanitizedTableName],
      rowCount,
      message: `Imported ${rowCount} rows from Parquet file`,
      schema,
    };
  } catch (error) {
    console.error('Parquet import error:', error);
    return { success: false, message: `Failed to import Parquet: ${error.message}` };
  } finally {
    if (reader) await reader.close().catch(() => {});
  }
}

/**
 * Import an Avro file into SQLite, consuming the decoder as an async iterable
 * so records are written as fast as they are read and no faster.
 */
async function importAvroToSqlite(filePath, sanitizedTableName, db, dbPath, options = {}) {
  const { onProgress = null, sampleSize, batchSize } = options;

  try {
    const report = progressReporter(onProgress, {
      phase: 'writing',
      file: path.basename(filePath),
      totalBytes: fileSizeOf(filePath),
    });

    const table = new SampledTableWriter(db, {
      tableName: sanitizedTableName,
      sampleSize,
      batchSize,
      onProgress: report,
    });

    // createFileDecoder opens the path itself — handing it a stream throws.
    const decoder = avro.createFileDecoder(filePath);
    let fieldNames = null;
    let sinceYield = 0;

    for await (const record of decoder) {
      if (!fieldNames) {
        fieldNames = Object.keys(record);
        if (fieldNames.length === 0) {
          return { success: false, message: 'No columns found in Avro file' };
        }
        table.setHeaders(dedupeHeaders(fieldNames.map(normalizeHeader)));
      }
      await table.addRow(fieldNames.map((name) => record[name]));
      if (++sinceYield >= STREAM_YIELD_ROWS) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }

    if (!fieldNames) {
      return { success: false, message: 'No data found in Avro file' };
    }

    const { rowCount, schema } = await table.finish();
    return {
      success: true,
      dbPath,
      tableName: sanitizedTableName,
      tables: [sanitizedTableName],
      rowCount,
      message: `Imported ${rowCount} rows from Avro file`,
      schema,
    };
  } catch (error) {
    console.error('Avro import error:', error);
    return { success: false, message: `Failed to import Avro: ${error.message}` };
  }
}

/**
 * Read just the first `limit` data rows of a delimited file.
 *
 * Previews only ever show the head of a file, so this aborts the read as soon
 * as it has enough rows — a 5 GB CSV costs the same as a small one. XLSX's
 * reader can't do that for text files: it pulls the whole thing into memory
 * before `sheetRows` gets a chance to limit anything.
 *
 * @returns {Promise<{ columns: string[], rows: object[] }>}
 */
function readDelimitedHead(filePath, limit = 1000) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath);
    let columns = null;
    const rows = [];
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      readStream.destroy();
      resolve({ columns: columns || [], rows });
    };

    readStream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    Papa.parse(readStream, {
      header: false,
      skipEmptyLines: 'greedy',
      preview: limit + 1, // header row plus the rows we want
      chunkSize: CSV_CHUNK_BYTES,
      chunk: (results, parser) => {
        for (const row of results.data || []) {
          if (!columns) {
            columns = (row || []).map((cell, index) => {
              const text = cell === null || cell === undefined ? '' : String(cell).replace(/^\uFEFF/, '').trim();
              return text === '' ? `Column ${index + 1}` : text;
            });
            continue;
          }
          const record = {};
          columns.forEach((name, index) => { record[name] = row ? row[index] : null; });
          rows.push(record);
        }
        if (rows.length >= limit) {
          parser.abort();
          done();
        }
      },
      complete: done,
      error: (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
    });
  });
}

/** First non-whitespace character of a file, used to tell `[...]` from `{...}`. */
function firstMeaningfulChar(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.slice(0, bytes).toString('utf8').replace(/^\uFEFF/, '');
    const match = text.match(/\S/);
    return match ? match[0] : '';
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  importParquetToSqlite,
  importAvroToSqlite,
  importSpreadsheetToSqlite,
  importCsvToSqlite,
  buildSchemaFromInferredTypes,
  readDelimitedHead,
  DELIMITED_EXTENSIONS,
};
