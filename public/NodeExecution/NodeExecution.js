const pluginManager = require('../pluginManager');
const DuckDB = require('../transfomers/DuckDB');
const { loadSourceData, loadSQLSourceInChunks, insertDataToTempTable, resolveStagedColumns, executeLocalDuckDBJoin, writeLocalJoinRows } = require('../joins/joinExecutionHelpers');
const localSqlite = require('../lib/sqlite');
const { batchChunkSizeFor, DEFAULT_BATCH_CHUNK_SIZE } = require('../lib/batchChunkSize');
const { logStep, traceCall } = require('./executionLog');
const { isCancelledError } = require('./executionCancel');

const VECTOR_DB_TYPES_SET = new Set(['lancedb', 'pinecone']);
const isVectorConnection = (conn) =>
  !!conn && (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES_SET.has(conn.dbType));

// These will be set by the initialize function
let appSqliteDbPath = null;
let getFullConfig = null;
let buildSkillHelpers = null;

/**
 * Initialize the module with required dependencies
 */
function initialize(sqliteDbPath, configGetter, skillHelpersBuilder = null) {
  appSqliteDbPath = sqliteDbPath;
  getFullConfig = configGetter;
  buildSkillHelpers = skillHelpersBuilder;
}

/**
 * Lazy lookup for the vector-db-executor skill. Returns null if not loaded.
 */
function getVectorSkill() {
  return pluginManager.hasSkill && pluginManager.hasSkill('vector-db-executor')
    ? pluginManager.getSkill('vector-db-executor')
    : null;
}

/**
 * Pull rows for a single source, using the vector-db-executor skill when the
 * source is a vector DB; otherwise falling back to the standard
 * loadSourceData helper.
 */
async function pullJoinSourceRows(sourceConnection, sourceConfig) {
  if (!isVectorConnection(sourceConnection)) {
    return await loadSourceData(sourceConnection, sourceConfig, pluginManager, getFullConfig);
  }

  const skill = getVectorSkill();
  if (!skill || typeof skill.fetchVectorSourceRecords !== 'function') {
    throw new Error('vector-db-executor skill not available; cannot pull rows from vector source');
  }

  // The vector table name can live in any of these places depending on
  // whether the source was authored by the AI or wired through a saved local
  // connection. LanceDB connections in particular keep it on
  // connection.dbConfig.tableName, which the previous fallback chain missed
  // and caused `openTable(undefined)` to throw with `StringExpected`.
  const tableName =
    sourceConfig.sourceTableSchema?.tableName
    || sourceConfig.tableName
    || sourceConnection.dbConfig?.tableName
    || sourceConnection.indexName;
  if (!tableName) {
    throw new Error(
      `Vector source ${sourceConfig.sourceNodeId || ''}: no tableName/indexName found on sourceConfig or connection.dbConfig`
    );
  }
  const indexName =
    sourceConfig.indexName
    || sourceConnection.indexName
    || sourceConnection.dbConfig?.indexName
    || tableName;
  const namespace =
    sourceConfig.namespace
    || sourceConnection.namespace
    || sourceConnection.dbConfig?.namespace
    || '';

  const helpers = buildSkillHelpers ? await buildSkillHelpers() : {};
  return await skill.fetchVectorSourceRecords({
    sourceConnection,
    // MERGED, not `sourceConfig.sourceTableSchema || {…}`. The skill reads the
    // index coordinates off this object (joinHandler: `sourceTableSchema.indexName
    // || sourceConnection.indexName`), so the `||` meant that any source with a
    // real schema — i.e. every source in a built workflow — silently discarded
    // the indexName and namespace resolved just above, and Pinecone failed with
    // "Index name is required". The fallback only ever fired for a source that
    // had no schema at all.
    sourceTableSchema: {
      ...(sourceConfig.sourceTableSchema || {}),
      tableName: sourceConfig.sourceTableSchema?.tableName || tableName,
      indexName,
      namespace,
    },
    vectorFetchOperation: sourceConfig.vectorFetchOperation || {},
    pluginManager,
    getFullConfig,
    helpers
  });
}

/**
 * A join step for a vector source that carries no read of its own — no
 * `vectorFetchOperation` (and no sql / nosqlOperation). That is how the join
 * prompt asks for a vector store the function searches itself: it gets an
 * entry, but nothing is fetched for it. Shared with the builder's
 * directReadSources rule so both agree on which sources are passed.
 */
function isDirectReadStep(step) {
  if (!step || typeof step !== 'object') return false;
  const conn = step.connection || step.sourceConnection;
  if (!conn || !isVectorConnection(conn)) return false;
  return !Object.prototype.hasOwnProperty.call(step, 'vectorFetchOperation')
    && !String(step.sql || '').trim()
    && !step.nosqlOperation;
}

/**
 * Does this join write mode keep the target between runs? 'append' and
 * 'merge' do: the target is created only when missing and never dropped (a
 * merge differs only in its insert script, which the model wrote). 'new_table'
 * replaces it every run.
 */
const keepsTarget = (mode) => mode === 'append' || mode === 'merge';

