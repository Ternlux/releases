/**
 * Google BigQuery Connector Plugin for Ternlux
 * Handles all BigQuery database operations
 *
 * Authentication is OAuth2, the same user-consent flow the other Google
 * connectors use (Drive, Sheets, GCS): the app opens a browser, captures the
 * redirect, and stores the resulting tokens on the connection. Queries then
 * run AS THE USER, so their own BigQuery IAM roles decide what they can read
 * and write — there is no service-account key to mint, hand around, or leak.
 */

const {
  BigQuery,
  BigQueryDate,
  BigQueryDatetime,
  BigQueryInt,
  BigQueryTime,
  BigQueryTimestamp,
  Geography,
} = require('@google-cloud/bigquery');
const { OAuth2Client } = require('google-auth-library');
const { Readable } = require('stream');

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/oauth/callback';

// The client hands temporal, large-integer and geography columns back as WRAPPER
// OBJECTS, not primitives: a TIMESTAMP arrives as a BigQueryTimestamp whose only
// own property is `value`. Every consumer downstream treats a row value as a
// scalar, so the wrapper survives all the way to whatever writes it — a join
// staging its sources produced
//   Timestamp '{"value":"2025-09-19T17:02:45.000Z"}' is not recognized
// because the object was stringified into the INSERT, and nedb refused the same
// rows outright ("Field names cannot contain a .") once a wrapper reached a
// document. Unwrapping at the connector's edge is the only place that fixes all
// of them at once.
//
// Detection is by the library's own classes rather than by "has a `value` key",
// so a genuine STRUCT the user selected as `foo.value` is never mistaken for a
// wrapper. `.value` is a string in every case — including BigQueryInt, where an
// integer beyond Number.MAX_SAFE_INTEGER must stay a string to survive at all.
const BQ_WRAPPERS = [
  BigQueryTimestamp, BigQueryDate, BigQueryDatetime, BigQueryTime, BigQueryInt, Geography,
].filter(Boolean);

// Constructor identity, not `instanceof`. The client instantiates these concrete
// classes directly, so one Set lookup answers what six instanceof checks did —
// each of which walks a prototype chain, on every object-valued cell of every
// row. `instanceof` is kept below as a fallback for the one case identity can
// miss (a subclass), reached only by objects that are neither plain nor arrays.
const BQ_WRAPPER_CTORS = new Set(BQ_WRAPPERS);

/**
 * Unwrap one value. Copy-on-write: returns the input itself when nothing
 * changed, so callers holding foreign data (batchInsert) are never mutated.
 */
function unwrapBigQueryValue(val) {
  if (val === null || typeof val !== 'object') return val;
  if (BQ_WRAPPER_CTORS.has(val.constructor)) return val.value;
  // Binary and dates are already usable — recursing into them would take them apart.
  if (Buffer.isBuffer(val) || val instanceof Date) return val;

  // Nested STRUCT / ARRAY columns carry wrappers of their own.
  if (Array.isArray(val)) {
    let out = null;
    for (let i = 0; i < val.length; i++) {
      const v = val[i];
      const next = unwrapBigQueryValue(v);
      if (next !== v) {
        if (!out) out = val.slice();
        out[i] = next;
      }
    }
    return out || val;
  }

  if (val.constructor !== Object && val.constructor !== undefined) {
    // Not a plain object and not a known wrapper — check the chain before
    // treating it as a STRUCT to walk.
    for (const Wrapper of BQ_WRAPPERS) {
      if (val instanceof Wrapper) return val.value;
    }
  }

  let out = null;
  // `for..in` over own keys rather than Object.entries, which allocates a
  // two-element array per property per row.
  for (const key in val) {
    if (!Object.prototype.hasOwnProperty.call(val, key)) continue;
    const v = val[key];
    const next = unwrapBigQueryValue(v);
    if (next !== v) {
      if (!out) out = { ...val };
      out[key] = next;
    }
  }
  return out || val;
}

/**
 * Unwrap a whole result set, in place.
 *
 * Built for size. Two things make the difference on a large read:
 *
 *   1. Only the columns that CAN wrap are visited. A SQL result set is
 *      rectangular — every row carries the same columns — so the candidate
 *      columns are decided once from the first row and reused. A column that is
 *      a scalar in row 0 is a scalar in every row, and is never touched again.
 *      A column that is null in row 0 has an unknown type, so it stays a
 *      candidate: that is what keeps this correct rather than merely fast.
 *   2. Rows are mutated, not rebuilt. They come straight from the client and
 *      are owned by us, so cloning each one only to assign one field back is
 *      pure garbage. The nested walk above stays copy-on-write.
 *
 * The common case — a result set with no wrapping columns at all — costs one
 * Object.keys on the first row and then returns.
 */
function candidateKeys(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = [];
  for (const key in row) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const v = row[key];
    // An object may wrap or contain a wrapper; null/undefined hides its type.
    if (v === null || v === undefined || typeof v === 'object') keys.push(key);
  }
  return keys.length ? keys : null;
}

function unwrapRowInPlace(row, keys) {
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const v = row[key];
    if (v === null || typeof v !== 'object') continue;
    const next = unwrapBigQueryValue(v);
    if (next !== v) row[key] = next;
  }
  return row;
}

function unwrapBigQueryRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const keys = candidateKeys(rows[0]);
  if (!keys) return rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && typeof row === 'object') unwrapRowInPlace(row, keys);
  }
  return rows;
}

// The BigQuery scope covers datasets, tables, jobs and streaming inserts —
// everything this connector calls. It grants reach, not permission: the
// signed-in user still needs BigQuery Data Viewer/Editor and Job User.
const SCOPES = ['https://www.googleapis.com/auth/bigquery'];

// BigQuery client cache
const bigQueryClients = new Map();
const tokenRefreshCallbacks = new Map();

