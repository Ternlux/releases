/**
 * Local SQLite helper. Single entry point: runQuery({ dbPath, query, params })
 * plus getTables / getColumns.
 *
 * A SQLite file is read and written through DuckDB's sqlite extension — the file
 * is ATTACHed and the statement runs with it as the current catalog, so an
 * unqualified table name means that file's table. One engine for every local
 * file; the sqlite3 npm driver this used to open is not used any more (its
 * native binary is per-platform, and a build carrying the wrong one broke every
 * SQLite read and write at once).
 *
 * Every SQLite file is a user's own file, opened by path — a database they
 * picked, or one an output node wrote. Table names are theirs too, so they are
 * quoted as given, never sanitised.
 */

const fs = require('fs');
const path = require('path');
const duck = require('../duckdb');

/** Attach `dbPath` as SQLite (creating the file if it is not there yet) and run `fn(alias)`. */
async function withSqlite(dbPath, fn) {
  if (!dbPath) throw new Error('SQLite runQuery requires dbPath');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return duck.holdDatabases(async () => fn(await duck.attachDb(dbPath, { sqlite: true })));
}

/**
 * runQuery({ dbPath, query, params? }) → the statement's rows.
 *
 * What a statement returns is the engine's answer, not a guess from its text:
 * a read returns its rows, and a write returns DuckDB's row-count result.
 */
async function runQuery({ dbPath, query, params = [] } = {}) {
  if (!query) throw new Error('SQLite runQuery requires a query string');
  return withSqlite(dbPath, (alias) => duck.withCatalog(
    alias,
    async () => (await duck.query(query, { params: params && params.length ? params : null })).rows,
  ));
}

async function getTables({ dbPath } = {}) {
  return withSqlite(dbPath, () => duck.tablesAt(dbPath));
}

async function getColumns({ dbPath, table } = {}) {
  if (!table) return [];
  return withSqlite(dbPath, async (alias) => {
    const columns = await duck.describe(`${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(table)}`);
    return columns.map((c) => ({ name: c.name, type: c.type, nullable: true, isPrimary: false }));
  });
}

module.exports = { runQuery, getTables, getColumns };
