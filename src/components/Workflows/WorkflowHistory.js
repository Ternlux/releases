/**
 * WorkflowHistory.js — the version history of one workflow.
 *
 * Left: every recorded version, newest first. Right: what that save changed
 * against the version before it, down to the individual node — a side-by-side
 * before/after of the node object, the way a commit diff reads.
 *
 * Versions come from workflowHistoryDb (collection `workflowHistory`, keyed by
 * workflowId). Each one holds a full snapshot, so "Revert to this version"
 * hands that snapshot straight back to the editor.
 *
 * Reverting loads the snapshot onto the CANVAS and marks it unsaved; it does
 * not write to the workflow record on its own. That is deliberate — the editor
 * has exactly one path that persists (the Save button), and a revert the user
 * can still walk away from is the same promise every other edit makes.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Spin, Empty, message } from 'antd';
import moment from 'moment';
import { C, MONO, SANS, Btn, Tag } from './_designShared';
import { workflowHistoryDb } from '../../utils/localDb';
import { diffSnapshots, sideBySideLines, MAX_VERSIONS } from '../../utils/workflowHistory';
import { nodeDisplayName } from './nodes/nodeCardShared';

const NODE_TYPE_NAMES = {
  start: 'Start',
  dataSource: 'Data Source',
  transformer: 'Transformer',
  join: 'Join',
  output: 'Data Export',
};

// How each kind of change is coloured, everywhere it appears.
const CHANGE_STYLE = {
  added:    { label: 'ADDED',    color: C.green, bg: C.gD,  border: C.gB },
  modified: { label: 'CHANGED',  color: C.amber, bg: C.amD, border: 'rgba(217,119,6,0.22)' },
  removed:  { label: 'REMOVED',  color: C.red,   bg: C.rD,  border: 'rgba(220,38,38,0.22)' },
};

// What put the version there. 'save' is the common case and says nothing
// useful, so it is the only one without a badge.
//   revert        — the save that committed a revert to an earlier version
//   ai-build      — written by the assistant's builder in the main process
//   external-edit — the workflow's code files were changed on disk
//   load          — the state found in the database when the editor opened it,
//                   which is what seeds the history for an older workflow
const SOURCE_LABEL = {
  revert: 'REVERT',
  'ai-build': 'ASSISTANT',
  'external-edit': 'ON DISK',
  load: 'BASELINE',
  import: 'IMPORT',
};

const LINE_BG = {
  added:   'rgba(5,150,105,0.10)',
  removed: 'rgba(220,38,38,0.09)',
  same:    'transparent',
  pad:     'rgba(0,0,0,0.02)',
};

// ── Version list ───────────────────────────────────────────────────────────

const CountChip = ({ n, kind }) => {
  if (!n) return null;
  const s = CHANGE_STYLE[kind];
  const sign = kind === 'added' ? '+' : kind === 'removed' ? '−' : '~';
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, fontWeight: 600,
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: 3, padding: '1px 5px',
    }}>
      {sign}{n}
    </span>
  );
};

const VersionRow = ({ entry, isLatest, selected, onSelect }) => {
  const [hov, setHov] = useState(false);
  const counts = entry.counts || {};
  const sourceTag = SOURCE_LABEL[entry.source];

  return (
    <div
      onClick={() => onSelect(entry)}
      onMouseOver={() => setHov(true)}
      onMouseOut={() => setHov(false)}
      style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${C.border}`,
        borderLeft: `3px solid ${selected ? C.accent : 'transparent'}`,
        background: selected ? C.aD : hov ? C.surface : '#fff',
        cursor: 'pointer',
        transition: 'background 0.12s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: selected ? C.accent : C.text }}>
          v{entry.version}
        </span>
        {isLatest && <Tag color={C.accent} bg={C.aD} border="rgba(37,99,235,0.18)">LATEST</Tag>}
        {sourceTag && <Tag color={C.violet} bg={C.vD} border="rgba(124,58,237,0.18)">{sourceTag}</Tag>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <CountChip n={counts.nodesAdded} kind="added" />
          <CountChip n={counts.nodesModified} kind="modified" />
          <CountChip n={counts.nodesRemoved} kind="removed" />
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.text, fontFamily: SANS, lineHeight: 1.35 }}>
        {entry.label || entry.summary}
      </div>
      <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginTop: 3 }}>
        {moment(entry.timestamp).format('MMM D, YYYY HH:mm:ss')}
        {' · '}
        {entry.nodeCount} node{entry.nodeCount === 1 ? '' : 's'}
      </div>
    </div>
  );
};

// ── Node diff ──────────────────────────────────────────────────────────────

const DiffColumn = ({ title, lines, empty }) => (
  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{
      padding: '4px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      fontFamily: MONO, color: C.muted, background: C.s2, borderBottom: `1px solid ${C.border}`,
    }}>
      {title}
    </div>
    <div style={{ overflowX: 'auto', flex: 1 }}>
      {lines.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 11, color: C.dim, fontFamily: MONO }}>{empty}</div>
      ) : lines.map((line, i) => (
        <div
          key={i}
          style={{
            display: 'flex', gap: 8,
            background: LINE_BG[line.state],
            fontFamily: MONO, fontSize: 11, lineHeight: '17px', whiteSpace: 'pre',
          }}
        >
          <span style={{ width: 30, flexShrink: 0, textAlign: 'right', color: C.dim, userSelect: 'none' }}>
            {line.text === null ? '' : i + 1}
          </span>
          <span style={{ color: line.state === 'pad' ? 'transparent' : C.text, paddingRight: 12 }}>
            {line.text === null ? ' ' : line.text}
          </span>
        </div>
      ))}
    </div>
  </div>
);

const NodeChange = ({ change }) => {
  const [open, setOpen] = useState(false);
  const style = CHANGE_STYLE[change.change];
  const node = change.after || change.before;
  const name = nodeDisplayName(node?.type, node?.data, change.nodeId);
  const typeName = NODE_TYPE_NAMES[node?.type] || node?.type || 'Node';

  // Only computed once the row is opened — a version that touched ten nodes
  // would otherwise serialize and align twenty node objects to draw a list.
  const diffLines = useMemo(
    () => (open ? sideBySideLines(change.before, change.after) : null),
    [open, change.before, change.after],
  );

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 8, overflow: 'hidden', background: '#fff' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          cursor: 'pointer', background: open ? C.surface : '#fff',
        }}
      >
        <span style={{
          fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
          color: style.color, background: style.bg, border: `1px solid ${style.border}`,
          borderRadius: 3, padding: '2px 6px', flexShrink: 0,
        }}>
          {style.label}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: SANS }}>{name}</span>
        <span style={{ fontSize: 11, color: C.muted, fontFamily: SANS }}>{typeName}</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>{change.nodeId}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.accent, fontFamily: SANS }}>
          {open ? 'Hide' : 'View'} before / after
        </span>
      </div>

      {/* Which fields moved — the headline of a "changed" row, and often all
          the user needs to read before deciding whether to open the diff. */}
      {change.fields?.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 4,
          padding: '0 12px 8px 12px', background: open ? C.surface : '#fff',
        }}>
          {change.fields.map((f) => (
            <span key={f} style={{
              fontFamily: MONO, fontSize: 10, color: C.muted,
              background: C.s2, borderRadius: 3, padding: '1px 6px',
            }}>
              {f}
            </span>
          ))}
        </div>
      )}

      {open && diffLines && (
        <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, maxHeight: 340, overflowY: 'auto' }}>
          <DiffColumn title="BEFORE" lines={diffLines.left} empty="Node did not exist" />
          <div style={{ width: 1, background: C.border }} />
          <DiffColumn title="AFTER" lines={diffLines.right} empty="Node was removed" />
        </div>
      )}
    </div>
  );
};

