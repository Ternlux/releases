import React from 'react';
import { Handle, Position } from 'reactflow';
import { SettingOutlined, EditOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, describeNode, nodeDisplayName, truncate, NODE_COLORS, DestinationFooter, sourceIssueLabel, WriteModeRow } from './nodeCardShared';
import SourceChangedPopup from './SourceChangedPopup';

const COLOR = NODE_COLORS.transformer;
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';
const RED = '#dc2626';

const TransformerNode = ({ id, data, selected }) => {
  // Matches how the Data Preview decides a transformer is configured: the
  // chat saves targetSql / nosqlOperation / transformFunction, never a bare
  // `sql`, so the old check left finished nodes reading "Click to configure".
  const config = data.config || {};
  const isConfigured = !!(
    (config.usesSkill && config.skillId) ||
    config.targetSql ||
    config.targetInsertSql ||
    config.nosqlOperation ||
    config.transformFunction ||
    config.sql ||
    config.transformationRequest
  );

  // Named by nodeDisplayName so the card, the steps editor and the run log
  // agree — and so a node built through chat stops reading "Transformer".
  const getDisplayName = () => nodeDisplayName('transformer', data, 'Transformer');

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure transformation';

    // What this node reads and writes, named from its own config — the same
    // source and target the Data Preview's Details tab lists.
    const described = describeNode('transformer', config);
    if (described) return described;

    const explanation =
      config.targetSqlExplanation ||
      config.sqlExplanation ||
      config.explanation ||
      config.transformationRequest;
    if (explanation) return truncate(explanation);

    return 'Transformation configured';
  };

  const latestCodes = extractLatestCodes(data.config?.chat);

  // Fed by something other than what this transformation was written against.
  // `sourceBuiltAgainst` names that original parent, so the card can say which
  // source the SQL below still targets instead of showing a node id. Both are
  // cleared when the original is re-attached or the node is regenerated.
  const builtAgainst = (config.sourceBuiltAgainst || [])
    .map((b) => b?.nodeLabel || b?.nodeId)
    .filter(Boolean)
    .join(', ');
  // Red for either reason — the input moved, or the node is blocked from
  // running. Only the first is answerable by "Keep as is"; see sourceIssueLabel.
  const sourceIssue = sourceIssueLabel(config, builtAgainst);
  const sourceChanged = !!sourceIssue;

  return (
    <>
      {/* Floats above the card, in ReactFlow's portal — the user answers the
          change here instead of opening the node to work out what moved. */}
      <SourceChangedPopup nodeId={id} config={config} nodeTypeLabel="transformation" />
    <div
      className={sourceChanged ? 'wf-node-source-changed' : undefined}
      style={{
        width: 264,
        background: '#fff',
        border: `1px solid ${sourceChanged ? RED : (selected ? COLOR : BORDER)}`,
        borderLeft: `3px solid ${sourceChanged ? RED : COLOR}`,
        borderRadius: 6,
        // The pulse owns the shadow while the input is wrong — see
        // .wf-node-source-changed in Workflows.css.
        boxShadow: sourceChanged
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
        {isConfigured
          ? <EditOutlined style={{ fontSize: 12, color: COLOR }} />
          : <SettingOutlined style={{ fontSize: 12, color: COLOR }} />}
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          TRANSFORM
        </span>
        {/* Amber once the node feeding this one has changed: the logic below
            was written against the previous input and needs regenerating. */}
        <div
          title={sourceChanged
            ? `Built against ${builtAgainst || 'another source'} — reconnect it, or open the node to regenerate.`
            : undefined}
          style={{
            marginLeft: 'auto',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: sourceChanged ? RED : (isConfigured ? GREEN : BORDER),
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
        {sourceChanged && (
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
            {sourceIssue}
          </div>
        )}
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

      <WriteModeRow type="transformer" config={config} accent={COLOR} />
      <DestinationFooter type="transformer" config={config} accent={COLOR} />

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
    </>
  );
};

export default TransformerNode;
