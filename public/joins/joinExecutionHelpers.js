/**
 * Join Execution Helper Functions
 * Shared utilities for executing join operations
 */

const path = require('path');
const { batchChunkSizeFor } = require('../lib/batchChunkSize');
const { throwIfCancelled, isCancelledError } = require('../NodeExecution/executionCancel');
const { setBatchWindow } = require('../NodeExecution/executionLog');

// A SQLite source's file. Imported files record it on fileInfo.filePath (most
// of them share the app's one imported-data file, told apart by table); a
// SQLite file picked as a connection records it on dbConfig.dbPath. Joins read
// it through DuckDB — see localFilePathOf.
function localSqlitePath(conn) {
  return conn.fileInfo?.filePath || conn.localPath || conn.dbConfig?.dbPath || null;
}

/**
 * The file a local DuckDB source is read from.
 *
 * A connection that spans several files keeps a name -> path map, so the table
 * being read is what decides which file that is; everything else has one path
 * and the table name is only a label.
 */
function duckSourcePath(connection, tableName) {
  const paths = connection?.dbConfig?.tablePaths;
  if (tableName && paths && typeof paths === 'object' && paths[tableName]) return paths[tableName];
  return localFilePathOf(connection);
}

/**
 * The connection name a local source's schema is derived from.
 *
 * The saved `sourcesConfig[].connection` shape does not carry the connection's
 * NAME — it was assembled for reading a file, not for naming one. So fall back
 * to the file's own basename, which is what registerLocalFile names an imported
 * connection after; for the ordinary case ("customers.csv" imported as
 * "customers") the two agree, and the schema comes out the same as the Data
 * Explorer's. An explicit name is preferred whenever a caller has one.
 */
function connectionNameOf(connection, dbPath) {
  const explicit = connection?.connectionName || connection?.name || null;
  if (explicit) return explicit;
  const original = connection?.fileInfo?.originalName;
  if (original) return path.basename(original, path.extname(original));
  return dbPath ? path.basename(dbPath, path.extname(dbPath)) : null;
}

/**
 * Read a local DuckDB source — a data file, or a table in a workflow database.
 *
 * These never go through the duckdb CONNECTOR. The connector is built for a
 * saved connection and resolves its file from `config.dbPath`, but the shape
 * this loader is handed comes from enrichJoinSourcesConfig, which puts the path
 * on `connection.localPath` and leaves dbConfig empty for anything without a
 * saved connection — every upstream node's output, since those carry the
 * synthetic id "local-duckdb". Routed through the connector that source
 * resolved to nothing: `runQuery` returned `{ success: false, message: 'DuckDB
 * requires a file path', rows: [] }`, the caller's `result.rows || []` turned
 * that into an empty array, and the join ran to completion against no rows —
 * writing a silently empty result into the destination.
 *
 * So the path is resolved here the same way the local-destination join resolves
 * it (executeLocalDuckDBJoin), which also gets two things the connector route
 * did not: a workflow database is attached and its table addressed through the
 * alias, and a workbook's sheet is picked out by the source's table name rather
 * than every sheet reading as the first one.
 *
 * The AI writes `SELECT … FROM <table>`, so the source is exposed under that
 * name for the duration of the read — and under the file's own basename too,
 * since the two do not always agree (mirrors DuckDB.registerSource).
 */
