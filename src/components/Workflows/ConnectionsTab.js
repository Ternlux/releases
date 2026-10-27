import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Modal, message } from 'antd';
import axios from 'axios';

import DataPreviewModal from './DataPreviewModal';
import ConnectionTypeSelector from './ConnectionTypeSelector';

import DynamicConnectionForm from './connections/DynamicConnectionForm';
import LocalFileConnectionForm from './connections/LocalFileConnectionForm';
import { isDuplicateConnectionName } from './connections/connectionNameRule';
import { connectorVisual, ConnectorLogo } from './connections/connectorCatalog';

import DatabaseExplorer from '../DatabaseExplorer/DatabaseExplorer';

import { connectionsDb } from '../../utils/localDb';
import { C, MONO, SANS, I, Btn, Tag, MoreMenu, PageHeader } from './_designShared';
import {
  detectFileType, collectDroppableFiles, fileDragHandlers, FileDropOverlay,
  LOCAL_FILE_FORM_TYPES, LOCAL_FILE_MODAL_TITLES,
} from './connections/localFileDrop';

// How much of the Data Explorer's worksheet rides along in the chat context.
// Enough for a long statement, short of crowding out the rest of the prompt.
const EXPLORER_CONTEXT_LIMIT = 4000;

// Subtype color/label config — used for the bottom-of-card chip
const CONN_TYPE_CFG = {
  postgres: { label: 'PostgreSQL', color: C.accent,  bg: C.aD,                    border: 'rgba(37,99,235,0.18)' },
  mysql:    { label: 'MySQL',      color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  mssql:    { label: 'SQL Server', color: '#0078d4', bg: 'rgba(0,120,212,0.07)',  border: 'rgba(0,120,212,0.2)' },
  mongodb:  { label: 'MongoDB',    color: C.green,   bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  csv:      { label: 'CSV',        color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  excel:    { label: 'Excel',      color: C.cyan,    bg: C.cD,                    border: 'rgba(8,145,178,0.18)' },
  sqlite:   { label: 'SQLite',     color: C.cyan,    bg: C.cD,                    border: 'rgba(8,145,178,0.18)' },
  duckdb:   { label: 'DuckDB',     color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  parquet:  { label: 'Parquet',    color: C.violet,  bg: C.vD,                    border: 'rgba(124,58,237,0.18)' },
  avro:     { label: 'Avro',       color: '#db2777', bg: 'rgba(219,39,119,0.06)', border: 'rgba(219,39,119,0.18)' },
  json:     { label: 'JSON',       color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  lancedb:  { label: 'LanceDB',    color: C.violet,  bg: C.vD,                    border: 'rgba(124,58,237,0.18)' },
  spreadsheet: { label: 'Spreadsheet', color: C.accent, bg: C.aD,                 border: 'rgba(37,99,235,0.18)' },
  shopify:  { label: 'Shopify',    color: C.green,   bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  clover_pos: { label: 'Clover POS', color: C.green, bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  square_pos: { label: 'Square POS', color: C.violet, bg: C.vD,                   border: 'rgba(124,58,237,0.18)' },
};

// A file connection's `dbType` records the engine that reads it — DuckDB for
// every local file and database — rather than the format the user actually
// uploaded. The original file name is the only place that survives, so recover
// the format from there.
const EXT_FILE_TYPE = {
  '.csv': 'csv', '.tsv': 'csv',
  '.xlsx': 'excel', '.xls': 'excel', '.xlsm': 'excel',
  '.json': 'json',
  '.parquet': 'parquet',
  '.avro': 'avro',
  '.sqlite': 'sqlite', '.sqlite3': 'sqlite', '.db': 'sqlite',
  '.duckdb': 'duckdb',
};

const originalFileType = (conn) => {
  if (conn.connectionType !== 'file') return null;
  const name = conn.fileInfo?.originalName || conn.fileInfo?.sourceFilePath || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_FILE_TYPE[name.toLowerCase().slice(dot)] || null;
};

const subTypeOf = (conn) =>
  originalFileType(conn) || conn.dbType || conn.fileType || conn.apiType || conn.connectionType || 'file';

const typeCfgFor = (subType) =>
  CONN_TYPE_CFG[subType] || { label: subType, color: C.muted, bg: C.s2, border: C.border };

// Plugin dbCategory values that have no useful Explore/Preview action.
const NO_MIDDLE_ACTION_CATEGORIES = new Set(['Vector', 'CloudStorage', 'API']);

// Saved connections wear the same provider logo the connector picker shows.
// An unrecognised type (a custom plugin, a legacy record) keeps the generic
// file/database glyph tinted by its category.
const ConnIcon = ({ conn }) => {
  const visual = connectorVisual(subTypeOf(conn));
  if (visual) return <ConnectorLogo c={visual} size={32} imgSize={20} letterSize={9} />;

  const isFile = conn.connectionType === 'file';
  const isDb   = conn.connectionType === 'database';
  const isApi  = conn.connectionType === 'api';
  const color  = isDb ? C.accent : isApi ? C.green : C.cyan;
  const bg     = isDb ? C.aD : isApi ? C.gD : C.cD;
  const border = isDb ? 'rgba(37,99,235,0.2)'
    : isApi ? 'rgba(5,150,105,0.2)'
    : 'rgba(8,145,178,0.2)';
  const iconName = isFile ? 'file' : 'db';
  return (
    <div style={{
      width: 32, height: 32, borderRadius: 5, flexShrink: 0,
      background: bg, border: `1px solid ${border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {I(iconName, color, 15)}
    </div>
  );
};

const formatDate = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(); } catch { return ''; }
};

const ConnectionCard = ({ conn, plugin, onEdit, onPreview, onExplore, onDelete }) => {
  const [hov, setHov] = useState(false);
  const subType = subTypeOf(conn);
  const tc = typeCfgFor(subType);
  const fileSizeMB = conn.fileInfo?.fileSize ? (conn.fileInfo.fileSize / 1024 / 1024).toFixed(2) : null;
  const dbCategory = conn.dbCategory || plugin?.dbCategory;
  const hideMiddleAction = NO_MIDDLE_ACTION_CATEGORIES.has(dbCategory);
  // Local files are queried in place by DuckDB, so they can be explored too —
  // the same worksheet, schema tree and history as a server connection. They
  // keep Preview Data as well, since that stays the quickest look at the rows.
  const isExplorableFile = conn.connectionType === 'file'
    && (conn.dbType === 'duckdb' || conn.dbType === 'sqlite');
  const canExplore = !hideMiddleAction && (conn.connectionType === 'database' || isExplorableFile);
  const canPreview = !hideMiddleAction && conn.connectionType !== 'database';
  const middleAction = hideMiddleAction
    ? []
    : conn.connectionType === 'database'
      ? [{ label: 'Explore DB', icon: 'compass', onClick: () => onExplore(conn) }]
      : [
        { label: 'Preview Data', icon: 'eye', onClick: () => onPreview(conn) },
        ...(isExplorableFile
          ? [{ label: 'Explore DB', icon: 'compass', onClick: () => onExplore(conn) }]
          : []),
      ];

  // Clicking the card runs the same action the menu leads with: the explorer
  // where there is one, otherwise the row preview. The ⋯ menu stops its own
  // clicks from bubbling, so it never triggers this.
  const openCard = canExplore ? () => onExplore(conn) : canPreview ? () => onPreview(conn) : null;

  return (
    <div
      onMouseOver={() => setHov(true)} onMouseOut={() => setHov(false)}
      onClick={openCard || undefined}
      title={openCard ? (canExplore ? 'Open in Data Explorer' : 'Preview data') : undefined}
      style={{
        background: '#fff', border: `1px solid ${hov ? C.border2 : C.border}`,
        borderRadius: 6, overflow: 'hidden',
        transition: 'all 0.15s',
        boxShadow: hov ? '0 4px 16px rgba(0,0,0,0.07)' : '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex', flexDirection: 'column',
        cursor: openCard ? 'pointer' : 'default',
      }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <ConnIcon conn={conn} />
        <span title={conn.name} style={{
          fontSize: 13, fontWeight: 600, color: C.text, letterSpacing: '-0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {conn.name || conn.connectionName || 'Unnamed connection'}
        </span>
        <MoreMenu items={[
          { label: 'Edit', icon: 'edit', onClick: () => onEdit(conn) },
          ...middleAction,
          { label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(conn) },
        ]} />
      </div>
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{
          fontSize: 12, color: C.muted, lineHeight: 1.55,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          minHeight: 36,
        }}>
          {conn.description || <span style={{ color: C.dim, fontStyle: 'italic' }}>No description</span>}
        </div>
        <div style={{ fontSize: 11, color: C.muted, fontFamily: MONO, lineHeight: 1.8 }}>
          {conn.connectionType === 'database' && conn.dbConfig?.host && (
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              host: {conn.dbConfig.host}{conn.dbConfig.port ? `:${conn.dbConfig.port}` : ''}
            </div>
          )}
          {conn.dbConfig?.database && <div>db: {conn.dbConfig.database}</div>}
          {conn.dbConfig?.engine && <div>engine: {conn.dbConfig.engine}</div>}
          {conn.fileInfo?.originalName && (
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              file: {conn.fileInfo.originalName}
            </div>
          )}
          {fileSizeMB && <div>size: {fileSizeMB} MB</div>}
          {conn.apiType && <div>via: REST API</div>}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 'auto', paddingTop: 4,
        }}>
          <Tag color={tc.color} bg={tc.bg} border={tc.border}>{tc.label}</Tag>
          {conn.createdAt && (
            <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>
              {formatDate(conn.createdAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

const CATEGORY_CFG = {
  database: { label: 'Databases', icon: 'db' },
  file:     { label: 'Files',     icon: 'file' },
  api:      { label: 'APIs',      icon: 'zap' },
};

const EMPTY_FILTERS = { search: '', category: '', types: [] };

// ── Filter Bar ──────────────────────────────────────────────────────
// Mirrors the executions filter bar: a search box on top, toggle pills below.
// `types` is multi-select so several file types can be shown side by side.
const FilterBar = ({ filters, setFilters, categories, types }) => {
  const activeCount = (filters.search ? 1 : 0) + (filters.category ? 1 : 0) + filters.types.length;

  const toggleType = (t) => setFilters(f => ({
    ...f,
    types: f.types.includes(t) ? f.types.filter(x => x !== t) : [...f.types, t],
  }));

  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            {I('eye', C.dim, 12)}
          </span>
          <input
            placeholder="Search connection or file name…"
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            style={{
              width: '100%', padding: '6px 10px 6px 28px', fontSize: 12, fontFamily: SANS,
              border: `1px solid ${C.border}`, borderRadius: 4, outline: 'none',
              color: C.text, background: '#fff',
            }}
            onFocus={e => { e.target.style.borderColor = C.accent; e.target.style.boxShadow = `0 0 0 2px ${C.aD}`; }}
            onBlur={e => { e.target.style.borderColor = C.border; e.target.style.boxShadow = 'none'; }}
          />
        </div>
        {activeCount > 0 && (
          <button type="button"
            onClick={() => setFilters({ ...EMPTY_FILTERS, types: [] })}
            style={{
              fontSize: 11, color: C.muted, background: 'none', border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontFamily: SANS,
              display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
            }}>
            {I('x', C.muted, 10)} Clear filters
            <span style={{
              background: C.accent, color: '#fff', borderRadius: 3,
              fontSize: 9, fontWeight: 700, padding: '1px 5px', fontFamily: MONO,
            }}>{activeCount}</span>
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, color: C.dim, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em', fontFamily: MONO, minWidth: 44,
        }}>Source</span>
        {categories.map(cat => {
          const cfg = CATEGORY_CFG[cat] || { label: cat, icon: 'db' };
          const active = filters.category === cat;
          return (
            <button key={cat} type="button"
              onClick={() => setFilters(f => ({ ...f, category: f.category === cat ? '' : cat }))}
              style={{
                padding: '4px 10px', borderRadius: 3,
                border: `1px solid ${active ? C.accent : C.border}`,
                background: active ? C.aD : '#fff',
                color: active ? C.accent : C.muted,
                fontSize: 11, fontWeight: active ? 600 : 500, fontFamily: SANS,
                cursor: 'pointer', transition: 'all 0.15s',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
              {I(cfg.icon, active ? C.accent : C.dim, 9)}
              {cfg.label}
            </button>
          );
        })}
      </div>

      {types.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, color: C.dim, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.06em', fontFamily: MONO, minWidth: 44,
          }}>Type</span>
          {types.map(t => {
            const cfg = typeCfgFor(t);
            const visual = connectorVisual(t);
            const active = filters.types.includes(t);
            return (
              <button key={t} type="button" onClick={() => toggleType(t)}
                style={{
                  padding: '4px 10px', borderRadius: 3,
                  border: `1px solid ${active ? cfg.border : C.border}`,
                  background: active ? cfg.bg : '#fff',
                  color: active ? cfg.color : C.muted,
                  fontSize: 11, fontWeight: active ? 600 : 500, fontFamily: SANS,
                  cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                {visual && (
                  <ConnectorLogo
                    c={visual} size={14} imgSize={12} letterSize={7}
                    style={{ background: 'transparent', border: 'none' }}
                  />
                )}
                {cfg.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const ConnectionsTab = ({
  onContextChange = () => {},
  pendingFiles = null,              // { files, bump } — handed over by a drop on another tab
  onPendingFilesHandled = () => {}, // call once consumed so the signal doesn't re-fire
}) => {
  const [connections, setConnections] = useState([]);
  const [isConnectionTypeSelectorOpen, setTypeSelectorOpen] = useState(false);
  const [activeDbType, setActiveDbType] = useState(null);
  const [editingConnection, setEditingConnection] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [isPreviewOpen, setPreviewOpen] = useState(false);
  const [explorerConnection, setExplorerConnection] = useState(null);
  // What the Data Explorer currently has open, reported up so it can ride along
  // in the chat assistant's context. Null whenever the explorer is closed.
  const [explorerQuery, setExplorerQuery] = useState(null);
  const [installedPlugins, setInstalledPlugins] = useState([]);
  const [pluginsLoaded, setPluginsLoaded] = useState(false);
  const [droppedFile, setDroppedFile] = useState(null);
  const [fileQueue, setFileQueue] = useState([]); // remaining dropped files waiting for their popup
  const [isDragOver, setIsDragOver] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // Set true when the user cancels (X / Cancel) so an in-flight save that
  // finishes afterwards doesn't persist the connection or open the next file.
  const cancelledRef = useRef(false);

  useEffect(() => {
    fetchConnections();
    loadInstalledPlugins();
  }, []);

  // The chat assistant focuses on whichever connection panel is currently open
  // — explorer, data preview, or the edit form. Derived rather than reported
  // from each open handler so that every close path (X, Cancel, save, the
  // dropped-file queue moving on) takes it back out of focus automatically.
  const focusedConnection = explorerConnection
    || (isPreviewOpen ? previewData?.connection : null)
    || editingConnection
    || null;
  const focusedConnectionId = focusedConnection
    ? (focusedConnection.id || focusedConnection._id)
    : null;
  useEffect(() => {
    if (!focusedConnection) { onContextChange(null); return; }

    // When the explorer is open, its worksheet rides along so the assistant can
    // answer about the query on screen. A highlighted fragment replaces the
    // whole sheet — that selection is almost always what the question is about.
    const lines = [`${focusedConnection.dbType || 'unknown'} · ${focusedConnection.connectionType || ''}`.trim()];
    if (explorerQuery && explorerQuery.query && explorerQuery.query.trim()) {
      const fence = explorerQuery.language === 'json' ? 'json' : 'sql';
      const body = explorerQuery.query.length > EXPLORER_CONTEXT_LIMIT
        ? `${explorerQuery.query.slice(0, EXPLORER_CONTEXT_LIMIT)}\n-- …truncated`
        : explorerQuery.query;
      lines.push(
        '',
        `Data Explorer worksheet: ${explorerQuery.worksheetName}`,
        explorerQuery.schema ? `Schema in scope: ${explorerQuery.schema}` : null,
        explorerQuery.isSelection
          ? 'The user has highlighted this fragment — treat it as the subject of the question:'
          : 'Query currently open in the worksheet:',
        `\`\`\`${fence}`,
        body,
        '```',
      );
    }

    onContextChange({
      kind: 'connection',
      id: focusedConnectionId,
      name: focusedConnection.name,
      summary: lines.filter((l) => l !== null).join('\n'),
    });
    // Keyed on the id and the explorer's worksheet so re-renders that change
    // neither don't re-report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedConnectionId, onContextChange, explorerQuery]);

  const loadInstalledPlugins = async () => {
    try {
      if (window.electronAPI?.plugins?.listInstalled) {
        const result = await window.electronAPI.plugins.listInstalled();
        if (result.success) setInstalledPlugins(result.connectors || []);
      }
    } catch (error) {
      console.error('Failed to load installed plugins:', error);
    } finally {
      setPluginsLoaded(true);
    }
  };

  const isLoggedIn = () => Boolean(localStorage.getItem('auth-token'));

  const handleAuthError = (error) => {
    if ([400, 401, 204].includes(error.response?.status)) {
      localStorage.removeItem('auth-token');
      message.error('Session expired. Please log in again.');
      window.location.href = '/login';
      return true;
    }
    return false;
  };

  const fetchConnections = async () => {
    // Remote connections fetch disabled — backend returns 403 for logged-in
    // tokens, so we always read from the local IndexedDB store.
    const local = await connectionsDb.getAll();
    setConnections(local);
    // try {
    //   const response = await axios.post('/workflow/connections', { transformer: false }, {
    //     headers: { 'auth-token': localStorage.getItem('auth-token') },
    //   });
    //   if (response.data.success) setConnections(response.data.data);
    // } catch (error) {
    //   if (handleAuthError(error)) return;
    //   console.error('Error fetching connections:', error);
    //   message.error('Failed to load connections');
    // }
  };

  const handleConnectionTypeSelect = (type) => {
    cancelledRef.current = false;
    setEditingConnection(null);
    setDroppedFile(null);
    setFileQueue([]);
    setActiveDbType(type);
  };

  // Anything modal that is already open owns the drop — see fileDragHandlers.
  const dropDisabled = Boolean(activeDbType) || Boolean(explorerConnection)
    || isPreviewOpen || isConnectionTypeSelectorOpen;
  const { onDragOver, onDragLeave } = useMemo(
    () => fileDragHandlers(setIsDragOver, dropDisabled), [dropDisabled]);

  // Open the connection popup for the next queued file, storing the rest so it
  // can be resumed after this one is saved. When the queue is empty everything
  // is closed. The file is only uploaded once its popup mounts (see the
  // LocalFileConnectionForm initialFile effect), so nothing uploads early.
  const processNextFile = (remaining) => {
    if (!remaining || remaining.length === 0) {
      setActiveDbType(null);
      setEditingConnection(null);
      setDroppedFile(null);
      setFileQueue([]);
      return;
    }
    cancelledRef.current = false; // fresh popup — this file's save is allowed
    const [next, ...rest] = remaining;
    setFileQueue(rest);
    setEditingConnection(null);
    setDroppedFile(next);
    setActiveDbType(detectFileType(next.name));
  };

  const onDrop = (event) => {
    if (dropDisabled) return;
    event.preventDefault();
    setIsDragOver(false);

    // Kick off the queue: open a popup for the first file, upload the rest one
    // at a time as each popup is completed.
    const validFiles = collectDroppableFiles(event);
    if (validFiles.length > 0) processNextFile(validFiles);
  };

  // Files dropped on another tab (the Workflows list) are validated there and
  // handed over as this tab is switched to — pick up the same queue here so the
  // popup flow is identical no matter where the file landed. Keyed on `bump` so
  // dropping the same file twice still re-opens the form.
  useEffect(() => {
    if (!pendingFiles?.files?.length) return;
    processNextFile(pendingFiles.files);
    onPendingFilesHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles?.bump]);

  const handleTestConnection = async (dbType, config) => {
    let result;
    if (window.electronAPI?.dbConnect) {
      result = await window.electronAPI.dbConnect.test(dbType, config);
    } else if (!isLoggedIn()) {
      result = { success: false, message: 'Sign in or use the desktop app to test live database connections.' };
    } else {
      try {
        const response = await axios.post('/workflow/test-connection', { dbType, config }, {
          headers: { 'auth-token': localStorage.getItem('auth-token') },
        });
        result = response.data.success
          ? { success: true,  message: response.data.message || 'Connection successful!' }
          : { success: false, message: response.data.error   || 'Connection failed.' };
      } catch (err) {
        result = { success: false, message: err.response?.data?.error || 'Connection failed. Check your credentials.' };
      }
    }

    if (result.success) message.success(result.message || 'Connection successful!');
    else message.error(result.message || 'Connection failed.');
    return result;
  };

  const handleSaveDbConnection = async (connectionData) => {
    // The user hit X/Cancel while this file's import was still running — abort
    // the whole flow: don't save this connection and don't open the next file.
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setActiveDbType(null);
      setEditingConnection(null);
      setDroppedFile(null);
      setFileQueue([]);
      return;
    }

    const connectionId = editingConnection?.id || editingConnection?._id;
    const isEditing = Boolean(connectionId);
    const isFileConnection = connectionData.connectionType === 'file';

    // The forms validate this too, but a dropped-file batch derives its names
    // from filenames without the user ever seeing the field — so re-check here
    // before anything is written.
    if (isDuplicateConnectionName(connectionData.name, connections, editingConnection)) {
      message.error(`A connection named "${connectionData.name}" already exists.`);
      return;
    }

    // if (!isLoggedIn() || isFileConnection) {
      try {
        if (connectionData.connectionType === 'database' && connectionData.dbConfig && window.electronAPI?.dbCredentials) {
          const { dbConfig, ...connectionDataWithoutConfig } = connectionData;
          let sensitiveFields = {};
          let nonSensitiveConfig = {};
          const plugin = installedPlugins.find(p => p.id === connectionData.dbType);
          if (plugin && plugin.configSchema && plugin.configSchema.fields) {
            plugin.configSchema.fields.forEach(field => {
              const fieldValue = dbConfig[field.name];
              if (fieldValue !== undefined) {
                if (field.sensitive) sensitiveFields[field.name] = fieldValue;
                else nonSensitiveConfig[field.name] = fieldValue;
              }
            });
          } else {
            sensitiveFields = {
              password: dbConfig.password, username: dbConfig.username,
              host: dbConfig.host, uri: dbConfig.uri,
            };
            nonSensitiveConfig = {
              port: dbConfig.port, database: dbConfig.database, ssl: dbConfig.ssl,
              instanceName: dbConfig.instanceName, engine: dbConfig.engine, schema: dbConfig.schema,
            };
          }
          // keyValue fields come back from the edit form with their keys but
          // blank values — the renderer never pulls decrypted secrets out of
          // the keychain, so it can't echo them back. A blank value on a key
          // that already exists means "keep the stored one"; merge it in here,
          // because db-credentials:update replaces the blob wholesale.
          if (isEditing) {
            const kvFields = (plugin?.configSchema?.fields || [])
              .filter(f => f.type === 'keyValue' && f.sensitive && Array.isArray(sensitiveFields[f.name]));
            if (kvFields.length > 0) {
              const stored = (await window.electronAPI.dbCredentials.load(connectionId)) || {};
              kvFields.forEach(f => {
                const previous = new Map(
                  (Array.isArray(stored[f.name]) ? stored[f.name] : [])
                    .map(p => [String((p && p.key) || '').trim().toLowerCase(), (p && p.value) || ''])
                );
                sensitiveFields[f.name] = sensitiveFields[f.name].map(pair => {
                  if (pair.value !== '') return pair;
                  const prior = previous.get(String(pair.key || '').trim().toLowerCase());
                  return prior === undefined ? pair : { ...pair, value: prior };
                });
              });
            }
          }

          const safeConnectionData = { ...connectionDataWithoutConfig, dbConfig: nonSensitiveConfig };
          if (isEditing) {
            await connectionsDb.update(connectionId, safeConnectionData);
            await window.electronAPI.dbCredentials.update(connectionId, sensitiveFields, connectionData.dbType);
            setConnections(prev => prev.map(c =>
              (c.id || c._id) === connectionId ? { ...c, ...safeConnectionData } : c));
            message.success('Connection updated securely.');
          } else {
            const saved = await connectionsDb.save(safeConnectionData);
            await window.electronAPI.dbCredentials.save(saved.id, sensitiveFields);
            setConnections(prev => [saved, ...prev]);
            message.success('Connection saved securely.');
          }
        } else {
          if (isEditing) {
            await connectionsDb.update(connectionId, connectionData);
            setConnections(prev => prev.map(c =>
              (c.id || c._id) === connectionId ? { ...c, ...connectionData } : c));
            message.success('Connection updated.');
          } else {
            const saved = await connectionsDb.save(connectionData);
            setConnections(prev => [saved, ...prev]);
            message.success('Connection saved.');
          }
        }
        // Advance to the next dropped file (if any); otherwise this closes the
        // popup. For edits / manual DB connections the queue is empty, so this
        // behaves exactly like closing.
        processNextFile(fileQueue);
      } catch (error) {
        console.error('Error saving connection:', error);
        message.error(`Failed to ${isEditing ? 'update' : 'save'} connection.`);
      }
      return;
    // }

    // try {
    //   const payload = isEditing
    //     ? { ...connectionData, status: 'untested', connectionId }
    //     : { ...connectionData, status: 'untested' };
    //   const endpoint = isEditing ? '/workflow/connection-update' : '/workflow/connection-save';
    //   const response = await axios.post(endpoint, payload, {
    //     headers: { 'auth-token': localStorage.getItem('auth-token') },
    //   });
    //   if (response.data.success) {
    //     await fetchConnections();
    //     setActiveDbType(null);
    //     setEditingConnection(null);
    //     message.success(isEditing ? 'Connection updated.' : 'Connection saved.');
    //   } else {
    //     message.error(response.data.error || `Failed to ${isEditing ? 'update' : 'save'} connection.`);
    //   }
    // } catch (err) {
    //   if (handleAuthError(err)) return;
    //   message.error(`Failed to ${isEditing ? 'update' : 'save'} connection.`);
    // }
  };

  const handleEditConnection = (connection) => {
    cancelledRef.current = false;
    setFileQueue([]);
    setEditingConnection(connection);
    setDroppedFile(null);
    if (connection.connectionType === 'database') {
      setActiveDbType(connection.dbType);
    } else if (connection.connectionType === 'file') {
      // A local file's form follows the format the user picked (fileType), not
      // the engine reading it — every local file reports dbType 'duckdb', which
      // is not a form. Only fall back to the legacy upload modal for records
      // that carry neither.
      const fileType = connection.dbType === 'duckdb'
        ? (connection.fileType || 'spreadsheet')
        : (connection.dbType || connection.fileType);
      // A type with no form of its own opens in the spreadsheet form, which is
      // where re-picking the file puts it right.
      setActiveDbType(LOCAL_FILE_FORM_TYPES.includes(fileType) ? fileType : 'spreadsheet');
    } else {
      setActiveDbType('spreadsheet');
    }
  };

  const handleDeleteConnection = (connection) => {
    Modal.confirm({
      title: 'Delete Connection',
      content: 'Are you sure? This cannot be undone.',
      okText: 'Delete', okType: 'danger', cancelText: 'Cancel',
      async onOk() {
        const connectionId = connection.id || connection._id;
        // if (!isLoggedIn()) {
          await connectionsDb.delete(connectionId);
          if (connection.connectionType === 'database' && window.electronAPI?.dbCredentials) {
            await window.electronAPI.dbCredentials.delete(connectionId);
          }
          setConnections(prev => prev.filter(c => (c.id || c._id) !== connectionId));
          message.success('Connection deleted.');
          return;
        // }
        try {
          const response = await axios.post('/workflow/connection-action',
            { action: 'delete', connectionId },
            { headers: { 'Content-Type': 'application/json', 'auth-token': localStorage.getItem('auth-token') } });
          if (response.data.success) {
            setConnections(prev => prev.filter(c => c._id !== connectionId));
            message.success('Connection deleted.');
          } else {
            message.error(response.data.error || 'Failed to delete.');
          }
        } catch (error) {
          if (handleAuthError(error)) return;
          message.error('Failed to delete connection.');
        }
      },
    });
  };

  const handlePreviewData = async (connection) => {
    if (connection.connectionType === 'file') {
      if (connection.dbType === 'duckdb' || connection.dbType === 'sqlite' || connection.dbType === 'lancedb') {
        const filePath = connection.fileInfo?.filePath;
        if (!filePath) { message.error('File path not found'); return; }
        if (!window.electronAPI?.db?.readLocalCollection) {
          message.warning('Local database preview requires the desktop app.');
          return;
        }
        const hide = message.loading('Reading local database…', 0);
        try {
          const storageType = connection.dbType;
          // A DuckDB connection reads one file per table, so fileInfo.filePath
          // already identifies the data and the table name is only a label.
          // The legacy SQLite imports all share one app-wide db, where a null
          // tableName would read the first table in the file — which can belong
          // to an unrelated import — so those pass their own name explicitly.
          const ownTableName = connection.fileInfo?.tables?.[0] || null;
          const result = await window.electronAPI.db.readLocalCollection(filePath, 1000, storageType, null, ownTableName);
          hide();
          if (!result.success) { message.error('Failed to read database: ' + result.message); return; }
          const rows = result.rows || [];
          const cols = result.columns?.length
            ? result.columns.map((c) => (typeof c === 'string' ? c : c.name))
            : (rows.length > 0 ? Object.keys(rows[0]) : []);
          setPreviewData({
            connection,
            data: rows.map((r, i) => ({ ...r, _sampleIndex: i + 1 })),
            columns: cols,
            metadata: {
              totalRows: rows.length, dbType: connection.dbType,
              tables: result.tables || [], currentTable: result.currentTable,
            },
          });
          setPreviewOpen(true);
        } catch (err) { hide(); message.error('Failed to read database: ' + err.message); }
        return;
      }

      if (!window.electronAPI?.fileReader) {
        message.warning('Local file preview requires the desktop app.');
        return;
      }

      let filePath = connection.fileInfo?.filePath;
      if (!filePath) {
        const dialogResult = await window.electronAPI.openFileDialog();
        if (dialogResult.canceled || !dialogResult.filePaths?.length) return;
        filePath = dialogResult.filePaths[0];
      }

      const hide = message.loading('Reading local file…', 0);
      try {
        const result = await window.electronAPI.fileReader.readRows(filePath, 1000);
        hide();
        if (!result.success) { message.error('Failed to read file: ' + result.message); return; }
        const sheetName = result.sheets[0];
        const sheetData = result.data[sheetName];
        const rows = sheetData.rows.map((r, i) => ({ ...r, _sampleIndex: i + 1 }));
        const cols = sheetData.columns;
        setPreviewData({
          connection, data: rows, columns: cols,
          metadata: { sheets: result.sheets, activeSheet: sheetName, totalRows: rows.length },
        });
        setPreviewOpen(true);
      } catch (err) { hide(); message.error('Failed to read file: ' + err.message); }
      return;
    }

    try {
      message.loading('Loading sample data...', 2);
      const headers = { 'Content-Type': 'application/json', 'auth-token': localStorage.getItem('auth-token') };
      const response = await axios.post('/workflow/sample-data', { connectionId: connection.id, limit: 1000 }, { headers });
      if (response.data.success) {
        const sd = response.data.data;
        if (sd.availableSheets && sd.message) {
          const sr = await axios.post('/workflow/sample-data',
            { connectionId: connection.id, limit: 1000, sheetName: sd.availableSheets[0].sheetName }, { headers });
          if (sr.data.success) {
            const shd = sr.data.data;
            const rows = shd.sampleRows.map((r, i) => ({ ...r.data, _rowIndex: r.rowIndex, _sampleIndex: i + 1 }));
            const cols = shd.columnMappings?.map(c => c.name) || Object.keys(rows[0] || {}).filter(k => !k.startsWith('_'));
            setPreviewData({ connection, data: rows, columns: cols, metadata: { ...shd, availableSheets: sd.availableSheets } });
            setPreviewOpen(true);
            message.destroy();
            return;
          }
        }
        if (sd.sampleRows) {
          const rows = sd.sampleRows.map((r, i) => ({ ...r.data, _rowIndex: r.rowIndex, _sampleIndex: i + 1 }));
          const cols = sd.columnMappings?.map(c => c.name) || Object.keys(rows[0] || {}).filter(k => !k.startsWith('_'));
          setPreviewData({ connection, data: rows, columns: cols, metadata: sd });
          setPreviewOpen(true);
        } else {
          message.error('No sample data available.');
        }
      } else {
        message.error(response.data.error || 'Failed to load sample data.');
      }
      message.destroy();
    } catch (error) {
      if (handleAuthError(error)) return;
      message.error('Failed to load sample data.');
    }
  };

  const getModalTitle = (dbType) => {
    if (LOCAL_FILE_MODAL_TITLES[dbType]) return LOCAL_FILE_MODAL_TITLES[dbType];
    const plugin = installedPlugins.find(p => p.id === dbType);
    if (plugin) return `Connect to ${plugin.metadata?.displayName || plugin.name}`;
    return 'Connect to Database';
  };

  const getActiveFormComponent = () => {
    if (!activeDbType) return null;
    if (LOCAL_FILE_FORM_TYPES.includes(activeDbType)) {
      return () => (
        <LocalFileConnectionForm
          fileType={activeDbType}
          initialFile={droppedFile}
          onSave={handleSaveDbConnection}
          onCancel={() => { cancelledRef.current = true; setActiveDbType(null); setEditingConnection(null); setDroppedFile(null); setFileQueue([]); }}
          editingConnection={editingConnection}
          existingConnections={connections}
        />
      );
    }
    const plugin = installedPlugins.find(p => p.id === activeDbType);
    if (plugin) {
      return () => (
        <DynamicConnectionForm
          plugin={plugin}
          onSave={handleSaveDbConnection}
          onCancel={() => { setActiveDbType(null); setEditingConnection(null); }}
          onTest={handleTestConnection}
          editingConnection={editingConnection}
          existingConnections={connections}
        />
      );
    }
    return null;
  };

  const ActiveForm = getActiveFormComponent();

  // Filter options come from what is actually connected, so the bar never
  // offers a type that would match nothing.
  const categoryOptions = useMemo(() => {
    const present = new Set(connections.map(c => c.connectionType || 'file'));
    return ['database', 'file', 'api'].filter(c => present.has(c));
  }, [connections]);

  const typeOptions = useMemo(() => {
    const present = Array.from(new Set(connections.map(subTypeOf)));
    return present.sort((a, b) => typeCfgFor(a).label.localeCompare(typeCfgFor(b).label));
  }, [connections]);

  const filteredConnections = useMemo(() => connections.filter(conn => {
    if (filters.category && (conn.connectionType || 'file') !== filters.category) return false;
    if (filters.types.length > 0 && !filters.types.includes(subTypeOf(conn))) return false;
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      const haystack = [conn.name, conn.connectionName, conn.description, conn.fileInfo?.originalName]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }), [connections, filters]);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: C.surface, position: 'relative' }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PageHeader
        title="Data Source Connections"
        sub="Manage spreadsheet uploads and database connections"
        actions={[
          <Btn key="new" variant="primary" icon="plus" onClick={() => setTypeSelectorOpen(true)}>
            New Connection
          </Btn>,
        ]}
      />

      {isDragOver && <FileDropOverlay />}

      <div style={{
        flex: 1, overflow: 'auto', padding: 24,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {connections.length > 0 && (
          <FilterBar
            filters={filters}
            setFilters={setFilters}
            categories={categoryOptions}
            types={typeOptions}
          />
        )}

        {connections.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '60px 24px', background: '#fff',
            border: `1px dashed ${C.border2}`, borderRadius: 6, color: C.muted,
          }}>
            <div style={{ marginBottom: 8 }}>{I('db', C.dim, 32)}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              No connections yet
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>
              Upload a spreadsheet or connect to a database to get started
            </div>
          </div>
        ) : filteredConnections.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '40px 24px', background: '#fff',
            border: `1px dashed ${C.border2}`, borderRadius: 6, color: C.dim, fontSize: 12,
          }}>
            No connections match the current filters
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {filteredConnections.map(conn => (
                <ConnectionCard
                  key={conn.id || conn._id}
                  conn={conn}
                  plugin={installedPlugins.find(p => p.id === conn.dbType)}
                  onEdit={handleEditConnection}
                  onPreview={handlePreviewData}
                  onExplore={(c) => setExplorerConnection(c)}
                  onDelete={handleDeleteConnection}
                />
              ))}
            </div>
            {filteredConnections.length !== connections.length && (
              <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, textAlign: 'right' }}>
                {filteredConnections.length} of {connections.length} connections
              </div>
            )}
          </>
        )}
      </div>

      {/* Connection type picker */}
      <ConnectionTypeSelector
        open={isConnectionTypeSelectorOpen}
        onClose={() => setTypeSelectorOpen(false)}
        onSelectType={handleConnectionTypeSelect}
      />

      {/* Database connection form */}
      {ActiveForm && (
        <Modal
          // Remount the form per dropped file so its name/state resets cleanly
          // between consecutive uploads of the same file type.
          key={droppedFile ? `${droppedFile.name}-${droppedFile.lastModified}` : activeDbType}
          title={getModalTitle(activeDbType)}
          open={Boolean(activeDbType)}
          onCancel={() => {
            if (window.electronAPI?.oauth?.cancelServer) window.electronAPI.oauth.cancelServer(3000);
            cancelledRef.current = true; // stop any in-flight save from advancing
            setActiveDbType(null);
            setEditingConnection(null);
            setDroppedFile(null);
            setFileQueue([]); // dropping the queue exits the multi-file flow
          }}
          footer={null}
          width={640}
          destroyOnClose
        >
          <ActiveForm />
        </Modal>
      )}

      {/* Data preview */}
      <DataPreviewModal
        open={isPreviewOpen}
        data={previewData}
        onClose={() => setPreviewOpen(false)}
      />

      {/* Database explorer — its own title bar carries the connection name and
          the close button, so it fills the overlay without a second frame
          around it. */}
      {explorerConnection && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15,23,42,0.44)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            // 5% gap all round. Percentage padding resolves against the
            // overlay's width, so the vertical side uses vh to stay at 5%.
            padding: '1vh 1%',
          }}
          onMouseDown={(e) => {
            // Click the backdrop to dismiss; clicks inside must not bubble out.
            if (e.target === e.currentTarget) {
              setExplorerQuery(null);
              setExplorerConnection(null);
            }
          }}
        >
          <div style={{
            width: '100%', height: '100%',
            background: '#fff', borderRadius: 12, overflow: 'hidden',
            border: '1px solid #e2e6eb', boxShadow: '0 32px 90px rgba(15,23,42,0.34)',
          }}>
            <DatabaseExplorer
              connection={explorerConnection}
              onClose={() => { setExplorerQuery(null); setExplorerConnection(null); }}
              onContextChange={setExplorerQuery}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectionsTab;
