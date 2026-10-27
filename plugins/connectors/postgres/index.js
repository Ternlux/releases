/**
 * PostgreSQL Connector Plugin for Ternlux
 * Handles all PostgreSQL database operations
 */

const { Pool } = require('pg');

// Connection pool cache
const connectionPools = new Map();

// Most parameters a single statement can bind. The wire protocol writes the
// count as an unsigned 16-bit integer, so this is a hard protocol ceiling, not
// a tunable - going over it wraps the count rather than erroring cleanly.
const PG_MAX_BIND_PARAMS = 65535;

/**
 * Get or create connection pool
 */
function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    const pool = new Pool({
      host: config.host,
      port: config.port || 5432,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    connectionPools.set(key, pool);
  }

  return connectionPools.get(key);
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
  // pg reports the SQLSTATE itself as `code` — '42701' is duplicate_column.
  // Repeated under sqlState so a caller can read it by either name.
  code: error.code,
  sqlState: error.code,
});

/**
 * VARCHAR length for a column whose longest SAMPLED value is `maxLen`.
 *
 * Headroom, because the sample is the first page of a load and not the whole of
 * it: half again as long, never under 255, never over this dialect's own limit.
 * Each connector carries its own copy — the ceiling is a property of the engine
 * (65535 here, 8000 for SQL Server's non-MAX NVARCHAR), and connectors do not
 * reach outside their own folder.
 */
const varcharFor = (maxLen) => Math.ceil(Math.min(Math.max((maxLen || 0) * 1.5, 255), 65535));

