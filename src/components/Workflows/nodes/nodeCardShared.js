import React, { useState, useEffect } from 'react';
import { CodeOutlined, DatabaseOutlined, FolderOutlined } from '@ant-design/icons';
import { connectionsDb } from '../../../utils/localDb';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as BigQueryIcon } from '../../ConnectorImages/BigQuery.svg';
import { ReactComponent as SnowflakeIcon } from '../../ConnectorImages/Snowflake.svg';
import { ReactComponent as SlackIcon } from '../../ConnectorImages/Slack.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';

const MONO = "'JetBrains Mono', monospace";
const MUTED = '#5a6678';
const DIM = '#9ca3af';
const BORDER = '#e2e6eb';
const SURFACE = '#f7f8fa';

/**
 * What each kind of node is COLOURED, canvas-wide.
 *
 * One hue per node type, and this is where it is decided. The card wears it as
 * its left edge, its icon and its title; anything else that stands for a node —
 * the chat's build plan, its node chips — reads from here too, so a step in a
 * plan is the same colour as the card it will become. They drifted once
 * already, which is how the build plan ended up teal/navy/green against a
 * canvas of blue/cyan/pink.
 *
 * Tints follow the cards' convention of appending an alpha suffix to the hex:
 * `1a` for a wash you can put text on, `44` for a visible edge.
 */
export const NODE_COLORS = {
  start:       '#2563eb',
  dataSource:  '#0891b2',
  transformer: '#7c3aed',
  join:        '#d97706',
  output:      '#db2777',
};

// ── Join input handles ──────────────────────────────────────────────────────
//
// Every other node card has ONE input dot, so ReactFlow can route an edge to it
// without being told which one it means. A join has several, and an edge that
// doesn't name its handle falls back to the FIRST one the card renders (see
// getHandle in @reactflow/core) — which is why every edge the AI builder
// derived stacked on the top-left dot and crossed the card to get there, while
// the dot below it stayed empty.
//
// So the ids are defined here, in one place: the card draws them, and whoever
// builds an edge into a join names the one it lands on.

/** The handle id for a join's nth input (0-based). */
export const joinInputHandleId = (index) => `input${index + 1}`;

/** The input index a handle id stands for, or -1 when it isn't one of ours. */
export const joinInputIndex = (handleId) => {
  const m = /^input(\d+)$/.exec(String(handleId || ''));
  return m ? Number(m[1]) - 1 : -1;
};

/**
 * How many input dots a join card draws: two by default (a join needs at least
 * two sources to mean anything), plus room for every edge that actually lands
 * on it — a handle an edge names but the card never renders would drop that
 * edge from the canvas entirely.
 */
export const joinInputHandleCount = (edges, nodeId) => {
  let incoming = 0;
  let highest = -1;
  for (const e of edges || []) {
    if (!e || e.target !== nodeId) continue;
    incoming += 1;
    const idx = joinInputIndex(e.targetHandle);
    if (idx > highest) highest = idx;
  }
  return Math.max(2, incoming, highest + 1);
};

/**
 * Name the input dot for every edge into a join that doesn't already name one.
 *
 * Edges reach the canvas from three places — the AI builder, the live build
 * preview, and workflows saved before any of them recorded a handle — and only
 * a hand-drawn connection carries one already. Filling the gap at render time
 * covers all of them, and an edge that DOES name a handle keeps it: the free
 * slots are handed out around the ones already taken.
 *
 * Returns the same array when nothing needed filling, so it is safe to call on
 * every render.
 */
export const withJoinInputHandles = (edges, nodes) => {
  const joinIds = new Set();
  for (const n of nodes || []) if (n?.type === 'join' && n.id) joinIds.add(n.id);
  if (joinIds.size === 0) return edges;

  const taken = new Map(); // join node id → indices already claimed
  for (const e of edges || []) {
    if (!e || !joinIds.has(e.target)) continue;
    const idx = joinInputIndex(e.targetHandle);
    if (idx < 0) continue;
    if (!taken.has(e.target)) taken.set(e.target, new Set());
    taken.get(e.target).add(idx);
  }

  let changed = false;
  const out = (edges || []).map((e) => {
    if (!e || e.targetHandle || !joinIds.has(e.target)) return e;
    if (!taken.has(e.target)) taken.set(e.target, new Set());
    const used = taken.get(e.target);
    let idx = 0;
    while (used.has(idx)) idx += 1;
    used.add(idx);
    changed = true;
    return { ...e, targetHandle: joinInputHandleId(idx) };
  });
  return changed ? out : edges;
};

// Fields on a chat bot message's `metadata` object that may contain a code
// string we want to surface on the node card. Order is "primary code first,
// supporting code after" since the first field present drives the default
// label shown collapsed.
const CODE_FIELDS = [
  { key: 'sql',                label: 'SQL',          lang: 'sql' },
  { key: 'joinSql',            label: 'JOIN SQL',     lang: 'sql' },
  { key: 'insertSql',          label: 'INSERT',       lang: 'sql' },
  { key: 'ddl',                label: 'DDL',          lang: 'sql' },
  { key: 'previewSql',         label: 'PREVIEW',      lang: 'sql' },
  { key: 'apiFetchCode',       label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'javascriptFunction', label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'transformFunction',  label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'validationFunction', label: 'JAVASCRIPT',   lang: 'javascript' },
  { key: 'pythonCode',         label: 'PYTHON',       lang: 'python' },
  { key: 'nosqlOperation',     label: 'NOSQL',        lang: 'json' },
];

