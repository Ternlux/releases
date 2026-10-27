/**
 * executionMonitorStore.js — one poller for "what is running right now".
 *
 * Execution progress lives in the local `executions` collection, written by the
 * main process as a run advances (see workflow:execute in public/electron.js):
 * `status`, `currentNodeId`, `nodeExecutions` and `logs` all update in place.
 * There is no push channel for it, so the renderer polls.
 *
 * Several places want that state at once — the monitor panel lists every
 * running workflow, and each open canvas rings its own nodes — and a poller per
 * consumer would multiply IPC round-trips for identical reads. So there is one
 * module-level store here: it starts polling when the first consumer subscribes
 * and stops when the last one leaves.
 *
 * Two things are fetched per tick:
 *  - every execution with status 'running' (the monitor's list);
 *  - the newest execution, any status, for each workflow id a consumer has
 *    asked to watch (the canvas's "did the last run fail on this node?").
 */

import { useEffect, useState } from 'react';
import { executionsDb } from './localDb';

// How often to re-read. Fast while something is running, so a node lighting up
// feels immediate; slower when nothing is, because the monitor is mounted for
// the whole session and there is no point querying a second at a time to keep
// being told the app is idle.
const POLL_ACTIVE_MS = 1200;
const POLL_IDLE_MS = 4000;

let running = [];                       // running execution docs, newest first
let latestByWorkflow = new Map();       // workflowId -> newest execution doc
const watchedWorkflows = new Map();     // workflowId -> subscriber count
const listeners = new Set();
let timer = null;
let inFlight = false;

const emit = () => { listeners.forEach((fn) => fn()); };

// A tick that changed nothing must not re-render every subscriber, and a
// long run accumulates enough logs that deep-comparing whole documents each
// second is not free. These are the only fields that move while a run is in
// flight, so a fingerprint over them is both cheaper and sufficient.
const fingerprint = (docs) => (docs || []).map((d) => [
  d.executionId,
  d.status,
  d.currentNodeId || '',
  (d.nodeExecutions || []).length,
  (d.nodeExecutions || []).map((n) => n.status).join(','),
  (d.logs || []).length,
  // A stop the user asked for shows in the monitor as "stopping…" while the
  // current node finishes. The main process writes it onto the row, so without
  // it here the flag would land silently and nothing would re-render.
  d.cancelRequested ? 'stopping' : '',
].join('|')).join(';');

const tick = async () => {
  if (inFlight) return;             // a slow read must not stack up behind itself
  inFlight = true;
  try {
    const nextRunning = (await executionsDb.getRunning()) || [];

    const ids = [...watchedWorkflows.keys()];
    const latest = await Promise.all(ids.map((id) => executionsDb.getLatestByWorkflow(id)));
    const nextLatest = new Map();
    ids.forEach((id, i) => { if (latest[i]) nextLatest.set(id, latest[i]); });

    let changed = false;
    if (fingerprint(running) !== fingerprint(nextRunning)) {
      running = nextRunning;
      changed = true;
    }
    if (fingerprint([...latestByWorkflow.values()]) !== fingerprint([...nextLatest.values()])) {
      latestByWorkflow = nextLatest;
      changed = true;
    }
    if (changed) emit();
  } catch (err) {
    console.error('[executionMonitor] poll failed:', err);
  } finally {
    inFlight = false;
    // Re-arm at whichever cadence now applies. A run that just started speeds
    // the loop up on this very tick rather than one interval later.
    schedule();
  }
};

// setTimeout rather than setInterval so the delay can change between ticks.
const schedule = () => {
  if (!listeners.size) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, running.length ? POLL_ACTIVE_MS : POLL_IDLE_MS);
};

const start = () => {
  if (timer || inFlight) return;
  tick();
};

const stop = () => {
  if (timer) clearTimeout(timer);
  timer = null;
  running = [];
  latestByWorkflow = new Map();
};

const subscribe = (fn) => {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
};

const watch = (workflowId) => {
  if (!workflowId) return () => {};
  watchedWorkflows.set(workflowId, (watchedWorkflows.get(workflowId) || 0) + 1);
  // Pull this workflow's row now rather than waiting out a full interval.
  tick();
  return () => {
    const n = (watchedWorkflows.get(workflowId) || 1) - 1;
    if (n > 0) watchedWorkflows.set(workflowId, n);
    else {
      watchedWorkflows.delete(workflowId);
      latestByWorkflow.delete(workflowId);
    }
  };
};

/**
 * Every execution currently in progress, newest first. Re-renders the caller
 * whenever that list — or anything inside one of those records — changes.
 * @returns {object[]}
 */
export const useRunningExecutions = () => {
  const [snapshot, setSnapshot] = useState(running);
  useEffect(() => subscribe(() => setSnapshot(running)), []);
  return snapshot;
};

/**
 * Live execution state for one workflow.
 * @param {string|null} workflowId
 * @returns {{ running: object|null, latest: object|null }} `running` is the
 *   in-progress execution if there is one; `latest` is the newest execution
 *   whatever its status (the same doc as `running` while a run is in flight).
 */
export const useWorkflowExecution = (workflowId) => {
  const [state, setState] = useState({ running: null, latest: null });

  useEffect(() => {
    if (!workflowId) { setState({ running: null, latest: null }); return undefined; }

    const read = () => setState((prev) => {
      const next = {
        running: running.find((e) => e.workflowId === workflowId) || null,
        latest: latestByWorkflow.get(workflowId) || null,
      };
      // The store only emits on real change, but both lookups can land on the
      // same docs as last time (e.g. another workflow's run moved), and a new
      // object identity would re-render the canvas for nothing.
      return prev.running === next.running && prev.latest === next.latest ? prev : next;
    });

    const unwatch = watch(workflowId);
    const unsubscribe = subscribe(read);
    read();
    return () => { unsubscribe(); unwatch(); };
  }, [workflowId]);

  return state;
};

/** Force an immediate re-read — e.g. right after kicking off a run. */
export const refreshExecutions = () => { tick(); };

/**
 * Ask a running execution to stop.
 *
 * The stop is cooperative and takes effect between nodes: the step in flight
 * finishes and is recorded, then the run ends with status 'cancelled'. It does
 * not abort a connector call already in progress, so a node writing a large
 * table keeps writing until it is done.
 *
 * Re-reads immediately on return so the `cancelRequested` flag the main process
 * just wrote reaches the UI without waiting out a poll interval.
 *
 * @param {string} executionId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export const stopExecution = async (executionId) => {
  if (!executionId) return { success: false, message: 'No execution to stop.' };
  if (!window.electronAPI?.workflow?.cancelWorkflow) {
    return { success: false, message: 'Stopping a run is not available in this build.' };
  }
  try {
    const result = await window.electronAPI.workflow.cancelWorkflow({ executionId });
    tick();
    return result || { success: false, message: 'Stop request returned nothing.' };
  } catch (err) {
    console.error('[executionMonitor] stop failed:', err);
    return { success: false, message: err.message || String(err) };
  }
};
