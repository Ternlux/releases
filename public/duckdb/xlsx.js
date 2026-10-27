/**
 * Workbook-aware helpers for the two things DuckDB's excel extension does not do.
 *
 * DuckDB reads a workbook perfectly well — `read_xlsx(path, sheet = 'Items')` —
 * so nothing here is on the read path. What it cannot do is:
 *
 *   LIST the sheets. There is no `xlsx_sheets()` function, and a connection has
 *     to know what a workbook holds before it can register a table per sheet.
 *
 *   WRITE one sheet. `COPY … TO 'book.xlsx' (FORMAT xlsx)` builds a NEW
 *     workbook containing only what it was given — verified: writing `Orders`
 *     back to a two-sheet book leaves a file with `Orders` and nothing else.
 *     For a single-sheet workbook that is exactly right and DuckDB does it. For
 *     a multi-sheet one it is silent data loss, so the write goes through
 *     `replaceSheet` below, which rewrites the workbook around the one sheet
 *     that changed.
 *
 * Both use the `xlsx` package, required lazily so a session that never opens a
 * spreadsheet never pays to load it.
 */

const fs = require('fs');
const path = require('path');

/** Extensions the excel extension can read — an OOXML zip, in both cases. */
const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm']);

/**
 * Legacy spreadsheet formats DuckDB cannot open, kept separate from "unknown"
 * so the app can say WHY rather than "unsupported file".
 *
 *   .xls  is BIFF, not a zip at all — `IO Error: Failed to open zip for reading`
 *   .xlsb is a zip of binary parts — `No xl/workbook.xml found in xlsx file`
 */
const LEGACY_EXTENSIONS = new Set(['.xls', '.xlsb']);

const extensionOf = (filePath) => path.extname(String(filePath || '')).toLowerCase();

const isWorkbook = (filePath) => WORKBOOK_EXTENSIONS.has(extensionOf(filePath));
const isLegacyWorkbook = (filePath) => LEGACY_EXTENSIONS.has(extensionOf(filePath));

/** What to tell a user who picked a format DuckDB will not open. */
const legacyMessage = (filePath) => (
  extensionOf(filePath) === '.xls'
    ? `Excel 97–2003 (.xls) files are not supported. Open "${path.basename(filePath)}" in Excel and save it as .xlsx.`
    : `Binary Excel (.xlsb) files are not supported. Open "${path.basename(filePath)}" in Excel and save it as .xlsx.`
);

/**
 * The sheet names in a workbook, in workbook order.
 *
 * `bookSheets` parses the workbook's index and none of its cells, so this stays
 * cheap on a large file. Empty sheets are still listed — whether a sheet has
 * anything readable in it is DuckDB's call, made when the caller probes it.
 */
function listSheets(filePath) {
  // eslint-disable-next-line global-require
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath, { bookSheets: true });
  return workbook.SheetNames || [];
}

/**
 * The used range of a sheet as { startCol, endCol, endRow } (letters, letters,
 * 1-based row), or null when it cannot be read. `sheet` null means the first.
 *
 * Read with `sheetRows` so only a few rows are parsed; `!fullref` still carries
 * the sheet's whole dimension. Used to tell DuckDB where a table starts when its
 * header is not on row 1 (see readOptions.js).
 */
function usedRange(filePath, sheet = null) {
  try {
    // eslint-disable-next-line global-require
    const XLSX = require('xlsx');
    const name = sheet || listSheets(filePath)[0];
    if (!name) return null;
    const wb = XLSX.readFile(filePath, { sheets: [name], sheetRows: 2 });
    const ws = wb.Sheets[name];
    const ref = ws && (ws['!fullref'] || ws['!ref']);
    if (!ref) return null;
    const r = XLSX.utils.decode_range(ref);
    return {
      startCol: XLSX.utils.encode_col(r.s.c),
      endCol: XLSX.utils.encode_col(r.e.c),
      endRow: r.e.r + 1,
    };
  } catch (_err) {
    return null;
  }
}

/**
 * A cell value a spreadsheet can hold.
 *
 * Rows arrive from DuckDB already reduced to JSON-safe values, which still
 * leaves STRUCT and LIST columns as objects and arrays. A cell cannot hold one,
 * so they are written as their JSON text — the same thing the grid shows.
 */
