/**
 * Workflow Execution Helpers
 * Handles execution of different node types in a workflow
 */

const path = require('path');
const fs = require('fs');
const { handleTransformNoSQL, handleTransformSQL, handleExecuteJoin, handleExecuteBranch } = require('./NodeExecution');
const { handleExecuteApiFetch, describeApiTable } = require('./ApiFetch');
const { executeOutput } = require('./outputExecutionHelpers');
const { isCancelledError } = require('./executionCancel');
const targetShape = require('../lib/targetShape');
const { qualifierFor } = require('../lib/tableRef');

/**
 * Node types that MATERIALISE something when they run — a table, a collection,
 * a file. Their config names an output (targetTableName / targetPreviewSql /
 * outputSettings) from the moment they are built, but nothing is behind that
 * name until the node has actually executed. The workflow's `executedNodes`
 * map is what tells the two apart, and only these types appear in it.
 */
const MATERIALIZING_NODE_TYPES = new Set(['transformer', 'join', 'output']);

/**
 * Record in the saved workflow that this node's output now exists.
 *
 * Every way a workflow runs — the Execute button, a chat "run this node", a
 * CRON schedule, a file watcher — comes through executeNode, so writing this
 * here covers all of them at once. The stored workflow is the only place it can
 * live: a triggered run has no canvas to tell, and the node object we were
 * handed is a copy that is thrown away when the run ends.
 *
 * It goes in `workflow.executedNodes`, keyed by node id, and NOT on the node —
 * a flag inside a node's config made a run indistinguishable from an edit, so
 * the open canvas went dirty, auto-saved, and the version history recorded a
 * "node changed" entry whose entire content was this flag. Writing beside the
 * nodes also means a run never touches the `nodes` array, so it cannot race a
 * concurrent save into clobbering a node's config.
 * (Renderer-side counterpart: src/utils/executedNodes.js.)
 *
 * Never throws. A run that produced real data must not be reported as failed
 * because a bookkeeping write did.
 */
async function markNodeExecuted(node, helpers) {
  try {
    const workflowId = helpers?.workflowId;
    const getDb = helpers?.getDb;
    if (!workflowId || !node?.id || typeof getDb !== 'function') return;

    const db = getDb('workflows');
    const workflow = await db.findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
    if (!workflow) return;

    const executedNodes = { ...(workflow.executedNodes || {}), [node.id]: true };
    await db.updateAsync({ _id: workflow._id }, { $set: { executedNodes } }, {});
  } catch (err) {
    console.warn(`[Workflow Execution] could not flag node ${node?.id} as executed:`, err.message);
  }
}

/**
 * Write a run's finding about a join back onto the SAVED workflow — today, a
 * kept target that was recreated (or no longer needed to be), so the node stops
 * asking. Saved here as well as handed to the editor, for the same reason the
 * executed flag is: a run started by a trigger has no editor, and an editor
 * closed without saving would otherwise bring the old "recreate pending" back
 * and ask again about a table that already fits.
 */
async function persistJoinSettingsPatch(node, patch, helpers) {
  try {
    const workflowId = helpers?.workflowId;
    const getDb = helpers?.getDb;
    if (!workflowId || !node?.id || !patch?.joinSettings || typeof getDb !== 'function') return;
    const db = getDb('workflows');
    const workflow = await db.findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
    if (!workflow || !Array.isArray(workflow.nodes)) return;
    let changed = false;
    const nodes = workflow.nodes.map((n) => {
      if (n?.id !== node.id || !n.data?.config) return n;
      changed = true;
      return { ...n, data: { ...n.data, config: { ...n.data.config, joinSettings: patch.joinSettings } } };
    });
    if (changed) await db.updateAsync({ _id: workflow._id }, { $set: { nodes } }, {});
  } catch (err) {
    console.warn(`[Workflow Execution] could not save the run's update to node ${node?.id}:`, err.message);
  }
}

/**
 * Write a run's findings about a node's TABLE onto the saved workflow — the
 * schema a REST API fetch just produced (sourceTableSchema), or the schema a
 * transformer's table really has after it was written (targetTableSchema).
 *
 * Saved here, not only handed to the editor as a configPatch: a run started
 * by a trigger has no editor, and one started from the editor kept the new
 * schema only if the user saved afterwards. Until then the node — and every
 * node built after it — went on describing the table with whatever the build
 * had guessed (`unknown` types, or the transformer's INPUT columns).
 */
const PERSISTED_SCHEMA_KEYS = ['sourceTableSchema', 'sourceLocalPath', 'apiFetchResult', 'apiFetchPending', 'targetTableSchema'];
async function persistNodeSchemaPatch(node, patch, helpers) {
  try {
    const workflowId = helpers?.workflowId;
    const getDb = helpers?.getDb;
    if (!workflowId || !node?.id || !patch || typeof getDb !== 'function') return;
    const keep = Object.fromEntries(Object.entries(patch).filter(([k]) => PERSISTED_SCHEMA_KEYS.includes(k)));
    if (!Object.keys(keep).length) return;
    const db = getDb('workflows');
    const workflow = await db.findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
    if (!workflow || !Array.isArray(workflow.nodes)) return;
    let changed = false;
    const nodes = workflow.nodes.map((n) => {
      if (n?.id !== node.id || !n.data?.config) return n;
      changed = true;
      return { ...n, data: { ...n.data, config: { ...n.data.config, ...keep } } };
    });
    if (changed) await db.updateAsync({ _id: workflow._id }, { $set: { nodes } }, {});
  } catch (err) {
    console.warn(`[Workflow Execution] could not save the schema of node ${node?.id}:`, err.message);
  }
}

/**
 * The schema of the table a transformer just wrote, read from the workflow's
 * own DuckDB — real types and a few sample rows — or null when its table is
 * not there (it wrote to a database connection, or modified a user's file in
 * place; those are described by their own engines).
 *
 * This is what a Python or JavaScript transformer could not declare when it
 * was built: its code had not run, so the build recorded the INPUT columns as
 * a stand-in. After the run the table exists and says what it holds.
 */
async function writtenTableSchema(node, helpers) {
  const workflowId = helpers?.workflowId;
  const table = nodeOutputTableName(node);
  if (!workflowId || !table) return null;
  try {
    const duck = require('../duckdb');
    const columns = await duck.describeTable(workflowId, table);
    if (!columns || !columns.length) return null;
  } catch (_) {
    return null;
  }
  const schema = await describeApiTable({ workflowId, collection: table });
  return schema?.columns?.length ? schema : null;
}

/**
 * The table (or collection, or index) a node's output lives in — what every
 * downstream node reads it by — or null when it names none.
 *
 * A data source's output is the object it READS; a transformer's or join's is
 * the one it WRITES. Every kind of source records one when it is complete:
 * a database table, a Mongo collection, a Pinecone index, a LanceDB table, a
 * REST API's local collection, a local or downloaded cloud file's table. A node
 * with none is unfinished — typically a data source whose connection was picked
 * but whose table (or cloud object) never was.
 */
function nodeOutputTableName(node) {
  const cfg = node?.data?.config || {};
  if (node?.type === 'dataSource' || cfg.nodeType === 'datasource') {
    return cfg.sourceTableName
      || cfg.sourceCollection
      || cfg.sourceIndexName
      || cfg.sourceTable
      || (Array.isArray(cfg.sourceSelectedTables) ? cfg.sourceSelectedTables[0] : null)
      || cfg.sourceTableSchema?.tableName
      || null;
  }
  if (node?.type === 'transformer' || node?.type === 'join') {
    return cfg.targetTableName
      || cfg.targetCollection
      || cfg.targetTableSchema?.tableName
      // An in-place transformer writes back to what it read.
      || cfg.sourceTableName
      || cfg.sourceCollection
      || null;
  }
  return null;
}

/** The "this node is unfinished" result for a node with no output table. */
function missingOutputTable(node) {
  const label = node?.data?.config?.node_name || node?.data?.label || node?.id || 'Node';
  return {
    success: false,
    message: `Node "${label}" is not configured: it names no table for its output. `
      + 'Open it and pick the table (or, for cloud storage, the file) it should use.',
    recordsProcessed: 0,
  };
}

/**
 * Detect a node that was placed on the canvas but never configured (empty or
 * near-empty config). Such a node would otherwise fail deep in execution with a
 * vague message like "Database type not configured". Returns a clear per-node
 * error result when unconfigured, or null when the node has real configuration.
 *
 * `kind` selects which fields count as "configured" for that node type.
 */
function checkNodeConfigured(node, kind) {
  const config = node?.data?.config || {};
  // Same preference as the execution log — the persisted name, not the
  // creation-time type label, is what the user recognises.
  const label = node?.data?.config?.node_name || node?.data?.label || node?.id || 'Node';
  const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  let configured = false;
  switch (kind) {
    case 'transformer':
      configured = (config.usesSkill && config.skillId)
        || nonEmpty(config.targetSql)
        || nonEmpty(config.targetInsertSql)
        || nonEmpty(config.nosqlOperation)
        || nonEmpty(config.transformFunction)
        || nonEmpty(config.operation)
        || nonEmpty(config.targetDbType);
      break;
    case 'join':
      configured = (config.usesSkill && config.skillId)
        || nonEmpty(config.skillId)
        || nonEmpty(config.joinSql)
        || nonEmpty(config.targetSql)
        || nonEmpty(config.transformFunction)
        || nonEmpty(config.javascriptFunction);
      break;
    case 'output':
      configured = nonEmpty(config.outputType)
        || nonEmpty(config.outputFormat)
        || nonEmpty(config.destinationType)
        || nonEmpty(config.targetConnectionId)
        || !!config.outputSettings;
      break;
    default:
      configured = Object.keys(config).length > 0;
  }

  if (configured) return null;
  return {
    success: false,
    message: `Node "${label}" is not configured. Open it and complete its setup before running the workflow.`,
    recordsProcessed: 0,
  };
}

