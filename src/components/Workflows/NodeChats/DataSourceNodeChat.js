import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import { Modal, message as antdMessage } from 'antd';
import {
  FileExcelOutlined,
  FileTextOutlined,
  FileOutlined,
  DatabaseOutlined,
  ApiOutlined,
  CloudOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { connectionsDb } from '../../../utils/localDb';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as ParquetIcon } from '../../ConnectorImages/Parquet.svg';
import { ReactComponent as AvroIcon } from '../../ConnectorImages/Avro.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';
import CloudStorageBrowser from '../CloudStorageBrowser';
import GoogleDrivePicker from '../GoogleDrivePicker';
import GoogleSheetsPicker from '../GoogleSheetsPicker';
import ConnectionTypeSelector from '../ConnectionTypeSelector';
import DynamicConnectionForm from '../connections/DynamicConnectionForm';
import LocalFileConnectionForm from '../connections/LocalFileConnectionForm';
import {
  FORM_ACCENT,
  FormScope, FormBody, FormFooter, Card, Fields, Field,
  SearchSelect, StaticValue, Note, Handoff, HandoffBody, Picked, CloudButton, EmptyState,
  SearchBox, ConnList, ConnGroupToggle, ConnRow, NewConnButton, IconFolder, IconChat,
  GROUP_COLOR,
} from './_formShared';

// ─────────────────────────────────────────────────────────────────────────────
// Data Source Node configuration form
//
// Step 1 is always "pick a saved connection". What comes next follows the
// connection's category, and the form never asks the user to restate it:
//   SQL           → schema + table            NoSQL  → collection
//   Vector        → index                     Sheets → spreadsheet + sheet
//   Cloud storage → file picker (gates Save)  API    → save, then the chat opens
//
// The source is picked, not queried — there is no filter or load-options step.
// REST API requests are authored in the ChatAssistant (build_dataSource), which
// this form hands off to on save.
// ─────────────────────────────────────────────────────────────────────────────

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

/** Icon for a local file, keyed by the format it was added as. */
const getFileIcon = (fileType) => {
  const iconMap = {
    csv: () => <FileTextOutlined style={{ fontSize: 16, color: '#16a34a' }} />,
    excel: () => <FileExcelOutlined style={{ fontSize: 16, color: '#1d6f42' }} />,
    json: () => <FileTextOutlined style={{ fontSize: 16, color: '#d97706' }} />,
    parquet: ParquetIcon,
    avro: AvroIcon,
    sqlite: SqlliteIcon,
  };
  return iconMap[fileType] || null;
};

/**
 * What to show when the dataset list comes back empty.
 *
 * A source with nothing in it and a source that could not be READ are different
 * problems with different fixes, and reporting both as "none found" sends the
 * user to check settings that are usually fine. The connector's own message is
 * the half that helps — it names the file that has moved, the extension that
 * would not load, the port that is closed — so it wins whenever there is one.
 *
 * The listing already carried that message back (see loadDatabaseTables); it was
 * only ever rendered as a hint on the picker, which does not exist while the
 * list is empty — so every failure read as "no tables found" no matter what.
 */
const DatasetEmpty = ({ error, noun }) => (
  <EmptyState>
    {error
      ? `Could not list ${noun}: ${error}`
      : `No ${noun} found. Check the connection settings.`}
  </EmptyState>
);

/** Which dataset step a connection leads to. Mirrors the old chat branching. */
const connKindOf = (conn) => {
  if (!conn) return null;
  if (conn.dbType === 'rest-api' || conn.dbCategory === 'API') return 'api';
  // Sheets goes through the cloud browser like every other remote store: the
  // spreadsheet is the container and its tabs are the files. It used to have a
  // private path that imported the tab into the shared SQLite database, which
  // made it a snapshot no run could refresh; a tab now downloads as CSV, is
  // read in place by DuckDB, and re-downloads each run like an S3 object.
  if (conn.dbCategory === 'CloudStorage' || conn.dbType === 'google-sheets') return 'cloud';
  if (conn.dbCategory === 'Vector' || conn.dbType === 'lancedb' || conn.dbType === 'pinecone') return 'vector';
  // Only a remote document store is still NoSQL. Local files — including JSON —
  // are read as SQL by DuckDB.
  if (conn.dbType === 'mongodb') return 'nosql';
  if (conn.connectionType === 'database' || conn.dbType === 'sqlite' || conn.dbType === 'duckdb') return 'sql';
  return 'ready';
};

// A local file is registered by path and read in place by DuckDB, so `dbType`
// records the reader ('duckdb'), not the format the user actually added. The
// original file name is where that survives — recover it from the extension.
const EXT_FILE_TYPE = {
  '.csv': 'csv', '.tsv': 'csv',
  '.xlsx': 'excel', '.xls': 'excel', '.xlsm': 'excel',
  '.json': 'json', '.ndjson': 'json',
  '.parquet': 'parquet',
  '.avro': 'avro',
  '.sqlite': 'sqlite', '.sqlite3': 'sqlite', '.db': 'sqlite',
};

const FILE_TYPE_LABEL = {
  csv: 'CSV',
  excel: 'Excel',
  json: 'JSON',
  parquet: 'Parquet',
  avro: 'Avro',
  sqlite: 'SQLite',
  lancedb: 'LanceDB',
};

const extensionOf = (name) => {
  // A cloud import of a workbook appends the sheet — "sales.xlsx (Sheet1)".
  const base = String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
};

/** What the user added, not what it is stored as. Null for non-file sources. */
const fileTypeOf = (conn) => {
  if (!conn || conn.connectionType !== 'file') return null;
  // Local uploads keep `originalName`; cloud imports name the file `fileName`.
  const name = conn.fileInfo?.originalName
    || conn.fileInfo?.fileName
    || conn.fileInfo?.sourceFilePath
    || '';
  const byExt = EXT_FILE_TYPE[extensionOf(name)];
  if (byExt) return byExt;
  // No usable name: fall back to how it was added, then to how it is read.
  // 'spreadsheet' covers both CSV and Excel, so let the format decide instead.
  if (conn.fileType && conn.fileType !== 'spreadsheet') return conn.fileType;
  if (conn.fileInfo?.format) return conn.fileInfo.format; // csv | json | parquet
  return conn.dbType === 'duckdb' ? null : conn.dbType || null;
};

/** The name of the file behind a local source, sheet suffix and all. */
const fileNameOf = (conn) => conn?.fileInfo?.originalName
  || conn?.fileInfo?.fileName
  || (conn?.fileInfo?.sourceFilePath || '').split(/[\\/]/).pop()
  || null;

const KIND_LABEL = {
  api: 'API',
  cloud: 'Cloud storage',
  sheets: 'Google Sheets',
  vector: 'Vector',
  nosql: 'NoSQL',
  sql: 'SQL',
  ready: 'File',
};

/** Category heading a connection is filed under in the picker. */
const groupOf = (conn) => {
  const kind = connKindOf(conn);
  if (kind === 'api') return 'APIs';
  if (kind === 'cloud' || kind === 'sheets') return 'Cloud Storage';
  if (kind === 'vector') return 'Vector';
  if (conn.connectionType === 'database') return 'Databases';
  if (conn.connectionType === 'file') return 'Local Files';
  return 'Other';
};

const GROUP_ORDER = ['Databases', 'Vector', 'Cloud Storage', 'APIs', 'Local Files', 'Other'];

// Case-insensitive, digit-aware ordering — "table2" sorts before "table10".
const byName = (a, b) => String(a).localeCompare(String(b), undefined, {
  sensitivity: 'base', numeric: true,
});

const getConnectionIcon = (connection) => {
  if (!connection) return null;
  const kind = connKindOf(connection);
  if (kind === 'api') return <ApiOutlined style={{ fontSize: 16 }} />;
  if (kind === 'vector') {
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <AppstoreOutlined style={{ fontSize: 16 }} />;
  }
  if (kind === 'cloud') {
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <CloudOutlined style={{ fontSize: 16 }} />;
  }
  if (connection.connectionType === 'file') {
    // Keyed off the format the user added, not the store it landed in — every
    // CSV/Excel/JSON file is `dbType: 'duckdb'` and would otherwise share one
    // icon.
    const FileIcon = getFileIcon(fileTypeOf(connection));
    if (FileIcon) return <FileIcon />;
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <FileOutlined style={{ fontSize: 16 }} />;
  }
  const IconComponent = getDbIcon(connection.dbType);
  return IconComponent ? <IconComponent /> : <DatabaseOutlined style={{ fontSize: 16 }} />;
};

