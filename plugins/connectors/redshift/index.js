/**
 * Amazon Redshift Connector Plugin for Ternlux
 * Handles all Redshift database operations
 */

const { Pool } = require('pg');

// Connection pool cache
const connectionPools = new Map();

// Most parameters a single statement can bind. Redshift speaks the PostgreSQL
// wire protocol, which writes the count as an unsigned 16-bit integer - a hard
// protocol ceiling, not a tunable. Going over it wraps the count rather than
// erroring cleanly.
const PG_MAX_BIND_PARAMS = 65535;

/**
 * Get or create connection pool
 */
function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    // Parse host to remove JDBC protocol prefix if present
    let host = config.host;
    let port = config.port || 5439;

    // Handle JDBC URL format: jdbc:redshift://hostname:port/database
    if (host && host.includes('jdbc:redshift://')) {
      const urlMatch = host.match(/jdbc:redshift:\/\/([^:\/]+)(?::(\d+))?/);
      if (urlMatch) {
        host = urlMatch[1]; // Extract hostname
        if (urlMatch[2]) {
          port = parseInt(urlMatch[2], 10); // Extract port if present
        }
      }
    }

    const pool = new Pool({
      host: host,
      port: port,
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
  // Redshift speaks the Postgres wire protocol, so pg reports the SQLSTATE
  // itself as `code` — '42701' is duplicate_column.
  code: error.code,
  sqlState: error.code,
});

/**
 * VARCHAR length for a column whose longest SAMPLED value is `maxLen`.
 * 65535 is Redshift's hard ceiling for VARCHAR — there is no wider text type.
 */
const varcharFor = (maxLen) => Math.ceil(Math.min(Math.max((maxLen || 0) * 1.5, 255), 65535));

