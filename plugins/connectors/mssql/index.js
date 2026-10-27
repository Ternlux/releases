/**
 * Microsoft SQL Server Connector Plugin for Ternlux
 * Handles all SQL Server database operations
 */

const mssql = require('mssql');

// A table value constructor - the `VALUES (...), (...)` of a multi-row INSERT -
// accepts at most 1000 row expressions in one statement. Past that SQL Server
// rejects the whole statement outright ("The number of row value expressions in
// the INSERT statement exceeds the maximum allowed number of 1000 row values").
const MSSQL_MAX_ROWS_PER_INSERT = 1000;

// A request carries at most 2100 parameters. node-mssql runs a parameterized
// query through sp_executesql, which spends two of those on the statement text
// and the parameter declaration, so the rows in one statement have to fit in
// what is left. The margin below that is deliberate headroom, not a measured
// limit - the cost of one extra statement is a round trip, the cost of getting
// it wrong is the whole batch.
const MSSQL_MAX_PARAMS_PER_STATEMENT = 2000;

// The widest NVARCHAR that can be declared with a length; beyond it the type
// has to be NVARCHAR(MAX).
const NVARCHAR_MAX_DECLARED_LENGTH = 4000;

// Connection pool cache
const connectionPools = new Map();

/**
 * Bind one JavaScript value to a named parameter, choosing the SQL Server type
 * explicitly rather than leaving it to the driver's inference.
 *
 * Text is always bound as NVARCHAR. Inserting into a VARCHAR column converts it
 * back down, but inserting into an NVARCHAR column keeps every character - the
 * opposite of what a VARCHAR literal does, which drops anything outside the
 * server's collation codepage on the way in.
 *
 * Dates are DATETIME2 rather than the driver's inferred DATETIME, whose
 * resolution is ~3.33ms: sending a DATETIME into a DATETIME2 column would round
 * the timestamp before it ever reached the column that could hold it.
 *
 * @param {object} request - mssql Request to bind on.
 * @param {string} name - Parameter name, without the leading '@'.
 * @param {*} val - Value from the source row.
 */
function bindValue(request, name, val) {
  if (val === null || val === undefined) {
    request.input(name, mssql.NVarChar, null);
    return;
  }

  if (typeof val === 'string') {
    const length = val.length > NVARCHAR_MAX_DECLARED_LENGTH
      ? mssql.MAX
      // NVARCHAR(0) is not a valid declaration, so an empty string still needs 1.
      : Math.max(val.length, 1);
    request.input(name, mssql.NVarChar(length), val);
    return;
  }

  if (typeof val === 'boolean') {
    request.input(name, mssql.Bit, val);
    return;
  }

  if (typeof val === 'bigint') {
    // Passed as text: the driver's BIGINT takes the full 64-bit range, which a
    // JS number cannot carry through without losing the low digits.
    request.input(name, mssql.BigInt, val.toString());
    return;
  }

  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      if (val >= -2147483648 && val <= 2147483647) {
        request.input(name, mssql.Int, val);
      } else {
        request.input(name, mssql.BigInt, val);
      }
      return;
    }
    request.input(name, mssql.Float, val);
    return;
  }

  if (val instanceof Date) {
    request.input(name, mssql.DateTime2, val);
    return;
  }

  if (Buffer.isBuffer(val)) {
    request.input(name, mssql.VarBinary(mssql.MAX), val);
    return;
  }

  // Objects and arrays go in as JSON text, matching what the other connectors
  // write for the same value.
  request.input(name, mssql.NVarChar(mssql.MAX), JSON.stringify(val));
}

/**
 * Get or create connection pool
 */
async function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    const poolConfig = {
      server: config.host,
      port: config.port || 1433,
      database: config.database,
      user: config.username,
      password: config.password,
      options: {
        encrypt: config.ssl || false,
        trustServerCertificate: true,
        instanceName: config.instanceName || undefined,
        connectTimeout: 10000,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };

    const pool = await mssql.connect(poolConfig);
    connectionPools.set(key, pool);
  }

  return connectionPools.get(key);
}