async function withDuckDBSource(sourceConnection, sourceConfig, fn) {
  const duck = require('../duckdb');

  const table = sourceConfig.tableName
    || sourceConfig.sourceTableSchema?.tableName
    || sourceConfig.tempTableName
    || null;
  const dbPath = duckSourcePath(sourceConnection, table);
  if (!dbPath) {
    throw new Error(
      `Local source "${table || sourceConfig.sourceNodeId || 'unknown'}" has no file path`
      + ' — expected one on connection.localPath, fileInfo.filePath or dbConfig.dbPath.',
    );
  }

  let body;
  // A DATABASE — .duckdb, or a SQLite file read through DuckDB's sqlite
  // extension — holds real tables and is attached. Anything else is a data file
  // read in place. `.duckdb` alone was too narrow: a local SQLite source fell
  // into the file branch below, where tableRef has no format for a .db and the
  // read failed on a source the Data Explorer browses fine. SQLite is also
  // recognised by its header, whatever the file is called.
  const isSqlite = duck.isSqliteFile(dbPath);
  if (isSqlite || duck.isDatabaseFile(dbPath)) {
    // An upstream node's output, or a SQLite file: a real table.
    if (!table) throw new Error(`Reading a table out of ${path.basename(dbPath)} requires the source's table name.`);
    const alias = await duck.attachDb(dbPath);
    // A table in a file the user owns keeps the name its owner gave it —
    // spaces, dashes and all — so it is quoted as-is. Only tables this app
    // wrote (a workflow's own database) were created under the sanitized form.
    const DuckDB = require('../transfomers/DuckDB');
    const tableIdent = (!isSqlite && DuckDB.isWorkflowDb(dbPath)) ? duck.sanitizeIdentifier(table) : table;
    body = `SELECT * FROM ${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(tableIdent)}`;
  } else {
    // A data file, read where it lies. For a workbook the table name is the
    // sheet; for every other format that resolves to null.
    const ref = await duck.tableRef(
      dbPath,
      sourceConnection.fileInfo?.format || sourceConnection.dbConfig?.format || null,
      { sheet: duck.sheetFor(dbPath, table) },
    );
    body = `SELECT * FROM ${ref}`;
  }

  // Bare AND `<connection>.<table>` — see duck.registerAddressableViews. It
  // matters more here than for a transformer: a join has SEVERAL local sources,
  // so `customers.customers` and `products.products` are exactly how the Data
  // Explorer tells the user (and any model reading their SQL) to tell two files
  // apart.
  const { created } = await duck.registerAddressableViews({
    body,
    names: [table, path.basename(dbPath, path.extname(dbPath))],
    connectionName: connectionNameOf(sourceConnection, dbPath),
  });
  try {
    return await fn({ duck, table, dbPath });
  } finally {
    // Leaving one behind would shadow whatever else answers to that name.
    await duck.dropViews(created);
  }
}

/** Read a local DuckDB source whole. */
async function loadDuckDBSourceData(sourceConnection, sourceConfig) {
  return withDuckDBSource(sourceConnection, sourceConfig, async ({ duck, table }) => {
    const sql = String(sourceConfig.sql || '').replace('{LIMIT_OFFSET_HERE}', '').trim();
    if (!sql) {
      throw new Error(`Local source "${table || sourceConfig.sourceNodeId || 'unknown'}" has no SQL to read it with.`);
    }
    const result = await duck.query(sql);
    return result.rows || [];
  });
}

/**
 * Page a local DuckDB source, for a join whose DESTINATION is a real database.
 *
 * That route stages every source into a temp table on the destination, so rows
 * arrive in chunks rather than all at once. Until this existed, a local DuckDB
 * source taking it fell through to the duckdb CONNECTOR, which resolves its
 * file from `config.dbPath` — and an upstream node's output carries the
 * synthetic id "local-duckdb" with an empty dbConfig, so there was nothing to
 * open and the read failed with "DuckDB requires a file path". The path was on
 * `connection.localPath` the whole time; only loadDuckDBSourceData looked there,
 * and that is the read-it-all route, not this one.
 *
 * Views are registered ONCE and the whole read runs against them, so a source
 * is not re-resolved per chunk.
 *
 * STREAMED, not paged with LIMIT/OFFSET.
 *
 * It used to run one `LIMIT n OFFSET m` per chunk, which asks DuckDB to
 * re-scan and discard the first m rows every time: quadratic in the size of the
 * source, so a ten-million-row local table cost on the order of 10^10 rows of
 * scanning to read 10^7. `duck.streamRows` pulls one result once and hands back
 * ~2048-row chunks, which is both linear and bounded in memory. The statement
 * is passed through untouched — no injected LIMIT, so SQL that a rewrite would
 * have broken still runs.
 */
async function loadDuckDBSourceInChunks(sourceConnection, sourceConfig, sql, chunkSize, onChunk) {
  return withDuckDBSource(sourceConnection, sourceConfig, async ({ duck, table }) => {
    const base = String(sql || '').trim();
    if (!base) {
      throw new Error(`Local source "${table || sourceConfig?.sourceNodeId || 'unknown'}" has no SQL to read it with.`);
    }
    // The placeholder exists for engines that need pagination spliced in.
    // Streaming needs none, so it is removed rather than filled.
    const readQuery = base.includes('{LIMIT_OFFSET_HERE}')
      ? base.replace('{LIMIT_OFFSET_HERE}', '')
      : base;

    let totalProcessed = 0;
    let buffer = [];

    // DuckDB's chunks are ~2048 rows; the caller asked for `chunkSize`, which is
    // the DESTINATION's batch size. Re-cut rather than passing chunks straight
    // through, or a connector that rations calls (BigQuery's load-job quota)
    // would get whatever DuckDB happened to produce.
    const deliver = async () => {
      if (buffer.length === 0) return;
      const chunk = buffer;
      buffer = [];
      throwIfCancelled('reading a local source', `${totalProcessed} rows read so far`);
      totalProcessed += chunk.length;
      await onChunk(chunk, totalProcessed - chunk.length, totalProcessed);
    };

    for await (const page of duck.streamRows(readQuery)) {
      for (const row of page) {
        buffer.push(row);
        if (buffer.length >= chunkSize) await deliver();
      }
    }
    await deliver();

    return totalProcessed;
  });
}

