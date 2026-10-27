/**
 * MySQL Connector Plugin for Ternlux
 * Handles all MySQL database operations
 */

const mysql = require('mysql2/promise');

// Connection pool cache
const connectionPools = new Map();

// Most placeholders a single prepared statement can carry. The protocol writes
// the parameter count as an unsigned 16-bit integer, so this is a hard ceiling
// rather than a tunable.
const MYSQL_MAX_PLACEHOLDERS = 65535;

/**
 * Get or create connection pool
 */
function getPool(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!connectionPools.has(key)) {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port || 3306,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000,
    });

    // Talk to the server in the DATABASE's collation, not the driver's.
    //
    // mysql2 opens every connection as utf8mb4_unicode_ci. A string the session
    // makes — a literal, CAST(x AS CHAR), CONCAT — takes the connection's
    // collation, while columns keep their table's (utf8mb4_0900_ai_ci on a
    // MySQL 8 default database). Comparing the two failed with "Illegal mix of
    // collations … for operation '='", which is how a cross-engine join on a
    // cast key died. Asking the server for its own default rather than naming
    // one keeps this right on MariaDB and on databases with other collations.
    // Statements on one connection run in order, so this lands before any query.
    pool.on('connection', (conn) => {
      conn.query('SET collation_connection = @@collation_database', (err) => {
        if (err) console.log('[mysql] Could not match the database collation:', err.message);
      });
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
  // mysql2 names the condition ('ER_DUP_FIELDNAME'), numbers it (1060), and
  // carries the SQL standard state ('42S21').
  code: error.code,
  errno: error.errno,
  sqlState: error.sqlState,
});

/**
 * VARCHAR length for a column whose longest SAMPLED value is `maxLen`.
 * See the note on the same helper in plugins/connectors/postgres/index.js.
 */
const varcharFor = (maxLen) => Math.ceil(Math.min(Math.max((maxLen || 0) * 1.5, 255), 65535));

