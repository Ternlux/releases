/**
 * ExecutionMonitor — "what is running right now", pinned to the top-left.
 *
 * A run can be started from the canvas, from the workflows list, or by a CRON
 * job or file watcher with nobody watching at all, and once it is going the
 * only place its progress showed was the Executions tab, after the fact. This
 * panel is the live view: every workflow currently executing, which step each
 * one is on, and — expanded — the log as it is written.
 *
 * It is mounted in App.js next to ChatAssistant, so it is app-wide rather than
 * tied to whatever tab is open, and floats above everything at the same
 * stacking level the assistant uses.
 *
 * It shows itself when a run starts and hides when the last one finishes. There
 * is no dismiss: a run in flight is writing to real destinations, and a panel
 * that could be closed out from under it left the only live account of that
 * write with no way back. What the user gets instead is a collapse (down to the
 * header bar), a stop button per run, and — like the assistant — the ability to
 * drag it out of the way.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, MONO, SANS, I } from './_designShared';
import { useRunningExecutions, stopExecution } from '../../utils/executionMonitorStore';

// Same layer as the assistant (see CHAT_Z in ChatAssistant.js), so the monitor
// sits over the editor, its modals and the node panels the way the assistant
// does. They never overlap — the assistant is right/bottom, this is top-left.
const MONITOR_Z = 1500;

const PANEL_WIDTH = 328;
const EXPANDED_MAX_HEIGHT = 320;   // per-workflow log area
const EDGE_GAP = 8;                // closest the panel may sit to a viewport edge
const DRAG_SLOP = 4;               // pixels before a press on the header is a drag
const ARM_TIMEOUT_MS = 3500;       // how long "Stop?" stays armed before it relaxes

// ── helpers ────────────────────────────────────────────────────────────────

const elapsedLabel = (startTime, now) => {
  if (!startTime) return '';
  const ms = Math.max(0, now - new Date(startTime).getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const timeLabel = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour12: false });
};

const logColor = (level) => (
  level === 'error' ? C.red : (level === 'warn' || level === 'warning') ? C.amber : C.muted
);

// ── log detail ─────────────────────────────────────────────────────────────
//
// The tracer attaches structured detail to its lines (executionLog.js), and
// until now this panel showed only the message — so a step that was ten minutes
// into a load said "postgres.batchInsert ok" and nothing else, which is exactly
// the moment someone opens this panel to ask WHAT it is running and HOW FAR it
// has got. Both answers are already in `detail`: the statement, and the record
// range the current batch is carrying.
//
// Only these fields, in this order. The rest is routing information that would
// cost more width than it is worth in a panel this narrow. The third entry is
// the printed label where the key alone would not read as one.
const LOG_META_FIELDS = [
  ['table', ''], ['rowCount', ' rows'], ['rows', ' rows'],
  ['rowRange', '', 'records'], ['durationMs', 'ms'],
];

// Enough of a statement to recognise it. The full text is in the Executions
// tab; this panel is a live glance, and a multi-thousand-tuple INSERT would
// otherwise push every other running step off the screen.
const SQL_PREVIEW_CHARS = 220;

const sqlPreview = (sql) => {
  // Generated SQL arrives as one long line; collapsing the whitespace keeps the
  // preview from being mostly indentation.
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  return flat.length > SQL_PREVIEW_CHARS ? `${flat.slice(0, SQL_PREVIEW_CHARS)}…` : flat;
};

// Left edge of the message column, so detail lines hang under the message
// rather than under the timestamp.
const LOG_INDENT = 56;

const LogLine = ({ l }) => {
  const d = l.detail || null;
  const meta = d
    ? LOG_META_FIELDS
        .filter(([k]) => d[k] != null && d[k] !== '')
        .map(([k, suffix, label]) => `${label || k}=${d[k]}${suffix}`)
    : [];

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.45 }}>
        <span style={{ color: C.dim, flexShrink: 0 }}>{timeLabel(l.timestamp)}</span>
        <span style={{ color: logColor(l.level), wordBreak: 'break-word' }}>{l.message}</span>
      </div>
      {meta.length > 0 && (
        <div style={{
          marginLeft: LOG_INDENT, fontFamily: MONO, fontSize: 9.5,
          color: C.dim, lineHeight: 1.5, wordBreak: 'break-word',
        }}>
          {meta.join('  ·  ')}
        </div>
      )}
      {d?.sql && (
        <div style={{
          marginLeft: LOG_INDENT, marginTop: 2, padding: '3px 5px',
          fontFamily: MONO, fontSize: 9.5, lineHeight: 1.5,
          color: C.muted, background: C.s2, border: `1px solid ${C.border}`,
          borderRadius: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 60, overflowY: 'auto',
        }}>
          {sqlPreview(d.sql)}
        </div>
      )}
    </div>
  );
};

// ── icons ──────────────────────────────────────────────────────────────────
// _designShared's set has no grip or stop glyph, and both are specific to this
// panel, so they live here rather than widening the shared icon table.

/** Six-dot grip that marks the header as the drag handle (same as the chat). */
const IconGrip = ({ color = C.dim, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill={color}>
    {[3, 6, 9].map((y) => (
      <React.Fragment key={y}>
        <circle cx="4" cy={y} r="0.95" />
        <circle cx="8" cy={y} r="0.95" />
      </React.Fragment>
    ))}
  </svg>
);

/** Filled square — the universal "stop", and distinct from the close ✕. */
const IconStop = ({ color = C.muted, size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill={color}>
    <rect x="2" y="2" width="8" height="8" rx="1.2" />
  </svg>
);

// ── drag-to-move ───────────────────────────────────────────────────────────

/**
 * Where the panel sits. `pos` is null until the user drags it, so an untouched
 * monitor keeps its top-left anchor across window resizes; once dragged it is
 * clamped inside the viewport, including as the window is resized under it.
 *
 * Modelled on ChatAssistant's useChatWindow, minus the dock-to-a-rail half: the
 * monitor is a small transient panel, not a surface the app lays out around.
 */
const useMonitorWindow = (panelRef) => {
  const [pos, setPos] = useState(null);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback((left, top) => {
    const el = panelRef.current;
    // Measured, not assumed: the panel grows as runs and their steps arrive,
    // so a fixed height would let a tall panel be dragged off the bottom.
    const w = el ? el.offsetWidth : PANEL_WIDTH;
    const h = el ? el.offsetHeight : 120;
    return {
      left: Math.min(Math.max(EDGE_GAP, left), Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP)),
      top: Math.min(Math.max(EDGE_GAP, top), Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP)),
    };
  }, [panelRef]);

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p.left, p.top) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const startDrag = useCallback((e) => {
    if (e.button !== 0) return;
    // The collapse toggle and anything else interactive in the header stays
    // clickable rather than becoming a drag handle.
    if (e.target.closest('button, a, input, textarea, select, [data-no-drag]')) return;
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const st = {
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };

    const onMove = (ev) => {
      if (!st.moved) {
        // A few pixels of slop so a click on the header isn't a micro-drag.
        if (Math.abs(ev.clientX - st.startX) < DRAG_SLOP && Math.abs(ev.clientY - st.startY) < DRAG_SLOP) return;
        st.moved = true;
        setDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      setPos(clamp(ev.clientX - st.offX, ev.clientY - st.offY));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setDragging(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [clamp, panelRef]);

  return { pos, dragging, startDrag };
};

/**
 * The steps of one run, in the order they happened: everything already
 * recorded, plus the one in flight (which has no nodeExecutions row yet — the
 * main process only writes one when a node finishes).
 */
const stepsOf = (ex) => {
  const done = (ex.nodeExecutions || []).map((n) => ({
    nodeId: n.nodeId,
    name: n.nodeName || n.nodeId,
    type: n.nodeType,
    status: n.status,
    duration: n.duration,
    error: n.error?.message || null,
  }));
  if (ex.currentNodeId && !done.some((s) => s.nodeId === ex.currentNodeId)) {
    done.push({
      nodeId: ex.currentNodeId,
      name: ex.currentNodeName || ex.currentNodeId,
      status: 'running',
      duration: null,
      error: null,
    });
  }
  return done;
};

/**
 * Group a run's log lines by the node they belong to. Lines that belong to the
 * run rather than to any one node ("Starting workflow execution: …") are
 * dropped: this panel is a list of workflows and, expanded, their steps —
 * run-level narration is what the Executions tab is for.
 */
const logsByNode = (ex) => {
  const map = new Map();
  (ex.logs || []).forEach((l) => {
    if (!l.nodeId) return;
    if (!map.has(l.nodeId)) map.set(l.nodeId, []);
    map.get(l.nodeId).push(l);
  });
  return map;
};

// ── step row ───────────────────────────────────────────────────────────────

const StepRow = ({ step, logs }) => {
  const running = step.status === 'running';
  const failed = step.status === 'failed';
  // A step the user stopped part-way. Not green — it did not finish, and its
  // message says how much of its write landed before it was cut short.
  const stopped = step.status === 'cancelled';
  const dot = running ? C.accent : failed ? C.red : stopped ? C.amber : C.green;

  return (
    <div style={{ padding: '6px 10px 6px 12px', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          className={running ? 'wf-exec-dot-live' : undefined}
          style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }}
        />
        <span style={{
          fontSize: 11.5, fontWeight: running ? 700 : 500,
          color: failed ? C.red : running ? C.text : C.muted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {step.name}
        </span>
        <span style={{
          fontFamily: MONO, fontSize: 10, flexShrink: 0,
          color: stopped ? C.amber : C.dim,
        }}>
          {running ? 'running' : stopped ? 'stopped' : step.duration != null ? `${step.duration}ms` : ''}
        </span>
      </div>

      {step.error && (
        <div style={{
          marginTop: 4, marginLeft: 14, fontFamily: MONO, fontSize: 10.5,
          // A stopped step's "error" is the stop message — how far its write
          // got. Painting that red would report the user's own button press as
          // a failure.
          color: stopped ? C.amber : C.red, wordBreak: 'break-word',
        }}>
          {step.error}
        </div>
      )}

      {logs.length > 0 && (
        <div style={{ marginTop: 4, marginLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {logs.map((l, i) => <LogLine key={i} l={l} />)}
        </div>
      )}
    </div>
  );
};

// ── stop control ───────────────────────────────────────────────────────────

/**
 * Stop one run. Arms on the first click and confirms on the second, relaxing
 * on its own after ARM_TIMEOUT_MS.
 *
 * The two-step is not ceremony: these runs write to real destination tables,
 * and this button sits a few pixels from the row you click to expand a run, so
 * a single-click stop would be one slip away from killing a load someone was
 * only trying to read. A confirm dialog would do the same job, but a modal from
 * a floating panel blocks the whole window — including the run it is about.
 */
const StopButton = ({ stopping, onStop }) => {
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);

  useEffect(() => () => clearTimeout(armTimer.current), []);

  const disarm = () => { clearTimeout(armTimer.current); setArmed(false); };

  const onClick = (e) => {
    e.stopPropagation();
    if (stopping) return;
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
      return;
    }
    disarm();
    onStop();
  };

  if (stopping) {
    return (
      <span
        title="The current step has to finish before the run can end"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
          padding: '3px 7px', borderRadius: 4, marginRight: 8,
          fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.04em',
          color: C.amber, background: C.amD, border: `1px solid rgba(217,119,6,0.25)`,
        }}
      >
        stopping…
      </span>
    );
  }

  return (
    <button
      onClick={onClick}
      onMouseLeave={disarm}
      title={armed
        ? 'Click again to stop this run'
        : 'Stop this run — the step in flight finishes first'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
        padding: armed ? '3px 7px' : '4px 5px', borderRadius: 4, marginRight: 8,
        cursor: 'pointer', font: 'inherit',
        fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
        color: armed ? C.red : C.dim,
        background: armed ? C.rD : 'transparent',
        border: `1px solid ${armed ? 'rgba(220,38,38,0.3)' : 'transparent'}`,
        transition: 'color 0.12s, background 0.12s',
      }}
      onMouseOver={(e) => { if (!armed) e.currentTarget.style.color = C.red; }}
      onMouseOut={(e) => { if (!armed) e.currentTarget.style.color = C.dim; }}
    >
      <IconStop color={armed ? C.red : 'currentColor'} size={armed ? 8 : 10} />
      {armed && 'STOP?'}
    </button>
  );
};

// ── one running workflow ───────────────────────────────────────────────────

const RunRow = ({ ex, now, expanded, onToggle, stopping, onStop }) => {
  const steps = useMemo(() => stepsOf(ex), [ex]);
  const byNode = useMemo(() => logsByNode(ex), [ex]);
  const total = ex.totalSteps || steps.length;
  const done = steps.filter((s) => s.status !== 'running').length;
  const current = steps.find((s) => s.status === 'running');

  // Follow the run: as steps are appended, keep the newest one in view — but
  // only while the user is already at the bottom, so scrolling back to read an
  // earlier step isn't yanked away on the next tick.
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !expanded) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [expanded, steps.length, ex.logs?.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div style={{ borderTop: `1px solid ${C.border}` }}>
      {/* The stop control cannot live inside the expand button — a button
          nested in a button is invalid and swallows its own clicks — so the
          row is a flex strip with the toggle taking the slack. */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button
          onClick={onToggle}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 4px 9px 10px', background: 'transparent', border: 'none',
            cursor: 'pointer', textAlign: 'left', font: 'inherit',
          }}
          onMouseOver={(e) => { e.currentTarget.style.background = C.surface; }}
          onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{
            display: 'inline-flex', transform: `rotate(${expanded ? 0 : -90}deg)`,
            transition: 'transform 0.15s ease', flexShrink: 0,
          }}>
            {I('chevron', C.dim, 12)}
          </span>

          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{
              display: 'block', fontSize: 12, fontWeight: 600, color: C.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {ex.workflowName || 'Untitled Workflow'}
            </span>
            <span style={{
              display: 'block', fontSize: 10.5, color: C.muted, marginTop: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {current ? current.name : 'starting…'}
              {total ? ` · ${Math.min(done + (current ? 1 : 0), total)}/${total}` : ''}
            </span>
          </span>

          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, flexShrink: 0 }}>
            {elapsedLabel(ex.startTime, now)}
          </span>
        </button>

        <StopButton stopping={stopping} onStop={onStop} />
      </div>

      {/* Progress bar — how much of the run is behind it. Amber once a stop is
          pending: the bar is still advancing, but towards an early end. */}
      {total > 0 && (
        <div style={{ height: 2, background: C.s2, margin: '0 10px 8px' }}>
          <div style={{
            height: '100%', width: `${Math.min(100, Math.round((done / total) * 100))}%`,
            background: stopping ? C.amber : C.accent, transition: 'width 0.3s ease, background 0.2s',
          }} />
        </div>
      )}

      {expanded && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ maxHeight: EXPANDED_MAX_HEIGHT, overflowY: 'auto', background: C.surface }}
        >
          {steps.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 11, color: C.dim, borderTop: `1px solid ${C.border}` }}>
              Waiting for the first step…
            </div>
          )}
          {steps.map((s) => (
            <StepRow key={s.nodeId} step={s} logs={byNode.get(s.nodeId) || []} />
          ))}
        </div>
      )}
    </div>
  );
};

