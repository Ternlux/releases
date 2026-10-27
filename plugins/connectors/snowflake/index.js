/**
 * Snowflake Connector Plugin for Ternlux
 * Handles all Snowflake database operations
 */

const snowflake = require('snowflake-sdk');

/**
 * How long one connect attempt may take before we report a failure.
 *
 * The SDK will not do this for us. Its `retryTimeout` floors at 300s
 * (connection_config.js applies `Math.max(300, yours)`), and a login request
 * that fails for a network reason — an account identifier that does not
 * resolve, a blocked host — is retried silently with exponential backoff, so
 * `connect()` can sit for five minutes without a word to the caller.
 */
const CONNECT_TIMEOUT_MS = 30000;

/**
 * Login retries within that window. The SDK's default of 7 exists to ride out
 * transient blips, but a wrong account or an unreachable host fails the same
 * way every time; a couple of attempts is enough to tell those apart.
 */
const MAX_LOGIN_RETRIES = 2;

/** Teardown is best-effort — never let it hold up the caller's answer. */
const DESTROY_TIMEOUT_MS = 5000;

// Connection cache: key -> { connection, connected, connecting }
const connections = new Map();

function cacheKey(config, connectionId) {
  return connectionId || JSON.stringify(config);
}

function createConnection(config) {
  return snowflake.createConnection({
    account: config.account,
    username: config.username,
    password: config.password,
    warehouse: config.warehouse,
    database: config.database,
    schema: config.schema || 'PUBLIC',
    role: config.role,
    sfRetryMaxLoginRetries: MAX_LOGIN_RETRIES,
  });
}

/**
 * Log out and forget a connection. Teardown is bounded because `destroy()` on a
 * connection that is still mid-connect is queued behind that connect.
 */
function closeQuietly(connection) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, DESTROY_TIMEOUT_MS);
    try {
      // Errors here are expected and uninteresting: destroying a connection
      // that never came up reports "not connected", which is what we want.
      connection.destroy(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch (err) {
      clearTimeout(timer);
      resolve();
    }
  });
}

function dropConnection(key) {
  const entry = connections.get(key);
  if (!entry) return;
  connections.delete(key);
  closeQuietly(entry.connection);
}

/**
 * Run one bounded connect attempt against a fresh connection object.
 *
 * A connection may only be connected once — the SDK object is a state machine,
 * and a failed or timed-out attempt leaves it in a terminal state where every
 * later `connect()` answers "Connection already terminated. Cannot connect
 * again." Callers must therefore throw the object away on rejection.
 */