const TextChange = ({ label, change }) => (
  <div style={{
    border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px',
    marginBottom: 8, background: '#fff',
  }}>
    <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, fontFamily: SANS, marginBottom: 4 }}>{label}</div>
    <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, textDecoration: 'line-through', wordBreak: 'break-word' }}>
      {change.before || '(empty)'}
    </div>
    <div style={{ fontFamily: MONO, fontSize: 11, color: C.green, wordBreak: 'break-word' }}>
      {change.after || '(empty)'}
    </div>
  </div>
);

// ── Detail pane ────────────────────────────────────────────────────────────

const VersionDetail = ({ entry, previous, isLatest, onRevert, reverting }) => {
  // Recomputed from the two snapshots rather than read from the entry: the
  // snapshots are the stored truth, and a diff derived from them can never
  // disagree with what a revert would actually restore.
  const diff = useMemo(
    () => (entry ? diffSnapshots(previous?.snapshot || null, entry.snapshot) : null),
    [entry, previous],
  );

  if (!entry) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty description="Select a version to see what changed" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  // Nothing to diff against: either this is the first version ever recorded, or
  // the one before it has been pruned. Either way the whole workflow reads as
  // added, and "renamed" / "description edited" against an empty baseline is
  // noise rather than information.
  const noBaseline = !previous;
  const isPruned = noBaseline && entry.version > 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: '#fff',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: SANS }}>
            Version {entry.version}
            {isLatest && <span style={{ color: C.muted, fontWeight: 400 }}> — current saved version</span>}
          </div>
          <div style={{ fontSize: 11, color: C.muted, fontFamily: MONO, marginTop: 2 }}>
            {moment(entry.timestamp).format('dddd, MMM D YYYY, HH:mm:ss')} · {entry.summary}
          </div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Btn
            variant="primary"
            icon="reload"
            disabled={isLatest || reverting}
            onClick={() => onRevert(entry)}
          >
            {reverting ? 'Reverting…' : isLatest ? 'Current version' : `Revert to v${entry.version}`}
          </Btn>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: C.surface, minHeight: 0 }}>
        {noBaseline && (
          <div style={{
            fontSize: 11, color: C.muted, fontFamily: SANS, marginBottom: 10,
            padding: '6px 10px', background: C.s2, borderRadius: 4,
          }}>
            {isPruned
              ? `The version before this one is no longer in the history (only the
                 newest ${MAX_VERSIONS} are kept), so the whole workflow is shown
                 as added. Reverting still restores this version exactly — each
                 version stores its own full snapshot.`
              : 'First recorded version — the whole workflow is shown as added.'}
          </div>
        )}

        {!noBaseline && diff.name && <TextChange label="Workflow name" change={diff.name} />}
        {!noBaseline && diff.description && <TextChange label="Description" change={diff.description} />}

        {diff.edges.length > 0 && (
          <div style={{
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px',
            marginBottom: 8, background: '#fff',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, fontFamily: SANS, marginBottom: 5 }}>
              Connections
            </div>
            {diff.edges.map((e) => {
              const s = CHANGE_STYLE[e.change];
              return (
                <div key={e.edgeId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: s.color }}>{s.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>
                    {e.edge.source} → {e.edge.target}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {diff.executionStepsChanged && (
          <div style={{
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px',
            marginBottom: 8, background: '#fff', fontSize: 12, color: C.text, fontFamily: SANS,
          }}>
            Execution steps changed
          </div>
        )}

        {diff.nodes.length > 0 && (
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: C.muted,
            fontFamily: MONO, margin: '12px 0 6px',
          }}>
            NODES ({diff.nodes.length})
          </div>
        )}
        {diff.nodes.map((change) => <NodeChange key={change.nodeId} change={change} />)}

        {diff.isEmpty && (
          <div style={{ fontSize: 12, color: C.muted, fontFamily: SANS }}>
            Only the canvas layout changed in this version.
          </div>
        )}
      </div>
    </div>
  );
};

// ── Shell ──────────────────────────────────────────────────────────────────

const WorkflowHistory = ({ open, workflowId, workflowName, onRevert, onClose }) => {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [reverting, setReverting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    workflowHistoryDb.getVersions(workflowId)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        // Open on the newest version, which is the one the canvas was loaded
        // from — so the pane starts on something the user recognizes.
        setSelectedId(rows[0]?.versionId || null);
      })
      .catch((err) => {
        if (!cancelled) message.error(`Could not load history: ${err.message}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, workflowId]);

  const selected = versions.find((v) => v.versionId === selectedId) || null;
  // Versions are newest-first, so the one BEFORE the selected version in time
  // is the next index along.
  const previous = useMemo(() => {
    const i = versions.findIndex((v) => v.versionId === selectedId);
    return i >= 0 ? versions[i + 1] || null : null;
  }, [versions, selectedId]);

  const handleRevert = useCallback((entry) => {
    Modal.confirm({
      title: `Revert to version ${entry.version}?`,
      content: (
        <span>
          The canvas will be replaced with this version, saved{' '}
          {moment(entry.timestamp).fromNow()}. Nothing is written until you click
          Save — close without saving to keep the current version.
        </span>
      ),
      okText: `Revert to v${entry.version}`,
      cancelText: 'Cancel',
      onOk: async () => {
        setReverting(true);
        try {
          await onRevert(entry);
          onClose();
        } catch (err) {
          message.error(`Could not revert: ${err.message}`);
        } finally {
          setReverting(false);
        }
      },
    });
  }, [onRevert, onClose]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      // Fluid, not a fixed 1140px. App.css pulls `.ant-modal-wrap` in off the
      // right edge by --chat-rail-w when the assistant is pinned, so a
      // percentage resolves against the space actually left over and the modal
      // stays clear of the rail at any rail width. A fixed pixel width wider
      // than that space overflows it and slides back under the assistant.
      width="94%"
      style={{ maxWidth: 1140 }}
      title={(
        <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: C.text }}>
          History
          {workflowName && <span style={{ color: C.muted, fontWeight: 400 }}> — {workflowName}</span>}
        </span>
      )}
      styles={{ body: { padding: 0, height: '70vh', display: 'flex', overflow: 'hidden' } }}
      destroyOnClose
    >
      {loading ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', gap: 10,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Spin size="large" />
          <span style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>Loading history…</span>
        </div>
      ) : versions.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={(
              <span style={{ fontFamily: SANS, fontSize: 13, color: C.muted }}>
                No history yet — the next save records the first version.
              </span>
            )}
          />
        </div>
      ) : (
        <>
          <div style={{
            width: 320, flexShrink: 0, borderRight: `1px solid ${C.border}`,
            overflowY: 'auto', background: '#fff',
          }}>
            {versions.map((entry, i) => (
              <VersionRow
                key={entry.versionId}
                entry={entry}
                isLatest={i === 0}
                selected={entry.versionId === selectedId}
                onSelect={(e) => setSelectedId(e.versionId)}
              />
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <VersionDetail
              entry={selected}
              previous={previous}
              isLatest={versions[0]?.versionId === selectedId}
              onRevert={handleRevert}
              reverting={reverting}
            />
          </div>
        </>
      )}
    </Modal>
  );
};

export default WorkflowHistory;