/**
 * Helper function to add a log entry to an execution
 */
async function addExecutionLog(executionsDb, executionId, level, message, nodeId = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    nodeId
  };

  await executionsDb.updateAsync(
    { executionId },
    { $push: { logs: logEntry } },
    {}
  );
}

/**
 * Get source local path for local file operations
 */
function getSourceLocalPath(targetNode, nodeMap, edges) {
  const sourceEdge = edges.find(e => e.target === targetNode.id);
  if (!sourceEdge) return null;

  const sourceNode = nodeMap.get(sourceEdge.source);
  if (!sourceNode?.data?.config) return null;

  const sourceConfig = sourceNode.data.config;

  return sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
}

  /**
   * Helper function to get original file path from connection
   * @param {String} sourceConnectionId - Connection ID
   * @param {String} dbType - Database type (duckdb or sqlite)
   * @returns {Promise<String|null>} Original file path or null
   */
  const getOriginalFilePath = async (sourceConnectionId, dbType, getDb) => {
    if (!sourceConnectionId) {
      return null;
    }

    // Only applicable for local file types
    if (!['duckdb', 'sqlite'].includes(dbType)) {
      return null;
    }

    try {
      // Get connections database
      const connectionsDb = await getDb('connections');

      // Find the connection record
      const connection = await connectionsDb.findOneAsync({ id: sourceConnectionId });
      console.log('connection: ', connection, sourceConnectionId, dbType)
      if (!connection) {
        console.warn(`[executeDataSourceNode] Connection not found: ${sourceConnectionId}`);
        return null;
      }

      // Get localPath from connection
      const localPath = connection?.fileInfo?.sourceFilePath || connection?.fileInfo?.filePath;

      if (localPath) {
        console.log(`[executeDataSourceNode] Found original file path for ${dbType}: ${localPath}`);
        return localPath;
      }

      console.warn(`[executeDataSourceNode] No local path found in connection ${sourceConnectionId}`);
      return null;
    } catch (error) {
      console.error(`[executeDataSourceNode] Error getting file path from connection:`, error);
      return null;
    }
  };

/**
 * Execute a Data Source node
 * Imports local files or Google Sheets
 */
async function executeDataSourceNode(node, helpers) {
  const { pluginManager, getFullConfig, getDb, appSqliteDbPath } = helpers;

  console.log(`[Workflow Execution] Executing Data Source node: ${node.id}`);

  // Data source nodes can have local file imports or cloud data sources
  const config = node.data?.config;
  // console.log('node: ', node)

  if (!config) {
    return {
      success: false,
      message: 'Data source configuration not found',
      recordsProcessed: 0
    };
  }

  // A source that names no table is unfinished, whatever its connection.
  // Checked first, so it fails here — on the node that is incomplete — rather
  // than as a "table does not exist" in whichever node reads it next.
  if (!nodeOutputTableName(node)) return missingOutputTable(node);


  const sourceConnectionId = config.sourceConnectionId;
  console.log('config: ', config)
  // REST API source: re-execute the saved fetch function and re-populate the
  // local table the downstream nodes already point at.
  if (config.sourceConnectionType === 'api' && config.apiFetchCode) {
    try {
      console.log('[Workflow Execution] REST API source — re-running fetch function');
      const collection = config.sourceCollection ||
        String(node.id).replace(/[^a-z0-9]+/gi, '_').toLowerCase() ||
        'api_response';

      const fetchResult = await handleExecuteApiFetch({
        apiConnectionId: config.sourceApiConnectionId,
        apiConnectionConfig: config.apiConnectionPublicConfig || {},
        apiFetchCode: config.apiFetchCode,
        targetCollection: collection,
        operationMode: 'new_table',
        workflowId: helpers?.workflowId || null,
        nodeId: node.id,
      });

      if (!fetchResult.success) {
        return {
          success: false,
          message: `REST API fetch failed: ${fetchResult.error || 'unknown error'}`,
          recordsProcessed: 0,
        };
      }

      // What the node's config should now say about its table. A source built
      // from chat is not run until the user approves it, so this run is often
      // the first one — the node has no columns yet, and the nodes built after
      // it need them. The caller (a single-node run from the chat or panel)
      // writes this back onto the node.
      const configPatch = fetchResult.rowCount
        ? {
          sourceLocalPath: fetchResult.localPath || null,
          sourceTableSchema: await describeApiTable({
            workflowId: helpers?.workflowId || null,
            collection,
            sampleRow: fetchResult.sampleRow,
          }),
          apiFetchResult: {
            rowCount: fetchResult.rowCount,
            localPath: fetchResult.localPath || null,
            collection: fetchResult.collection || collection,
          },
          apiFetchPending: false,
        }
        : null;

      return {
        success: true,
        message: `REST API fetch completed: ${fetchResult.rowCount || 0} rows into ${collection}`,
        recordsProcessed: fetchResult.rowCount || 0,
        configPatch,
      };
    } catch (err) {
      // A stop stays an exception all the way to the runner — see executeOutputNode.
      if (isCancelledError(err)) throw err;
      console.error('[Workflow Execution] REST API source error:', err);
      return { success: false, message: err.message || 'REST API source failed', recordsProcessed: 0 };
    }
  }

  // Check if it's a cloud storage file that needs to be re-downloaded and imported
  if (config.cloudSource) {
    try {
      console.log('[Workflow Execution] Cloud storage file detected, downloading and importing...');

      const { connectionId, dbType, containerName, objectKey, objectName, sheetName } = config.cloudSource;

      // Get the cloud storage connection config
      const cloudConnection = await getFullConfig(connectionId);
      if (!cloudConnection) {
        return {
          success: false,
          message: `Cloud storage connection not found: ${connectionId}`,
          recordsProcessed: 0
        };
      }

      // Get the connector plugin
      const plugin = pluginManager.getConnector(dbType);
      if (!plugin || !plugin.downloadObject) {
        return {
          success: false,
          message: `Cloud storage connector not available for: ${dbType}`,
          recordsProcessed: 0
        };
      }

      // Download the file from cloud storage
      console.log(`[Workflow Execution] Downloading from ${dbType}: ${containerName}/${objectKey}`);
      // console.log('cloudConnection: ', cloudConnection)
      const downloadResult = await plugin.downloadObject(
        cloudConnection,
        connectionId,
        containerName,
        objectKey
      );

      if (!downloadResult.success) {
        return {
          success: false,
          message: `Failed to download file: ${downloadResult.message}`,
          recordsProcessed: 0
        };
      }

      // A cloud file saved to disk is refreshed IN PLACE: the bytes replace the
      // file the user chose, and DuckDB reads it from there. Nothing is
      // imported into the app's SQLite database, which is what the branch below
      // still does for sources recorded before this became the way.
      const savedPath = config.cloudSource.localPath
        || (config.sourceDbType === 'duckdb' ? (config.sourceFilePath || config.sourceLocalPath) : null);

      if (savedPath) {
        const duck = require('../duckdb');
        fs.mkdirSync(path.dirname(savedPath), { recursive: true });
        fs.writeFileSync(savedPath, Buffer.from(downloadResult.data));

        const sourceTable = config.sourceTableName || config.sourceTableSchema?.tableName;
        const rowCount = await duck.countRows(savedPath, config.sourceFormat || null, {
          sheet: duck.sheetFor(savedPath, sourceTable),
        });
        return {
          success: true,
          message: `${path.basename(savedPath)} refreshed from ${dbType} — ${rowCount} row(s), read in place`,
          recordsProcessed: rowCount,
        };
      }

      // No saved path on this node means it was recorded before cloud files were
      // kept on disk and read in place. Such a node used to re-import the object
      // into the app's SQLite database, or — for JSON — into a local document
      // store. Both of those are gone: every local file is DuckDB
      // now, read where it lies. There is nothing to fall back to, so say what
      // to do rather than failing further down with a missing-table error.
      return {
        success: false,
        message:
          `"${objectName}" was added before cloud files were saved to disk, so this node has `
          + 'no local path to refresh. Open the data source, pick a save location for the file, '
          + 'and re-select it — the object is then kept on disk and read in place by DuckDB.',
        recordsProcessed: 0,
      };

    } catch (error) {
      // A stop stays an exception all the way to the runner — see executeOutputNode.
      if (isCancelledError(error)) throw error;
      console.error('[Workflow Execution] Cloud storage import error:', error);
      return {
        success: false,
        message: error.message,
        recordsProcessed: 0
      };
    }
  }

  const filePath = await getOriginalFilePath(sourceConnectionId, config.sourceDbType, getDb)
  console.log("sourceFilePath: ", filePath)

  // A local file source has nothing to execute. It used to be re-imported into
  // SQLite on every run — reading the whole file and rewriting a copy
  // of it before the workflow could touch a single row. DuckDB reads the file
  // in place when a downstream node queries it, so this step only has to
  // confirm the file is still there and report how big it is.
  if (config.sourceDbType === 'duckdb') {
    const localPath = config.sourceFilePath || config.sourceLocalPath || filePath;
    if (!localPath) {
      return { success: false, message: 'No file path recorded for this data source', recordsProcessed: 0 };
    }
    if (!fs.existsSync(localPath)) {
      return {
        success: false,
        message: `Source file no longer exists: ${localPath}`,
        recordsProcessed: 0,
      };
    }
    try {
      const duck = require('../duckdb');
      // A DATABASE holds the source as a TABLE — a workflow's .duckdb (an
      // upstream node's output) or a .sqlite/.db the user imported, both of
      // which DuckDB ATTACHes; a data file is counted where it lies. Same
      // predicate the connector and the transform use (duck.isDatabaseFile), so
      // a source the Data Explorer browses cannot fail here: matching only
      // `.duckdb` sent .sqlite down the data-file path, where tableRef threw
      // "supported formats are csv, json, parquet, xlsx and avro".
      const isDb = duck.isDatabaseFile(localPath);
      const sourceTable = config.sourceTableName || config.sourceTableSchema?.tableName;
      if (isDb && !sourceTable) {
        return { success: false, message: 'No table recorded for this data source', recordsProcessed: 0 };
      }
      const rowCount = isDb
        ? await duck.tableRowCountAt(localPath, sourceTable)
        // A workbook's sheets share one path, so the table name is what says
        // which of them this source is; null for every other format.
        : await duck.countRows(localPath, config.sourceFormat || null, {
          sheet: duck.sheetFor(localPath, sourceTable),
        });
      return {
        success: true,
        message: isDb
          ? `${sourceTable} ready — ${rowCount} row(s)`
          : `${path.basename(localPath)} ready — ${rowCount} row(s), read in place`,
        recordsProcessed: rowCount,
      };
    } catch (error) {
      return {
        success: false,
        message: `Cannot read ${path.basename(localPath)}: ${error.message}`,
        recordsProcessed: 0,
      };
    }
  }

  // Google Sheets used to be imported into the shared SQLite database by a
  // branch here. It was dead twice over — it keyed on `config.dbType` /
  // `config.spreadsheetId` while the node records `source*` fields, and it
  // called `plugin.importToSqlite`, which the connector never implemented — so
  // a sheet was frozen at the moment it was configured.
  //
  // A Sheets source is now an ordinary cloud file: the tab downloads as CSV
  // through the connector, is read in place by DuckDB, and is refreshed by the
  // cloudSource branch below on every run, exactly like an S3 object.


  // For other data sources, just validate that the configuration exists
  return {
    success: true,
    message: 'Data source validated',
    recordsProcessed: config.recordCount || 0
  };
}