module.exports = {
  type: 'connector',
  id: 'redshift',
  name: 'Amazon Redshift',
  icon: './icon.svg',
  dbCategory: 'SQL',

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js.
   *
   * Redshift has NO unbounded text type. A bare TEXT — which is what this
   * connector got before it owned this block, by falling through to SQLite's
   * names — is accepted and silently means VARCHAR(256), truncating every
   * longer value on load. Every string here carries an explicit length.
   */
  /**
   * Why this engine cannot create a column with this name, or null. Checked
   * before an Output creates a table, so a name the engine would refuse (or
   * silently shorten) fails with the column named and the fix, not with
   * whatever the CREATE happens to say.
   */
  columnNameProblem: (name) => {
    const n = Buffer.byteLength(String(name), 'utf8');
    return n > 127 ? `is ${n} bytes long; Redshift allows at most 127` : null;
  },

  types: {
    NULL: () => 'VARCHAR(65535)',
    DATE_ONLY: () => 'DATE',
    TIMESTAMP: () => 'TIMESTAMP',
    BOOLEAN: () => 'BOOLEAN',
    // BIGINT rather than INTEGER: ids routinely outgrow 2^31 and widening a
    // column after the fact means rewriting the table.
    INTEGER: () => 'BIGINT',
    FLOAT: () => 'DOUBLE PRECISION',
    OBJECT: () => 'VARCHAR(65535)',
    STRING: (maxLen) => (maxLen > 255 ? 'VARCHAR(65535)' : `VARCHAR(${varcharFor(maxLen)})`),
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js.
    DECIMAL: (p, s) => (p && p <= 38 ? `DECIMAL(${p},${s || 0})` : null),
    TIMESTAMPTZ: () => 'TIMESTAMPTZ',
    TIME: () => 'TIME',
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
          schemaname as schema,
          tablename as name,
          'table' as type
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
        UNION ALL
        SELECT
          schemaname as schema,
          viewname as name,
          'view' as type
        FROM pg_views
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
        ORDER BY schema, name
      `);

      return {
        success: true,
        tables: result.rows.map(row => ({
          schema: row.schema,
          name: row.name,
          type: row.type
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
      // Accept a qualified "public.orders" as well as a bare table with the
      // schema passed separately — see the PostgreSQL connector's note. An
      // explicit `schema` wins over the qualifier.
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
        SELECT
          column_name AS name,
          data_type AS type,
          is_nullable AS nullable,
          column_default AS default_value
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, table]);

      return {
        success: true,
        columns: result.rows.map(row => ({
          name: row.name,
          type: row.type,
          nullable: row.nullable === 'YES',
          isPrimary: false, // Redshift doesn't enforce primary keys
          defaultValue: row.default_value
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
        cursor = client.query(new Cursor(sqlQuery));
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

        // One INSERT per slice of rows, not one for the whole call: a statement
        // can bind at most PG_MAX_BIND_PARAMS parameters, while the caller sizes
        // its chunk for memory (tens of thousands of rows). Over the ceiling the
        // count WRAPS rather than erroring cleanly, so the server rejects the
        // bind with a parameter count bearing no relation to the data. Slicing
        // by the actual column count keeps every statement under the limit; they
        // all run inside the one transaction, so the call still lands or rolls
        // back as a whole.
        const rowsPerStatement = Math.floor(PG_MAX_BIND_PARAMS / columns.length);
        if (rowsPerStatement < 1) {
          // A single row already exceeds the ceiling - no slicing can help.
          throw new Error(
            `Cannot insert into ${tableName}: ${columns.length} columns exceeds `
            + `the limit of ${PG_MAX_BIND_PARAMS} parameters per statement.`
          );
        }

        for (let start = 0; start < rows.length; start += rowsPerStatement) {
          const slice = rows.slice(start, start + rowsPerStatement);

          // Build parameterized multi-row INSERT
          const valuePlaceholders = slice.map((_, rowIndex) => {
            const rowPlaceholders = columns.map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`);
            return `(${rowPlaceholders.join(', ')})`;
          });

          // The table name arrives UNQUOTED and is quoted here — the contract
          // every other connector already keeps. Same rule as the PostgreSQL
          // connector this dialect follows; Redshift folds an identifier to
          // lower case either way by default, so this is the form that keeps
          // working if enable_case_sensitive_identifier is ever on.
          const insertSql = `INSERT INTO ${module.exports.quoteIdentifier(tableName)} `
            + `(${columns.join(', ')}) VALUES ${valuePlaceholders.join(', ')}`;

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
        label: 'Cluster Endpoint',
        placeholder: 'my-cluster.abc123.us-east-1.redshift.amazonaws.com',
        required: true,
        sensitive: true
      },
      {
        name: 'port',
        type: 'number',
        label: 'Port',
        placeholder: '5439',
        default: 5439,
        required: true,
        sensitive: false
      },
      {
        name: 'database',
        type: 'string',
        label: 'Database',
        placeholder: 'dev',
        required: true,
        sensitive: false
      },
      {
        name: 'username',
        type: 'string',
        label: 'Username',
        placeholder: 'awsuser',
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
        default: true,
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating Redshift transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are an Amazon Redshift expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Amazon Redshift
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Column names: Redshift folds an UNQUOTED identifier to LOWER CASE, so a
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

    **Redshift-Specific Considerations**:
    - Use appropriate distribution keys (DISTKEY) for large tables
    - Use sort keys (SORTKEY) for frequently filtered columns
    - Use ENCODE to specify column compression
    - Consider DISTSTYLE (AUTO, EVEN, KEY, ALL) based on table size and usage

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "ddl": "CREATE TABLE statement with Redshift optimizations (DISTKEY, SORTKEY, ENCODE) — creates the table, inserts nothing",
      "sql": "INSERT INTO <target> (cols...) SELECT ... — REQUIRED, this is what loads the rows",
      "targetColumns": [{"name": "col", "type": "TYPE"}],   // EVERY column of the result, in SELECT order — downstream nodes are configured from this, so it must match the SQL above
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local Storage**:
    The rows are fetched from Redshift and written into a table in THIS
    workflow's own local DuckDB database. Nothing is written back to Redshift.

    You provide ONE statement: the Redshift SELECT that produces the rows you
    want. That is the only thing that runs. Its result is streamed straight into
    the local table, which is replaced on every run with the column types
    inferred from the data — so there is no CREATE TABLE to write, no INSERT,
    and no type mapping to choose. Do NOT emit "ddl" or "insertSql": nothing
    reads them, and inventing them only risks contradicting the SELECT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "sql": "Redshift SELECT query producing the transformed rows",
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

    Be specific and provide working SQL. Use Redshift-specific features where appropriate (e.g., DISTKEY, SORTKEY, window functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are an Amazon Redshift expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: Amazon Redshift
    - Target schema: ${targetSchema}
    - Target table name: ${fullTableName}
      That name is already qualified and quoted for this engine. Use it EXACTLY
      as given: do not re-quote it, do not drop a part of it, and do not "tidy"
      what looks like a repeated qualifier out of it — a table's own name may
      contain a dot, so the repetition may be the name.
    - Column names: Redshift folds an UNQUOTED identifier to LOWER CASE, so a
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

    **ALTER TABLE Operations (Redshift)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value] [ENCODE encoding]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME TABLE: ALTER TABLE table_name RENAME TO new_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name

    **Important Redshift Limitations**:
    - Redshift does NOT support ALTER COLUMN TYPE directly
    - To change column type, you must: 1) Add new column with new type, 2) Copy data with type conversion, 3) Drop old column, 4) Rename new column
    - Redshift does NOT support SET DEFAULT or SET NOT NULL on existing columns

    **Important**:
    - In-place mode only supports database storage (cannot store locally while modifying remote source).
    - Ensure string literals are properly escaped for Redshift.
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
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_amount DECIMAL(10,2) DEFAULT 0.00 ENCODE LZO",
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

    Alter table + update (add column and populate):
    {
      "explanation": "Add **full_name** column and populate it from existing data",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN full_name VARCHAR(200) ENCODE LZO",
      "sql": "UPDATE ${fullTableName} SET full_name = first_name || ' ' || last_name",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working Redshift SQL. Use Redshift-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for Redshift
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name
   * @param {object} config - Database configuration (not used for Redshift)
   * @returns {string} Properly quoted identifier
   */
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

    // A dotted name given as one string ("public.orders") is a schema.table
    // name, so each part is quoted separately. Quoting it whole would ask for
    // a table whose NAME contains a dot — which then never matches the
    // unquoted `INSERT INTO public.orders` the insert path builds. Same rule
    // as the PostgreSQL connector this dialect follows.
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
   * distinctly Redshift belongs here.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'Redshift',
    formatter: 'redshift',
    // runQuery honours { maxRows } via a cursor — see the note there.
    maxRowsOption: true,
    container: 'Schema',
    objectLabel: 'Table',
    quote: '"',
    keywords: [
      'ILIKE', 'DISTKEY', 'SORTKEY', 'DISTSTYLE', 'ENCODE', 'COPY', 'UNLOAD',
      'VACUUM', 'ANALYZE', 'CREDENTIALS', 'IAM_ROLE', 'INTERLEAVED',
      'COMPUPDATE', 'STATUPDATE', 'LATE BINDING', 'EXTERNAL TABLE', 'SPECTRUM',
    ],
    functions: [
      'LISTAGG', 'DATE_TRUNC', 'DATEADD', 'DATEDIFF', 'GETDATE', 'CONVERT_TIMEZONE',
      'NVL', 'NVL2', 'DECODE', 'SPLIT_PART', 'REGEXP_REPLACE', 'REGEXP_SUBSTR',
      'JSON_EXTRACT_PATH_TEXT', 'JSON_ARRAY_LENGTH', 'APPROXIMATE COUNT',
      'PERCENTILE_CONT', 'MEDIAN', 'RATIO_TO_REPORT',
    ],
  }
};
