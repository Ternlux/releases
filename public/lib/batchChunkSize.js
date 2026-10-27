/**
 * How many rows to hand a connector's `batchInsert` in one call.
 *
 * The default suits row-at-a-time engines, where a chunk becomes one multi-row
 * INSERT and the limit that matters is statement size. It is the wrong shape
 * for an engine that turns each call into a JOB rather than a statement:
 * BigQuery's connector runs a load job per call, and load jobs are capped at
 * 1,500 per table per day — so small chunks would cap a table at a fraction of
 * a day's data regardless of how much there was to write.
 *
 * A connector with a different per-call limit declares `batchInsertChunkSize`
 * in its module exports — larger or smaller than the default. Nothing else
 * changes: the caller still loops, and a chunk smaller than the preference
 * (the last one, or a short source) is passed through as-is.
 *
 * Bigger chunks cost memory — a chunk is materialised in full before the call —
 * so a connector should ask for the size that keeps it under whatever per-call
 * limit it actually has, not the largest it could survive. The default is
 * deliberately large: writing a few million rows a thousand at a time is
 * dominated by per-call overhead (a round trip, a statement parse, a load job),
 * and that overhead, not the row count, is what made big writes take minutes.
 */

const DEFAULT_BATCH_CHUNK_SIZE = 50000;

/**
 * @param {object} plugin - Connector module (may be null/undefined).
 * @param {number} [fallback] - Size to use when the plugin states no preference.
 * @returns {number} A positive integer chunk size.
 */
function batchChunkSizeFor(plugin, fallback = DEFAULT_BATCH_CHUNK_SIZE) {
  const preferred = Number(plugin && plugin.batchInsertChunkSize);
  if (Number.isFinite(preferred) && preferred >= 1) {
    return Math.floor(preferred);
  }

  // A caller may pass a deliberate fallback (e.g. "this batch is already
  // chunked, don't re-chunk it"). Only guard against it being unusable.
  const floor = Number(fallback);
  return Number.isFinite(floor) && floor >= 1 ? Math.floor(floor) : DEFAULT_BATCH_CHUNK_SIZE;
}

module.exports = { batchChunkSizeFor, DEFAULT_BATCH_CHUNK_SIZE };
