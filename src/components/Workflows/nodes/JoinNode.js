import React, { useEffect } from 'react';
import { Handle, Position, useStore, useUpdateNodeInternals } from 'reactflow';
import { MergeOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, describeNode, nodeDisplayName, truncate, NODE_COLORS, DestinationFooter, sourceIssueLabel, joinInputHandleId, joinInputHandleCount, WriteModeRow } from './nodeCardShared';
import SourceChangedPopup from './SourceChangedPopup';

const COLOR = NODE_COLORS.join;
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';
const RED = '#dc2626';

const JoinNode = ({ id, data, selected }) => {
  // Matches how the Data Preview decides a join is configured. The chat saves
  // the generated function as `transformFunction`; `javascriptFunction` is
  // only the AI's field name and never lands on the config.
  const config = data.config || {};
  const isConfigured = !!(
    config.sourcesConfig ||
    config.joinSql ||
    config.targetSql ||
    config.aggregationPipeline ||
    config.transformFunction ||
    config.javascriptFunction
  );

  // Named by nodeDisplayName — see TransformerNode for why the config, not
  // the creation-time label, is what names a node.
  const getDisplayName = () => nodeDisplayName('join', data, 'Join');

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure join operation';

    // Which sources are joined and where the result lands, named from the
    // config — the same rows the Data Preview's Details tab lists.
    const described = describeNode('join', config);
    if (described) return described;

    const explanation = config.explanation || config.joinRequest || config.joinDescription;
    if (explanation) return truncate(explanation);

    if (config.sourcesConfig?.length > 0) {
      const sourceCount = config.sourcesConfig.length;
      const targetName = config.targetTableName || config.targetCollection || 'result';
      return `Joining ${sourceCount} source${sourceCount > 1 ? 's' : ''} into ${targetName}`;
    }

    return 'Join operation configured';
  };

  const latestCodes = extractLatestCodes(data.config?.chat);

  // One input dot per edge that lands here (never fewer than two), spread down
  // the left edge so each incoming edge ends on a dot of its own instead of
  // every one of them stacking on the top handle. ReactFlow measures handles
  // once per node, so adding or removing a dot has to ask it to re-measure —
  // an unmeasured handle is one an edge can't be routed to.
  const inputCount = useStore((s) => joinInputHandleCount(s.edges, id));
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, inputCount, updateNodeInternals]);

  // Fed by sources other than the ones this join was written against.
  // `sourceBuiltAgainst` names those originals so the card can show them
  // rather than node ids; both clear on re-attach or regeneration.
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
      {/* See TransformerNode — same prompt, and a join can have several
          parents, so it names every source that moved. */}
      <SourceChangedPopup nodeId={id} config={config} nodeTypeLabel="join" />
    <div
      className={sourceChanged ? 'wf-node-source-changed' : undefined}
      style={{
        width: 264,
        background: '#fff',
        border: `1px solid ${sourceChanged ? RED : (selected ? COLOR : BORDER)}`,
        borderLeft: `3px solid ${sourceChanged ? RED : COLOR}`,
        borderRadius: 6,
        // The pulse owns the shadow while the sources are wrong — see
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
      {Array.from({ length: inputCount }, (_, i) => (
        <Handle
          key={joinInputHandleId(i)}
          type="target"
          position={Position.Left}
          id={joinInputHandleId(i)}
          style={{
            background: COLOR,
            border: '2px solid #fff',
            width: 10,
            height: 10,
            left: -6,
            // Evenly spaced down the card: two inputs sit at a third and two
            // thirds of its height, three at a quarter each, and so on.
            top: `${((i + 1) * 100) / (inputCount + 1)}%`,
            boxShadow: `0 0 0 1px ${COLOR}44`,
          }}
        />
      ))}

      {/* Header */}
      <div style={{
        padding: '7px 10px',
        borderBottom: '1px solid #f0f2f5',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}>
        <MergeOutlined style={{ fontSize: 12, color: COLOR }} />
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          JOIN
        </span>
        <div
          title={sourceChanged
            ? `Built against ${builtAgainst || 'other sources'} — reconnect them, or open the node to regenerate.`
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

      <WriteModeRow type="join" config={config} accent={COLOR} />
      <DestinationFooter type="join" config={config} accent={COLOR} />

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

export default JoinNode;