/**
 * Execute a Transformer node
 * Calls the transformation handlers directly
 */
async function executeTransformerNode(node, nodeMap, edges, helpers) {
  console.log(`[Workflow Execution] Executing Transformer node: ${node.id}`);

  const config = node.data?.config;
  // console.log('config: ', config)
  if (!config) {
    return {
      success: false,
      message: 'Transformation configuration not found',
      recordsProcessed: 0
    };
  }

  // Reject an unconfigured transformer up front with a clear, node-named
  // message instead of failing later with "Database type not configured".
  const notConfigured = checkNodeConfigured(node, 'transformer');
  if (notConfigured) return notConfigured;

  // Find source node
  const sourceEdge = edges.find(e => e.target === node.id);
  if (!sourceEdge) {
    return {
      success: false,
      message: 'No source connection found for transformer',
      recordsProcessed: 0
    };
  }

  const sourceNode = nodeMap.get(sourceEdge.source);
  if (!sourceNode) {
    return {
      success: false,
      message: 'Source node not found',
      recordsProcessed: 0
    };
  }

  // Wired to a different node than this transformer was built against. Unlike
  // an output — which only forwards what it reads, so it can safely follow the
  // wire (see executeOutputNode) — a transformer's SQL NAMES its source table.
  // Re-pointing it here would run that SQL against a table it was not written
  // for, so the run proceeds as configured and says what it saw. The editor
  // re-points and flags the node on rewire; regenerating it is the real fix.
  // Wired to a different node than this transformer was built against. Unlike
  // an output — which only forwards what it reads, so it can safely follow the
  // wire (see executeOutputNode) — a transformer's SQL NAMES its source table.
  //
  // What matters is whether the node now in that position holds DIFFERENT data,
  // not that the id changed: swapping in another node that reads the same table
  // on the same connection leaves every statement correct, and refusing there
  // would block a run for nothing. Checked against the live graph, so it holds
  // for a workflow rewired outside the editor too.
  if (config.sourceNodeId && config.sourceNodeId !== sourceNode.id) {
    const wired = sourceIdentityOf(sourceNode.data?.config || {});
    const recorded = sourceIdentityOf(config);
    if (identityDiffers(recorded, wired)) {
      return {
        success: false,
        message: `This transformer was built against ${config.sourceNodeLabel || config.sourceNodeId} `
          + `and is now wired to ${sourceNode.data?.config?.node_name || sourceNode.data?.label || sourceNode.id}, `
          + `which reads ${wired.tableName || 'something else'} rather than ${recorded.tableName || 'what it was built for'}. `
          + 'Its SQL still names the old source. Rebuild the transformer from its chat before running it.',
        recordsProcessed: 0,
      };
    }
    console.warn(
      `[Workflow Execution] Transformer ${node.id} was built against ${config.sourceNodeId} `
      + `but is wired to ${sourceNode.id}; both read the same table, so the run continues.`,
    );
  }

  // The source this transformer was built against now reads a different table
  // or connection, and its SQL names the old one. Its TARGET is stale too: for
  // an in-place transformation `targetTableName` IS the source table it was
  // built for, and `targetSchema` / `targetLocalPath` came from that source
  // (workflowBuilder.js). So running it does not merely read the wrong rows —
  // it WRITES to the table the parent has abandoned, and reports success.
  // Refused until the node is rebuilt, which is the only thing that
  // regenerates the statements and the target together.
  if (config.sourceMoved) {
    return {
      success: false,
      message: `This transformer's source moved (${describeMove(config.sourceMoved)}) after the `
        + "transformer was built, so its SQL reads the old table and its target still names it. "
        + 'Rebuild the transformer from its chat before running it.',
      recordsProcessed: 0,
    };
  }

  try {
    // Check if this transformation uses a skill
    if (config.usesSkill && config.skillId) {
      console.log(`[Workflow Execution] Executing skill transformation: ${config.skillId}`);

      // What this node reads, in the shape skills expect (un-prefixed names,
      // like a saved connection record).
      //
      // Taken from THIS NODE's own `source*` fields — the same fields the node
      // chat's skill path reads (NodeChatPanel.js) and the same ones the
      // non-skill transformer path reads. They were resolved at build time by
      // copySourceFromUpstream, which reads the parent TARGET-first, so they are
      // already correct whatever the parent is.
      //
      // This used to re-derive them from the PARENT node's config using
      // `source*` lookups. That only works when the parent is a dataSource --
      // the one node type that describes ITSELF with `source*`. Every other node
      // describes its OUTPUT with `target*`, so a join or transformer parent
      // yielded dbType/id/name === undefined, the local-DuckDB branch was
      // skipped, and the read fell through to runQuery(undefined):
      // "Connection not found: undefined".
      const parentConfig = sourceNode.data?.config || {};
      let sourceConnection = {
        id:             config.sourceConnectionId,
        name:           config.sourceConnectionName,
        dbType:         config.sourceDbType || config.sourceType,
        dbConfig:       config.sourceDbConfig,
        dbCategory:     config.sourceDbCategory,
        connectionType: config.sourceConnectionType,
        localPath:      config.sourceLocalPath,
        indexName:      config.sourceIndexName,
      };
      // Nodes built before those fields were recorded fall back to deriving from
      // the parent -- target-first this time, matching copySourceFromUpstream.
      if (!sourceConnection.dbType && !sourceConnection.id) {
        const p = parentConfig.connection || parentConfig;
        sourceConnection = {
          ...p,
          id:             p.targetConnectionId   || p.sourceConnectionId   || p.id,
          name:           p.targetConnectionName || p.sourceConnectionName || p.name,
          dbType:         p.targetDbType         || p.sourceDbType         || p.dbType,
          dbConfig:       p.targetDbConfig       || p.sourceDbConfig       || p.dbConfig,
          dbCategory:     p.targetDbCategory     || p.sourceDbCategory     || p.dbCategory,
          connectionType: p.targetConnectionType || p.sourceConnectionType || p.connectionType,
          localPath:      p.targetLocalPath      || p.sourceLocalPath      || p.localPath,
        };
      }
      // The node's own recorded input shape. Downstream propagation refreshes
      // this when a parent is rebuilt, so preferring it is also what makes that
      // refresh reach skills.
      const sourceTableSchema = config.sourceTableSchema
        || parentConfig.targetTableSchema
        || parentConfig.sourceTableSchema;

      // Determine operation type
      const isNoSQL = sourceConnection?.dbType === 'mongodb';
      const operationType = isNoSQL ? 'nosql' : 'sql';

      // Get source schema
      const sourceSchema = sourceNode.data?.config?.targetSchema || sourceNode.data?.config?.sourceSchema;
      const sourceNodeConfig = sourceNode.data?.config;

      // For LanceDB, ensure localPath is included in sourceConnection
      if (sourceConnection?.dbType === 'lancedb') {
        sourceConnection = {
          ...sourceConnection,
          localPath: sourceConnection.localPath ||
                     sourceNodeConfig?.targetLocalPath ||
                     sourceNodeConfig?.sourceLocalPath ||
                     sourceNodeConfig?.targetDbConfig?.dbPath ||
                     config.targetDbConfig?.dbPath
        };
      }

      // Build the same helpers bundle the IPC layer would inject so skills
      // (javascript-executor, vector-db-executor, ...) receive params.helpers.
      const skillHelpers = typeof helpers.buildSkillHelpers === 'function'
        ? await helpers.buildSkillHelpers()
        : null;

      // Mirror the `skills:execute` IPC shim: vector-db-executor still reads
      // embeddingApiKey from top-level params, but stored configs don't carry
      // the key. Resolve it from the same apiKeys bundle the chat path uses.
      let resolvedEmbeddingKey = config.embeddingApiKey;
      if (config.skillId === 'vector-db-executor' && !resolvedEmbeddingKey && config.embeddingProvider && skillHelpers?.apiKeys) {
        if (config.embeddingProvider === 'openai') {
          resolvedEmbeddingKey = skillHelpers.apiKeys.chatgpt || skillHelpers.apiKeys.openai;
        }
      }

      // Execute the skill
      const skillResult = await helpers.pluginManager.executeSkill(config.skillId, {
        helpers: skillHelpers,
        // Source information
        sourceConnection: sourceConnection,
        sourceTableSchema: {
          tableName: sourceTableSchema?.tableName,
          originalTableName: sourceTableSchema?.tableName,
          indexName: sourceTableSchema?.indexName || sourceConnection?.indexName,
          columns: sourceTableSchema?.columns,
          sampleData: sourceTableSchema?.sampleData,
          sheetName: sourceTableSchema?.sheetName,
          schema: sourceSchema,
          namespace: sourceTableSchema?.namespace || sourceSchema,
          localPath: sourceTableSchema?.localPath || sourceNodeConfig?.targetLocalPath || sourceNodeConfig?.sourceLocalPath
        },

        // Operation type and settings
        operationType,
        storageLocation: config.transformationSettings?.storageLocation || config.storageLocation,
        operationMode: config.transformationSettings?.operationMode || config.operationMode,

        // Target information
        targetLocalPath: config.targetLocalPath || sourceNodeConfig?.targetLocalPath || sourceNodeConfig?.sourceLocalPath,
        targetTable: config.targetTableName || config.targetCollection,
        targetConnectionId: config.targetConnectionId,
        targetConnectionName: sourceConnection?.name,

        // Vector DB specific parameters
        vectorDbType: config.targetDbType || config.skillExecution?.vectorDbType,
        operation: config.skillExecution?.operation,
        namespace: config.namespace || sourceTableSchema?.namespace || sourceSchema,
        indexName: config.indexName || sourceTableSchema?.indexName || sourceConnection?.indexName,

        // Embedding parameters
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        embeddingApiKey: resolvedEmbeddingKey,
        columnToEmbed: config.columnToEmbed,

        // Query parameters
        queryText: config.queryText,
        queryVector: config.queryVector,
        topK: config.topK,
        filter: config.filter,
        useEmbeddingSearch: config.useEmbeddingSearch,
        searchQuery: config.searchQuery,

        // Transformation function parameters
        transformFunction: config.transformFunction,
        initialState: config.initialState,

        // Pinecone/LanceDB specific configs
        pineconeConfig: config.pineconeConfig,
        lancedbConfig: config.lancedbConfig,

        // Node context
        nodeId: node.id,
        sourceNodeId: sourceNode?.id,
        sourceNodeLabel: sourceNode?.data?.label,
        sourceNodeConfig: sourceNodeConfig,
        sourceConnectionName: sourceConnection?.name,
        sourceConnectionType: sourceConnection?.connectionType,

        // System dependencies
        pluginManager: helpers.pluginManager,
        getFullConfig: helpers.getFullConfig,
        appSqliteDbPath: helpers.appSqliteDbPath,

        // Spread any additional skill params last (allows overrides)
        ...config.skillParams
      });

      if (!skillResult.success) {
        return {
          success: false,
          message: skillResult.error || skillResult.message || 'Skill execution failed',
          recordsProcessed: 0
        };
      }

      return {
        success: true,
        message: skillResult.message || 'Skill transformation completed',
        recordsProcessed: skillResult.recordCount || 0
      };
    }

    const dbType = config.targetDbType || config.dbType;
    const sourceDbType = config.sourceDbType || config.sourceType;

    if (!dbType) {
      return {
        success: false,
        message: `Node "${node.data?.config?.node_name || node.data?.label || node.id}" is not fully configured (no target database). Open it and complete its setup before running.`,
        recordsProcessed: 0
      };
    }

    // Get source local path if needed (for local file operations)
    const isLocalStorage = config.transformationSettings?.storageLocation === 'local';
    const isInPlace = config.transformationSettings?.operationMode === 'in_place';

    // Cross-database NoSQL case: the source is MongoDB but the destination is a
    // local DuckDB table (storageLocation "local"). The read and aggregation
    // must run against MongoDB; the resulting documents are then written to the
    // workflow's DuckDB database by handleTransformNoSQL.
    // Routing off the *target* dbType alone would mistakenly try to open a local
    // source file that does not exist.
    const isMongoSourceToLocal =
      sourceDbType === 'mongodb' && dbType !== 'mongodb' && isLocalStorage;

    // Diagnostic: the exact inputs that drive transformer routing. If the
    // running main process predates the isMongoSourceToLocal guard, this line
    // will be ABSENT from the logs even though the code above has it — that
    // absence is itself the signal that Electron needs a restart.
    // console.log('[Transformer Routing]', JSON.stringify({
    //   nodeId: node.id,
    //   label: node.data?.label,
    //   sourceNodeId: config.sourceNodeId,
    //   dbType,                         // target db (config.targetDbType || config.dbType)
    //   sourceDbType,                   // source db (config.sourceDbType || config.sourceType)
    //   storageLocation: config.transformationSettings?.storageLocation,
    //   operationMode: config.transformationSettings?.operationMode,
    //   operationType: config.operationType,
    //   sourceCollection: config.sourceCollection,
    //   targetCollection: config.targetCollection,
    //   sourceConnectionId: config.sourceConnectionId,
    //   targetConnectionId: config.targetConnectionId,
    //   targetLocalPath: config.targetLocalPath,
    //   flags: { isLocalStorage, isInPlace, isMongoSourceToLocal },
    //   route: isMongoSourceToLocal
    //     ? 'mongo-source-to-local (handleTransformNoSQL dbType=mongodb)'
    //     : (dbType === 'mongodb'
    //         ? `nosql (handleTransformNoSQL dbType=${dbType})`
    //         : 'sql (handleTransformSQL)')
    // }, null, 2));

    if (isMongoSourceToLocal) {
      console.log('[Transformer Routing] -> mongo-source-to-local: aggregating on MongoDB, writing result to local DuckDB');
      const result = await handleTransformNoSQL({
        dbType: 'mongodb',
        config: config.sourceDbConfig || config.dbConfig,
        connectionId: config.sourceConnectionId || config.connectionId,
        sourceLocalPath: null,
        sourceCollection: config.sourceCollection,
        targetCollection: config.targetCollection,
        targetLocalPath: config.targetLocalPath,
        operationType: config.operationType,
        nosqlOperation: config.nosqlOperation,
        transformFunction: config.transformFunction,
        storageLocation: 'local',
        operationMode: config.transformationSettings?.operationMode
      });

      return {
        success: result.success,
        message: result.message || (result.success ? 'NoSQL transformation completed' : 'NoSQL transformation failed'),
        recordsProcessed: result.recordCount || result.modifiedCount
          || result.documentsInserted || result.documentsProcessed || 0
      };
    }

    // Cross-database SQL case: the source is a remote SQL database (MSSQL,
    // Postgres, MySQL, …) but the destination is local SQLite (target dbType
    // "sqlite" / storageLocation "local"). The transform SELECT must run on the
    // *source* via its plugin; the rows are then written to local SQLite with
    // ddl/insertSql by Sqlite.databaseToLocal. Routing off the target dbType
    // would run the source SELECT (e.g. "FROM [dbo].[items]") against the local
    // app DB → "no such table: dbo.items". Mirrors isMongoSourceToLocal above.
    const isSqlSourceToLocal =
      isLocalStorage && !isInPlace &&
      (dbType === 'duckdb' || dbType === 'sqlite') &&
      sourceDbType && !['duckdb', 'sqlite', 'mongodb'].includes(sourceDbType);

    const sourceLocalPath = (isLocalStorage || isInPlace || dbType === 'duckdb')
      ? getSourceLocalPath(node, nodeMap, edges)
      : null;

    // NoSQL transformations (MongoDB)
    if (dbType === 'mongodb') {
      console.log(`[Transformer Routing] -> nosql branch dbType=${dbType}, sourceLocalPath=${sourceLocalPath}`);
      const result = await handleTransformNoSQL({
        dbType,
        config: config.targetDbConfig || config.dbConfig,
        connectionId: config.targetConnectionId || config.connectionId,
        sourceLocalPath: sourceLocalPath,
        sourceCollection: config.sourceCollection,
        targetCollection: config.targetCollection,
        targetLocalPath: config.targetLocalPath,
        operationType: config.operationType,
        nosqlOperation: config.nosqlOperation,
        transformFunction: config.transformFunction,
        storageLocation: config.transformationSettings?.storageLocation,
        operationMode: config.transformationSettings?.operationMode,
        workflowId: helpers?.workflowId || null,
        nodeId: node.id
      });

      return {
        success: result.success,
        message: result.message || (result.success ? 'NoSQL transformation completed' : 'NoSQL transformation failed'),
        recordsProcessed: result.recordCount || result.modifiedCount || 0
      };
    }

    // SQL transformations (PostgreSQL, MySQL, MSSQL, SQLite, etc.)
    // For a remote-SQL-source → local-SQLite transform, hand handleTransformSQL
    // the *source* db/connection so its storageLocation==='local' branch pulls
    // data from the source plugin into local SQLite; otherwise use the target.
    const result = await handleTransformSQL({
      dbType: isSqlSourceToLocal ? sourceDbType : dbType,
      config: isSqlSourceToLocal
        ? (config.sourceDbConfig || config.dbConfig)
        : (config.targetDbConfig || config.dbConfig),
      connectionId: isSqlSourceToLocal
        ? (config.sourceConnectionId || config.connectionId)
        : (config.targetConnectionId || config.connectionId),
      ddl: config.targetDdl,
      sql: config.targetSql,
      previewSql: config.targetPreviewSql,
      storageLocation: config.transformationSettings?.storageLocation,
      operationMode: config.transformationSettings?.operationMode,
      targetSchema: config.targetSchema || config.sourceSchema || config.schema,
      targetTableName: config.targetTableName || config.targetCollection,
      sourceLocalPath: sourceLocalPath,
      // The source's IDENTITY, from the NODE's config. handleTransformSQL used
      // to read these off its `config` argument, which is the target database
      // config passed just above — a different object that has never held them.
      sourceTableName: config.sourceTableName || config.sourceTableSchema?.tableName || null,
      sourceConnectionName: config.sourceConnectionName || null,
      insertSql: config.targetInsertSql,
      // A local DuckDB target writes one Parquet file per node, so it needs to
      // know which node it is.
      targetLocalPath: config.targetLocalPath,
      sourceFormat: config.sourceFormat || null,
      workflowId: helpers?.workflowId || null,
      nodeId: node.id
    });

    return {
      success: result.success,
      // Set by the DuckDB transform paths when the table they created came out
      // empty — a real count read back off the table, not an absent one — and
      // by a remote in-place transform whose DDL failed while its DML went
      // through, which is what a rerun of an ALTER looks like.
      warning: !!result.warning,
      message: result.message || (result.success ? 'SQL transformation completed' : 'SQL transformation failed'),
      recordsProcessed: result.rowCount || result.recordCount || 0
    };
  } catch (error) {
    // A stop stays an exception all the way to the runner — see executeOutputNode.
    if (isCancelledError(error)) throw error;
    console.error('[Workflow Execution] Transformer error:', error);
    return {
      success: false,
      message: error.message,
      recordsProcessed: 0
    };
  }
}