/**
 * Walk the chat backwards and return the codes carried by the most recent
 * bot message that has any. We stop at the first matching message so the
 * card reflects the *latest* state of the configuration, not stale earlier
 * drafts the user may have refined past.
 */
export const extractLatestCodes = (chat) => {
  if (!Array.isArray(chat) || chat.length === 0) return [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.sender !== 'bot' || !m.metadata) continue;
    const found = [];
    for (const f of CODE_FIELDS) {
      const raw = m.metadata[f.key];
      if (raw == null) continue;
      const str = typeof raw === 'string' ? raw : safeStringify(raw);
      if (!str || !str.trim()) continue;
      found.push({ type: f.label, lang: f.lang, content: str });
    }
    if (found.length > 0) return found;
  }
  return [];
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
};

// ── Node summaries ──────────────────────────────────────────────────────────
// The second line of a card answers "what does this node do?", and the only
// honest source for that is the node's own config — the same fields the Data
// Preview names in its header and Details tab. Cards used to fall back to the
// last message in the chat, which records what the user ASKED rather than what
// the node ended up configured to do, and goes stale the moment the config is
// changed from the form.

const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** "schema.table", or the bare table when the source has no schema. */
const qualified = (schema, name) => (nonEmpty(schema) ? `${schema}.${name}` : name);

/** The dataset a node reads. Same precedence as the Data Preview header. */
export const sourceDatasetOf = (config = {}, { withSchema = true } = {}) => {
  if (nonEmpty(config.sourceCollection)) return config.sourceCollection;
  if (nonEmpty(config.sourceTableName)) {
    // The schema is dropped where the name has to stay short — a node title on
    // a 264px card. Everywhere else it is part of what the dataset IS.
    return withSchema ? qualified(config.sourceSchema, config.sourceTableName) : config.sourceTableName;
  }
  if (nonEmpty(config.sourceIndexName)) return config.sourceIndexName;
  if (nonEmpty(config.table)) return config.table;
  if (nonEmpty(config.sourceDataset)) return config.sourceDataset;
  if (nonEmpty(config.dataset)) return config.dataset;
  return '';
};

/** The dataset a node writes. */
export const targetDatasetOf = (config = {}) => {
  if (nonEmpty(config.targetCollection)) return config.targetCollection;
  if (nonEmpty(config.targetTableName)) return qualified(config.targetSchema, config.targetTableName);
  return '';
};

// ── Destination footer ──────────────────────────────────────────────────────
//
// Where a node's result LANDS, shown along the bottom of its card: the store's
// logo, the connection it belongs to, and the table written there. A canvas of
// transformers and joins otherwise says what each step does but never where the
// data goes, which is the question being asked when someone traces a pipeline.

/**
 * Connector logo by dbType.
 *
 * Shared with DataSourceNode, which reads the same map for a source's badge —
 * two copies drifted once already (Snowflake and BigQuery had SVGs sitting
 * unused because only one map was ever updated).
 */
export const CONNECTOR_ICONS = {
  postgres: PostgresIcon,
  // Redshift disabled for now — see connections/connectorCatalog.js.
  // redshift: PostgresIcon,   // Redshift is Postgres-derived and ships no mark of its own
  mysql: MysqlIcon,
  mssql: MssqlIcon,
  mongodb: MongodbIcon,
  sqlite: SqlliteIcon,
  bigquery: BigQueryIcon,
  snowflake: SnowflakeIcon,
  slack: SlackIcon,
  gcs: GoogleCloudStorageIcon,
  dropbox: DropboxIcon,
  'google-drive': GoogleDriveIcon,
  'google-sheets': GoogleSheetsIcon,
};

export const connectorIconFor = (dbType) => CONNECTOR_ICONS[String(dbType || '').toLowerCase()] || null;

/** Stores that live on disk rather than behind a connection. */
const LOCAL_DB_TYPES = new Set(['duckdb', 'lancedb']);

/**
 * Every saved connection, keyed by id — loaded once and shared by every card.
 *
 * An output node records only `outputSettings.connectionId`; unlike a
 * transformer or a join it carries no `targetDbType`, so its destination store
 * can only be named by looking the connection up. Doing that per card would
 * fire one read per output node on every canvas render, so the load is done
 * once at module level and every card subscribes to the same result.
 */
let connectionCache = null;
let connectionPromise = null;
const connectionSubscribers = new Set();

const loadConnections = () => {
  if (connectionPromise) return connectionPromise;
  connectionPromise = connectionsDb.getAll()
    .then((rows) => {
      connectionCache = new Map(
        (rows || []).map((c) => [String(c.id || c._id), c]),
      );
      connectionSubscribers.forEach((fn) => fn(connectionCache));
      return connectionCache;
    })
    .catch(() => {
      // A card that cannot name its connection still renders — it falls back to
      // whatever the node recorded. Never let this break the canvas.
      connectionCache = new Map();
      connectionSubscribers.forEach((fn) => fn(connectionCache));
      return connectionCache;
    });
  return connectionPromise;
};

