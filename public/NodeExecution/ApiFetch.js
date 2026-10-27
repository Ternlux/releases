/**
 * ApiFetch — execute a REST API fetch function authored on a DataSource node.
 *
 * The renderer never sees decrypted secrets. It hands us:
 *   - apiConnectionId / apiConnectionConfig (public parts of the connection).
 *   - apiFetchCode — a JavaScript async function expression string produced
 *     by the AI. It may contain `{{PLACEHOLDER}}` tokens from a fixed
 *     vocabulary, placed inside string literals or template literals.
 *   - targetCollection + operationMode (what to name the rows and how to write them).
 *
 * We merge the public config with keychain-decrypted credentials via the
 * injected `getFullConfig(connectionId, baseConfig)` (same helper Postgres /
 * Slack use in the main process). We substitute placeholders into the code
 * string, evaluate the function, and invoke it with a configured `axios` so
 * it can perform any looping / pagination logic the user described. The
 * function returns an array of rows, which we materialise as this node's own
 * output table in the workflow's database — the same place a transformer or
 * join writes, so an API source is just another local table to everything
 * downstream.
 */

const axios = require('axios');
const duck = require('../duckdb');
const { resolveOutputPath } = require('../transfomers/DuckDB');
const { normaliseParams, buildParamTokens } = require('../lib/apiPlaceholders');

// Wired by initialize() from electron.js main.
let getFullConfig = null;

function initialize(configGetter) {
  getFullConfig = configGetter;
}

// ── Placeholder substitution ────────────────────────────────────────────────

/**
 * Build the placeholder map for the resolved connection config.
 * Called only after `getFullConfig` has merged in the decrypted secrets.
 *
 * Two sources feed the map:
 *   - `apiParams` — the user's own key/value list (current connections). Each
 *     key becomes a token via the shared normalisation in lib/apiPlaceholders,
 *     so "X-API-Key" resolves `{{X_API_KEY}}`.
 *   - the legacy authType fields, kept so connections saved before the
 *     key/value editor existed keep resolving. Reserved tokens win over user
 *     keys, which buildParamTokens already guarantees.
 */
function buildPlaceholderMap(fullConfig) {
  const authType = fullConfig.authType || 'none';

  let authHeaderName = '';
  let authHeaderValue = '';

  if (authType === 'bearer' && fullConfig.bearerToken) {
    authHeaderName = 'Authorization';
    authHeaderValue = `Bearer ${fullConfig.bearerToken}`;
  } else if (authType === 'apiKey' && fullConfig.apiKeyValue) {
    authHeaderName = (fullConfig.apiKeyName && String(fullConfig.apiKeyName).trim()) || 'X-API-Key';
    authHeaderValue = String(fullConfig.apiKeyValue);
  } else if (authType === 'basic' && (fullConfig.basicUser || fullConfig.basicPassword)) {
    authHeaderName = 'Authorization';
    const encoded = Buffer
      .from(`${fullConfig.basicUser || ''}:${fullConfig.basicPassword || ''}`)
      .toString('base64');
    authHeaderValue = `Basic ${encoded}`;
  }

  const paramMap = {};
  buildParamTokens(normaliseParams(fullConfig.apiParams))
    .forEach(({ token, value }) => { paramMap[token] = value; });

  return {
    ...paramMap,
    BASE_URL: fullConfig.baseUrl ? String(fullConfig.baseUrl) : '',
    AUTH_HEADER_NAME: authHeaderName,
    AUTH_HEADER_VALUE: authHeaderValue,
    BEARER_TOKEN: fullConfig.bearerToken || '',
    API_KEY_VALUE: fullConfig.apiKeyValue || '',
    BASIC_USERNAME: fullConfig.basicUser || '',
    BASIC_PASSWORD: fullConfig.basicPassword || '',
  };
}

// Escape a value so that when inserted in place of {{PLACEHOLDER}} inside a
// single-quoted, double-quoted, or template JS string the resulting source
// stays valid. The prompt requires placeholders to only appear inside string
// contexts, so this escape suffices.
function escapeForJsString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function substituteCode(code, map) {
  if (typeof code !== 'string') return '';
  return code.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_full, name) =>
    Object.prototype.hasOwnProperty.call(map, name)
      ? escapeForJsString(map[name])
      : ''
  );
}

// ── The axios a fetch function is given ─────────────────────────────────────

/** "GET https://host/path" — never the query string, which can carry a key. */
function describeRequest(config = {}) {
  const method = String(config.method || 'get').toUpperCase();
  try {
    const u = new URL(config.url, config.baseURL || undefined);
    return `${method} ${u.origin}${u.pathname}`;
  } catch (_) {
    return `${method} ${String(config.url || '').split('?')[0]}`;
  }
}

/**
 * axios with HTTP errors made fatal. A 4xx/5xx is a failed fetch even when the
 * generated function passes its own `validateStatus` to let it through — that
 * is how a 404 used to come back as one row of its error body and build as a
 * working source. The error names the status and the endpoint, which is what
 * the user needs to fix it.
 */
function strictAxios() {
  const instance = axios.create();
  const fail = (status, config) => `HTTP ${status} from ${describeRequest(config)}`;
  instance.interceptors.response.use(
    (response) => {
      if (response.status >= 400) {
        const err = new Error(fail(response.status, response.config));
        err.response = response;
        throw err;
      }
      return response;
    },
    (error) => {
      if (error?.response) error.message = fail(error.response.status, error.config);
      return Promise.reject(error);
    },
  );
  // Statics a function may reach for on the default export.
  for (const k of ['isAxiosError', 'isCancel', 'all', 'spread', 'CancelToken', 'AxiosError']) {
    if (axios[k] !== undefined) instance[k] = axios[k];
  }
  return instance;
}

