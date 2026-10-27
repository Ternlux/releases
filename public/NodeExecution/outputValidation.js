/**
 * Output validation — runs a workflow's AI-authored validate(ctx) function once
 * at the END of a successful execution, to confirm the produced output actually
 * satisfies the pipeline's goal.
 *
 * The function is authored by chatAssistant.generateValidationFunction and saved
 * onto the workflow doc as `outputValidation.validationFunction`. Here we build a
 * ctx (the same helper surface transformer/join code use — see
 * NodeExecution.buildJoinCtx) but with askAi/axios WRAPPED to count requests and
 * enforce fixed conservative caps, then run the function and normalize its result
 * to { valid, reason }.
 *
 * A failing validation does NOT roll back or fail the run — the caller keeps the
 * execution status 'completed' and records this result for the UI to surface.
 */

// Fixed conservative request budget for a single validation run. Kept small on
// purpose: validation should lean on cheap deterministic checks (counts, nulls,
// ranges) and use AI/HTTP sparingly on small samples.
const MAX_AI_CALLS = 20;
const MAX_HTTP_CALLS = 30;

/**
 * Build the ctx handed to the validation function. Mirrors NodeExecution's
 * buildJoinCtx, but wraps askAi + axios so the function can see how many
 * requests it has made (ctx.requestCounts) against the caps (ctx.limits), and
 * so exceeding a cap throws rather than running away.
 */
function buildValidationCtx(helpers, counts) {
  const limits = { ai: MAX_AI_CALLS, http: MAX_HTTP_CALLS };

  const askAi = async (prompt, opts = {}) => {
    if (counts.ai >= limits.ai) {
      throw new Error(`validation AI-call budget exceeded (limit ${limits.ai})`);
    }
    counts.ai += 1;
    return helpers.callAI(prompt, opts);
  };

  const axios = async (config) => {
    if (counts.http >= limits.http) {
      throw new Error(`validation HTTP-call budget exceeded (limit ${limits.http})`);
    }
    counts.http += 1;
    return helpers.axios(config);
  };

  return {
    connections: (helpers.connections || []).map((c) => ({
      id: c.id || c._id,
      name: c.name,
      dbType: c.dbType,
      dbCategory: c.dbCategory,
    })),
    aiProviders: helpers.aiProviders || [],
    embeddingProviders: helpers.embeddingProviders || [],
    runQuery:   (connection, query, dbPath = null)                => helpers.runQuery(connection, query, dbPath),
    getTables:  (connection, dbPath = null)                       => helpers.getTables(connection, dbPath),
    getColumns: (connection, table, schema = null, dbPath = null) => helpers.getColumns(connection, table, schema, dbPath),
    askAi,
    vectorize:  (texts, opts = {}) => helpers.vectorize(texts, opts),
    axios,
    log: (...args) => console.log('[validate-fn]', ...args),
    // Introspection so the function can self-throttle.
    requestCounts: counts,
    limits,
  };
}

// Normalize whatever the function returned into { valid, reason }. Accepts the
// bare string "valid", a boolean, or { valid, reason }.
function normalizeResult(raw) {
  if (typeof raw === 'string') {
    if (raw.trim().toLowerCase() === 'valid') return { valid: true, reason: '' };
    return { valid: false, reason: raw.trim() };
  }
  if (typeof raw === 'boolean') {
    return { valid: raw, reason: raw ? '' : 'validation function returned false' };
  }
  if (raw && typeof raw === 'object') {
    return {
      valid: Boolean(raw.valid),
      reason: String(raw.reason || '').trim(),
    };
  }
  return { valid: false, reason: 'validation function returned an unrecognized result' };
}

/**
 * Run a workflow's output-validation function, if enabled. Returns null when
 * there is nothing to run, otherwise { valid, reason, aiCalls, httpCalls }.
 *
 * @param {object}   params.workflow        the workflow doc (reads outputValidation)
 * @param {object}   params.helpers         the execution helpers bundle (must expose buildSkillHelpers)
 */
async function runOutputValidation({ workflow, helpers }) {
  const ov = workflow && workflow.outputValidation;
  if (!ov || !ov.enabled) return null;
  const fnSource = typeof ov.validationFunction === 'string' ? ov.validationFunction.trim() : '';
  if (!fnSource) return null;
  if (!helpers || typeof helpers.buildSkillHelpers !== 'function') {
    return { valid: false, reason: 'validation could not run: execution helpers unavailable', aiCalls: 0, httpCalls: 0 };
  }

  const counts = { ai: 0, http: 0 };
  try {
    const skillHelpers = await helpers.buildSkillHelpers();
    const ctx = buildValidationCtx(skillHelpers, counts);
    // Same execution mechanism as NodeExecution.handleExecuteBranch, wrapped so
    // an async validate(ctx) can be awaited.
    const runner = new Function(
      'ctx',
      `return (async () => { const fn = (${fnSource}); return await fn(ctx); })();`,
    );
    const raw = await runner(ctx);
    const { valid, reason } = normalizeResult(raw);
    return { valid, reason, aiCalls: counts.ai, httpCalls: counts.http };
  } catch (err) {
    return {
      valid: false,
      reason: `validation error: ${err.message || String(err)}`,
      aiCalls: counts.ai,
      httpCalls: counts.http,
    };
  }
}

module.exports = { runOutputValidation, buildValidationCtx, MAX_AI_CALLS, MAX_HTTP_CALLS };