/**
 * Load data from a source (SQL or NoSQL)
 * @param {Object} sourceConnection - Source connection configuration
 * @param {Object} sourceConfig - Source configuration with sql/nosqlOperation
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @returns {Promise<Array>} Array of data rows/documents
 */
/**
 * A join source's document-store read, as the object the connector runs.
 *
 * Saved as a JSON string by contract, but a model can hand back the object
 * itself, and the builder stores what it is given — JSON.parse on that threw
 * `"[object Object]" is not valid JSON` and failed every run of the join.
 *
 * A find written `{ collection, query: {...} }` is also accepted: the
 * connector unwraps a top-level `query` as a wrapper around the whole params
 * object, so that shape lost its collection. `filter` is the field it reads.
 *
 * `defaultCollection` is the collection THIS source's Data Source node reads.
 * Which collection to read is never the model's choice — the node already
 * decided it — so a read that leaves it out ("A query needs a collection")
 * reads that one. Each source of a join passes its own.
 */
function parseNoSQLOperation(operation, defaultCollection = null) {
  const parsed = (operation && typeof operation === 'object')
    ? { ...operation }
    : JSON.parse(operation || '{}');
  if (parsed && !Array.isArray(parsed)) {
    if (!parsed.collection && !parsed.tableName && defaultCollection) parsed.collection = defaultCollection;
    if (parsed.collection
        && parsed.query && typeof parsed.query === 'object' && parsed.filter === undefined) {
      parsed.filter = parsed.query;
      delete parsed.query;
    }
  }
  return parsed;
}

/** The collection a join source's own node reads — see parseNoSQLOperation. */
function sourceCollectionOf(sourceConfig = {}, sourceConnection = {}) {
  return sourceConfig.tableName
    || sourceConfig.sourceCollection
    || sourceConfig.sourceTableSchema?.tableName
    || sourceConnection?.dbConfig?.tableName
    || null;
}

async function loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig) {
  const sourceDbType = sourceConnection.dbType;

  // Local file source — a DuckDB/data file, a table in a workflow database, or
  // a SQLite file. All of them are read by DuckDB by path (a SQLite file
  // through its sqlite extension), never through a connector or the sqlite3
  // library; see loadDuckDBSourceData. The source's `sql` runs as a DuckDB
  // SELECT against the table, registered under its own name.
  if (sourceDbType === 'duckdb' || (sourceDbType === 'sqlite' && localFilePathOf(sourceConnection))) {
    return await loadDuckDBSourceData(sourceConnection, sourceConfig);
  }

  // Check if connector is available
  if (!pluginManager.hasConnector(sourceDbType)) {
    throw new Error(`Database type ${sourceDbType} is not supported`);
  }

  const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
  // Only a remote document store is still NoSQL. Every local file — JSON
  // included — is read as SQL by DuckDB and took the branch above.
  const isNoSQLSource = sourceDbType === 'mongodb';

  if (isNoSQLSource) {
    // Load from the document store via its plugin
    const plugin = pluginManager.getConnector(sourceDbType);
    const operationObj = parseNoSQLOperation(
      sourceConfig.nosqlOperation,
      sourceCollectionOf(sourceConfig, sourceConnection),
    );
    // 0 = no cap. A join source is read WHOLE — the join function needs every
    // document to be correct, and a truncated read is not a smaller answer but
    // a wrong one. The connector's default is 100 (a preview default), which
    // meant an anti-join against an existing collection only ever saw its first
    // 100 documents: every record past that looked new on each run and was
    // re-emitted forever. An explicit `limit` inside the operation still wins.
    const result = await plugin.runQuery(fullConfig, sourceConnection.id, operationObj, 0);
    return rowsOrThrow(result, sourceConnection, sourceLabel(sourceConfig, sourceConnection));
  } else {
    // Load from SQL source via plugin
    const plugin = pluginManager.getConnector(sourceDbType);
    const sql = sourceConfig.sql.replace('{LIMIT_OFFSET_HERE}', '')
    const result = await plugin.runQuery(fullConfig, sourceConnection.id, { query: sql});
    return rowsOrThrow(result, sourceConnection, sourceLabel(sourceConfig, sourceConnection));
  }
}