/** An empty object is no data — e.g. `{}` from an endpoint that does not exist. */
const isEmptyRow = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0;

// ── Main runner ─────────────────────────────────────────────────────────────

/**
 * Execute the AI-authored fetch function and persist the rows it returns.
 *
 * @param {Object} params
 * @param {string} params.apiConnectionId
 * @param {Object} params.apiConnectionConfig - public config from the saved connection record
 * @param {string} params.apiFetchCode - async function expression (with placeholders)
 * @param {string} params.targetCollection - target collection name
 * @param {string} [params.operationMode='new_table'] - 'new_table' replaces, 'append' adds
 *
 * @returns {Promise<{success:boolean, rowCount?:number, collection?:string,
 *                    localPath?:string, sampleRow?:object, error?:string}>}
 */
async function handleExecuteApiFetch({
  apiConnectionId,
  apiConnectionConfig = {},
  apiFetchCode,
  targetCollection,
  operationMode = 'new_table',
  // Optional — writes the fetched rows as a table in the workflow's own
  // database instead of a standalone Parquet file.
  workflowId = null,
  nodeId = null,
}) {
  try {
    if (!getFullConfig) {
      return { success: false, error: 'ApiFetch not initialized (getFullConfig missing)' };
    }
    if (!apiFetchCode || typeof apiFetchCode !== 'string') {
      return { success: false, error: 'Missing apiFetchCode' };
    }
    if (!targetCollection || typeof targetCollection !== 'string') {
      return { success: false, error: 'Missing targetCollection' };
    }

    // 1. Merge public config with decrypted secrets (main-process only).
    const fullConfig = await getFullConfig(apiConnectionId, apiConnectionConfig);

    // 2. Substitute the parameterised placeholders (base URL, auth header,
    //    API keys, etc.) with the actual decrypted values before evaluating
    //    the code.
    const map = buildPlaceholderMap(fullConfig);
    const resolvedCode = substituteCode(apiFetchCode, map);

    // 3. Turn the resolved source into a callable function. Wrapping in
    //    parentheses converts a function declaration into a function
    //    expression, so the AI may return either form.
    let fetchFn;
    try {
      const factory = new Function(`return (${resolvedCode});`);
      fetchFn = factory();
    } catch (err) {
      return { success: false, error: `Failed to load fetch function: ${err.message}` };
    }
    if (typeof fetchFn !== 'function') {
      return { success: false, error: 'apiFetchCode did not resolve to a function' };
    }
    // NB: do not log `fetchFn` — at this point the placeholders have been
    // replaced with the decrypted credentials, so printing the source puts the
    // user's keys in the console/log output.
    // 4. Invoke it with axios. The function is responsible for any looping /
    //    pagination and returns either an array of rows or a single object.
    let rawResult;
    try {
      rawResult = await fetchFn({ axios: strictAxios() });
    } catch (err) {
      return { success: false, error: `Fetch function threw: ${err.message}` };
    }

    const rows = normaliseRows(rawResult).filter((r) => !isEmptyRow(r));

    // Fetched rows are materialised as this node's output table in the
    // workflow's database — the same place a transformer or join writes — so
    // an API source is just another local table to everything downstream.
    const localPath = resolveOutputPath(targetCollection, { workflowId, nodeId });

    if (rows.length === 0) {
      return {
        success: true,
        rowCount: 0,
        collection: targetCollection,
        localPath,
        sampleRow: null,
        message: 'No rows returned by the API.',
      };
    }

    try {
      await duck.withWorkflowLock(
        workflowId,
        () => duck.ingestRowsToTable(rows, workflowId, targetCollection),
      );
    } catch (err) {
      return { success: false, error: `Failed to write rows: ${err.message}` };
    }

    return {
      success: true,
      rowCount: rows.length,
      collection: targetCollection,
      localPath,
      sampleRow: rows[0],
    };
  } catch (err) {
    console.error('[handleExecuteApiFetch] error:', err);
    return { success: false, error: err.message || 'API fetch failed' };
  }
}

function normaliseRows(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'object') return [value];
  return [{ value }];
}

/**
 * The `sourceTableSchema` of an API source's table, read back off the table a
 * fetch just wrote: real column types (a nested object is a STRUCT) and a few
 * sample rows. Shared by the build (when an approved fetch runs mid-plan) and
 * the runner (the first approved "Run this node"), so both describe the table
 * the same way. Falls back to the keys of `sampleRow` if the read fails.
 */
async function describeApiTable({ workflowId, collection, sampleRow = null, limit = 5 }) {
  try {
    const ref = await duck.workflowTableRef(workflowId, collection);
    const { rows, columns } = await duck.query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 5}`);
    const strip = (r) => { if (!r || typeof r !== 'object') return r; const { _id, ...rest } = r; return rest; };
    return {
      tableName: collection,
      columns: (columns || []).filter((c) => c.name !== '_id').map((c) => ({ name: c.name, type: c.type || 'unknown' })),
      sampleData: (rows || []).map(strip),
    };
  } catch (err) {
    console.warn(`[ApiFetch] Could not read back "${collection}":`, err.message);
    const keys = sampleRow && typeof sampleRow === 'object' ? Object.keys(sampleRow).filter((k) => k !== '_id') : [];
    return {
      tableName: collection,
      columns: keys.map((name) => ({ name, type: 'unknown' })),
      sampleData: sampleRow ? [sampleRow] : [],
    };
  }
}

module.exports = {
  initialize,
  handleExecuteApiFetch,
  describeApiTable,
};
