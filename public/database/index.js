/**
 * Data Explorer IPC.
 *
 * Every database interaction the explorer performs goes through here, on the
 * `explorer:*` channels. Nothing in this folder is engine-specific: each
 * handler resolves the connector for the requested dbType and delegates the
 * parts only that engine can answer (its grammar, its preview syntax, how to
 * turn editor text into a query object). Anything an engine doesn't implement
 * falls back to the generic behaviour in ./dialect and ./validate.
 *
 * Registered by public/electron.js at startup.
 */

const { resolveDialect, quoteIdentifier } = require('./dialect');
const { validateStatement } = require('./validate');
const { registerQueryStore } = require('./queryStore');

// Rows returned to the renderer per run. The grid is not virtualised, and
// everything crosses IPC as one structured-clone payload, so this is a real
// ceiling rather than a preference.
const MAX_ROWS = 5000;

/**
 * Read at most `cap` rows, letting the ENGINE do the limiting.
 *
 * The cap is expressed to the DRIVER, never to the SQL: no LIMIT is appended
 * and nothing is wrapped in a subquery, so the statement the user wrote is the
 * statement the engine runs. Each connector implements that in whatever way its
 * driver actually supports — a cursor, a result stream it stops, a native
 * maxResults — and advertises it with `explorer.maxRowsOption`.
 *
 * Nothing here inspects the statement text. An earlier version classified it as
 * read-only by its leading keyword to decide whether a failed streaming read
 * could safely be retried; `WITH staged AS (…) INSERT …` reads as a SELECT
 * under any such rule, and retrying it would have inserted twice. The engine is
 * the only thing that knows what a statement does, so the decision belongs to
 * the connector — and the retry is gone entirely.
 *
 * The statement therefore executes EXACTLY ONCE on every path.
 */
async function readCapped({ connector, fullConfig, connectionId, payload, cap }) {
  if (connector.explorer && connector.explorer.maxRowsOption) {
    const res = await connector.runQuery(fullConfig, connectionId, payload, {
      maxRows: cap,
      // Array rows keep two result columns with the same name apart; as
      // objects the second overwrote the first (`SELECT 1 AS x, 2 AS x` showed
      // 2 and 2). See rowsToObjects.
      ...(connector.explorer.rowsAsArrays ? { rowsAsArrays: true } : {}),
    });
    return { res, capped: Boolean(res && res.success) };
  }

  // No driver-level cap available: the whole result lands in this process. The
  // slice at the call site at least keeps it off IPC.
  const res = await connector.runQuery(fullConfig, connectionId, payload);
  return { res, capped: false };
}

/**
 * Array rows → objects, with a repeated column name made unique the way DuckDB
 * names them (`x`, `x:1`, `x:2`) so every engine reads the same in the grid.
 */
function rowsToObjects(columnNames, rows) {
  const seen = new Map();
  const names = columnNames.map((name) => {
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return n === 0 ? name : `${name}:${n}`;
  });
  return {
    names,
    rows: rows.map((arr) => Object.fromEntries(names.map((name, i) => [name, arr[i]]))),
  };
}

/** How the tree groups what getTables() reports. */
function kindFor(rawType) {
  const t = String(rawType || '').toUpperCase();
  if (t.includes('VIEW')) return 'views';
  if (t.includes('COLLECTION')) return 'collections';
  return 'tables';
}

/**
 * Engine type name → the short label the grid puts under a column header, and
 * whether the column right-aligns.
 *
 * Ordered, and matched against the START of the declared type, so
 * `DECIMAL(18,4)` and `TIMESTAMP WITH TIME ZONE` land on their family without
 * every dialect's spelling being enumerated.
 */