function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Replace ONE sheet's contents, leaving the rest of the workbook alone.
 *
 * The existing file is read, the named sheet is swapped for the rows given, and
 * the whole book is written to a sibling temp file and renamed into place — so
 * a failure part-way leaves the original untouched, exactly as copyToFile does.
 *
 * What survives is every other sheet's data and this sheet's new values. What
 * does not is anything the xlsx package cannot round-trip — charts, pivot
 * tables, conditional formatting, and the macros in a .xlsm. A workbook that
 * carries those is better exported with `COPY … TO` than edited in place.
 *
 * @param {string} filePath   the workbook to rewrite
 * @param {string} sheetName  the sheet to replace
 * @param {object[]} rows     the sheet's new contents
 * @param {string[]} columns  column order, since rows are unordered objects
 */
function replaceSheet(filePath, sheetName, rows, columns) {
  return writeSheet(filePath, sheetName, rows, columns);
}

/**
 * A sheet name Excel will accept.
 *
 * Excel rejects a name over 31 characters or containing any of `\ / ? * [ ] :`,
 * and refuses one wrapped in apostrophes. A table name is not bound by any of
 * that — `analytics/q3_summary` is a perfectly ordinary one — so a name derived
 * from a table has to be brought inside those rules before it can be written,
 * or the workbook is rejected at save time with nothing to explain why.
 *
 * @param {string} name       the name to make legal
 * @param {string} [fallback] used when nothing legal survives
 */