module.exports = {
  type: 'connector',
  id: 'mysql',
  name: 'MySQL',
  icon: './icon.svg',
  dbCategory: 'SQL',
  // See postgres: how a join may merge into this database (write mode "merge").
  mergeSupport: {
    statements: ['INSERT … ON DUPLICATE KEY UPDATE'],
    guidance: 'MySQL has no MERGE. Use INSERT INTO {{TARGET}} (<cols>) SELECT … ON DUPLICATE KEY UPDATE '
      + '<col> = VALUES(<col>), … . It only matches rows through a PRIMARY KEY or UNIQUE index on the key, so '
      + 'targetDdl MUST declare PRIMARY KEY (<key>) (a VARCHAR key needs a length, e.g. VARCHAR(255)). '
      + 'Against an existing table without that key it silently inserts duplicates instead of updating.',
  },

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js.
   */
  /**
   * Why this engine cannot create a column with this name, or null. Checked
   * before an Output creates a table, so a name the engine would refuse (or
   * silently shorten) fails with the column named and the fix, not with
   * whatever the CREATE happens to say.
   */
  columnNameProblem: (name) => {
    const n = [...String(name)].length;
    return n > 64 ? `is ${n} characters long; MySQL allows at most 64` : null;
  },

  types: {
    NULL: () => 'TEXT',
    DATE_ONLY: () => 'DATE',
    // DATETIME, not TIMESTAMP: MySQL's TIMESTAMP is a 1970-2038 range stored as
    // UTC and converted on read, which silently mangles a value outside it.
    TIMESTAMP: () => 'DATETIME',
    BOOLEAN: () => 'BOOLEAN',
    INTEGER: () => 'INT',
    FLOAT: () => 'DOUBLE',
    OBJECT: () => 'TEXT',
    // LONGTEXT for a column with no length at its source: TEXT stops at 64KB.
    STRING: (maxLen) => {
      if (maxLen === Infinity) return 'LONGTEXT';
      return maxLen > 255 ? 'TEXT' : `VARCHAR(${varcharFor(maxLen)})`;
    },
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js. No TIMESTAMPTZ: an instant lands in
    // DATETIME, converted to UTC (MySQL has no type that keeps an offset).
    BIGINT: () => 'BIGINT',
    DECIMAL: (p, s) => (p && p <= 65 && (s || 0) <= 30 ? `DECIMAL(${p},${s || 0})` : null),
    TIME: () => 'TIME',
  },

  /**
   * This engine's type for a column (a getColumns entry) as a canonical type —
   * what an Output writing a copy of this table elsewhere builds its column
   * from. See public/NodeExecution/columnTypes.js for the kinds. null leaves
   * the column to be guessed from its values.
   */
  toCanonicalType: (column) => {
    // COLUMN_TYPE: "int", "bigint unsigned", "decimal(10,2)", "varchar(40)"…
    const t = String(column?.type || '').toLowerCase().trim();
    const size = t.match(/\((\d+)(?:,(\d+))?\)/);
    const unsigned = /\bunsigned\b/.test(t);
    const base = t.split(/[\s(]/)[0];
    // tinyint(1) is how MySQL spells a boolean, but its values arrive as 0/1;
    // kept an integer so a copy holds exactly what was read.
    if (['tinyint', 'smallint', 'mediumint', 'year'].includes(base)) return { kind: 'INTEGER' };
    if (base === 'int' || base === 'integer') return { kind: unsigned ? 'BIGINT' : 'INTEGER' };
    if (base === 'bigint') return unsigned ? { kind: 'DECIMAL', precision: 20, scale: 0 } : { kind: 'BIGINT' };
    if (base === 'float' || base === 'double' || base === 'real') return { kind: 'DOUBLE' };
    if (base === 'decimal' || base === 'numeric') {
      return { kind: 'DECIMAL', precision: size ? Number(size[1]) : 10, scale: size && size[2] ? Number(size[2]) : 0 };
    }
    if (base === 'date') return { kind: 'DATE_ONLY' };
    if (base === 'datetime' || base === 'timestamp') return { kind: 'TIMESTAMP' };
    if (base === 'time') return { kind: 'TIME' };
    if (base === 'json') return { kind: 'OBJECT' };
    if (base === 'varchar' || base === 'char') return { kind: 'STRING', length: size ? Number(size[1]) : null };
    // text types, enum, set, blobs, bit…
    return { kind: 'STRING', length: null };
  },

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const conn = await mysql.createConnection({
        host: config.host,
        port: config.port || 3306,
        database: config.database,
        user: config.username,
        password: config.password,
        ssl: config.ssl ? {} : undefined,
        connectTimeout: 8000,
      });
      await conn.end();
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
      const [rows] = await pool.execute(`
        SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name,
               TABLE_TYPE AS type
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME
      `, [config.database]);

      return {
        success: true,
        // The connection's one database, listed even while it holds no tables.
        schemas: config.database ? [config.database] : [],
        tables: rows
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
      // Accept a qualified "reporting.orders" as well as a bare table with the
      // schema (here, the database) passed separately. Taking the qualified
      // form literally searches for a table whose NAME contains a dot, which
      // matches nothing — silently, since the caller that needs this treats a
      // failed lookup as "cannot check". An explicit `schema` wins.
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
      // No schema at all means the connection's own database — MySQL's
      // "schema" IS the database. Without this the lookup asked for
      // TABLE_SCHEMA = NULL and found nothing, so every caller that checks
      // whether a table exists (a join in append / merge mode, the output
      // node's same-connection copy) was told it did not.
      schema = schema || config.database || null;
      const pool = getPool(config, connectionId);
      const [rows] = await pool.execute(`
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
               IS_NULLABLE AS nullable,
               (COLUMN_KEY = 'PRI') AS isPrimary
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [schema, table]);

      return {
        success: true,
        columns: rows
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
   * The cap is applied by reading the result as a stream and destroying it once
   * enough rows have arrived, so the SQL the user wrote is the SQL MySQL runs —
   * no LIMIT is appended and no subquery is wrapped around it. Rows past the cap
   * are never buffered.
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
        const pool = getPool(config, connectionId);
        const [rows, fields] = await pool.execute(sqlQuery);
        // A statement that returns no result set (INSERT, UPDATE, DDL) hands
        // back a ResultSetHeader, not an array — its count is `affectedRows`.
        // Reading `.length` off it gave undefined, which callers reported as
        // "0 rows inserted" for a load that wrote every row.
        const isResultSet = Array.isArray(rows);
        return {
          success: true,
          rows,
          columns: fields ? fields.map(f => f.name) : [],
          rowCount: isResultSet ? rows.length : (rows?.affectedRows ?? 0),
          ...(isResultSet ? {} : { affectedRows: rows?.affectedRows ?? 0 }),
        };
      } catch (error) {
        return queryError(error);
      }
    }

    let connection;
    try {
      connection = await getPool(config, connectionId).getConnection();
    } catch (error) {
      return queryError(error);
    }

    return new Promise((resolve) => {
      const rows = [];
      let columns = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        connection.release();
        resolve(value);
      };

      try {
        // rowsAsArrays: see the PostgreSQL connector — keeps same-named
        // result columns apart for the Data Explorer.
        const q = connection.connection.query(options.rowsAsArrays
          ? { sql: sqlQuery, rowsAsArray: true }
          : sqlQuery);
        q.on('fields', (fields) => { columns = (fields || []).map(f => f.name); });

        const stream = q.stream();
        stream.on('data', (row) => {
          // One past the cap, so "is there more?" is observed rather than
          // assumed. Destroying the stream stops MySQL sending the rest.
          if (rows.length <= maxRows) rows.push(row);
          if (rows.length > maxRows) stream.destroy();
        });
        stream.on('error', (err) => finish(queryError(err)));
        const done = () => finish({
          success: true,
          rows: rows.slice(0, maxRows),
          columns: columns.length ? columns : Object.keys(rows[0] || {}),
          rowCount: Math.min(rows.length, maxRows),
          truncated: rows.length > maxRows,
          ...(options.rowsAsArrays ? { rowsAreArrays: true } : {}),
        });
        stream.on('end', done);
        stream.on('close', done);
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
      const pool = getPool(config, connectionId);
      const connection = await pool.getConnection();
  
      return new Promise((resolve, reject) => {
        let batch = [];
        let columns = null;
        let totalRows = 0;
  
        // 1. Drop down to the underlying callback-based connection
        const sqlQuery = connection.connection.query(query);
  
        // 2. Listen for fields on the query object itself
        sqlQuery.on('fields', (fields) => {
          columns = fields.map(f => f.name);
        });
  
        // 3. Create the stream
        const stream = sqlQuery.stream();
  
        stream.on('data', (row) => {
          batch.push(row);
  
          if (batch.length >= batchSize) {
            stream.pause();
            const currentBatch = batch;
            batch = [];
            totalRows += currentBatch.length;
  
            // Process batch asynchronously
            Promise.resolve(onBatch(currentBatch, columns))
              .then(() => stream.resume())
              .catch((err) => {
                stream.destroy();
                connection.release();
                reject(err);
              });
          }
        });
  
        stream.on('end', async () => {
          // Process remaining rows in batch
          if (batch.length > 0) {
            totalRows += batch.length;
            try {
              await onBatch(batch, columns);
            } catch (err) {
              connection.release();
              reject(err);
              return;
            }
          }
  
          connection.release();
          resolve({ success: true, totalRows });
        });
  
        stream.on('error', (err) => {
          connection.release();
          reject(err);
        });
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
      await pool.end();
      connectionPools.delete(connectionId);
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

      const pool = getPool(config, connectionId);
      const connection = await pool.getConnection();

      try {
        // Start transaction
        await connection.beginTransaction();

        // One INSERT per slice of rows, not one for the whole call: a prepared
        // statement carries at most MYSQL_MAX_PLACEHOLDERS placeholders, while
        // the caller sizes its chunk for memory (tens of thousands of rows).
        // Slicing by the actual column count keeps every statement under the
        // ceiling; they all run inside the one transaction, so the call still
        // lands or rolls back as a whole.
        const rowsPerStatement = Math.floor(MYSQL_MAX_PLACEHOLDERS / columns.length);
        if (rowsPerStatement < 1) {
          // A single row already exceeds the ceiling - no slicing can help.
          throw new Error(
            `Cannot insert into ${tableName}: ${columns.length} columns exceeds `
            + `the limit of ${MYSQL_MAX_PLACEHOLDERS} placeholders per statement.`
          );
        }

        for (let start = 0; start < rows.length; start += rowsPerStatement) {
          const slice = rows.slice(start, start + rowsPerStatement);

          // Build parameterized multi-row INSERT. The table name arrives
          // UNQUOTED and is quoted here — the contract every other connector
          // already keeps, and what the connection's own database qualifying it
          // (quoteIdentifier with the config) resolves a bare name to anyway.
          // Interpolated bare it could not reach a table whose name carries a
          // capital, which on a case-sensitive server (lower_case_table_names=0,
          // the Linux default) is a different table from the folded one.
          const valuePlaceholders = slice.map(() => `(${columns.map(() => '?').join(', ')})`);
          const insertSql = `INSERT INTO ${module.exports.quoteIdentifier(tableName, null, config)} `
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

          await connection.execute(insertSql, allValues);
        }

        // Commit transaction
        await connection.commit();
        connection.release();

        return {
          success: true,
          rowsInserted: rows.length
        };
      } catch (error) {
        // Rollback on error
        await connection.rollback();
        connection.release();
        throw error;
      }
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Run several statements as ONE transaction on one connection: all of them
   * land, or none do. See the PostgreSQL connector's note — the same contract.
   *
   * Callers must not put DDL in here: MySQL commits implicitly before and after
   * any DDL (TRUNCATE included), which would end the transaction early. A
   * DELETE + INSERT … SELECT is plain DML and stays atomic on InnoDB.
   */
  runInTransaction: async (config, connectionId, statements) => {
    let connection;
    try {
      connection = await getPool(config, connectionId).getConnection();
    } catch (error) {
      return queryError(error);
    }
    try {
      await connection.beginTransaction();
      for (const sql of statements) await connection.query(sql);
      await connection.commit();
      return { success: true };
    } catch (error) {
      await connection.rollback().catch(() => {});
      return queryError(error);
    } finally {
      connection.release();
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
        placeholder: '3306',
        default: 3306,
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
        placeholder: 'root',
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
   * Returns prompts for generating MySQL transformations
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a MySQL expert helping transform data.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: MySQL
    - Target schema: ${targetSchema}
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
      "previewSql": "SELECT query to preview the transformed data (LIMIT 100)"
    }`
      : `**Instructions for Local Storage**:
    The rows are fetched from MySQL and written into a table in THIS
    workflow's own local DuckDB database. Nothing is written back to MySQL.

    You provide ONE statement: the MySQL SELECT that produces the rows you
    want. That is the only thing that runs. Its result is streamed straight into
    the local table, which is replaced on every run with the column types
    inferred from the data — so there is no CREATE TABLE to write, no INSERT,
    and no type mapping to choose. Do NOT emit "ddl" or "insertSql": nothing
    reads them, and inventing them only risks contradicting the SELECT.

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "sql": "MySQL SELECT query producing the transformed rows",
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

    Be specific and provide working SQL. Use MySQL-specific features where appropriate (e.g., AUTO_INCREMENT, JSON functions).`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceConnection, targetSchema, fullTableName) => `You are a MySQL expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Target:
    - Database type: MySQL
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

    **ALTER TABLE Operations (MySQL)**:
    - ADD COLUMN: ALTER TABLE table_name ADD COLUMN column_name data_type [DEFAULT value] [AFTER existing_column]
    - DROP COLUMN: ALTER TABLE table_name DROP COLUMN column_name
    - RENAME COLUMN: ALTER TABLE table_name RENAME COLUMN old_name TO new_name (MySQL 8.0+)
    - CHANGE COLUMN: ALTER TABLE table_name CHANGE old_name new_name data_type (older MySQL versions)
    - MODIFY COLUMN: ALTER TABLE table_name MODIFY COLUMN column_name new_data_type

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
      "sql": "UPDATE ${fullTableName} SET archived = 1, archived_date = NOW() WHERE created_at < '2024-01-01'",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table (add column):
    {
      "explanation": "Add **discount_rate** column after **total_amount**",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN discount_rate DECIMAL(5,2) DEFAULT 0.00 AFTER total_amount",
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

    Alter table (modify type):
    {
      "explanation": "Change **status** column from VARCHAR(20) to VARCHAR(50)",
      "ddl": "ALTER TABLE ${fullTableName} MODIFY COLUMN status VARCHAR(50)",
      "sql": null,
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Alter table + update (add column and populate):
    {
      "explanation": "Add **total_price** column and calculate from quantity and unit price",
      "ddl": "ALTER TABLE ${fullTableName} ADD COLUMN total_price DECIMAL(10,2) DEFAULT 0.00",
      "sql": "UPDATE ${fullTableName} SET total_price = quantity * unit_price",
      "previewSql": "SELECT * FROM ${fullTableName} LIMIT 100"
    }

    Be specific and provide working MySQL SQL. Use MySQL-specific features where appropriate.`
  }),

  /**
   * Quote identifier (table/column name) for MySQL
   * @param {string} identifier - The identifier to quote
   * @param {string} schema - Optional schema name (not used for MySQL)
   * @param {object} config - Database configuration containing database name
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
  quoteColumn: (name) => `\`${String(name).replace(/`/g, '``')}\``,

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


    const quote = (part) => `\`${String(part).replace(/`/g, '``')}\``;

    // A schema the CALLER passed settles it: the identifier is then the table's
    // whole name, dots included. A table may genuinely be called
    // "public.transactions", and reading a qualifier out of a name that already
    // arrived with its schema beside it drops the real schema AND truncates the
    // name — the other connectors have always tested the schema first, and this
    // one now agrees.
    if (schema) {
      return `${quote(schema)}.${quote(identifier)}`;
    }

    // No schema beside it, so a qualifier may be read out of the name itself
    // ("reporting.orders"). That qualifier is explicit, so it wins over the
    // connection's own database, and each part is quoted separately: quoting the
    // whole string would ask for a table whose NAME contains a dot, which never
    // matches the unquoted `INSERT INTO reporting.orders` the insert path
    // builds. A name that IS genuinely dotted cannot be told apart from a
    // qualified one here, which is exactly why the caller passing a schema is
    // preferred over this reading.
    if (typeof identifier === 'string' && identifier.includes('.')) {
      return identifier.split('.').map(quote).join('.');
    }

    // Nothing explicit either way — fall back to the connection's own database.
    const databaseName = config?.database;

    if (databaseName) {
      return `${quote(databaseName)}.${quote(identifier)}`;
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
   * distinctly MySQL belongs here.
   */
  explorer: {
    // runQuery returns array rows on request ({ rowsAsArrays }), so the explorer
    // can keep same-named result columns apart.
    rowsAsArrays: true,
    language: 'sql',
    sqlDialect: 'MySQL',
    formatter: 'mysql',
    // runQuery honours { maxRows } by streaming and stopping — see the note there.
    maxRowsOption: true,
    // MySQL has no schema layer above the database, so the tree's top level
    // is the database itself.
    container: 'Database',
    objectLabel: 'Table',
    quote: '`',
    keywords: [
      'ON DUPLICATE KEY UPDATE', 'REPLACE INTO', 'IGNORE', 'STRAIGHT_JOIN',
      'SHOW TABLES', 'SHOW COLUMNS', 'DESCRIBE', 'EXPLAIN', 'USE', 'ENGINE',
      'AUTO_INCREMENT', 'UNSIGNED', 'ZEROFILL', 'CHARACTER SET', 'COLLATE',
      'SEPARATOR', 'REGEXP', 'RLIKE', 'LIMIT ? OFFSET ?',
    ],
    functions: [
      'GROUP_CONCAT', 'JSON_EXTRACT', 'JSON_OBJECT', 'JSON_ARRAY', 'JSON_UNQUOTE',
      'DATE_FORMAT', 'STR_TO_DATE', 'DATEDIFF', 'TIMESTAMPDIFF', 'DATE_ADD',
      'DATE_SUB', 'NOW', 'CURDATE', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
      'IFNULL', 'IF', 'FIND_IN_SET', 'SUBSTRING_INDEX', 'CONVERT',
    ],
  }
};