module.exports = {
  type: 'connector',
  id: 'postgres',
  name: 'PostgreSQL',
  icon: './icon.svg',
  dbCategory: 'SQL',
  // How a join may write "update the rows that match, insert the rest" here
  // (join write mode "merge"). Read by the join builder and shown to the model
  // that writes the statement; nothing here is executed.
  mergeSupport: {
    statements: ['MERGE', 'INSERT … ON CONFLICT … DO UPDATE'],
    guidance: 'Prefer MERGE INTO {{TARGET}} AS t USING (<the joined SELECT>) AS s ON t.<key> = s.<key> '
      + 'WHEN MATCHED THEN UPDATE SET <col> = s.<col>, … WHEN NOT MATCHED THEN INSERT (<cols>) VALUES (s.<cols>) '
      + '(PostgreSQL 15+). INSERT INTO {{TARGET}} (<cols>) SELECT … ON CONFLICT (<key>) DO UPDATE SET <col> = EXCLUDED.<col> '
      + 'also works, but only when the key has a PRIMARY KEY or UNIQUE constraint — declare it in targetDdl.',
  },

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js — the caller decides what
   * a column HOLDS, this decides what it is called here.
   */
  /**
   * Why this engine cannot create a column with this name, or null. Checked
   * before an Output creates a table, so a name the engine would refuse (or
   * silently shorten) fails with the column named and the fix, not with
   * whatever the CREATE happens to say.
   */
  columnNameProblem: (name) => {
    // 63 BYTES, not characters — and a longer name is not refused but cut,
    // so the column would silently get a different name.
    const n = Buffer.byteLength(String(name), 'utf8');
    return n > 63 ? `is ${n} bytes long; Postgres keeps only the first 63 and would rename it` : null;
  },

  types: {
    NULL: () => 'TEXT',
    DATE_ONLY: () => 'DATE',
    TIMESTAMP: () => 'TIMESTAMP',
    BOOLEAN: () => 'BOOLEAN',
    INTEGER: () => 'INTEGER',
    FLOAT: () => 'DOUBLE PRECISION',
    OBJECT: () => 'TEXT',
    // Past 255 characters an unbounded TEXT is cheaper to live with than a
    // VARCHAR(n) guessed from a sample — Postgres stores them identically.
    STRING: (maxLen) => (maxLen > 255 ? 'TEXT' : `VARCHAR(${varcharFor(maxLen)})`),
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js. A missing key falls back
    // (BIGINT → INTEGER, DOUBLE → FLOAT, …).
    BIGINT: () => 'BIGINT',
    // Unconstrained NUMERIC when the source gave no precision: it holds any
    // exact value, which is the point of copying an exact type.
    DECIMAL: (p, s) => (p ? `NUMERIC(${Math.min(p, 1000)},${s || 0})` : 'NUMERIC'),
    TIMESTAMPTZ: () => 'TIMESTAMPTZ',
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
    if (t === 'smallint' || t === 'integer') return { kind: 'INTEGER' };
    if (t === 'bigint') return { kind: 'BIGINT' };
    if (t === 'real' || t === 'double precision') return { kind: 'DOUBLE' };
    if (t === 'numeric' || t === 'money') {
      return { kind: 'DECIMAL', precision: column.precision ?? null, scale: column.scale ?? null };
    }
    if (t === 'boolean') return { kind: 'BOOLEAN' };
    if (t === 'date') return { kind: 'DATE_ONLY' };
    if (t === 'timestamp with time zone') return { kind: 'TIMESTAMPTZ' };
    if (t === 'timestamp without time zone') return { kind: 'TIMESTAMP' };
    if (t.startsWith('time')) return { kind: 'TIME' };
    if (t === 'json' || t === 'jsonb' || t === 'array') return { kind: 'OBJECT' };
    // character varying, character, text, uuid, user-defined (enums), bytea…
    return { kind: 'STRING', length: column?.maxLength ?? null };
  },

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const pool = getPool(config, connectionId);
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
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
      const pool = getPool(config, connectionId);
      const result = await pool.query(`
        SELECT
          table_schema as schema,
          table_name as name,
          table_type as type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
      `);
      // Every schema this login can use, empty ones included — the explorer
      // builds its tree from this list as well as from the tables.
      const schemaResult = await pool.query(`
        SELECT nspname AS name FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
          AND has_schema_privilege(nspname, 'USAGE')
        ORDER BY nspname
      `);

      return {
        success: true,
        schemas: schemaResult.rows.map((row) => row.name),
        tables: result.rows.map(row => ({
          schema: row.schema,
          name: row.name,
          type: row.type === 'BASE TABLE' ? 'table' : 'view'
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
      // Callers disagree on how they name a table: the Data Explorer passes the
      // schema separately with a bare table, while the output node passes a
      // qualified "public.orders" and no schema. Taking the second shape
      // literally searches for a table whose NAME contains a dot, which matches
      // nothing — silently, since the caller that needs this treats a failed
      // lookup as "cannot check". Accept both, and let an explicit `schema` win
      // over the qualifier.
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
      const pool = getPool(config, connectionId);
      const result = await pool.query(`
      SELECT c.column_name AS name, c.data_type AS type,
      c.is_nullable AS nullable,
      c.character_maximum_length AS max_length,
      c.numeric_precision AS precision, c.numeric_scale AS scale,
      CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS "isPrimary"
FROM information_schema.columns c
LEFT JOIN (
 SELECT ku.column_name
 FROM information_schema.table_constraints tc
 JOIN information_schema.key_column_usage ku
   ON tc.constraint_name = ku.constraint_name
  AND tc.table_schema = ku.table_schema
 WHERE tc.constraint_type = 'PRIMARY KEY'
   AND tc.table_schema = $1 AND tc.table_name = $2
) pk ON c.column_name = pk.column_name
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
      `, [schema, table]);

      return {
        success: true,
        columns: result.rows.map(row => ({
          name: row.name,
          type: row.type,
          nullable: row.nullable === 'YES',
          // The query aliases it "isPrimary" (quoted, so the case is kept).
          isPrimary: row.isPrimary === true,
          defaultValue: row.default_value,
          // Size and precision, so a copy elsewhere can keep them (see
          // toCanonicalType). null where the type has none.
          maxLength: row.max_length,
          precision: row.precision,
          scale: row.scale,
        }))
      };
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Run SQL query
   * Accepts a query object with a 'query' field containing the SQL string
   */
  /**
   * @param {object} [options]
   * @param {number} [options.maxRows] - Stop after this many rows.
   *
   * The cap is applied through a cursor, so the SQL the user wrote is the SQL
   * Postgres runs — no LIMIT is appended and no subquery is wrapped around it.
   * A cursor reads a bounded number of rows and the rest of the result is never
   * materialised on either side of the wire.
   *
   * The statement runs exactly ONCE on every path. A cursor that fails is
   * reported as a failure rather than retried unwrapped: re-running an
   * arbitrary statement to work around a read problem is how an INSERT ends up
   * applied twice.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => {
    const pool = getPool(config, connectionId);
    const sqlQuery = queryObj.query;
    const maxRows = Number(options.maxRows);

    if (!(maxRows > 0)) {
      try {
        const result = await pool.query(sqlQuery);
        return {
          success: true,
          rows: result.rows,
          columns: result.fields ? result.fields.map(f => f.name) : [],
          rowCount: result.rowCount
        };
      } catch (error) {
        return queryError(error);
      }
    }

    const Cursor = require('pg-cursor');
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      return queryError(error);
    }

    return new Promise((resolve) => {
      let cursor;
      try {
        // rowsAsArrays: the Data Explorer asks for array rows so two result
        // columns with the same name (SELECT 1 AS x, 2 AS x) don't collapse
        // into one object key; it names the duplicates itself.
        cursor = client.query(options.rowsAsArrays
          ? new Cursor(sqlQuery, null, { rowMode: 'array' })
          : new Cursor(sqlQuery));
      } catch (error) {
        client.release();
        resolve(queryError(error));
        return;
      }
      // One past the cap, so "is there more?" is observed rather than assumed.
      cursor.read(maxRows + 1, (err, rows, result) => {
        cursor.close(() => client.release());
        if (err) {
          resolve(queryError(err));
          return;
        }
        const all = rows || [];
        const capped = all.slice(0, maxRows);
        const fields = (result && result.fields) || [];
        resolve({
          success: true,
          rows: capped,
          columns: fields.length
            ? fields.map(f => f.name)
            : Object.keys(capped[0] || {}),
          // A statement that returns no rows (DDL, or an UPDATE without
          // RETURNING) completes through the same path with an empty array —
          // its command tag is the only count there is, so report that.
          rowCount: capped.length || (result && result.rowCount) || 0,
          truncated: all.length > maxRows,
          ...(options.rowsAsArrays ? { rowsAreArrays: true } : {}),
        });
      });
    });
  },

  /**
   * Stream query results in batches (for large datasets)
   * Calls onBatch with each batch of rows
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const Cursor = require('pg-cursor');
      const pool = getPool(config, connectionId);
      const client = await pool.connect();

      return new Promise((resolve, reject) => {
        const cursor = client.query(new Cursor(query));
        let columns = null;
        let totalRows = 0;

        const readBatch = () => {
          cursor.read(batchSize, async (err, rows) => {
            if (err) {
              cursor.close(() => client.release());
              reject(err);
              return;
            }

            if (rows.length === 0) {
              // No more rows
              cursor.close(() => client.release());
              resolve({ success: true, totalRows });
              return;
            }

            // Extract column names from first batch
            if (!columns && rows.length > 0) {
              columns = Object.keys(rows[0]);
            }

            totalRows += rows.length;

            try {
              // Call onBatch and wait for it to complete
              await onBatch(rows, columns);
              // Continue reading next batch
              readBatch();
            } catch (batchError) {
              cursor.close(() => client.release());
              reject(batchError);
            }
          });
        };

        readBatch();
      });
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Batch insert rows into a table (uses parameterized multi-row INSERT with transaction)
   */
  batchInsert: async (config, connectionId, tableName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const pool = await getPool(config, connectionId);
      const client = await pool.connect();

      try {
        // Start transaction
        await client.query('BEGIN');

        // One INSERT per slice of rows, not one for the whole call: the
        // protocol's Bind message counts parameters in a 16-bit field, so a
        // statement can carry at most PG_MAX_BIND_PARAMS of them. The caller
        // sizes its chunk for memory (tens of thousands of rows), which for
        // anything but a one-column table is far past that ceiling — and the
        // overflow does not surface as "too many parameters" but as the count
        // WRAPPED, e.g. 50,000 rows x 7 columns reported back as "bind message
        // has 22320 parameter formats but 0 parameters". Slicing by the actual
        // column count keeps every statement under the real limit; they all run
        // inside the one transaction, so the call as a whole still lands or
        // rolls back together.
        const rowsPerStatement = Math.floor(PG_MAX_BIND_PARAMS / columns.length);
        if (rowsPerStatement < 1) {
          // A single row already exceeds the ceiling - no slicing can help.
          throw new Error(
            `Cannot insert into ${tableName}: ${columns.length} columns exceeds `
            + `PostgreSQL's limit of ${PG_MAX_BIND_PARAMS} parameters per statement.`
          );
        }

        for (let start = 0; start < rows.length; start += rowsPerStatement) {
          const slice = rows.slice(start, start + rowsPerStatement);

          // Build parameterized multi-row INSERT
          const valuePlaceholders = slice.map((_, rowIndex) => {
            const rowPlaceholders = columns.map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`);
            return `(${rowPlaceholders.join(', ')})`;
          });

          // batchInsert is given the table name UNQUOTED and quotes it here —
          // the contract every other connector already keeps. Interpolating it
          // bare made this the one INSERT in the codebase that could not reach
          // a table whose name carries a capital: a join's `CREATE TABLE
          // "temp_dataSource_x"` preserved the S, this asked for
          // temp_datasource_x, and the load failed with `relation does not
          // exist` after reading every row of the source.
          const insertSql = `INSERT INTO ${module.exports.quoteIdentifier(tableName)} `
            // Columns quoted one by one — bare, a column called `order` or
            // `first name` was a syntax error, and a capital was folded away.
            + `(${columns.map((c) => module.exports.quoteColumn(c)).join(', ')}) VALUES ${valuePlaceholders.join(', ')}`;

          // Flatten all values into a single array
          const allValues = slice.flatMap(row =>
            columns.map(col => {
              const val = row[col];
              if (val instanceof Date) return val;
              if (typeof val === 'object' && val !== null) return JSON.stringify(val);
              return val;
            })
          );

          await client.query(insertSql, allValues);
        }

        // Commit transaction
        await client.query('COMMIT');
        client.release();

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await client.query('ROLLBACK');
        client.release();
        throw error;
      }
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Run several statements as ONE transaction on one connection: all of them
   * land, or none do.
   *
   * runQuery takes a pooled connection per call, so two calls are two
   * transactions and a failure in the second cannot undo the first. A
   * truncate-and-load that has to replace a table's contents without ever
   * leaving it empty needs the delete and the insert committed together — this
   * is that primitive. Returns { success, message } like runQuery; on failure
   * the transaction has been rolled back.
   */
  runInTransaction: async (config, connectionId, statements) => {
    let client;
    try {
      const pool = await getPool(config, connectionId);
      client = await pool.connect();
    } catch (error) {
      return queryError(error);
    }
    try {
      await client.query('BEGIN');
      for (const sql of statements) await client.query(sql);
      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return queryError(error);
    } finally {
      client.release();
    }
  },

  /**
   * Close connection pool
   */
  closeConnection: async (connectionId) => {
    if (connectionPools.has(connectionId)) {
      const pool = connectionPools.get(connectionId);
      await pool.end();
      connectionPools.delete(connectionId);
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
        label: 'Host',
        placeholder: 'localhost',
        required: true,
        sensitive: true
      },
      {
        name: 'port',
        type: 'number',
        label: 'Port',
        placeholder: '5432',
        default: 5432,
        required: true,
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
        placeholder: 'postgres',
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
        name: 'schema',
        type: 'string',
        label: 'Schema',
        placeholder: 'public',
        default: 'public',
        required: false,
        sensitive: false
      },
      {
        name: 'ssl',
        type: 'boolean',
        label: 'Use SSL',
        default: false,
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating PostgreSQL transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a PostgreSQL expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: PostgreSQL
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Column names: PostgreSQL folds an UNQUOTED identifier to LOWER CASE, so a
      column whose stored name contains any upper-case letter is reachable only
      in double quotes. The column names listed in the source schema above are
      the EXACT stored names: wherever one is not already all lower-case, write
      it as "ThatName" every time it appears — in SELECT lists, WHERE clauses,
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
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local Storage**:
    The rows are fetched from PostgreSQL and written into a table in THIS
    workflow's own local DuckDB database. Nothing is written back to PostgreSQL.

    You provide ONE statement: the PostgreSQL SELECT that produces the rows you
    want. That is the only thing that runs. Its result is streamed straight into
    the local table, which is replaced on every run with the column types
    inferred from the data — so there is no CREATE TABLE to write, no INSERT,
    and no type mapping to choose. Do NOT emit "ddl" or "insertSql": nothing
    reads them, and inventing them only risks contradicting the SELECT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "sql": "PostgreSQL SELECT query producing the transformed rows",
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

    Be specific and provide working SQL. Use PostgreSQL-specific features where appropriate (e.g., SERIAL, JSONB, array operations).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a PostgreSQL expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: PostgreSQL
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Column names: PostgreSQL folds an UNQUOTED identifier to LOWER CASE, so a
      column whose stored name contains any upper-case letter is reachable only
      in double quotes. The column names listed in the source schema above are
      the EXACT stored names: wherever one is not already all lower-case, write
      it as "ThatName" every time it appears — in SELECT lists, WHERE clauses,
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

    **ALTER TABLE Operations (PostgreSQL)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name [CASCADE]
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name
    - ALTER COLUMN TYPE: ALTER TABLE table_name ALTER COLUMN column_name TYPE new_type [USING expression]
    - SET DEFAULT: ALTER TABLE table_name ALTER COLUMN column_name SET DEFAULT value
    - SET NOT NULL: ALTER TABLE table_name ALTER COLUMN column_name SET NOT NULL

    **Important**:
    - In-place mode only supports database storage (cannot store locally while modifying remote source).
    - Ensure string literals are properly escaped for PostgreSQL.
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
      "sql": "UPDATE ${fullTableName} SET archived = true, archived_date = CURRENT_TIMESTAMP WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (add column):
    {
      "explanation": "Add **total_amount** column to track order totals",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount NUMERIC(10,2) DEFAULT 0.00",
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
      "explanation": "Change **status_code** from INTEGER to VARCHAR",
      "ddl": "ALTER TABLE ${fullTableName} ALTER COLUMN status_code TYPE VARCHAR(10) USING status_code::VARCHAR",
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

    Be specific and provide working PostgreSQL SQL. Use PostgreSQL-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for PostgreSQL
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for PostgreSQL)
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


    const quote = (part) => `"${String(part).replace(/"/g, '""')}"`;

    if (schema) {
      return `${quote(schema)}.${quote(identifier)}`;
    }

    // A dotted name passed as a single string ("public.product_vectors") with
    // no explicit schema is a multi-part schema.table name, and EACH part is
    // quoted → "public"."product_vectors". Quoting the whole string instead
    // asks for a table whose NAME contains a dot: CREATE TABLE made
    // "public.product_vectors" in the default schema, while the unquoted
    // `INSERT INTO public.product_vectors` resolved schema public / table
    // product_vectors — so the load failed with "relation does not exist"
    // against a table the CREATE had just reported as already existing.
    // Same rule, and the same reason, as the SQL Server connector's.
    if (typeof identifier === 'string' && identifier.includes('.')) {
      return identifier.split('.').map(quote).join('.');
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
   * distinctly PostgreSQL belongs here.
   */
  explorer: {
    // runQuery returns array rows on request ({ rowsAsArrays }), so the explorer
    // can keep same-named result columns apart.
    rowsAsArrays: true,
    language: 'sql',
    sqlDialect: 'PostgreSQL',
    formatter: 'postgresql',
    // runQuery honours { maxRows } via a cursor, so the Data Explorer never
    // pulls a whole table across the wire to show the first page of it. The
    // statement itself is passed through untouched.
    maxRowsOption: true,
    container: 'Schema',
    objectLabel: 'Table',
    quote: '"',
    keywords: [
      'ILIKE', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE', 'LATERAL',
      'DISTINCT ON', 'MATERIALIZED', 'REFRESH MATERIALIZED VIEW', 'RECURSIVE',
      'WINDOW', 'FILTER', 'TABLESAMPLE', 'EXPLAIN', 'ANALYZE', 'VACUUM', 'COPY',
      'GENERATED', 'IDENTITY', 'SERIAL', 'BIGSERIAL', 'JSONB', 'ARRAY', 'INTERVAL',
    ],
    functions: [
      'ARRAY_AGG', 'STRING_AGG', 'JSONB_AGG', 'JSON_AGG', 'JSONB_BUILD_OBJECT',
      'DATE_TRUNC', 'EXTRACT', 'AGE', 'NOW', 'TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP',
      'GENERATE_SERIES', 'UNNEST', 'SPLIT_PART', 'REGEXP_REPLACE', 'REGEXP_MATCHES',
      'PERCENTILE_CONT', 'PERCENTILE_DISC', 'GREATEST', 'LEAST',
    ],
  }
};
