/**
 * Per-file read settings a user chose when adding a file: today, which row the
 * header is on.
 *
 * A spreadsheet often carries a title above its header — a merged "Q1 Sales
 * Report" across A1:C1, the real header on row 2. Read from A1, DuckDB took the
 * title as the header, found B1 and C1 empty and stopped there: a three-column
 * sheet loaded as ONE column, the other two silently gone. A CSV export with a
 * banner line has the same problem.
 *
 * Kept in one small JSON file under userData, keyed by the file's absolute path
 * (and sheet, for a workbook), because a file is read from many places — the
 * explorer, data sources, transformers, joins, outputs — and every one of them
 * goes through sourceRef. Looking the setting up there means no caller has to
 * carry it, and a setting can never be honoured by one reader and missed by
 * another.
 */

const fs = require('fs');
const path = require('path');

let cache = null;

function storePath() {
  // eslint-disable-next-line global-require
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'file-read-options.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(storePath(), 'utf8')) || {};
  } catch (_err) {
    cache = {};   // no file yet, or not running under Electron (tests)
  }
  return cache;
}

const keyFor = (filePath, sheet) => `${path.resolve(String(filePath))}${sheet ? `#${sheet}` : ''}`;

/**
 * The 1-based row the header is on, or 1 when nothing was set. A sheet-level
 * setting wins over a whole-file one.
 */
function headerRowFor(filePath, sheet = null) {
  const store = load();
  const n = Number(
    (sheet && store[keyFor(filePath, sheet)]?.headerRow)
    || store[keyFor(filePath, null)]?.headerRow,
  );
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** Record the header row for a file (all sheets) or one sheet. 1 clears it. */
function setHeaderRow(filePath, headerRow, sheet = null) {
  const store = load();
  const key = keyFor(filePath, sheet);
  const n = Number(headerRow);
  if (!Number.isInteger(n) || n <= 1) delete store[key];
  else store[key] = { ...(store[key] || {}), headerRow: n };
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn('[readOptions] Could not save file read options:', err.message);
  }
}

/**
 * Replace every header-row setting for a file in one go: a whole-file row and,
 * for a workbook, one per sheet. Re-adding or editing a file states its
 * settings in full, so whatever was recorded before for it is dropped first —
 * a sheet left out returns to row 1.
 *
 * @param {string} filePath
 * @param {number} headerRow - Whole-file row (1 = none).
 * @param {Record<string, number>|null} perSheet - sheet name -> row.
 */
function replaceHeaderRows(filePath, headerRow = 1, perSheet = null) {
  const store = load();
  const fileKey = keyFor(filePath, null);
  for (const key of Object.keys(store)) {
    if (key === fileKey || key.startsWith(`${fileKey}#`)) delete store[key];
  }
  const keep = (key, value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 1) store[key] = { headerRow: n };
  };
  keep(fileKey, headerRow);
  for (const [sheet, value] of Object.entries(perSheet || {})) keep(keyFor(filePath, sheet), value);
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn('[readOptions] Could not save file read options:', err.message);
  }
}

module.exports = { headerRowFor, setHeaderRow, replaceHeaderRows };