/**
 * A connector's rows, or the reason there are none.
 *
 * Connectors report failure as `{ success: false, message, rows: [] }` rather
 * than by throwing, so `result.rows || []` reads a failed read as an empty
 * source — and a join over an empty source succeeds, writing a silently wrong
 * result to the destination. Same rule the skill-helper layer applies in
 * electron.js: success false is an error.
 */
function rowsOrThrow(result, sourceConnection, label) {
  if (result && result.success === false) {
    const name = label || sourceConnection?.id || 'source';
    throw new Error(`Could not read join source "${name}" (${sourceConnection?.dbType}): ${result.message || 'query failed'}`);
  }
  return (result && result.rows) || [];
}

/** How a source is named in a read failure — the table it meant, else its node. */
function sourceLabel(sourceConfig, sourceConnection) {
  return sourceConfig?.tableName
    || sourceConfig?.sourceTableSchema?.tableName
    || sourceConfig?.sourceNodeId
    || sourceConnection?.id
    || 'source';
}

/**
 * Load data from SQL source in chunks (streaming)
 * @param {Object} sourceConnection - Source connection configuration
 * @param {string} sql - SQL query to execute
 * @param {number} chunkSize - Number of rows per chunk
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @param {Function} onChunk - Callback for each chunk (chunk, offset, totalSoFar)
 * @returns {Promise<number>} Total rows processed
 */
async function loadSQLSourceInChunks(
  sourceConnection,
  sql,
  chunkSize,
  pluginManager,
  getFullConfig,
  onChunk,
  // The source's own config. Needed to resolve WHERE a local source lives (and
  // which sheet of a workbook it means) — the connection alone does not say.
  sourceConfig = null
) {
  const sourceDbType = sourceConnection.dbType;

  // Local DuckDB source — a data file, or an upstream node's table in a
  // workflow database. Read by PATH rather than through the connector, which
  // resolves its file from `config.dbPath` and so cannot open either of those.
  // Mirrors the branch loadSourceData already has; see loadDuckDBSourceInChunks.
  // A SQLite file takes the same route: DuckDB attaches it through the sqlite
  // extension and streams it, instead of paging it with the sqlite3 library.
  const isLocalFile = sourceDbType === 'duckdb'
    || (sourceDbType === 'sqlite' && !!localFilePathOf(sourceConnection));
  if (isLocalFile && sourceConfig) {
    return await loadDuckDBSourceInChunks(sourceConnection, sourceConfig, sql, chunkSize, onChunk);
  }

  if (!pluginManager.hasConnector(sourceDbType)) {
    throw new Error(`Database type ${sourceDbType} is not supported`);
  }

  const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
  const plugin = pluginManager.getConnector(sourceDbType);

  let offset = 0;
  let totalProcessed = 0;
  console.log('sql: ', sql)
  while (true) {
    // Paging a large remote table is one node and many round-trips, so the
    // runner's between-steps check never comes round. Stopping here is clean:
    // the read has written nothing, only the temp-table load below has.
    throwIfCancelled('reading a source', `${totalProcessed} rows read so far`);

    // Replace {LIMIT_OFFSET_HERE} placeholder with database-specific pagination syntax
    let chunkQuery;
    let paginationClause;

    // Determine database-specific pagination syntax
    if (sourceDbType === 'mssql') {
      // MS SQL Server uses OFFSET...FETCH NEXT and requires ORDER BY
      // Use ORDER BY (SELECT NULL) as a workaround when no explicit ORDER BY is present
      paginationClause = `ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${chunkSize} ROWS ONLY`;
    } else {
      // PostgreSQL, MySQL, SQLite, Redshift, Snowflake, BigQuery use LIMIT/OFFSET
      paginationClause = `LIMIT ${chunkSize} OFFSET ${offset}`;
    }

    if (sql.includes('{LIMIT_OFFSET_HERE}')) {
      chunkQuery = sql.replace('{LIMIT_OFFSET_HERE}', paginationClause);
    } else {
      // Backward compatibility: append pagination clause if no placeholder found
      chunkQuery = `${sql} ${paginationClause}`;
    }

    const result = await plugin.runQuery(fullConfig, sourceConnection.id, { query: chunkQuery });
    // A failed chunk is not the end of the data. Left to `rows || []` it reads
    // as one — the loop breaks, the caller is told how many rows it got, and a
    // temp table that should hold a million rows holds none, with the join over
    // it succeeding anyway. Fail the read instead.
    const rows = rowsOrThrow(result, sourceConnection, sourceConnection?.id);

    if (rows.length === 0) break;

    totalProcessed += rows.length;
    await onChunk(rows, offset, totalProcessed);

    offset += chunkSize;
  }

  return totalProcessed;
}