/**
 * Execute a Join node
 * Calls the join handler directly
 */
/**
 * Fill in a vector source's index coordinates from the node that produced it.
 *
 * A Pinecone index is identified by `indexName` + `namespace`, never by a table
 * name. The builder now records both onto each join source
 * (enrichJoinSourcesConfig), but workflows built before that carry neither — and
 * the executor's fallback chain ends at the table name, so it would call
 * `/indexes/<tableName>` and get a 404 for an index that was never named that.
 *
 * The upstream node still knows: a vector transformer records `indexName` /
 * `namespace` at its config top level when it writes the embeddings. Reading
 * them here means an existing workflow runs correctly without being rebuilt.
 *
 * Only fills gaps — anything already on the source config wins, and non-vector
 * sources are returned untouched.
 */
/**
 * What a node config says it READS — target-first, because every node type but
 * a dataSource describes its output with `target*`. Mirrors the renderer's
 * SOURCE_IDENTITY_KEYS (src/utils/workflowUtils.js); keep the two in step.
 */
function sourceIdentityOf(config = {}) {
  return {
    connectionId: config.targetConnectionId || config.sourceConnectionId || null,
    tableName: config.targetTableName || config.targetCollection
      || config.sourceTableName || config.sourceCollection || null,
    localPath: config.targetLocalPath || config.sourceLocalPath || null,
  };
}