/** Last name segment, unquoted, lower-cased — for comparing two table names. */
function bareTableName(name) {
  const parts = String(name || '').split('.');
  return String(parts[parts.length - 1] || '').replace(/^[`"\[]+|[`"\]]+$/g, '').toLowerCase();
}

/**
 * Does the destination already hold the join's target? Asked of the engine
 * through lib/tableRef.resolveTableRef — the same resolver the output node
 * uses, which knows each connector's case folding and qualifier rule (a bare
 * name on Snowflake, a schema-qualified one on Postgres) — never by parsing
 * SQL. null when it cannot say.
 *
 * `schema` is the connection's DEFAULT schema. getFullConfig returns the
 * connection config flat, so `fullConfig.dbConfig.schema` is usually absent —
 * reading only that made every append run ask Postgres about schema NULL,
 * find nothing, and try to CREATE a table that was already there.
 */
async function destinationTableExists(destPlugin, destFullConfig, connectionId, schema, tableName) {
  if (!destPlugin || !tableName) return null;
  try {
    const { resolveTableRef } = require('../lib/tableRef');
    const ref = await resolveTableRef(destPlugin, destFullConfig, connectionId, tableName, schema || null);
    return !!ref?.found;
  } catch (_) {
    return null;
  }
}

/** The destination connection's default schema, wherever its config keeps it. */
function destinationDefaultSchema(destinationConnection, destFullConfig) {
  return destinationConnection?.targetSchema
    || destinationConnection?.dbConfig?.schema
    || destFullConfig?.schema
    || destFullConfig?.dbConfig?.schema
    || null;
}

/**
 * Build a `ctx` object passed to the AI-generated join `javascriptFunction`
 * (NoSQL / vector destinations). Mirrors the surface area of
 * skills/javascript-executor's sandbox so prompts can describe a single
 * helper API across both skills.
 */
function buildJoinCtx(helpers, directVectorSources = []) {
  if (!helpers) return null;
  // A similarity join's function queries its vector source itself, and the
  // generated call often names only the connection — Pinecone then refuses it
  // ("Index name is required"). When the call targets one of this join's own
  // vector sources, the index and namespace that source points at are filled in.
  const fillVectorCoordinates = (connection, query) => {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return query;
    const conn = String(connection || '');
    const src = directVectorSources.find((s) => conn
      && (conn === s.connectionId || conn === s.connectionName || conn === s.dbType));
    if (!src || src.dbType === 'lancedb') return query;
    return {
      ...query,
      ...(query.indexName ? {} : (src.indexName ? { indexName: src.indexName } : {})),
      ...(query.namespace !== undefined ? {} : (src.namespace ? { namespace: src.namespace } : {})),
    };
  };
  return {
    connections: (helpers.connections || []).map((c) => ({
      id: c.id || c._id,
      name: c.name,
      dbType: c.dbType,
      dbCategory: c.dbCategory
    })),
    aiProviders: helpers.aiProviders || [],
    embeddingProviders: helpers.embeddingProviders || [],
    // Unified data access: pass `dbPath` to hit a local duckdb/sqlite/lancedb
    // file; leave it null for saved connections.
    runQuery:    (connection, query, dbPath = null)             => helpers.runQuery(connection, fillVectorCoordinates(connection, query), dbPath),
    getTables:   (connection, dbPath = null)                    => helpers.getTables(connection, dbPath),
    getColumns:  (connection, table, schema = null, dbPath = null) => helpers.getColumns(connection, table, schema, dbPath),
    askAi:       (prompt, opts = {})       => helpers.callAI(prompt, opts),
    vectorize:   (texts, opts = {})        => helpers.vectorize(texts, opts),
    axios: helpers.axios,
    log: (...args) => console.log('[join-fn]', ...args)
  };
}

/**
 * Run a JavaScript join: load every source into memory, then call the join's
 * AI-written function over them.
 *
 * Shared by every destination that joins in JavaScript — a document store and a
 * vector store always do, and a local or SQL destination does when the join
 * needs embeddings / similarity search, which no SQL engine here can run.
 *
 * Throws rather than returning nothing. A missing function, one that does not
 * compile, or one that returns something other than an array is a broken join,
 * and every caller REPLACES its target — so reading any of those as "no rows"
 * emptied the destination and reported success.
 */
async function runJoinFunction(sourcesConfig, javascriptFunction, label, directVectorSources = []) {
  if (!javascriptFunction || !String(javascriptFunction).trim()) {
    throw new Error(`${label} join has no javascriptFunction to run — rebuild the join from its chat.`);
  }
  const sourceDataArrays = [];
  const directIds = new Set((directVectorSources || []).map((d) => d?.sourceNodeId).filter(Boolean));
  for (const sourceConfig of sourcesConfig || []) {
    const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
    if (!sourceConnection) {
      throw new Error(`Source connection not found for ${sourceConfig.sourceNodeId}`);
    }
    // A vector source the function searches itself (through ctx.runQuery) is
    // not loaded and not passed: the function was written without a parameter
    // for it. Reading it anyway shifted every argument after it — the rows
    // landed in `ctx`, and the run died on "ctx.vectorize is not a function".
    if (directIds.has(sourceConfig.sourceNodeId) || isDirectReadStep(sourceConfig)) continue;
    const rows = await pullJoinSourceRows(sourceConnection, sourceConfig);
    console.log(`[${label} Join] Loaded ${rows.length} rows from ${sourceConfig.sourceNodeId}`);
    sourceDataArrays.push(rows);
  }

  let joinFn;
  try {
    joinFn = eval(`(${javascriptFunction})`);
  } catch (err) {
    throw new Error(`The join function does not compile: ${err.message}`);
  }
  if (typeof joinFn !== 'function') throw new Error('The join\'s javascriptFunction is not a function');

  const ctxHelpers = buildSkillHelpers ? await buildSkillHelpers() : null;
  const joinedRows = await joinFn(...sourceDataArrays, buildJoinCtx(ctxHelpers, directVectorSources));
  if (!Array.isArray(joinedRows)) {
    throw new Error(`The join function must return an array of rows; it returned ${joinedRows === null ? 'null' : typeof joinedRows}.`);
  }
  console.log(`[${label} Join] Join produced ${joinedRows.length} rows`);
  return joinedRows;
}

/** Every key the rows carry, in first-seen order — the columns to insert. */
function rowColumns(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object') for (const k of Object.keys(row)) seen.add(k);
  }
  return [...seen];
}

/**
 * Quote table identifier with optional schema using the plugin's quoteIdentifier method
 */
/**
 * Join staging tables in use right now, process-wide:
 * `<destination connection id>|<staging name>` → the run holding it.
 *
 * Staging names come from node ids, and nothing about two different workflows
 * keeps their ids apart (an imported copy kept the original's). Run
 * concurrently, one dropped the other's staging table mid-load and the
 * destination ended up with rows from both. The per-workflow run lock cannot
 * see that; this does.
 */
const stagingClaims = new Map();

function quoteTableIdentifier(dbType, tableName, schema, config) {
  if (!tableName) return tableName;

  // Check if a plugin exists for this database type
  if (pluginManager.hasConnector(dbType)) {
    const connector = pluginManager.getConnector(dbType);

    if (typeof connector.quoteIdentifier === 'function') {
      return connector.quoteIdentifier(tableName, schema, config);
    }
  }

  // Fallback: return with schema if provided
  return schema ? `${schema}.${tableName}` : tableName;
}

/**
 * Run one statement on a join's DESTINATION and fail if it did not run.
 *
 * A connector reports a failed statement by RETURNING { success: false, message }
 * rather than by throwing — the mysql/postgres/mssql runQuery all catch the
 * driver error themselves. An unchecked call therefore carries on as though the
 * statement had worked, and the real error is discarded. Both ways that went
 * wrong were reported as something else entirely, several steps later:
 *
 *   - a failed CREATE TABLE surfaced as "Table 'database.temp_x' doesn't exist"
 *     from the INSERT after it, hiding the DDL error that actually happened
 *     (MySQL rejecting a bare VARCHAR, which requires a length);
 *   - a failed join INSERT…SELECT returned "Join completed successfully.
 *     0 rows inserted", because rowsAffected simply defaulted to 0.
 *
 * The statement's own message is the only thing that names the problem, so it
 * travels with the failure.
 */
async function runDestStatement(plugin, fullConfig, connectionId, query, what) {
  const result = await plugin.runQuery(fullConfig, connectionId, { query });
  if (result && result.success === false) {
    throw new Error(`${what} failed: ${result.message || 'unknown error'}`);
  }
  return result;
}

// SQL transformation handler implementation
async function handleTransformSQL({
    dbType,
    config,
    connectionId,
    ddl,
    sql,
    previewSql,
    storageLocation,
    operationMode,
    targetSchema,
    targetTableName,
    sourceLocalPath = null,
    // What the source is CALLED. Passed explicitly by the caller, like every
    // other field here — it used to be dug out of `config`, which is the target
    // DATABASE config (credentials, dbPath) and has never carried it. That read
    // silently produced null on every run, and the DuckDB path then fell back to
    // the target table name and had the node read its own unwritten output.
    sourceTableName = null,
    sourceConnectionName = null,
    insertSql = null,
    targetLocalPath = null,
    sourceFormat = null,
    workflowId = null,
    nodeId = null
  }) {
    try {
      console.log('handleTransformSQL', {
        dbType,
        config,
        connectionId,
        ddl,
        sql,
        previewSql,
        storageLocation,
        operationMode,
        targetSchema,
        targetTableName,
        sourceLocalPath,
        targetLocalPath,
        insertSql
      })

      // LOCAL — the node's output is a table in its workflow's DuckDB database.
      // The source is read where it lies (a file, or an upstream node's table
      // in the same database). `in_place` runs the model's ALTER/UPDATE/DELETE
      // against the table; anything else replaces it from the SELECT.
      // Which branch a transform takes is the first thing worth knowing when it
      // writes to somewhere unexpected — the routing rules below are subtle
      // (see isSqlSourceToLocal in workflowExecutionHelpers), and until now the
      // decision existed only as a console.log in the main process.
      logStep('info', `SQL transform routing: dbType=${dbType}, mode=${operationMode || 'replace'}`, {
        kind: 'transform',
        dbType,
        operationMode: operationMode || null,
        storageLocation: storageLocation || null,
        targetTable: targetTableName || null,
        sourceTable: sourceTableName || null,
      });

      if (dbType === 'duckdb') {
        const params = {
          sourceLocalPath,
          sql,
          targetTableName,
          targetLocalPath,
          // What the source is called when it is another node's output — the
          // name the model's `FROM …` refers to.
          sourceTableName,
          sourceFormat,
          // The source is ALSO registered under this connection's own schema,
          // so `FROM <connection>.<table>` — the form the Data Explorer's tree
          // displays — resolves at run time as well as the bare name.
          connectionName: sourceConnectionName,
          workflowId,
          nodeId,
        };
        const duckLabel = operationMode === 'in_place'
          ? 'duckdb.inPlaceLocalUpdate'
          : 'duckdb.createLocalTable';
        return traceCall(
          { kind: 'duckdb', label: duckLabel, sql, detail: { targetTable: targetTableName } },
          () => (operationMode === 'in_place'
            ? DuckDB.inPlaceLocalUpdate(params)
            : DuckDB.createLocalTable(params)),
        );
      }

      // A transform whose TARGET is SQLite is a node saved before local results
      // moved to DuckDB: it wrote into the app's shared SQLite database, a store
      // nothing writes to any more. Rebuilding the node repoints it at DuckDB,
      // which is a one-step fix — so say that rather than failing later with a
      // missing table.
      if (dbType === 'sqlite') {
        logStep('error', 'Transform target is the retired local SQLite store', {
          kind: 'transform', targetTable: targetTableName || null,
        });
        return {
          success: false,
          message:
            `This transform writes to "${targetTableName || 'a local SQLite table'}" in the app's `
            + 'shared SQLite database, which is no longer written to — local results are DuckDB now. '
            + 'Open the node and regenerate it to repoint it at local DuckDB storage.',
        };
      } else {
        // DATABASE TYPES
        if (operationMode === 'in_place') {
          // Execute DDL (ALTER TABLE) and/or UPDATE/DELETE directly on the database
          const fullConfig = await getFullConfig(connectionId, config);
  
          if (!pluginManager.hasConnector(dbType)) {
            return {
              success: false,
              message: `Database type ${dbType} is not supported`
            };
          }
  
          const plugin = pluginManager.getConnector(dbType);
          let sqlRowCount = 0;
          const messages = [];

          // The DDL runs first, and whether ITS failure fails the node depends
          // on whether there is DML behind it.
          //
          // DDL ALONE is the whole node. Nothing else was going to happen, so a
          // failure there is the node's failure and is reported as it stands.
          //
          // DDL + DML is the "add a column, then populate it" pair, and there a
          // failing DDL is routine rather than fatal: the SECOND run of an
          // ADD COLUMN reports "column already exists" precisely because the
          // first run worked. Failing the node on that would make every
          // in-place ALTER a one-shot — MySQL, SQL Server and Redshift have no
          // `ADD COLUMN IF NOT EXISTS` to write instead, so the statement
          // cannot be made rerunnable in SQL. So the DML decides the verdict:
          // it succeeds and the node succeeded, with the DDL's error carried on
          // the result rather than swallowed; it fails and both errors are
          // reported together, since the DDL's is usually the one that explains
          // the DML's ("no such column" behind "could not add column").
          let ddlError = null;
          if (ddl) {
            logStep('info', `Running DDL on ${dbType}`, { kind: 'transform', phase: 'ddl', sql: ddl });
            const ddlResult = await plugin.runQuery(fullConfig, connectionId, { query: ddl });
            if (ddlResult.success) {
              messages.push('DDL executed successfully');
              logStep('info', 'DDL executed successfully', { kind: 'transform', phase: 'ddl' });
            } else if (!sql) {
              // DDL alone was the whole node, so its failure is the node's.
              logStep('error', `DDL execution failed: ${ddlResult.message}`, {
                kind: 'transform', phase: 'ddl', sql: ddl,
              });
              return {
                success: false,
                message: `DDL execution failed: ${ddlResult.message}`
              };
            } else {
              ddlError = ddlResult.message;
              // Not fatal — see the note above on why a failing ADD COLUMN is
              // routine on a rerun — but it is the thing a user hunting a
              // missing column needs to see, and until now it reached them only
              // as a clause tacked onto the node's success message.
              logStep('warn', `DDL did not apply: ${ddlResult.message}. Continuing — the DML behind it decides this node.`, {
                kind: 'transform', phase: 'ddl', sql: ddl,
              });
            }
          }

          // Execute SQL (UPDATE/DELETE) if it exists
          if (sql) {
            logStep('info', `Running DML on ${dbType}`, { kind: 'transform', phase: 'dml', sql });
            const sqlResult = await plugin.runQuery(fullConfig, connectionId, { query: sql });
            console.log('sqlResult: ', sqlResult)
            if (!sqlResult.success) {
              logStep('error', `SQL execution failed: ${sqlResult.message}`, {
                kind: 'transform', phase: 'dml', sql,
                ...(ddlError ? { precedingDdlError: ddlError } : {}),
              });
              return {
                success: false,
                message: ddlError
                  ? `SQL execution failed: ${sqlResult.message}. The DDL before it also failed: ${ddlError}`
                  : `SQL execution failed: ${sqlResult.message}`
              };
            }
            sqlRowCount = sqlResult.rowCount || 0;
            messages.push(`${sqlRowCount} rows modified`);
            logStep('info', `${sqlRowCount} rows modified`, {
              kind: 'transform', phase: 'dml', rowCount: sqlRowCount,
            });
          }

          return {
            success: true,
            // A DDL that failed while the DML went through is not a failure, but
            // it is not nothing either — a rerun's duplicate column and a real
            // schema problem look identical from here. Flagged so the run shows
            // amber and the message says what was skipped.
            warning: !!ddlError,
            message: ddlError
              ? `${messages.join('. ') || 'Operation completed'}. DDL did not apply: ${ddlError}`
              : (messages.length > 0 ? messages.join('. ') : 'Operation completed successfully'),
            rowCount: sqlRowCount // For UPDATE/DELETE row count
          };
        }else if(storageLocation === 'database'){
        // Execute DDL + INSERT directly in the database
          // This works for all SQL databases with plugin connectors
          const fullConfig = await getFullConfig(connectionId, config);
  
          if (!pluginManager.hasConnector(dbType)) {
            return {
              success: false,
              message: `Database type ${dbType} is not supported. No plugin connector available.`
            };
          }
  
          const plugin = pluginManager.getConnector(dbType);

          // Drop existing table if it exists
          if (targetTableName) {
            // console.log('dbType, targetTableName, targetSchema: ', dbType, targetTableName, targetSchema, )
            const quotedTableName = quoteTableIdentifier(dbType, targetTableName, targetSchema, fullConfig);
            const dropQuery = `DROP TABLE IF EXISTS ${quotedTableName}`;
            await plugin.runQuery(fullConfig, connectionId, { query: dropQuery });
          }
          // console.log("ddl: ", ddl)
          // Execute DDL
          //
          // Fatal here, unlike the in-place branch above. A new table's DDL is
          // the CREATE that the DROP immediately before it just made necessary,
          // so a failure means the target does not exist — and letting the
          // INSERT run anyway would either fail for a second reason or, worse,
          // succeed against a stale table left over from an earlier shape and
          // report rows written into the wrong place.
          let ddlResult = {};
          if(ddl){

            ddlResult = await plugin.runQuery(fullConfig, connectionId, { query: ddl });
            console.log('ddlResult: ', ddlResult)

            if (!ddlResult.success) {
              return {
                success: false,
                message: `DDL execution failed: ${ddlResult.message}`
              };
            }
          }
          let sqlResult = {};
          if(sql){
            // Execute INSERT
            sqlResult = await plugin.runQuery(fullConfig, connectionId, { query: sql });
            console.log('sqlResult: ', sqlResult)

            if (!sqlResult.success) {
              return {
                success: false,
                message: `SQL execution failed: ${sqlResult.message}`
              };
            }
          }

  
          // Success - return result.
          //
          // A DDL-only node reaching here is one saved BEFORE the connector
          // prompts required a separate INSERT: its ddl is a CREATE ... AS
          // SELECT, which fills the table in the same statement, so there is no
          // row count to report. Saying "0 rows inserted" reads as a node that
          // did nothing, which is the opposite of what happened. New builds
          // always carry both statements — see the completeness gate in
          // workflowBuilder.assembleTransformerConfig.
          const ranInsert = !!(sql && String(sql).trim());
          return {
            success: true,
            message: ranInsert
              ? `Table created and ${sqlResult.rowCount || 0} rows inserted`
              : 'Table created and populated in a single statement',
            rowCount: sqlResult.rowCount || 0
          };
  
        } else if (storageLocation === 'local') {
          // Pull data from a remote database into this node's table in the
          // workflow database. The SELECT has to run on the source through its
          // own plugin — DuckDB can't reach a Postgres table — so rows are
          // streamed across and written here.
          const fullConfig = await getFullConfig(connectionId, config);

          if (!pluginManager.hasConnector(dbType)) {
            return {
              success: false,
              message: `Database type ${dbType} is not supported. Cannot pull data to local storage.`
            };
          }

          const plugin = pluginManager.getConnector(dbType);
          return DuckDB.databaseToLocal({
            fullConfig,
            plugin,
            connectionId,
            sql,
            targetTableName,
            targetLocalPath,
            workflowId,
            nodeId,
          });
        }
  
  
      }
  
      // Unknown storage location
      return {
        success: false,
        message: `Invalid settings location: ${storageLocation}. Must be 'database' or 'local'.`
      };
  
  
    } catch (error) {
      // A stop must reach the runner as an exception — see executeOutput.
      if (isCancelledError(error)) throw error;
      console.error('[dbconn:transform-sql]', error);
      return {
        success: false,
        message: `Transformation failed: ${error.message}`,
        error: error.stack
      };
    }
  }


  // NoSQL transformation handler implementation
async function handleTransformNoSQL({
    dbType,
    config,
    connectionId,
    sourceLocalPath,
    sourceCollection,
    targetCollection,
    targetLocalPath = null,
    operationType,
    nosqlOperation,
    transformFunction,
    storageLocation,
    operationMode,
    // Optional scope for the local DuckDB table the aggregated docs land in.
    workflowId = null,
    nodeId = null
  }) {
    // console.log('[handleTransformNoSQL] input', JSON.stringify({
    //   dbType,
    //   connectionId,
    //   sourceLocalPath,
    //   sourceCollection,
    //   targetCollection,
    //   operationType,
    //   storageLocation,
    //   operationMode
    // }));
    try {
      // NoSQL means a remote document store. Local files — JSON included —
      // are read as SQL by DuckDB and go through handleTransformSQL, so nothing
      // local arrives here at all.
      if (pluginManager.hasConnector(dbType)) {
        // Use NoSQL plugin for transformation (MongoDB, etc.)
        const fullConfig = await getFullConfig(connectionId, config);
  
        const plugin = pluginManager.getConnector(dbType);
        if (!plugin || !plugin.transformData) {
          return {
            success: false,
            message: `${dbType} plugin not found or does not support transformations`
          };
        }
  
        const result = await plugin.transformData(fullConfig, connectionId, {
          sourceCollection,
          targetCollection,
          operationType,
          nosqlOperation,
          transformFunction,
          storageLocation,
          operationMode
        });
  
        // The plugin aggregated remotely and handed back documents to land
        // locally. They go where every other node output goes: a table in this
        // workflow's own DuckDB database. They used to become a local file
        // which nothing downstream reads any more — the preview, joins and
        // output nodes all address a node's result as a DuckDB table.
        if (result.needsLocalStorage && result.transformedDocs) {
          const docs = Array.isArray(result.transformedDocs)
            ? result.transformedDocs
            : [result.transformedDocs];
          if (docs.length === 0) {
            return { success: true, message: 'Transformation produced no documents', recordCount: 0 };
          }

          const duck = require('../duckdb');
          const table = targetCollection || `transform_${String(nodeId || Date.now()).replace(/[^A-Za-z0-9_]/g, '_')}`;
          // `mode` mirrors what the old local path meant by operationMode: a new
          // table replaces, anything else adds to what is already there.
          const mode = operationMode === 'new_table' ? 'replace' : 'append';

          const { rowCount } = targetLocalPath && !workflowId
            ? await duck.ingestRowsToTableAt(docs, targetLocalPath, table, { mode })
            : await duck.ingestRowsToTable(docs, workflowId, table, { mode });

          return {
            success: true,
            message: `Saved ${rowCount} document(s) to ${table}`,
            recordCount: rowCount,
            documentsInserted: rowCount,
            totalProcessed: result.totalProcessed || rowCount,
            localPath: workflowId ? duck.workflowDbPath(workflowId) : targetLocalPath,
            targetTableName: table,
          };
        }
  
        return result;
  
      } else {
        return {
          success: false,
          message: `Unsupported database type: ${dbType}. Only 'mongodb' is supported.`
        };
      }
  
    } catch (error) {
      // A stop must reach the runner as an exception rather than a failed
      // transform — see executeOutput's catch in outputExecutionHelpers.
      if (isCancelledError(error)) throw error;
      return {
        success: false,
        message: `Transformation failed: ${error.message}`,
        error: error.stack
      };
    }
  }

  /**
 * Execute Join Operation
 * Handles joining multiple data sources with SQL or NoSQL destinations
 */
async function handleExecuteJoin({
    destinationConnection,
    joinConfig,
    operationMode = 'new_table',
    // Optional — used only to scope a local result to this run's own workflow
    // database. Absent for ad-hoc runs.
    workflowId = null,
    nodeId = null
  }) {
    // Drops the staging tables a remote SQL join created — set once they
    // exist, so a failed run removes them too instead of leaving them for the
    // next run's DROP (which never comes if the join is rebuilt under another
    // name).
    let dropStagingTables = null;
    try {
      // Rows per source read AND per temp-table batchInsert on the remote-join
      // path below. It was 1000, which made staging a large source thousands of
      // LIMIT/OFFSET round trips and thousands of inserts — the round trips,
      // not the rows, were the minutes. Shared default with the output node so
      // the two write paths do not drift; see public/lib/batchChunkSize.js.
      const CHUNK_SIZE = DEFAULT_BATCH_CHUNK_SIZE;
      const isVectorDestination = isVectorConnection(destinationConnection);
      // NoSQL means a remote document store. A local destination is DuckDB and
      // takes the SQL path, whatever the shape of the data.
      const isNoSQL = destinationConnection.dbType === 'mongodb';
      const targetTableName = joinConfig.targetTableName || joinConfig.targetCollection;

      console.log(`[Join] Starting ${isVectorDestination ? 'Vector' : (isNoSQL ? 'NoSQL' : 'SQL')} join operation`);
      console.log(`[Join] Destination: ${destinationConnection.dbType}, Mode: ${operationMode}`);

      // ===== VECTOR DESTINATION =====
      // Pull every source into memory (vector sources go through the skill),
      // run the AI's joinFunction, then hand the joined rows to the skill for
      // embedding + upsert into the vector destination.
      if (isVectorDestination) {
        const sourcesConfig = joinConfig.sourcesConfig || [];
        const javascriptFunction = joinConfig.transformFunction || joinConfig.javascriptFunction;

        const vectorDest = joinConfig.vectorDestination || {};
        if (!vectorDest.columnToEmbed || !vectorDest.embeddingProvider || !vectorDest.embeddingModel) {
          return {
            success: false,
            message: 'Vector destination missing required fields: columnToEmbed, embeddingProvider, embeddingModel'
          };
        }

        const joinedRows = await runJoinFunction(sourcesConfig, javascriptFunction, 'Vector', joinConfig.directVectorSources || []);

        const skill = getVectorSkill();
        if (!skill || typeof skill.embedAndUpsertJoinedRows !== 'function') {
          return { success: false, message: 'vector-db-executor skill not available' };
        }
        const helpers = buildSkillHelpers ? await buildSkillHelpers() : {};

        const result = await skill.embedAndUpsertJoinedRows({
          joinedRows,
          columnToEmbed: vectorDest.columnToEmbed,
          // The row's primary key the join builder named — the id each vector
          // is upserted under. Absent: a hash of the whole row.
          idColumn: vectorDest.idColumn || null,
          // New-table (replace) mode: the store ends up holding exactly this
          // run's records. Append / merge upsert by id and keep the rest. It
          // used to upsert in every mode, so a replace whose ids changed run to
          // run (a row hash over a float score) grew the store each time.
          writeMode: keepsTarget(operationMode) ? 'append' : 'truncate',
          vectorDbType: vectorDest.vectorDbType || destinationConnection.dbType,
          targetTable: vectorDest.targetTable || targetTableName,
          targetLocalPath: vectorDest.targetLocalPath || destinationConnection.localPath,
          targetConnectionId: vectorDest.targetConnectionId || destinationConnection.id,
          indexName: vectorDest.indexName,
          namespace: vectorDest.namespace || '',
          embeddingProvider: vectorDest.embeddingProvider,
          embeddingModel: vectorDest.embeddingModel,
          embeddingApiKey: vectorDest.embeddingApiKey,
          pluginManager,
          getFullConfig,
          helpers
        });

        return {
          success: !!result?.success,
          message: result?.message,
          recordCount: result?.recordCount || 0,
          targetTableName: vectorDest.targetTable || targetTableName,
          localPath: result?.targetLocalPath
        };
      }
  
      if (isNoSQL) {
        // ===== NoSQL JOIN: Load data into memory, run JavaScript function, insert to destination =====
  
        const sourcesConfig = joinConfig.sourcesConfig || [];
        const javascriptFunction = joinConfig.transformFunction || joinConfig.javascriptFunction;

        // Steps 1 + 2: load every source, run the join function. Throws on a
        // missing function or a non-array result — see runJoinFunction for why
        // that must never read as "no rows" here, where the target is dropped.
        const joinedResults = await runJoinFunction(sourcesConfig, javascriptFunction, 'NoSQL', joinConfig.directVectorSources || []);

        // Step 3: Insert into the destination document store
        {
          if (!pluginManager.hasConnector(destinationConnection.dbType)) {
            return {
              success: false,
              message: `Database type ${destinationConnection.dbType} is not supported`
            };
          }
  
          const fullConfig = await getFullConfig(destinationConnection.id, destinationConnection.dbConfig || {});
          const plugin = pluginManager.getConnector(destinationConnection.dbType);
  
          // runJoinFunction has already refused anything that is not an array.
          const documents = joinedResults;

          // Strip `_id` for the same reason the output node does (see
          // outputExecutionHelpers): it names a document within its OWN
          // collection. A join function that returns source documents rather
          // than freshly-built objects would write another collection's ids
          // into the target — and two Mongo sources contributing rows can
          // collide with EACH OTHER on `_id` even in a brand-new collection,
          // failing the whole batch with E11000.
          //
          // In place, no rebuild: these objects were produced by the join
          // function for this insert and nothing else holds them. Most join
          // functions build fresh objects with no `_id` at all, in which case
          // the `in` check is all this costs.
          for (const doc of documents) {
            if (doc !== null && typeof doc === 'object' && '_id' in doc) delete doc._id;
          }

          // A join that matched nothing is not a failure of this node. What it
          // MEANS for the destination depends on the mode, and the two answers
          // are opposites:
          //
          //  · 'new_table' REPLACES the target every run. Replacing it with
          //    nothing means the target ends up EMPTY. Leaving last run's rows
          //    in place is not caution, it is staleness — a staging collection
          //    that the join reported as "no new records" still handed the
          //    downstream output node the PREVIOUS run's rows, which it then
          //    re-appended to the destination.
          //  · any other mode adds to what is there, so an empty result adds
          //    nothing and the target is correctly left alone.
          //
          // Either way insertMany is skipped rather than called with [] — the
          // driver rejects an empty batch outright.
          const isEmpty = documents.length === 0;

          if (isEmpty && operationMode !== 'new_table') {
            console.warn(`[NoSQL Join] Join matched no records — ${targetTableName} left unchanged`);
            return {
              success: true,
              warning: true,
              message: `No rows to write: the join matched no records, so ${targetTableName} was left unchanged.`,
              documentsInserted: 0,
            };
          }

          if (operationMode === 'new_table') {
            // Drop existing collection
            try {
              await plugin.runQuery(fullConfig, destinationConnection.id, {
                operation: 'drop',
                collection: targetTableName
              });
            } catch (err) {
              // Collection might not exist
            }
          }

          if (isEmpty) {
            // 'new_table' with nothing to write: the drop above already made the
            // target reflect this run. Downstream reads an empty collection,
            // which is the honest answer, rather than last run's rows.
            console.warn(`[NoSQL Join] Join matched no records — ${targetTableName} replaced with an empty collection`);
            return {
              success: true,
              warning: true,
              message: `No rows to write: the join matched no records, so ${targetTableName} is now empty.`,
              documentsInserted: 0,
            };
          }

          // Insert documents
          const insertResult = await plugin.runQuery(fullConfig, destinationConnection.id, {
            operation: 'insertMany',
            collection: targetTableName,
            documents
          });
  
          // A connector reports a failed statement by RETURNING
          // { success: false }, not by throwing — the MongoDB runQuery catches
          // the driver error itself. This result used to be assigned and then
          // discarded, so a write that never landed was reported as a
          // successful load of however many rows we had HOPED to write, and
          // the whole run went green on top of it.
          if (!insertResult || insertResult.success === false) {
            return {
              success: false,
              message: `Could not write to ${targetTableName}: ${insertResult?.message || 'unknown error'}`,
            };
          }

          // What the destination says it took, not what it was handed.
          const inserted = insertResult.insertedCount
            ?? insertResult.rowCount
            ?? documents.length;

          return {
            success: true,
            message: `Successfully inserted ${inserted} documents into ${targetTableName}`,
            documentsInserted: inserted
          };
        }
  
      } else {
        // ===== SQL JOIN: Create temp tables, load data, execute join SQL =====
  
        const sourcesConfig = joinConfig.sourcesConfig || [];
        const targetDdl = joinConfig.targetDdl || joinConfig.ddl;
        const joinSql = joinConfig.joinSql || joinConfig.sql;
        const tempTablesToCleanup = [];
        // Staging names this run has claimed (see stagingClaims), released
        // with the tables themselves.
        const claimedStaging = [];
        // Identity of THIS run for the claims (an object, so two runs of one
        // node are still told apart).
        const stagingOwner = { label: `workflow ${workflowId || 'unknown'}, node ${nodeId || 'unknown'}` };

        // A local destination writes this node's own table in the workflow's
        // DuckDB database.
        const isLocalDestination = destinationConnection.dbType === 'duckdb';

        // A JavaScript join into a table destination. Built when the join needs
        // embeddings or similarity search, which no SQL engine here can run:
        // the generator then emits a function and no joinSql. The rows it
        // returns are written as the destination table — that is the only
        // difference from a document destination.
        const javascriptFunction = joinConfig.transformFunction || joinConfig.javascriptFunction;
        const isFunctionJoin = !String(joinSql || '').trim() && !!javascriptFunction;

        if (isFunctionJoin && isLocalDestination) {
          const rows = await runJoinFunction(sourcesConfig, javascriptFunction, 'DuckDB', joinConfig.directVectorSources || []);
          return await writeLocalJoinRows({
            rows,
            targetTableName,
            targetLocalPath: joinConfig.targetLocalPath,
            emptyColumns: joinConfig.targetColumns,
            operationMode,
            workflowId,
            nodeId,
          });
        }
        // console.log('sourcesConfig: ', joinSql, targetDdl, sourcesConfig)
        if (isLocalDestination) {
          // Vector sources have no SQL surface, so resolve their rows via the
          // skill first; the join then sees them like any other source.
          for (const sc of sourcesConfig) {
            const sconn = sc.connection || sc.sourceConnection;
            if (isVectorConnection(sconn)) {
              sc._preloadedRows = await pullJoinSourceRows(sconn, sc);
              console.log(`[DuckDB Join] Pre-loaded ${sc._preloadedRows.length} vector rows for ${sc.sourceNodeId}`);
            }
          }

          // ===== LOCAL DUCKDB JOIN =====
          return await executeLocalDuckDBJoin({
            sourcesConfig,
            joinSql,
            targetDdl,
            operationMode,
            targetTableName,
            targetLocalPath: joinConfig.targetLocalPath,
            pluginManager,
            getFullConfig,
            workflowId,
            nodeId,
          });
        }
  
        // ===== REMOTE DATABASE JOIN =====
  
        // Get destination connection
        if (!pluginManager.hasConnector(destinationConnection.dbType)) {
          return {
            success: false,
            message: `Database type ${destinationConnection.dbType} is not supported`
          };
        }
  
        const destFullConfig = await getFullConfig(destinationConnection.id, destinationConnection.dbConfig || {});
        const destPlugin = pluginManager.getConnector(destinationConnection.dbType);
        dropStagingTables = async () => {
          for (const key of claimedStaging.splice(0)) stagingClaims.delete(key);
          for (const tempTable of tempTablesToCleanup.splice(0)) {
            try {
              await destPlugin.runQuery(destFullConfig, destinationConnection.id, { query: `DROP TABLE IF EXISTS ${tempTable}` });
            } catch (err) {
              console.error(`Failed to cleanup ${tempTable}:`, err);
            }
          }
        };
        // Sources whose read came back empty — named when the join writes 0 rows.
        const emptySources = [];

        // ── Guard: a replace (new_table) run must not drop a table it reads ──
        // A source already on the destination is read IN PLACE by the join SQL.
        // If that same table is the target, the DROP + CREATE below empties it
        // before the INSERT reads it: the run "succeeds" with 0 rows and the
        // source data is gone. Refused before anything is touched. Append mode
        // never drops, so there it is allowed (each run reads what earlier runs
        // added).
        if (!keepsTarget(operationMode) && !isFunctionJoin) {
          const clash = sourcesConfig.find((sc) => {
            const conn = sc?.connection || sc?.sourceConnection || {};
            const inPlace = !(sc?.ddl && sc?.tempTableName) && conn.id === destinationConnection.id;
            return inPlace && bareTableName(sc.tableName || sc.sourceTableSchema?.tableName) === bareTableName(targetTableName);
          });
          if (clash) {
            return {
              success: false,
              message: `Join ${targetTableName} replaces its target on every run, but "${clash.tableName}" is also one of its sources `
                + 'on the same connection — the replace would empty it before it is read. Write to a different target table, '
                + 'or switch the join to append mode. Nothing was changed.',
              recordsProcessed: 0,
            };
          }
        }

        // On the streaming path below, the SOURCE read size decides the
        // destination write size: every batch pulled from the source becomes
        // one batchInsert. So a destination that rations calls rather than
        // statement size — BigQuery spends a daily load-job quota — has to be
        // able to widen the read. See public/lib/batchChunkSize.js.
        const LOAD_CHUNK_SIZE = batchChunkSizeFor(destPlugin, CHUNK_SIZE);

        // JavaScript join into a SQL destination: no temp tables and no join
        // SQL. The target is created from targetDdl exactly as a SQL join's is
        // (drop, then CREATE), and the function's rows are inserted into it in
        // batches by column name — the same batchInsert a temp table loads with.
        if (isFunctionJoin) {
          if (!String(targetDdl || '').trim()) {
            return {
              success: false,
              message: `Join ${targetTableName} has no targetDdl, so its destination table cannot be created. Rebuild the join from its chat.`,
            };
          }
          const rows = await runJoinFunction(sourcesConfig, javascriptFunction, 'SQL', joinConfig.directVectorSources || []);
          // The schema the DROP below quotes with — unchanged; the existence
          // check takes the connection's default schema (see destinationDefaultSchema).
          const fnSchema = destinationConnection.targetSchema || destFullConfig?.dbConfig?.schema || null;
          // Append keeps the target and only creates it when it is missing; a
          // new_table run drops and recreates it.
          const keepTarget = keepsTarget(operationMode)
            && await destinationTableExists(destPlugin, destFullConfig, destinationConnection.id,
              destinationDefaultSchema(destinationConnection, destFullConfig), targetTableName) === true;
          if (!keepTarget) {
            try {
              const quotedTarget = quoteTableIdentifier(destinationConnection.dbType, targetTableName, fnSchema, destFullConfig);
              await destPlugin.runQuery(destFullConfig, destinationConnection.id, { query: `DROP TABLE IF EXISTS ${quotedTarget}` });
            } catch (err) {
              console.log('[SQL Join] Ignoring drop error for target:', err.message);
            }
            await runDestStatement(
              destPlugin, destFullConfig, destinationConnection.id,
              targetDdl, `Creating target table ${targetTableName}`,
            );
          }
          // Every key the rows carry. A key the DDL has no column for fails the
          // insert loudly, which is what should happen — a silent drop would
          // lose the similarity results this join exists to produce.
          const columns = rowColumns(rows);
          const inserted = rows.length
            ? await insertDataToTempTable(
              destPlugin, destFullConfig, destinationConnection.id,
              targetTableName, columns, rows, LOAD_CHUNK_SIZE,
            )
            : 0;
          return {
            success: true,
            warning: inserted === 0,
            message: inserted === 0
              ? `Join completed — 0 rows written to ${targetTableName}. The join function returned no rows.`
              : `Join completed successfully. ${inserted} rows inserted into ${targetTableName}`,
            rowsAffected: inserted,
            rowCount: inserted,
            targetTableName,
          };
        }


        // Step 1: Create temp tables and load source data
        for (let i = 0; i < sourcesConfig.length; i++) {
          const sourceConfig = sourcesConfig[i];
  
          // A source already on the destination connection is read in place —
          // no temp table. Every other source MUST be staged. Missing staging
          // fields used to mean "skip it" regardless, so a source the model
          // forgot to stage vanished from the join and it failed later on a
          // table that does not exist. Same test the builder uses to decide a
          // source is in the destination (connection id equality).
          if (!sourceConfig.ddl || !sourceConfig.tempTableName) {
            const srcConnId = (sourceConfig.connection || sourceConfig.sourceConnection || {}).id;
            if (srcConnId && srcConnId === destinationConnection.id) continue;
            throw new Error(
              `Join source "${sourceConfig.sourceNodeId || 'unknown'}" is not on the destination connection, `
              + 'so it has to be staged into a temp table, but it has no ddl / tempTableName. '
              + 'Rebuild the join from its chat.',
            );
          }
          console.log(`SOURCE_CONFIG: `, sourceConfig);
  
          const tempTableName = sourceConfig.tempTableName;

          // Claim the staging name on this connection before touching it. The
          // DROP below would otherwise remove a table another running workflow
          // is still loading into — two workflows whose nodes share ids (an
          // import of an export, before imports were given fresh ids) stage
          // under the same name, and the run lock is per workflow so it does
          // not see them. Refusing here leaves the other run untouched.
          const claimKey = `${destinationConnection.id}|${String(tempTableName).toLowerCase()}`;
          const claimedBy = stagingClaims.get(claimKey);
          if (claimedBy && claimedBy !== stagingOwner) {
            throw new Error(
              `The staging table ${tempTableName} on ${destinationConnection.name || destinationConnection.dbType} `
              + `is in use by another run (${claimedBy.label}). Two workflows that stage the same table cannot `
              + 'run at once — wait for it to finish. If this workflow was imported before imports were given '
              + 'their own node ids, re-import it so its staging names are its own.',
            );
          }
          if (!claimedBy) {
            stagingClaims.set(claimKey, stagingOwner);
            claimedStaging.push(claimKey);
          }

          // One quoted form for every statement built HERE — the DROP below and
          // the cleanup at the end — so both name the same table that
          // `sourceConfig.ddl` creates. Quoted, because that DDL is: PostgreSQL
          // keeps a capital in a quoted name and folds it away in a bare one,
          // and the two forms are then different tables. (The load in between
          // goes through batchInsert, which takes the name UNQUOTED and quotes
          // it itself — see outputExecutionHelpers' note at its own call.)
          //
          // No schema, because the DDL is unqualified: the table lands wherever
          // the connection's own search path (or default database/dataset) puts
          // it, and naming a schema here could point somewhere else. The
          // connector's quoteIdentifier still qualifies where a bare name would
          // otherwise be ambiguous to it — MySQL with the connection's
          // database, BigQuery with its dataset.
          const quotedTempTableName = quoteTableIdentifier(
            destinationConnection.dbType, tempTableName, null, destFullConfig,
          );
          tempTablesToCleanup.push(quotedTempTableName);

          console.log(`TEMP_TABLE: ${tempTableName} -> ${quotedTempTableName}`);

          // Drop temp table if exists (from previous failed runs)
          try {
            await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${quotedTempTableName}`});
          } catch (err) {
            // Ignore errors if table doesn't exist
            console.log(`Ignoring drop table error for ${tempTableName}: ${err.message}`);
          }
  
          // Create temp table. Checked: a DDL that fails here leaves nothing for
          // the load below to write into, and the "table doesn't exist" it then
          // raises names neither the statement nor the reason.
          await runDestStatement(
            destPlugin, destFullConfig, destinationConnection.id,
            sourceConfig.ddl, `Creating temp table ${tempTableName}`,
          );
  
          // Load data from source
          const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;
          const isNoSQLSource = sourceConnection.dbType === 'mongodb';
          const isVectorSource = isVectorConnection(sourceConnection);

          // Get selectedColumns from sourceConfig
          const selectedColumns = sourceConfig.selectedColumns;
          if (!selectedColumns || selectedColumns.length === 0) {
            throw new Error(`No selectedColumns found for source ${sourceConfig.sourceNodeId}`);
          }
          // The names the CREATE above actually produced (see
          // resolveStagedColumns) — a bare DDL column is upper case on Snowflake.
          const tableColumns = await resolveStagedColumns(
            destPlugin, destFullConfig, destinationConnection.id, tempTableName, selectedColumns,
          );

          let totalInserted = 0;

          if (isNoSQLSource || isVectorSource) {
            // NoSQL or Vector source: Load all data into memory, then batch
            // insert into the temp table. Vector rows are flattened by the
            // skill so metadata fields appear as top-level columns.
            const sourceData = await pullJoinSourceRows(sourceConnection, sourceConfig);
            totalInserted = await insertDataToTempTable(
              destPlugin,
              destFullConfig,
              destinationConnection.id,
              tempTableName,
              selectedColumns,
              sourceData,
              LOAD_CHUNK_SIZE,
              tableColumns,
            );
  
            console.log(`SQL_LOADED: ${totalInserted}/${sourceData.length}`);
  
          } else {
            // SQL source: Stream data in chunks
            // console.log(`[SQL Join] Loading SQL source ${i + 1}...`);

            totalInserted = await loadSQLSourceInChunks(
              sourceConnection,
              sourceConfig.sql,
              LOAD_CHUNK_SIZE,
              pluginManager,
              getFullConfig,
              async (rows) => {
                await insertDataToTempTable(
                  destPlugin,
                  destFullConfig,
                  destinationConnection.id,
                  tempTableName,
                  selectedColumns,
                  rows,
                  rows.length, // Don't re-chunk, already chunked by loadSQLSourceInChunks
                  tableColumns,
                );
              },
              // Lets a local DuckDB source be resolved by path instead of
              // through the connector, which cannot open one.
              sourceConfig
            );

            console.log(`[SQL Join] Loaded ${totalInserted} rows from SQL source`);
          }
  
          console.log(`[SQL Join] Finished loading source ${i + 1}: ${totalInserted} total rows`);
          if (totalInserted === 0) emptySources.push(sourceConfig.tableName || sourceConfig.sourceNodeId);
        }
  
        // Step 2: Create the target. new_table drops and recreates it every
        // run; append keeps it and creates it only when it is missing.
        // The DROP below quotes with the schema it always has; the existence
        // check takes the connection's default schema (see destinationDefaultSchema).
        const targetSchemaName = destinationConnection.targetSchema || destFullConfig?.dbConfig?.schema || null;
        const appendToExisting = keepsTarget(operationMode)
          && await destinationTableExists(destPlugin, destFullConfig, destinationConnection.id,
            destinationDefaultSchema(destinationConnection, destFullConfig), targetTableName) === true;
        if (targetDdl && !appendToExisting) {
          console.log(`join_${keepsTarget(operationMode) ? 'create_missing' : 'new_table'} ${targetTableName}...`);
  
          // Drop target table if exists (for clean re-runs)
          if (!keepsTarget(operationMode)) {
            try {
              const quotedTargetTableName = quoteTableIdentifier(destinationConnection.dbType, targetTableName, targetSchemaName, destFullConfig);
              await destPlugin.runQuery(destFullConfig, destinationConnection.id, {query: `DROP TABLE IF EXISTS ${quotedTargetTableName}`});
            } catch (err) {
              console.log('destPlugin_drop_table_error: ', err)
              // Ignore errors if table doesn't exist
            }
          }
  
          await runDestStatement(
            destPlugin, destFullConfig, destinationConnection.id,
            targetDdl, `Creating target table ${targetTableName}`,
          );
        }
  
        // Step 3: Execute join query
        console.log(`join_execute_main_query: `, joinSql);
        // Checked: rowsAffected falls back to 0, so an unchecked failure here
        // was reported as "Join completed successfully. 0 rows inserted" — a
        // node that wrote nothing, and said so as though that were the answer.
        const joinResult = await runDestStatement(
          destPlugin, destFullConfig, destinationConnection.id, joinSql, 'Join query',
        );
        const rowsAffected = joinResult.rowCount || joinResult.affectedRows || 0;
  
        // Step 4: Clean up temp tables
        console.log(`join_drop_temp_table: `, tempTablesToCleanup);
        // Already quoted when the table was named, by the same call the CREATE
        // and the load went through — re-quoting it here would only be the
        // idempotent guard handing it back.
        await dropStagingTables();

        // 0 rows is a result worth a warning, not a plain success — above all
        // when a source read nothing, which is a wrong read far more often
        // than a genuinely empty source (a vector store asked for the wrong
        // namespace answered with 0 rows and the run said "completed").
        return {
          success: true,
          ...(rowsAffected === 0 ? { warning: true } : {}),
          message: rowsAffected === 0
            ? `Join completed — 0 rows inserted into ${targetTableName}.${emptySources.length
              ? ` These sources returned no rows: ${emptySources.join(', ')}.` : ''}`
            : `Join completed successfully. ${rowsAffected} rows inserted into ${targetTableName}`,
          rowsAffected,
          targetTableName
        };
      }
  
    } catch (error) {
      // A stop must reach the runner as an exception — see executeOutput.
      //
      // The staging tables go either way — a failure or a stop.
      if (dropStagingTables) await dropStagingTables().catch(() => {});
      if (isCancelledError(error)) throw error;
      console.error('Join execution error:', error);
      return {
        success: false,
        message: `Join execution failed: ${error.message}`,
        error: error.stack
      };
    }
  }

/**
 * Execute a branch validation plan.
 *
 * Input:
 *   sources: Array<{
 *     sourceNodeId, sourceNodeLabel, sourceNodeType,
 *     connection: { id, dbType, dbConfig, connectionType, localPath },
 *     tableName
 *   }>
 *   steps: Array<{
 *     stepNumber, sourceNodeId, description,
 *     sql?: string (must contain {LIMIT_OFFSET_HERE}),
 *     nosqlOperation?: string (JSON string),
 *     selectedColumns?: string[]
 *   }>
 *   validationFunction: string — a JS function expression
 *     `function(stepResults) { ... return boolean; }`
 *   outputRoutes: { "true": string, "false": string }
 *
 * Output:
 *   { success: true, result: boolean, route: string,
 *     stepResults: { [stepNumber]: { rows: Array<Object>, count: number } } }
 *   or { success: false, error: string, stepResults? }
 */
async function handleExecuteBranch({
  sources,
  steps,
  validationFunction,
  outputRoutes,
}) {
  const stepResults = {};
  try {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { success: false, error: 'No steps to execute' };
    }
    if (typeof validationFunction !== 'string' || !validationFunction.trim()) {
      return { success: false, error: 'Missing validation function' };
    }

    const sourceById = new Map();
    for (const src of sources || []) {
      if (src && src.sourceNodeId) sourceById.set(src.sourceNodeId, src);
    }

    for (const step of steps) {
      const stepNumber = step.stepNumber;
      const source = sourceById.get(step.sourceNodeId);
      if (!source) {
        return {
          success: false,
          error: `Step ${stepNumber}: unknown sourceNodeId "${step.sourceNodeId}"`,
          stepResults,
        };
      }

      const sourceConnection = source.connection || {};
      // loadSourceData reads either nosqlOperation or sql from the step config
      const stepConfig = {
        sql: step.sql,
        nosqlOperation: step.nosqlOperation,
      };

      let rows = [];
      try {
        const dbType = sourceConnection.dbType;
        if (dbType === 'sqlite') {
          // A SQLite source is a FILE, read by path. This used to go through the
          // app's shared SQLite pool, which could only ever reach app-data.db —
          // so a step against a .sqlite the user picked themselves silently ran
          // against the wrong database. Same lib and same path resolution the
          // join reader uses.
          const dbPath = sourceConnection.fileInfo?.filePath
            || sourceConnection.localPath
            || sourceConnection.dbConfig?.dbPath
            || null;
          if (!dbPath) {
            throw new Error(`No local SQLite path for source ${sourceConnection.id || '(unknown)'}`);
          }
          const rawSql = (step.sql || '').replace('{LIMIT_OFFSET_HERE}', '');
          if (!rawSql.trim()) {
            throw new Error('SQLite step requires a "sql" query');
          }
          rows = await localSqlite.runQuery({ dbPath, query: rawSql });
        } else {
          rows = await loadSourceData(
            sourceConnection,
            stepConfig,
            pluginManager,
            getFullConfig
          );
        }
      } catch (err) {
        return {
          success: false,
          error: `Step ${stepNumber} failed: ${err.message}`,
          stepResults,
        };
      }

      const safeRows = Array.isArray(rows) ? rows : [];
      stepResults[stepNumber] = {
        rows: safeRows,
        count: safeRows.length,
      };
    }

    // Evaluate the validation function in a sandboxed-ish Function scope.
    let validationResult = false;
    try {
      const evalFn = new Function(
        'stepResults',
        `try { var fn = (${validationFunction}); return !!fn(stepResults); } catch (e) { throw e; }`
      );
      validationResult = Boolean(evalFn(stepResults));
    } catch (err) {
      return {
        success: false,
        error: `Validation function error: ${err.message}`,
        stepResults,
      };
    }

    const route = (outputRoutes && outputRoutes[String(validationResult)])
      || (validationResult ? 'valid' : 'invalid');

    return {
      success: true,
      result: validationResult,
      route,
      stepResults,
    };
  } catch (err) {
    console.error('[handleExecuteBranch] error:', err);
    return {
      success: false,
      error: err.message || 'Branch execution failed',
      stepResults,
    };
  }
}

// A node run holds the user's database files for its whole duration — see
// holdDatabases in ../duckdb: a join registers views over an attached file,
// then may wait on a remote source before reading them.
const { holdDatabases } = require('../duckdb');
const held = (fn) => (...args) => holdDatabases(() => fn(...args));

module.exports = {
  initialize,
  handleTransformSQL: held(handleTransformSQL),
  handleTransformNoSQL: held(handleTransformNoSQL),
  handleExecuteJoin: held(handleExecuteJoin),
  handleExecuteBranch: held(handleExecuteBranch),
};