function connectOnce(connection) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(connection);
    };

    const timer = setTimeout(() => {
      finish(new Error(
        `Timed out after ${CONNECT_TIMEOUT_MS / 1000}s connecting to Snowflake. ` +
        'Check the account identifier, network access, and the warehouse/role.'
      ));
    }, CONNECT_TIMEOUT_MS);

    try {
      connection.connect((err) => finish(err));
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * Resolve to a live connection for this config, connecting on first use.
 *
 * Concurrent callers share one in-flight attempt: calling `connect()` twice on
 * the same object is itself an error ("Connection already in progress"). A
 * failed attempt evicts the entry so the next call starts from a fresh object
 * rather than replaying the terminal-state error forever.
 */
async function acquire(config, connectionId) {
  const key = cacheKey(config, connectionId);
  const cached = connections.get(key);

  // A connection whose session has since gone down cannot be revived, only
  // replaced.
  if (cached && cached.connected && !cached.connection.isUp()) {
    dropConnection(key);
  }

  if (!connections.has(key)) {
    connections.set(key, { connection: createConnection(config), connected: false, connecting: null });
  }

  const entry = connections.get(key);
  if (entry.connected) return entry.connection;
  if (entry.connecting) return entry.connecting;

  entry.connecting = connectOnce(entry.connection)
    .then((connection) => {
      entry.connected = true;
      entry.connecting = null;
      return connection;
    })
    .catch((err) => {
      entry.connecting = null;
      dropConnection(key);
      throw err;
    });

  return entry.connecting;
}

/**
 * SDK codes meaning "this connection object is finished — build a new one".
 * All carry SQL state 08003 (connection does not exist).
 */
const TERMINAL_CONNECTION_CODES = new Set([
  405503, // ERR_CONN_CONNECT_STATUS_DISCONNECTED — connect() on a dead object
  407001, // ERR_CONN_REQUEST_STATUS_PRISTINE     — request before connecting
  407002, // ERR_CONN_REQUEST_STATUS_DISCONNECTED — request on a dead object
]);

function isDeadConnectionError(error) {
  if (!error) return false;
  return TERMINAL_CONNECTION_CODES.has(Number(error.code)) || error.sqlState === '08003';
}

/** Forget a connection the SDK has terminated. Safe to call with any error. */
function evictIfDead(config, connectionId, error) {
  if (isDeadConnectionError(error)) dropConnection(cacheKey(config, connectionId));
}

/**
 * Run a READ against a live connection, replacing the connection once if it
 * turns out to have been terminated.
 *
 * `acquire` checks isUp() before handing a connection over, but a session can
 * be terminated by the server at any moment — an idle timeout, an admin, a
 * dropped network — including between that check and the request going out.
 * The SDK then answers every later call on that object with "Unable to perform
 * operation using terminated connection" (407002), and because the object is a
 * one-shot state machine it can never recover: the cached connection is dead
 * for good, and the caller sees a bare 08003 with nothing to act on.
 *
 * Evicting and retrying ONCE turns that into a reconnect nobody has to notice.
 *
 * READS ONLY. Re-running an arbitrary statement to work around a dead
 * connection is how an INSERT ends up applied twice, so the write paths call
 * evictIfDead instead — the next call gets a fresh connection, but this one is
 * reported as the failure it was.
 */
async function withReadRetry(config, connectionId, run) {
  const connection = await acquire(config, connectionId);
  try {
    return await run(connection);
  } catch (err) {
    if (!isDeadConnectionError(err)) throw err;
    dropConnection(cacheKey(config, connectionId));
    return run(await acquire(config, connectionId));
  }
}

/**
 * Turn a driver error into something a user can act on.
 *
 * The SDK collapses every login failure into "Request to Snowflake failed.",
 * which names neither the cause nor the field to correct. What it does carry is
 * a socket code (NetworkError, under `cause`) or the HTTP response
 * (RequestFailedError) — enough to tell an unreachable host from an account
 * identifier that the Snowflake edge does not recognise.
 */
function describeError(error) {
  const message = (error && error.message) || String(error);
  const code = (error && error.cause && error.cause.code) || (error && error.code);
  const status = error && error.response && error.response.status;

  const accountHint = 'Check the Account field — it must include the region for a legacy ' +
    'locator ("xy12345.us-east-1") or use the "myorg-myaccount" form.';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${message} — the Snowflake host could not be resolved. ${accountHint}`;
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return `${message} — could not reach the Snowflake host. Check network access and any proxy or firewall.`;
  }
  if (status === 404) {
    return `${message} — Snowflake returned 404 for this account's login endpoint, so no such ` +
      `account exists at that host. ${accountHint}`;
  }
  if (status === 403) {
    return `${message} — Snowflake returned 403. The account may have a network policy that ` +
      'blocks this IP address.';
  }
  if (status) {
    return `${message} (HTTP ${status})`;
  }
  return message;
}

/**
 * Quote one identifier for Snowflake.
 *
 * Quoting is all-or-nothing on this engine and cannot be treated as cosmetic.
 * Snowflake folds an UNQUOTED identifier to UPPER CASE, so a table created as
 * `"transactions"` — quoted, and therefore genuinely lower case — is a
 * different object from the `TRANSACTIONS` that a bare
 * `INSERT INTO transactions` resolves to. Every statement this connector
 * builds must quote, or none of them can.
 */
function quote(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * Quote a possibly schema-qualified name ("PUBLIC.transactions"), part by part.
 * Quoting it whole would ask for one object whose name contains a dot.
 */
function quoteQualified(name) {
  return String(name).split('.').map(quote).join('.');
}

/**
 * Execute query (async wrapper)
 */
function executeAsync(connection, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sqlText,
      binds: binds,
      complete: (err, stmt, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve({ stmt, rows });
        }
      }
    });
  });
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
  message: describeError(error),
  code: error && error.code,
  sqlState: error && error.sqlState,
});