/** Drop the cache so the next card re-reads it (a connection was added/edited). */
export const refreshConnectionCache = () => {
  connectionCache = null;
  connectionPromise = null;
  loadConnections();
};

const useConnections = () => {
  const [conns, setConns] = useState(connectionCache);
  useEffect(() => {
    if (connectionCache) { setConns(connectionCache); return undefined; }
    const onLoad = (map) => setConns(map);
    connectionSubscribers.add(onLoad);
    loadConnections();
    return () => connectionSubscribers.delete(onLoad);
  }, []);
  return conns;
};

/**
 * Where this node writes: `{ store, table, dbType }`, or null when it writes
 * nowhere yet.
 *
 * `store` is what the destination is CALLED (the connection's name, or the
 * local file), `table` is the object written inside it. A transformer and a
 * join both describe their destination with `target*`; an output keeps its own
 * under `outputSettings` and has to resolve the connection by id.
 */
export const destinationOf = (type, config = {}, connections = null) => {
  if (type === 'output') {
    const out = config.outputSettings;
    if (!out || !out.outputType) return null;

    if (out.outputType === 'local') {
      // A file export names the file, not a table — the format IS the store.
      const file = nonEmpty(out.savePath) ? String(out.savePath).split(/[\\/]/).pop() : '';
      const fmt = nonEmpty(out.format) ? String(out.format).toUpperCase() : 'FILE';
      return { store: fmt, table: file || null, dbType: null, isLocal: true };
    }

    // The DESTINATION connection, never `sourceConnectionName` — that names
    // where the node READS from, so an output reading LanceDB and writing MySQL
    // used to label itself with the LanceDB end.
    const conn = connections && out.connectionId
      ? connections.get(String(out.connectionId))
      : null;
    return {
      store: conn?.name || (out.connectionId ? 'Connection' : null),
      table: out.objectPath || out.tableName || null,
      dbType: conn?.dbType || null,
      isLocal: false,
    };
  }

  // Transformer / join. An in-place transformer rewrites its source, so that
  // table IS the destination.
  const inPlace = config.transformationSettings?.operationMode === 'in_place';
  const table = inPlace ? sourceDatasetOf(config) : targetDatasetOf(config);
  const dbType = config.targetDbType || null;
  const store = config.targetConnectionName || null;
  if (!nonEmpty(table) && !nonEmpty(store)) return null;

  return {
    store: store || null,
    table: nonEmpty(table) ? table : null,
    dbType,
    isLocal: LOCAL_DB_TYPES.has(String(dbType || '').toLowerCase()),
  };
};

/**
 * Where this node reads: `{ store, table, dbType }`, the mirror of
 * `destinationOf` for a data source. `store` is the connection's name, `table`
 * the object read through it — a file import that never landed a table name is
 * still identified by the file it came from.
 */
export const sourceOf = (config = {}) => {
  const store = config.sourceConnectionName || config.connectionName || null;
  let table = sourceDatasetOf(config);
  if (!nonEmpty(table) && nonEmpty(config.sourceLocalPath)) {
    table = String(config.sourceLocalPath).split(/[\\/]/).pop();
  }
  if (!nonEmpty(table) && !nonEmpty(store)) return null;

  // An imported file is READ by DuckDB and parked in the shared SQLite store,
  // so its `sourceDbType` names the engine, not the source — badging a CSV with
  // the SQLite logo would contradict the file glyph in the card's own header.
  const isFile = config.sourceConnectionType === 'file';
  const dbType = isFile ? null : (config.sourceDbType || config.dbType || null);
  return {
    store,
    table: nonEmpty(table) ? table : null,
    dbType,
    isLocal: isFile || LOCAL_DB_TYPES.has(String(dbType || '').toLowerCase()),
  };
};

/**
 * The strip along the bottom of a card: a store's logo, the table, and the
 * connection it belongs to. Shared so a source and a destination read alike.
 */
const EndpointFooter = ({ endpoint: dest, accent }) => {
  const Icon = connectorIconFor(dest.dbType);
  const Fallback = dest.isLocal ? FolderOutlined : DatabaseOutlined;

  return (
    <div
      title={[dest.store, dest.table].filter(Boolean).join(' · ')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderTop: `1px solid ${BORDER}`,
        background: SURFACE,
        borderRadius: '0 0 6px 6px',
        minWidth: 0,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, flexShrink: 0,
      }}>
        {Icon
          ? <Icon width={14} height={14} />
          : <Fallback style={{ fontSize: 12, color: accent || MUTED }} />}
      </span>

      <span style={{
        fontSize: 10.5, fontFamily: MONO, color: MUTED,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
      }}>
        {dest.table || dest.store}
      </span>

      {/* The store only earns its own slot when the table is already shown. */}
      {dest.table && dest.store && (
        <span style={{
          marginLeft: 'auto', fontSize: 9.5, fontFamily: MONO, color: DIM,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flexShrink: 1, minWidth: 0, paddingLeft: 6,
        }}>
          {dest.store}
        </span>
      )}
    </div>
  );
};