/** Whether two identities disagree. A side that states nothing never disagrees. */
function identityDiffers(a, b) {
  return ['connectionId', 'tableName', 'localPath']
    .some((k) => !!a?.[k] && !!b?.[k] && a[k] !== b[k]);
}

/** How a moved source reads in an error: "customers" → "orders on another connection". */
function describeMove(moved) {
  const from = moved?.from || {};
  const to = moved?.to || {};
  const elsewhere = from.connectionId && to.connectionId && from.connectionId !== to.connectionId;
  return `${from.tableName || 'what it was built against'} → ${to.tableName || 'another table'}`
    + (elsewhere ? ' on another connection' : '');
}

/**
 * The failure for a join whose source has been re-pointed since it was built,
 * or null when every step still reads what its SQL names.
 *
 * `sourceMoved` is stamped by whichever pass re-pointed the step — the editor's
 * on every canvas change, the builder's on a single-node chat rebuild. Both
 * refresh WHERE a source is read from and leave HOW it is read alone, so the
 * marker is the one thing that can tell the executor the two no longer agree.
 *
 * ONLY a rebuild clears it, because only a rebuild regenerates the step's SQL,
 * DDL and staging table against the source that is actually there now. The
 * card's "Keep as is" deliberately does NOT: it answers for the node's logic,
 * and no answer makes a `CREATE TABLE` for one table's columns correct for
 * another's. A run allowed through on that assurance writes real rows into a
 * real database.
 */
function staleJoinSource(sourcesConfig, parentIds, nodeMap, directReadSources = []) {
  const steps = Array.isArray(sourcesConfig) ? sourcesConfig.filter(Boolean) : [];
  const wired = new Set(parentIds || []);
  // Sources the join's function reads itself (a similarity join's vector
  // store) have no step, but they are read all the same.
  const direct = Array.isArray(directReadSources) ? directReadSources.filter(Boolean) : [];
  const named = new Set([...steps.map((s) => s.sourceNodeId).filter(Boolean), ...direct]);
  const labelOf = (id) => nodeMap?.get(id)?.data?.config?.node_name
    || nodeMap?.get(id)?.data?.label
    || id;

  const reasons = [];

  // RETARGETED — the step still exists, but reads a different object now.
  const moved = steps.filter((s) => s.sourceMoved);
  if (moved.length) {
    reasons.push(`a source moved (${moved.map((s) => describeMove(s.sourceMoved)).join('; ')})`);
  }

  // REMOVED — a step whose node no longer feeds this join. Checked against the
  // live graph rather than a saved flag, so it holds however the edge went
  // away: deleted on the canvas, the node itself deleted, or a workflow
  // hand-edited outside the editor. The join SQL still names that source's
  // table, and the step still carries the connection to reach it — so the run
  // would go on reading a source the user has disconnected, and succeed.
  const removed = [
    ...steps.filter((s) => s.sourceNodeId && !wired.has(s.sourceNodeId))
      .map((s) => s.tableName || labelOf(s.sourceNodeId)),
    ...direct.filter((id) => !wired.has(id)).map(labelOf),
  ];
  if (removed.length) {
    reasons.push(`a source is no longer connected (${removed.join(', ')})`);
  }

  // ADDED — a node feeds this join that the generated SQL has never heard of.
  // Running would quietly ignore it and write a result missing whatever the
  // user attached it for.
  const added = [...wired].filter((id) => !named.has(id));
  if (added.length) {
    reasons.push(`a new source is connected that the join does not read (${added.map(labelOf).join(', ')})`);
  }

  if (reasons.length === 0) return null;
  return {
    success: false,
    message: `This join's sources changed after it was built — ${reasons.join('; ')}. Its SQL, DDL `
      + 'and staging tables still describe the old set of sources. Rebuild the join from its chat '
      + 'before running it.',
    recordsProcessed: 0,
  };
}

function withVectorIndexCoordinates(sourcesConfig, nodeMap) {
  if (!Array.isArray(sourcesConfig) || !nodeMap) return sourcesConfig;
  return sourcesConfig.map((sc) => {
    if (!sc || (sc.indexName && sc.namespace)) return sc;
    const upstream = nodeMap.get(sc.sourceNodeId);
    const up = upstream?.data?.config;
    if (!up) return sc;
    const indexName = sc.indexName || up.indexName || up.targetIndexName || up.skillParams?.indexName || null;
    const namespace = sc.namespace || up.namespace || up.targetNamespace || up.skillParams?.namespace || null;
    if (!indexName && !namespace) return sc;
    return {
      ...sc,
      ...(indexName ? { indexName } : {}),
      ...(namespace ? { namespace } : {}),
      connection: {
        ...(sc.connection || {}),
        ...(indexName ? { indexName } : {}),
        ...(namespace ? { namespace } : {}),
        dbConfig: {
          ...(sc.connection?.dbConfig || {}),
          ...(indexName ? { indexName } : {}),
          ...(namespace ? { namespace } : {}),
        },
      },
    };
  });
}

/**
 * Coordinates of the vector sources a join's function reads itself — the
 * connection it is addressed by, plus the index/table and namespace the source
 * node points at.
 */
