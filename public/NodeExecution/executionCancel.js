/**
 * Cooperative cancellation, reaching inside a running node.
 *
 * The runner in electron.js checks for a stop request between steps, which is
 * enough when steps are short. It is not enough for the node that actually
 * takes the time: an output node writing 400k rows sits in ONE step for
 * minutes, looping over batch inserts, and a stop pressed during that loop did
 * nothing visible until the whole load had finished. That is what this module
 * fixes — the loops themselves check, so a stop lands within one batch instead
 * of one node.
 *
 * The reach problem is the same one executionLog.js solves, and so is the
 * answer. The loops that need to check sit four or five calls below the
 * orchestrator that knows a stop was requested (electron.js → executeNode →
 * executeOutputNode → the chunk loop), several of those layers are also called
 * from IPC handlers with no execution at all, and threading a token through
 * every signature would touch all of them and still miss the loops inside joins
 * and transforms. So the predicate travels in an AsyncLocalStorage context: the
 * orchestrator opens one around each node, and anything running inside it —
 * however deep, across every await — can call `throwIfCancelled`.
 *
 * AsyncLocalStorage rather than a module-level flag because runs overlap: a
 * CRON trigger can fire while a manual run is in flight, and a global would
 * stop the wrong one.
 *
 * Outside a run every function here is inert, which is what makes it safe to
 * put `throwIfCancelled` in shared code that ad-hoc IPC handlers also call.
 *
 * WHY AN EXCEPTION, not a return value: these loops are inside connector calls,
 * transform helpers and join builders whose returns are already overloaded
 * ({ success, message, rowCount, rows }), and every one of their callers would
 * have to learn a new "stopped" case or silently treat it as success. A throw
 * unwinds to the runner, which is the only layer that knows what to do with it.
 * The runner tells it apart from a real failure with `isCancelledError`, and
 * records the node as cancelled rather than failed.
 *
 * WHAT THIS DOES NOT DO: it cannot interrupt a single call already in flight.
 * A batch insert that has been handed to the driver runs to completion; the
 * check happens before the NEXT one. So the granularity of a stop is one batch
 * — 50,000 rows by default, 10,000 on BigQuery (see lib/batchChunkSize.js) —
 * not one row. A bigger batch means a stop lands later, which is the price of
 * the throughput it buys, and it is still bounded. Rows
 * already committed stay committed: nothing here rolls anything back, and a
 * stopped load leaves a partially written destination table on purpose, since
 * the alternative is discarding work the user may want.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Thrown by `throwIfCancelled` when the user has asked the run to stop.
 *
 * Carries `cancelled: true` rather than relying on the class, because this
 * error crosses module boundaries and `instanceof` is unreliable once a package
 * is loaded twice (plugins each have their own node_modules here).
 */
class ExecutionCancelledError extends Error {
  constructor(where = null, progress = null) {
    const parts = [];
    if (where) parts.push(`during ${where}`);
    // What the destination looks like now. A stop mid-load leaves rows behind,
    // and "12,000 of 400,000 rows already written" is the difference between a
    // user who knows to clean up and one who finds a half-full table next week.
    if (progress) parts.push(progress);
    const body = parts.join(', ');
    // The safety net in the runner wraps a message that may already be a
    // finished sentence (it can carry a node's own return message), so only add
    // the full stop when there isn't one.
    const tail = /[.!?]$/.test(body) ? '' : '.';
    super(parts.length ? `Stopped by the user — ${body}${tail}` : 'Stopped by the user.');
    this.name = 'ExecutionCancelledError';
    this.cancelled = true;
  }
}

/**
 * Run `fn` with `isCancelled` answering for everything it awaits.
 *
 * @param {(() => boolean)|null} isCancelled Polled on each check. Cheap by
 *   contract — it is called inside tight loops, so it must not do I/O. The
 *   runner passes a Set lookup.
 * @param {Function} fn
 */
function runWithCancellation(isCancelled, fn) {
  if (typeof isCancelled !== 'function') return fn();
  return storage.run({ isCancelled }, fn);
}

/**
 * Has a stop been requested for the run this code is executing inside?
 * False outside a run, and false if the predicate itself throws — a broken
 * cancellation check must never take down a run that is doing real work.
 * @returns {boolean}
 */
function isCancellationRequested() {
  const ctx = storage.getStore();
  if (!ctx) return false;
  try {
    return !!ctx.isCancelled();
  } catch (err) {
    console.warn('[Execution Cancel] cancellation check failed:', err.message);
    return false;
  }
}

/**
 * Stop here if the user has asked the run to stop.
 *
 * Call it at the TOP of a loop body, before the expensive call — checking after
 * the work is done saves nothing.
 *
 * @param {string} [where] What was about to happen, e.g. 'batch insert'. Ends up
 *   in the message the execution log and the monitor show.
 * @param {string} [progress] How far the work got, e.g. '12000 of 400000 rows
 *   already written'. Worth passing anywhere the stop leaves data behind.
 * @throws {ExecutionCancelledError}
 */
function throwIfCancelled(where = null, progress = null) {
  if (isCancellationRequested()) throw new ExecutionCancelledError(where, progress);
}

/**
 * Is this error a stop request rather than a failure?
 * Duck-typed on purpose — see the note on ExecutionCancelledError.
 * @param {*} err
 * @returns {boolean}
 */
function isCancelledError(err) {
  return !!(err && err.cancelled === true);
}

module.exports = {
  ExecutionCancelledError,
  runWithCancellation,
  isCancellationRequested,
  throwIfCancelled,
  isCancelledError,
};
