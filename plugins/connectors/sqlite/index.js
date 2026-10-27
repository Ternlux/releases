/**
 * SQLite Connector Plugin for Ternlux
 *
 * Backs local file connections — spreadsheet/CSV imports and node outputs that
 * were landed into a SQLite file.
 *
 * A SQLite file is read and written through DuckDB's sqlite extension, by the
 * DuckDB connector: it ATTACHes the file under its own catalog, scopes the tree
 * to `config.tables`, and runs reads and writes natively against the attached
 * tables. This plugin is that connector under the SQLite name, so the two kinds
 * of local database behave the same way. The sqlite3 npm driver it used to open
 * is gone — its native binary is per-platform, and a build carrying the wrong
 * one broke every SQLite read at once.
 *
 * Config: { dbPath, tables? }
 *   dbPath  the .db file
 *   tables  optional allow-list. Several connections can share one file — an
 *           import lands its own tables into the shared app database — so a
 *           connection only shows the tables it actually owns.
 */

const fs = require('fs');
const path = require('path');

const duckdbConnector = require(path.join(__dirname, '..', 'duckdb'));
const duck = require(path.join(__dirname, '..', '..', '..', 'public', 'duckdb'));

/**
 * The file has to be there already. Attaching a missing path would quietly
 * CREATE an empty database at it — a connection whose file was moved or deleted
 * would then browse as "no tables" instead of saying what happened.
 */
function requireFile(config) {
  if (!config || !config.dbPath) throw new Error('SQLite requires a dbPath');
  if (!fs.existsSync(config.dbPath)) throw new Error(`SQLite file not found: ${config.dbPath}`);
  // Only this connection is opened: the DuckDB connector would otherwise
  // register every sibling file the explorer lists, which is a DuckDB-explorer
  // feature this connector does not advertise.
  return { ...config, siblings: undefined };
}

/** Run a connector call, turning a missing file into the call's own failure shape. */
const guarded = (fn, failure) => async (config, ...rest) => {
  let checked;
  try {
    checked = requireFile(config);
  } catch (error) {
    return { success: false, message: error.message, ...failure };
  }
  return fn(checked, ...rest);
};

/** SQLite quotes identifiers with double quotes; an inner one is doubled. */
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

module.exports = {
  type: 'connector',
  id: 'sqlite',
  name: 'SQLite',
  dbCategory: 'SQL',

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js.
   *
   * SQLite has four storage classes and no date or boolean type, so most of
   * these collapse to TEXT or INTEGER. That is correct HERE — it was only
   * wrong as the silent fallback every other engine used to get.
   */
  types: {
    NULL: () => 'TEXT',
    DATE_ONLY: () => 'TEXT',
    TIMESTAMP: () => 'TEXT',
    BOOLEAN: () => 'INTEGER',
    INTEGER: () => 'INTEGER',
    FLOAT: () => 'REAL',
    OBJECT: () => 'TEXT',
    STRING: () => 'TEXT',
  },

  testConnection: guarded((config) => duckdbConnector.testConnection(config), {}),

  releaseConnection: (config, connectionId) => duckdbConnector.releaseConnection(config, connectionId),

  getTables: guarded(
    (config, connectionId) => duckdbConnector.getTables(config, connectionId),
    { tables: [] },
  ),

  getColumns: guarded(
    (config, connectionId, schema, table) => duckdbConnector.getColumns(config, connectionId, schema, table),
    { columns: [] },
  ),

  /**
   * @param {object} [options]
   * @param {number} [options.maxRows] - Stop after this many rows, by streaming
   *   the result — the SQL the user wrote is the SQL that runs.
   */
  runQuery: guarded(
    (config, connectionId, queryObj, options = {}) => duckdbConnector.runQuery(config, connectionId, queryObj, options),
    { rows: [], columns: [] },
  ),

  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    if (!rows || rows.length === 0) return { success: true, rowsInserted: 0 };
    try {
      const { dbPath } = requireFile(config);
      const docs = rows.map((row) => Object.fromEntries(columns.map((c) => {
        const v = row[c];
        if (v === undefined) return [c, null];
        if (v instanceof Date) return [c, v.toISOString()];
        if (v !== null && typeof v === 'object') return [c, JSON.stringify(v)];
        return [c, v];
      })));
      const bare = String(tableName).replace(/^"|"$/g, '').replace(/^main\./, '');
      await duck.ingestRowsToTableAt(docs, dbPath, bare, { mode: 'append', sqlite: true });
      return { success: true, rowsInserted: rows.length };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  closeConnection: async () => {},

  configSchema: {
    fields: [
      {
        name: 'dbPath',
        type: 'string',
        label: 'Database file',
        placeholder: '/path/to/database.db',
        required: true,
        sensitive: false,
      },
    ],
  },

  // A dotted name given as one string ("main.orders", or an attached database's
  // "aux.orders") is a database-qualified table name, so each part is quoted
  // separately — quoting it whole would name a single table containing a dot,
  // which never matches the unquoted form the insert path builds. "main" is
  // dropped for the same reason it is dropped from the `schema` argument: it is
  // the default database, and naming it adds nothing.
  quoteIdentifier: (identifier, schema = null) => {
    if (!identifier) return identifier;
    // Already quoted — hand it back untouched. Callers pass identifiers that
    // another layer has sometimes quoted already, and quoting a second time
    // produces ONE identifier whose text is the quoted string, which resolves
    // to nothing.
    if (typeof identifier === 'string'
        && identifier.startsWith('"') && identifier.endsWith('"') && identifier.length > 1) {
      return identifier;
    }

    if (schema) {
      return schema === 'main' ? quote(identifier) : `${quote(schema)}.${quote(identifier)}`;
    }
    if (typeof identifier === 'string' && identifier.includes('.')) {
      const parts = identifier.split('.');
      const [head, ...rest] = parts;
      if (parts.length === 2 && head === 'main') return quote(rest[0]);
      return parts.map(quote).join('.');
    }
    return quote(identifier);
  },

  getPreviewQuery: (tableName, limit = 100) => `SELECT * FROM ${tableName} LIMIT ${limit}`,

  /**
   * Data Explorer dialect: the statements run on DuckDB, so this is the DuckDB
   * connector's dialect — without its sibling connections, which this
   * connector does not register (see requireFile).
   */
  explorer: (() => {
    const { siblingConnections, ...rest } = duckdbConnector.explorer;
    return rest;
  })(),
};