module.exports = {
  type: 'connector',
  id: 'snowflake',
  name: 'Snowflake',
  icon: './icon.svg',
  dbCategory: 'SQL',
  // See postgres: how a join may merge into this database (write mode "merge").
  mergeSupport: {
    statements: ['MERGE'],
    guidance: 'MERGE INTO {{TARGET}} t USING (<the joined SELECT>) s ON t.<key> = s.<key> '
      + 'WHEN MATCHED THEN UPDATE SET <col> = s.<col>, … WHEN NOT MATCHED THEN INSERT (<cols>) VALUES (s.<cols>). '
      + 'Each target row may match at most one source row — de-duplicate the source on the key first.',
  },

  /**
   * Column types for a CREATE TABLE this app generates.
   *
   * public/NodeExecution/outputExecutionHelpers.js decides WHAT a column holds
   * — all integers, has a time component, nested objects — and this says what
   * that is CALLED here. It used to be a hardcoded table in that file with no
   * snowflake entry, so an output node fell through to SQLite's names and
   * created `("total_amount" REAL, "transaction_date" TEXT)`. That only worked
   * because REAL and TEXT happen to be aliases on this engine; a boolean column
   * would have landed as INTEGER and a timestamp as a string.
   */
  /**
   * Why this engine cannot create a column with this name, or null. Checked
   * before an Output creates a table, so a name the engine would refuse (or
   * silently shorten) fails with the column named and the fix, not with
   * whatever the CREATE happens to say.
   */
  columnNameProblem: (name) => {
    const n = [...String(name)].length;
    return n > 255 ? `is ${n} characters long; Snowflake allows at most 255` : null;
  },

  types: {
    NULL: () => 'VARCHAR',
    DATE_ONLY: () => 'DATE',
    // NTZ rather than plain TIMESTAMP: the app writes wall-clock strings with
    // no offset ("2025-12-04 15:50:05"), and TIMESTAMP maps to whichever of the
    // three variants TIMESTAMP_TYPE_MAPPING is set to on the account — TZ on
    // some, which would attach the session's zone to a value that never had one.
    TIMESTAMP: () => 'TIMESTAMP_NTZ',
    BOOLEAN: () => 'BOOLEAN',
    // Snowflake has one numeric type; INTEGER is an alias for NUMBER(38,0).
    INTEGER: () => 'NUMBER(38,0)',
    FLOAT: () => 'FLOAT',
    OBJECT: () => 'VARIANT',
    // VARCHAR with no length is the full 16MB here, so there is nothing to size.
    STRING: () => 'VARCHAR',
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js.
    DECIMAL: (p, s) => (p && p <= 38 ? `NUMBER(${p},${s || 0})` : null),
    TIMESTAMPTZ: () => 'TIMESTAMP_TZ',
    TIME: () => 'TIME',
  },

  /**
   * This engine's type for a column (a getColumns entry) as a canonical type —
   * what an Output writing a copy of this table elsewhere builds its column
   * from. See public/NodeExecution/columnTypes.js for the kinds. null leaves
   * the column to be guessed from its values.
   */
  toCanonicalType: (column) => {
    const t = String(column?.type || '').toUpperCase();
    if (t === 'NUMBER' || t === 'DECIMAL' || t === 'NUMERIC') {
      const p = column.precision ?? 38;
      const s = column.scale ?? 0;
      // A whole number that fits 64 bits reads better as BIGINT elsewhere;
      // NUMBER(38,0) — Snowflake's INTEGER — can exceed it, so stays exact.
      if (s === 0 && p <= 18) return { kind: 'BIGINT' };
      return { kind: 'DECIMAL', precision: p, scale: s };
    }
    if (t === 'FLOAT' || t === 'DOUBLE' || t === 'REAL') return { kind: 'DOUBLE' };
    if (t === 'BOOLEAN') return { kind: 'BOOLEAN' };
    if (t === 'DATE') return { kind: 'DATE_ONLY' };
    if (t === 'TIMESTAMP_TZ' || t === 'TIMESTAMP_LTZ') return { kind: 'TIMESTAMPTZ' };
    if (t.startsWith('TIMESTAMP')) return { kind: 'TIMESTAMP' };
    if (t === 'TIME') return { kind: 'TIME' };
    if (t === 'VARIANT' || t === 'OBJECT' || t === 'ARRAY') return { kind: 'OBJECT' };
    // TEXT's default length is the 16MB maximum — that is no length at all.
    const len = Number(column?.maxLength);
    return { kind: 'STRING', length: len > 0 && len < 16777216 ? len : null };
  },

  /**
   * Resolve a table name to the object this account really has.
   *
   * Snowflake's rule is exactly two candidates: a QUOTED reference means the
   * literal string, an UNQUOTED one means the upper-cased string. So a name the
   * app holds as `pg_txn_customers` may be either the table literally called
   * that (created quoted) or PG_TXN_CUSTOMERS (created bare) — and BOTH can
   * exist side by side as different objects, which is the state an unquoted
   * CREATE followed by a quoted one leaves behind.
   *
   * Asked as an IN list rather than `UPPER(table_name) = UPPER(?)` precisely
   * because of that: a case-insensitive match returns both tables, and the
   * caller reading a flat column list would see one five-column table as having
   * ten. Two named candidates stay distinguishable by table_name.
   */
  resolveTableRef: async (config, connectionId, name, schema = null) => {
    try {
      // Same split rule as getColumns: only a name arriving with NO schema
      // beside it may have a qualifier read out of it, because a table really
      // can be called "public.orders".
      const parts = String(name || '').split('.');
      if (!schema && parts.length === 2) {
        [schema, name] = parts;
      }

      const database = config.database;
      const targetSchema = schema || config.schema || 'PUBLIC';
      const literal = String(name || '');
      const folded = literal.toUpperCase();

      const { rows } = await withReadRetry(config, connectionId, (connection) => executeAsync(connection, `
        SELECT DISTINCT table_name AS name
        FROM "${database}".INFORMATION_SCHEMA.TABLES
        WHERE table_schema = ? AND table_name IN (?, ?)
      `, [targetSchema, literal, folded]));

      const names = rows.map(row => row.NAME);
      const hit = names.includes(literal) ? literal
        : names.includes(folded) ? folded
          : null;

      if (!hit) {
        return { found: false, schema: targetSchema, table: null, quotedRef: null, ambiguous: [] };
      }

      // Both forms exist as distinct objects. Prefer the literal — it is what
      // the caller asked for — and NAME the other, so a load that lands
      // somewhere unexpected says so now rather than being found weeks later
      // when the row counts stop adding up.
      const ambiguous = names.length > 1 ? names : [];
      if (ambiguous.length) {
        console.warn(
          `[snowflake] "${literal}" in ${targetSchema} matches ${names.join(' and ')} — using ${hit}. `
          + 'These are different tables; one is probably left over from an unquoted CREATE TABLE.',
        );
      }

      return {
        found: true,
        schema: targetSchema,
        table: hit,
        quotedRef: `${quote(targetSchema)}.${quote(hit)}`,
        ambiguous,
      };
    } catch (error) {
      // Cannot tell. Reported as not-found with the reason logged, so callers
      // fall back to their own behaviour rather than treating a lookup failure
      // as proof the table is absent.
      console.log('[snowflake] resolveTableRef failed:', error.message || error);
      return { found: false, schema: schema || config.schema || null, table: null, quotedRef: null, ambiguous: [] };
    }
  },

  /**
   * Test database connection.
   *
   * Deliberately outside the connection cache. A test runs against credentials
   * the user is still editing, so a cached result — success or the terminal
   * "Connection already terminated" left behind by a failure — would report on
   * a previous attempt rather than on what is currently on screen.
   */
  testConnection: async (config) => {
    const connection = createConnection(config);
    try {
      await connectOnce(connection);
      await executeAsync(connection, 'SELECT 1');
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return queryError(error);
    } finally {
      await closeQuietly(connection);
    }
  },

  /**
   * Get list of tables
   */
  getTables: async (config, connectionId = null) => {
    try {
      const database = config.database;

      const { rows } = await withReadRetry(config, connectionId, (connection) => executeAsync(connection, `
        SELECT
          table_schema as schema,
          table_name as name,
          table_type as type
        FROM "${database}".INFORMATION_SCHEMA.TABLES
        ORDER BY table_schema, table_name
      `, []));
      // Every schema, not just those holding a table — a fresh database's
      // PUBLIC is empty, and the explorer builds its tree from this list.
      const { rows: schemaRows } = await withReadRetry(config, connectionId, (connection) => executeAsync(connection, `
        SELECT schema_name AS name FROM "${database}".INFORMATION_SCHEMA.SCHEMATA ORDER BY schema_name
      `, []));

      return {
        success: true,
        schemas: schemaRows.map((row) => row.NAME),
        tables: rows.map(row => ({
          schema: row.SCHEMA,
          name: row.NAME,
          type: row.TYPE === 'BASE TABLE' ? 'table' : 'view'
        }))
      };
    } catch (error) {
      console.log('getTables_error: ', error)
      return queryError(error);
    }
  },

  /**
   * Get table columns
   */
  getColumns: async (config, connectionId, schema, table) => {
    try {
      // Accept a qualified "PUBLIC.transactions" as well as a bare table with
      // the schema passed separately — the same two shapes quoteIdentifier
      // handles. Split BEFORE the default below, or the qualifier is lost and
      // the lookup searches PUBLIC for a table whose NAME contains a dot.
      // A schema passed SEPARATELY settles it: `table` is then the table's whole
      // name, dots included. A table really can be called "public.transactions",
      // and taking the first segment off one looks up a DIFFERENT table — which
      // fails silently, because the callers that need this read a failed lookup
      // as "cannot check" rather than as an error.
      // Only a name arriving with no schema beside it may have a qualifier read
      // out of it, and even there a genuinely dotted name cannot be told apart
      // from a qualified one — so that split is a last resort, not the default.
      const parts = String(table || '').split('.');
      if (!schema && parts.length === 2) {
        [schema, table] = parts;
      }

      const database = config.database;
      const targetSchema = schema || config.schema || 'PUBLIC';

      const { rows } = await withReadRetry(config, connectionId, (connection) => executeAsync(connection, `
        SELECT
          column_name AS name,
          data_type AS type,
          is_nullable AS nullable,
          column_default AS default_value,
          character_maximum_length AS max_length,
          numeric_precision AS precision,
          numeric_scale AS scale
        FROM "${database}".INFORMATION_SCHEMA.COLUMNS
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position
      `, [targetSchema, table]));

      return {
        success: true,
        columns: rows.map(row => ({
          name: row.NAME,
          type: row.TYPE,
          nullable: row.NULLABLE === 'YES',
          isPrimary: false, // Snowflake doesn't enforce primary keys by default
          defaultValue: row.DEFAULT_VALUE,
          maxLength: row.MAX_LENGTH,
          precision: row.PRECISION,
          scale: row.SCALE,
        }))
      };
    } catch (error) {
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
   * The cap is expressed to the driver as a row RANGE on the result stream, so
   * the SQL the user wrote is the SQL Snowflake runs — no LIMIT is appended and
   * no subquery is wrapped around it.
   *
   * The statement runs exactly ONCE on every path. A stream that fails is
   * reported as a failure rather than retried unwrapped: re-running an
   * arbitrary statement to work around a read problem is how an INSERT ends up
   * applied twice.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    const maxRows = Number(options.maxRows);
    const sqlQuery = queryObj.query;

    try {
      const connection = await acquire(config, connectionId);

      if (!(maxRows > 0)) {
        const { stmt, rows } = await executeAsync(connection, sqlQuery);
        return {
          success: true,
          rows,
          columns: stmt.getColumns().map(col => col.getName()),
          rowCount: rows.length
        };
      }

      return await new Promise((resolve) => {
        connection.execute({
          sqlText: sqlQuery,
          streamResult: true,
          // rowsAsArrays: see the PostgreSQL connector.
          ...(options.rowsAsArrays ? { rowMode: 'array' } : {}),
          complete: (err, stmt) => {
            if (err) {
              resolve(queryError(err));
              return;
            }
            const columns = stmt.getColumns().map(col => col.getName());
            const rows = [];
            // One past the cap, so "is there more?" is observed rather than
            // assumed. `end` is inclusive and zero-based.
            const stream = stmt.streamRows({ start: 0, end: maxRows });
            stream.on('data', (row) => rows.push(row));
            stream.on('error', (streamErr) => resolve(queryError(streamErr)));
            stream.on('end', () => resolve({
              success: true,
              rows: rows.slice(0, maxRows),
              columns,
              rowCount: Math.min(rows.length, maxRows),
              truncated: rows.length > maxRows,
              ...(options.rowsAsArrays ? { rowsAreArrays: true } : {}),
            }));
          }
        });
      });
    } catch (error) {
      // Writes and arbitrary SQL never retry — re-running a statement to work
      // around a dead connection is how an INSERT gets applied twice. Forget the
      // terminated connection so the NEXT call reconnects, and report this one.
      evictIfDead(config, connectionId, error);
      return queryError(error);
    }
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const connection = await acquire(config, connectionId);

      return new Promise((resolve, reject) => {
        let columns = null;
        let totalRows = 0;
        let buffer = [];

        connection.execute({
          sqlText: query,
          streamResult: true,
          complete: (err, stmt, rows) => {
            if (err) {
              reject(err);
              return;
            }

            // Extract column names
            columns = stmt.getColumns().map(col => col.getName());

            const stream = stmt.streamRows();

            stream.on('data', async (row) => {
              buffer.push(row);

              // When buffer reaches batch size, process it
              if (buffer.length >= batchSize) {
                const batchToProcess = buffer;
                buffer = [];
                totalRows += batchToProcess.length;

                try {
                  await onBatch(batchToProcess, columns);
                } catch (error) {
                  stream.destroy();
                  reject(error);
                }
              }
            });

            stream.on('end', async () => {
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
            });

            stream.on('error', (error) => {
              reject(error);
            });
          }
        });
      });
    } catch (error) {
      // Writes and arbitrary SQL never retry — re-running a statement to work
      // around a dead connection is how an INSERT gets applied twice. Forget the
      // terminated connection so the NEXT call reconnects, and report this one.
      evictIfDead(config, connectionId, error);
      return queryError(error);
    }
  },

  /**
   * Batch insert rows into a table (uses multi-row INSERT with transaction)
   *
   * `tableName` and `columns` arrive UNQUOTED — quoting them is this function's
   * job, and it must quote them the same way the caller's CREATE TABLE did.
   * Leaving them bare let Snowflake fold them to upper case, so a load into a
   * table created as `"transactions"` failed with "Table 'TRANSACTIONS' does
   * not exist" — after the truncate had already emptied it.
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const connection = await acquire(config, connectionId);

      // Start transaction
      await executeAsync(connection, 'BEGIN TRANSACTION');

      try {
        // Format values for Snowflake multi-row insert
        const valueRows = rows.map(row => {
          const values = columns.map(col => {
            const val = row[col];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return val;
          });
          return `(${values.join(', ')})`;
        });

        // Use multi-row INSERT syntax
        const insertSql = `INSERT INTO ${quoteQualified(tableName)} `
          + `(${columns.map(quote).join(', ')}) VALUES ${valueRows.join(', ')}`;
        await executeAsync(connection, insertSql);

        // Commit transaction
        await executeAsync(connection, 'COMMIT');

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await executeAsync(connection, 'ROLLBACK');
        throw error;
      }
    } catch (error) {
      // Writes and arbitrary SQL never retry — re-running a statement to work
      // around a dead connection is how an INSERT gets applied twice. Forget the
      // terminated connection so the NEXT call reconnects, and report this one.
      evictIfDead(config, connectionId, error);
      return queryError(error);
    }
  },

  /**
   * Run several statements as ONE transaction: all of them land, or none do.
   * See the PostgreSQL connector's note — the same contract. Same connection
   * handling as batchInsert. DML only: Snowflake commits DDL (TRUNCATE
   * included) implicitly, which would end the transaction early.
   */
  runInTransaction: async (config, connectionId, statements) => {
    let connection;
    try {
      connection = await acquire(config, connectionId);
      await executeAsync(connection, 'BEGIN TRANSACTION');
    } catch (error) {
      evictIfDead(config, connectionId, error);
      return queryError(error);
    }
    try {
      for (const sql of statements) await executeAsync(connection, sql);
      await executeAsync(connection, 'COMMIT');
      return { success: true };
    } catch (error) {
      await executeAsync(connection, 'ROLLBACK').catch(() => {});
      evictIfDead(config, connectionId, error);
      return queryError(error);
    }
  },

  /**
   * Close connection
   */
  closeConnection: async (connectionId) => {
    dropConnection(connectionId);
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'account',
        type: 'string',
        label: 'Account',
        placeholder: 'xy12345.us-east-1',
        required: true,
        sensitive: true
      },
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        placeholder: 'myuser',
        required: true,
        sensitive: true
      },
      {
        name: 'password',
        type: 'password',
        label: 'Password',
        required: true,
        sensitive: true
      },
      {
        name: 'warehouse',
        type: 'string',
        label: 'Warehouse',
        placeholder: 'COMPUTE_WH',
        required: true,
        sensitive: false
      },
      {
        name: 'database',
        type: 'string',
        label: 'Database',
        placeholder: 'MYDB',
        required: true,
        sensitive: false
      },
      {
        name: 'schema',
        type: 'string',
        label: 'Schema',
        placeholder: 'PUBLIC',
        default: 'PUBLIC',
        required: false,
        sensitive: false
      },
      {
        name: 'role',
        type: 'string',
        label: 'Role',
        placeholder: 'ACCOUNTADMIN',
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating Snowflake transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Snowflake expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Snowflake
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Column names: Snowflake folds an UNQUOTED identifier to UPPER CASE, so a
      column whose stored name is lower-case or mixed-case is reachable only in
      double quotes. The column names listed in the source schema above are the
      EXACT stored names: wherever one is not already all upper-case, write it
      as "that_name" every time it appears — in SELECT lists, WHERE clauses,
      SET clauses, CASE expressions and ALTER TABLE alike. An ALIAS you invent
      is your own new name and needs no quoting.
    - Source table name: the source schema above gives the name to read FROM
      already qualified and quoted. Use that, and nothing else — never re-derive
      it from the bare table name.
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

    **Snowflake-Specific Considerations**:
    - Use clustering keys for frequently filtered columns (CLUSTER BY)
    - Clustering keys belong on the CREATE TABLE in \`ddl\`
    - Consider table types (TRANSIENT, TEMPORARY) for staging
    - Snowflake supports VARIANT for semi-structured data (JSON, AVRO, PARQUET)
    - Use appropriate data types (NUMBER, FLOAT, VARCHAR, BOOLEAN, DATE, TIMESTAMP_NTZ, etc.)
    - Identifiers are case-insensitive unless quoted

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement (columns + types, plus any CLUSTER BY) — creates the table, inserts nothing",
      "sql": "INSERT INTO <target> (cols...) SELECT ... — REQUIRED, this is what loads the rows",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local Storage**:
    The rows are fetched from Snowflake and written into a table in THIS
    workflow's own local DuckDB database. Nothing is written back to Snowflake.

    You provide ONE statement: the Snowflake SELECT that produces the rows you
    want. That is the only thing that runs. Its result is streamed straight into
    the local table, which is replaced on every run with the column types
    inferred from the data — so there is no CREATE TABLE to write, no INSERT,
    and no type mapping to choose. Do NOT emit "ddl" or "insertSql": nothing
    reads them, and inventing them only risks contradicting the SELECT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "sql": "Snowflake SELECT query producing the transformed rows",
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

    Be specific and provide working SQL. Use Snowflake-specific features where appropriate (e.g., VARIANT, semi-structured data functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Snowflake expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Snowflake
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Column names: Snowflake folds an UNQUOTED identifier to UPPER CASE, so a
      column whose stored name is lower-case or mixed-case is reachable only in
      double quotes. The column names listed in the source schema above are the
      EXACT stored names: wherever one is not already all upper-case, write it
      as "that_name" every time it appears — in SELECT lists, WHERE clauses,
      SET clauses, CASE expressions and ALTER TABLE alike. An ALIAS you invent
      is your own new name and needs no quoting.
    - Source table name: the source schema above gives the name to read FROM
      already qualified and quoted. Use that, and nothing else — never re-derive
      it from the bare table name.

    Analyze the request and determine what operations are needed:

    1. **UPDATE/DELETE only**: Use sql field only, ddl is null
    2. **ALTER TABLE only**: Use ddl field only, sql is null
    3. **ALTER TABLE + UPDATE/DELETE**: Use both ddl and sql (ddl executes first)

    **Logic Rules**:
    1. Use UPDATE if the user wants to change values within existing rows.
    2. Use DELETE if the user wants to remove records.
    3. Use ALTER TABLE if the user wants to modify table structure (add/drop/rename columns, change types).
    4. **Filtering Intent**: If the user's request is to "keep only," "get only," or "filter for" certain records, you must DELETE all records that do NOT meet that criteria (e.g., DELETE FROM table WHERE column != 'value').

    **ALTER TABLE Operations (Snowflake)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value] [COMMENT 'description']
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name
    - ALTER COLUMN TYPE: ALTER TABLE table_name ALTER COLUMN column_name SET DATA TYPE new_type
    - SET DEFAULT: ALTER TABLE table_name ALTER COLUMN column_name SET DEFAULT value
    - DROP DEFAULT: ALTER TABLE table_name ALTER COLUMN column_name DROP DEFAULT
    - SET NOT NULL: ALTER TABLE table_name ALTER COLUMN column_name SET NOT NULL
    - DROP NOT NULL: ALTER TABLE table_name ALTER COLUMN column_name DROP NOT NULL

    **Important Snowflake Notes**:
    - Identifiers are case-insensitive unless quoted
    - Use double quotes for case-sensitive identifiers
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
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount NUMBER(10,2) DEFAULT 0.00 COMMENT 'Total order amount'",
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
      "explanation": "Change **status_code** from NUMBER to VARCHAR",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status_code SET DATA TYPE VARCHAR(10)",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **full_name** column and populate it from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN full_name VARCHAR(200)",
      "sql": "UPDATE ${fullTableName} SET full_name = first_name || ' ' || last_name",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working Snowflake SQL. Use Snowflake-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for Snowflake
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for Snowflake)
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
  quoteColumn: (name) => `"${String(name).replace(/"/g, '""')}"`,

  quoteIdentifier: (identifier, schema = null, config = null) => {
    if (!identifier) return identifier;
    // Already quoted — hand it back untouched. Callers pass identifiers that
    // another layer has sometimes quoted already, and quoting a second time
    // produces ONE identifier whose text is the quoted string, which resolves
    // to nothing: a read of "PUBLIC"."public.transactions" came back as
    // `Object 'TERNLUX.PUBLIC.""PUBLIC"."public.transactions""' does not exist`.
    // The SQL Server connector has always done this; the rest now agree.
    if (typeof identifier === 'string'
        && identifier.startsWith('"') && identifier.endsWith('"') && identifier.length > 1) {
      return identifier;
    }


    if (schema) {
      return `${quote(schema)}.${quote(identifier)}`;
    }

    // A dotted name given as one string ("PUBLIC.transactions") is a
    // schema.table name — quoteQualified splits it so the parts qualify each
    // other instead of naming one object with a dot in it. This is the same
    // form batchInsert builds, which is what keeps CREATE and INSERT pointed at
    // the same table.
    return quoteQualified(identifier);
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
   * distinctly Snowflake belongs here.
   */
  explorer: {
    // runQuery returns array rows on request ({ rowsAsArrays }), so the explorer
    // can keep same-named result columns apart.
    rowsAsArrays: true,
    language: 'sql',
    sqlDialect: 'Snowflake',
    formatter: 'snowflake',
    // runQuery honours { maxRows } via streamRows({start,end}) — see the note there.
    maxRowsOption: true,
    container: 'Schema',
    objectLabel: 'Table',
    quote: '"',
    // Unquoted identifiers fold to UPPERCASE, so anything not already
    // uppercase must be quoted or Snowflake won't resolve it.
    fold: 'upper',
    keywords: [
      'QUALIFY', 'ILIKE', 'LATERAL FLATTEN', 'PIVOT', 'UNPIVOT', 'SAMPLE',
      'CLONE', 'WAREHOUSE', 'STAGE', 'FILE FORMAT', 'COPY INTO', 'MERGE',
      'VARIANT', 'OBJECT', 'ARRAY', 'AT', 'BEFORE', 'CHANGES', 'STREAM', 'TASK',
    ],
    functions: [
      'FLATTEN', 'PARSE_JSON', 'TO_JSON', 'OBJECT_CONSTRUCT', 'ARRAY_AGG',
      'ARRAY_CONSTRUCT', 'GET_PATH', 'DATE_TRUNC', 'DATEADD', 'DATEDIFF',
      'CURRENT_TIMESTAMP', 'TO_VARCHAR', 'TO_NUMBER', 'TO_DATE', 'TRY_CAST',
      'IFF', 'NVL', 'ZEROIFNULL', 'LISTAGG', 'RATIO_TO_REPORT',
    ],
  }
};