/**
 * The temp table's real column names, in `selectedColumns` order.
 *
 * The staging DDL is the model's, and it may write its columns bare. Snowflake
 * folds a bare `product_id` to PRODUCT_ID, while every connector's batchInsert
 * quotes the names it is handed — so the load asked for "product_id" and failed
 * with `invalid identifier '"product_id"'` after the table had been created.
 * Asking the destination what the table actually holds settles it on every
 * engine, without reading or rewriting the DDL: each selected column maps to
 * the real column of the same name, exactly, or else ignoring case. A connector
 * that cannot answer leaves the names as they were.
 */
async function resolveStagedColumns(destPlugin, destFullConfig, destConnectionId, tempTableName, selectedColumns) {
  if (!destPlugin || typeof destPlugin.getColumns !== 'function') return selectedColumns;
  let real = [];
  try {
    const res = await destPlugin.getColumns(destFullConfig, destConnectionId, null, tempTableName);
    const list = Array.isArray(res) ? res : (res?.columns || []);
    real = list.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  } catch (_) {
    return selectedColumns;
  }
  if (!real.length) return selectedColumns;
  return selectedColumns.map((col) => {
    if (real.includes(col)) return col;
    const lower = String(col).toLowerCase();
    return real.find((r) => String(r).toLowerCase() === lower) || col;
  });
}

/**
 * Insert data into a temp table in batches using selectedColumns
 * @param {Object} destPlugin - Destination database plugin
 * @param {Object} destFullConfig - Destination full configuration
 * @param {string} destConnectionId - Destination connection ID
 * @param {string} tempTableName - Temp table name
 * @param {Array} selectedColumns - Array of column names in order
 * @param {Array} data - Array of data to insert
 * @param {number} chunkSize - Batch size for inserts. A connector that
 *   declares `batchInsertChunkSize` overrides this — see
 *   public/lib/batchChunkSize.js for why BigQuery does.
 * @returns {Promise<number>} Total rows inserted
 */
async function insertDataToTempTable(
  destPlugin,
  destFullConfig,
  destConnectionId,
  tempTableName,
  selectedColumns,
  data,
  chunkSize,
  // The table's own names for selectedColumns (resolveStagedColumns). When a
  // name differs, each row is re-keyed so the value lands under it.
  tableColumns = null
) {
  if (data.length === 0) return 0;
  if (!selectedColumns || selectedColumns.length === 0) {
    throw new Error(`No selectedColumns provided for ${tempTableName}`);
  }
  if (Array.isArray(tableColumns) && tableColumns.length === selectedColumns.length
      && tableColumns.some((c, i) => c !== selectedColumns[i])) {
    data = data.map((row) => Object.fromEntries(selectedColumns.map((c, i) => [tableColumns[i], row[c]])));
    selectedColumns = tableColumns;
  }

  let totalInserted = 0;
  const effectiveChunkSize = batchChunkSizeFor(destPlugin, chunkSize);

  // Insert in chunks to avoid query size limits
  for (let chunkStart = 0; chunkStart < data.length; chunkStart += effectiveChunkSize) {
    // Same reason as the output node's loop: staging a big source into the
    // destination is minutes of work inside a single step. The temp table is
    // dropped by the join's cleanup, so a partial load here is not left behind.
    throwIfCancelled(
      'staging a join source',
      `${totalInserted} of ${data.length} rows loaded into ${tempTableName}`,
    );

    const chunk = data.slice(chunkStart, chunkStart + effectiveChunkSize);

    // Use plugin's batchInsert function if available, otherwise fallback to individual inserts
    if (destPlugin.batchInsert) {
      // Which records this call carries, for the tracer's line — see
      // executionLog.setBatchWindow. Staging a big source is a run of otherwise
      // identical batch lines.
      setBatchWindow({ table: tempTableName, written: totalInserted });
      try {
        const result = await destPlugin.batchInsert(destFullConfig, destConnectionId, tempTableName, selectedColumns, chunk);
        if (!result.success) {
          throw new Error(result.message || 'Batch insert failed');
        }
        totalInserted += result.rowsInserted;
      } finally {
        setBatchWindow(null);
      }
    } else {
      // Fallback: individual INSERT statements
      const insertStatements = chunk.map(row => {
        // Format values for each column
        const values = selectedColumns.map(col => {
          const val = row[col];

          if (val === null || val === undefined) {
            return 'NULL';
          } else if (typeof val === 'string') {
            return `'${val.replace(/'/g, "''")}'`;
          } else if (val instanceof Date) {
            return `'${val.toISOString()}'`;
          } else if (typeof val === 'object') {
            return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          } else {
            return val;
          }
        });

        // Build INSERT statement
        const columnsList = selectedColumns.join(', ');
        const valuesList = values.join(', ');
        return `INSERT INTO ${tempTableName} (${columnsList}) VALUES (${valuesList})`;
      });

      // Execute all inserts in the batch (semicolon separated)
      const batchInsert = insertStatements.join('; ');
      await destPlugin.runQuery(destFullConfig, destConnectionId, {query: batchInsert});
      totalInserted += chunk.length;
    }
  }

  return totalInserted;
}


