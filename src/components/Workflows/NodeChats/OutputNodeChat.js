import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { message as antdMessage } from 'antd';
import { connectionsDb } from '../../../utils/localDb';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';
import { sourceFieldsFromUpstream } from '../../../utils/workflowUtils';
import CloudStorageBrowser from '../CloudStorageBrowser';
import GoogleSheetsPicker from '../GoogleSheetsPicker';
import {
  FileExcelOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  ApiOutlined,
  CloudOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';
import {
  FORM_ACCENT, GROUP_COLOR,
  FormScope, FormBody, FormFooter, Card, Fields, Field,
  Segmented, SelectInput, TextInput, PathPicker, Note, Handoff, HandoffBody,
  Picked, CloudButton, EmptyState, ConnList, ConnGroupToggle, ConnRow, IconFolder,
} from './_formShared';

// ─────────────────────────────────────────────────────────────────────────────
// Output Node configuration form
// Local Environment → format + native save dialog.
// Connection       → grouped destination list, then a table name (databases),
//                    an index name (vector) or a browsed upload path (cloud).
// Saving runs the output first, then persists the config.
// ─────────────────────────────────────────────────────────────────────────────

const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

const FORMAT_OPTIONS = [
  { label: 'JSON — export as JSON file', value: 'json' },
  { label: 'CSV — export as CSV file', value: 'csv' },
  { label: 'Excel — export as .xlsx', value: 'excel' },
  { label: 'DuckDB — local DuckDB database', value: 'duckdb' },
  { label: 'SQLite — local SQLite database', value: 'sqlite' },
  { label: 'LanceDB — local vector database', value: 'lancedb' },
  { label: 'Parquet — export as Parquet file', value: 'parquet' },
  { label: 'Avro — export as Avro file', value: 'avro' },
];

/**
 * Local formats whose file holds MANY tables, so the node has to say which one
 * it writes — the same reason Excel has to name a sheet. Everything else here
 * is one dataset per file, where the path alone identifies the destination.
 */
const TABLE_FORMATS = new Set(['sqlite', 'duckdb', 'lancedb']);

// What an Output can embed with — the dimension is what a Pinecone index must match.
const EMBEDDING_MODEL_OPTIONS = [
  { label: 'text-embedding-3-small (1536 dimensions)', value: 'text-embedding-3-small' },
  { label: 'text-embedding-3-large (3072 dimensions)', value: 'text-embedding-3-large' },
];

/** Where the file extension differs from the format's name. Only Excel does. */
const EXTENSION_BY_FORMAT = { excel: 'xlsx' };

/**
 * A sheet name Excel will accept: at most 31 characters, none of `\ / ? * [ ] :`,
 * not wrapped in apostrophes. A table name is bound by none of that, so a name
 * derived from one is brought inside the rules before it is offered as the
 * default. Mirrors sanitizeSheetName in public/duckdb/xlsx.js, which applies the
 * same rules again at write time — this copy exists because the renderer cannot
 * reach into the main process's modules.
 */
const sanitizeSheetName = (name, fallback = 'Data') => {
  const cleaned = String(name || '')
    .replace(/[\\/?*[\]:]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .trim();
  return cleaned || fallback;
};

/**
 * A table name SQLite and DuckDB will both accept unquoted: letters, digits and
 * underscores, not starting with a digit. Mirrors sanitizeIdentifier in
 * public/duckdb/index.js, which applies the same rules again at write time —
 * this copy exists because the renderer cannot reach into the main process's
 * modules, exactly like sanitizeSheetName above.
 */
const sanitizeTableName = (name, fallback = 'data') => {
  const cleaned = String(name || '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(?=\d)/, '_')
    .slice(0, 80);
  return cleaned || fallback;
};

const GROUP_ORDER = ['Databases', 'Vector', 'Cloud Storage', 'APIs', 'Local Files', 'Other'];

/**
 * Undo the pre-quoting an earlier build applied before saving. The executor
 * quotes the name itself, so a stored `db`.`tbl` came back doubled up
 * ("Table 'db.tbl' doesn't exist"). Stripping the quote characters is all that
 * is needed: what a destination stores is the PLAIN name, quoted once at run
 * time by the target connector's quoteIdentifier.
 *
 * The qualifier is deliberately kept. This used to also drop a leading segment
 * that matched the connection's own database/schema, because the executor
 * re-added it — but it read `database || schema`, and a two-part destination
 * name means a SCHEMA on every engine here except MySQL (database) and
 * BigQuery (dataset). On a Postgres connection to a database named `reporting`,
 * a destination of `reporting.orders` — meaning the SCHEMA `reporting` — was
 * stripped to `orders` and then resolved through search_path, writing to a
 * different table than the one named. Every connector now quotes a qualified
 * name correctly on its own, so there is nothing left for this to repair.
 */
const normalizeSavedTableName = (raw) => {
  if (!raw) return raw;
  return String(raw).replace(/[`"[\]]/g, '');
};

const categorizeConnection = (conn) => {
  if (!conn) return 'Other';
  if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
  if (conn.dbCategory === 'API' || conn.dbType === 'rest-api') return 'APIs';
  if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return 'Vector';
  if (conn.connectionType === 'database') return 'Databases';
  if (conn.connectionType === 'file') return 'Local Files';
  return 'Other';
};

const getDbIcon = (dbType) => {
  const iconMap = {
    postgres: PostgresIcon,
    mysql: MysqlIcon,
    mssql: MssqlIcon,
    mongodb: MongodbIcon,
    sqlite: SqlliteIcon,
    gcs: GoogleCloudStorageIcon,
    dropbox: DropboxIcon,
    'google-drive': GoogleDriveIcon,
    'google-sheets': GoogleSheetsIcon,
  };
  return iconMap[dbType?.toLowerCase()] || null;
};

const getConnectionIcon = (connection) => {
  if (!connection) return null;
  const category = categorizeConnection(connection);
  if (category === 'APIs') return <ApiOutlined style={{ fontSize: 16 }} />;
  if (category === 'Vector') return <AppstoreOutlined style={{ fontSize: 16 }} />;
  if (category === 'Cloud Storage') {
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <CloudOutlined style={{ fontSize: 16 }} />;
  }
  if (connection.connectionType === 'file') {
    const fileName = connection.fileInfo?.fileName?.toLowerCase() || '';
    if (fileName.endsWith('.csv')) return <FileTextOutlined style={{ fontSize: 16 }} />;
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <FileExcelOutlined style={{ fontSize: 16 }} />;
  }
  const IconComponent = getDbIcon(connection.dbType);
  return IconComponent ? <IconComponent /> : <DatabaseOutlined style={{ fontSize: 16 }} />;
};

const OutputNodeChat = ({
  node,
  nodes,
  edges,
  initialConfig,
  onSave,
  onCancel,
  onDirtyChange,
  // True while the panel is running this node. Running is started from the
  // panel header, not from here; this only keeps the form's own controls from
  // being edited or re-saved underneath a run in flight.
  executing = false,
}) => {
  const initialized = useRef(false);

  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState(null);

  // Source node (output requires exactly 1 input)
  const [sourceNode, setSourceNode] = useState(null);
  const [sourceConnection, setSourceConnection] = useState(null);
  const [sourceTableSchema, setSourceTableSchema] = useState(null);

  // Destinations that can receive output
  const [availableConnections, setAvailableConnections] = useState([]);
  const [pluginManager, setPluginManager] = useState(null);

  const saved = initialConfig?.outputSettings || null;
  const [outputSettings, setOutputSettings] = useState({
    outputType: saved?.outputType || 'local',
    format: saved?.format || null,
    savePath: saved?.savePath || null,
    connectionId: saved?.connectionId || null,
    tableName: saved?.tableName || null,
    // Cloud only: the object the upload writes, as the user sees it — the path
    // inside the container ("e2e/stores.csv") and its file name. `tableName`
    // keeps the full `<container>/<path>` the connector needs, but its container
    // half is often an id ("root", a drive GUID), which is no name for a card.
    objectPath: saved?.objectPath || null,
    objectName: saved?.objectName || null,
    // Excel only. An output node has exactly one input, so it writes exactly
    // one sheet — pointing several nodes at the same workbook with different
    // sheet names is how a multi-sheet file gets built.
    sheetName: saved?.sheetName || null,
    // What to do with what is already at the destination on every run:
    // 'append' adds to it, 'truncate' empties it first. Only destinations that
    // KEEP rows between runs have the choice — a file is rewritten whole
    // whatever this says — so the control below is shown for those only.
    // Defaults to append, which is what every output node did before.
    writeMode: saved?.writeMode || 'append',
    // Vector destinations only (a LanceDB file, a Pinecone / LanceDB
    // connection): the column embedded on the way out when the input is plain
    // rows. Empty means the input already carries vectors.
    embedColumn: saved?.embedColumn || null,
    embeddingModel: saved?.embeddingModel || 'text-embedding-3-small',
    // Vector destination in Append mode only, optional: the column that is the
    // row's primary key. Records are upserted under it, so a re-run replaces
    // them. Empty: ids are a hash of the whole row.
    idColumn: saved?.idColumn || null,
  });

  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [executionError, setExecutionError] = useState(null);


  const [cloudStorageBrowserOpen, setCloudStorageBrowserOpen] = useState(false);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // The one funnel every control in this form writes through, and so the one
  // place `dirty` is raised — which is what puts the footer action on screen.
  const patch = useCallback((next) => {
    setDirty(true);
    setExecutionError(null);
    setOutputSettings((prev) => ({ ...prev, ...next }));
  }, []);

  // ── Detect the source node and load destinations ─────────────────────────

  const detectSourceNode = useCallback(async () => {
    const connectedEdges = edges.filter((e) => e.target === node.id);
    if (connectedEdges.length === 0) {
      setSourceError('An output node requires a connected data source. Connect a source, then reopen this node.');
      return;
    }
    if (connectedEdges.length > 1) {
      setSourceError('An output node can only have one connected source. Remove the extra connections.');
      return;
    }

    const source = nodes.find((n) => n.id === connectedEdges[0].source);
    if (!source || !source.data?.config) {
      setSourceError(`Source node "${source?.data?.label || 'upstream'}" is not configured. Configure the source first.`);
      return;
    }

    const sourceConfig = source.data.config;
    const isDataSource = sourceConfig.nodeType === 'datasource';

    const connection = {
      id: isDataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
      name: isDataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
      connectionType: isDataSource
        ? (sourceConfig.sourceConnectionType || 'database')
        : (sourceConfig.targetConnectionType || 'database'),
      dbType: isDataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
      dbConfig: isDataSource ? (sourceConfig.sourceDbConfig || {}) : (sourceConfig.targetDbConfig || {}),
      localPath: isDataSource ? sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath,
      fileInfo: sourceConfig.fileInfo,
    };

    const savedSchema = isDataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;

    let schema;
    if (savedSchema) {
      schema = {
        sourceNodeId: source.id,
        sourceNodeLabel: source.data.label,
        tableName: (isDataSource ? sourceConfig.sourceTableName : sourceConfig.targetTableName)
          || (isDataSource ? sourceConfig.sourceCollection : sourceConfig.targetCollection)
          || savedSchema.tableName,
        columns: savedSchema.columns,
        sampleData: savedSchema.sampleData,
        query: isDataSource ? sourceConfig.sourceSql : sourceConfig.targetSql,
        sheetName: savedSchema.sheetName,
      };
    } else {
      schema = await loadSourceTableSchema(source, connection);
      if (schema) {
        schema.sourceNodeId = source.id;
        schema.sourceNodeLabel = source.data.label;
      }
    }

    if (!schema) {
      setSourceError(`Failed to load the schema for source "${source.data.label}".`);
      return;
    }

    setSourceNode(source);
    setSourceConnection(connection);
    setSourceTableSchema(schema);
    setSourceError(null);
  }, [edges, nodes, node.id]);

  const loadSourceTableSchema = async (source, connection) => {
    if (!window.electronAPI?.dbConnect && connection.connectionType === 'database') {
      console.warn('Database API not available');
      return null;
    }
    try {
      const sourceConfig = source?.data?.config || {};
      const isNoSQL = connection.dbType === 'mongodb';

      let tableName = null;
      let tableSchema = null;
      let localPath = null;
      let queryConnection = connection;

      if (isNoSQL) {
        tableName = sourceConfig.targetCollection || sourceConfig.sourceCollection || sourceConfig.table;
        localPath = sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
      } else {
        tableSchema = sourceConfig.targetSchema || sourceConfig.sourceSchema || connection.dbConfig?.schema;
        tableName = sourceConfig.targetTableName || sourceConfig.sourceTableName || sourceConfig.table;
      }

      if (!tableName && !localPath) {
        console.warn('Could not determine table name or local path from source config');
        return null;
      }

      return await loadTableSchema({ connection: queryConnection, tableName, tableSchema, localPath, limit: 5 });
    } catch (error) {
      console.error('Failed to load source schema:', error);
      return null;
    }
  };

  const loadDestinations = useCallback(async () => {
    const allConnections = await connectionsDb.getAll();

    const pluginsMap = new Map();
    if (window.electronAPI?.dbConnect?.listPlugins) {
      try {
        const pluginsResult = await window.electronAPI.dbConnect.listPlugins();
        if (pluginsResult.success && pluginsResult.connectors) {
          pluginsResult.connectors.forEach((plugin) => pluginsMap.set(plugin.id, plugin));
          setPluginManager({
            getConnector: (dbType) => pluginsResult.connectors.find((c) => c.id === dbType) || null,
          });
        }
      } catch (error) {
        console.error('Failed to load plugins:', error);
      }
    }

    const enriched = allConnections.map((conn) => {
      const plugin = pluginsMap.get(conn.dbType);
      // LanceDB is built in, not a connector plugin, so its connections keep the
      // category they were saved with — overwriting it with the (missing)
      // plugin's dropped every LanceDB connection from the destinations.
      return { ...conn, dbCategory: plugin?.dbCategory || conn.dbCategory || null, storageType: plugin?.storageType || null };
    });

    // Only databases, vector stores and cloud storage can receive output. A
    // REST API is read-only as far as the output node is concerned, and it can
    // carry connectionType 'database', so exclude it explicitly.
    const destinations = enriched
      .filter((conn) => conn.dbCategory !== 'API' && conn.dbType !== 'rest-api')
      .filter((conn) => conn.connectionType === 'database'
        || conn.dbCategory === 'CloudStorage'
        || conn.dbCategory === 'Vector')
      .map((conn) => {
        const group = categorizeConnection(conn);
        const isCloudStorage = conn.dbCategory === 'CloudStorage';
        const isVector = conn.dbCategory === 'Vector';
        return {
          id: conn.id,
          name: conn.name,
          meta: isCloudStorage
            ? `Upload to ${conn.name} (${conn.dbType})`
            : isVector
              ? `Insert vectors into ${conn.name} (${conn.dbType})`
              : `Insert into ${conn.name} (${conn.dbType})`,
          connection: conn,
          icon: getConnectionIcon(conn),
          group,
        };
      });

    setAvailableConnections(destinations);
    return destinations;
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      setLoading(true);
      await detectSourceNode();
      const destinations = await loadDestinations();

      // Repair a table name pre-quoted by an older build.
      const savedTable = saved?.tableName;
      if (saved?.outputType === 'connection' && savedTable) {
        const dest = destinations.find((d) => d.id === saved.connectionId);
        if (dest && dest.group !== 'Cloud Storage') {
          const fixed = normalizeSavedTableName(savedTable);
          if (fixed !== savedTable) {
            setOutputSettings((prev) => ({ ...prev, tableName: fixed }));
          }
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectSourceNode, loadDestinations]);

  // ── Derived selection state ──────────────────────────────────────────────

  const selectedDestination = useMemo(
    () => availableConnections.find((c) => c.id === outputSettings.connectionId) || null,
    [availableConnections, outputSettings.connectionId],
  );

  const destKind = useMemo(() => {
    if (!selectedDestination) return null;
    const group = selectedDestination.group;
    if (group === 'Cloud Storage') return 'cloud';
    if (group === 'Vector') return 'vector';
    return 'database';
  }, [selectedDestination]);

  const grouped = useMemo(() => {
    const buckets = new Map();
    availableConnections.forEach((c) => {
      if (!buckets.has(c.group)) buckets.set(c.group, []);
      buckets.get(c.group).push(c);
    });
    buckets.forEach((list) => list.sort((a, b) => String(a.name).localeCompare(
      String(b.name), undefined, { sensitivity: 'base', numeric: true },
    )));
    return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => [g, buckets.get(g)]);
  }, [availableConnections]);

  // Categories collapse so a long destination list stays navigable. Open the
  // group holding the current selection, else the first one.
  const [openGroups, setOpenGroups] = useState({});
  const groupsSeeded = useRef(false);
  useEffect(() => {
    if (groupsSeeded.current || loading || grouped.length === 0) return;
    groupsSeeded.current = true;
    const selectedGroup = availableConnections.find((c) => c.id === outputSettings.connectionId)?.group;
    setOpenGroups({ [selectedGroup || grouped[0][0]]: true });
  }, [grouped, availableConnections, outputSettings.connectionId, loading]);

  const toggleGroup = (group) => setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const dbType = selectedDestination?.connection?.dbType;

  // Destinations that KEEP what was written last time, so "append or replace?"
  // is a real question. A table, a collection, a vector index and a Sheets tab
  // all qualify. An object in cloud storage and a local file do not: the write
  // replaces the whole file, which is the same thing every run.
  // Where the rows become vectors: a LanceDB file, or a vector connection.
  const writesVectors = (outputSettings.outputType === 'local' && outputSettings.format === 'lancedb')
    || (outputSettings.outputType === 'connection' && destKind === 'vector');
  const embedColumnOptions = useMemo(() => [
    { label: 'None — the data already has vectors', value: '' },
    ...((sourceTableSchema?.columns || [])
      .map((c) => (typeof c === 'string' ? c : c?.name))
      .filter(Boolean)
      .map((name) => ({ label: name, value: name }))),
  ], [sourceTableSchema]);

  const idColumnOptions = useMemo(() => [
    { label: 'None — use a hash of the whole row', value: '' },
    ...embedColumnOptions.slice(1),
  ], [embedColumnOptions]);

  // A LanceDB file is the exception among local files: it is a vector
  // database, written exactly like a LanceDB connection.
  const keepsRowsBetweenRuns = (outputSettings.outputType === 'connection'
    && (destKind === 'database' || destKind === 'vector' || dbType === 'google-sheets'))
    || (outputSettings.outputType === 'local' && outputSettings.format === 'lancedb');

  // ── Validation ───────────────────────────────────────────────────────────

  const missing = useMemo(() => {
    const out = {};
    if (outputSettings.outputType === 'local') {
      if (!outputSettings.format) out.format = true;
      if (!outputSettings.savePath) out.savePath = true;
      // A workbook needs a tab to write to, and the user can clear the field.
      if (outputSettings.format === 'excel' && !String(outputSettings.sheetName || '').trim()) {
        out.sheetName = true;
      }
      // A multi-table file needs to say which table, for the same reason.
      if (TABLE_FORMATS.has(outputSettings.format) && !String(outputSettings.tableName || '').trim()) {
        out.tableName = true;
      }
    } else {
      if (!outputSettings.connectionId) out.connectionId = true;
      else if (!outputSettings.tableName) out.tableName = true;
    }
    return out;
  }, [outputSettings]);

  const missingCount = Object.keys(missing).length;
  const invalid = (key) => attempted && !!missing[key];

  // Cloud destinations can't be saved until a path has been browsed to.
  const needsCloudPick = outputSettings.outputType === 'connection' && destKind === 'cloud';
  const cloudBlocked = needsCloudPick && !outputSettings.tableName;

  // Panel-level: the header's Run button is what sets it. Saving is synchronous
  // now, so this form has no in-flight state of its own to track.
  const running = executing;

  // Saving needs a complete, valid form and something to save. Nothing here
  // gates RUNNING — that is the header's decision, and it turns on `dirty`.
  const canSave = !running && !cloudBlocked && missingCount === 0 && dirty;

  const gateMessage = running
    ? 'Running the output — it can be stopped from the execution monitor.'
    : cloudBlocked
    ? 'Pick an upload path to enable Save'
    : executionError
      ? executionError
      : attempted && missingCount > 0
        ? `${missingCount} field${missingCount === 1 ? '' : 's'} still needed`
        : null;

  // ── Actions ──────────────────────────────────────────────────────────────

  // What an Excel sheet is called when the user hasn't said: the table this
  // node is writing. Two output nodes on one workbook then land on different
  // tabs by default instead of overwriting each other.
  const defaultSheetName = useCallback(
    () => sanitizeSheetName(sourceTableSchema?.tableName || sourceNode?.data?.label),
    [sourceTableSchema, sourceNode],
  );

  // Fill the sheet name in once the source is known — for a node saved before
  // this field existed, and for one whose format was set before the source
  // finished loading.
  useEffect(() => {
    if (outputSettings.outputType !== 'local' || outputSettings.format !== 'excel') return;
    if (outputSettings.sheetName) return;
    if (!sourceTableSchema && !sourceNode) return;
    setOutputSettings((prev) => (prev.sheetName ? prev : { ...prev, sheetName: defaultSheetName() }));
  }, [outputSettings.outputType, outputSettings.format, outputSettings.sheetName,
    sourceTableSchema, sourceNode, defaultSheetName]);

  // What the table is called when the user hasn't said: the table this node is
  // writing. Two output nodes on one database file then land on different tables
  // by default instead of overwriting each other — the Excel rule, applied to
  // the formats that also hold more than one dataset per file.
  const defaultTableName = useCallback(
    () => sanitizeTableName(sourceTableSchema?.tableName || sourceNode?.data?.label),
    [sourceTableSchema, sourceNode],
  );

  // Same fill-in as the sheet name above, for a node saved before this field
  // existed or whose format was set before the source finished loading.
  useEffect(() => {
    if (outputSettings.outputType !== 'local' || !TABLE_FORMATS.has(outputSettings.format)) return;
    if (outputSettings.tableName) return;
    if (!sourceTableSchema && !sourceNode) return;
    setOutputSettings((prev) => (prev.tableName ? prev : { ...prev, tableName: defaultTableName() }));
  }, [outputSettings.outputType, outputSettings.format, outputSettings.tableName,
    sourceTableSchema, sourceNode, defaultTableName]);

  const changeOutputType = (value) => {
    // Switching sides drops whatever the other side had picked.
    patch({ outputType: value, format: null, savePath: null, connectionId: null, tableName: null, objectPath: null, objectName: null, sheetName: null, writeMode: 'append', embedColumn: null, idColumn: null });
    setAttempted(false);
  };

  const changeDestination = (conn) => {
    patch({ connectionId: conn.id, tableName: null, objectPath: null, objectName: null });
    setAttempted(false);
  };

  const browseSavePath = async () => {
    if (!outputSettings.format) {
      antdMessage.warning('Choose an output format first.');
      return;
    }
    const fileExtension = EXTENSION_BY_FORMAT[outputSettings.format] || outputSettings.format;
    const defaultFileName = `output_${node.id.slice(0, 8)}.${fileExtension}`;
    try {
      const result = await window.electronAPI.selectSavePath(defaultFileName, fileExtension);
      if (result.canceled) return;
      patch({ savePath: result.filePath });
    } catch (error) {
      console.error('Error selecting save path:', error);
      antdMessage.error('Failed to open the save dialog.');
    }
  };

  const handleCloudStoragePathSelect = (pathInfo) => {
    setCloudStorageBrowserOpen(false);
    const objectPath = pathInfo.objectPath || null;
    patch({
      tableName: pathInfo.fullPath,
      objectPath,
      objectName: objectPath ? objectPath.split('/').filter(Boolean).pop() || null : null,
    });
  };

  const buildConfig = (finalSettings) => {
    if (!sourceNode || !sourceConnection) return {};

    // The full input snapshot, taken the same way the canvas takes it on a
    // rewire (workflowUtils.sourceFieldsFromUpstream) and the headless builder
    // takes it on a chat build (workflowBuilder.copySourceFromUpstream). This
    // panel used to hand-copy a subset, which left out `sourcePreviewSql` —
    // and without a statement to run, the Data Preview has nothing to show for
    // a live database source. Going through the shared helper means all three
    // paths record an output node's input identically.
    const upstream = sourceFieldsFromUpstream(sourceNode);

    // What this panel resolved wins over the raw copy where it knows better:
    // it has already followed the datasource/transformer split to pick the
    // right connection, and loaded the schema for the table actually read.
    // Only defined values override, so a field the panel could not determine
    // falls back to the upstream copy instead of blanking it.
    const resolved = {
      sourceConnectionId: sourceConnection.id,
      sourceConnectionName: sourceConnection.name,
      sourceConnectionType: sourceConnection.connectionType,
      sourceDbType: sourceConnection.dbType,
      sourceDbConfig: sourceConnection.dbConfig,
      sourceTableSchema,
      sourceTableName: sourceTableSchema?.tableName,
      sourceCollection: sourceTableSchema?.tableName,
      sourceLocalPath: sourceConnection.localPath,
    };
    Object.keys(resolved).forEach((k) => {
      if (resolved[k] === undefined) delete resolved[k];
    });

    return {
      nodeType: 'output',
      ...upstream,
      ...resolved,
      outputSettings: finalSettings,
    };
  };

  /**
   * Persist the configuration. Writes nothing to the destination.
   *
   * This used to be "Run & Save": the output was executed first and the config
   * was only kept if the run succeeded. That tied two unrelated decisions
   * together in the wrong direction — a user correcting a wrong destination had
   * to WRITE TO THE WRONG DESTINATION to record the correction, and a run that
   * failed for an unrelated reason (a closed connection, a locked file) threw
   * away settings that were perfectly good. Saving is now free and immediate;
   * running is a separate, deliberate act.
   *
   * The table name goes through as the user typed it. insertToConnection quotes
   * and schema-qualifies it itself, and hands the RAW name to batchInsert —
   * pre-quoting here produced `db`.`tbl` which then got re-qualified, so CREATE
   * TABLE failed silently and the insert reported "table doesn't exist".
   */
  const handleSave = () => {
    setAttempted(true);
    if (missingCount > 0 || cloudBlocked) return;

    setExecutionError(null);
    onSave(buildConfig(outputSettings), []);
    // Saved — this is what enables Run, and what takes the unsaved marker off.
    setDirty(false);
    setAttempted(false);
  };

  // Running lives in the panel header, next to the unsaved marker — see
  // handleHeaderExecute in NodeChatPanel. This form's job ends at saving a
  // valid configuration; what the header needs to decide whether it may run is
  // the dirty flag, which already travels up through onDirtyChange.

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <FormScope>
        <FormBody><EmptyState>Loading the connected source…</EmptyState></FormBody>
      </FormScope>
    );
  }

  if (sourceError) {
    return (
      <FormScope>
        <FormBody>
          <Card label="Source"><Note>{sourceError}</Note></Card>
        </FormBody>
      </FormScope>
    );
  }

  const isLocal = outputSettings.outputType === 'local';

  return (
    <FormScope>
      <FormBody>
        <Card label="Output">
          <Fields>
            <Field
              label="Where would you like to output the data?"
              hint="Export to a local file, or insert into a saved connection."
            >
              <Segmented
                value={outputSettings.outputType}
                options={[
                  { label: 'Local Environment', value: 'local' },
                  { label: 'Connection', value: 'connection' },
                ]}
                onChange={changeOutputType}
              />
            </Field>
            <Note>
              Source: <strong>{sourceNode?.data?.label || sourceTableSchema?.tableName}</strong>
              {' '}— an output node takes exactly one input.
            </Note>
          </Fields>
        </Card>

        {isLocal && (
          <Card label="Local file">
            <Fields>
              <Field label="Output format" required invalid={invalid('format')}>
                <SelectInput
                  value={outputSettings.format ?? ''}
                  placeholder="Select a format…"
                  options={FORMAT_OPTIONS}
                  // Changing the format invalidates a path with the old extension.
                  // A sheet name means nothing outside a workbook.
                  onChange={(v) => patch({
                    format: v,
                    savePath: null,
                    sheetName: v === 'excel' ? (outputSettings.sheetName || defaultSheetName()) : null,
                    // Cleared for every other format so a name left over from the
                    // connection side, or from a format that addresses tables,
                    // can't travel to one where the path IS the destination.
                    tableName: TABLE_FORMATS.has(v) ? (outputSettings.tableName || defaultTableName()) : null,
                  })}
                />
              </Field>
              {outputSettings.format === 'excel' && (
                <Field
                  label="Sheet name"
                  required
                  invalid={invalid('sheetName')}
                  hint={<>The tab this output writes. An existing workbook keeps its other sheets, so a second output node pointed at the same file adds another sheet rather than replacing it.</>}
                >
                  <TextInput
                    value={outputSettings.sheetName ?? ''}
                    placeholder={defaultSheetName()}
                    onChange={(v) => patch({ sheetName: v })}
                  />
                </Field>
              )}
              {TABLE_FORMATS.has(outputSettings.format) && (
                <Field
                  label="Table name"
                  required
                  invalid={invalid('tableName')}
                  hint={<>The table this output writes{outputSettings.format === 'lancedb' ? ' (see Write mode below)' : ', replaced on every run'}. An existing database file keeps its other tables, so a second output node pointed at the same file adds another table rather than replacing it. Letters, digits and underscores.</>}
                >
                  <TextInput
                    value={outputSettings.tableName ?? ''}
                    placeholder={defaultTableName()}
                    onChange={(v) => patch({ tableName: v })}
                  />
                </Field>
              )}
              <Field
                label="Save to"
                required
                invalid={invalid('savePath')}
                hint={<>Opens the native save dialog. Defaults to <code>output_{'{node}'}.{'{ext}'}</code>.</>}
              >
                <PathPicker
                  value={outputSettings.savePath}
                  placeholder="Choose where to write the file…"
                  onChange={(v) => patch({ savePath: v || null })}
                  onBrowse={browseSavePath}
                  browseTitle="Choose save location"
                />
              </Field>
            </Fields>
          </Card>
        )}

        {!isLocal && (
          <Card label="Destination connection">
            {availableConnections.length === 0 ? (
              <EmptyState>
                No database, vector or cloud-storage connection is available. Create one from the Connections tab.
              </EmptyState>
            ) : (
              <>
                <ConnList grouped>
                  {grouped.map(([group, conns]) => (
                    <React.Fragment key={group}>
                      <ConnGroupToggle
                        label={group}
                        color={GROUP_COLOR[group]}
                        count={conns.length}
                        open={!!openGroups[group]}
                        onToggle={() => toggleGroup(group)}
                      />
                      {openGroups[group] && conns.map((c) => (
                        <ConnRow
                          key={c.id}
                          icon={c.icon}
                          name={c.name}
                          meta={c.meta}
                          selected={c.id === outputSettings.connectionId}
                          onClick={() => changeDestination(c)}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                </ConnList>
                <div className="tlx-hint" style={{ marginTop: 8 }}>
                  Only database, vector and cloud-storage connections can receive output.
                </div>
              </>
            )}
          </Card>
        )}

        {!isLocal && destKind === 'database' && (
          <Card label="Target table">
            <Fields>
              <Field
                label="What table should the data be inserted into?"
                required
                invalid={invalid('tableName')}
                hint={
                  dbType === 'bigquery'
                    ? <>BigQuery expects <code>dataset.table_name</code>.</>
                    : dbType === 'snowflake'
                      ? <>Snowflake accepts <code>schema.table_name</code> or a bare name.</>
                      : 'Quoted and schema-qualified for you when the output runs. Created if it does not exist.'
                }
              >
                <TextInput
                  mono
                  value={outputSettings.tableName}
                  placeholder={dbType === 'bigquery' ? 'dataset.table_name' : 'orders_enriched'}
                  onChange={(v) => patch({ tableName: v })}
                />
              </Field>
            </Fields>
          </Card>
        )}

        {!isLocal && destKind === 'vector' && (
          <Card label="Target index">
            <Fields>
              <Field
                label="What table should the vectors be inserted into?"
                required
                invalid={invalid('tableName')}
                hint={dbType === 'pinecone'
                  ? <>Pinecone takes <code>index-name</code> or <code>index-name/namespace</code>.</>
                  : null}
              >
                <TextInput
                  mono
                  value={outputSettings.tableName}
                  placeholder={dbType === 'pinecone' ? 'index-name or index-name/namespace' : 'Enter table name…'}
                  onChange={(v) => patch({ tableName: v })}
                />
              </Field>
            </Fields>
          </Card>
        )}

        {writesVectors && (
          <Card label="Embedding">
            <Fields>
              <Field
                label="Column to embed"
                hint={outputSettings.embedColumn
                  ? (outputSettings.writeMode === 'append'
                    ? (outputSettings.idColumn
                      ? 'Each row is embedded from this column. On a re-run, unchanged rows are skipped, rows whose other columns changed are updated without re-embedding, and only new or edited text is embedded.'
                      : 'Each row is embedded from this column. On a re-run, unchanged rows are skipped; a changed row is a new record and is embedded. Pick an ID column below to update changed rows in place instead.')
                    : 'Each row is embedded from this column. The destination is emptied and reloaded each run, so every row is embedded every run.')
                  : 'Pick a column when the input is plain rows. Leave it on None when the input already carries vectors (an embedding step or another vector store) — they are copied as they are.'}
              >
                <SelectInput
                  value={outputSettings.embedColumn ?? ''}
                  options={embedColumnOptions}
                  onChange={(v) => patch({ embedColumn: v || null })}
                />
              </Field>
              {outputSettings.embedColumn && (
                <Field
                  label="Embedding model"
                  hint="OpenAI, using the key in Settings → AI Provider. A Pinecone index must have the same dimension as the model."
                >
                  <SelectInput
                    value={outputSettings.embeddingModel || 'text-embedding-3-small'}
                    options={EMBEDDING_MODEL_OPTIONS}
                    onChange={(v) => patch({ embeddingModel: v })}
                  />
                </Field>
              )}
            </Fields>
          </Card>
        )}

        {keepsRowsBetweenRuns && (
          <Card label="Write mode">
            <Fields>
              <Field
                label="What should happen to the rows already there?"
                hint={outputSettings.writeMode === 'truncate'
                  ? (dbType === 'google-sheets'
                    ? 'The tab is cleared before the rows are written, so it holds only this run.'
                    : writesVectors
                      ? 'The table (or namespace) is emptied first, so stale vectors cannot survive a re-run.'
                      : 'The table is emptied first — TRUNCATE where the engine supports it, DELETE otherwise. The table itself is kept.')
                  : writesVectors
                    ? 'Records are upserted: a re-run replaces the records it wrote before (matched by the ID column below, or by a hash of the whole row) and adds new ones.'
                    : 'Rows are added to whatever is already there. Re-running adds another copy.'}
              >
                <Segmented
                  value={outputSettings.writeMode}
                  options={[
                    { label: 'Append', value: 'append' },
                    { label: 'Truncate & insert', value: 'truncate' },
                  ]}
                  onChange={(v) => patch({ writeMode: v })}
                />
              </Field>
              {writesVectors && outputSettings.writeMode === 'append' && (
                <Field
                  label="ID column (optional)"
                  hint={outputSettings.idColumn
                    ? `Records are upserted by ${outputSettings.idColumn}: a re-run replaces the record with the same value and adds new ones.`
                    : 'The column that identifies a row (its primary key). Without one, ids are a hash of the whole row, so a row whose values change is stored as a new record and the old one stays until a Truncate & insert.'}
                >
                  <SelectInput
                    value={outputSettings.idColumn ?? ''}
                    options={idColumnOptions}
                    onChange={(v) => patch({ idColumn: v || null })}
                  />
                </Field>
              )}
            </Fields>
          </Card>
        )}

        {!isLocal && destKind === 'cloud' && (
          <Card label="Upload path">
            <Handoff
              color={FORM_ACCENT.source}
              icon={<IconFolder color={FORM_ACCENT.source} size={14} />}
              title={dbType === 'google-sheets' ? 'Choose the tab to write' : 'Choose where to upload'}
            >
              <HandoffBody>
                {dbType === 'google-sheets'
                  ? <>Open the spreadsheet and pick the tab the rows are written to. Save stays
                    disabled until a tab is chosen. Write mode above decides what happens to the
                    rows already in it.</>
                  : <>Browse the bucket and pick the container and object path the results are
                    written to. Save stays disabled until a path is chosen. The file is replaced
                    on every run.</>}
              </HandoffBody>
              {outputSettings.tableName ? (
                <Picked>Uploading to <code>{outputSettings.tableName}</code></Picked>
              ) : null}
              <CloudButton
                onClick={() => setCloudStorageBrowserOpen(true)}
                disabled={!pluginManager}
              >
                {outputSettings.tableName ? 'Change location' : 'Open storage browser'}
              </CloudButton>
            </Handoff>
          </Card>
        )}
      </FormBody>

      <FormFooter
        error={gateMessage}
        onCancel={onCancel}
        cancelDisabled={running}
        onSave={handleSave}
        saveLabel="Save configuration"
        // Nothing edited, nothing to save. Unlike before, this no longer gates
        // running as well — a saved config can be run as many times as the user
        // wants without having to change something first.
        saveDisabled={!canSave}
        saveDisabledReason={running
          ? 'The output is running — stop it from the execution monitor, or wait.'
          : cloudBlocked
            ? 'Pick an upload path in the storage browser first.'
            : missingCount > 0
              ? 'Finish the configuration first.'
              : !dirty
                ? 'Nothing has changed since the last save.'
                : undefined}
      />

      {cloudStorageBrowserOpen && selectedDestination?.connection && pluginManager && (
        selectedDestination.connection?.dbType === 'google-sheets' ? (
          // Spreadsheet through Google's Picker, then the tab to write into —
          // see GoogleSheetsPicker for why the generic browser is not used.
          <GoogleSheetsPicker
            connection={selectedDestination.connection}
            mode="output"
            onFileSelect={handleCloudStoragePathSelect}
            onClose={() => setCloudStorageBrowserOpen(false)}
          />
        ) : (
        <CloudStorageBrowser
          open={cloudStorageBrowserOpen}
          onClose={() => setCloudStorageBrowserOpen(false)}
          connection={selectedDestination.connection}
          onFileSelect={handleCloudStoragePathSelect}
          pluginManager={pluginManager}
          mode="output"
          sourceDbType={sourceConnection?.dbType}
        />
        )
      )}
    </FormScope>
  );
};

export default OutputNodeChat;