/**
 * The line under a connection's name: what it is, then what it leads to.
 * For a local file that first half is the format the user added — `dbType` is
 * 'duckdb' for every CSV, Excel, JSON and Parquet source alike, which told the
 * user nothing about which file they were picking.
 */
const connMeta = (conn) => {
  const kind = connKindOf(conn);
  const fileType = fileTypeOf(conn);
  if (fileType) {
    // "SQL" is true of every local file (DuckDB reads them all) and so says
    // nothing; the format already carries the useful half.
    const kindLabel = kind === 'sql' || kind === 'ready' ? 'Local file' : (KIND_LABEL[kind] || 'File');
    return `${FILE_TYPE_LABEL[fileType] || fileType} · ${kindLabel}`;
  }
  return `${conn.dbType || conn.connectionType} · ${KIND_LABEL[kind] || 'Other'}`;
};

const sanitizeCollectionName = (raw, fallback) => {
  const base = String(raw || fallback || 'api_response')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return base || 'api_response';
};

const DataSourceNodeChat = ({
  node,
  initialConfig,
  onSave,
  onCancel,
  onDirtyChange,
  onRequestChatHandoff,
  onLoadDatabaseTables,
  onPreviewConfigUpdate,
}) => {
  const initialized = useRef(false);

  const [connections, setConnections] = useState([]);
  const [search, setSearch] = useState('');
  const [selConn, setSelConn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tablesLoading, setTablesLoading] = useState(false);

  // Dataset selection
  const [dbTableObjects, setDbTableObjects] = useState([]);
  const [selectedSchema, setSelectedSchema] = useState(initialConfig?.sourceSchema || '');
  const [selectedTableName, setSelectedTableName] = useState('');
  // Why the table list is empty, when it is empty because the lookup FAILED
  // rather than because the database holds nothing. Without it a connection
  // that briefly could not be read looked identical to an empty one, and the
  // node's own saved table vanished from the form.
  const [tablesError, setTablesError] = useState('');
  // A vector index is addressed by index + NAMESPACE, and getTables lists one
  // row per pair — so the index name alone does not identify a dataset. Kept
  // apart from selectedSchema, which scopes the SQL table list: here the
  // namespace is chosen AFTER the index, not before it.
  const [selectedNamespace, setSelectedNamespace] = useState(initialConfig?.sourceNamespace || '');
  const [tableSchema, setTableSchema] = useState(initialConfig?.sourceTableSchema || null);
  const [latestWithSQL, setLatestWithSQL] = useState(null);

  // Google Sheets: the spreadsheet's tabs, then the import result. selConn
  // stays the Google Sheets connection so the picker keeps rendering; the
  // imported SQLite file is what buildConfig actually points downstream at.
  const [sheets, setSheets] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetImport, setSheetImport] = useState(null); // { tableName, localPath, sheetName }

  // Cloud storage import
  const [cloudStorageBrowserOpen, setCloudStorageBrowserOpen] = useState(false);
  const [cloudStorageConnection, setCloudStorageConnection] = useState(null);
  const [importedFile, setImportedFile] = useState(null);
  const [pluginManager, setPluginManager] = useState(null);

  // "New connection" modals
  const [isConnectionTypeSelectorOpen, setIsConnectionTypeSelectorOpen] = useState(false);
  const [activeDbType, setActiveDbType] = useState(null);
  const [installedPlugins, setInstalledPlugins] = useState([]);

  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // Saving here is synchronous, so a "saving…" flag can't guard a double
  // click — going not-dirty after a save does, and says something truer.
  const [hasSaved, setHasSaved] = useState(!!initialConfig?.nodeType);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const connKind = connKindOf(selConn);

  // ── Connection loading ───────────────────────────────────────────────────

  const loadConnections = useCallback(async () => {
    try {
      const conns = await connectionsDb.getAll();

      // Plugin metadata carries dbCategory / storageType, which decides the
      // dataset step for each connection.
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

      const enriched = conns.map((conn) => {
        const plugin = pluginsMap.get(conn.dbType);
        return { ...conn, dbCategory: plugin?.dbCategory || null, storageType: plugin?.storageType || null };
      });
      setConnections(enriched);
      return enriched;
    } catch (err) {
      console.error('Failed to load connections', err);
      return [];
    }
  }, []);

  useEffect(() => {
    const loadInstalledPlugins = async () => {
      try {
        if (window.electronAPI?.plugins?.listInstalled) {
          const result = await window.electronAPI.plugins.listInstalled();
          if (result.success) setInstalledPlugins(result.connectors || []);
        }
      } catch (error) {
        console.error('Failed to load installed plugins:', error);
      }
    };
    loadInstalledPlugins();
  }, []);

  /**
   * Re-attach the saved connection. A source that was imported (a cloud file)
   * carries its local path in the config, so graft that back on rather than
   * making the user re-import.
   */
  const restoreConnection = (list, cfg) => {
    if (!cfg) return null;
    if (cfg.sourceApiConnectionId) {
      return list.find((c) => c.id === cfg.sourceApiConnectionId) || null;
    }
    const direct = list.find((c) => c.id === cfg.sourceConnectionId);
    if (!direct) return null;
    // Google Sheets keeps its own connection; the import is restored separately.
    if (direct.dbType === 'google-sheets') return direct;
    if (cfg.sourceConnectionType === 'file' && cfg.sourceLocalPath && !direct.fileInfo?.filePath) {
      return {
        ...direct,
        connectionType: 'file',
        fileInfo: { ...(direct.fileInfo || {}), filePath: cfg.sourceLocalPath },
      };
    }
    return direct;
  };

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      setLoading(true);
      const list = await loadConnections();

      const restored = restoreConnection(list, initialConfig);
      if (restored) {
        setSelConn(restored);
        const savedTable = initialConfig.sourceTableName
          || initialConfig.sourceCollection
          || initialConfig.sourceIndexName
          || '';
        setSelectedSchema(initialConfig.sourceSchema || '');
        setSelectedNamespace(initialConfig.sourceNamespace || '');

        if (restored.dbType === 'google-sheets') {
          // The spreadsheet + sheet were already imported into SQLite; restore
          // the import rather than re-running it.
          setSelectedTableName(initialConfig.sourceSpreadsheetId || '');
          setSelectedSheet(initialConfig.sourceSheetName || '');
          if (initialConfig.sourceLocalPath && initialConfig.sourceTableName) {
            setSheetImport({
              tableName: initialConfig.sourceTableName,
              localPath: initialConfig.sourceLocalPath,
              sheetName: initialConfig.sourceSheetName || '',
            });
          }
        } else {
          setSelectedTableName(savedTable);
        }

        if (initialConfig.sourceSql) {
          setLatestWithSQL({
            sql: initialConfig.sourceSql,
            previewSql: initialConfig.sourcePreviewSql || initialConfig.sourceSql,
            explanation: initialConfig.sourceSqlExplanation || '',
            queryDescription: initialConfig.sourceQueryDescription || '',
          });
        }
        const kind = connKindOf(restored);
        if (kind !== 'api' && kind !== 'cloud' && kind !== 'ready') {
          await loadTables(restored);
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Table loading ────────────────────────────────────────────────────────

  const loadTables = async (conn) => {
    // LanceDB file connections already carry their table list from import.
    if (conn.dbType === 'lancedb' && conn.connectionType === 'file') {
      const tableList = conn.fileInfo?.tables || [];
      setDbTableObjects(tableList.map((t) => ({ name: t, schema: null, type: 'table' })));
      return;
    }

    setTablesLoading(true);
    setTablesError('');
    try {
      const result = await onLoadDatabaseTables(conn);
      if (!result?.success) {
        console.log('Failed to load tables: ', result);
        setDbTableObjects([]);
        setTablesError(
          result?.message
          || result?.error
          || 'Could not read the table list from this connection.',
        );
        return;
      }

      let tableList = result.tables || [];

      // A file connection only owns the tables that came from its own upload.
      if (conn.connectionType === 'file' && conn.fileInfo?.tables?.length > 0) {
        const owned = conn.fileInfo.tables;
        tableList = tableList.filter((t) => owned.includes(t.name || String(t)));
      }

      setDbTableObjects(tableList.map((t) => ({
        name: t.name || String(t),
        schema: t.schema || null,
        displayName: t.displayName || null,
        type: t.type || null,
      })));
    } catch (err) {
      console.error('Failed to load tables:', err);
      setDbTableObjects([]);
      setTablesError(err?.message || 'Could not read the table list from this connection.');
    } finally {
      setTablesLoading(false);
    }
  };

  // ── Connection selection ─────────────────────────────────────────────────

  const selectConnection = async (conn) => {
    setDirty(true);
    setAttempted(false);
    setSelConn(conn);
    setDbTableObjects([]);
    setSelectedSchema('');
    setSelectedNamespace('');
    setSelectedTableName('');
    setSelectedSheet('');
    setSheets([]);
    setSheetImport(null);
    setTableSchema(null);
    setLatestWithSQL(null);
    setImportedFile(null);

    const kind = connKindOf(conn);

    if (kind === 'cloud') {
      setCloudStorageConnection(conn);
      setCloudStorageBrowserOpen(true);
      return;
    }
    if (kind === 'api' || kind === 'ready') return;

    await loadTables(conn);
  };

  const filteredConnections = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter((c) =>
      (c.name || '').toLowerCase().includes(q) || (c.dbType || '').toLowerCase().includes(q));
  }, [connections, search]);

  const groupedConnections = useMemo(() => {
    const buckets = new Map();
    filteredConnections.forEach((c) => {
      const g = groupOf(c);
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(c);
    });
    buckets.forEach((list) => list.sort((a, b) => byName(a.name, b.name)));
    return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => [g, buckets.get(g)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredConnections]);

  // Categories collapse so a long connection list stays navigable. Seed with
  // the group holding the current selection, else the first group.
  const [openGroups, setOpenGroups] = useState({});
  const groupsSeeded = useRef(false);
  useEffect(() => {
    // Wait for init to finish, so a restored connection is already known and
    // we open ITS group rather than defaulting to the first one.
    if (groupsSeeded.current || loading || groupedConnections.length === 0) return;
    groupsSeeded.current = true;
    const current = selConn ? groupOf(selConn) : null;
    setOpenGroups({ [current || groupedConnections[0][0]]: true });
  }, [groupedConnections, selConn, loading]);

  const toggleGroup = (group) => setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  // While searching, show every matching group expanded — collapsing hides hits.
  const searching = search.trim().length > 0;

  // ── Dataset selection ────────────────────────────────────────────────────

  const schemaOptions = useMemo(() => {
    const set = new Set(dbTableObjects.map((t) => t.schema).filter(Boolean));
    return Array.from(set).sort(byName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbTableObjects]);

  const tableOptions = useMemo(() => {
    // A vector store lists one row per index×namespace, so the raw list repeats
    // an index once per namespace — identical label, identical value, and only
    // the first of them reachable. The index list is the distinct names; the
    // namespace is picked separately below.
    if (connKind === 'vector') {
      const seen = new Set();
      return dbTableObjects
        .filter((t) => (seen.has(t.name) ? false : seen.add(t.name)))
        .map((t) => ({ label: t.displayName || t.name, value: t.name }))
        .sort((a, b) => byName(a.label, b.label));
    }
    const scoped = schemaOptions.length > 0 && selectedSchema
      ? dbTableObjects.filter((t) => t.schema === selectedSchema)
      : dbTableObjects;
    const options = scoped
      .map((t) => ({ label: t.displayName || t.name, value: t.name }))
      .sort((a, b) => byName(a.label, b.label));

    // The table this node is ALREADY configured with always appears, even when
    // the live list does not contain it — the lookup failed, the connection is
    // slow, or someone moved the table since. A select whose value is absent
    // from its options renders blank, so reopening a working node showed no
    // table at all and looked unconfigured while its config was intact.
    if (selectedTableName && !options.some((o) => o.value === selectedTableName)) {
      options.unshift({ label: selectedTableName, value: selectedTableName });
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbTableObjects, schemaOptions, selectedSchema, connKind, selectedTableName]);

  // The namespaces the chosen index actually holds. '' is Pinecone's default
  // namespace and a real choice, so it is labelled rather than dropped.
  const namespaceOptions = useMemo(() => {
    if (connKind !== 'vector' || !selectedTableName) return [];
    const seen = new Set();
    return dbTableObjects
      .filter((t) => t.name === selectedTableName)
      .map((t) => t.schema || '')
      .filter((ns) => (seen.has(ns) ? false : seen.add(ns)))
      .sort(byName)
      .map((ns) => ({ label: ns === '' ? '(default)' : ns, value: ns }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbTableObjects, selectedTableName, connKind]);

  const sheetOptions = useMemo(() => (
    [...sheets]
      .sort((a, b) => byName(a.name, b.name))
      .map((s) => ({
        label: `${s.name} — ${s.rowCount} rows × ${s.columnCount} columns`,
        value: s.name,
      }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [sheets]);

  const selectedTable = useMemo(
    () => {
      if (connKind === 'vector') {
        return dbTableObjects.find(
          (t) => t.name === selectedTableName && (t.schema || '') === (selectedNamespace || ''),
        ) || dbTableObjects.find((t) => t.name === selectedTableName) || null;
      }
      return dbTableObjects.find((t) => t.name === selectedTableName) || null;
    },
    [dbTableObjects, selectedTableName, selectedNamespace, connKind],
  );

  // Only one schema / one table (a CSV or single-sheet Excel import, say) means
  // there is no choice to make — take it and show it as a read-only value
  // rather than a dropdown with a single option.
  const onlySchema = schemaOptions.length === 1 ? schemaOptions[0] : null;
  const onlyTable = tableOptions.length === 1 ? tableOptions[0] : null;

  useEffect(() => {
    if (onlySchema && !selectedSchema) setSelectedSchema(onlySchema);
  }, [onlySchema, selectedSchema]);

  const loadTableSchemaFromDB = async (table, connection = null, sheetName = null) => {
    const conn = connection || selConn;
    try {
      // Prefer a schema captured at import time.
      if (conn.fileInfo?.schemas) {
        let savedSchema = null;
        if (Array.isArray(conn.fileInfo.schemas)) {
          savedSchema = conn.fileInfo.schemas.find((s) => s.tableName === table.name);
        } else if (conn.fileInfo.schemas.tableName === table.name) {
          savedSchema = conn.fileInfo.schemas;
        }
        if (savedSchema) {
          setTableSchema(savedSchema);
          return savedSchema;
        }
      }

      // A connection can span several files, so the selected table decides
      // which one to read — fileInfo.filePath is only the first. A workbook's
      // sheets all resolve to the same path and are told apart by table name.
      const localPath = conn.connectionType === 'file'
        ? (conn.fileInfo?.tablePaths?.[table.name] || conn.fileInfo?.filePath)
        : null;
      const schema = await loadTableSchema({
        connection: conn,
        tableName: table.name,
        tableSchema: table.schema,
        localPath,
        sheetName,
      });
      if (schema) setTableSchema(schema);
      return schema || null;
    } catch (error) {
      console.error('Failed to load table schema:', error);
      return null;
    }
  };

  // The shared reader (utils/tableSchemaUtils) — it describes a Pinecone record
  // the way joins and the JavaScript skill receive it (metadata fields at top
  // level, from a sample big enough to find fields only some records carry).
  // This used to keep its own copy, which took the columns from the first
  // record and left `metadata` as one opaque column.
  const loadVectorTableSchema = async (table) => {
    try {
      const schema = await loadTableSchema({
        connection: selConn,
        tableName: table.name,
        tableSchema: table.schema || '',
        localPath: selConn.localPath || selConn.fileInfo?.filePath,
      });
      if (schema && schema.columns?.length) {
        setTableSchema(schema);
        return schema;
      }
      console.warn('No data returned from vector database preview');
      return null;
    } catch (error) {
      console.error('Failed to load vector table schema:', error);
      return null;
    }
  };

  /**
   * Commit one index×namespace row: sample it for the schema, then push the
   * pair to the Data Preview. The namespace travels with the index — reading it
   * back off the index name alone would silently mean the default namespace.
   */
  const selectVectorTable = async (table) => {
    setSelectedNamespace(table.schema || '');
    setTablesLoading(true);
    const schema = await loadVectorTableSchema(table);
    setTablesLoading(false);
    pushPreview({
      tableName: table.name,
      table,
      namespace: table.schema || '',
      tableSchema: schema,
      latestWithSQL: null,
      sheetImport: null,
    });
  };

  /** Switching namespace within the already-chosen index. */
  const selectNamespace = async (namespace) => {
    setDirty(true);
    const table = dbTableObjects.find(
      (t) => t.name === selectedTableName && (t.schema || '') === (namespace || ''),
    );
    if (!table) return;
    setTableSchema(null);
    await selectVectorTable(table);
  };

  /** Picking a table loads its schema and the preview query for DataPreview. */
  const selectTable = async (tableName) => {
    setDirty(true);
    setSelectedTableName(tableName);
    setSelectedSheet('');
    setSheets([]);
    setSheetImport(null);
    setTableSchema(null);
    setLatestWithSQL(null);

    if (connKind === 'vector') {
      // Which namespace of the index: the one already chosen if this index has
      // it, otherwise the default ('') when present, otherwise the first.
      const rows = dbTableObjects.filter((t) => t.name === tableName);
      if (rows.length === 0) return;
      const table = rows.find((t) => (t.schema || '') === (selectedNamespace || ''))
        || rows.find((t) => (t.schema || '') === '')
        || rows[0];
      await selectVectorTable(table);
      return;
    }

    const table = dbTableObjects.find((t) => t.name === tableName);
    if (!table) return;

    if (connKind === 'sheets') {
      await loadSheetsFor(table);
      return;
    }

    setTablesLoading(true);
    try {
      let previewQuery;
      if (selConn.dbType === 'mongodb') {
        previewQuery = JSON.stringify({ collection: table.name, filter: {}, limit: 100 });
      } else {
        const quoted = await window.electronAPI.dbConnect.quoteIdentifier(
          selConn.dbType, table.name, table.schema, selConn.dbConfig, selConn.id,
        );
        const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
          selConn.dbType, quoted.quotedIdentifier, 100,
        );
        previewQuery = previewResult.success
          ? previewResult.previewQuery
          : `SELECT * FROM ${quoted.quotedIdentifier} LIMIT 100`;
      }

      const schema = await loadTableSchemaFromDB(table);

      const sql = {
        sql: previewQuery,
        previewSql: previewQuery,
        explanation: `Selecting all columns from ${table.schema ? `${table.schema}.${table.name}` : table.name}`,
        queryDescription: `Preview data from ${table.name}`,
      };
      setLatestWithSQL(sql);

      // One push, with the query AND the schema already in hand.
      pushPreview({ tableName, table, tableSchema: schema, latestWithSQL: sql, sheetImport: null });
    } catch (err) {
      console.error('Failed to prepare table preview:', err);
    } finally {
      setTablesLoading(false);
    }
  };

  // Take the only table on offer without asking. Guarded by a ref rather than
  // by selectTable's identity, which changes every render.
  const autoPickedRef = useRef(null);
  useEffect(() => {
    if (!onlyTable || selectedTableName) return;
    // A schema has to be settled before the table list means anything — except
    // for a vector store, where `schema` is the namespace and is chosen from
    // WITHIN the index. Waiting on it there stranded a single-index connection
    // with several namespaces: the index rendered as a read-only value that no
    // selection was ever recorded for.
    if (connKind !== 'vector' && schemaOptions.length > 0 && !selectedSchema) return;
    if (autoPickedRef.current === onlyTable.value) return;
    autoPickedRef.current = onlyTable.value;
    selectTable(onlyTable.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyTable, selectedTableName, selectedSchema, schemaOptions.length, connKind]);

  // ── Google Sheets ────────────────────────────────────────────────────────

  const loadSheetsFor = async (spreadsheet) => {
    setSheetsLoading(true);
    try {
      const columnsResult = await window.electronAPI.dbConnect.getColumns(
        selConn.dbType, selConn.dbConfig, spreadsheet.schema, spreadsheet.name, selConn.id,
      );
      setSheets(columnsResult.success && columnsResult.sheets ? columnsResult.sheets : []);
    } catch (error) {
      console.error('Failed to load sheets:', error);
      antdMessage.error('Failed to load sheets from this spreadsheet.');
      setSheets([]);
    } finally {
      setSheetsLoading(false);
    }
  };

  /**
   * Selecting a sheet imports it into a local DuckDB file and re-points the
   * connection at that file, exactly as the chat flow did.
   */
  const selectSheet = async (sheetName) => {
    setDirty(true);
    setSelectedSheet(sheetName);
    setSheetImport(null);
    if (!sheetName || !selectedTable) return;

    setSheetsLoading(true);
    try {
      const importResult = await window.electronAPI.dbConnect.importGoogleSheetToDuckDb(
        selConn.dbConfig, selConn.id, selectedTable.name, sheetName,
      );

      if (!importResult.success) {
        antdMessage.error(`Failed to import sheet: ${importResult.message}`);
        return;
      }

      const schema = await loadTableSchema({
        connection: { dbType: 'duckdb', dbConfig: {} },
        tableName: importResult.tableName,
        tableSchema: null,
        localPath: importResult.localPath,
        limit: 5,
      });
      if (schema) setTableSchema({ ...schema, sheetName });

      const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
        'duckdb', `"${importResult.tableName}"`, 100,
      );
      const previewQuery = previewResult.success
        ? previewResult.previewQuery
        : `SELECT * FROM "${importResult.tableName}" LIMIT 100`;

      const nextImport = {
        tableName: importResult.tableName,
        localPath: importResult.localPath,
        sheetName,
      };
      const sql = {
        sql: previewQuery,
        previewSql: previewQuery,
        explanation: `Selecting all columns from ${importResult.tableName}`,
        queryDescription: `Preview data from ${sheetName}`,
      };
      setSheetImport(nextImport);
      setLatestWithSQL(sql);
      pushPreview({
        sheetImport: nextImport,
        tableName: nextImport.tableName,
        tableSchema: schema ? { ...schema, sheetName } : null,
        latestWithSQL: sql,
        spreadsheetId: selectedTable.name,
      });
      antdMessage.success(`Imported ${importResult.rowCount} rows from "${sheetName}".`);
    } catch (error) {
      console.error('Failed to import Google Sheet:', error);
      antdMessage.error('Failed to import Google Sheet. Please try again.');
    } finally {
      setSheetsLoading(false);
    }
  };

  // ── Cloud storage import ─────────────────────────────────────────────────

  const handleCloudFileSelect = async (fileInfo) => {
    setCloudStorageBrowserOpen(false);

    const localConnection = {
      id: `cloud-import-${Date.now()}`,
      name: `[${cloudStorageConnection.name}] ${fileInfo.fileName}`,
      connectionType: 'file',
      dbType: fileInfo.dbType,
      fileInfo: {
        fileName: fileInfo.fileName,
        filePath: fileInfo.localPath,
        tables: fileInfo.tables,
        schemas: fileInfo.schemas,
        // A cloud file is saved to disk and read in place now, so it carries
        // everything a file added from disk does — including the sheet map a
        // workbook needs for its tables to mean different sheets.
        format: fileInfo.format || null,
        tablePaths: fileInfo.tablePaths || null,
        tableSheets: fileInfo.tableSheets || null,
        sourceFilePath: fileInfo.localPath,
      },
      cloudSource: fileInfo.cloudSource,
    };

    try {
      await connectionsDb.save(localConnection);
      await loadConnections();

      setSelConn(localConnection);
      setImportedFile({
        name: fileInfo.fileName,
        path: fileInfo.cloudSource?.objectPath || fileInfo.fileName,
      });
      setDirty(true);

      await loadTables(localConnection);

      const tableName = fileInfo.tables?.[0];
      if (tableName) {
        setSelectedTableName(tableName);

        let schema = null;
        if (fileInfo.schemas) {
          schema = Array.isArray(fileInfo.schemas)
            ? fileInfo.schemas.find((s) => s.tableName === tableName) || fileInfo.schemas[0]
            : fileInfo.schemas;
          if (schema) setTableSchema(schema);
        } else if (fileInfo.dbType !== 'lancedb') {
          schema = await loadTableSchemaFromDB({ name: tableName, schema: null }, localConnection);
        }

        let sql = null;
        if (fileInfo.dbType === 'lancedb') {
          // Vector sources have no SQL preview query.
        } else {
          const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
            fileInfo.dbType || 'sqlite', `"${tableName}"`, 100,
          );
          const previewQuery = previewResult.success
            ? previewResult.previewQuery
            : `SELECT * FROM "${tableName}" LIMIT 100`;
          sql = {
            sql: previewQuery,
            previewSql: previewQuery,
            explanation: `Selecting all columns from ${tableName}`,
            queryDescription: `Preview data from ${tableName}`,
          };
        }
        if (sql) setLatestWithSQL(sql);

        // selConn hasn't flushed yet, so build against the imported connection.
        if (onPreviewConfigUpdate) {
          onPreviewConfigUpdate(node.id, buildConfigFor(localConnection, {
            tableName,
            table: { name: tableName, schema: null },
            tableSchema: schema,
            latestWithSQL: sql,
            sheetImport: null,
          }));
        }
      }
    } catch (error) {
      console.error('Failed to save cloud import connection:', error);
      antdMessage.error('Failed to import the file. Please try again.');
    }
  };

  // ── New connection modals ────────────────────────────────────────────────

  const handleTestConnection = async (dbType, config) => {
    let result;
    if (window.electronAPI?.dbConnect) {
      result = await window.electronAPI.dbConnect.test(dbType, config);
    } else {
      const token = localStorage.getItem('auth-token');
      if (!token) {
        result = { success: false, message: 'Sign in or use the desktop app to test live database connections.' };
      } else {
        try {
          const response = await axios.post('/workflow/test-connection', { dbType, config }, {
            headers: { 'auth-token': token },
          });
          result = response.data.success
            ? { success: true, message: response.data.message || 'Connection successful!' }
            : { success: false, message: response.data.error || 'Connection failed.' };
        } catch (err) {
          result = { success: false, message: err.response?.data?.error || 'Connection failed. Check your credentials.' };
        }
      }
    }

    if (result.success) antdMessage.success(result.message || 'Connection successful!');
    else antdMessage.error(result.message || 'Connection failed.');
    return result;
  };

  const handleSaveDbConnection = async (connectionData) => {
    try {
      // Database credentials are encrypted separately from the connection row.
      if (connectionData.connectionType === 'database' && connectionData.dbConfig && window.electronAPI?.dbCredentials) {
        const { dbConfig, ...connectionDataWithoutConfig } = connectionData;

        let sensitiveFields = {};
        let nonSensitiveConfig = {};

        const plugin = installedPlugins.find((p) => p.id === connectionData.dbType);
        if (plugin?.configSchema?.fields) {
          plugin.configSchema.fields.forEach((field) => {
            const fieldValue = dbConfig[field.name];
            if (fieldValue !== undefined) {
              if (field.sensitive) sensitiveFields[field.name] = fieldValue;
              else nonSensitiveConfig[field.name] = fieldValue;
            }
          });
        } else {
          sensitiveFields = {
            password: dbConfig.password,
            username: dbConfig.username,
            host: dbConfig.host,
            uri: dbConfig.uri,
          };
          nonSensitiveConfig = {
            port: dbConfig.port,
            database: dbConfig.database,
            ssl: dbConfig.ssl,
            instanceName: dbConfig.instanceName,
            engine: dbConfig.engine,
            schema: dbConfig.schema,
          };
        }

        const saved = await connectionsDb.save({ ...connectionDataWithoutConfig, dbConfig: nonSensitiveConfig });
        await window.electronAPI.dbCredentials.save(saved.id, sensitiveFields);
        antdMessage.success('Connection saved securely.');
      } else {
        await connectionsDb.save(connectionData);
        antdMessage.success('Connection saved.');
      }
      setActiveDbType(null);
      await loadConnections();
    } catch (error) {
      console.error('Error saving connection:', error);
      antdMessage.error('Failed to save connection.');
    }
  };

  const getModalTitle = (dbType) => {
    const titleMap = {
      sqlite: 'Connect SQLite Database',
      lancedb: 'Connect LanceDB Database',
      json: 'Upload JSON File',
      spreadsheet: 'Add Spreadsheet',
      parquet: 'Upload Parquet File',
      avro: 'Upload Avro File',
    };
    if (titleMap[dbType]) return titleMap[dbType];
    const plugin = installedPlugins.find((p) => p.id === dbType);
    if (plugin) return `Connect to ${plugin.metadata?.displayName || plugin.name}`;
    return 'Connect to Database';
  };

  const ActiveForm = useMemo(() => {
    if (!activeDbType) return null;
    // Same set the connector picker offers under "Local Files" — leaving
    // lancedb out here meant choosing it opened no form at all.
    if (['sqlite', 'lancedb', 'json', 'spreadsheet', 'parquet', 'avro'].includes(activeDbType)) {
      return () => (
        <LocalFileConnectionForm
          fileType={activeDbType}
          onSave={handleSaveDbConnection}
          onCancel={() => setActiveDbType(null)}
          editingConnection={null}
        />
      );
    }
    const plugin = installedPlugins.find((p) => p.id === activeDbType);
    if (plugin) {
      return () => (
        <DynamicConnectionForm
          plugin={plugin}
          onSave={handleSaveDbConnection}
          onCancel={() => setActiveDbType(null)}
          onTest={handleTestConnection}
          editingConnection={null}
        />
      );
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDbType, installedPlugins]);

  // ── Validation ───────────────────────────────────────────────────────────

  const missing = useMemo(() => {
    const out = {};
    if (!selConn) { out.connection = true; return out; }
    if (connKind === 'sql' || connKind === 'nosql' || connKind === 'vector') {
      if (schemaOptions.length > 0 && !selectedSchema && connKind === 'sql') out.schema = true;
      if (!selectedTableName) out.table = true;
      // A table-backed source has to carry its columns: downstream nodes name
      // their input from it and the join/transform builders list it. The read
      // only comes back empty on an error (an empty table still has columns),
      // so this blocks a save that raced the read or followed a failed one —
      // never a valid table. REST API and cloud sources have no schema until
      // they are fetched, so they are not asked for one — nor is a file just
      // imported from cloud storage, whose import step reads (or, for a LanceDB
      // folder, deliberately skips) the schema itself.
      else if (!tableSchema && !importedFile) out.tableSchema = true;
    } else if (connKind === 'sheets') {
      // A restored import is already complete, even if the spreadsheet list
      // hasn't been re-fetched yet.
      if (!sheetImport) {
        if (!selectedTableName) out.table = true;
        else if (!selectedSheet) out.sheet = true;
      }
    } else if (connKind === 'cloud') {
      out.cloudFile = true; // A cloud connection is replaced by its import.
    }
    return out;
  }, [selConn, connKind, schemaOptions, selectedSchema, selectedTableName, selectedSheet, sheetImport, tableSchema, importedFile]);

  const missingCount = Object.keys(missing).length;
  const invalid = (key) => attempted && !!missing[key];

  // The columns are read after the table is picked, and a slow engine (BigQuery
  // takes a second or two) left a window where Save stored the source without
  // them. Named on its own because it is not a field the user can fill in.
  const schemaPending = !!missing.tableSchema && tablesLoading;
  const gateMessage = missing.cloudFile
    ? 'Pick a file to enable Save'
    : missing.tableSchema && !tablesLoading && missingCount === 1
      ? "Couldn't read this table's columns — pick the table again to retry."
      : attempted && missingCount > 0
      ? `${missingCount} field${missingCount === 1 ? '' : 's'} still needed`
      : null;

  // ── Build config ─────────────────────────────────────────────────────────

  // Every source* key this node can emit, reset to null. onPreviewConfigUpdate
  // MERGES into the node's existing config, so a key we simply omit keeps its
  // previous value — which is how a Postgres "SELECT * FROM …" survived a
  // switch to MongoDB and came back as "Unexpected token 'S'". Always emit the
  // whole set so switching connections genuinely clears the old one.
  const BLANK_SOURCE = {
    sourceDbType: null,
    sourceDbCategory: null,
    sourceDbConfig: null,
    sourceLocalPath: null,
    // The file DuckDB reads, and how to read it. For a local source these are
    // the whole story — there is no imported copy behind them.
    sourceFilePath: null,
    sourceFormat: null,
    sourceDataset: null,
    sourceTableName: null,
    sourceCollection: null,
    sourceIndexName: null,
    sourceNamespace: null,
    sourceSchema: null,
    sourceTable: null,
    sourceSelectedTables: [],
    sourceTableSchema: null,
    sourceSql: null,
    sourcePreviewSql: null,
    sourceSqlExplanation: '',
    sourceQueryDescription: '',
    sourceSpreadsheetId: null,
    sourceSheetName: null,
    sourceApiConnectionId: null,
    sourceApiConnectionName: null,
    apiFetchPrompt: null,
    apiFetchExplanation: '',
    apiEndpoint: '',
    apiFetchCode: '',
    cloudSource: null,
  };

  /**
   * `override` lets a caller build the config from a selection that state
   * hasn't flushed yet (selectTable pushes the preview before its setState
   * calls land); `connection` does the same for selConn itself.
   */
  const buildConfigFor = (connection, override = {}) => {
    const selConnLocal = connection;
    if (!selConnLocal) return {};

    const sel = {
      tableName: sheetImport ? sheetImport.tableName : selectedTableName,
      table: selectedTable,
      schema: selectedSchema,
      namespace: selectedNamespace,
      tableSchema,
      latestWithSQL,
      sheetImport,
      spreadsheetId: selectedTableName,
      ...override,
    };

    // A Google Sheet is imported into a local DuckDB file; downstream nodes
    // read that file, not the Sheets API. Keep the connection's id/name so the
    // source is still recognisable, and swap in the local file everywhere else.
    const conn = sel.sheetImport
      ? {
        ...selConnLocal,
        connectionType: 'file',
        fileType: 'duckdb',
        dbType: 'duckdb',
        dbConfig: {},
        fileInfo: {
          filePath: sel.sheetImport.localPath,
          fileName: 'google-sheets.duckdb',
          dbType: 'duckdb',
          tables: [sel.sheetImport.tableName],
          source: 'google-sheets',
          originalSpreadsheetId: sel.spreadsheetId,
          originalSheetName: sel.sheetImport.sheetName,
        },
      }
      : selConnLocal;

    // For a Sheets source the picked "table" is the spreadsheet — the dataset
    // downstream is the DuckDB table it was imported into.
    const tableName = sel.tableName;
    const tableSchemaVal = sel.tableSchema;
    const sqlVal = sel.latestWithSQL;

    const config = {
      ...BLANK_SOURCE,
      nodeType: 'datasource',
      sourceConnectionId: conn.id,
      sourceConnectionName: conn.name,
      sourceConnectionType: conn.connectionType || 'file',
      sourceType: conn.fileType || conn.apiType || conn.dbType,
    };

    if (sel.sheetImport) {
      config.sourceSpreadsheetId = sel.spreadsheetId;
      config.sourceSheetName = sel.sheetImport.sheetName;
    }

    // REST API sources materialise into local DuckDB and behave like any other
    // NoSQL local source downstream. The fetch function itself is authored in
    // the chat (build_dataSource) — preserve it if it is already there.
    if (conn.dbType === 'rest-api') {
      // Only carry the previous fetch forward when this is the SAME API
      // connection being re-saved. Otherwise a node that used to point at a
      // local file (or a different API) kept that file's sourceLocalPath,
      // and the preview then tried to read a collection this node never wrote —
      // surfacing as "97% of the data file is corrupt".
      const sameApi = !!initialConfig?.sourceApiConnectionId
        && initialConfig.sourceApiConnectionId === conn.id;

      // The node label is not unique (every dragged source is "Data Source"),
      // so fold in the node id to keep two API nodes off the same file.
      const collection = (sameApi && initialConfig?.sourceCollection)
        || sanitizeCollectionName(
          `${node?.data?.label || 'api'}_${String(node?.id || '').slice(-6)}`,
          node?.id,
        );

      Object.assign(config, {
        sourceConnectionType: 'api',
        // Fetched rows are materialised as a local Parquet file, so downstream
        // nodes treat an API source like any other local file.
        sourceDbType: 'duckdb',
        sourceDbCategory: 'API',
        sourceApiConnectionId: conn.id,
        sourceApiConnectionName: conn.name,
        sourceConnectionId: 'local-duckdb',
        sourceCollection: collection,
        sourceDataset: collection,
        sourceLocalPath: sameApi ? (initialConfig.sourceLocalPath || null) : null,
        apiFetchPrompt: sameApi ? (initialConfig.apiFetchPrompt || null) : null,
        apiFetchExplanation: sameApi ? (initialConfig.apiFetchExplanation || '') : '',
        apiEndpoint: sameApi ? (initialConfig.apiEndpoint || '') : '',
        apiFetchCode: sameApi ? (initialConfig.apiFetchCode || '') : '',
        apiConnectionPublicConfig: {
          baseUrl: conn.dbConfig?.baseUrl || '',
          authType: conn.dbConfig?.authType || 'none',
          apiKeyName: conn.dbConfig?.apiKeyName || '',
          basicUser: conn.dbConfig?.basicUser || '',
          // Key names only. Values live encrypted on the connection and are
          // resolved in the main process at fetch time.
          apiParamKeys: conn.dbConfig?.apiParamKeys || [],
        },
      });
      if (sameApi && initialConfig?.sourceTableSchema) {
        config.sourceTableSchema = initialConfig.sourceTableSchema;
      }
      return config;
    }

    if (conn.connectionType === 'file') {
      config.sourceDataset = conn.name;
      if (conn.fileInfo?.filePath) config.sourceLocalPath = conn.fileInfo.filePath;
      if (conn.cloudSource) config.cloudSource = conn.cloudSource;

      if (['duckdb', 'sqlite', 'lancedb'].includes(conn.dbType)) {
        config.sourceDbType = conn.dbType;
        config.sourceDbCategory = conn.dbCategory || (conn.dbType === 'lancedb' ? 'Vector' : null);

        // A DuckDB source is a file: the path is the address, and the table
        // name is the label the user sees — except for a workbook, whose sheets
        // share one path and are addressed by that name.
        if (conn.dbType === 'duckdb') {
          const selected = tableName || conn.fileInfo?.tables?.[0] || null;
          const filePath = (selected && conn.fileInfo?.tablePaths?.[selected]) || conn.fileInfo?.filePath || null;
          config.sourceFilePath = filePath;
          config.sourceLocalPath = filePath;
          config.sourceFormat = conn.fileInfo?.format || null;
          if (selected) config.sourceTableName = selected;
        }
        if (conn.dbType === 'sqlite' && tableName) config.sourceTableName = tableName;
        if (conn.dbType === 'lancedb' && tableName) {
          config.sourceIndexName = tableName;
          config.sourceTableName = tableName;
          config.sourceNamespace = '';
        }
        if (tableSchemaVal) config.sourceTableSchema = tableSchemaVal;
      }

      if ((conn.dbType === 'sqlite' || conn.dbType === 'duckdb') && sqlVal) {
        config.sourceSql = sqlVal.sql;
        config.sourcePreviewSql = sqlVal.previewSql;
        config.sourceSqlExplanation = sqlVal.explanation || '';
      }
    } else if (conn.connectionType !== 'database') {
      config.sourceDataset = conn.name;
    }

    if (conn.connectionType === 'database') {
      config.sourceDbType = conn.dbType;
      config.sourceDbCategory = conn.dbCategory;
      config.sourceDbConfig = conn.dbConfig;
      config.sourceSelectedTables = tableName ? [tableName] : [];
      if (tableName) config.sourceTable = tableName;

      const isNoSQL = conn.dbType === 'mongodb';
      const isVector = conn.dbCategory === 'Vector' || conn.dbType === 'pinecone' || conn.dbType === 'lancedb';

      if (isVector && tableName) {
        if (conn.dbType === 'pinecone') {
          if (tableName.includes('/')) {
            const parts = tableName.split('/');
            config.sourceIndexName = parts[0];
            config.sourceNamespace = parts.slice(1).join('/');
          } else {
            config.sourceIndexName = tableName;
            // The namespace the user picked wins over the row's own schema: the
            // two agree except while a namespace switch is still settling, when
            // `sel.namespace` is the newer of the two.
            config.sourceNamespace = sel.namespace ?? sel.table?.schema ?? '';
          }
          config.sourceTableName = config.sourceIndexName;
          config.sourceSchema = config.sourceNamespace;
        } else {
          config.sourceIndexName = tableName;
          config.sourceTableName = tableName;
          config.sourceNamespace = '';
        }
      } else if (isNoSQL) {
        config.sourceCollection = tableName || null;
      } else {
        config.sourceTableName = tableName || null;
        config.sourceSchema = sel.table?.schema || sel.schema || conn.dbConfig?.schema || null;
      }

      if (sqlVal) {
        config.sourceSql = sqlVal.sql;
        config.sourcePreviewSql = sqlVal.previewSql;
        config.sourceSqlExplanation = sqlVal.explanation || '';
        config.sourceQueryDescription = sqlVal.queryDescription || '';
      }
      if (tableSchemaVal) config.sourceTableSchema = tableSchemaVal;
    }

    return config;
  };

  const buildConfig = (override = {}) => buildConfigFor(selConn, override);

  /**
   * Push the current selection to the Data Preview. Called once per COMPLETED
   * selection, never mid-flight: an earlier version fired on every state change,
   * so picking a table pushed one config with a table but no query and another
   * with both. The premature one raced the previous connection's still-open
   * query ("connection is in closed state") and left the preview refetching
   * twice per click.
   */
  const pushPreview = (override = {}) => {
    if (!onPreviewConfigUpdate || !selConn) return;
    onPreviewConfigUpdate(node.id, buildConfig(override));
  };

  /**
   * Backfill `sourceSql` / `sourcePreviewSql` for a DATABASE source that has a
   * table selected but no query.
   *
   * Picking a table normally produces both, along with the schema — selectTable
   * builds them together and commits them in one push. When that step does not
   * complete (the picked name not matching the loaded table list, an IPC call
   * rejecting), the SELECTION still stands: `sourceTableName`,
   * `sourceSelectedTables` and `sourceSchema` are read straight off the
   * selection state, so buildConfigFor happily saved a node that looks
   * configured and carries no query at all.
   *
   * That is only survivable for a FILE source, which the Data Preview can read
   * by table name (readLocalCollection takes one). A remote database has no such
   * fallback — DataPreview requires SQL to send — so the preview failed with
   * "No SQL query found in node configuration", and every downstream node
   * inherited the null through copySourceFromUpstream.
   *
   * Derived here, at save, rather than by making buildConfigFor async: it is
   * also called synchronously by pushPreview on every selection change.
   */
  const withDerivedSourceSql = async (config) => {
    if (!config || config.sourceConnectionType !== 'database') return config;
    if (config.sourcePreviewSql) return config;
    // A vector index is not read with SQL — the preview goes through the vector
    // skill — so there is nothing to derive.
    if (config.sourceIndexName) return config;
    const table = config.sourceTableName || config.sourceCollection;
    if (!table) return config;

    const qualified = config.sourceSchema ? `${config.sourceSchema}.${table}` : table;
    try {
      if (config.sourceDbType === 'mongodb') {
        // Same envelope selectTable writes, and what DataPreview JSON.parses.
        const query = JSON.stringify({ collection: table, filter: {}, limit: 100 });
        return {
          ...config,
          sourceSql: query,
          sourcePreviewSql: query,
          sourceSqlExplanation: config.sourceSqlExplanation || `Selecting all documents from ${table}`,
        };
      }
      if (!window.electronAPI?.dbConnect?.quoteIdentifier) return config;
      // The connector quotes and qualifies — a BigQuery table needs its dataset,
      // and a name containing a dot must not be split by hand.
      const quoted = await window.electronAPI.dbConnect.quoteIdentifier(
        config.sourceDbType, table, config.sourceSchema, config.sourceDbConfig, config.sourceConnectionId,
      );
      const identifier = quoted?.quotedIdentifier || table;
      const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
        config.sourceDbType, identifier, 100,
      );
      const query = previewResult?.success
        ? previewResult.previewQuery
        : `SELECT * FROM ${identifier} LIMIT 100`;
      return {
        ...config,
        sourceSql: query,
        sourcePreviewSql: query,
        sourceSqlExplanation: config.sourceSqlExplanation || `Selecting all columns from ${qualified}`,
      };
    } catch (err) {
      // Saving without a query is still better than losing the selection — the
      // preview says so plainly, and this is logged rather than swallowed.
      console.error('Could not derive preview SQL for the selected table:', err);
      return config;
    }
  };

  const handleSave = async () => {
    setAttempted(true);
    if (missingCount > 0) return;
    if (hasSaved && !dirty) return;

    onSave(await withDerivedSourceSql(buildConfig()), []);
    setDirty(false);
    setHasSaved(true);
    setAttempted(false);

    // A REST API source has no form fields left to fill — the request is
    // described in the chat, which opens with this node in focus.
    if (connKind === 'api') onRequestChatHandoff?.(node.id);
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const datasetBusy = tablesLoading || sheetsLoading;

  // Which file a local source actually reads, and the format it was added as.
  // The table names below are generated from the file, so without this the
  // form never names the file itself.
  const fileSummary = useMemo(() => {
    const fileType = fileTypeOf(selConn);
    if (!fileType) return null;
    const label = `${FILE_TYPE_LABEL[fileType] || fileType} file`;
    const name = fileNameOf(selConn);
    return <Picked>{name ? <><code>{name}</code> — {label}</> : label}</Picked>;
  }, [selConn]);

  return (
    <FormScope>
      <FormBody>
        <Card label="Connection">
          {loading ? (
            <EmptyState>Loading connections…</EmptyState>
          ) : (
            <>
              <SearchBox value={search} onChange={setSearch} />
              {filteredConnections.length === 0 ? (
                <EmptyState>
                  {connections.length === 0
                    ? 'No saved connections yet.'
                    : 'No connection matches that search.'}
                </EmptyState>
              ) : (
                <ConnList grouped>
                  {groupedConnections.map(([group, conns]) => {
                    const open = searching || !!openGroups[group];
                    return (
                      <React.Fragment key={group}>
                        <ConnGroupToggle
                          label={group}
                          color={GROUP_COLOR[group]}
                          count={conns.length}
                          open={open}
                          onToggle={() => toggleGroup(group)}
                        />
                        {open && conns.map((conn) => (
                          <ConnRow
                            key={conn.id}
                            icon={getConnectionIcon(conn)}
                            name={conn.name}
                            meta={connMeta(conn)}
                            selected={conn.id === selConn?.id}
                            onClick={() => selectConnection(conn)}
                          />
                        ))}
                      </React.Fragment>
                    );
                  })}
                </ConnList>
              )}
              <NewConnButton onClick={() => setIsConnectionTypeSelectorOpen(true)} />
            </>
          )}
        </Card>

        {/* SQL → schema + table */}
        {connKind === 'sql' && (
          <Card label="Dataset">
            {fileSummary}
            {datasetBusy && dbTableObjects.length === 0 ? (
              <EmptyState>Loading tables…</EmptyState>
            ) : dbTableObjects.length === 0 ? (
              <DatasetEmpty error={tablesError} noun="tables" />
            ) : (
              <Fields>
                {schemaOptions.length > 0 && (
                  <Field label="Schema" required invalid={invalid('schema')}>
                    {onlySchema ? (
                      <StaticValue>{onlySchema}</StaticValue>
                    ) : (
                      <SearchSelect
                        value={selectedSchema}
                        placeholder="Select a schema…"
                        searchPlaceholder="Filter schemas…"
                        options={schemaOptions.map((s) => ({ label: s, value: s }))}
                        onChange={(v) => { setDirty(true); setSelectedSchema(v); setSelectedTableName(''); }}
                      />
                    )}
                  </Field>
                )}
                <Field
                  label="Table"
                  required
                  invalid={invalid('table')}
                  hint={tablesError
                    ? `Could not list tables: ${tablesError} — showing the saved table only.`
                    : onlyTable
                      ? 'The only table in this source.'
                      : schemaOptions.length > 0 ? 'Loaded from the connection once a schema is chosen.' : null}
                >
                  {onlyTable ? (
                    <StaticValue>{onlyTable.label}</StaticValue>
                  ) : (
                    <SearchSelect
                      value={selectedTableName}
                      placeholder="Select a table…"
                      searchPlaceholder="Filter tables…"
                      options={tableOptions}
                      disabled={schemaOptions.length > 0 && !selectedSchema}
                      onChange={selectTable}
                    />
                  )}
                </Field>
              </Fields>
            )}
          </Card>
        )}

        {/* NoSQL → collection */}
        {connKind === 'nosql' && (
          <Card label="Dataset">
            {fileSummary}
            {datasetBusy && dbTableObjects.length === 0 ? (
              <EmptyState>Loading collections…</EmptyState>
            ) : dbTableObjects.length === 0 ? (
              <DatasetEmpty error={tablesError} noun="collections" />
            ) : (
              <Fields>
                <Field
                  label="Collection"
                  required
                  invalid={invalid('table')}
                  hint={onlyTable ? 'The only collection in this source.' : null}
                >
                  {onlyTable ? (
                    <StaticValue>{onlyTable.label}</StaticValue>
                  ) : (
                    <SearchSelect
                      value={selectedTableName}
                      placeholder="Select a collection…"
                      searchPlaceholder="Filter collections…"
                      options={tableOptions}
                      onChange={selectTable}
                    />
                  )}
                </Field>
              </Fields>
            )}
          </Card>
        )}

        {/* Vector → index */}
        {connKind === 'vector' && (
          <Card label="Dataset">
            {fileSummary}
            {datasetBusy && dbTableObjects.length === 0 ? (
              <EmptyState>Loading indexes…</EmptyState>
            ) : dbTableObjects.length === 0 ? (
              <DatasetEmpty error={tablesError} noun="indexes" />
            ) : (
              <Fields>
                <Field
                  label="Index"
                  required
                  invalid={invalid('table')}
                  hint={onlyTable ? 'The only index in this source.' : null}
                >
                  {onlyTable ? (
                    <StaticValue>{onlyTable.label}</StaticValue>
                  ) : (
                    <SearchSelect
                      value={selectedTableName}
                      placeholder="Select an index…"
                      searchPlaceholder="Filter indexes…"
                      options={tableOptions}
                      onChange={selectTable}
                    />
                  )}
                </Field>
                {selectedTableName && namespaceOptions.length > 1 && (
                  <Field
                    label="Namespace"
                    required
                    hint="Vectors live in one namespace; the rest of the index is invisible to this source."
                  >
                    <SearchSelect
                      value={selectedNamespace}
                      placeholder="Select a namespace…"
                      searchPlaceholder="Filter namespaces…"
                      options={namespaceOptions}
                      onChange={selectNamespace}
                    />
                  </Field>
                )}
              </Fields>
            )}
          </Card>
        )}

        {/* Google Sheets → spreadsheet + sheet */}
        {connKind === 'sheets' && (
          <Card label="Dataset">
            {datasetBusy && dbTableObjects.length === 0 ? (
              <EmptyState>Loading spreadsheets…</EmptyState>
            ) : (
              <Fields>
                <Field label="Spreadsheet" required invalid={invalid('table')}>
                  <SearchSelect
                    value={selectedTableName}
                    placeholder="Select a spreadsheet…"
                    searchPlaceholder="Filter spreadsheets…"
                    options={tableOptions}
                    onChange={selectTable}
                  />
                </Field>
                {(selectedTableName || sheetImport) && (
                  <Field
                    label="Sheet"
                    required
                    invalid={invalid('sheet')}
                    hint="The chosen sheet is imported to a local table."
                  >
                    <SearchSelect
                      value={selectedSheet}
                      placeholder={sheetsLoading ? 'Loading sheets…' : 'Select a sheet…'}
                      searchPlaceholder="Filter sheets…"
                      options={sheetOptions.length > 0
                        ? sheetOptions
                        // On reopen the tab list hasn't been re-fetched; keep
                        // the saved sheet selectable so it still renders.
                        : selectedSheet ? [{ label: selectedSheet, value: selectedSheet }] : []}
                      disabled={sheetsLoading || (sheetOptions.length === 0 && !selectedSheet)}
                      onChange={selectSheet}
                    />
                  </Field>
                )}
                {sheetImport && (
                  <Picked>Imported into <code>{sheetImport.tableName}</code></Picked>
                )}
              </Fields>
            )}
          </Card>
        )}

        {/* API → save, then the chat opens with this node in focus */}
        {connKind === 'api' && (
          <Card label="API request">
            <Handoff color={FORM_ACCENT.transform} icon={<IconChat />} title="Continues in chat after you save">
              <HandoffBody>
                {selConn?.dbConfig?.baseUrl ? (
                  <>Base URL: <code>{selConn.dbConfig.baseUrl}</code><br /></>
                ) : null}
                Auth is stored on the connection. <strong>Press Save and the chat opens with this
                node in focus</strong>, where you describe the request — endpoint, method, filtering.
                You can come back and modify the request at any time.
              </HandoffBody>
              {initialConfig?.apiFetchCode ? (
                <Picked>
                  Fetch function ready{initialConfig.sourceCollection
                    ? <> — cached into <code>{initialConfig.sourceCollection}</code></>
                    : null}
                </Picked>
              ) : null}
            </Handoff>
          </Card>
        )}

        {/* Cloud storage → picker; save stays disabled until a file is chosen */}
        {connKind === 'cloud' && (
          <Card label="Cloud file">
            <Handoff
              color={FORM_ACCENT.source}
              icon={<IconFolder color={FORM_ACCENT.source} size={14} />}
              title="Pick a file to import"
            >
              <HandoffBody>
                Browse the connected storage and choose a CSV, Excel, JSON or Parquet file. It is
                imported to a local table, and the table + schema are filled in for you. Save stays
                disabled until a file is picked.
              </HandoffBody>
              <CloudButton onClick={() => { setCloudStorageConnection(selConn); setCloudStorageBrowserOpen(true); }}>
                Open storage browser
              </CloudButton>
            </Handoff>
          </Card>
        )}

        {/* An imported cloud file, or a file source with nothing left to pick */}
        {importedFile && connKind !== 'cloud' && (
          <Card label="Cloud file">
            <Picked>Imported <code>{importedFile.path}</code></Picked>
            <CloudButton onClick={() => {
              setCloudStorageConnection(cloudStorageConnection);
              setCloudStorageBrowserOpen(true);
            }}>
              Change file
            </CloudButton>
          </Card>
        )}

        {connKind === 'ready' && !importedFile && (
          <Card label="Dataset">
            {fileSummary}
            <Note>
              <strong>{selConn?.name}</strong> is already imported — there is nothing else to pick.
            </Note>
          </Card>
        )}
      </FormBody>

      <FormFooter
        error={gateMessage}
        onCancel={onCancel}
        onSave={handleSave}
        // Nothing edited, nothing to save — the button stays disabled until
        // something changes, rather than sitting active the moment the node is
        // opened. The first edit makes it live.
        saveDisabled={!!missing.cloudFile || schemaPending || !dirty}
        saveDisabledReason={missing.cloudFile
          ? 'Open the storage browser and pick a file to import first.'
          : schemaPending
            ? "Reading the table's columns…"
            : 'Nothing has changed yet.'}
      />

      {/* Cloud Storage Browser */}
      {cloudStorageBrowserOpen && cloudStorageConnection && (
        cloudStorageConnection.dbType === 'google-sheets' ? (
          // Google's own Picker, not the generic browser: listing a person's
          // spreadsheets in-app needs a RESTRICTED Drive scope, while a file
          // picked in Google's dialog is reachable under plain `drive.file`.
          <GoogleSheetsPicker
            connection={cloudStorageConnection}
            mode="import"
            onFileSelect={handleCloudFileSelect}
            onClose={() => setCloudStorageBrowserOpen(false)}
          />
        ) : cloudStorageConnection.dbType === 'google-drive' && cloudStorageConnection.dbConfig?.accessToken ? (
          <GoogleDrivePicker
            connection={cloudStorageConnection}
            onFileSelect={handleCloudFileSelect}
            onClose={() => setCloudStorageBrowserOpen(false)}
          />
        ) : pluginManager ? (
          <CloudStorageBrowser
            open={cloudStorageBrowserOpen}
            onClose={() => setCloudStorageBrowserOpen(false)}
            connection={cloudStorageConnection}
            onFileSelect={handleCloudFileSelect}
            pluginManager={pluginManager}
          />
        ) : null
      )}

      {/* New connection */}
      <ConnectionTypeSelector
        open={isConnectionTypeSelectorOpen}
        onClose={() => { setIsConnectionTypeSelectorOpen(false); loadConnections(); }}
        onSelectType={(type) => { setIsConnectionTypeSelectorOpen(false); setActiveDbType(type); }}
      />

      {ActiveForm && (
        <Modal
          title={getModalTitle(activeDbType)}
          open={Boolean(activeDbType)}
          onCancel={() => {
            if (window.electronAPI?.oauth?.cancelServer) window.electronAPI.oauth.cancelServer(3000);
            setActiveDbType(null);
          }}
          footer={null}
          width={640}
          destroyOnClose
        >
          <ActiveForm />
        </Modal>
      )}
    </FormScope>
  );
};

export default DataSourceNodeChat;