function sanitizeSheetName(name, fallback = 'Data') {
  const cleaned = String(name || '')
    .replace(/[\\/?*[\]:]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .trim();
  return cleaned || fallback;
}

/**
 * Write ONE sheet, creating the workbook if it isn't there yet.
 *
 * The two cases an output node meets. A workbook that already exists is read
 * and rewritten around the named sheet, so every OTHER sheet in it survives —
 * which is what lets several output nodes write several sheets of one file, one
 * node per sheet. A path with no file at it gets a new workbook holding just
 * this sheet.
 *
 * Either way the book goes to a sibling temp file and is renamed into place, so
 * a failure part-way leaves whatever was there untouched.
 *
 * @param {string} filePath   the workbook to write
 * @param {string} sheetName  the sheet to create or replace
 * @param {object[]} rows     the sheet's contents
 * @param {string[]} columns  column order, since rows are unordered objects
 */
// The xlsx FORMAT holds at most 1,048,576 rows per sheet — a hard limit of the
// file format, not of any writer. One row is the header, so this is the data
// ceiling. Excel itself refuses to open anything claiming more.
const XLSX_MAX_DATA_ROWS = 1048575;

// What THIS writer can build below that ceiling. SheetJS (0.18.5, the last npm
// release) stores a sheet as one object with a property per cell, and V8
// refuses to enumerate an object past ~8.3M properties — the observed failure
// was "RangeError: Too many properties to enumerate" from inside
// json_to_sheet. So a sheet that is legal for the format can still be too big
// for the writer when it is wide: 1M rows × 10 columns is 10M cells. Newer
// SheetJS has a dense (array-backed) mode that lifts this, but 0.18.5's
// json_to_sheet silently ignores `dense: true` (verified), so the budget is
// enforced instead of crashed into. Margin kept under the hard limit.
const SHEETJS_CELL_BUDGET = 8000000;

/**
 * Throw with a clear account if a sheet of `rowCount` data rows can't be
 * written — either at all (format limit) or by this writer (cell budget).
 *
 * @param {number} rowCount  Data rows, excluding the header.
 * @param {number} [colCount] Columns, when known. The format check runs
 *   without it; the cell-budget check needs it.
 * @param {string} [rowCountLabel] Optional wording for the row count — the
 *   early bail in the output reader stops counting at the cap, so it says
 *   "more than N" rather than claiming a total it never measured.
 */
/**
 * The most data rows a sheet of `colCount` columns can actually hold here —
 * the format's own ceiling, or the writer's cell budget, whichever bites first.
 *
 * Lets a reader stop at the real limit rather than at the row limit alone: a
 * 12-column source runs out of cells at ~666k rows, well before 1,048,575, and
 * without this the extra 230k rows are read only to be thrown away.
 *
 * @param {number} [colCount] Columns. Unknown (0/null) gives the row ceiling.
 */
function maxDataRowsFor(colCount = 0) {
  if (!colCount || colCount < 1) return XLSX_MAX_DATA_ROWS;
  // -1 for the header row, which spends cells too.
  const byCells = Math.floor(SHEETJS_CELL_BUDGET / colCount) - 1;
  return Math.max(0, Math.min(XLSX_MAX_DATA_ROWS, byCells));
}

/**
 * Stop a read that has already gone past what a sheet can hold.
 *
 * Called while the source is still being read, so the row count is a FLOOR, not
 * a total — the message says "more than N" rather than inventing a size that
 * was never measured.
 *
 * @param {number} rowsSoFar Rows read so far.
 * @param {number} [colCount] Columns, from the first row.
 */
function assertSheetBudgetSoFar(rowsSoFar, colCount = 0) {
  const cap = maxDataRowsFor(colCount);
  if (rowsSoFar <= cap) return;

  const limitedByCells = colCount >= 1 && cap < XLSX_MAX_DATA_ROWS;
  throw new Error(
    `An Excel sheet here holds at most ${cap.toLocaleString()} data rows`
    + (limitedByCells
      ? ` at ${colCount} columns (the writer's ${SHEETJS_CELL_BUDGET.toLocaleString()}-cell limit)`
      : ' (the limit of the .xlsx format)')
    + `, and this source has more than that. `
    + 'Export to CSV or Parquet instead, or reduce the rows'
    + (limitedByCells ? ' or columns' : '') + ' with a transformer first.',
  );
}

function assertSheetFits(rowCount, colCount = null, rowCountLabel = null) {
  const have = rowCountLabel || `${rowCount.toLocaleString()} rows`;
  if (rowCount > XLSX_MAX_DATA_ROWS) {
    throw new Error(
      `An Excel sheet holds at most ${XLSX_MAX_DATA_ROWS.toLocaleString()} data rows and this source has ${have}. `
      + 'Export to CSV or Parquet instead, or reduce the rows with a transformer first.',
    );
  }
  if (colCount && (rowCount + 1) * colCount > SHEETJS_CELL_BUDGET) {
    throw new Error(
      `This sheet needs ${((rowCount + 1) * colCount).toLocaleString()} cells `
      + `(${have} × ${colCount} columns), which is more than the Excel writer can build `
      + `(${SHEETJS_CELL_BUDGET.toLocaleString()}). `
      + 'Export to CSV or Parquet instead, or reduce the rows or columns with a transformer first.',
    );
  }
}

function writeSheet(filePath, sheetName, rows, columns) {
  // eslint-disable-next-line global-require
  const XLSX = require('xlsx');

  // An existing workbook is preserved around this sheet; anything else — no
  // file, or a path whose extension isn't one we can read back — starts fresh.
  const existing = isWorkbook(filePath) && fs.existsSync(filePath);
  const workbook = existing ? XLSX.readFile(filePath, { cellDates: true }) : XLSX.utils.book_new();
  const sheet = sanitizeSheetName(sheetName);
  const header = columns && columns.length ? columns : Object.keys(rows[0] || {});

  // Refused up front, with the reason, rather than crashed into: past these
  // sizes json_to_sheet dies mid-build with "Too many properties to enumerate",
  // an error that names neither the sheet nor what to do about it.
  assertSheetFits((rows || []).length, header.length);
  const cleaned = (rows || []).map((row) => {
    const out = {};
    for (const name of header) out[name] = cellValue(row ? row[name] : null);
    return out;
  });

  workbook.Sheets[sheet] = XLSX.utils.json_to_sheet(cleaned, { header });
  if (!workbook.SheetNames.includes(sheet)) workbook.SheetNames.push(sheet);

  const bookType = extensionOf(filePath) === '.xlsm' ? 'xlsm' : 'xlsx';
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    XLSX.writeFile(workbook, tempPath, { bookType });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return filePath;
}

module.exports = {
  usedRange,
  LEGACY_EXTENSIONS,
  WORKBOOK_EXTENSIONS,
  isLegacyWorkbook,
  isWorkbook,
  legacyMessage,
  listSheets,
  replaceSheet,
  writeSheet,
  sanitizeSheetName,
  XLSX_MAX_DATA_ROWS,
  SHEETJS_CELL_BUDGET,
  maxDataRowsFor,
  assertSheetBudgetSoFar,
  assertSheetFits,
};
