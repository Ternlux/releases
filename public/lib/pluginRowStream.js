const { DEFAULT_BATCH_CHUNK_SIZE } = require('./batchChunkSize');

/**
 * A connector's `streamQuery`, as an async iterable of rows.
 *
 * Lives in lib/ rather than in a transformer because two unrelated readers need
 * it: loading a remote source into a local table (transfomers/DuckDB.js
 * databaseToLocal) and reading a remote source for an output node
 * (NodeExecution/sourcePages.js). One implementation, so the backpressure and
 * the abort-on-abandon below cannot drift apart between them.
 *
 * Connectors stream by CALLBACK — `streamQuery(config, connectionId, sql,
 * onBatch, batchSize)` — and every one of them pauses its cursor until the
 * promise `onBatch` returns settles. It resolves to `{ success, totalRows }`;
 * it is NOT an async iterable, and its third argument is the SQL STRING, not a
 * `{ query }` object. Consuming it as `for await (… of plugin.streamQuery(…,
 * { query: sql }))` therefore failed before a single row moved, with
 * "streamQuery(...) is not a function or its return value is not async
 * iterable" — every remote-source-to-local transform on every SQL connector.
 * `Sqlite.databaseToLocal` has always called it correctly; this is the same
 * call, adapted for a consumer that PULLS.
 *
 * Backpressure is preserved: a batch is handed over, and its `onBatch` stays
 * unresolved until the consumer has taken every row out of it, so the connector
 * never reads further ahead than one batch of the writer.
 *
 * `batchSize` is the connector's own read size, which every one of them
 * defaults to 1000. That is a lot of cursor round trips for a large table and
 * it is the reader's peak memory, so callers that know what they are feeding
 * pass their own: the local-pull transform uses the shared batch default, and
 * an output-node read uses its page size so a page is one read rather than
 * five.
 */
async function* streamPluginRows(plugin, fullConfig, connectionId, sql, batchSize = DEFAULT_BATCH_CHUNK_SIZE) {
  const pending = [];
  let releaseBatch = null;  // resolves the onBatch currently in flight
  let abortBatch = null;    // …and rejects it, which is how the source is stopped
  let wake = null;          // resolves the consumer's wait
  let finished = false;
  let failure = null;

  const signal = () => {
    if (!wake) return;
    const resume = wake;
    wake = null;
    resume();
  };

  const streaming = plugin.streamQuery(
    fullConfig,
    connectionId,
    sql,
    (batch) => new Promise((resolve, reject) => {
      pending.push(Array.isArray(batch) ? batch : (batch?.rows || []));
      releaseBatch = resolve;
      abortBatch = reject;
      signal();
    }),
    batchSize,
  ).then(
    (result) => {
      // A connector reports failure by RETURNING { success: false } rather than
      // throwing — the same shape runQuery uses.
      if (result && result.success === false) {
        failure = new Error(result.message || 'Source query failed');
      }
      finished = true;
      signal();
    },
    (err) => { failure = err; finished = true; signal(); },
  );

  try {
    for (;;) {
      while (pending.length) {
        for (const row of pending.shift()) yield row;
        if (releaseBatch) {
          const resume = releaseBatch;
          releaseBatch = null;
          abortBatch = null;
          resume();
        }
      }
      if (failure) throw failure;
      if (finished) break;
      // Nothing to hand over yet. Checked immediately before this line and with
      // no await between, so a batch arriving now cannot be missed.
      await new Promise((resolve) => { wake = resolve; });
    }

    await streaming;
    if (failure) throw failure;
  } finally {
    // The consumer left without draining us — it threw, or the run was stopped
    // part-way through staging these rows. The connector is parked on an
    // onBatch promise that will now never be resolved, and every one of them
    // holds an open cursor and a pooled client until it settles.
    //
    // Rejecting is what releases it, and it is also what STOPS it: each
    // connector's streamQuery closes the cursor and releases the client when
    // onBatch rejects (see the try/catch around `await onBatch(...)` in
    // plugins/connectors/*/index.js). Resolving instead would free the
    // connection but set the source reading again — the whole table, for a run
    // nobody is waiting on any more.
    //
    // `streaming` already has both handlers attached above, so the rejection it
    // takes is observed and cannot surface as an unhandled rejection.
    if (abortBatch) {
      const abort = abortBatch;
      abortBatch = null;
      releaseBatch = null;
      abort(new Error('Row stream abandoned by its consumer.'));
    }
  }
}

module.exports = { streamPluginRows };