/**
 * How a node writes its result — one of three, the same words on the canvas
 * card and in the Data Preview's Details tab:
 *
 *   'new_table'    New table        — replaced on every run (a join or
 *                                     transformer in new-table mode, an output
 *                                     in Truncate & insert, any file export)
 *   'in_place'     Modify in place  — a transformer editing its source's rows
 *   'append_merge' Append/Merge     — rows added to (or merged into) a table
 *                                     that is kept between runs
 *
 * `detail` says which of append / merge, the merge key, and whether a kept
 * target is waiting to be recreated. null for nodes that write nothing.
 */
/**
 * The warning for a join whose pending drop-and-recreate target is ALSO one of
 * its sources (joinSettings.targetRebuild.targetIsSource, set by the builder).
 * Dropping it empties that source before the join reads it. One wording for
 * every place the drop is approved. null when there is nothing to warn about.
 */
export const targetIsSourceWarning = (rebuild) => {
  const clash = rebuild?.targetIsSource;
  if (!clash) return null;
  const [other, temp] = clash.suggestions || [];
  return `${rebuild.table} is also this join's source "${clash.source}". Dropping it deletes that source's `
    + 'rows before the join reads them — the join would run against an empty table, write nothing, and the data '
    + `would be gone. Write the join to another table instead${other ? ` (e.g. ${other}` : ''}`
    + `${temp ? `, or a temporary ${temp}` : ''}${other ? ')' : ''}, and replace ${rebuild.table} from it afterwards if you need to.`;
};

export const WRITE_MODE_LABEL = {
  new_table: 'New table',
  in_place: 'Modify in place',
  append_merge: 'Append/Merge',
};

export const writeModeOf = (type, config = {}) => {
  const c = config || {};
  if (type === 'transformer') {
    const mode = c.transformationSettings?.operationMode;
    if (!mode && !c.targetTableName && !c.targetCollection) return null;
    const value = mode === 'in_place' ? 'in_place' : 'new_table';
    return { value, label: WRITE_MODE_LABEL[value], detail: null };
  }
  if (type === 'join') {
    const js = c.joinSettings || {};
    if (!js.operationMode && !c.targetTableName && !c.targetCollection) return null;
    if (js.operationMode === 'append' || js.operationMode === 'merge') {
      const parts = [js.operationMode === 'merge'
        ? `merge${Array.isArray(js.mergeKeys) && js.mergeKeys.length ? ` on ${js.mergeKeys.join(', ')}` : ''}`
        : 'append'];
      if (js.targetRebuild?.pending) parts.push(`${js.targetRebuild.table || 'target'} will be recreated on the next run`);
      return { value: 'append_merge', label: WRITE_MODE_LABEL.append_merge, detail: parts.join(' · ') };
    }
    return { value: 'new_table', label: WRITE_MODE_LABEL.new_table, detail: null };
  }
  if (type === 'output') {
    const os = c.outputSettings || {};
    if (!os.outputType) return null;
    // A file is rewritten whole every run, whatever the setting — except a
    // LanceDB file, which appends (upserts) like a vector connection.
    const isFile = os.outputType === 'local' && os.format !== 'lancedb';
    const value = !isFile && os.writeMode !== 'truncate' ? 'append_merge' : 'new_table';
    const detail = isFile ? 'file rewritten each run'
      : (os.writeMode === 'truncate' ? 'truncate & insert' : 'append');
    return { value, label: WRITE_MODE_LABEL[value], detail };
  }
  return null;
};

/** The write-mode line on a transformer, join or output card. */
export const WriteModeRow = ({ type, config, accent }) => {
  const mode = writeModeOf(type, config);
  if (!mode) return null;
  const pending = type === 'join' && !!config?.joinSettings?.targetRebuild?.pending;
  return (
    <div
      title={mode.detail ? `${mode.label} — ${mode.detail}` : mode.label}
      style={{
        padding: '4px 10px',
        borderTop: '1px solid #f0f2f5',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        fontFamily: MONO,
        color: MUTED,
      }}
    >
      <span style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: DIM }}>Write</span>
      <span style={{ color: accent || MUTED, fontWeight: 600 }}>{mode.label}</span>
      {pending && (
        <span style={{ marginLeft: 'auto', color: '#b45309' }}>recreate pending</span>
      )}
    </div>
  );
};

/**
 * The strip along the bottom of a card naming where the result lands.
 *
 * Renders nothing at all when the node has no destination yet — an unconfigured
 * card should not grow an empty row.
 */
export const DestinationFooter = ({ type, config, accent }) => {
  const connections = useConnections();
  const dest = destinationOf(type, config, connections);
  if (!dest) return null;
  return <EndpointFooter endpoint={dest} accent={accent} />;
};

/** The same strip, naming where a data source READS from. */
export const SourceFooter = ({ config, accent }) => {
  const src = sourceOf(config);
  if (!src) return null;
  return <EndpointFooter endpoint={src} accent={accent} />;
};

