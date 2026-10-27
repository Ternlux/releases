import React from 'react';
import { Handle, Position } from 'reactflow';
import { MailOutlined, ExportOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, nodeDisplayName, truncate, NODE_COLORS, DestinationFooter, WriteModeRow } from './nodeCardShared';

const COLOR = NODE_COLORS.output;
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';

const OutputNode = ({ data, selected }) => {
  const isConfigured = !!(data.config?.outputSettings?.outputType);

  // What the settings alone call this node, used as the last resort below.
  const settingsName = () => {
    const outputSettings = data.config?.outputSettings;
    if (!outputSettings?.outputType) return 'Output';

    if (outputSettings.outputType === 'local') {
      const format = outputSettings.format?.toUpperCase() || 'FILE';
      return `Export to ${format}`;
    } else if (outputSettings.outputType === 'connection') {
      return outputSettings.objectName || outputSettings.tableName || 'Database Export';
    }

    return 'Output';
  };

  // Named by nodeDisplayName, like every other card — a name the user chose,
  // then the label, then whatever the config identifies. This node used to read
  // its settings and nothing else, so it was the one card with nothing to show
  // before those settings exist: while the AI builder writes a workflow it
  // draws each node as it starts, config still empty, and the label off the
  // build plan ("Export enriched orders to CSV") is all any card has to go on.
  // Every other type already showed it; this one sat there reading "Output".
  const getDisplayName = () => nodeDisplayName('output', data, settingsName());

  const getOutputIcon = () => {
    const outputSettings = data.config?.outputSettings;

    if (outputSettings?.outputType === 'connection') {
      return <MailOutlined style={{ fontSize: 12, color: COLOR }} />;
    }

    return <ExportOutlined style={{ fontSize: 12, color: COLOR }} />;
  };

  const getSummary = () => {
    if (!isConfigured) {
      // Mid-build the settings don't exist yet, but the instruction that is
      // being turned into them does — say that rather than asking the user to
      // configure a node nobody has finished writing.
      const request = data.config?.builderPrompt || data.config?.outputDescription;
      return request ? truncate(request) : 'Click to configure output';
    }

    const outputSettings = data.config?.outputSettings;

    if (outputSettings.outputType === 'local') {
      const format = outputSettings.format?.toUpperCase() || 'file';
      const fileName = outputSettings.savePath ? outputSettings.savePath.split('/').pop() : 'output file';
      return `Export data to ${format} file: ${fileName}`;
    } else if (outputSettings.outputType === 'connection') {
      // The DESTINATION table only. This used to append
      // `config.sourceConnectionName` as though it named the destination — it
      // names where the node READS from, so an output reading LanceDB and
      // writing MySQL labelled itself "(Local LanceDB)". The connection it
      // actually writes to is resolved from outputSettings.connectionId and
      // shown by the DestinationFooter below.
      // A cloud object is uploaded, not inserted into.
      if (outputSettings.objectPath) return `Upload to ${outputSettings.objectPath}`;
      return `Insert data into ${outputSettings.tableName}`;
    }

    return 'Output configured';
  };

  const latestCodes = extractLatestCodes(data.config?.chat);

  return (
    <div
      style={{
        width: 264,
        background: '#fff',
        border: `1px solid ${selected ? COLOR : BORDER}`,
        borderLeft: `3px solid ${COLOR}`,
        borderRadius: 6,
        boxShadow: selected
          ? `0 0 0 3px ${COLOR}1a, 0 4px 16px rgba(0,0,0,0.12)`
          : '0 1px 4px rgba(0,0,0,0.07)',
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
        {getOutputIcon()}
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          OUTPUT
        </span>
        <div style={{
          marginLeft: 'auto',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isConfigured ? GREEN : BORDER,
        }} />
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
      </div>

      <ExpandableCodes codes={latestCodes} />

      <WriteModeRow type="output" config={data.config || {}} accent={COLOR} />
      <DestinationFooter type="output" config={data.config || {}} accent={COLOR} />
    </div>
  );
};

export default OutputNode;