// ── panel ──────────────────────────────────────────────────────────────────

const ExecutionMonitor = () => {
  const executions = useRunningExecutions();
  const [expanded, setExpanded] = useState(() => new Set());
  // Ids the user has pressed stop on, held until the main process's own
  // `cancelRequested` flag comes back on the next poll — up to a second and a
  // bit away, which is far too long for a button to look like it did nothing.
  const [stopping, setStopping] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());

  const panelRef = useRef(null);
  const { pos, dragging, startDrag } = useMonitorWindow(panelRef);

  // Elapsed times tick on their own — the execution record doesn't change
  // between steps, so nothing else would re-render them.
  useEffect(() => {
    if (executions.length === 0) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [executions.length]);

  // Let go of ids for runs that have finished, so the sets don't grow for the
  // lifetime of the session.
  useEffect(() => {
    const live = new Set(executions.map((e) => e.executionId));
    const prune = (prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setExpanded(prune);
    setStopping(prune);
  }, [executions]);

  // Nothing running, nothing to show. Note this is the ONLY way the panel goes
  // away: there is no dismiss, because a run in flight is writing to a real
  // destination and hiding it would leave that write unaccounted for. Collapse
  // and drag are the ways to get it out of the way.
  if (executions.length === 0) return null;

  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const stop = async (id) => {
    setStopping((prev) => new Set(prev).add(id));
    const result = await stopExecution(id);
    // A stop the main process refused (the run finished on its own between the
    // click and the call) must not leave the row stuck on "stopping…".
    if (!result?.success) {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const anyStopping = executions.some((e) => e.cancelRequested || stopping.has(e.executionId));

  return (
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        ...(pos ? { left: pos.left, top: pos.top } : { top: 12, left: 12 }),
        width: PANEL_WIDTH,
        zIndex: MONITOR_Z, fontFamily: SANS,
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
        boxShadow: dragging
          ? '0 28px 64px rgba(15,23,42,0.26), 0 4px 12px rgba(0,0,0,0.10)'
          : '0 16px 40px rgba(15,23,42,0.18), 0 2px 8px rgba(0,0,0,0.06)',
        maxHeight: 'calc(100vh - 24px)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes wf-exec-dot { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }
        .wf-exec-dot-live { animation: wf-exec-dot 1s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .wf-exec-dot-live { animation: none } }
      `}</style>

      {/* The header doubles as the drag handle — same gesture as the chat
          assistant's, grip and all, so the two floating panels behave alike. */}
      <div
        onPointerDown={startDrag}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
          borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
          background: C.surface, flexShrink: 0,
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none', touchAction: 'none',
        }}
      >
        <IconGrip color={C.dim} size={11} />
        <span className="wf-exec-dot-live" style={{
          width: 8, height: 8, borderRadius: '50%',
          background: anyStopping ? C.amber : C.accent, flexShrink: 0,
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: C.text, flex: 1 }}>
          {executions.length === 1
            ? '1 workflow running'
            : `${executions.length} workflows running`}
        </span>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed
            ? 'Show the running workflows'
            : 'Collapse to the header — the runs keep going'}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, padding: 0, borderRadius: 4,
            border: 'none', background: 'transparent', cursor: 'pointer',
            transform: `rotate(${collapsed ? -90 : 0}deg)`, transition: 'transform 0.15s ease',
          }}
          onMouseOver={(e) => { e.currentTarget.style.background = C.s2; }}
          onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {I('chevron', C.muted, 12)}
        </button>
      </div>

      {!collapsed && (
        <div style={{ overflowY: 'auto' }}>
          {executions.map((ex) => (
            <RunRow
              key={ex.executionId}
              ex={ex}
              now={now}
              expanded={expanded.has(ex.executionId)}
              onToggle={() => toggle(ex.executionId)}
              stopping={!!ex.cancelRequested || stopping.has(ex.executionId)}
              onStop={() => stop(ex.executionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ExecutionMonitor;