/**
 * What a REST source calls, for its card. The builder records the endpoint the
 * fetch function calls (`GET {{BASE_URL}}latest`); `{{BASE_URL}}` is shown as
 * the connection's base URL and the query string is dropped, since that is
 * where keys and long parameter lists live. A node built before the endpoint
 * was recorded falls back to the connection's HOST — its full base URL names
 * one endpoint (e.g. …/todos/1) that the node may not call at all.
 */
const apiEndpointLabel = (endpoint, baseUrl) => {
  if (nonEmpty(endpoint)) {
    const shown = endpoint
      .replace(/\{\{BASE_URL\}\}/g, nonEmpty(baseUrl) ? baseUrl : '')
      .replace(/\?.*$/, '')
      // "Fetches GET …" says GET twice; other methods are worth showing.
      .replace(/^\s*GET\s+/i, '')
      .trim();
    // Only a real URL is shown. Anything else — a description the model wrote
    // in place of one — would put a URL on the card that the node never calls,
    // so it falls through to the host below.
    const [method, url] = /\s/.test(shown) ? shown.split(/\s+/, 2) : [null, shown];
    const candidate = method && /^[A-Z]+$/.test(method) && !/\s/.test(shown.slice(method.length + 1))
      ? `${method} ${url}`
      : (method ? null : url);
    if (candidate) {
      try {
        // eslint-disable-next-line no-new
        new URL(candidate.replace(/^[A-Z]+\s+/, ''));
        return candidate;
      } catch (_) { /* not a URL — use the host */ }
    }
  }
  try {
    return new URL(baseUrl).host || 'the API';
  } catch (_) {
    return 'the API';
  }
};

const describeDataSource = (config) => {
  // A REST API source has no table to name — the endpoint identifies it, and
  // the collection it caches into is where downstream nodes read from.
  const api = config.apiConnectionPublicConfig;
  if (api || config.sourceConnectionType === 'api') {
    if (!nonEmpty(config.apiFetchCode)) return 'REST API — describe the request in the chat';
    const into = nonEmpty(config.sourceCollection) ? ` into ${config.sourceCollection}` : '';
    return `Fetches ${apiEndpointLabel(config.apiEndpoint, api?.baseUrl)}${into}`;
  }
  const dataset = sourceDatasetOf(config);
  return dataset ? `Reads ${dataset}` : '';
};

const describeTransformer = (config) => {
  const src = sourceDatasetOf(config);
  const target = targetDatasetOf(config);
  if (config.usesSkill && nonEmpty(config.skillId)) {
    return src ? `Runs ${config.skillId} on ${src}` : `Runs ${config.skillId}`;
  }
  if (config.transformationSettings?.operationMode === 'in_place' && src) {
    return `Updates ${src} in place`;
  }
  if (src && target) return `Transforms ${src} → ${target}`;
  if (target) return `Writes ${target}`;
  return src ? `Transforms ${src}` : '';
};

const describeJoin = (config) => {
  const names = Array.isArray(config.sources)
    ? config.sources
      .map((s) => s?.sourceTableName || s?.sourceCollection || s?.sourceNodeLabel || s?.sourceConnectionName)
      .filter(nonEmpty)
    : [];
  const target = targetDatasetOf(config);
  const into = target ? ` → ${target}` : '';
  if (names.length === 0) return target ? `Writes ${target}` : '';
  // Past three the names crowd out the target, which is the more useful half.
  const from = names.length > 3 ? `${names.length} sources` : names.join(' + ');
  return `Joins ${from}${into}`;
};

/**
 * One line naming what a node reads and writes, built from its config. Returns
 * '' when the config has nothing to identify yet, so callers can fall back to
 * an AI explanation or their own placeholder.
 */
export const describeNode = (type, config = {}) => {
  if (type === 'dataSource') return describeDataSource(config);
  if (type === 'transformer') return describeTransformer(config);
  if (type === 'join') return describeJoin(config);
  return '';
};

// ── Node display name ───────────────────────────────────────────────────────
//
// Every surface that names a node — the canvas card, the execution-steps
// editor, the run log — used to roll its own precedence, and all of them
// bottomed out on `data.label`. That label is written once at creation
// (`getNodeLabel(type)` → "Transformer") and nothing updates it afterwards:
// building a node through chat merges `config` only, so a canvas full of
// configured nodes still reads "Transformer", "Transformer", "Data Source".
//
// So the config becomes the name when nothing better was chosen. It already
// says what the node does, it updates itself every time the node is rebuilt,
// and it needs no migration — existing saved workflows read correctly too.
const GENERIC_LABELS = new Set(['start', 'data source', 'datasource', 'transformer', 'join', 'output', 'node', 'unnamed', '']);

const isGenericLabel = (label) => GENERIC_LABELS.has(String(label || '').trim().toLowerCase());

/** Whether a label is just the auto-stamped name read back off the node. */
const isAutoLabel = (label, config = {}) => !!config.node_nameAuto
  && nonEmpty(config.node_name)
  && String(config.node_name).trim() === String(label || '').trim();

