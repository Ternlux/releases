/**
 * The "your input moved" prompt that sits over a transformer or join card.
 *
 * A transformer's SQL and a join's join condition NAME their input. When that
 * input moves — rewired to another node, rebuilt onto another connection or
 * table, or simply returning different columns — the node goes on running logic
 * written for something that is no longer there. syncNodeSourcesToEdges detects
 * that and flags the node (see `sourceChanged`); this is where the user answers
 * it, without having to open the node to find out what happened.
 *
 * Two answers, both final:
 *
 *   Keep as is  — the logic still holds. The current input becomes the node's
 *                 new baseline and the prompt goes away.
 *   Rebuild     — hand it to the assistant. The editor opens a fresh chat with
 *                 a request naming this node and what changed about its input.
 *
 * Rendered through ReactFlow's NodeToolbar so it floats above the card in the
 * canvas's own portal — over neighbouring nodes and edges rather than under
 * them, and without growing the node's own box.
 */

import React from 'react';
import { NodeToolbar, Position } from 'reactflow';
import { SOURCE_CHANGE_KINDS } from '../../../utils/workflowUtils';

const RED = '#dc2626';
const TEXT = '#111827';
const MUTED = '#5a6678';
const MONO = "'JetBrains Mono', monospace";

/** Both sides of the change, named the way the canvas names things. */
const describe = (kind, builtAgainst = [], changedTo = []) => {
  const was = builtAgainst.map((b) => b?.dataset || b?.nodeLabel || b?.nodeId).filter(Boolean).join(', ');
  const now = changedTo.map((t) => t?.dataset || t?.nodeLabel || t?.nodeId).filter(Boolean).join(', ');

  if (kind === SOURCE_CHANGE_KINDS.REWIRED) {
    const fromNodes = builtAgainst.map((b) => b?.nodeLabel || b?.nodeId).filter(Boolean).join(', ');
    const toNodes = changedTo.map((t) => t?.nodeLabel || t?.nodeId).filter(Boolean).join(', ');
    return {
      title: 'This node was rewired',
      detail: `Built against ${fromNodes || 'another node'} — now reads ${toNodes || 'something else'}.`,
    };
  }

  if (kind === SOURCE_CHANGE_KINDS.SCHEMA) {
    // Name the columns that actually moved; a bare "columns changed" leaves the
    // user opening the node to find out which.
    const before = new Set(builtAgainst.flatMap((b) => b?.columns || []));
    const after = new Set(changedTo.flatMap((t) => t?.columns || []));
    const added = [...after].filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !after.has(c));
    const parts = [];
    if (added.length) parts.push(`+${added.join(', +')}`);
    if (removed.length) parts.push(`−${removed.join(', −')}`);
    return {
      title: 'Source columns changed',
      detail: parts.length ? parts.join('  ') : `${now || 'The source'} returns different columns.`,
    };
  }

  return {
    title: 'Source moved',
    detail: `Built against ${was || 'another dataset'} — now reads ${now || 'something else'}.`,
  };
};

const buttonStyle = (primary) => ({
  flex: 1,
  padding: '5px 10px',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 5,
  cursor: 'pointer',
  lineHeight: 1.2,
  border: `1px solid ${primary ? RED : '#d8dde4'}`,
  background: primary ? RED : '#fff',
  color: primary ? '#fff' : TEXT,
});

const SourceChangedPopup = ({ nodeId, config = {}, nodeTypeLabel = 'node' }) => {
  if (!config.sourceChanged) return null;

  const { title, detail } = describe(
    config.sourceChangeKind,
    config.sourceBuiltAgainst || [],
    config.sourceChangedTo || [],
  );

  // The canvas owns what happens next — it has the nodes, the chat bridge and
  // the unsaved-changes bookkeeping — so the buttons only say which node was
  // answered and how. Same window-event bus the rest of the editor uses.
  const answer = (event) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.dispatchEvent(new CustomEvent(event, { detail: { nodeId } }));
  };

  return (
    <NodeToolbar isVisible position={Position.Top} offset={10}>
      <div
        // A click in here is an answer to the prompt, never a click on the node
        // underneath (which would open its config panel).
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 264,
          background: '#fff',
          border: `1px solid ${RED}`,
          borderRadius: 8,
          boxShadow: '0 6px 20px rgba(17, 24, 39, 0.16)',
          padding: '9px 10px',
          textAlign: 'left',
          cursor: 'default',
        }}
      >
        <div style={{
          fontSize: 10,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: RED,
          marginBottom: 4,
        }}>
          {title}
        </div>

        <div style={{ fontSize: 11, color: TEXT, lineHeight: 1.45, marginBottom: 3 }}>
          {detail}
        </div>

        <div style={{ fontSize: 10.5, color: MUTED, lineHeight: 1.4, marginBottom: 8 }}>
          This {nodeTypeLabel}&apos;s logic still targets the old one.
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            style={buttonStyle(false)}
            title="The logic still holds — stop flagging this node"
            onClick={answer('ternlux:node-source-confirm')}
          >
            Keep as is
          </button>
          <button
            type="button"
            style={buttonStyle(true)}
            title="Ask the assistant to rebuild this node for its new input"
            onClick={answer('ternlux:node-source-rebuild')}
          >
            Rebuild
          </button>
        </div>
      </div>
    </NodeToolbar>
  );
};

export default SourceChangedPopup;