/**
 * The sources a join's function reads itself: the ones the builder recorded
 * (config.directReadSources), plus any vector source whose step carries no
 * read of its own — the same rule the builder now applies and the executor
 * skips by (NodeExecution's isDirectReadStep). Joins built before that rule
 * recorded none, so their function's ctx.runQuery never got the index and
 * namespace filled in ("Index name is required").
 */
function directReadIds(config, nodeMap) {
  const ids = new Set((config.directReadSources || []).filter(Boolean));
  for (const step of config.sourcesConfig || []) {
    if (!step?.sourceNodeId) continue;
    const up = nodeMap?.get(step.sourceNodeId)?.data?.config || {};
    const dbType = String(step.connection?.dbType || up.sourceDbType || '').toLowerCase();
    const isVector = dbType === 'pinecone' || dbType === 'lancedb'
      || step.connection?.dbCategory === 'Vector' || up.sourceDbCategory === 'Vector';
    const hasOwnRead = Object.prototype.hasOwnProperty.call(step, 'vectorFetchOperation')
      || !!String(step.sql || '').trim() || !!step.nosqlOperation;
    if (isVector && !hasOwnRead) ids.add(step.sourceNodeId);
  }
  return [...ids];
}

function directVectorSourcesOf(directReadSources, nodeMap) {
  if (!Array.isArray(directReadSources) || !nodeMap) return [];
  return directReadSources.map((id) => {
    const up = nodeMap.get(id)?.data?.config || {};
    return {
      sourceNodeId: id,
      connectionId: up.sourceConnectionId || null,
      connectionName: up.sourceConnectionName || null,
      dbType: up.sourceDbType || null,
      indexName: up.sourceIndexName || up.sourceTableName || null,
      namespace: up.sourceNamespace ?? up.sourceSchema ?? null,
      localPath: up.sourceLocalPath || null,
    };
  }).filter((s) => s.connectionId || s.localPath);
}

/**
 * A join that KEEPS its target (append / merge) whose build found the live
 * table no longer fits what it writes (joinSettings.targetRebuild — see
 * workflowBuilder's joinTargetRebuild). Before the join runs:
 *
 *   - the live table is read again. If it is gone, or it already has the shape
 *     the join writes (someone fixed it, or an earlier approved run recreated
 *     it), nothing needs dropping: the flag is cleared and the join runs.
 *   - otherwise the drop needs the user's approval — given at build time (bound
 *     to the exact CREATE statement) or for this run (the "Run this node" card,
 *     the Execute prompt: helpers.approvedRebuilds). Without it the run is
 *     refused and nothing is touched; a run started by a trigger never has it.
 *   - with it, the table is dropped here, and the join's own "create when
 *     missing" step recreates it from targetDdl.
 *
 * Returns { proceed, configPatch?, result? }.
 */
async function joinTargetRebuildGate(node, config, helpers) {
  const settings = config.joinSettings || {};
  const rebuild = settings.targetRebuild;
  const mode = settings.operationMode;
  if (!rebuild?.pending || (mode !== 'append' && mode !== 'merge')) return { proceed: true };

  const table = config.targetTableName;
  const isLocal = config.targetDbType === 'duckdb';
  const workflowId = helpers?.workflowId || null;
  const clear = { joinSettings: { ...settings, targetRebuild: null } };

  let live = null;
  let plugin = null;
  let fullConfig = null;
  let defaultSchema = null;
  const connectionId = config.targetConnectionId;
  if (isLocal) {
    live = workflowId ? await targetShape.probeLocalTable(workflowId, table) : null;
  } else {
    plugin = helpers?.pluginManager?.getConnector?.(config.targetDbType) || null;
    if (plugin && typeof helpers.getFullConfig === 'function') {
      fullConfig = await helpers.getFullConfig(connectionId, config.targetDbConfig || {});
      defaultSchema = config.targetDbConfig?.schema || fullConfig?.schema || fullConfig?.dbConfig?.schema || null;
      live = await targetShape.probeTargetTable({
        plugin, config: fullConfig, connectionId, tableName: table, defaultSchema,
      });
    }
  }

  if (live?.state === 'missing') return { proceed: true, configPatch: clear };
  // Cannot tell what is there: run as before rather than drop on a guess.
  if (!live || live.state !== 'exists') return { proceed: true };

  const sameSet = (a = [], b = []) => {
    const x = [...a].map((v) => String(v).toLowerCase()).sort().join(',');
    const y = [...b].map((v) => String(v).toLowerCase()).sort().join(',');
    return x === y;
  };
  const untouchedSinceBuild = sameSet(live.columns.map((c) => c.name), rebuild.liveColumns || [])
    && sameSet(live.primaryKey, rebuild.livePrimaryKey || []);
  const cmp = targetShape.compareTargetShape(live, {
    columns: rebuild.newColumns || [], primaryKey: rebuild.newPrimaryKey || [],
  });
  if (!untouchedSinceBuild && !cmp.changed) return { proceed: true, configPatch: clear };

  const fingerprint = targetShape.statementFingerprint(config.targetDdl);
  const approved = (rebuild.approvedFingerprint && rebuild.approvedFingerprint === fingerprint)
    || (Array.isArray(helpers?.approvedRebuilds) && helpers.approvedRebuilds.includes(node.id));
  if (!approved) {
    return {
      proceed: false,
      result: {
        success: false,
        needsRebuildApproval: true,
        message: `${table} has to be dropped and recreated before this join can write to it: ${rebuild.reason}. `
          + 'Nothing was changed. Approve it from the join\'s chat ("Run this node") or when you press Execute.',
        recordsProcessed: 0,
      },
    };
  }

  if (isLocal) {
    const duck = require('../duckdb');
    await duck.withWorkflowLock(workflowId, async () => {
      await duck.exec(`DROP TABLE IF EXISTS ${await duck.workflowTableRef(workflowId, table)}`);
    });
  } else {
    const ref = live.resolved?.quotedRef
      || plugin.quoteIdentifier(table, qualifierFor(table, defaultSchema), fullConfig);
    const dropped = await plugin.runQuery(fullConfig, connectionId, { query: `DROP TABLE ${ref}` });
    if (dropped && dropped.success === false) {
      return {
        proceed: false,
        result: {
          success: false,
          message: `Could not drop ${table} to recreate it: ${dropped.message || 'unknown error'}. Nothing else was changed.`,
          recordsProcessed: 0,
        },
      };
    }
  }
  console.log(`[Workflow Execution] Join ${node.id}: dropped ${table} (approved) — it is recreated from targetDdl.`);
  return { proceed: true, configPatch: clear, recreated: true };
}