/** The dataset a node is named after, when neither a name nor a real label exists. */
const derivedNameOf = (type, config = {}) => {
  if (type === 'dataSource') {
    // A source is identified by WHERE it reads from and WHAT it reads there:
    // the connection, then the table/collection. The table was once left out —
    // the card's footer already spells it out — but the title is the first
    // thing anyone checks, and a source retargeted to another table went on
    // announcing the old one. Segments that repeat each other (a connection
    // named after its engine, say) collapse to one.
    //
    // The database is named only when there is no table to name yet, so a
    // half-configured source still has something to go by. Known trade-off:
    // two sources on the SAME connection but different databases, reading
    // tables of the same name, now share a title — the footer tells them apart.
    const dataset = sourceDatasetOf(config, { withSchema: false });
    const parts = [
      config.sourceConnectionName || config.connectionName
        || config.sourceDbType || config.sourceType || config.sourceConnectionType,
      dataset || config.sourceDbConfig?.database || config.sourceDatabase,
    ].filter(nonEmpty).map((p) => String(p).trim());
    const seen = new Set();
    const unique = parts.filter((p) => {
      const key = p.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.join(' · ') || sourceDatasetOf(config);
  }
  if (type === 'transformer') {
    // In-place work writes nothing new — it IS its source table, so that is
    // the only dataset that names it.
    if (config.transformationSettings?.operationMode === 'in_place') {
      return sourceDatasetOf(config) || targetDatasetOf(config);
    }
    return targetDatasetOf(config) || sourceDatasetOf(config);
  }
  if (type === 'join') return targetDatasetOf(config);
  if (type === 'output') {
    const os = config.outputSettings || config;
    // A cloud upload is named by the file it writes, not `<container>/<path>` —
    // the container is often an id ("root", a drive GUID).
    if (nonEmpty(os.objectName)) return os.objectName;
    if (nonEmpty(os.tableName)) return os.tableName;
    // A file output is named by its file, not the whole path.
    if (nonEmpty(os.savePath)) return String(os.savePath).split(/[\\/]/).pop();
  }
  return '';
};

/**
 * What to call a node, in one place so every surface agrees.
 *
 * Precedence: a name the USER chose wins, then a label that isn't just the node
 * type, then whatever the config identifies, then a name we derived earlier,
 * then the type itself.
 *
 * A name WE derived (`node_nameAuto`) deliberately ranks below a fresh
 * derivation — it is a cache written for the main process, which cannot derive
 * anything, not an authority. Ranked above one it went stale the moment the
 * config moved on: repoint a data source at another connection and the card
 * kept the old connection's name until the next save re-stamped it. Read as a
 * cache it corrects itself immediately, and every workflow already saved with a
 * stale one reads correctly with no migration. It still answers when nothing is
 * derivable right now, so a node whose config is mid-edit keeps its name rather
 * than flicking back to "Data Source".
 *
 * @param {string} type     Node type ('transformer' | 'join' | 'dataSource' | …).
 * @param {Object} data     The node's `data` ({ label, config }).
 * @param {string} fallback Shown when the node has nothing to name it yet.
 */
export const nodeDisplayName = (type, data = {}, fallback = 'Node') => {
  const config = data.config || {};
  const label = String(data.label || '').trim();
  const stamped = nonEmpty(config.node_name) ? String(config.node_name).trim() : '';
  if (stamped && !config.node_nameAuto) return stamped;
  // Fed by something it was not built against (see syncNodeSourcesToEdges).
  // A derived name describes the SOURCE, so following the rewire would rename
  // the node after data its logic does not touch — and the name it earned
  // would be gone until it is regenerated. Keep what it is called.
  if (stamped && config.sourceChanged) return stamped;
  // A label is a name someone CHOSE — unless it is the auto-stamp read back.
  // The builder writes the same string to both `data.label` and `node_name`,
  // so a label equal to an auto `node_name` is this cache wearing another hat,
  // and ranking it above a fresh derivation is what kept a retargeted source
  // announcing the table it no longer reads.
  if (label && !isGenericLabel(label) && !isAutoLabel(label, config)) return label;
  const derived = derivedNameOf(type, config);
  if (derived) return derived;
  return stamped || label || fallback;
};

/**
 * The banner a card shows while its input is wrong, or '' while it is fine.
 *
 * Two different things put it there, and they are cleared differently:
 *
 *   `sourceStale`   — the node CANNOT RUN: its statements were written for a
 *                     source that has moved, been disconnected, or a new one
 *                     has appeared that they never mention. The executor
 *                     refuses it. Only a rebuild clears this, so the card stays
 *                     red through "Keep as is" — that answer is about the
 *                     node's logic, and no answer makes SQL written for one
 *                     table correct for another.
 *   `sourceChanged` — the node's input moved and its logic MAY no longer fit.
 *                     A question, which "Keep as is" answers.
 */
export const sourceIssueLabel = (config = {}, builtAgainst = '') => {
  const stale = {
    moved: 'SOURCE MOVED — rebuild this node before running',
    disconnected: 'SOURCE DISCONNECTED — rebuild this node before running',
    unread: 'NEW SOURCE NOT READ — rebuild this node before running',
  }[config.sourceStale];
  if (stale) return stale;
  if (config.sourceChanged) return `SOURCE CHANGED — was ${builtAgainst || 'other nodes'}`;
  return '';
};

// ── Persisting the name ─────────────────────────────────────────────────────
//
// Deriving at display time covers everything the renderer draws, but the
// execution log is written by the main process from the SAVED workflow — it
// has no access to this module and no chance to derive anything. So the name
// is also written into the config, where the executor (and anything else
// reading a saved workflow) can just read it.
//
// `node_nameAuto` records that WE wrote it. A name typed into the node's own
// form carries no such flag and is never touched, while a name we derived
// stays in step with the config it came from — rebuild a transformer onto a
// different target table and the name follows.

/**
 * The name to persist onto a node, or null when there is nothing to write
 * (nothing derivable yet, already correct, or a name the user owns).
 */
export const persistedNameFor = (type, data = {}) => {
  const config = data.config || {};
  if (nonEmpty(config.node_name) && !config.node_nameAuto) return null;
  // Same rule as nodeDisplayName: while the input is wrong, the name derived
  // from it is wrong too, so a save must not overwrite the stored one with it.
  if (nonEmpty(config.node_name) && config.sourceChanged) return null;
  const label = String(data.label || '').trim();
  // Same rule as nodeDisplayName: a label that IS the auto-stamp cannot be the
  // authority for re-stamping it, or the stale name would write itself back.
  const name = (label && !isGenericLabel(label) && !isAutoLabel(label, config))
    ? label
    : derivedNameOf(type, config);
  if (!name || name === config.node_name) return null;
  return name;
};

/**
 * Stamp derived names onto a node list. Returns the SAME array when nothing
 * changed, so callers can use it as a cheap "did anything move" check and skip
 * a redundant setNodes.
 */
export const withPersistedNodeNames = (nodes = []) => {
  let changed = false;
  const out = nodes.map((node) => {
    const name = persistedNameFor(node?.type, node?.data);
    if (!name) return node;
    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        config: { ...(node.data?.config || {}), node_name: name, node_nameAuto: true },
      },
    };
  });
  return changed ? out : nodes;
};