/**
 * Quote a SQL Server identifier (table / schema name).
 *
 * A dotted name passed as a single string ("dbo.test_values") with no explicit
 * schema is treated as a multi-part schema.table name and EACH part is bracketed
 * → [dbo].[test_values]. The previous behaviour wrapped the whole string in one
 * bracket pair → [dbo.test_values], i.e. a table whose name literally contains a
 * dot — which then mismatched the unbracketed `INSERT INTO dbo.test_values`
 * (parsed by SQL Server as schema dbo / table test_values) and surfaced as
 * "Invalid object name 'dbo.test_values'".
 */
function quoteSqlServerIdentifier(identifier, schema = null) {
  if (!identifier) return identifier;
  if (typeof identifier === 'string' && identifier.startsWith('[')) return identifier;

  if (schema) {
    return `[${schema}].[${identifier}]`;
  }
  if (typeof identifier === 'string' && identifier.includes('.')) {
    return identifier.split('.').map((part) => `[${part}]`).join('.');
  }
  return `[${identifier}]`;
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
  // `code` on an mssql error is the transport-level kind ('EREQUEST'); what
  // classifies the failure is SQL Server's error NUMBER (2705 is a duplicate
  // column name), which sits on the wrapper or on the driver's original error.
  code: error.code,
  errno: error.number != null ? error.number : (error.originalError && error.originalError.info && error.originalError.info.number),
});

/**
 * NVARCHAR length for a column whose longest SAMPLED value is `maxLen`.
 * Capped at 4000, not 65535: that is the widest non-MAX NVARCHAR SQL Server
 * accepts (4000 two-byte characters = the 8000-byte page limit). Anything
 * longer has to be NVARCHAR(MAX), which the STRING rule below handles.
 */
const nvarcharFor = (maxLen) => Math.ceil(Math.min(Math.max((maxLen || 0) * 1.5, 255), 4000));