/**
 * The file a local source is read from, or null when it isn't a local file.
 *
 * DuckDB files and data files, and SQLite files too: DuckDB reads those through
 * its sqlite extension (attachDb), so a SQLite source is read where it lies
 * like any other local file — never through the sqlite3 library, and never
 * copied into staging first.
 */
function localFilePathOf(connection) {
  if (!connection) return null;
  if (connection.dbType === 'duckdb') {
    return connection.fileInfo?.filePath || connection.localPath || connection.dbConfig?.dbPath || null;
  }
  if (connection.dbType === 'sqlite') return localSqlitePath(connection);
  return null;
}

/**
 * An empty relation with the right column names, so a join over a source that
 * returned no rows still resolves instead of failing on an unknown table.
 */
function emptyViewSelect(selectedColumns) {
  const columns = (selectedColumns || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  if (columns.length === 0) return 'SELECT NULL WHERE false';
  const projection = columns.map((c) => `NULL::VARCHAR AS "${String(c).replace(/"/g, '""')}"`).join(', ');
  return `SELECT ${projection} WHERE false`;
}

/**
 * Run a join whose destination is local.
 *
 * Local file sources are registered as views straight over their files, so
 * their rows are never copied into a staging table — the join reads the CSV or
 * Parquet where it sits, and an upstream node's output is already a table in
 * this workflow's database. Only genuinely remote sources are pulled across,
 * and those land in a temporary Parquet file that is deleted afterwards.
 *
 * `joinSql` is a SELECT, and what it produces IS the result: it becomes this
 * node's output table in its workflow's DuckDB database.
 *
 * @returns {Promise<{success, message, localPath, targetTableName, rowCount}>}
 */
// How the generated SQL names the join's target. A SQL destination has it
// filled in at build time (workflowBuilder's applySourceSlots); a local one at
// run time, above, where the workflow database's alias is known.
const TARGET_PLACEHOLDER = '{{TARGET}}';

// 'append' and 'merge' keep the target (created only when missing, never
// dropped); 'new_table' replaces it. See NodeExecution's keepsTarget.
const keepsTarget = (mode) => mode === 'append' || mode === 'merge';

async function executeLocalDuckDBJoin({
  sourcesConfig,
  joinSql,
  // The SQL-destination contract, which a local join now shares: a CREATE for
  // the target and an INSERT into it, both naming the target as {{TARGET}}.
  // Absent on joins built before that — they carry a bare SELECT, run through
  // CREATE OR REPLACE TABLE … AS below.
  targetDdl = null,
  // 'new_table' replaces the target every run; 'append' keeps its rows and
  // adds this run's, creating the table only when it is missing.
  operationMode = 'new_table',
  targetTableName,
  targetLocalPath,
  pluginManager,
  getFullConfig,
  workflowId = null,
  nodeId = null,
}) {
  const duck = require('../duckdb');
  const DuckDB = require('../transfomers/DuckDB');

  const views = [];
  const stagedTables = [];
  const outPath = DuckDB.resolveTargetDb(targetLocalPath, { workflowId, nodeId });

  try {
    if (!joinSql || !String(joinSql).trim()) throw new Error('Join SQL is empty');

    // Replace mode drops the target before the INSERT reads its sources, so a
    // source that IS the target (an upstream node's table of the same name in
    // this workflow database) would be emptied first. Append never drops.
    if (!keepsTarget(operationMode) && String(targetDdl || '').trim()) {
      const clash = (sourcesConfig || []).find((sc) => {
        const conn = sc.connection || sc.sourceConnection || {};
        return DuckDB.isWorkflowDb(localFilePathOf(conn))
          && String(sc.tableName || '').toLowerCase() === String(targetTableName || '').toLowerCase();
      });
      if (clash) {
        return {
          success: false,
          message: `Join ${targetTableName} replaces its target on every run, but that table is also one of its sources — `
            + 'the replace would empty it before it is read. Write to a different table, or switch the join to append mode. Nothing was changed.',
        };
      }
    }

    // Counts SOURCES, not views. It used to piggyback on `views.length`, which
    // was one-per-source until a source started registering several names.
    let sourceIndex = 0;
    for (const sourceConfig of sourcesConfig) {
      const name = sourceConfig.tempTableName || sourceConfig.tableName;
      // A source with no name cannot be read, and skipping it only moved the
      // failure into the join SQL as "table does not exist", naming the wrong
      // cause. Every complete node names its table; this one is unfinished.
      if (!name) {
        throw new Error(
          `Join source "${sourceConfig.sourceNodeId || 'unknown'}" names no table to read. `
          + 'Finish that source node (pick its table, or the cloud file) and rebuild the join.',
        );
      }
      const stagingIndex = sourceIndex++;

      const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection || {};
      const filePath = localFilePathOf(sourceConnection);
      let body;

      if (DuckDB.isWorkflowDb(filePath)) {
        // An upstream node's output — already a table in this same database.
        const ref = await duck.workflowTableRef(workflowId, sourceConfig.tableName || name);
        body = `SELECT * FROM ${ref}`;
      } else if (filePath && (duck.isSqliteFile(filePath) || duck.isDatabaseFile(filePath))) {
        // A database file the user owns — SQLite (through DuckDB's sqlite
        // extension) or DuckDB. Attached and read in place: its table under
        // the name its owner gave it, never copied into staging first.
        const table = sourceConfig.tableName || sourceConfig.sourceTableSchema?.tableName || null;
        if (!table) {
          throw new Error(`Join source "${sourceConfig.sourceNodeId}" reads ${path.basename(filePath)} but names no table in it.`);
        }
        const alias = await duck.attachDb(filePath);
        body = `SELECT * FROM ${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(table)}`;
      } else if (filePath) {
        // The point of the whole change: read the file where it is. A workbook
        // holds a table per sheet, and this source's table name is which sheet
        // it means — without that, every sheet of a workbook would join as the
        // first one, quietly and with no error.
        const ref = await duck.tableRef(filePath, sourceConnection.fileInfo?.format || null, {
          sheet: duck.sheetFor(filePath, sourceConfig.tableName),
        });
        body = `SELECT * FROM ${ref}`;
      } else {
        // A source DuckDB can't read where it lies — a remote database, or a
        // vector store. Its rows are pulled through the plugin and staged as a
        // table in this workflow's own database, so the join never leaves
        // DuckDB and nothing is written outside the workflow's file.
        const rows = Array.isArray(sourceConfig._preloadedRows)
          ? sourceConfig._preloadedRows
          : await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);

        if (!rows || rows.length === 0) {
          body = emptyViewSelect(sourceConfig.selectedColumns);
        } else {
          const staged = `join_src_${stagingIndex}_${name}`;
          await duck.ingestRowsToStaging(rows, outPath, staged);
          stagedTables.push(staged);
          body = `SELECT * FROM ${await duck.stagingRef(outPath, staged)}`;
        }
      }

      // `name` is the temp-table alias the generated joinSql addresses. The
      // source's REAL table name and its `<connection>.<table>` form are
      // registered alongside it, so a join written against what the Data
      // Explorer shows resolves too — with several local files in one join,
      // that qualified form is the only way to tell same-named tables apart.
      const realTable = sourceConfig.tableName || sourceConfig.sourceTableSchema?.tableName || null;
      const { created } = await duck.registerAddressableViews({
        body,
        names: [name, realTable],
        // A node output has no connection; it is already reachable as
        // `<workflowAlias>.<table>` through the attach.
        connectionName: DuckDB.isWorkflowDb(filePath)
          ? null
          : connectionNameOf(sourceConnection, filePath),
      });
      views.push(...created);
    }

    // The join result is this node's output: a table in the workflow database.
    let before = 0;
    const rowCount = await duck.withWorkflowLock(workflowId, async () => {
      if (!String(targetDdl || '').trim()) {
        // Built before the shared contract: joinSql is a bare SELECT.
        await duck.createTableAs(workflowId, targetTableName, joinSql);
        return duck.tableRowCount(workflowId, targetTableName);
      }
      // {{TARGET}} is resolved here, not at build time: the workflow
      // database's alias is only known once it is attached.
      const ref = await duck.workflowTableRef(workflowId, targetTableName);
      const fill = (sql) => String(sql).split(TARGET_PLACEHOLDER).join(ref);
      const exists = await duck.tableExists(workflowId, targetTableName);
      if (keepsTarget(operationMode) && exists) {
        before = await duck.tableRowCount(workflowId, targetTableName);
      } else {
        if (exists) await duck.exec(`DROP TABLE IF EXISTS ${ref}`);
        await duck.exec(fill(targetDdl));
      }
      await duck.exec(fill(joinSql));
      return duck.tableRowCount(workflowId, targetTableName);
    });
    const written = rowCount - before;

    return {
      success: true,
      // A join that matched nothing is a legitimate result, and the count is
      // read back off the table it wrote, so a zero here is real. It is worth
      // saying out loud: an empty source (which stages as an empty view above)
      // and join keys that simply never match look identical from the outside.
      // A merge that only updated rows adds none, so the row-count difference
      // says nothing about it; report the table's size instead.
      warning: operationMode !== 'merge' && written === 0,
      message: operationMode === 'merge'
        ? `Join merged into ${targetTableName} — ${rowCount} row(s) now (${before} before).`
        : written === 0
          ? `Join completed — 0 rows written to ${targetTableName}. Either a source was empty or no rows matched the join keys.`
          : `Join completed — ${written} row(s) ${before ? `appended to ${targetTableName} (${rowCount} in total)` : `written to ${targetTableName}`}`,
      localPath: outPath,
      targetTableName,
      rowCount,
    };
  } catch (error) {
    // A stop must stay an exception all the way to the runner — see the note in
    // outputExecutionHelpers' executeOutput catch. The `finally` below still
    // runs, so the views and staging this join created are cleaned up either
    // way.
    if (isCancelledError(error)) throw error;

    console.error('[DuckDB Join] Error:', error);
    return {
      success: false,
      message: `Local join failed: ${error.message}`,
      error: error.stack,
    };
  } finally {
    // `views` holds quoted refs from registerAddressableViews, bare and
    // schema-qualified alike.
    await duck.dropViews(views);
    await duck.dropStaging(outPath, stagedTables);
  }
}