/** Card summaries are one clamped paragraph — keep prose from running away. */
export const truncate = (text, max = 100) => {
  const str = String(text || '').trim();
  return str.length > max ? `${str.slice(0, max)}...` : str;
};

// ── Syntax highlighting ─────────────────────────────────────────────────────
// Tokenizer shared by all supported languages. We keep the palette small and
// compatible with the dark editor background: strings green, numbers amber,
// keywords indigo, comments grey, builtins cyan.

const TOKEN_COLORS = {
  keyword: '#818cf8',
  string:  '#86efac',
  number:  '#fbbf24',
  comment: '#64748b',
  builtin: '#5eead4',
  punct:   '#cbd5e1',
  base:    '#e2e8f0',
};

const SQL_KEYWORDS = [
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','IS','NULL','AS','DISTINCT',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','ON','USING','UNION','ALL',
  'GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET','INSERT','INTO','VALUES',
  'UPDATE','SET','DELETE','CREATE','ALTER','DROP','TABLE','INDEX','VIEW',
  'IF','EXISTS','PRIMARY','KEY','FOREIGN','REFERENCES','DEFAULT','CASE',
  'WHEN','THEN','ELSE','END','WITH','CAST','BETWEEN','LIKE','ILIKE',
];

const JS_KEYWORDS = [
  'async','await','break','case','catch','class','const','continue','debugger',
  'default','delete','do','else','export','extends','finally','for','from',
  'function','if','import','in','instanceof','let','new','of','return',
  'switch','this','throw','try','typeof','var','void','while','with','yield',
  'true','false','null','undefined',
];

const JS_BUILTINS = [
  'axios','console','Math','JSON','Object','Array','Promise','Date','Number',
  'String','Boolean','Error','Map','Set','parseInt','parseFloat','fetch',
];

const PY_KEYWORDS = [
  'and','as','assert','async','await','break','class','continue','def','del',
  'elif','else','except','finally','for','from','global','if','import','in',
  'is','lambda','nonlocal','not','or','pass','raise','return','try','while',
  'with','yield','True','False','None',
];

const PY_BUILTINS = [
  'print','len','range','list','dict','tuple','set','str','int','float',
  'bool','open','enumerate','zip','map','filter','sorted','sum','min','max',
  'abs','any','all','isinstance','type','pd','np',
];

// Escape regex metacharacters in a string.
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build a tokenizer result from a pre-assembled list of patterns. Each
// pattern entry is { re, type }. The tokenizer scans left-to-right, taking
// the earliest match on each step; unmatched characters become `base` tokens.
const tokenize = (source, patterns) => {
  const out = [];
  let i = 0;
  const L = source.length;
  while (i < L) {
    let best = null;
    for (const p of patterns) {
      p.re.lastIndex = i;
      const m = p.re.exec(source);
      if (m && m.index === i && (best === null || m[0].length > best.match[0].length)) {
        best = { match: m, type: p.type };
      }
    }
    if (best) {
      out.push({ type: best.type, text: best.match[0] });
      i += best.match[0].length;
    } else {
      // No pattern matched — capture a single character as base text and
      // merge it with the previous base run to keep the node count low.
      const ch = source[i++];
      if (out.length && out[out.length - 1].type === 'base') {
        out[out.length - 1].text += ch;
      } else {
        out.push({ type: 'base', text: ch });
      }
    }
  }
  return out;
};

