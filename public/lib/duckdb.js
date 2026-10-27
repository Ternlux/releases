/**
 * Local DuckDB helper. Same shape as lib/sqlite.js — runQuery({ dbPath, query })
 * plus getTables / getColumns — so the skill-helper layer can address local
 * data the same way it addresses any other local store.
 *
 * `dbPath` is one of two things:
 *
 *   • a database (`*.duckdb`, or a `*.sqlite` / `*.db` DuckDB reads through its
 *     sqlite extension) — its tables are attached under an alias and a query
 *     names them directly: `SELECT * FROM orders_clean`.
 *   • a data file (csv / json / parquet) — not a database. It is registered as
 *     a view named after itself, so `SELECT * FROM orders` means the file.
 */

const path = require('path');
const duck = require('../duckdb');

/**
 * True when the path is a database rather than a data file.
 *
 * The shared predicate, not a local one. This used to test `/\.duckdb$/`, which
 * left SQLite out — so a `.sqlite` / `.db` file reached through here was taken
 * for a data file and handed to `tableRef`, which knows nothing about database
 * formats and answered "DuckDB cannot read transcripts.sqlite — supported
 * formats are csv, json, parquet, xlsx and avro" for a file the Data Explorer
 * browses perfectly well. The Explorer goes through the connector, whose own
 * rule always included SQLite; this module had a third copy that disagreed.
 */
const isDb = duck.isDatabaseFile;

/** The view name a bare file is addressable by. */
const viewNameFor = (dbPath) => path.basename(dbPath, path.extname(dbPath)) || 'data';

// The views are rebuilt on every call so an edited file is picked up, which
// would otherwise repeat the same complaint about the same empty sheet for the
// life of the process.
const warned = new Set();
const firstLine = (message) => String(message || '').split('\n')[0];
const warnOnce = (key, message) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
};

/**
 * The names a file is addressable by.
 *
 * One per SHEET for a workbook — a workbook is several tables in one file, and
 * naming them all after the file would make every sheet but the first
 * unreachable. Everything else is a single table named after the file.
 */
function viewNamesFor(dbPath) {
  return duck.isWorkbook(dbPath) ? duck.listSheets(dbPath) : [viewNameFor(dbPath)];
}

/**
 * Make every table in `dbPath` queryable by name on the shared connection.
 *
 * For a database this attaches it and returns the alias; for a file it
 * (re)creates a view per table, recreated per call so a file rewritten on disk
 * — a node output being overwritten — is picked up.
 *
 * @returns {Promise<string[]>} the names registered, or [alias] for a database
 */
async function ensureViews(dbPath) {
  if (!dbPath) throw new Error('DuckDB runQuery requires dbPath');
  if (isDb(dbPath)) return [await duck.attachDb(dbPath)];

  // Resolved once: for a workbook this reads the file's index, and the views
  // are rebuilt on every call.
  const names = viewNamesFor(dbPath);

  const registered = [];
  for (const name of names) {
    try {
      const ref = await duck.tableRef(dbPath, null, { sheet: duck.sheetFor(dbPath, name) });
      await duck.exec(`CREATE OR REPLACE VIEW ${duck.quoteIdentifier(name)} AS SELECT * FROM ${ref}`);
      registered.push(name);
    } catch (err) {
      // An empty sheet has nothing for DuckDB to describe, and real workbooks
      // carry them. Leaving it unregistered is what keeps it out of getTables;
      // failing here would take the readable sheets down with it. A file with
      // only one table has no such spare, so its failure is the caller's.
      if (names.length === 1) throw err;
      warnOnce(`${dbPath}#${name}`, `[lib/duckdb] Skipped sheet "${name}": ${firstLine(err.message)}`);
    }
  }
  if (registered.length === 0) throw new Error(`No readable tables in ${path.basename(dbPath)}`);
  return registered;
}

/**
 * The scope an unqualified query resolves against: a database's alias, or the
 * first table of a file. Kept for callers that only need somewhere to point.
 */
async function ensureView(dbPath) {
  const [first] = await ensureViews(dbPath);
  return first;
}

/**
 * runQuery({ dbPath, query })                      — read, returns rows
 * runQuery({ dbPath, operation: 'insert', docs })  — write rows
 *
 * The write form mirrors the old local-store shape, so a caller that used to write a
 * local collection can address local data the same way. Where the rows land
 * follows the path: a database gets a table (`tableName` required), a file is
 * written in its own format. `mode: 'append'` only applies to a table — a file
 * is rewritten whole.
 */
async function runQuery({ dbPath, query, operation, docs, tableName, mode = 'replace' } = {}) {
  if (operation) {
    if (operation !== 'insert') {
      throw new Error(`DuckDB runQuery does not support operation "${operation}" — write rows with { operation: 'insert', docs }, or send SQL as \`query\`.`);
    }
    if (!dbPath) throw new Error('Writing rows requires dbPath');
    const rows = Array.isArray(docs) ? docs : [];
    if (rows.length === 0) throw new Error('DuckDB write requires at least one row');
    if (mode !== 'replace' && mode !== 'append') {
      throw new Error(`Unsupported write mode "${mode}" — use 'replace' or 'append'.`);
    }
    if (!isDb(dbPath)) {
      if (mode === 'append') {
        throw new Error('Appending needs a database path (*.duckdb); a data file is rewritten whole.');
      }
      // `tableName` names the sheet when the target is a workbook, so writing
      // one sheet of an existing book leaves the rest of it alone.
      return duck.ingestRows(rows, dbPath, { sheet: duck.sheetFor(dbPath, tableName) });
    }
    if (!tableName) throw new Error('Writing rows to a database requires a tableName');
    // ...At — this helper is given a database PATH, not a workflow id.
    return duck.ingestRowsToTableAt(rows, dbPath, tableName, { mode });
  }

  if (!query) throw new Error('DuckDB runQuery requires a query string');
  // Every table is registered before the query runs, not just the first — the
  // caller's SQL may name any sheet of a workbook, and may join two of them.
  const [scope] = await ensureViews(dbPath);
  const sql = typeof query === 'string' ? query : query.query;
  if (!sql) throw new Error('DuckDB runQuery requires a query string');
  // A database's tables are reached through its alias, so an unqualified name
  // in the caller's SQL resolves there for the duration of this query.
  if (isDb(dbPath)) return (await duck.queryIn(scope, sql)).rows;
  const result = await duck.query(sql);
  return result.rows;
}

async function getTables({ dbPath } = {}) {
  if (isDb(dbPath)) return duck.tablesAt(dbPath);
  // The registered names, so a workbook reports its sheets rather than the one
  // name the file happens to have.
  return ensureViews(dbPath);
}

async function getColumns({ dbPath, table } = {}) {
  if (isDb(dbPath)) {
    const alias = await duck.attachDb(dbPath);
    const columns = await duck.describe(
      `${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(duck.sanitizeIdentifier(table))}`,
    );
    return columns.map((c) => ({ name: c.name, type: c.type }));
  }
  const [first] = await ensureViews(dbPath);
  const columns = await duck.describe(duck.quoteIdentifier(table || first));
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

module.exports = { runQuery, getTables, getColumns, ensureView, ensureViews, viewNameFor, viewNamesFor };