async function executeJoinNode(node, nodeMap, edges, helpers) {
  const { getFullConfig } = helpers;

  console.log(`[Workflow Execution] Executing Join node: ${node.id}`);

  const config = node.data?.config;

  if (!config) {
    return {
      success: false,
      message: 'Join configuration not found',
      recordsProcessed: 0
    };
  }

  // Reject an unconfigured join up front with a clear, node-named message.
  const joinNotConfigured = checkNodeConfigured(node, 'join');
  if (joinNotConfigured) return joinNotConfigured;

  // Find source nodes
  const sourceEdges = edges.filter(e => e.target === node.id);
  if (sourceEdges.length < 2) {
    return {
      success: false,
      message: 'Join requires at least 2 source connections',
      recordsProcessed: 0
    };
  }

  // Check if join is configured. Saved join nodes store the generated
  // operation as flat fields (sourcesConfig, joinSql / transformFunction,
  // targetDdl …) — there is no nested config.joinConfig; the executor rebuilds
  // it below. So gate on what's actually generated: a SQL join has joinSql, a
  // NoSQL/vector join has a transformFunction. Both JoinNodeChat (interactive)
  // and the headless workflow builder produce this same flat shape.
  if (!config.joinSql && !config.transformFunction) {
    return {
      success: false,
      message: 'Join configuration not found',
      recordsProcessed: 0
    };
  }

  // The join's SQL, DDL and staging tables were generated for ONE set of
  // sources, each read a specific way. Three things can leave that set behind,
  // and all three are refused here rather than run:
  //
  //   - a source RETARGETED at another table or connection (the re-point passes
  //     move the identity and deliberately leave the SQL alone);
  //   - a source DISCONNECTED or deleted, whose step the SQL still names and
  //     whose connection the step still carries — so the join would keep
  //     reading a source that is no longer part of the workflow;
  //   - a source ADDED that the SQL has never heard of, which the run would
  //     ignore while reporting success.
  const movedSource = staleJoinSource(
    config.sourcesConfig, sourceEdges.map((e) => e.source), nodeMap, config.directReadSources,
  );
  if (movedSource) return movedSource;

  // Every input has to name its table. Checked here as well as on the source
  // node itself, because "Run this node" runs the join alone — its inputs do
  // not run first — and an unfinished input then surfaced as the join's own
  // SQL failing on a missing table.
  for (const edge of sourceEdges) {
    const upstream = nodeMap?.get(edge.source);
    if (upstream && !nodeOutputTableName(upstream)) {
      const label = upstream.data?.config?.node_name || upstream.data?.label || upstream.id;
      return {
        success: false,
        message: `Join input "${label}" is not configured: it names no table for its output. `
          + 'Finish that node (pick its table, or the cloud file) and run again.',
        recordsProcessed: 0,
      };
    }
  }

  try {
    // Build destination connection from config. Include localPath so a local
    // file destination (LanceDB directory / SQLite file) resolves to the
    // right path — the vector branch falls back to destinationConnection.localPath.
    const destinationConnection = {
      id: config.targetConnectionId || config.connectionId,
      dbType: config.targetDbType,
      dbConfig: config.targetDbConfig || {},
      localPath: config.targetLocalPath
    };

    // Build join config. Pass vectorDestination through so a vector destination
    // (saved Pinecone connection OR local LanceDB table) gets embedded + upserted
    // by the handler's vector branch.
    const joinConfig = {
      sourcesConfig: withVectorIndexCoordinates(config.sourcesConfig, nodeMap),
      // The vector stores the join's function queries itself (similarity
      // joins): where each one lives, so ctx.runQuery can fill in an index or
      // namespace the generated code left out.
      directVectorSources: directVectorSourcesOf(directReadIds(config, nodeMap), nodeMap),
      joinSql: config.joinSql,
      targetDdl: config.targetDdl,
      transformFunction: config.transformFunction,
      targetTableName: config.targetTableName,
      targetCollection: config.targetCollection,
      // Carried so a local join writes to the store its readers already
      // point at, rather than falling back to a derived path.
      targetLocalPath: config.targetLocalPath,
      vectorDestination: config.vectorDestination,
      // The declared output shape — lets a JavaScript join that returned no
      // rows still replace its local target with an empty table of the right
      // columns.
      targetColumns: config.targetTableSchema?.columns || null,
    };

    // A kept target that no longer fits: approved → dropped here and recreated
    // by the join; not approved → refused before anything is touched.
    const gate = await joinTargetRebuildGate(node, config, helpers);
    if (!gate.proceed) return gate.result;

    // Call the join handler directly
    const result = await handleExecuteJoin({
      destinationConnection,
      joinConfig,
      operationMode: config.joinSettings?.operationMode || 'new_table',
      workflowId: helpers?.workflowId || null,
      nodeId: node.id
    });

    return {
      success: result.success,
      // Set by the DuckDB join when the table it wrote came out empty.
      warning: !!result.warning,
      message: result.message || (result.success ? 'Join executed successfully' : 'Join execution failed'),
      // A SQL join reports what it wrote as `rowsAffected`; reading only the
      // other names left every SQL join at 0 rows in the execution record.
      recordsProcessed: result.rowsAffected ?? result.rowCount ?? result.recordCount
        ?? result.documentsInserted ?? 0,
      // The rebuild is done (or was no longer needed): the node stops asking.
      ...(result.success && gate.configPatch ? { configPatch: gate.configPatch } : {}),
      ...(gate.recreated ? { message: `${result.message || 'Join executed successfully'} (${config.targetTableName} was recreated, as approved.)` } : {}),
    };
  } catch (error) {
    // A stop stays an exception all the way to the runner — see executeOutputNode.
    if (isCancelledError(error)) throw error;
    console.error('[Workflow Execution] Join error:', error);
    return {
      success: false,
      message: error.message,
      recordsProcessed: 0
    };
  }
}



/**
 * Execute an Output node
 * Calls the output handler directly
 */
/**
 * The upstream Data Source (any number of nodes back) that reads the table an
 * Output would TRUNCATE, or null. Same connection and same table name
 * (compared without quotes, schema or case).
 */
function truncateTargetClash(outputNode, outputSettings, nodeMap, edges) {
  const s = outputSettings || {};
  if (s.writeMode !== 'truncate' || !s.connectionId || !s.tableName) return null;
  const bare = (n) => String(n || '').split('.').pop().replace(/^[`"\[]+|[`"\]]+$/g, '').toLowerCase();
  const target = bare(s.tableName);
  const seen = new Set();
  const queue = [outputNode.id];
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges || []) {
      if (e.target !== id || seen.has(e.source)) continue;
      seen.add(e.source);
      queue.push(e.source);
      const up = nodeMap.get(e.source);
      if (up?.type !== 'dataSource') continue;
      const c = up.data?.config || {};
      const table = c.sourceTableName || c.sourceCollection || c.sourceTable;
      if (c.sourceConnectionId === s.connectionId && bare(table) === target) {
        return { nodeId: up.id, label: c.node_name || up.data?.label || table };
      }
    }
  }
  return null;
}

async function executeOutputNode(node, nodeMap, edges, helpers) {
  const { getFullConfig, pluginManager, getDb } = helpers;

  console.log(`[Workflow Execution] Executing Output node: ${node.id}`);

  const config = node.data?.config;

  if (!config) {
    return {
      success: false,
      message: 'Output configuration not found',
      recordsProcessed: 0
    };
  }

  // Reject an unconfigured output up front with a clear, node-named message.
  const outputNotConfigured = checkNodeConfigured(node, 'output');
  if (outputNotConfigured) return outputNotConfigured;

  // Find source node
  const sourceEdge = edges.find(e => e.target === node.id);
  if (!sourceEdge) {
    return {
      success: false,
      message: 'No source connection found for output',
      recordsProcessed: 0
    };
  }

  const sourceNode = nodeMap.get(sourceEdge.source);
  if (!sourceNode) {
    return {
      success: false,
      message: 'Source node not found',
      recordsProcessed: 0
    };
  }

  // Check if output is configured
  if (!config.outputSettings) {
    return {
      success: false,
      message: 'Output settings not configured',
      recordsProcessed: 0
    };
  }

  // Guard: "Truncate & insert" into a table this same workflow reads. The
  // truncate empties the table before (or while) it is read — a Data Source
  // wired straight to the Output streams from the table it is emptying — so
  // the run can write nothing and the source data is gone. Append is allowed:
  // it never empties the table (each run re-reads what earlier runs added).
  const clash = truncateTargetClash(node, config.outputSettings, nodeMap, edges);
  if (clash) {
    return {
      success: false,
      message: `Output "${config.outputSettings.tableName}" is set to Truncate & insert, but that table is also read by `
        + `"${clash.label}" earlier in this workflow — truncating it would empty the source before it is read. `
        + 'Write to a different table, or switch the output to Append. Nothing was changed.',
      recordsProcessed: 0,
    };
  }

  try {


    // This node's own source* fields already hold the upstream connection,
    // resolved when the node was configured (OutputNodeChat.js:305). Prefer
    // them. Deriving from the parent instead mixes its source* and target*
    // sides — for a transformer that yields dbType from its source (mongodb)
    // beside localPath from its target (a local file), a pair that matches no
    // read branch in executeOutput. Parent target* comes next, since a
    // transformer/join writes to its target; parent source* is last, covering
    // a datasource parent, which has no target side.
    const sourceConfig = sourceNode.data?.config || {};

    // Those recorded fields are only trustworthy while they still describe the
    // node that actually feeds this one. Inserting a transformer between a data
    // source and an output rewires the edge but leaves this node's copy naming
    // the old parent — and since the copy wins every `||` below, the output
    // would go on reading the data source and quietly ignore the new node.
    //
    // The editor re-points a node's input as soon as its edge changes
    // (workflowUtils.syncNodeSourcesToEdges), so this covers workflows saved
    // before that and any rewire that reached the DB another way.
    const recordedParent = config.sourceNodeId;
    const staleSource = !!recordedParent && recordedParent !== sourceNode.id;
    if (staleSource) {
      console.warn(
        `[Workflow Execution] Output ${node.id} records source ${recordedParent} `
        + `but is wired to ${sourceNode.id}; reading the wired one.`,
      );
    }

    // Naming the right parent is not enough: the parent can be rebuilt IN PLACE
    // onto a different connection or table (an assistant "modify" does exactly
    // that, keeping the node id), leaving this copy pointing at what the parent
    // abandoned. A workflow whose Mongo source and transformer were moved to a
    // new connection failed here with "MongoDB URI is required", because the
    // copy still asked for the replaced connection. The parent is the authority
    // on what it just produced, so where the two disagree the copy loses.
    //
    // The editor refreshes the copy as soon as the parent moves
    // (workflowUtils.syncNodeSourcesToEdges); this covers workflows saved before
    // it did, and any edit that reached the database another way.
    const parentOut = {
      connectionId: sourceConfig.targetConnectionId || sourceConfig.sourceConnectionId,
      tableName: sourceConfig.targetTableName || sourceConfig.sourceTableName,
      collection: sourceConfig.targetCollection || sourceConfig.sourceCollection,
      localPath: sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath,
      indexName: sourceConfig.targetIndexName || sourceConfig.sourceIndexName,
    };
    // Only compared where both sides state something: a parent that never names
    // a collection must not make a copy that does look wrong.
    const disagrees = (mine, theirs) => !!mine && !!theirs && mine !== theirs;
    const staleTarget = !staleSource && (
      disagrees(config.sourceConnectionId, parentOut.connectionId)
      || disagrees(config.sourceTableName, parentOut.tableName)
      || disagrees(config.sourceCollection, parentOut.collection)
      || disagrees(config.sourceLocalPath, parentOut.localPath)
      || disagrees(config.sourceIndexName, parentOut.indexName)
    );
    if (staleTarget) {
      console.warn(
        `[Workflow Execution] Output ${node.id} records connection `
        + `${config.sourceConnectionId}/${config.sourceTableName || config.sourceCollection || ''} `
        + `but ${sourceNode.id} now writes ${parentOut.connectionId}/`
        + `${parentOut.tableName || parentOut.collection || ''}; reading what it writes.`,
      );
    }

    const own = (staleSource || staleTarget) ? {} : config;

    const connection = {
      id: own.sourceConnectionId || sourceConfig.targetConnectionId || sourceConfig.sourceConnectionId,
      name: own.sourceConnectionName || sourceConfig.targetConnectionName || sourceConfig.sourceConnectionName,
      connectionType: own.sourceConnectionType || sourceConfig.targetConnectionType || sourceConfig.sourceConnectionType,
      dbType: own.sourceDbType || sourceConfig.targetDbType || sourceConfig.sourceDbType,
      dbConfig: own.sourceDbConfig || sourceConfig.targetDbConfig || sourceConfig.sourceDbConfig,
      localPath: own.sourceLocalPath || sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath,
      dbCategory: own.sourceDbCategory || sourceConfig.targetDbCategory || sourceConfig.sourceDbCategory,
      indexName: own.sourceIndexName || sourceConfig.targetIndexName || sourceConfig.sourceIndexName // For Pinecone
    };

    const sourceConnectionId = connection.id;

    const sourceConnection = await getFullConfig(sourceConnectionId, connection);
    
    // console.log('sourceConnectionId: ', sourceNode, sourceConnection)

    if (!sourceConnection) {
      return {
        success: false,
        message: 'Source connection not found',
        recordsProcessed: 0
      };
    }

    // Call the output handler directly. getDb IS available on the helpers
    // bundle (assembled in electron.js); the previous null hard-code broke
    // insertToConnection's connection-lookup at outputExecutionHelpers.js:760.
    const skillHelpers = typeof helpers.buildSkillHelpers === 'function'
      ? await helpers.buildSkillHelpers()
      : null;
    // Which table/collection to read, and its shape. Same rule as the
    // connection above: a stale copy describes the wrong node's output.
    let readSchema = own.sourceTableSchema || sourceConfig.targetTableSchema || sourceConfig.sourceTableSchema;
    // A Pinecone source is read from one NAMESPACE, which the node records as
    // sourceNamespace / sourceSchema (a Data Source) or targetSchema (a node
    // maintaining it in place) — not in the table schema. Without it the read
    // went to the default namespace and an Output from Pinecone wrote 0 rows.
    if (connection.dbType === 'pinecone' && readSchema && !readSchema.schema && !readSchema.namespace) {
      const namespace = own.sourceNamespace || own.sourceSchema
        || sourceConfig.targetSchema || sourceConfig.sourceNamespace || sourceConfig.sourceSchema;
      if (namespace) readSchema = { ...readSchema, schema: namespace };
    }
    const result = await executeOutput(
      sourceConnection,
      readSchema,
      config.outputSettings,
      pluginManager,
      getFullConfig,
      getDb,
      skillHelpers
    );

    return {
      success: result.success,
      // A node that succeeded with something worth saying — an empty source,
      // so nothing was written. The runner logs it at warn level; dropping it
      // here left an empty run indistinguishable from a full one.
      warning: !!result.warning,
      message: result.message || (result.success ? 'Output executed successfully' : 'Output execution failed'),
      recordsProcessed: result.rowCount || result.recordCount || 0
    };
  } catch (error) {
    // The last catch between the batch-insert loop and the runner. A stop has
    // to stay an exception through here, or it arrives as { success: false }
    // and the run is recorded as FAILED — see executionCancel.js.
    if (isCancelledError(error)) throw error;
    console.error('[Workflow Execution] Output error:', error);
    return {
      success: false,
      message: error.message,
      recordsProcessed: 0
    };
  }
}