const DISPLAY_TYPES = [
  [/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|INT|SERIAL|LONG)/i, 'integer', true],
  [/^(FLOAT|DOUBLE|DECIMAL|REAL|NUMERIC|MONEY)/i, 'number', true],
  [/^BOOL/i, 'boolean', false],
  [/^(DATE|TIMESTAMP|TIME|INTERVAL)/i, 'date', false],
  [/^(BLOB|BYTEA|BINARY|VARBINARY)/i, 'blob', false],
  [/^MAP\(/i, 'map', false],
  [/^STRUCT\(/i, 'struct', false],
  [/^UNION\(/i, 'union', false],
  [/^JSON/i, 'json', false],
  [/^(VARCHAR|CHAR|TEXT|STRING|UUID|ENUM)/i, 'string', false],
];

/**
 * The label for a DECLARED type, or null when there isn't one to read.
 *
 * Nothing here inspects a value: the whole point is that the engine already
 * said what the column is. A MAP whose entries arrive as `[{key, value}]` is
 * the case that made this necessary — by its value it looks like an array, and
 * calling it one sends a reader looking for list functions that will not bind.
 */
function displayType(declared) {
  const type = String(declared || '').trim();
  if (!type) return null;
  // A list is spelled as its ELEMENT type followed by `[]`, so it has to be
  // recognised before the element type matches a family of its own.
  if (/\[\]$/.test(type) || /^LIST\(/i.test(type)) return { type: 'list', numeric: false };
  for (const [pattern, label, numeric] of DISPLAY_TYPES) {
    if (pattern.test(type)) return { type: label, numeric };
  }
  // Something unmapped — show the engine's own word for it rather than
  // "unknown", minus any parameters.
  return { type: type.toLowerCase().split('(')[0].trim(), numeric: false };
}

/**
 * A display type per column: the engine's declared type where the connector
 * reports one, and otherwise inferred from the first non-null value.
 *
 * `runQuery` returns column NAMES, so sniffing was the only option and remains
 * the fallback for connectors that report nothing more. It is a guess, and it
 * guesses wrong in ways that matter: an all-null column reads as "unknown" and
 * loses its right-alignment, and a DuckDB MAP reads as "array" because that is
 * how its entries encode. A connector that also sends `columnTypes` gets the
 * real answer instead.
 */
function describeColumns(names, rows, declaredTypes = null) {
  const declared = new Map(
    (Array.isArray(declaredTypes) ? declaredTypes : []).map((c) => [c.name, c.type]),
  );

  return names.map((name) => {
    const fromDeclared = displayType(declared.get(name));
    if (fromDeclared) return { name, ...fromDeclared };

    let type = 'unknown';
    for (const row of rows) {
      const v = row ? row[name] : undefined;
      if (v === null || v === undefined) continue;
      if (typeof v === 'number') type = Number.isInteger(v) ? 'integer' : 'number';
      else if (typeof v === 'boolean') type = 'boolean';
      else if (v instanceof Date) type = 'date';
      else if (typeof v === 'object') type = Array.isArray(v) ? 'array' : 'object';
      else type = 'string';
      break;
    }
    return { name, type, numeric: type === 'integer' || type === 'number' };
  });
}

/**
 * Rows cross IPC by structured clone, which throws on Dates in some shapes,
 * on BSON/driver objects, and on anything with a circular reference. Reduce
 * every value to a clonable primitive before it leaves the main process.
 */
function sanitizeRows(rows) {
  const seen = new WeakSet();

  const clean = (v) => {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return v.toString();
    if (t === 'function' || t === 'symbol') return null;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex').slice(0, 64)}`;
    if (t === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      // Driver value objects (ObjectId, Decimal128, …) print far better than
      // they enumerate.
      if (typeof v.toHexString === 'function') return v.toHexString();
      if (Array.isArray(v)) return v.map(clean);
      const out = {};
      for (const k of Object.keys(v)) out[k] = clean(v[k]);
      return out;
    }
    return String(v);
  };

  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object') return { value: clean(row) };
    const out = {};
    for (const k of Object.keys(row)) out[k] = clean(row[k]);
    return out;
  });
}

/**
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {object} deps.pluginManager
 * @param {function} deps.getFullConfig   - (connectionId, baseConfig) => merged config
 * @param {function} deps.getUserDataDir  - resolves app.getPath('userData')
 * @param {function} [deps.listConnections] - () => all saved connection records
 */
function registerDatabaseIpc({ ipcMain, pluginManager, getFullConfig, getUserDataDir, listConnections }) {
  /** Resolve a connector, or null when this dbType has no plugin installed. */
  const connectorFor = (dbType) =>
    (pluginManager.hasConnector(dbType) ? pluginManager.getConnector(dbType) : null);

  /** The config shape the explorer builds for a file connection. */
  const configForConnection = (conn) => {
    if (conn.connectionType === 'file' && conn.fileInfo) {
      return {
        ...(conn.dbConfig || {}),
        dbPath: conn.fileInfo.filePath,
        tables: conn.fileInfo.tables || null,
        tablePaths: conn.fileInfo.tablePaths || null,
        tableSheets: conn.fileInfo.tableSheets || null,
        format: conn.fileInfo.format || null,
      };
    }
    return conn.dbConfig || {};
  };

  /**
   * Attach every OTHER connection of the same engine to the config.
   *
   * Local files are the reason this exists: each file is its own connection,
   * but they all live in one DuckDB instance, so a connector that is handed
   * its siblings can register them as additional schemas and let the user join
   * across files. The clicked connection stays primary — it owns the search
   * path, and the tree opens on it.
   *
   * Connectors that don't declare `explorer.siblingConnections` never see the
   * field, so nothing changes for a Postgres or Mongo connection.
   */
  const withSiblings = async (connector, dbType, connectionId, config) => {
    if (!connector.explorer || !connector.explorer.siblingConnections) return config;
    if (typeof listConnections !== 'function') return config;

    try {
      const all = await listConnections();
      const self = (all || []).find((c) => (c.id || c._id) === connectionId);
      const siblings = (all || [])
        .filter((c) => c.dbType === dbType && (c.id || c._id) !== connectionId)
        .map((c) => ({
          connectionId: c.id || c._id,
          name: c.name,
          config: configForConnection(c),
        }))
        .filter((s) => s.config && s.config.dbPath);

      // The connection's own name travels with its config: a connector may name
      // the user-facing schema after it (DuckDB does), and needs the sibling
      // names to resolve a collision the same way from either side.
      const named = self && self.name ? { ...config, connectionName: self.name } : config;
      return siblings.length ? { ...named, siblings } : named;
    } catch (_err) {
      // Browsing one file is still better than failing to browse any.
      return config;
    }
  };

  // ── dialect metadata ─────────────────────────────────────────────────────

  /**
   * Everything the editor needs to configure itself: language mode, keyword
   * and function lists for completion, what to call the tree's top level.
   * Fetched once when the explorer opens.
   */
  ipcMain.handle('explorer:metadata', async (_e, { dbType }) => {
    try {
      const connector = connectorFor(dbType);
      return {
        success: true,
        installed: Boolean(connector),
        dialect: resolveDialect(connector),
      };
    } catch (err) {
      return { success: false, message: err.message, dialect: resolveDialect(null) };
    }
  });

  // ── schema tree ──────────────────────────────────────────────────────────

  /**
   * The left panel's tree: schemas (or databases) each holding tables, views
   * and collections. Built from the connector's flat getTables() list.
   */
  ipcMain.handle('explorer:schema-tree', async (_e, { dbType, config, connectionId }) => {
    try {
      const connector = connectorFor(dbType);
      if (!connector) return { success: false, message: `No connector installed for "${dbType}"`, schemas: [] };
      if (typeof connector.getTables !== 'function') {
        return { success: false, message: `${dbType} connections cannot be browsed.`, schemas: [] };
      }

      const base = await getFullConfig(connectionId, config);
      const fullConfig = await withSiblings(connector, dbType, connectionId, base);
      const res = await connector.getTables(fullConfig, connectionId);
      if (!res || !res.success) {
        return { success: false, message: (res && res.message) || 'Could not list tables', schemas: [] };
      }

      const grouped = new Map();
      // Schemas the connector lists on their own, so one with nothing in it yet
      // (a fresh database's PUBLIC) is still in the tree. Built from tables
      // alone, an empty schema simply did not exist.
      for (const name of res.schemas || []) {
        if (!name || grouped.has(name)) continue;
        grouped.set(name, { name, primary: false, label: null, objects: { tables: [], views: [], collections: [] } });
      }
      for (const t of res.tables || []) {
        const schemaName = t.schema || '(default)';
        if (!grouped.has(schemaName)) {
          grouped.set(schemaName, {
            name: schemaName,
            // Set by the connector on the schema the opened connection owns.
            // The tree opens and focuses this one; the rest are there to join to.
            primary: Boolean(t.primary),
            label: t.schemaLabel || null,
            objects: { tables: [], views: [], collections: [] },
          });
        }
        if (t.primary) grouped.get(schemaName).primary = true;
        grouped.get(schemaName).objects[kindFor(t.type)].push({ name: t.name, type: t.type });
      }

      // Primary first, then alphabetical — the file you opened stays at the top.
      const schemas = Array.from(grouped.values()).sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      schemas.forEach((s) => {
        Object.values(s.objects).forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));
      });

      return { success: true, schemas };
    } catch (err) {
      return { success: false, message: err.message, schemas: [] };
    }
  });

  /** Columns for one object. Loaded lazily — on expand, and for completions. */
  ipcMain.handle('explorer:columns', async (_e, { dbType, config, connectionId, schema, table }) => {
    try {
      const connector = connectorFor(dbType);
      if (!connector) return { success: false, message: `No connector installed for "${dbType}"`, columns: [] };
      if (typeof connector.getColumns !== 'function') {
        return { success: true, columns: [] };
      }

      const base = await getFullConfig(connectionId, config);
      const fullConfig = await withSiblings(connector, dbType, connectionId, base);
      const res = await connector.getColumns(fullConfig, connectionId, schema, table);
      if (!res || !res.success) {
        return { success: false, message: (res && res.message) || 'Could not read columns', columns: [] };
      }
      return { success: true, columns: res.columns || [] };
    } catch (err) {
      return { success: false, message: err.message, columns: [] };
    }
  });

  // ── editor support ───────────────────────────────────────────────────────

  /**
   * Syntax-check a batch of statements. The renderer sends each statement with
   * the line it starts on, so issue positions come back already mapped to the
   * worksheet rather than to the statement.
   */
  ipcMain.handle('explorer:validate', async (_e, { dbType, statements }) => {
    try {
      const connector = connectorFor(dbType);
      const issues = [];

      for (const st of statements || []) {
        const res = validateStatement(connector, st.text);
        for (const issue of res.issues) {
          issues.push({
            ...issue,
            // Statement-local line 1 is the statement's own start line.
            line: (st.startLine || 1) + issue.line - 1,
            column: issue.line === 1 ? (st.startColumn || 1) + issue.column - 1 : issue.column,
          });
        }
      }

      return { success: true, issues };
    } catch (err) {
      return { success: false, message: err.message, issues: [] };
    }
  });

  /** The default `SELECT * FROM …` a table opens with, in the right dialect. */
  ipcMain.handle('explorer:preview-query', async (_e, { dbType, schema, table, limit = 100 }) => {
    try {
      const connector = connectorFor(dbType);
      const dialect = resolveDialect(connector);

      const custom = connector && connector.explorer && connector.explorer.previewQuery;
      if (typeof custom === 'function') {
        return { success: true, query: custom(schema, table, limit) };
      }

      if (dialect.language === 'json') {
        return {
          success: true,
          query: JSON.stringify({ collection: table, filter: {}, limit }, null, 2),
        };
      }

      const quoted = quoteIdentifier(connector, table, schema);
      const query = typeof connector?.getPreviewQuery === 'function'
        ? connector.getPreviewQuery(quoted, limit)
        : `SELECT * FROM ${quoted} LIMIT ${limit}`;
      return { success: true, query };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  /**
   * Pretty-print a statement in the connector's own dialect.
   *
   * Runs here rather than in the renderer so sql-formatter never enters the
   * webpack bundle — it ships ESM referencing TypeScript sources it doesn't
   * publish, which floods the dev build with source-map warnings.
   */
  ipcMain.handle('explorer:format', async (_e, { dbType, statement }) => {
    try {
      const dialect = resolveDialect(connectorFor(dbType));
      if (!dialect.formatter) {
        return { success: false, message: `${dbType} does not declare a formatter.` };
      }

      // eslint-disable-next-line global-require
      const { format } = require('sql-formatter');
      return {
        success: true,
        text: format(String(statement || ''), {
          language: dialect.formatter,
          keywordCase: 'upper',
        }),
      };
    } catch (err) {
      // Formatting is cosmetic — a statement it can't parse is not an error
      // worth interrupting the user for.
      return { success: false, message: err.message };
    }
  });

  // ── execution ────────────────────────────────────────────────────────────

  /**
   * Run exactly one statement — the block the editor resolved from the
   * selection or the surrounding `;`. Returns a normalised result the grid can
   * render without knowing which engine produced it.
   */
  ipcMain.handle('explorer:run', async (_e, { dbType, config, connectionId, statement, limit = MAX_ROWS }) => {
    const startedAt = Date.now();

    try {
      const connector = connectorFor(dbType);
      if (!connector) {
        return { success: false, message: `No connector installed for "${dbType}"`, ms: 0 };
      }
      if (typeof connector.runQuery !== 'function') {
        return { success: false, message: `${dbType} connections cannot run queries.`, ms: 0 };
      }

      const dialect = resolveDialect(connector);
      const text = String(statement || '').trim();
      if (!text) return { success: false, message: 'Nothing to run', ms: 0 };

      // Editor text → whatever this connector's runQuery expects. SQL engines
      // take { query }; document stores take a parsed params object, and their
      // parseQuery is what understands shell syntax.
      let payload;
      const parseQuery = connector.explorer && connector.explorer.parseQuery;
      if (typeof parseQuery === 'function') {
        try {
          payload = parseQuery(text);
        } catch (err) {
          return { success: false, message: err.message || 'Could not parse query', ms: Date.now() - startedAt };
        }
      } else {
        payload = { query: text };
      }

      const base = await getFullConfig(connectionId, config);
      // Siblings are registered before the run too, or a join written against
      // another file's schema would fail to resolve it.
      const fullConfig = await withSiblings(connector, dbType, connectionId, base);
      const cap = Math.max(1, Math.min(Number(limit) || MAX_ROWS, MAX_ROWS));
      const { res, capped } = await readCapped({
        connector, fullConfig, connectionId, payload, cap,
      });
      const ms = Date.now() - startedAt;

      if (!res || !res.success) {
        return { success: false, message: (res && res.message) || 'Query failed', ms };
      }

      let rawRows = res.rows;
      let arrayNames = null;
      if (res.rowsAreArrays && Array.isArray(res.columns)) {
        const converted = rowsToObjects(res.columns, rawRows || []);
        rawRows = converted.rows;
        arrayNames = converted.names;
      }
      const allRows = sanitizeRows(rawRows);
      const rows = allRows.slice(0, cap);
      const names = arrayNames
        || (Array.isArray(res.columns) && res.columns.length ? res.columns : Object.keys(rows[0] || {}));

      return {
        success: true,
        ms,
        rows,
        // `columnTypes` is optional — a connector that reports the engine's own
        // types gets them used; one that doesn't falls back to sniffing.
        columns: describeColumns(names, rows, res.columnTypes),
        // rowCount is what the engine reported; rows.length is what we kept.
        rowCount: typeof res.rowCount === 'number' ? res.rowCount : allRows.length,
        // On a capped read the engine stopped early, so `truncated` is the
        // connector's answer; otherwise we can only compare what we received.
        truncated: capped ? Boolean(res.truncated) : allRows.length > rows.length,
        // Tells the UI whether the cap was enforced at the engine or after the
        // whole result had already been pulled into memory.
        cappedAtSource: capped,
        rowCap: cap,
        // Non-SELECT statements come back with a message and no rows.
        message: res.message || null,
        // Objects the statement changed, when the connector reports them. The
        // explorer reloads these: after an ALTER, the tree and the completions
        // it feeds are describing a table that no longer looks like that.
        mutated: Array.isArray(res.mutated) && res.mutated.length ? res.mutated : null,
        language: dialect.language,
      };
    } catch (err) {
      return { success: false, message: err.message, ms: Date.now() - startedAt };
    }
  });

  // ── query memory ─────────────────────────────────────────────────────────
  registerQueryStore(ipcMain, getUserDataDir);
}

module.exports = { registerDatabaseIpc, MAX_ROWS };
