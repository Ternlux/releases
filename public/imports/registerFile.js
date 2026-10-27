/**
 * Recording a local file as a data source.
 *
 * Nothing is imported and nothing is converted. Every format the app accepts —
 * csv, json, parquet, xlsx and avro — is one DuckDB can read where it lies, so
 * adding a file is a matter of working out what tables it holds and asking
 * DuckDB to describe them. Adding a 5 GB file is as quick as a 5 KB one.
 *
 * This replaces the old convert-to-Parquet step. Excel and Avro used to be
 * rewritten as Parquet under userData because DuckDB could not read them; it
 * can now (public/duckdb/extensions.js ships the extensions), and reading the
 * real file is what lets an edit be written back INTO it.
 *
 * A workbook is the one file that holds more than one table: each sheet becomes
 * a table of its own, all sharing the workbook's path and told apart by name.
 */

const fs = require('fs');
const path = require('path');

const duck = require('../duckdb');
const xlsx = require('../duckdb/xlsx');

/**
 * Describe one table, or explain why it can't be read.
 *
 * A sheet with nothing in it is the ordinary case — real workbooks carry them —
 * and DuckDB says so plainly (`No rows found in xlsx file`). Such a sheet is
 * dropped rather than failing the whole file.
 */
async function describeTable(table, format) {
  const schema = await duck.fileSchema(table.path, { format, sheet: table.sheet });
  schema.tableName = table.name;
  return { ...table, schema, ...(format === 'xlsx' ? headerWarning(table, schema) : {}) };
}

/**
 * A warning when a sheet read FEWER columns than its used range spans — the
 * shape of a title above the header: DuckDB takes the title row as the header
 * and stops at its first empty cell, so the columns after it are not read.
 * Compares two facts (the column count DuckDB returned, the sheet's dimension);
 * nothing is guessed from the cell contents.
 */
function headerWarning(table, schema) {
  const used = xlsx.usedRange(table.path, table.sheet);
  if (!used) return {};
  const span = colNumber(used.endCol) - colNumber(used.startCol) + 1;
  const read = Array.isArray(schema?.columns) ? schema.columns.length : 0;
  if (read === 0 || read >= span) return {};
  return {
    warning: `"${table.name}" spans ${span} columns but only ${read} could be read from its first row. `
      + 'If there is a title or notes above the header, edit this connection and set this sheet\'s '
      + '"Header row" to the row that holds the column names.',
  };
}

const colNumber = (letters) => String(letters).split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

/**
 * Everything the app needs to record a local file as a connection.
 *
 * @param {string} filePath
 * @param {string} _userDataDir - unused now that nothing is converted; kept so
 *   the IPC handler's call site does not have to change shape.
 * @param {{ onProgress?: (info: object) => void }} options
 * @returns {Promise<{ success, format, tables: Array<{name, path, sheet, schema}> }>}
 */
async function registerLocalFile(filePath, _userDataDir, { onProgress = null } = {}) {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: `File not found: ${filePath}` };
  }
  // Said before the generic "unsupported" below, because a user with a .xls has
  // a fix available and deserves to be told what it is.
  if (duck.isLegacyWorkbook(filePath)) {
    return { success: false, message: duck.legacyWorkbookMessage(filePath) };
  }
  if (!duck.isReadable(filePath)) {
    return {
      success: false,
      message: `Unsupported file type: ${path.extname(filePath) || filePath}`,
    };
  }

  try {
    const format = duck.detectFormat(filePath);

    // A workbook is many tables in one file; everything else is one table named
    // after the file.
    const candidates = format === 'xlsx'
      ? duck.listSheets(filePath).map((sheet) => ({ name: sheet, path: filePath, sheet }))
      : [{ name: path.basename(filePath, path.extname(filePath)), path: filePath, sheet: null }];

    if (candidates.length === 0) throw new Error('No sheets found in workbook');

    const tables = [];
    for (const [index, candidate] of candidates.entries()) {
      if (onProgress) {
        onProgress({
          phase: 'describing',
          sheet: candidate.sheet,
          rows: index,
          total: candidates.length,
        });
      }
      try {
        tables.push(await describeTable(candidate, format));
      } catch (error) {
        if (candidates.length === 1) throw error;
        console.warn(`[registerLocalFile] Skipped sheet "${candidate.sheet}": ${error.message}`);
      }
    }

    if (tables.length === 0) throw new Error(`No readable data found in ${path.basename(filePath)}`);

    return { success: true, format, tables };
  } catch (error) {
    console.error('[registerLocalFile]', error);
    return { success: false, message: error.message };
  }
}

/**
 * The table names a data file exposes RIGHT NOW, read from the file itself.
 *
 * A connection records its tables once, when it is created. That snapshot goes
 * stale the moment the file changes underneath it: a sheet added to a workbook
 * is invisible, and a sheet deleted is still offered. Callers that want the
 * current answer ask the file, and fall back to the snapshot only when this
 * cannot answer.
 *
 * Deliberately mirrors registerLocalFile's candidate naming above — a workbook
 * is its sheets, anything else is one table named after the file — so a live
 * listing and a recorded one use the same names for the same tables. It stops
 * at names: no `describeTable`, so no DuckDB read per sheet. Callers wanting
 * columns already have getColumns for that.
 *
 * Returns [] rather than throwing for anything it cannot read (a missing file,
 * a database file like .duckdb/.sqlite, a legacy .xls), leaving the caller free
 * to fall back.
 */
function listFileTables(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  if (duck.isLegacyWorkbook(filePath) || !duck.isReadable(filePath)) return [];
  try {
    if (duck.detectFormat(filePath) === 'xlsx') return duck.listSheets(filePath);
    return [path.basename(filePath, path.extname(filePath))];
  } catch (error) {
    console.warn(`[listFileTables] ${filePath}: ${error.message}`);
    return [];
  }
}

module.exports = { registerLocalFile, listFileTables };