/**
 * Execute a single workflow node
 * @param {object} node - The node to execute
 * @param {Map} nodeMap - Map of node IDs to node objects
 * @param {Array} edges - Array of workflow edges
 * @param {object} helpers - Helper functions and dependencies
 * @returns {Promise<object>} - Result of node execution
 */
/**
 * The saved connections a node reads or writes THROUGH, as
 * { id, name, role }. `local-…` ids are this workflow's own storage, not saved
 * connections, and are left out. Mirrored for the canvas by
 * src/utils/connectionRefs.js — keep the two field lists in step.
 */
function connectionRefsOf(node) {
  const c = node?.data?.config || {};
  const refs = [];
  const add = (id, name, role) => {
    if (!id || typeof id !== 'string' || id.startsWith('local-')) return;
    if (refs.some((r) => r.id === id)) return;
    refs.push({ id, name: name || null, role });
  };
  switch (node?.type) {
    case 'dataSource':
      add(c.sourceConnectionId, c.sourceConnectionName, 'reads from');
      add(c.sourceApiConnectionId, c.sourceApiConnectionName, 'reads from');
      break;
    case 'transformer':
      add(c.sourceConnectionId, c.sourceConnectionName, 'reads from');
      add(c.targetConnectionId, c.targetConnectionName, 'writes to');
      break;
    case 'join':
      (Array.isArray(c.sources) ? c.sources : []).forEach((src) => add(src?.sourceConnectionId, src?.sourceConnectionName, 'reads from'));
      add(c.targetConnectionId, c.targetConnectionName, 'writes to');
      break;
    case 'output':
      add(c.sourceConnectionId, c.sourceConnectionName, 'reads from');
      if (c.outputSettings?.outputType === 'connection') add(c.outputSettings.connectionId, null, 'writes to');
      break;
    default:
      break;
  }
  return refs;
}

/**
 * Refuse to run a node whose saved connection has been deleted.
 *
 * Deleting a connection used to change nothing about a run: a file source fell
 * back to the path saved on the node, so the workflow kept reading a file the
 * user had removed from the app, and reported success. The connection is the
 * user's statement of what the workflow may touch — gone, the node stops.
 *
 * @returns {Promise<object|null>} a failed node result, or null when every
 *   connection the node names exists.
 */
async function deletedConnectionFailure(node, helpers) {
  const refs = connectionRefsOf(node);
  if (!refs.length || typeof helpers?.getDb !== 'function') return null;
  let saved;
  try {
    const connectionsDb = await helpers.getDb('connections');
    const all = await connectionsDb.findAsync({});
    saved = new Set((all || []).map((conn) => conn.id).filter(Boolean));
  } catch (err) {
    console.log('[Workflow Execution] Could not read the saved connections:', err.message || err);
    return null; // cannot tell — do not block the run on a lookup failure
  }
  const gone = refs.filter((r) => !saved.has(r.id));
  if (!gone.length) return null;
  // The runner already names the node ("Node X failed: …"), so this names
  // only the connection and what to do about it.
  const list = gone.map((r) => `"${r.name || r.id}", which this node ${r.role},`).join(' and ');
  return {
    success: false,
    message: `Connection ${list} no longer exists — it was deleted. `
      + 'Open the node and pick another connection, or add the connection back.',
    recordsProcessed: 0,
    missingConnections: gone,
  };
}

async function executeNode(node, nodeMap, edges, helpers) {
  let nodeResult = null;
  if (node.type !== 'start') {
    const refused = await deletedConnectionFailure(node, helpers);
    if (refused) return refused;
  }
  // console.log('node: ', node)
  switch (node.type) {
    case 'dataSource':
      nodeResult = await executeDataSourceNode(node, helpers);
      break;

    case 'transformer':
      nodeResult = await executeTransformerNode(node, nodeMap, edges, helpers);
      break;

    case 'join':
      nodeResult = await executeJoinNode(node, nodeMap, edges, helpers);
      break;

    case 'output':
      nodeResult = await executeOutputNode(node, nodeMap, edges, helpers);
      break;

    case 'start':
      // Start nodes don't need execution
      nodeResult = { success: true, message: 'Start node' };
      break;

    default:
      console.log(`[Workflow Execution] Skipping node type: ${node.type}`);
      nodeResult = { success: true, message: `Skipped ${node.type} node` };
  }

  // Transformer / join / output write a table, collection or file that nothing
  // could read until this moment. Flag it in the saved workflow so readers —
  // the Data Preview above all — know the output is really there now.
  if (nodeResult?.success && node.type === 'join' && nodeResult.configPatch?.joinSettings) {
    await persistJoinSettingsPatch(node, nodeResult.configPatch, helpers);
  }
  // A transformer that wrote a table in the workflow's DuckDB: record what
  // that table really is (see writtenTableSchema), for the editor and on the
  // saved workflow.
  if (nodeResult?.success && node.type === 'transformer') {
    const targetTableSchema = await writtenTableSchema(node, helpers);
    if (targetTableSchema) {
      nodeResult.configPatch = { ...(nodeResult.configPatch || {}), targetTableSchema };
    }
  }
  // A REST API source's fetch, or a transformer's written table: keep the
  // schema the run found on the saved workflow, whoever started the run.
  if (nodeResult?.success && (node.type === 'dataSource' || node.type === 'transformer') && nodeResult.configPatch) {
    await persistNodeSchemaPatch(node, nodeResult.configPatch, helpers);
  }
  if (nodeResult?.success && MATERIALIZING_NODE_TYPES.has(node.type)) {
    await markNodeExecuted(node, helpers);
  }

  return nodeResult;
}

// Each node holds the user's database files for as long as it runs — see
// holdDatabases in ../duckdb.
const { holdDatabases } = require('../duckdb');

module.exports = {
  addExecutionLog,
  connectionRefsOf,
  joinTargetRebuildGate,
  executeNode: (...args) => holdDatabases(() => executeNode(...args)),
  executeDataSourceNode,
  executeTransformerNode,
  executeJoinNode,
  executeOutputNode,
  nodeOutputTableName,
};
