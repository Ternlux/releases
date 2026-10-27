/**
 * Sandbox utilities exposed to AI-generated transformation functions.
 *
 * Every helper is a thin wrapper around the bundle electron.js injects via
 * `params.helpers` — the skill imports nothing outside this directory.
 *
 * The generated function signature is:
 *   async function transform(records, ctx) { ... return outputRecords; }
 *
 * `ctx` exposes single-call async helpers so the AI's code stays small.
 */

/**
 * Build the `ctx` helper object for the generated transform function.
 * @param {Object} helpers - The helpers bundle injected by skills:execute.
 * @param {Set<string>} [secrets] - Collects every credential value handed to
 *   the function, so the caller can scrub them back out of its output. See
 *   `scrubSecrets`.
 */
function buildContext(helpers, secrets = null) {
  if (!helpers) throw new Error('helpers bundle is required');

  return {
    connections: (helpers.connections || []).map((c) => ({
      id: c.id || c._id,
      name: c.name,
      dbType: c.dbType,
      dbCategory: c.dbCategory
    })),
    aiProviders: helpers.aiProviders || [],
    embeddingProviders: helpers.embeddingProviders || [],

    // Unified connection / file access. `connection` is either the saved
    // connection's name/id or a local dbType ('duckdb' | 'sqlite' | 'lancedb');
    // when `dbPath` is provided the call routes to the local lib.
    runQuery:    (connection, query, dbPath = null)             => helpers.runQuery(connection, query, dbPath),
    getTables:   (connection, dbPath = null)                    => helpers.getTables(connection, dbPath),
    getColumns:  (connection, table, schema = null, dbPath = null) => helpers.getColumns(connection, table, schema, dbPath),

    // Model calls.
    askAi:       (prompt, opts = {})         => helpers.callAI(prompt, opts),
    vectorize:   (texts, opts = {})          => helpers.vectorize(texts, opts),

    // Credentials for an API connection, resolved at call time.
    //
    // This is the ONLY way a generated function can authenticate against a
    // saved API connection. The decryption happens here, in the main process,
    // while the function is already running — the key/value pairs the user
    // saved never appear in the generated source, so nothing that is written,
    // logged, or handed back to the model carries a secret. The function must
    // read them from the returned object at run time, e.g.
    //   const { baseUrl, params } = await ctx.apiCredentials('fixer trading API');
    //   await ctx.axios.get(baseUrl + 'api/latest', { params: { access_key: params['api key'] } });
    apiCredentials: async (connection) => {
      if (typeof helpers.getFullConfig !== 'function') {
        throw new Error('apiCredentials is unavailable (getFullConfig not injected)');
      }
      const ref = String(connection == null ? '' : connection).trim();
      if (!ref) throw new Error('apiCredentials requires a connection name or id');

      const conn = (helpers.connections || []).find(
        (c) => (c.id || c._id) === ref || c.name === ref
      );
      if (!conn) throw new Error(`Connection not found: ${ref}`);

      const full = await helpers.getFullConfig(conn.id || conn._id, conn.dbConfig || {});
      const params = {};
      (Array.isArray(full.apiParams) ? full.apiParams : []).forEach((p) => {
        const key = String((p && p.key) || '').trim();
        if (!key) return;
        const value = p.value == null ? '' : String(p.value);
        params[key] = value;
        // Remember what we handed out so the caller can strip it back out of
        // the function's output. The realistic leak isn't malicious code — it
        // is an API that echoes your request back inside its response body,
        // which the function then returns as a row.
        if (secrets && value) secrets.add(value);
      });

      return { baseUrl: full.baseUrl || '', params };
    },

    // Misc.
    axios: helpers.axios,
    log: (...args) => console.log('[js-skill]', ...args)
  };
}

const REDACTED = '[redacted credential]';

/**
 * Replace any credential the sandbox handed out with a marker, anywhere in the
 * function's output — object values, keys, array items, nested structures.
 *
 * This is a backstop, not a proof: it matches the exact string that was
 * handed out. A value the endpoint returns re-encoded (URL-escaped, hashed,
 * split across fields) will not be caught. Its job is the common case — an API
 * echoing `{"query": {"access_key": "..."}}` straight back into a row.
 */
function scrubSecrets(value, secrets) {
  if (!secrets || secrets.size === 0) return value;

  const scrubString = (str) => {
    let out = str;
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };

  const walk = (node, depth) => {
    if (depth > 12) return node;
    if (typeof node === 'string') return scrubString(node);
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
    if (node && typeof node === 'object') {
      // Leave class instances (Date, Buffer, …) alone — rewriting them would
      // change their type, and a credential doesn't hide inside one.
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) return node;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[walk(k, depth + 1)] = walk(v, depth + 1);
      }
      return out;
    }
    return node;
  };

  return walk(value, 0);
}

module.exports = { buildContext, scrubSecrets, REDACTED };