/**
 * Build an OAuth2 client from the tokens stored on the connection.
 */
function createOAuthClient(config) {
  const oauth2Client = new OAuth2Client(
    config.clientId,
    config.clientSecret,
    config.redirectUri || DEFAULT_REDIRECT_URI
  );

  if (config.accessToken || config.refreshToken) {
    oauth2Client.setCredentials({
      access_token: config.accessToken,
      refresh_token: config.refreshToken,
      scope: config.scope,
      token_type: 'Bearer',
      expiry_date: config.expiryDate
    });
  }

  return oauth2Client;
}

/**
 * True when the connection was saved with OAuth rather than a service account.
 */
function isOAuthConfig(config) {
  return !!(config.clientId || config.accessToken || config.refreshToken);
}

/**
 * Get or create BigQuery client
 *
 * `authClient` hands the BigQuery library a ready-made credential instead of
 * letting it hunt for application-default ones, which is what lets an OAuth2
 * user client stand in for a service-account key. `projectId` must still be
 * supplied — it is the billing/query project, and a user token carries none.
 *
 * Service-account fields are still honoured so connections saved before the
 * move to OAuth keep working; nothing in the form writes them any more.
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!bigQueryClients.has(key)) {
    const options = {
      projectId: config.projectId,
    };

    if (isOAuthConfig(config)) {
      const oauth2Client = createOAuthClient(config);

      // The library refreshes an expired access token on its own; this is how
      // the new one gets back out to the stored connection rather than living
      // only in this process.
      oauth2Client.on('tokens', (tokens) => {
        const callback = connectionId && tokenRefreshCallbacks.get(connectionId);
        if (!callback) return;
        Promise.resolve(callback({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || config.refreshToken,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope
        })).catch(err => console.error('[BigQuery] Token persist error:', err));
      });

      options.authClient = oauth2Client;
    } else if (config.keyFilePath) {
      options.keyFilename = config.keyFilePath;
    } else if (config.credentials) {
      // Parse credentials if it's a string
      const creds = typeof config.credentials === 'string'
        ? JSON.parse(config.credentials)
        : config.credentials;
      options.credentials = creds;
    }

    const client = new BigQuery(options);
    bigQueryClients.set(key, client);
  }

  return bigQueryClients.get(key);
}

/**
 * Resolve however a caller named a table into { datasetId, tableId }.
 *
 * Callers disagree on the shape, and all three are legitimate:
 *   - the Data Explorer passes the dataset as `schema` with a bare table;
 *   - an output node passes a qualified "dataset.table" and no schema;
 *   - an output node ALSO passes a bare "orders", meaning the connection's
 *     own dataset — which is a required config field, so it always exists.
 *
 * Each of those used to be handled differently in a different function: a bare
 * name was a hard error in batchInsert ("Invalid table name format. Expected:
 * dataset.table or project.dataset.table") while getColumns happily defaulted
 * it, so a destination that read fine could not be written to. Everything that
 * addresses a table resolves it here instead.
 *
 * An explicit `schema` wins over a qualifier in the name; a project prefix on a
 * three-part name is dropped, since the client is already bound to a project.
 */
function resolveTableRef(config, table, schema = null) {
  const parts = String(table || '').split('.');
  let datasetId = schema || config?.dataset;
  let tableId = table;

  if (parts.length === 2) {
    [, tableId] = parts;
    if (!schema) [datasetId] = parts;
  } else if (parts.length === 3) {
    [, , tableId] = parts;
    if (!schema) [, datasetId] = parts;
  }

  if (!datasetId) {
    throw new Error(
      `Cannot resolve a dataset for table "${table}". Name it as "dataset.table", `
      + 'or set the Dataset field on this connection.',
    );
  }
  return { datasetId, tableId };
}

/**
 * A driver failure, with the driver's own classification kept alongside the text.
 *
 * The message alone cannot be reasoned about — "Duplicate column name 'x'" is
 * prose that moves with the server's version and locale. The CODE is the
 * driver's own answer to what KIND of failure this is, and the transform
 * executor uses it to tell a structural change that was ALREADY APPLIED (what
 * the second run of an in-place ALTER looks like) from one that genuinely
 * failed. Callers that only read `message` are unaffected.
 */
const queryError = (error) => ({
  success: false,
  message: error.message,
  // BigQuery's `code` is the HTTP status; the specific condition is the
  // reason on the first of the errors it returns.
  code: error.code,
  reason: error.errors && error.errors[0] && error.errors[0].reason,
});

/**
 * Is this BigQuery telling us to slow down, rather than that the work was wrong?
 *
 * Matched on the REASON where there is one — `rateLimitExceeded` for the
 * per-table rate, `quotaExceeded` / `jobRateLimitExceeded` for the others — and
 * on the message only as a fallback, because a load job's rejection surfaces
 * through the write stream with the text but not always the structured reason.
 *
 * Deliberately narrow. A throttled job is one BigQuery REFUSED, so nothing was
 * written and re-sending the same chunk is safe; a job that failed while running
 * (bad rows, schema mismatch) may have written part of itself, and retrying that
 * would duplicate data. Only the first kind is retried.
 */