/**
 * Write a JavaScript join's rows as this node's table in the workflow database.
 *
 * The local counterpart of executeLocalDuckDBJoin for a join that could not be
 * SQL — one that embeds or runs a similarity search. The rows are staged in the
 * workflow's own file and the target is created from them with the same
 * CREATE OR REPLACE TABLE a SQL join uses, so readers see one shape either way.
 * An empty result still replaces the target (a join always does), shaped from
 * the columns the node declared.
 */
async function writeLocalJoinRows({
  rows,
  targetTableName,
  targetLocalPath,
  emptyColumns = null,
  // See executeLocalDuckDBJoin.
  operationMode = 'new_table',
  workflowId = null,
  nodeId = null,
}) {
  const duck = require('../duckdb');
  const DuckDB = require('../transfomers/DuckDB');
  const outPath = DuckDB.resolveTargetDb(targetLocalPath, { workflowId, nodeId });
  const staged = `join_fn_${String(targetTableName || 'result')}`;
  let before = 0;
  const stagedTables = [];

  try {
    let selectSql;
    if (Array.isArray(rows) && rows.length > 0) {
      await duck.ingestRowsToStaging(rows, outPath, staged);
      stagedTables.push(staged);
      selectSql = `SELECT * FROM ${await duck.stagingRef(outPath, staged)}`;
    } else {
      selectSql = emptyViewSelect(emptyColumns);
    }

    const rowCount = await duck.withWorkflowLock(workflowId, async () => {
      if (keepsTarget(operationMode) && await duck.tableExists(workflowId, targetTableName)) {
        before = await duck.tableRowCount(workflowId, targetTableName);
        // BY NAME: the function's rows land under the columns of the same
        // name, whatever order its objects listed them in.
        const ref = await duck.workflowTableRef(workflowId, targetTableName);
        await duck.exec(`INSERT INTO ${ref} BY NAME ${selectSql}`);
      } else {
        await duck.createTableAs(workflowId, targetTableName, selectSql);
      }
      return duck.tableRowCount(workflowId, targetTableName);
    });
    const written = rowCount - before;

    return {
      success: true,
      warning: written === 0,
      message: written === 0
        ? `Join completed — 0 rows written to ${targetTableName}. The join function returned no rows.`
        : `Join completed — ${written} row(s) ${before ? `appended to ${targetTableName} (${rowCount} in total)` : `written to ${targetTableName}`}`,
      localPath: outPath,
      targetTableName,
      rowCount,
    };
  } catch (error) {
    if (isCancelledError(error)) throw error;
    console.error('[DuckDB Join] Error writing function-join rows:', error);
    return {
      success: false,
      message: `Local join failed: ${error.message}`,
      error: error.stack,
    };
  } finally {
    await duck.dropStaging(outPath, stagedTables);
  }
}

module.exports = {
  loadSourceData,
  parseNoSQLOperation,
  sourceCollectionOf,
  TARGET_PLACEHOLDER,
  loadSQLSourceInChunks,
  insertDataToTempTable,
  resolveStagedColumns,
  executeLocalDuckDBJoin,
  writeLocalJoinRows
};