const buildPatterns = ({ keywords = [], builtins = [], comments = [] }) => {
  const pats = [];
  // Comments first so `--` / `//` / `#` beat operators.
  for (const c of comments) pats.push({ re: c, type: 'comment' });
  // Strings: single, double, and (for JS) template literals. Allow escapes.
  pats.push({ re: /'(?:\\.|[^'\\])*'/gy, type: 'string' });
  pats.push({ re: /"(?:\\.|[^"\\])*"/gy, type: 'string' });
  pats.push({ re: /`(?:\\.|[^`\\])*`/gy, type: 'string' });
  // Numbers (int, float, scientific, hex).
  pats.push({ re: /0x[0-9a-fA-F]+|\d+\.\d+(?:[eE][+-]?\d+)?|\d+/gy, type: 'number' });
  // Keywords — longest first so multi-word SQL (e.g. GROUP BY) beats GROUP.
  const kwSorted = [...keywords].sort((a, b) => b.length - a.length);
  if (kwSorted.length) {
    const kwRx = new RegExp(`(?:${kwSorted.map(rx).join('|')})\\b`, 'giy');
    pats.push({ re: kwRx, type: 'keyword' });
  }
  if (builtins.length) {
    const biRx = new RegExp(`(?:${builtins.map(rx).join('|')})\\b`, 'gy');
    pats.push({ re: biRx, type: 'builtin' });
  }
  // Punctuation / operators — a short set, to give punctuation a slightly
  // dimmer shade than base text.
  pats.push({ re: /[{}()\[\];,.:<>=!+\-*/%&|^~?]/gy, type: 'punct' });
  return pats;
};

const PATTERNS_BY_LANG = {
  sql: buildPatterns({
    keywords: SQL_KEYWORDS,
    comments: [/--[^\n]*/gy, /\/\*[\s\S]*?\*\//gy],
  }),
  javascript: buildPatterns({
    keywords: JS_KEYWORDS,
    builtins: JS_BUILTINS,
    comments: [/\/\/[^\n]*/gy, /\/\*[\s\S]*?\*\//gy],
  }),
  python: buildPatterns({
    keywords: PY_KEYWORDS,
    builtins: PY_BUILTINS,
    comments: [/#[^\n]*/gy],
  }),
  json: buildPatterns({
    keywords: ['true', 'false', 'null'],
  }),
};

const highlight = (code, lang) => {
  const patterns = PATTERNS_BY_LANG[lang];
  if (!patterns) return [{ type: 'base', text: code }];
  return tokenize(code, patterns);
};

/**
 * Dark-themed code block. Keeps formatting intact and scrolls horizontally
 * on long lines rather than wrapping, which preserves readability for SQL
 * and JS.
 */
export const CodeBlock = ({ code, lang = 'text' }) => {
  const tokens = highlight(String(code ?? ''), lang);
  return (
    <div
      style={{
        background: '#0f172a',
        borderRadius: 5,
        padding: '10px 12px',
        fontFamily: MONO,
        fontSize: 10.5,
        color: TOKEN_COLORS.base,
        lineHeight: 1.7,
        overflowX: 'auto',
        whiteSpace: 'pre',
        maxHeight: 220,
        overflowY: 'auto',
      }}
      data-lang={lang}
    >
      {tokens.map((t, i) => (
        <span key={i} style={{ color: TOKEN_COLORS[t.type] || TOKEN_COLORS.base }}>
          {t.text}
        </span>
      ))}
    </div>
  );
};

/**
 * Expandable "View/Hide CODE" rows that slot in at the bottom of a node
 * card. Mirrors the redesign NodeCard pattern: one collapsed row per code
 * type, each independently toggleable.
 */
export const ExpandableCodes = ({ codes }) => {

  const [open, setOpen] = useState({});
  if (!codes || codes.length === 0) return null;

  return (
    <div>
      {codes.map((c, ci) => {
        const isOpen = !!open[c.type];
        return (
          <div
            key={`${c.type}-${ci}`}
            style={{ borderTop: '1px solid #f0f2f5' }}
          >
            <div
              onClick={(e) => {
                e.stopPropagation();
                setOpen((p) => ({ ...p, [c.type]: !p[c.type] }));
              }}
              className="nodrag"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                cursor: 'pointer',
                background: isOpen ? SURFACE : 'transparent',
                transition: 'background 0.15s',
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: SURFACE,
                  border: `1px solid ${BORDER}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <CodeOutlined style={{ fontSize: 8 }} />
              </div>
              <span
                style={{
                  fontSize: 9,
                  fontFamily: MONO,
                  fontWeight: 700,
                  letterSpacing: '0.07em',
                  color: MUTED,
                  textTransform: 'uppercase',
                }}
              >
                {c.type}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: DIM,
                  display: 'inline-block',
                  transform: isOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.15s',
                }}
              >
                ▾
              </span>
            </div>
            {isOpen && (
              <div
                style={{ padding: '0 6px 6px' }}
                onClick={(e) => e.stopPropagation()}
                className="nodrag nowheel"
              >
                <CodeBlock code={c.content} lang={c.lang} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