function isRateLimited(error) {
  const reasons = Array.isArray(error?.errors)
    ? error.errors.map((e) => String(e?.reason || ''))
    : [];
  if (reasons.some((r) => /^(rateLimitExceeded|quotaExceeded|jobRateLimitExceeded|backendError)$/.test(r))) {
    return true;
  }
  const text = `${error?.message || ''} ${reasons.join(' ')}`;
  return /exceeded rate limits|too many table update operations|quota exceeded/i.test(text);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run a load job, backing off when BigQuery throttles the table.
 *
 * BigQuery allows only ~5 table update operations per table per 10 SECONDS, and
 * every load job is one of them. That is a different limit from the 1,500 per
 * table per DAY the chunk size is sized against (see batchInsertChunkSize), and
 * it is the one a multi-chunk staging load actually hits: ten chunks fired back
 * to back are ten table updates inside a second, and BigQuery rejects the sixth
 * with "Exceeded rate limits: too many table update operations for this table".
 *
 * Waits are spaced to clear that 10-second window rather than to be polite in
 * general — the first retry already waits long enough for the window to roll —
 * with jitter so parallel loads into one table do not line up and collide again
 * on every attempt. Google's own guidance for these reasons is exponential
 * backoff; there is no way to ask for a quota increase on this one.
 */
async function withLoadRetry(run, { attempts = 6, baseMs = 2500, label = 'load job' } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      const backoff = baseMs * (2 ** attempt);
      const wait = Math.min(backoff, 30000) + Math.floor(Math.random() * 1000);
      console.warn(
        `[bigquery] ${label} throttled (${error.message || 'rate limited'}) — `
        + `retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${attempts})`,
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

module.exports = {
  type: 'connector',
  id: 'bigquery',
  name: 'Google BigQuery',
  icon: './icon.svg',
  dbCategory: 'SQL',
  // See postgres: how a join may merge into this database (write mode "merge").
  mergeSupport: {
    statements: ['MERGE'],
    guidance: 'MERGE {{TARGET}} t USING (<the joined SELECT>) s ON t.<key> = s.<key> '
      + 'WHEN MATCHED THEN UPDATE SET <col> = s.<col>, … WHEN NOT MATCHED THEN INSERT (<cols>) VALUES (s.<cols>). '
      + 'Each target row may match at most one source row — de-duplicate the source on the key first.',
  },
  authType: 'oauth2',

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js.
   *
   * BigQuery's names share almost nothing with the other engines' — INT64 and
   * FLOAT64 rather than INTEGER/DOUBLE, BOOL rather than BOOLEAN, one STRING
   * with no length at all.
   */
  /**
   * Why this engine cannot create a column with this name, or null. Checked
   * before an Output creates a table, so a name the engine would refuse (or
   * silently shorten) fails with the column named and the fix, not with
   * whatever the CREATE happens to say.
   */
  columnNameProblem: (name) => {
    const text = String(name);
    // Seen refused by BigQuery itself ("Illegal field name: e.mail").
    if (text.includes('.')) return 'contains a dot, which BigQuery does not allow in a column name';
    const n = [...text].length;
    return n > 300 ? `is ${n} characters long; BigQuery allows at most 300` : null;
  },

  types: {
    NULL: () => 'STRING',
    // DATE, not TIMESTAMP, for a bare YYYY-MM-DD: BigQuery rejects a date-only
    // literal offered to a TIMESTAMP column.
    DATE_ONLY: () => 'DATE',
    TIMESTAMP: () => 'TIMESTAMP',
    BOOLEAN: () => 'BOOL',
    INTEGER: () => 'INT64',
    FLOAT: () => 'FLOAT64',
    OBJECT: () => 'STRING',
    STRING: () => 'STRING',
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js. NUMERIC holds 29 integer and 9
    // fractional digits; BIGNUMERIC the rest. TIMESTAMP is already an instant.
    DECIMAL: (p, s) => {
      if (!p) return 'BIGNUMERIC';
      const scale = s || 0;
      if (p - scale <= 29 && scale <= 9) return `NUMERIC(${p},${scale})`;
      if (p - scale <= 38 && scale <= 38) return `BIGNUMERIC(${p},${scale})`;
      return null;
    },
    TIMESTAMPTZ: () => 'TIMESTAMP',
    TIME: () => 'TIME',
  },

  /**
   * This engine's type for a column (a getColumns entry) as a canonical type —
   * what an Output writing a copy of this table elsewhere builds its column
   * from. See public/NodeExecution/columnTypes.js for the kinds. null leaves
   * the column to be guessed from its values.
   */
  toCanonicalType: (column) => {
    if (column?.mode === 'REPEATED') return { kind: 'OBJECT' };
    const t = String(column?.type || '').toUpperCase();
    if (t === 'INTEGER' || t === 'INT64') return { kind: 'BIGINT' };
    if (t === 'FLOAT' || t === 'FLOAT64') return { kind: 'DOUBLE' };
    if (t === 'NUMERIC') return { kind: 'DECIMAL', precision: column.precision ?? 38, scale: column.scale ?? 9 };
    if (t === 'BIGNUMERIC') return { kind: 'DECIMAL', precision: column.precision ?? null, scale: column.scale ?? null };
    if (t === 'BOOLEAN' || t === 'BOOL') return { kind: 'BOOLEAN' };
    if (t === 'DATE') return { kind: 'DATE_ONLY' };
    if (t === 'TIMESTAMP') return { kind: 'TIMESTAMPTZ' };
    if (t === 'DATETIME') return { kind: 'TIMESTAMP' };
    if (t === 'TIME') return { kind: 'TIME' };
    if (t === 'RECORD' || t === 'STRUCT' || t === 'JSON') return { kind: 'OBJECT' };
    return { kind: 'STRING', length: column?.maxLength ?? null };
  },

  /**
   * Rows per `batchInsert` call.
   *
   * Each call is one LOAD JOB, and BigQuery meters those TWICE over:
   *
   *   · 1,500 load jobs per table per DAY. At 25,000 rows a call that is 37.5M
   *     rows a day, past what this app streams through memory anyway, so this
   *     one is not the binding constraint.
   *   · ~5 table update operations per table per 10 SECONDS. This is the one
   *     that bites: a source needing several chunks sends them back to back,
   *     and BigQuery rejects the sixth with "Exceeded rate limits: too many
   *     table update operations for this table". At 10,000 a 100k-row source
   *     was 10 jobs and failed halfway; at 25,000 it is 4, inside the window.
   *
   * Sizing only moves where that threshold falls — a source past ~125k rows
   * still needs more than five chunks — so it is not the fix, just headroom for
   * the common case. batchInsert backs off and retries when the limit is hit
   * anyway (see withLoadRetry), which is what makes an arbitrarily large source
   * work rather than merely a bigger one.
   *
   * The ceiling on this number is memory: a chunk is materialised as NDJSON on
   * top of the rows themselves before it is sent, so it stays BELOW the caller's
   * 50,000 default. 25,000 is comfortable for ordinary rows; a table wide enough
   * that a chunk runs to hundreds of MB wants it lower again.
   */
  batchInsertChunkSize: 25000,

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const oauth2Client = createOAuthClient(config);

      const authUrl = oauth2Client.generateAuthUrl({
        // Without offline access Google returns no refresh token, and the
        // connection would stop working an hour after it was saved.
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        state: config.state
      });

      return { success: true, authUrl, scopes: SCOPES };
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Exchange authorization code for tokens
   */
  exchangeCodeForTokens: async (config, code) => {
    try {
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || DEFAULT_REDIRECT_URI
      );

      const { tokens } = await oauth2Client.getToken(code);

      return {
        success: true,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope
        }
      };
    } catch (error) {
      console.error('[BigQuery] Token exchange error:', error.response?.data?.error_description || error.message);
      return queryError(error);
    }
  },

  /**
   * Refresh access token using refresh token
   */
  refreshAccessToken: async (config) => {
    try {
      if (!config.refreshToken) {
        return { success: false, message: 'No refresh token available' };
      }

      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || DEFAULT_REDIRECT_URI
      );
      oauth2Client.setCredentials({ refresh_token: config.refreshToken });

      const { credentials } = await oauth2Client.refreshAccessToken();

      return {
        success: true,
        tokens: {
          accessToken: credentials.access_token,
          refreshToken: credentials.refresh_token || config.refreshToken,
          expiryDate: credentials.expiry_date,
          tokenType: credentials.token_type,
          scope: credentials.scope
        }
      };
    } catch (error) {
      console.error('[BigQuery] Token refresh error:', error.response?.data?.error_description || error.message);
      return queryError(error);
    }
  },

  /**
   * Register token refresh callback so the app can persist rotated tokens
   */
  registerTokenRefreshCallback: (connectionId, callback) => {
    tokenRefreshCallbacks.set(connectionId, callback);
  },

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const bigquery = getClient(config, connectionId);

      // Test connection by listing datasets (limit 1)
      const [datasets] = await bigquery.getDatasets({ maxResults: 1 });

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Get list of tables
   */
  getTables: async (config, connectionId = null) => {
    try {
      const bigquery = getClient(config, connectionId);
      const datasetId = config.dataset;

      if (!datasetId) {
        return { success: false, message: 'Dataset is required' };
      }

      const dataset = bigquery.dataset(datasetId);
      const [tables] = await dataset.getTables();

      return {
        success: true,
        // The connection's dataset, listed even while it holds no tables.
        schemas: [datasetId],
        tables: tables.map(table => ({
          schema: datasetId,
          name: table.id,
          type: table.metadata.type === 'VIEW' ? 'view' : 'table'
        }))
      };
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Get table columns
   */
  getColumns: async (config, connectionId, schema, table) => {
    try {
      const bigquery = getClient(config, connectionId);
      const { datasetId, tableId } = resolveTableRef(config, table, schema);

      const [metadata] = await bigquery
        .dataset(datasetId)
        .table(tableId)
        .getMetadata();

      const fields = metadata.schema?.fields || [];

      return {
        success: true,
        columns: fields.map(field => ({
          name: field.name,
          type: field.type,
          nullable: field.mode !== 'REQUIRED',
          isPrimary: false, // BigQuery doesn't enforce primary keys
          defaultValue: null,
          // Set only when the column was declared with them (NUMERIC(10,2),
          // STRING(40)); the field metadata carries them as strings.
          maxLength: field.maxLength != null ? Number(field.maxLength) : null,
          precision: field.precision != null ? Number(field.precision) : null,
          scale: field.scale != null ? Number(field.scale) : null,
          mode: field.mode || 'NULLABLE',
        }))
      };
    } catch (error) {
      // A table that is not there is an ANSWER — no columns — not a failed
      // lookup. Reported as an error, the Output could not tell "missing"
      // from "could not check": a CREATE that failed for a real reason
      // (an illegal column name) was taken as "may already exist", and the
      // load went on to fail three times against a table that never existed,
      // with the real reason buried in the log.
      if (error && (error.code === 404 || /^Not found: Table /.test(String(error.message)))) {
        return { success: true, columns: [] };
      }
      return queryError(error);
    }
  },

  /**
   * Run SQL query
   */
  /**
   * @param {object} [options]
   * @param {number} [options.maxRows] - Stop after this many rows.
   *
   * BigQuery caps natively: `maxResults` bounds the page the job returns, so
   * the SQL the user wrote is the SQL BigQuery runs — no LIMIT is appended and
   * no subquery is wrapped around it. `autoPaginate: false` is what keeps the
   * client from fetching every remaining page behind our back.
   *
   * The statement runs exactly ONCE on every path.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    try {
      const bigquery = getClient(config, connectionId);

      // Extract SQL query from the query object
      const sqlQuery = queryObj.query;
      const maxRows = Number(options.maxRows);

      const jobOptions = {
        query: sqlQuery,
        location: config.location || 'US',
        // Where an UNQUALIFIED name in this SQL resolves.
        //
        // Every other engine binds a default namespace when it connects — a
        // schema, a database — so bare `FROM orders` works. The BigQuery client
        // binds only a PROJECT, and the API rejects a bare name outright
        // ("must be qualified with a dataset"). resolveTableRef already defaults
        // one for the calls this connector makes itself (batchInsert, getColumns),
        // but SQL TEXT goes to the engine untouched: a join's generated
        // `CREATE TABLE temp_join_x (...)` failed, and the load that followed
        // then found no table. This is the same default, applied to the SQL path
        // so the two agree.
        //
        // A name that is already qualified is unaffected — this only fills in
        // for bare ones. A connection with no dataset configured keeps the
        // previous behaviour rather than sending an empty reference.
        ...(config.dataset ? { defaultDataset: { datasetId: config.dataset } } : {}),
      };

      const [job] = await bigquery.createQueryJob(jobOptions);
      // One past the cap, so "is there more?" is observed rather than assumed.
      const [allRows] = maxRows > 0
        ? await job.getQueryResults({ maxResults: maxRows + 1, autoPaginate: false })
        : await job.getQueryResults();

      // Unwrapped here, at the edge: everything past this point — the preview,
      // a join's temp-table load, a transform's rows — expects plain scalars.
      const rows = unwrapBigQueryRows(maxRows > 0 ? allRows.slice(0, maxRows) : allRows);

      // Extract column names from the first row or from job metadata
      let columns = [];
      if (rows.length > 0) {
        columns = Object.keys(rows[0]);
      }

      // A DML statement returns no rows; how many it changed is on the job, not
      // in the result. Without it callers reported "0 rows inserted" for a load
      // that wrote every row. BigQuery itself says whether the job was DML —
      // numDmlAffectedRows is only set for one — so nothing here guesses from
      // the SQL text. Asked only when there are no rows, so a query pays nothing.
      let affectedRows;
      if (rows.length === 0) {
        try {
          const [metadata] = await job.getMetadata();
          const n = metadata?.statistics?.query?.numDmlAffectedRows;
          if (n != null) affectedRows = Number(n);
        } catch (_err) {
          // The count is reporting only — a failed lookup must not fail a
          // statement that already succeeded.
        }
      }

      return {
        success: true,
        rows: rows,
        columns: columns,
        rowCount: affectedRows ?? rows.length,
        ...(affectedRows != null ? { affectedRows } : {}),
        ...(maxRows > 0 ? { truncated: allRows.length > maxRows } : {})
      };
    } catch (error) {
      console.error('BigQuery runQuery error:', error);
      console.error('Query that failed:', queryObj.query);
      return queryError(error);
    }
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const bigquery = getClient(config, connectionId);

      const options = {
        query: query,
        location: config.location || 'US',
        // Same default as runQuery — a streamed read of a bare table name has
        // to resolve the same way a buffered one does.
        ...(config.dataset ? { defaultDataset: { datasetId: config.dataset } } : {}),
      };

      const [job] = await bigquery.createQueryJob(options);

      return new Promise((resolve, reject) => {
        let columns = null;
        let totalRows = 0;
        let buffer = [];
        // Which columns can carry a wrapper, decided once from the first row —
        // the same amortisation unwrapBigQueryRows does for a buffered read.
        // `false` means "computed, nothing to unwrap": this is a per-row hot
        // path over the whole result set, so the all-scalar case must cost a
        // single check and no work.
        let wrapKeys = null;

        job
          .getQueryResultsStream()
          .on('data', async (row) => {
            // Extract column names from first row
            if (!columns && row) {
              columns = Object.keys(row);
            }

            // Same unwrap runQuery does — the streamed path feeds the join's
            // chunked loader, which is where a wrapped TIMESTAMP was reaching
            // the INSERT as '{"value":"…"}'.
            if (wrapKeys === null) wrapKeys = candidateKeys(row) || false;
            if (wrapKeys && row) unwrapRowInPlace(row, wrapKeys);
            buffer.push(row);

            // When buffer reaches batch size, process it
            if (buffer.length >= batchSize) {
              const batchToProcess = buffer;
              buffer = [];
              totalRows += batchToProcess.length;

              try {
                await onBatch(batchToProcess, columns);
              } catch (error) {
                reject(error);
              }
            }
          })
          .on('end', async () => {
            // Process remaining rows in buffer
            if (buffer.length > 0) {
              totalRows += buffer.length;
              try {
                await onBatch(buffer, columns);
              } catch (error) {
                reject(error);
                return;
              }
            }
            resolve({ success: true, totalRows });
          })
          .on('error', (error) => {
            reject(error);
          });
      });
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Close connection (cleanup client)
   */
  /**
   * Run several statements as ONE transaction: all of them land, or none do.
   * See the PostgreSQL connector's note — the same contract.
   *
   * BigQuery has no session to hold a transaction open across calls; a
   * multi-statement transaction is one SCRIPT, run as one query job. An error
   * inside it rolls the whole transaction back before the job reports failure.
   */
  runInTransaction: async (config, connectionId, statements) => {
    const script = ['BEGIN TRANSACTION', ...statements, 'COMMIT TRANSACTION']
      .map((s) => String(s).trim().replace(/;+$/, ''))
      .join(';\n') + ';';
    const result = await module.exports.runQuery(config, connectionId, { query: script });
    return result && result.success === false ? result : { success: true };
  },

  closeConnection: async (connectionId) => {
    if (bigQueryClients.has(connectionId)) {
      bigQueryClients.delete(connectionId);
    }
    if (tokenRefreshCallbacks.has(connectionId)) {
      tokenRefreshCallbacks.delete(connectionId);
    }
  },

  /**
   * Batch insert rows into a table, via a LOAD JOB.
   *
   * Deliberately NOT the streaming API (`table.insert` → tabledata.insertAll).
   * Streaming has its own view of which tables exist, which lags table
   * creation by seconds to minutes, so loading into a table the caller just
   * created failed with `Not found: Table` even as the CREATE reported
   * `Already Exists`. Streaming also cannot target a view or external table,
   * and parks written rows in a buffer that DML cannot touch for ~90 minutes —
   * which silently defeated the TRUNCATE the output node runs before a
   * replace-mode reload.
   *
   * A load job has none of those properties: it sees the table immediately,
   * costs nothing, and is durable the moment the job reports DONE.
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const bigquery = getClient(config, connectionId);

      const { datasetId, tableId } = resolveTableRef(config, tableName);

      const dataset = bigquery.dataset(datasetId);
      const table = dataset.table(tableId);

      // Newline-delimited JSON: one object per row, keyed by column name.
      // BigQuery matches those keys against the destination table's schema, so
      // column ORDER does not matter here — unlike a CSV load.
      const ndjson = rows.map(row => {
        const rowData = {};
        columns.forEach(col => {
          // A BigQuery→BigQuery copy hands these rows straight back to us with
          // their wrappers intact; without this the `typeof val === 'object'`
          // branch below would JSON.stringify one into the literal text
          // {"value":"…"} and load THAT as the column's value.
          const val = unwrapBigQueryValue(row[col]);
          if (val === null || val === undefined) {
            rowData[col] = null;
          } else if (val instanceof Date) {
            rowData[col] = val.toISOString();
          } else if (typeof val === 'number' && !Number.isFinite(val)) {
            // NaN / ±Infinity are not JSON, and JSON.stringify would emit the
            // bare token `null` anyway — be explicit rather than accidental.
            rowData[col] = null;
          } else if (typeof val === 'object') {
            rowData[col] = JSON.stringify(val);
          } else {
            rowData[col] = val;
          }
        });
        return JSON.stringify(rowData);
      }).join('\n');

      // Retried as a unit: the stream is built fresh each attempt because a
      // write stream cannot be re-piped once it has errored.
      const loadJob = await withLoadRetry(() => new Promise((resolve, reject) => {
        const stream = table.createWriteStream({
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          // The caller creates the table first, so the destination schema is
          // already correct. Reusing it — rather than autodetecting from this
          // chunk — is what keeps every chunk of a multi-chunk load agreeing
          // on column types instead of each guessing from its own sample.
          autodetect: false,
          // Each call appends its chunk. Replacing is the caller's business:
          // it clears the table once up front, and a WRITE_TRUNCATE here would
          // make every chunk after the first discard the ones before it.
          writeDisposition: 'WRITE_APPEND',
        });

        // A load job that fails — bad rows, schema mismatch, missing table —
        // finishes with `status.errorResult`, which the client raises as an
        // 'error' on the job and the write stream re-raises here.
        stream.on('error', reject);
        stream.on('complete', (job) => resolve(job));

        Readable.from([Buffer.from(ndjson, 'utf8')]).pipe(stream);
      }), { label: `load into ${datasetId}.${tableId}` });

      // What BigQuery says it wrote, rather than what we hoped it would.
      const outputRows = Number(loadJob?.metadata?.statistics?.load?.outputRows);

      return {
        success: true,
        rowsInserted: Number.isFinite(outputRows) ? outputRows : rows.length
      };
    } catch (error) {
      // Handle complete failure
      if (error.errors && Array.isArray(error.errors)) {
        const errorDetails = error.errors.map(e => e.message || e.errors);
        console.error('BigQuery load error:', errorDetails);
        return { success: false, message: `Insert failed: ${errorDetails}` };
      }
      console.error('BigQuery load error:', error);
      return queryError(error);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'projectId',
        type: 'string',
        label: 'Project ID',
        placeholder: 'my-gcp-project',
        required: true,
        sensitive: true,
        helpText: 'The GCP project queries are billed to. Still needed with OAuth — a user '
          + 'token carries no project of its own.'
      },
      {
        name: 'dataset',
        type: 'string',
        label: 'Dataset',
        placeholder: 'my_dataset',
        required: true,
        sensitive: false
      },
      {
        name: 'clientId',
        type: 'string',
        label: 'OAuth Client ID',
        placeholder: 'xxxxx.apps.googleusercontent.com',
        required: true,
        sensitive: true,
        helpText: 'Get this from Google Cloud Console'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'OAuth Client Secret',
        required: true,
        sensitive: true,
        helpText: 'Get this from Google Cloud Console'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: DEFAULT_REDIRECT_URI,
        default: DEFAULT_REDIRECT_URI,
        required: false,
        sensitive: false,
        helpText: 'Leave at the default. A Desktop app OAuth client accepts any loopback '
          + 'address without registering it, but Ternlux listens on port 3000 — so the port '
          + 'here must stay 3000.'
      },
      {
        name: 'location',
        type: 'string',
        label: 'Location',
        placeholder: 'US',
        default: 'US',
        required: false,
        sensitive: false
      },
      {
        name: 'accessToken',
        type: 'hidden',
        label: 'Access Token',
        required: false,
        sensitive: true
      },
      {
        name: 'refreshToken',
        type: 'hidden',
        label: 'Refresh Token',
        required: false,
        sensitive: true
      },
      {
        name: 'expiryDate',
        type: 'hidden',
        label: 'Token Expiry Date',
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating BigQuery transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetDataset, fullTableName) => `You are a Google BigQuery expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Google BigQuery
    - Target dataset: ${targetDataset}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Storage Location: ${settings.storageLocation === 'database' ? 'Database' : 'Local DuckDB'}

    ${settings.storageLocation === 'database'
      ? `**Instructions for Database Storage**:

    The target is TRUNCATED AND LOADED on every run: the executor drops it
    before your ddl runs, so your ddl always creates it fresh and your sql
    always loads it from empty. Nothing survives a run. So do not write
    IF NOT EXISTS, do not check for or delete prior rows, and do not try to
    merge, upsert, or de-duplicate against what was there last time — write the
    plain CREATE and the plain load.

    You return TWO separate statements, and the executor runs them in order:

      1. \`ddl\`  — a plain CREATE TABLE that declares the columns and types.
      2. \`sql\`  — an INSERT INTO ... SELECT that loads those columns.

    Do NOT combine them. A CREATE TABLE ... AS SELECT is not accepted here: the
    two fields are executed as separate statements, so a CTAS in \`ddl\` leaves
    \`sql\` with nothing to do.

    **\`sql\` MUST NOT BE EMPTY.** It is the only statement that puts rows in the
    table. Leave it empty and the run creates an empty table and loads nothing —
    the node reports success having produced no data. If you find yourself with
    nothing to put in \`sql\`, you have written the SELECT into \`ddl\` by
    mistake: split it back out into a CREATE plus an INSERT.

    **BigQuery-Specific Considerations**:
    - Use partitioning for large tables (PARTITION BY DATE, TIMESTAMP, or integer ranges)
    - Use clustering for frequently filtered columns (CLUSTER BY)
    - Partitioning and clustering belong on the CREATE TABLE in \`ddl\`
    - BigQuery supports nested and repeated fields (ARRAY, STRUCT)
    - Use appropriate data types (INT64, FLOAT64, STRING, BOOL, DATE, TIMESTAMP, etc.)

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement (columns + types, plus any PARTITION BY / CLUSTER BY) — creates the table, inserts nothing",
      "sql": "INSERT INTO <target> (cols...) SELECT ... — REQUIRED, this is what loads the rows",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local Storage**:
    The rows are fetched from BigQuery and written into a table in THIS
    workflow's own local DuckDB database. Nothing is written back to BigQuery.

    You provide ONE statement: the BigQuery SELECT that produces the rows you
    want. That is the only thing that runs. Its result is streamed straight into
    the local table, which is replaced on every run with the column types
    inferred from the data — so there is no CREATE TABLE to write, no INSERT,
    and no type mapping to choose. Do NOT emit "ddl" or "insertSql": nothing
    reads them, and inventing them only risks contradicting the SELECT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "sql": "BigQuery SELECT query producing the transformed rows",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT * FROM ${String(fullTableName).replace(/"/g, '')} LIMIT 100"   // reads the LOCAL table, so this one is DuckDB SQL
    }

    **Example**:
    {
      "explanation": "Fetch active customers with calculated total spending",
      "sql": "SELECT customer_id, name, email, (purchase_count * avg_purchase) AS total_spending FROM customers WHERE status = 'active'",
      "targetColumns": [{"name": "customer_id", "type": "INTEGER"}, {"name": "name", "type": "VARCHAR"}, {"name": "email", "type": "VARCHAR"}, {"name": "total_spending", "type": "DOUBLE"}],
      "previewSql": "SELECT * FROM ${String(fullTableName).replace(/"/g, '')} LIMIT 100"
    }`}

    Be specific and provide working SQL. Use BigQuery-specific features where appropriate (e.g., backticks for table names, standard SQL syntax).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetDataset, fullTableName) => `You are a Google BigQuery expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Google BigQuery
    - Target dataset: ${targetDataset}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.

    Analyze the request and determine what operations are needed:

    1. **UPDATE/DELETE only**: Use sql field only, ddl is null
    2. **ALTER TABLE only**: Use ddl field only, sql is null
    3. **ALTER TABLE + UPDATE/DELETE**: Use both ddl and sql (ddl executes first)

    **Logic Rules**:
    1. Use UPDATE if the user wants to change values within existing rows.
    2. Use DELETE if the user wants to remove records.
    3. Use ALTER TABLE if the user wants to modify table structure (add/drop/rename columns).
    4. **Filtering Intent**: If the user's request is to "keep only," "get only," or "filter for" certain records, you must DELETE all records that do NOT meet that criteria (e.g., DELETE FROM table WHERE column != 'value').

    **ALTER TABLE Operations (BigQuery)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [OPTIONS(description='...')]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name
    - ALTER COLUMN TYPE: ALTER TABLE table_name ALTER COLUMN column_name SET DATA TYPE new_type

    **Important BigQuery Notes**:
    - Use backticks for table names: \`project.dataset.table\`
    - BigQuery supports UPDATE and DELETE with WHERE clauses
    - String literals use single quotes
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - **Exactly ONE statement per field.** The "ddl" field is sent to the driver
      as a single statement, and so is "sql". No semicolon-separated scripts, no
      dynamic or guarded DDL, no procedure bodies — the driver runs one
      statement per field and rejects everything after the first. Several
      structural changes have to fit inside that one statement; if they cannot,
      the transformation needs more than one node.
    - ddl executes first, then sql. When BOTH are present, a failing ddl does
      NOT fail the node — only a failing sql does, and the ddl's error is
      reported alongside the result. That is what lets the node be rerun: on the
      second run the structural change fails because the first run already
      applied it, the DML behind it still runs, and the node succeeds. Write the
      plain statement and let a rerun report it. When ddl is the ONLY field, its
      failure IS the node's failure.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "ALTER TABLE statement (null if not needed)",
      "sql": "UPDATE or DELETE statement (null if not needed)",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // the table columns AFTER the change, or "*" if the shape is unchanged (plain UPDATE / DELETE)
      "previewSql": "SELECT query to preview the modified table (LIMIT 100)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders",
      "ddl": null,
      "sql": "DELETE FROM ${fullTableName} WHERE status = 'cancelled'",
      "targetColumns": "*",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Update operation:
    {
      "explanation": "Mark old orders as archived",
      "ddl": null,
      "sql": "UPDATE ${fullTableName} SET archived = true, archived_date = CURRENT_TIMESTAMP() WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (add column):
    {
      "explanation": "Add **total_amount** column to track order totals",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount FLOAT64 OPTIONS(description='Total order amount')",
      "sql": null,
      "targetColumns": [{"name": "order_id", "type": "INT"}, {"name": "total_amount", "type": "DECIMAL(10,2)"}, {"name": "discount_rate", "type": "DECIMAL(5,2)"}],   // ALL columns the table now has, not just the new one
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (rename column):
    {
      "explanation": "Rename **customer_name** to **client_name**",
      "ddl": "ALTER TABLE ${fullTableName} RENAME COLUMN customer_name TO client_name",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (change type):
    {
      "explanation": "Change **status_code** from INT64 to STRING",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status_code SET DATA TYPE STRING",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **full_name** column and populate it from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN full_name STRING",
      "sql": "UPDATE ${fullTableName} SET full_name = CONCAT(first_name, ' ', last_name) WHERE TRUE",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working BigQuery SQL. Use BigQuery-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for BigQuery
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name (dataset)
   * @param {object} config - Database configuration (not used for BigQuery)
   * @returns {string} Properly quoted identifier
   */
  /**
   * Quote ONE column name, whatever characters it holds.
   *
   * quoteIdentifier is for TABLE references and reads a dot as a qualifier
   * ("public.orders" → schema public, table orders). A column is never
   * qualified, so a name like "e.mail" has to stay one identifier — handing it
   * to quoteIdentifier produced "e"."mail" and every CREATE / INSERT that
   * carried it failed. Spaces, reserved words, unicode and emoji are covered by
   * the quoting itself.
   */
  quoteColumn: (name) => `\`${String(name).replace(/`/g, '\\`')}\``,

  quoteIdentifier: (identifier, schema = null, config = null) => {
    if (!identifier) return identifier;
    // Already quoted — hand it back untouched. Callers pass identifiers that
    // another layer has sometimes quoted already, and quoting a second time
    // produces ONE identifier whose text is the quoted string, which resolves
    // to nothing: a read of "PUBLIC"."public.transactions" came back as
    // `Object 'TERNLUX.PUBLIC.""PUBLIC"."public.transactions""' does not exist`.
    // The SQL Server connector has always done this; the rest now agree.
    if (typeof identifier === 'string'
        && identifier.startsWith('`') && identifier.endsWith('`') && identifier.length > 1) {
      return identifier;
    }


    const quote = (part) => `\`${String(part)}\``;

    if (schema) {
      return `${quote(schema)}.${quote(identifier)}`;
    }

    // BigQuery addresses a table as `dataset.table` or `project.dataset.table`,
    // and a destination is routinely configured that way. Both forms have to be
    // recognised here — this used to be special-cased in the OUTPUT executor,
    // which meant every other caller quoted the whole string as ONE identifier
    // and asked for a table whose name contained dots.
    //
    // Two parts are split so the dataset qualifies the table. Three parts stay
    // whole inside a single pair of backticks: that is BigQuery's canonical
    // form for a fully-qualified name, and a project id may itself contain
    // characters that splitting would misread.
    if (typeof identifier === 'string' && identifier.includes('.')) {
      const parts = identifier.split('.');
      return parts.length === 2 ? `${quote(parts[0])}.${quote(parts[1])}` : quote(identifier);
    }

    // A bare name means the connection's own dataset, which is what
    // resolveTableRef gives the load job — so qualify it the same way here, or
    // CREATE TABLE and the insert that follows name different tables. Only when
    // a config is actually supplied: callers quote COLUMN names through this
    // too, and they pass no config precisely so that nothing is prepended.
    // Same shape as the MySQL connector, which qualifies with config.database.
    if (config?.dataset) {
      return `${quote(config.dataset)}.${quote(identifier)}`;
    }

    return quote(identifier);
  },

  /**
   * Generate preview SQL query with database-specific syntax
   * @param {string} tableName - Table name (can be pre-quoted)
   * @param {number} limit - Number of rows to return (default 100)
   * @returns {string} Preview SQL query
   */
  getPreviewQuery: (tableName, limit = 100) => {
    return `SELECT * FROM ${tableName} LIMIT ${limit}`;
  },

  /**
   * Data Explorer dialect. Read by public/database/dialect.js — keyword and
   * function lists are unioned with the shared ANSI baseline, so only what is
   * distinctly BigQuery belongs here.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'BigQuery',
    formatter: 'bigquery',
    // runQuery honours { maxRows } via maxResults — see the note there.
    maxRowsOption: true,
    // BigQuery's container above a table is the dataset.
    container: 'Dataset',
    objectLabel: 'Table',
    quote: '`',
    keywords: [
      'QUALIFY', 'UNNEST', 'STRUCT', 'ARRAY', 'EXCEPT DISTINCT', 'SELECT AS STRUCT',
      'PIVOT', 'UNPIVOT', 'TABLESAMPLE SYSTEM', 'PARTITION BY', 'CLUSTER BY',
      'FOR SYSTEM_TIME AS OF', 'ASSERT', 'DECLARE', 'MERGE', 'WINDOW',
    ],
    functions: [
      'ARRAY_AGG', 'ARRAY_LENGTH', 'STRING_AGG', 'GENERATE_ARRAY', 'UNNEST',
      'PARSE_JSON', 'JSON_VALUE', 'JSON_EXTRACT', 'TO_JSON_STRING',
      'DATE_TRUNC', 'DATE_ADD', 'DATE_DIFF', 'TIMESTAMP_TRUNC', 'TIMESTAMP_DIFF',
      'CURRENT_DATE', 'FORMAT_DATE', 'PARSE_DATE', 'SAFE_CAST', 'IFNULL',
      'APPROX_COUNT_DISTINCT', 'APPROX_QUANTILES', 'NET.HOST',
    ],
  }
};
