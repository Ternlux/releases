/**
 * Per-node execution tracing.
 *
 * Before this, an execution record held two lines per node — "Executing node X"
 * and "X completed successfully" — so a run that went wrong told you WHICH node
 * failed and nothing about why. The SQL that ran, the DDL that was skipped, the
 * connector that timed out and the skill that returned an error were all only
 * ever `console.log`s in the Electron main process, which the user never sees.
 *
 * The problem this module solves is reach: the code that knows those details
 * sits four or five calls below the orchestrator that owns the execution record
 * (electron.js → executeNode → executeTransformerNode → handleTransformSQL →
 * plugin.runQuery), and several of those layers are also called from IPC
 * handlers that have no execution at all. Threading a logger through every
 * signature would touch every one of them and still miss the connector calls
 * made from joins, outputs and validation.
 *
 * So the sink travels in an AsyncLocalStorage context instead. The orchestrator
 * opens one around each node; anything that runs inside it — however deep, and
 * across every await — can call `logStep` / `traceCall` and reach that node's
 * log. Outside a run every function here is a no-op, which is what makes it
 * safe to instrument shared code paths like pluginManager.
 *
 * AsyncLocalStorage rather than a module-level "current execution" variable
 * because runs overlap: a CRON trigger can fire while a manual run is in
 * flight, and a plain global would file one run's SQL under the other's node.
 *
 * NOTHING here may throw. A run that produced real data must never be reported
 * as failed because a log write did — the same rule markNodeExecuted follows.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// A single statement is worth reading in full; a generated INSERT with ten
// thousand tuples is not, and it would be copied into the execution record on
// every run. Long values are cut with a marker saying how much was dropped.
const MAX_SQL_CHARS = 4000;
const MAX_MESSAGE_CHARS = 2000;

// Per-run ceiling on log entries. A node looping over a few thousand batches
// would otherwise grow the execution document without bound — NeDB holds the
// whole thing in memory and rewrites it on every update.
const MAX_ENTRIES_PER_RUN = 5000;

// Config objects are credentials. They are never logged; these are the only
// fields worth naming, and they identify a connection without exposing it.
const SAFE_CONFIG_FIELDS = ['host', 'port', 'database', 'schema', 'warehouse', 'account', 'project', 'dataset', 'bucket', 'region'];

/** Cut `text` to `max` characters, saying how much was dropped. */
function truncate(text, max) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [${s.length - max} more characters]`;
}

/**
 * The identifying, non-secret part of a connection config.
 *
 * Deliberately an allow-list: a deny-list ("drop password, drop token") silently
 * starts leaking the day a connector adds a differently-named secret, and
 * connectors here carry private keys, refresh tokens and SAS URLs.
 */
function safeConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const out = {};
  for (const key of SAFE_CONFIG_FIELDS) {
    if (config[key] != null && typeof config[key] !== 'object') out[key] = config[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Create a sink that appends to one execution record.
 *
 * Writes are batched. Every traced call would otherwise be its own awaited
 * `$push` against a document NeDB rewrites in full, which on a chatty node
 * costs more than the work being logged. Entries queue and flush together, and
 * `flush()` — which the orchestrator awaits when a node ends — drains whatever
 * is left, so nothing is lost even though individual `log` calls do not await.
 *
 * @param {object} executionsDb  NeDB datastore holding the execution record.
 * @param {string} executionId
 * @param {object} [opts]
 * @param {number} [opts.flushMs] How long entries may sit before being written.
 */
function createExecutionSink(executionsDb, executionId, { flushMs = 300 } = {}) {
  let pending = [];
  let timer = null;
  let inFlight = Promise.resolve();
  let written = 0;
  let capReported = false;

  const writeBatch = async (batch) => {
    try {
      await executionsDb.updateAsync(
        { executionId },
        { $push: { logs: { $each: batch } } },
        {},
      );
    } catch (err) {
      // Losing a log line is not worth failing a run over, and re-queuing on a
      // failing datastore would just grow the queue.
      console.warn('[Execution Log] could not write log batch:', err.message);
    }
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return inFlight;
    const batch = pending;
    pending = [];
    // Chained rather than parallel: two overlapping $push updates on the same
    // NeDB document can drop one of them.
    inFlight = inFlight.then(() => writeBatch(batch));
    return inFlight;
  };

  return {
    /** Queue one entry. Never throws, never awaited by callers. */
    write(entry) {
      try {
        if (written >= MAX_ENTRIES_PER_RUN) {
          if (!capReported) {
            capReported = true;
            pending.push({
              timestamp: new Date().toISOString(),
              level: 'warn',
              message: `Log output truncated after ${MAX_ENTRIES_PER_RUN} entries.`,
              nodeId: entry?.nodeId ?? null,
            });
            flush();
          }
          return;
        }
        written += 1;
        pending.push(entry);
        if (!timer) timer = setTimeout(flush, flushMs);
      } catch (err) {
        console.warn('[Execution Log] could not queue log entry:', err.message);
      }
    },
    /** Drain the queue. Awaited by the orchestrator at node and run boundaries. */
    async flush() {
      try {
        await flush();
      } catch (err) {
        console.warn('[Execution Log] flush failed:', err.message);
      }
    },
  };
}

/**
 * Run `fn` with `sink` as the log destination for everything it awaits.
 *
 * @param {object|null} sink   From createExecutionSink. Null disables logging.
 * @param {string|null} nodeId Stamped on every entry, so the UI can group logs
 *   under the node that produced them (see groupLogsByNode in ExecutionTab).
 */
function runWithExecutionLog(sink, nodeId, fn) {
  if (!sink) return fn();
  return storage.run({ sink, nodeId }, fn);
}

/** The active context, or null when called outside a traced run. */
function currentContext() {
  return storage.getStore() || null;
}

/**
 * Record one line against the node currently executing.
 *
 * A no-op outside a run, which is what lets shared code — pluginManager, the
 * transformers, the connectors — call it unconditionally.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [detail] Structured extras shown under the line in the UI.
 *   `sql` is rendered as a code block; everything else as key/value pairs.
 */
function logStep(level, message, detail = null) {
  const ctx = currentContext();
  if (!ctx) return;
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: truncate(message, MAX_MESSAGE_CHARS),
      nodeId: ctx.nodeId ?? null,
    };
    if (detail && typeof detail === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(detail)) {
        if (v == null) continue;
        clean[k] = k === 'sql' ? truncate(v, MAX_SQL_CHARS) : v;
      }
      if (Object.keys(clean).length > 0) entry.detail = clean;
    }
    ctx.sink.write(entry);
  } catch (err) {
    console.warn('[Execution Log] could not record step:', err.message);
  }
}

/** True when there is an execution to log to — for skipping expensive detail. */
function isTracing() {
  return currentContext() !== null;
}

/**
 * How far a chunked write into `table` has got, so the line the connector
 * wrapper writes can say WHICH records a call carried rather than only how
 * many. A loader reading a large source produces a run of identical
 * "batchInsert ok · rows=50000" lines, and identical lines cannot be told from
 * a stuck loop, nor answer "how far in is it?" while the run is still going.
 *
 * The write loops know the offset; batchInsert's signature (config, id, table,
 * columns, rows) has nowhere to put it, and widening it would mean changing
 * every connector. So it rides on the log context instead, next to the sink
 * that is already travelling with the node.
 *
 * Carries the table it refers to, and the wrapper uses the window only for a
 * call against that same table: two loops interleaving inside one node then
 * cannot file one loop's offset under the other's write. The window is a hint
 * for a log line — when it is absent or does not match, the line is written
 * exactly as it was before.
 *
 * @param {{table: string, written: number}|null} window Rows already written
 *   BEFORE the call about to be made. Null clears it.
 */
function setBatchWindow(window) {
  const ctx = currentContext();
  if (!ctx) return;
  try {
    ctx.batchWindow = window && typeof window === 'object' ? window : null;
  } catch (err) {
    console.warn('[Execution Log] could not set batch window:', err.message);
  }
}

/** The active batch window, or null. See setBatchWindow. */
function batchWindow() {
  const ctx = currentContext();
  return (ctx && ctx.batchWindow) || null;
}

/**
 * "50,001–100,000" for the rows a batch call is carrying, or null when the
 * caller left no window (or left one for a different table).
 *
 * @param {string|null} table Table the call is writing to.
 * @param {number|null} rows  How many rows this call carries.
 */
function batchRowRange(table, rows) {
  const window = batchWindow();
  if (!window || !Number.isFinite(rows) || rows <= 0) return null;
  if (table == null || window.table !== table) return null;
  const written = Number(window.written);
  if (!Number.isFinite(written) || written < 0) return null;
  return `${(written + 1).toLocaleString()}–${(written + rows).toLocaleString()}`;
}

/**
 * Time `fn`, and log what it was and how it went.
 *
 * The success line is 'info' and carries the duration; a thrown error and a
 * returned `{ success: false }` are both logged at 'error' — connectors here use
 * both conventions, and a caller reading the trace should not have to know
 * which one a given plugin picked. The error is then re-thrown / returned
 * unchanged: this observes, it never changes control flow.
 *
 * @param {object} meta
 * @param {string} meta.kind   What sort of call — 'connector', 'skill', 'duckdb', 'sqlite'.
 * @param {string} meta.label  What ran, e.g. 'postgres.runQuery'.
 * @param {string} [meta.sql]  The statement, when there is one.
 * @param {object} [meta.detail] Extra structured fields.
 */
async function traceCall(meta, fn) {
  if (!isTracing()) return fn();

  const { kind, label, sql = null, detail = null } = meta || {};
  const started = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    // A plugin that reports failure in its return value rather than by throwing.
    const failed = result && typeof result === 'object' && result.success === false;
    logStep(
      failed ? 'error' : 'info',
      failed ? `${label} failed: ${result.message || 'no message'}` : `${label} ok`,
      {
        kind,
        durationMs,
        ...(sql ? { sql } : {}),
        ...(detail || {}),
        ...(result && typeof result === 'object' && result.rowCount != null
          ? { rowCount: result.rowCount }
          : {}),
      },
    );
    return result;
  } catch (err) {
    logStep('error', `${label} threw: ${err.message}`, {
      kind,
      durationMs: Date.now() - started,
      ...(sql ? { sql } : {}),
      ...(detail || {}),
    });
    throw err;
  }
}

module.exports = {
  createExecutionSink,
  runWithExecutionLog,
  logStep,
  traceCall,
  isTracing,
  setBatchWindow,
  batchWindow,
  batchRowRange,
  safeConfig,
  truncate,
};
