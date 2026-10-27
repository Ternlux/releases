import React from 'react';
import { Handle, Position } from 'reactflow';
import {
  DatabaseOutlined, ApiOutlined, FileOutlined, FileTextOutlined, FileExcelOutlined,
} from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, describeNode, nodeDisplayName, truncate, NODE_COLORS, connectorIconFor, SourceFooter } from './nodeCardShared';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as ParquetIcon } from '../../ConnectorImages/Parquet.svg';
import { ReactComponent as AvroIcon } from '../../ConnectorImages/Avro.svg';

const COLOR = NODE_COLORS.dataSource;
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';
const RED = '#dc2626';

// One connector-icon map for the whole canvas — see CONNECTOR_ICONS. A second
// copy lived here and fell behind: BigQuery, Snowflake and Slack had SVGs in
// the tree that no source badge ever rendered.
const getDbIcon = (dbType) => connectorIconFor(dbType);

const FILE_ICONS = {
  csv: FileTextOutlined,
  excel: FileExcelOutlined,
  json: FileTextOutlined,
  parquet: ParquetIcon,
  avro: AvroIcon,
  sqlite: SqlliteIcon,
};

/**
 * The format a local file source was added as. Every one of them is read by
 * DuckDB, so `sourceDbType` is the same for a CSV and a Parquet file and can't
 * tell them apart — `sourceType` carries the connection's own file type, and
 * since 'spreadsheet' covers CSV and Excel alike, the read format breaks that
 * tie (an Excel workbook is converted to Parquet on import, a CSV is not).
 */
const fileTypeOf = (config) => {
  if (config.sourceConnectionType !== 'file') return null;
  if (config.sourceType === 'spreadsheet') return config.sourceFormat === 'csv' ? 'csv' : 'excel';
  if (FILE_ICONS[config.sourceType]) return config.sourceType;
  return config.sourceFormat || null; // csv | json | parquet
};

/**
 * A node config records its connector as `sourceDbType`; a bare `dbType` is
 * the shape a saved *connection* has, so the old lookup never matched and
 * every source on the canvas fell back to the generic database glyph.
 */
const getSourceIcon = (config) => {
  if (config.sourceConnectionType === 'api') return ApiOutlined;
  const fileType = fileTypeOf(config);
  if (fileType && FILE_ICONS[fileType]) return FILE_ICONS[fileType];
  const dbIcon = getDbIcon(config.sourceDbType || config.dbType);
  if (dbIcon) return dbIcon;
  // A file whose format didn't survive the import — a cloud download, say —
  // is still a file, not a database.
  return config.sourceConnectionType === 'file' ? FileOutlined : null;
};

/** A REST API source — no connection/table pair to name, so it reads differently. */
const isApiSource = (config) =>
  config.sourceConnectionType === 'api' || !!config.apiConnectionPublicConfig;

const DataSourceNode = ({ data, selected }) => {
  const config = data.config || {};
  const isConfigured = config.sourceConnectionId &&
    (config.sourceType === 'csv' || config.table || config.dataset || config.sourceType);
  // An API source has no connection/table pair to put in the footer — the
  // endpoint is the whole story, so it keeps the prose summary and its code
  // instead. Every other source is identified the way an output is: the
  // connection it reads through and the table it reads there.
  const isApi = isApiSource(config);

  const SourceIconComponent = getSourceIcon(config);

  // The saved connection this source reads through has been deleted (set by
  // the editor from the live connection list — see nodesWithConnectionState).
  // Red like a transformer whose parent moved: the node cannot run until it
  // is pointed at a connection that exists.
  const connectionMissing = !!data.connectionMissing;
  const connectionName = config.sourceConnectionName || config.connectionName || null;

  // Named by nodeDisplayName, in step with every other surface that names a
  // node; the connection and table it reads are spelled out by the footer.
  const getDisplayName = () =>
    nodeDisplayName('dataSource', data, isConfigured ? 'Configured Data Source' : 'Data Source');

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure data source';

    // What this node reads, named from its own config — the same fields the
    // Data Preview header shows. An explanation only fills in when the config
    // has nothing to identify yet.
    const described = describeNode('dataSource', config);
    if (described) return described;

    const explanation =
      config.apiFetchExplanation ||
      config.sourceExplanation ||
      config.sourceSqlExplanation ||
      config.sourceQueryDescription;
    if (explanation) return truncate(explanation);

    return 'Data source configured';
  };

  // The code dropdown belongs to the API source too: a table read has no code
  // of its own worth unfolding on the card.
  const latestCodes = isApi ? extractLatestCodes(data.config?.chat) : [];

  return (
    <div
      className={connectionMissing ? 'wf-node-source-changed' : undefined}
      style={{
        width: 264,
        background: '#fff',
        border: `1px solid ${connectionMissing ? RED : (selected ? COLOR : BORDER)}`,
        borderLeft: `3px solid ${connectionMissing ? RED : COLOR}`,
        borderRadius: 6,
        // The pulse owns the shadow while the connection is missing — see
        // .wf-node-source-changed in Workflows.css.
        boxShadow: connectionMissing
          ? undefined
          : (selected
            ? `0 0 0 3px ${COLOR}1a, 0 4px 16px rgba(0,0,0,0.12)`
            : '0 1px 4px rgba(0,0,0,0.07)'),
        position: 'relative',
        userSelect: 'none',
        fontFamily: "'Inter',-apple-system,sans-serif",
        opacity: isConfigured ? 1 : 0.9,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: COLOR,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          left: -6,
          boxShadow: `0 0 0 1px ${COLOR}44`,
        }}
      />

      {/* Header */}
      <div style={{
        padding: '7px 10px',
        borderBottom: '1px solid #f0f2f5',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}>
        {/* One style for both kinds of icon: an imported SVG paints from
            width/height/fill, an antd glyph from fontSize/color. */}
        {SourceIconComponent ? (
          <SourceIconComponent style={{ width: 12, height: 12, fill: COLOR, fontSize: 12, color: COLOR }} />
        ) : (
          <DatabaseOutlined style={{ fontSize: 12, color: COLOR }} />
        )}
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          DATA SOURCE
        </span>
        <div
          title={connectionMissing ? 'The connection this source reads through was deleted.' : undefined}
          style={{
            marginLeft: 'auto',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: connectionMissing ? RED : (isConfigured ? GREEN : BORDER),
          }}
        />
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: TEXT,
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {getDisplayName()}
        </div>
        {connectionMissing && (
          <div style={{
            fontSize: 10,
            fontFamily: MONO,
            color: RED,
            background: '#fef2f2',
            border: `1px solid ${RED}33`,
            borderRadius: 4,
            padding: '3px 6px',
            marginBottom: 5,
            lineHeight: 1.4,
            whiteSpace: 'normal',
          }}>
            CONNECTION DELETED{connectionName ? ` — ${connectionName}` : ''} — pick another connection, or add it back (it reconnects on its own)
          </div>
        )}
        {(isApi || !isConfigured) && (
          <div style={{
            fontSize: 11,
            color: MUTED,
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {getSummary()}
          </div>
        )}
      </div>

      <ExpandableCodes codes={latestCodes} />

      {!isApi && <SourceFooter config={config} accent={COLOR} />}

      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: COLOR,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          right: -6,
          boxShadow: `0 0 0 1px ${COLOR}44`,
        }}
      />
    </div>
  );
};

export default DataSourceNode;