module.exports = {
  type: 'connector',
  id: 'mssql',
  name: 'SQL Server',
  icon: './icon.svg',
  dbCategory: 'SQL',
  // See postgres: how a join may merge into this database (write mode "merge").
  mergeSupport: {
    statements: ['MERGE'],
    guidance: 'MERGE INTO {{TARGET}} AS t USING (<the joined SELECT>) AS s ON t.<key> = s.<key> '
      + 'WHEN MATCHED THEN UPDATE SET t.<col> = s.<col>, … WHEN NOT MATCHED BY TARGET THEN INSERT (<cols>) VALUES (s.<cols>); '
      + '— SQL Server requires the terminating semicolon.',
  },

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js.
   *
   * Text columns are NVARCHAR, never VARCHAR: VARCHAR stores one byte per
   * character in the database's collation codepage, so anything outside it —
   * accented names, CJK, emoji — is silently replaced with '?' on the way in,
   * and the loss is not recoverable afterwards. (TEXT, an older default here,
   * is worse still: non-unicode AND deprecated by SQL Server.)
   */
  /**
   * Why this engine cannot create a column with this name, or null. Checked
   * before an Output creates a table, so a name the engine would refuse (or
   * silently shorten) fails with the column named and the fix, not with
   * whatever the CREATE happens to say.
   */
  columnNameProblem: (name) => {
    const n = [...String(name)].length;
    return n > 128 ? `is ${n} characters long; SQL Server allows at most 128` : null;
  },

  types: {
    NULL: () => 'NVARCHAR(MAX)',
    DATE_ONLY: () => 'DATE',
    // DATETIME2, not DATETIME: wider range and no 3.33ms rounding.
    TIMESTAMP: () => 'DATETIME2',
    // BIT, not BOOLEAN — SQL Server has no boolean type.
    BOOLEAN: () => 'BIT',
    INTEGER: () => 'INT',
    FLOAT: () => 'FLOAT',
    OBJECT: () => 'NVARCHAR(MAX)',
    STRING: (maxLen) => (maxLen > 255 ? 'NVARCHAR(MAX)' : `NVARCHAR(${nvarcharFor(maxLen)})`),
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js.
    BIGINT: () => 'BIGINT',
    DECIMAL: (p, s) => (p && p <= 38 ? `DECIMAL(${p},${s || 0})` : null),
    TIMESTAMPTZ: () => 'DATETIMEOFFSET',
    TIME: () => 'TIME',
  },

  /**
   * This engine's type for a column (a getColumns entry) as a canonical type —
   * what an Output writing a copy of this table elsewhere builds its column
   * from. See public/NodeExecution/columnTypes.js for the kinds. null leaves
   * the column to be guessed from its values.
   */
  toCanonicalType: (column) => {
    const t = String(column?.type || '').toLowerCase();
    if (t === 'tinyint' || t === 'smallint' || t === 'int') return { kind: 'INTEGER' };
    if (t === 'bigint') return { kind: 'BIGINT' };
    if (t === 'float' || t === 'real') return { kind: 'DOUBLE' };
    if (t === 'decimal' || t === 'numeric' || t === 'money' || t === 'smallmoney') {
      return { kind: 'DECIMAL', precision: column.precision ?? null, scale: column.scale ?? null };
    }
    if (t === 'bit') return { kind: 'BOOLEAN' };
    if (t === 'date') return { kind: 'DATE_ONLY' };
    if (t === 'datetimeoffset') return { kind: 'TIMESTAMPTZ' };
    if (t.includes('datetime')) return { kind: 'TIMESTAMP' };
    if (t === 'time') return { kind: 'TIME' };
    // -1 is (MAX): unbounded.
    const len = Number(column?.maxLength);
    return { kind: 'STRING', length: len > 0 ? len : null };
  },

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const pool = await mssql.connect({
        server: config.host,
        port: config.port || 1433,
        database: config.database,
        user: config.username,
        password: config.password,
        options: {
          encrypt: config.ssl || false,
          trustServerCertificate: true,
          instanceName: config.instanceName || undefined
        },
        connectionTimeout: 8000,
      });
      await pool.close();
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
      const pool = await getPool(config, connectionId);
      const result = await pool.request().query(`
        SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name, TABLE_TYPE AS type
        FROM INFORMATION_SCHEMA.TABLES
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `);
      // Every user schema, empty ones included — ids 5–16383 are the ones
      // created in this database; dbo is id 1. The rest are SQL Server's own
      // (sys, guest, INFORMATION_SCHEMA, the db_* role schemas).
      const schemaResult = await pool.request().query(`
        SELECT name FROM sys.schemas
        WHERE name = 'dbo' OR schema_id BETWEEN 5 AND 16383
        ORDER BY name
      `);

      return {
        success: true,
        schemas: schemaResult.recordset.map((row) => row.name),
        tables: result.recordset
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
      // Accept a qualified "dbo.orders" as well as a bare table with the schema
      // passed separately — the same two shapes quoteSqlServerIdentifier above
      // handles. Split BEFORE the 'dbo' default, or the qualifier is lost and
      // the lookup searches dbo for a table whose NAME contains a dot.
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
      schema = schema || 'dbo';
      console.log('config, connectionId, schema, table: ', config, connectionId, schema, table)
      const pool = await getPool(config, connectionId);
      const result = await pool.request()
        .input('schema', mssql.NVarChar, schema)
        .input('table', mssql.NVarChar, table)
        .query(`
          SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.IS_NULLABLE AS nullable,
                 c.CHARACTER_MAXIMUM_LENGTH AS maxLength,
                 c.NUMERIC_PRECISION AS precision, c.NUMERIC_SCALE AS scale,
                 CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS isPrimary
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN (
            SELECT ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
          ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
          WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION
        `);
      return {
        success: true,
        columns: result.recordset
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
   * The cap is applied by putting the request in streaming mode and cancelling
   * it once enough rows have arrived, so the SQL the user wrote is the SQL SQL
   * Server runs — no TOP is injected and no subquery is wrapped around it.
   *
   * The statement runs exactly ONCE on every path. A stream that fails is
   * reported as a failure rather than retried unwrapped: re-running an
   * arbitrary statement to work around a read problem is how an INSERT ends up
   * applied twice.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    const maxRows = Number(options.maxRows);
    const sqlQuery = queryObj.query;

    if (!(maxRows > 0)) {
      try {
        const pool = await getPool(config, connectionId);
        const result = await pool.request().query(sqlQuery);
        const columns = result.recordset?.columns ? Object.keys(result.recordset.columns) : [];
        return {
          success: true,
          rows: result.recordset,
          columns,
          rowCount: result.rowsAffected?.[0] ?? result.recordset?.length
        };
      } catch (error) {
        return queryError(error);
      }
    }

    let pool;
    try {
      pool = await getPool(config, connectionId);
    } catch (error) {
      return queryError(error);
    }

    return new Promise((resolve) => {
      const rows = [];
      let columns = [];
      let affected = 0;
      let settled = false;
      let cancelledAtCap = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const request = pool.request();
        request.stream = true;
        // rowsAsArrays: see the PostgreSQL connector. In object mode the driver
        // folds same-named columns into one key holding an array.
        if (options.rowsAsArrays) request.arrayRowMode = true;

        request.on('recordset', (recordsetColumns) => {
          columns = Array.isArray(recordsetColumns)
            ? recordsetColumns.map((c) => c.name)
            : Object.keys(recordsetColumns || {});
        });
        request.on('row', (row) => {
          // One past the cap, so "is there more?" is observed rather than
          // assumed. Cancelling stops SQL Server sending the rest.
          if (rows.length <= maxRows) rows.push(row);
          // Rows already in flight keep arriving after the cancel is sent, so
          // the flag is what stops it being sent again for each of them.
          if (rows.length > maxRows && !cancelledAtCap) {
            cancelledAtCap = true;
            request.cancel();
          }
        });
        request.on('rowsaffected', (count) => { affected += count || 0; });
        request.on('error', (err) => {
          // A cancel WE asked for is how the cap is enforced, not a failure:
          // the driver reports it as RequestError('Canceled.', 'ECANCEL'), and
          // reporting that back turned every read past the cap into a query
          // that appeared to fail. 'done' always follows the error in stream
          // mode, and that is what resolves the rows we did collect.
          if (cancelledAtCap && err && err.code === 'ECANCEL') return;
          finish(queryError(err));
        });
        request.on('done', () => finish({
          success: true,
          rows: rows.slice(0, maxRows),
          columns: columns.length ? columns : Object.keys(rows[0] || {}),
          // A statement that returns no rows (DDL, or an UPDATE) reports its
          // effect through `rowsaffected` — that is the only count there is.
          rowCount: Math.min(rows.length, maxRows) || affected,
          truncated: rows.length > maxRows,
          ...(options.rowsAsArrays ? { rowsAreArrays: true } : {}),
        }));

        request.query(sqlQuery);
      } catch (error) {
        finish(queryError(error));
      }
    });
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const pool = await getPool(config, connectionId);

      return new Promise((resolve, reject) => {
        const request = pool.request();
        request.stream = true;

        let batch = [];
        let columns = null;
        let totalRows = 0;
        let isPaused = false;

        request.on('recordset', (recordsetColumns) => {
          columns = Object.keys(recordsetColumns);
        });

        request.on('row', (row) => {
          batch.push(row);

          if (batch.length >= batchSize && !isPaused) {
            isPaused = true;
            request.pause();
            const currentBatch = batch;
            batch = [];
            totalRows += currentBatch.length;

            // Process batch asynchronously
            Promise.resolve(onBatch(currentBatch, columns))
              .then(() => {
                isPaused = false;
                request.resume();
              })
              .catch((err) => {
                reject(err);
              });
          }
        });

        request.on('done', async () => {
          // Process remaining rows in batch
          if (batch.length > 0) {
            totalRows += batch.length;
            try {
              await onBatch(batch, columns);
            } catch (err) {
              reject(err);
              return;
            }
          }

          resolve({ success: true, totalRows });
        });

        request.on('error', (err) => {
          reject(err);
        });

        request.query(query);
      });
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Close connection pool
   */
  closeConnection: async (connectionId) => {
    if (connectionPools.has(connectionId)) {
      const pool = connectionPools.get(connectionId);
      await pool.close();
      connectionPools.delete(connectionId);
    }
  },

  /**
   * Batch insert rows into a table (parameterized multi-row INSERT in a transaction)
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const pool = await getPool(config, connectionId);
      const transaction = pool.transaction();

      try {
        // Start transaction
        await transaction.begin();

        // Quote column names for SQL Server
        // quoteColumn, not a bare `[${col}]`: a `]` inside the name has to be
        // doubled or it ends the identifier early.
        const quotedColumns = columns.map(col => module.exports.quoteColumn(col));
        const quotedTable = quoteSqlServerIdentifier(tableName);

        // One INSERT per slice of rows, not one for the whole call: the caller
        // sizes its chunk for memory (tens of thousands of rows), while a single
        // statement is bounded twice over - at most MSSQL_MAX_ROWS_PER_INSERT
        // row expressions in the table value constructor, and at most
        // MSSQL_MAX_PARAMS_PER_STATEMENT parameters across all of them. The
        // slices all run inside the one transaction, so the call as a whole
        // still lands or rolls back together.
        if (!columns || columns.length === 0) {
          throw new Error(`Cannot insert into ${tableName}: no columns to write.`);
        }
        const rowsPerStatement = Math.min(
          MSSQL_MAX_ROWS_PER_INSERT,
          Math.floor(MSSQL_MAX_PARAMS_PER_STATEMENT / columns.length),
        );
        if (rowsPerStatement < 1) {
          // A single row already exceeds the ceiling - no slicing can help.
          throw new Error(
            `Cannot insert into ${tableName}: ${columns.length} columns exceeds `
            + `SQL Server's limit of ${MSSQL_MAX_PARAMS_PER_STATEMENT} parameters per statement.`
          );
        }

        for (let start = 0; start < rows.length; start += rowsPerStatement) {
          const slice = rows.slice(start, start + rowsPerStatement);

          // Build a parameterized multi-row INSERT. Values are bound, never
          // interpolated: a literal has to be escaped correctly for every type
          // it could hold, and a single missed case is both a broken write and
          // an injection point. A fresh request per statement - parameters
          // accumulate on the one they are bound to.
          const request = transaction.request();
          const valueRows = slice.map((row, rowIndex) => {
            const placeholders = columns.map((col, colIndex) => {
              const name = `p${rowIndex}_${colIndex}`;
              bindValue(request, name, row[col]);
              return `@${name}`;
            });
            return `(${placeholders.join(', ')})`;
          });

          const insertSql = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES ${valueRows.join(', ')}`;
          // console.log('insertSql: ', insertSql)

          await request.query(insertSql);
        }

        // Commit transaction
        await transaction.commit();

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error. SQL Server aborts the transaction itself on many
        // errors (a failed conversion, for one), and rolling back an aborted
        // transaction throws "Transaction has been aborted." — which, unguarded,
        // replaced the real error: the user saw that sentence and never the
        // value or column that caused it.
        await transaction.rollback().catch(() => {});
        throw error;
      }
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Run several statements as ONE transaction on one connection: all of them
   * land, or none do. See the PostgreSQL connector's note — the same contract.
   */
  runInTransaction: async (config, connectionId, statements) => {
    let transaction;
    try {
      const pool = await getPool(config, connectionId);
      transaction = pool.transaction();
      await transaction.begin();
    } catch (error) {
      return queryError(error);
    }
    try {
      for (const sql of statements) await transaction.request().query(sql);
      await transaction.commit();
      return { success: true };
    } catch (error) {
      await transaction.rollback().catch(() => {});
      return queryError(error);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'host',
        type: 'string',
        label: 'Server',
        placeholder: 'localhost',
        required: true,
        sensitive: true
      },
      {
        name: 'port',
        type: 'number',
        label: 'Port',
        placeholder: '1433',
        default: 1433,
        required: false,
        sensitive: false
      },
      {
        name: 'database',
        type: 'string',
        label: 'Database',
        placeholder: 'mydb',
        required: true,
        sensitive: false
      },
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        placeholder: 'sa',
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
        name: 'instanceName',
        type: 'string',
        label: 'Instance Name',
        placeholder: 'SQLEXPRESS',
        required: false,
        sensitive: false
      },
      {
        name: 'ssl',
        type: 'boolean',
        label: 'Encrypt Connection',
        default: false,
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating MSSQL transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Microsoft SQL Server expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Microsoft SQL Server
    - Target schema: ${targetSchema || 'dbo'}
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

    Do NOT combine them. A CREATE TABLE ... AS SELECT (or SELECT ... INTO) is not
    accepted here: the two fields are executed as separate statements, so putting
    the SELECT in \`ddl\` leaves \`sql\` with nothing to do.

    **\`sql\` MUST NOT BE EMPTY.** It is the only statement that puts rows in the
    table. Leave it empty and the run creates an empty table and loads nothing —
    the node reports success having produced no data. If you find yourself with
    nothing to put in \`sql\`, you have written the SELECT into \`ddl\` by
    mistake: split it back out into a CREATE plus an INSERT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement (columns + types) — creates the table, inserts nothing",
      "sql": "INSERT INTO <target> (cols...) SELECT ... — REQUIRED, this is what loads the rows",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT query to preview the transformed data (TOP 100)"
    }`
      : `**Instructions for Local Storage**:
    The rows are fetched from SQL Server and written into a table in THIS
    workflow's own local DuckDB database. Nothing is written back to SQL Server.

    You provide ONE statement: the SQL Server SELECT that produces the rows you
    want. That is the only thing that runs. Its result is streamed straight into
    the local table, which is replaced on every run with the column types
    inferred from the data — so there is no CREATE TABLE to write, no INSERT,
    and no type mapping to choose. Do NOT emit "ddl" or "insertSql": nothing
    reads them, and inventing them only risks contradicting the SELECT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "sql": "SQL Server SELECT query producing the transformed rows",
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

    Be specific and provide working SQL. Use SQL Server-specific features where appropriate (e.g., IDENTITY, NVARCHAR, XML/JSON functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a Microsoft SQL Server expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Microsoft SQL Server
    - Target schema: ${targetSchema}
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
    3. Use ALTER TABLE if the user wants to modify table structure (add/drop/rename columns, change types).
    4. **Filtering Intent**: If the user's request is to "keep only," "get only," or "filter for" certain records, you must DELETE all records that do NOT meet that criteria (e.g., DELETE FROM table WHERE column != 'value').

    **ALTER TABLE Operations (SQL Server)**:
    - ADD COLUMN: ALTER TABLE table_name ADD column_name data_type [DEFAULT value]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - ALTER COLUMN: ALTER TABLE table_name ALTER COLUMN column_name new_data_type [NULL | NOT NULL]
    - RENAME COLUMN: EXEC sp_rename 'table_name.old_name', 'new_name', 'COLUMN' (use stored procedure)

    **Important**:
    - In-place mode only supports database storage (cannot store locally while modifying remote source).
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
      "ddl": "ALTER TABLE or EXEC sp_rename statement (null if not needed)",
      "sql": "UPDATE or DELETE statement (null if not needed)",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // the table columns AFTER the change, or "*" if the shape is unchanged (plain UPDATE / DELETE)
      "previewSql": "SELECT query to preview the modified table (TOP 100)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders",
      "ddl": null,
      "sql": "DELETE FROM ${fullTableName} WHERE status = 'cancelled'",
      "targetColumns": "*",
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Update operation:
    {
      "explanation": "Mark old orders as archived",
      "ddl": null,
      "sql": "UPDATE ${fullTableName} SET archived = 1, archived_date = GETDATE() WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table (add column):
    {
      "explanation": "Add **priority_level** column with default value",
      "ddl": "ALTER TABLE ${fullTableName} ADD priority_level INT DEFAULT 0",
      "sql": null,
      "targetColumns": [{"name": "order_id", "type": "INT"}, {"name": "total_amount", "type": "DECIMAL(10,2)"}, {"name": "discount_rate", "type": "DECIMAL(5,2)"}],   // ALL columns the table now has, not just the new one
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table (rename column):
    {
      "explanation": "Rename **customer_name** to **client_name**",
      "ddl": "EXEC sp_rename '${fullTableName}.customer_name', 'client_name', 'COLUMN'",
      "sql": null,
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table (modify type):
    {
      "explanation": "Change **status** column to allow longer values",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status NVARCHAR(100) NOT NULL",
      "sql": null,
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **display_name** column and populate from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD display_name NVARCHAR(255)",
      "sql": "UPDATE ${fullTableName} SET display_name = first_name + ' ' + last_name",
      "previewSql": "SELECT TOP 100 * FROM ${fullTableName}"
    }

    Be specific and provide working T-SQL. Use SQL Server-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for SQL Server
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for SQL Server)
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
  quoteColumn: (name) => `[${String(name).replace(/]/g, ']]')}]`,

  quoteIdentifier: (identifier, schema = null, config = null) =>
    quoteSqlServerIdentifier(identifier, schema),

  /**
   * Generate preview SQL query with database-specific syntax
   * @param {string} tableName - Table name (can be pre-quoted)
   * @param {number} limit - Number of rows to return (default 100)
   * @returns {string} Preview SQL query
   */
  getPreviewQuery: (tableName, limit = 100) => {
    return `SELECT TOP ${limit} * FROM ${tableName}`;
  },

  /**
   * Data Explorer dialect. Read by public/database/dialect.js — keyword and
   * function lists are unioned with the shared ANSI baseline, so only what is
   * distinctly T-SQL belongs here.
   */
  explorer: {
    // runQuery returns array rows on request ({ rowsAsArrays }), so the explorer
    // can keep same-named result columns apart.
    rowsAsArrays: true,
    language: 'sql',
    sqlDialect: 'TransactSQL',
    formatter: 'transactsql',
    // runQuery honours { maxRows } by streaming and cancelling — see the note there.
    maxRowsOption: true,
    container: 'Schema',
    objectLabel: 'Table',
    // Bracket quoting comes from this connector's own quoteIdentifier; this is
    // only the fallback, and T-SQL accepts double quotes under QUOTED_IDENTIFIER.
    quote: '"',
    keywords: [
      'TOP', 'OFFSET ? ROWS', 'FETCH NEXT ? ROWS ONLY', 'OUTPUT', 'MERGE',
      'CROSS APPLY', 'OUTER APPLY', 'PIVOT', 'UNPIVOT', 'WITH (NOLOCK)',
      'IDENTITY', 'NVARCHAR', 'DECLARE', 'BEGIN', 'GO', 'EXEC', 'TRY_CAST',
      'TRY_CONVERT', 'IIF', 'OVER', 'PARTITION BY',
    ],
    functions: [
      'ISNULL', 'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'DATEADD', 'DATEDIFF',
      'DATEPART', 'DATENAME', 'FORMAT', 'CONVERT', 'TRY_CONVERT', 'TRY_CAST',
      'STRING_AGG', 'STRING_SPLIT', 'CHARINDEX', 'PATINDEX', 'STUFF', 'LEN',
      'IIF', 'CHOOSE', 'NEWID', 'SCOPE_IDENTITY',
    ],
  }
};
