/**
 * DuckDB Connector Plugin for Ternlux
 *
 * Backs local connections. Unlike the other connectors there is no server: the
 * "database" is a path on disk, and DuckDB reads it in place — so exploring a
 * 5 GB CSV costs the same as a small one.
 *
 * A path is one of two things, and the difference decides everything:
 *
 *   a DATA FILE (csv / json / parquet / xlsx / avro) — registered as a view in
 *     a schema of this connection's own, which is what lets a worksheet say
 *     `SELECT * FROM Orders` about a file. Views are recreated per call, so a
 *     file edited on disk is picked up without reconnecting. A view cannot be
 *     written to, so DDL and DML take the copy-and-write-back path in
 *     runInPlace.
 *
 *     A workbook is the one file holding several tables: each sheet is its own
 *     view, all over the same path, and `sheet` is what tells them apart. They
 *     share one schema, so the tree shows the workbook once with a table per
 *     sheet, and `SELECT * FROM Items JOIN Orders …` needs no qualification.
 *
 *   a DATABASE (.duckdb / .sqlite / .db) — attached under its own catalog
 *     alias. Its tables are real tables, so UPDATE, INSERT, DELETE and ALTER
 *     run natively: nothing is copied, nothing is written back, and several
 *     databases can be attached at once and joined to each other and to files.
 *     SQLite goes through DuckDB's sqlite extension and is written through it
 *     too, so the same statements work on either kind.
 *
 * Config: { dbPath, tables?, tablePaths?, tableSheets?, format? }
 *   dbPath      the file DuckDB reads (csv / json / parquet / xlsx / avro /
 *               duckdb / sqlite)
 *   tables      names this connection owns; defaults to the file's own name,
 *               or for a database, to every table in it
 *   tablePaths  name -> path, when a connection spans more than one file
 *   tableSheets name -> sheet, for a workbook's tables — they share one path
 */

const fs = require('fs');
const path = require('path');

// public/ and plugins/ are siblings in both the repo and the packaged app.
// eslint-disable-next-line import/no-dynamic-require
const duck = require(path.join(__dirname, '..', '..', '..', 'public', 'duckdb'));

/** Short, stable token for a connection — the tiebreaker when names collide. */
function idToken(connectionId, config) {
  const seed = String(connectionId || config.dbPath || 'local');
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

/**
 * The schema a connection's tables live under.
 *
 * This name is USER-FACING: it appears in the tree, in the preview statement a
 * double-click generates, and in any cross-file join the user writes. So it is
 * the connection's own name, not a hash — `sales_csv.orders`, not
 * `c_968wen.orders`.
 *
 * Sanitized to a legal identifier, and prefixed if it would otherwise start
 * with a digit. Two connections whose names sanitize to the same string would
 * shadow each other, so the loser gets its id token appended; `siblings` is how
 * a connection learns which other names are in play. Ordering by connection id
 * keeps the choice stable across sessions — the same connection always resolves
 * to the same schema.
 */
// Lives in the core duckdb module, not here: the workflow executor registers
// its sources under the same schema name, and a name that differed between the
// two would mean the Explorer displaying `sales_csv.orders` while a run
// rejected it. Collision handling (below) stays connector-side — only the
// Explorer knows the sibling set.
const sanitizeSchemaName = duck.sanitizeSchemaName;

function schemaFor(connectionId, config) {
  const base = sanitizeSchemaName(config && config.connectionName);
  if (!base) return `c_${idToken(connectionId, config)}`;

  const clashes = (Array.isArray(config.siblings) ? config.siblings : [])
    .filter((s) => sanitizeSchemaName(s && s.name) === base);
  if (clashes.length === 0) return base;

  // Deterministic winner: the lowest connection id keeps the bare name.
  const ids = [String(connectionId), ...clashes.map((s) => String(s.connectionId))].sort();
  return ids[0] === String(connectionId) ? base : `${base}_${idToken(connectionId, config)}`;
}

/**
 * True when a connection points at a database rather than a data file.
 *
 * The difference runs through everything below. A data file has to be wrapped
 * in a view to be queryable, and a view cannot be written to. A database holds
 * real tables, so it is attached and its tables are addressed where they live:
 * UPDATE, INSERT, DELETE and ALTER all work natively, nothing is copied, and
 * nothing is written back.
 *
 * SQLite counts. DuckDB reads and WRITES an attached SQLite file through its
 * sqlite extension, so a .sqlite/.db file behaves exactly like a .duckdb one —
 * same tables, same native DML, and joinable against everything else in the
 * session. `.db` is treated as SQLite because that is what it is in practice.
 */
const isDatabase = (filePath) => /\.(duckdb|sqlite|sqlite3|db)$/i.test(String(filePath || ''));

/**
 * The data files this connection exposes, as `{ name, path, sheet }`.
 *
 * `sheet` is what makes a workbook work. Its sheets all share ONE path — the
 * .xlsx itself — so unlike the Parquet-per-sheet arrangement this replaced, the
 * path no longer identifies the table and the sheet name is what picks it out.
 * Null for every other format, which has only one table per file.
 */
function tablesOf(config) {
  const sheets = config.tableSheets && typeof config.tableSheets === 'object' ? config.tableSheets : {};
  const paths = config.tablePaths && typeof config.tablePaths === 'object' ? config.tablePaths : null;
  if (paths && Object.keys(paths).length) {
    return Object.entries(paths).map(([name, file]) => ({ name, path: file, sheet: sheets[name] || null }));
  }
  const names = Array.isArray(config.tables) && config.tables.length ? config.tables : null;
  const fallback = path.basename(config.dbPath || '', path.extname(config.dbPath || '')) || 'data';
  // Several names but only one path means an older record; they all describe
  // the same file, so point them at it rather than inventing paths.
  return (names || [fallback]).map((name) => ({
    name,
    path: config.dbPath,
    sheet: sheets[name] || null,
  }));
}

/**
 * The schema a connection's tables appear under, WITHOUT touching the file.
 *
 * A database's schema is its attach alias, which `aliasForDbPath` derives from
 * the path alone, so this stays a pure function for either kind of connection.
 * That is what lets the tree be built, and a single schema be re-registered on
 * demand, without opening anything.
 */
const schemaNameFor = (config, connectionId) => (
  isDatabase(config.dbPath)
    ? duck.aliasForDbPath(config.dbPath)
    : schemaFor(connectionId, config)
);

/**
 * The sibling connections as registerSchema wants them — each carrying its own
 * name and the peer list it needs to resolve its schema name the same way from
 * either side.
 */
function siblingsOf(config, connectionId) {
  const siblings = Array.isArray(config.siblings) ? config.siblings : [];
  return siblings.map((sib) => ({
    connectionId: sib.connectionId,
    name: sib.name,
    config: {
      ...sib.config,
      connectionName: sib.name,
      siblings: [
        { connectionId, name: config.connectionName },
        ...siblings.filter((s) => s.connectionId !== sib.connectionId),
      ],
    },
  }));
}

/** A file's identity for caching: its path and the version on disk. */
const fileVersion = (filePath) => {
  try { return `${filePath}@${fs.statSync(filePath).mtimeMs}`; } catch (_) { return `${filePath}@missing`; }
};

const fileExists = (filePath) => {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
};

/**
 * connectionId → the last registration made for it, and the inputs it was made
 * from. A hit skips the work entirely.
 *
 * Registering a data file is not bookkeeping: creating the view BINDS a reader
 * over it, which sniffs a CSV, verifies a workbook and (before it was pinned)
 * re-inferred a JSON file's whole schema. That was being paid on the schema
 * tree, on every column expansion and on every run, for the opened connection
 * AND every sibling — so re-registering an unchanged file was most of what
 * opening a large local file cost.
 *
 * The key covers everything the registration depends on: the session (a rebuilt
 * DuckDB instance has none of these views), the schema name it resolved to, and
 * each backing file's mtime — so a file edited on disk still re-registers, which
 * is what keeps an external edit visible without reconnecting.
 *
 * Only data files are cached. A database is ATTACHed rather than viewed, which
 * duck already caches, and its table list is a catalog query that must stay
 * live: a worksheet that creates a table in an attached database has to see it
 * in the tree without waiting for an mtime to change.
 */
const registrationCache = new Map();

function registrationKey(config, schema) {
  return JSON.stringify([
    duck.sessionEpoch(),
    schema,
    config.format || null,
    tablesOf(config).map((t) => [t.name, t.sheet || null, fileVersion(t.path)]),
  ]);
}

/**
 * Make one connection's tables reachable, and describe what backs each of them.
 *
 * A database is attached under its own catalog alias; its tables are already
 * base tables and are left alone. Data files each become a view in a schema of
 * this connection's own — and are skipped when nothing about them has changed
 * since the last call.
 *
 * @returns {Promise<{schema: string, tables: Array<{
 *   schema, name, kind: 'native'|'file', ref, path, format, from
 * }>}>} `ref` is how the table is addressed in SQL, `from` (files only) is the
 *   expression that reads the file behind it.
 */
async function registerSchema(config, connectionId) {
  if (isDatabase(config.dbPath)) return buildSchema(config, connectionId);

  const schema = schemaFor(connectionId, config);
  const key = registrationKey(config, schema);
  const cacheId = connectionId || config.dbPath;
  const cached = registrationCache.get(cacheId);
  if (cached && cached.key === key) return cached.result;

  const result = await buildSchema(config, connectionId);
  registrationCache.set(cacheId, { key, result });
  return result;
}

/** registerSchema without the memo — the work itself. */
async function buildSchema(config, connectionId) {
  if (isDatabase(config.dbPath)) {
    let alias;
    try {
      // ATTACH sniffs the file, so a SQLite database is recognised as one
      // without being told. That needs DuckDB's sqlite extension, which it
      // fetches on first use and caches — the one thing here that wants a
      // network, and only once per machine.
      alias = await duck.attachDb(config.dbPath);
    } catch (err) {
      throw new Error(
        `Could not open ${path.basename(config.dbPath)}: ${err.message}`
        + ' — reading a SQLite database needs DuckDB\'s sqlite extension,'
        + ' which is downloaded once and then cached.',
      );
    }

    // A connection may own only SOME of a database's tables: the app's older
    // imports all share one SQLite file, and each connection is scoped to the
    // tables it brought in. Listing the whole catalog would show a connection
    // every other import's data. An unscoped connection — a database file the
    // user picked themselves — gets everything in it.
    const names = Array.isArray(config.tables) && config.tables.length
      ? config.tables
      : await duck.tablesAt(config.dbPath);

    return {
      schema: alias,
      tables: names.map((name) => ({
        schema: alias,
        name,
        kind: 'native',
        ref: `${duck.quoteIdentifier(alias)}.${duck.quoteIdentifier(name)}`,
        path: config.dbPath,
        format: null,
        from: null,
      })),
    };
  }

  const schema = schemaFor(connectionId, config);
  await duck.exec(`CREATE SCHEMA IF NOT EXISTS ${duck.quoteIdentifier(schema)}`);

  const tables = [];
  for (const table of tablesOf(config)) {
    const format = config.format || duck.detectFormat(table.path);
    const from = await duck.tableRef(table.path, format, { sheet: table.sheet });
    const ref = `${duck.quoteIdentifier(schema)}.${duck.quoteIdentifier(table.name)}`;
    await duck.exec(`CREATE OR REPLACE VIEW ${ref} AS SELECT * FROM ${from}`);
    tables.push({
      schema, name: table.name, kind: 'file', ref, path: table.path, format, from, sheet: table.sheet,
    });
  }
  return { schema, tables };
}

/**
 * Point the shared connection at this connection's tables, then leave
 * search_path set so the caller's SQL can name them unqualified.
 *
 * `config.siblings` — supplied by the Data Explorer — lists the other local
 * file connections. Every one of them is registered as its own schema in the
 * same DuckDB instance, which is what lets a worksheet join one file to
 * another. Only the primary's schema goes on the search path, so unqualified
 * names still mean "the file I opened"; the rest are reached as
 * `<schema>.<table>`.
 *
 * A sibling that has gone missing (file deleted, drive unplugged) is skipped
 * rather than failing the whole browse.
 */
async function ensureViews(config, connectionId, registered = null) {
  if (!config || !config.dbPath) throw new Error('DuckDB requires a file path');
  const own = await registerSchema(config, connectionId);
  if (registered) {
    registered.push(...own.tables.map((t) => ({ ...t, primary: true, label: config.connectionName || config.name || null })));
  }

  for (const sib of siblingsOf(config, connectionId)) {
    try {
      // A sibling resolves its own schema name the same way the primary does,
      // so it needs its name AND the same peer list — otherwise the two sides
      // of a collision would disagree about which one keeps the bare name.
      const reg = await registerSchema(sib.config, sib.connectionId);
      if (registered) {
        registered.push(...reg.tables.map((t) => ({ ...t, primary: false, label: sib.name || null })));
      }
    } catch (_err) {
      // The file moved, was deleted, or isn't readable. Leaving it out of
      // `registered` is what keeps it out of the tree — listing a table whose
      // view failed to create would just fail again when clicked.
    }
  }

  // An attached database's tables live in its own catalog, so the search path
  // has to name the catalog as well as the schema for `orders` to mean them.
  //
  // The home catalog stays FIRST. A two-part `sales_csv.orders` — how the tree
  // says to reach a sibling — is resolved as schema.table inside whichever
  // catalog is current, and the sibling views live at home. Lead with the
  // attached database and those names stop resolving; lead with home and both
  // work, including writes straight to the database's own tables.
  const searchPath = isDatabase(config.dbPath)
    ? `${await duck.currentDatabase()}.main,${own.schema}.main`
    : own.schema;
  await duck.exec(`SET search_path = ${duck.quoteLiteral(searchPath)}`);
  return own.schema;
}

/**
 * Register only the connection that owns `schemaName`.
 *
 * Reading one table's columns needs one view, not the whole session's worth.
 * Schema names resolve without touching a file (schemaNameFor), so the owner is
 * found by name and only that connection is registered; an unrecognised schema
 * falls back to registering everything, which is the answer that cannot be
 * wrong.
 */
async function ensureSchema(config, connectionId, schemaName) {
  if (!config || !config.dbPath) throw new Error('DuckDB requires a file path');
  if (!schemaName) return ensureViews(config, connectionId);

  if (schemaNameFor(config, connectionId) === schemaName) {
    await registerSchema(config, connectionId);
    return schemaName;
  }

  const owner = siblingsOf(config, connectionId)
    .find((sib) => schemaNameFor(sib.config, sib.connectionId) === schemaName);
  if (!owner) return ensureViews(config, connectionId);

  await registerSchema(owner.config, owner.connectionId);
  return schemaName;
}

/**
 * The tables this connection and its siblings expose — WITHOUT registering
 * anything.
 *
 * A data-file connection already knows its own table names: they are in the
 * connection record (`tables` / `tablePaths` / `tableSheets`), which is what
 * `tablesOf` reads. Nothing about naming them requires opening the file, so the
 * schema tree no longer does — that is the difference between a sidebar that
 * appears at once and one that waits for every file the user has ever imported
 * to be sniffed.
 *
 * A missing file is dropped here rather than by a failed CREATE VIEW, which is
 * what registration used to fall back on. The tradeoff is that a file which
 * EXISTS but cannot be read now lists its table and reports the problem when it
 * is opened, instead of being silently absent from the tree.
 *
 * A database still has to be attached: its table list is in the file, not in
 * the connection record. Attaching is cached per session and reads no data.
 */
async function listTables(config, connectionId) {
  if (isDatabase(config.dbPath)) {
    const own = await registerSchema(config, connectionId);
    return own.tables;
  }

  const schema = schemaFor(connectionId, config);
  return tablesOf(config)
    .filter((table) => fileExists(table.path))
    .map((table) => ({
      schema,
      name: table.name,
      kind: 'file',
      ref: `${duck.quoteIdentifier(schema)}.${duck.quoteIdentifier(table.name)}`,
      path: table.path,
      format: config.format || duck.detectFormat(table.path),
      from: null,
      sheet: table.sheet,
    }));
}

/**
 * DuckDB statement types that write to the table they name, as reported by
 * DuckDB itself once the statement has been bound against real tables.
 *
 * Consulted only after a script has already failed, to decide which of its
 * statements are worth probing for a table to stage. A type left out of this
 * set is left alone with its original error, so the cost of an omission is a
 * statement that does not work — never one that does the wrong thing to a file.
 *
 * DROP and CREATE are deliberately absent. `DROP TABLE orders` would mean
 * deleting the user's file, which is not a thing a query console should do
 * without asking, and a CREATE makes a table in the session rather than a file.
 */
const WRITE_TYPES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE_INTO', 'ALTER', 'COPY']);

/**
 * Statements run one at a time.
 *
 * An in-place run swaps a connection's views for real tables while it works, so
 * for a moment `orders` is a copy being filled rather than the file. A read that
 * landed in the middle of that would come back short, or not resolve at all —
 * silently wrong, which is worse than slow. Ordering every statement behind the
 * last one closes the window; the desktop UI runs one statement at a time
 * anyway, so this only bites when something else queries in the background.
 *
 * Taken BEFORE duck's session lock everywhere, so the two can never deadlock.
 */
let runQueue = Promise.resolve();
function serialised(fn) {
  // Chain off settlement, not value: one failed statement must not poison the
  // ones queued behind it.
  const next = runQueue.then(fn, fn);
  runQueue = next.then(() => {}, () => {});
  return next;
}

/**
 * What the binder says about statement `index` as the catalog stands right now:
 * null if it binds, its complaint if it does not.
 *
 * The MESSAGE is the signal, not just success or failure. A statement halfway
 * through a script often cannot bind for a reason that is nobody's fault — the
 * UPDATE that backfills an expanded `ADD COLUMN … DEFAULT` names the column the
 * statement in front of it has yet to create — and a probe that only asked
 * "does it bind" would learn nothing from it. Asking the same statement twice
 * under two shapes of catalog and comparing what comes back still does: if the
 * answer changes, the thing that was changed is a thing the statement cares
 * about. The text is never read, only compared with itself.
 *
 * Nothing executes here — binding plans and stops.
 */
async function bindSays(sql, index) {
  try {
    await duck.statementType(sql, index);
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Which of these tables does statement `index` WRITE to?
 *
 * DuckDB will read a view but never write to one, and that asymmetry is the
 * answer: shape one candidate as a view, then as a real table, and ask the
 * binder both times. A different answer means the statement needs that name to
 * be a table — it writes to it. The same answer means the distinction did not
 * arise: the table is only read, and a table that is only read needs no copy at
 * all, because the view over the file already reads the whole file.
 *
 * This is asked of the binder rather than of the SQL text, because the text
 * does not answer it: DuckDB's plan for `INSERT INTO t VALUES (…)` does not
 * name `t` anywhere, in either the logical or the physical form.
 */
async function writeTargets(sql, index, candidates, asView, asEmptyTable) {
  const targets = [];
  for (const table of candidates) {
    await asView(table);
    const asViewSays = await bindSays(sql, index);
    await asEmptyTable(table);
    const asTableSays = await bindSays(sql, index);
    if (asViewSays !== asTableSays) targets.push(table);
  }
  return targets;
}

/**
 * Which of these tables does statement `index` NAME at all?
 *
 * The fallback for ALTER, which binds against a view and a table alike, so the
 * probe above cannot see it. Taking the name away entirely does change the
 * answer, and an ALTER names exactly one table — the one it alters.
 *
 * Only consulted for a statement already known to write, because "names it" is
 * not "writes to it": a SELECT names its tables too, and reads them happily
 * through the view.
 */
async function referencedTables(sql, index, candidates, drop, asEmptyTable) {
  const referenced = [];
  for (const table of candidates) {
    const presentSays = await bindSays(sql, index);
    await drop(table);
    const absentSays = await bindSays(sql, index);
    await asEmptyTable(table);
    if (presentSays !== absentSays) referenced.push(table);
  }
  return referenced;
}

/**
 * Every table in `candidates` that has to be a real table for this script to
 * run — asked statement by statement, with nothing executed.
 *
 * A script is not one statement, and its statements do not agree about what
 * they need: `ALTER TABLE a …; UPDATE b SET … FROM c` writes to two tables and
 * only reads a third. So each statement is probed on its own and the answers
 * are unioned. Tables nobody writes to stay views over their files.
 *
 * A statement DuckDB can name is only probed when its type says it writes;
 * a read is happy with a view, and probing it would materialise files a SELECT
 * was going to stream. A statement that cannot be bound yet has no type to go
 * on, so it gets the write probe regardless — that probe survives an unbindable
 * statement, and a read that fails to bind (a misspelled column, say) reports
 * no targets and so still costs nothing.
 *
 * @returns {Promise<{targets: object[], bindError: Error|null}>} `bindError` is
 *   the binder's first complaint, kept because it explains a failed script
 *   better than the view's "Can only update base table" does.
 */
async function materialiseTargets(sql, candidates, { asView, asEmptyTable, drop }) {
  const count = await duck.statementCount(sql);
  const targets = new Set();
  let bindError = null;

  for (let index = 0; index < count; index++) {
    let type = null;
    try {
      type = await duck.statementType(sql, index);
    } catch (err) {
      if (!bindError) bindError = err;
    }
    // A read needs nothing staged; the BEGIN/COMMIT an expansion is wrapped in
    // need nothing either.
    if (type && !WRITE_TYPES.has(type)) continue;

    const untargeted = candidates.filter((t) => !targets.has(t));
    if (!untargeted.length) continue;

    let found = await writeTargets(sql, index, untargeted, asView, asEmptyTable);
    if (!found.length && type && WRITE_TYPES.has(type)) {
      found = await referencedTables(sql, index, untargeted, drop, asEmptyTable);
    }
    for (const table of found) targets.add(table);
  }

  return { targets: [...targets], bindError };
}

/**
 * Run a script that changes data, after the plain attempt has failed.
 *
 * Reaching here means DuckDB refused the script as written. A failed statement
 * is rolled back — DuckDB is transactional, verified against a persistent
 * database — so nothing has happened and the script can be worked out and run
 * properly.
 *
 * What it takes depends on what backs each table:
 *
 *   a table in a .duckdb database — nothing. It is a base table, so a statement
 *     against it succeeds on the first attempt; it never gets here.
 *
 *   a data file — no format on disk supports row mutation, so the file is
 *     materialised into a real table, the script runs against that, and the
 *     result is written back over the file in its own format, through a temp
 *     file and a rename so a failure leaves the original alone.
 *
 * The order is: work out what the WHOLE script needs, stage exactly that, then
 * run the script once. Statement by statement would be simpler, but each one
 * would have to be executed before the next could be understood, and half of a
 * failed script is worse than none of it — this way a script that dies partway
 * leaves nothing but discarded copies behind, and no file is touched.
 *
 * Three things keep it cheap:
 *
 *   * The copies start EMPTY, so working out what the script touches costs
 *     binds and no rows. A misspelled column fails here, with the binder's own
 *     message, before a byte is read off disk.
 *   * Only the tables being WRITTEN to are filled — by any statement in the
 *     script. Everything else goes back to being a view over its file, which
 *     reads the file directly.
 *   * Only tables the script actually changed are written back — compared by
 *     fingerprint either side of the run, which covers the column shape as well
 *     as the rows, since an ALTER changes a table without touching a value.
 *
 * Candidates span the opened connection AND its siblings, so a script can write
 * to any local file the explorer has attached, not just the opened one, and to
 * several of them in one run.
 *
 * @returns {Promise<{result: object|null, bindError: Error|null}>} `result` is
 *   null when nothing was written after all — nothing ran, and the caller
 *   should report the failure from its own attempt.
 */
async function runInPlace(config, connectionId, sql, candidates) {
  const files = candidates.filter((t) => t.kind === 'file');
  if (!files.length) return { result: null, bindError: null };

  // Swapping views for tables changes what every other caller of the shared
  // connection sees, so it happens under the session lock.
  return duck.withSession(async () => {
    // `DROP TABLE IF EXISTS` is not a no-op against a view — DuckDB objects
    // that the name is held by the wrong kind of thing — so releasing a name
    // means trying both and letting the mismatch pass.
    const drop = async (t) => {
      for (const kind of ['TABLE', 'VIEW']) {
        try {
          await duck.exec(`DROP ${kind} IF EXISTS ${t.ref}`);
        } catch (_err) {
          // The name is held by the other kind; the next statement gets it.
        }
      }
    };
    const asEmptyTable = async (t) => {
      await drop(t);
      await duck.exec(`CREATE TABLE ${t.ref} AS SELECT * FROM ${t.from} LIMIT 0`);
    };
    const asView = async (t) => {
      await drop(t);
      await duck.exec(`CREATE VIEW ${t.ref} AS SELECT * FROM ${t.from}`);
    };

    const staged = [];
    try {
      for (const table of files) {
        await asEmptyTable(table);
        staged.push(table);
      }

      // With every candidate staged the binder can resolve what it can, and
      // says something intelligible about the rest. Nothing has run yet.
      const { targets, bindError } = await materialiseTargets(sql, staged, {
        asView, asEmptyTable, drop,
      });
      // Nothing in the script writes to a file, so it failed for its own
      // reasons. Report them rather than running anything a second time.
      if (!targets.length) return { result: null, bindError };

      const unwritable = targets.filter((t) => !t.format);
      if (unwritable.length) {
        throw new Error(
          `Cannot write ${unwritable.map((t) => path.basename(t.path)).join(', ')} back — `
          + 'only csv, json, parquet, xlsx and avro files can be modified in place',
        );
      }

      // Everything the script only reads goes back to being a view, so the
      // file is read where it lies instead of being copied.
      for (const table of staged) {
        if (!targets.includes(table)) await asView(table);
      }

      const before = new Map();
      for (const table of targets) {
        await duck.exec(`INSERT INTO ${table.ref} SELECT * FROM ${table.from}`);
        before.set(table.ref, await duck.fingerprint(table.ref));
      }

      // The whole script in one call. Every way of RUNNING sql takes a script,
      // whatever `prepare` thinks of one, and each statement now finds the
      // tables it writes to staged as tables. What comes back is the last
      // statement's result, which is what the worksheet showed before.
      const result = await duck.query(sql);

      const changed = [];
      for (const table of targets) {
        // A table the script DROPped has no fingerprint left to compare, and a
        // dropped table is not a licence to delete the user's file.
        let after;
        try {
          after = await duck.fingerprint(table.ref);
        } catch (_err) {
          continue;
        }
        if (after !== before.get(table.ref)) changed.push(table);
      }
      // Sequential, and it matters for a workbook: two sheets of one file can
      // both be targets, and each write reads back the file the last one left.
      for (const table of changed) {
        await duck.copyToFile(`SELECT * FROM ${table.ref}`, table.path, table.format, { sheet: table.sheet });
      }

      // DML reports what it touched in a single `Count` row; DDL reports
      // nothing, and the file it rewrote is the whole story.
      const affected = result.rows.length === 1 && result.rows[0].Count !== undefined
        ? Number(result.rows[0].Count)
        : null;
      // Naming the sheet as well as the file, since several sheets share one.
      const rewritten = changed
        .map((t) => (t.sheet ? `${path.basename(t.path)} (${t.sheet})` : path.basename(t.path)))
        .join(', ');

      return {
        result: {
          success: true,
          rows: [],
          columns: [],
          rowCount: affected,
          message: changed.length
            ? `${affected != null ? `${affected} row(s) changed · ` : ''}rewrote ${rewritten}`
            : 'Statement completed — nothing changed, so no file was rewritten',
          mutated: changed.map((t) => ({ schema: t.schema, table: t.name })),
        },
        bindError: null,
      };
    } finally {
      // Put every file back to being a view, whatever happened: a leftover
      // table would shadow the file it was copied from.
      for (const table of staged) {
        try {
          await asView(table);
        } catch (err) {
          console.warn('[duckdb] Could not restore the view over', table.name, err.message);
        }
      }
    }
  });
}

module.exports = {
  type: 'connector',
  id: 'duckdb',
  name: 'DuckDB',
  dbCategory: 'SQL',
  // See postgres: how a join may merge into this database (write mode
  // "merge"). Also what a LOCAL join destination (the workflow's DuckDB) gets.
  mergeSupport: {
    statements: ['MERGE', 'INSERT … ON CONFLICT … DO UPDATE'],
    guidance: 'Prefer MERGE INTO {{TARGET}} AS t USING (<the joined SELECT>) AS s ON t.<key> = s.<key> '
      + 'WHEN MATCHED THEN UPDATE SET <col> = s.<col>, … WHEN NOT MATCHED THEN INSERT (<cols>) VALUES (s.<cols>). '
      + 'INSERT INTO {{TARGET}} … ON CONFLICT (<key>) DO UPDATE SET <col> = EXCLUDED.<col> needs a PRIMARY KEY or '
      + 'UNIQUE on the key, declared in targetDdl.',
  },

  /**
   * Column types for a CREATE TABLE this app generates. See the note on
   * `types` in plugins/connectors/snowflake/index.js.
   */
  types: {
    NULL: () => 'VARCHAR',
    DATE_ONLY: () => 'DATE',
    TIMESTAMP: () => 'TIMESTAMP',
    BOOLEAN: () => 'BOOLEAN',
    // BIGINT rather than INTEGER: this is a staging engine for data arriving
    // from elsewhere, and an id that overflows 2^31 would fail the load.
    INTEGER: () => 'BIGINT',
    FLOAT: () => 'DOUBLE',
    // VARCHAR rather than JSON: the value is serialised to a string before it
    // gets here, and a malformed one would fail the INSERT rather than store.
    OBJECT: () => 'VARCHAR',
    // VARCHAR is unbounded in DuckDB — a length would be accepted and ignored.
    STRING: () => 'VARCHAR',
    // Only reached for a source column whose type is known — see
    // public/NodeExecution/columnTypes.js.
    DECIMAL: (p, s) => (p && p <= 38 ? `DECIMAL(${p},${s || 0})` : null),
    TIMESTAMPTZ: () => 'TIMESTAMPTZ',
    TIME: () => 'TIME',
  },

  testConnection: async (config) => {
    try {
      await ensureViews(config, null);
      return { success: true, message: 'File readable' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Undo what registerSchema did, for a connection that has been deleted.
   *
   * Browsing a local file leaves a schema of views behind on the shared DuckDB
   * instance — that is how one file can be joined to another. They outlive the
   * connection record: delete the connection and its views keep answering, so
   * a worksheet still resolves `sales_csv.orders` and the file still shows up
   * among another connection's siblings, until the app is restarted.
   *
   * A database-backed connection is ATTACHed rather than viewed, so it is
   * detached instead — which also lets go of the file handle.
   *
   * `config.siblings` must be the connections that REMAIN, exactly as the
   * explorer passes them when registering: schemaFor resolves a name collision
   * from the sibling list, so the same list is what reproduces the name this
   * connection was registered under.
   *
   * Never throws. Cleanup that fails is a stale view; cleanup that throws is a
   * connection the user cannot delete.
   */
  releaseConnection: async (config, connectionId) => {
    try {
      if (!config || !config.dbPath) return { success: true, message: 'Nothing was registered' };
      // Whatever is about to be dropped, the memo must stop claiming it is
      // registered — otherwise the next call would skip rebuilding views that
      // no longer exist.
      registrationCache.delete(connectionId || config.dbPath);

      if (isDatabase(config.dbPath)) {
        await duck.detachDb(config.dbPath);
        return { success: true, message: 'Database detached' };
      }

      const schema = schemaFor(connectionId, config);
      // CASCADE takes the views with the schema; they are only ever views over
      // a file, so nothing here owns data.
      await duck.exec(`DROP SCHEMA IF EXISTS ${duck.quoteIdentifier(schema)} CASCADE`);
      return { success: true, message: `Dropped schema ${schema}` };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * One entry per table. Reported as BASE TABLE rather than VIEW so files sit
   * under "Tables" in the tree — the view is an implementation detail.
   */
  getTables: async (config, connectionId) => {
    try {
      if (!config || !config.dbPath) throw new Error('DuckDB requires a file path');

      // The opened connection's tables come back flagged primary so the
      // explorer knows which schema to focus, followed by every sibling's —
      // all joinable, because they share one DuckDB instance.
      //
      // Nothing is registered here. Listing a name is not reading a file, and
      // treating it as though it were is what made the sidebar wait on every
      // file in the session; the views are built when a table is actually
      // opened, expanded or queried.
      const listed = (await listTables(config, connectionId))
        .map((t) => ({ ...t, primary: true, label: config.connectionName || config.name || null }));

      for (const sib of siblingsOf(config, connectionId)) {
        try {
          const tables = await listTables(sib.config, sib.connectionId);
          listed.push(...tables.map((t) => ({ ...t, primary: false, label: sib.name || null })));
        } catch (_err) {
          // The file moved, was deleted, or its database will not open. Leaving
          // it out is what keeps it off the tree.
        }
      }

      return {
        success: true,
        tables: listed.map((t) => ({
          schema: t.schema,
          schemaLabel: t.label,
          primary: t.primary,
          name: t.name,
          type: 'BASE TABLE',
        })),
      };
    } catch (error) {
      return { success: false, message: error.message, tables: [] };
    }
  },

  getColumns: async (config, connectionId, schema, table) => {
    try {
      // Accept a qualified "main.orders" as well as a bare table with the
      // schema passed separately — the same two shapes quoteIdentifier handles.
      // An explicit `schema` wins over the qualifier.
      const parts = String(table || '').split('.');
      if (parts.length === 2) {
        if (!schema) [schema] = parts;
        [, table] = parts;
      }
      // Only the schema being asked about has to exist for this — expanding one
      // table in the tree should not register every other connection's files.
      await ensureSchema(config, connectionId, schema);
      // Qualify with the schema the tree asked about. Unqualified would resolve
      // through search_path — i.e. always the opened file — so a sibling's
      // columns would come back wrong (or not at all) once siblings are
      // registered alongside it.
      const ref = schema
        ? `${duck.quoteIdentifier(schema)}.${duck.quoteIdentifier(table)}`
        : duck.quoteIdentifier(table);
      const columns = await duck.describe(ref);
      return {
        success: true,
        columns: columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: true,
          isPrimary: false,
          defaultValue: null,
        })),
      };
    } catch (error) {
      return { success: false, message: error.message, columns: [] };
    }
  },

  /**
   * Run a script: one statement, several, or the several DuckDB makes out of
   * one — `ALTER TABLE t ADD COLUMN c … DEFAULT <expr>` is a five-statement
   * transaction to the engine, whatever the worksheet shows.
   *
   * The script is RUN first, exactly as written. That is the whole routing
   * decision for everything that works: a read, a DESCRIBE or PRAGMA, and any
   * write against a table in an attached .duckdb database all succeed on the
   * first attempt and cost nothing extra.
   *
   * Only a failure is interesting. DuckDB refuses to write to a view at BIND
   * time and rolls a failed statement back besides, so a failure means nothing
   * happened — which makes it safe to ask what the script wanted and give it
   * that. runInPlace works out which tables the script writes to, stages those
   * as real tables, and runs the script against the files. If nothing in it
   * writes, nothing is run twice: the original failure is reported.
   *
   * Nothing here reads the SQL text. The engine answers every question.
   *
   * @param {object} [options]
   * @param {number} [options.maxRows] - Stop after this many rows. Honoured by
   *   streaming the result rather than by touching the SQL, so the statement
   *   the user wrote is the statement DuckDB runs.
   */
  runQuery: async (config, connectionId, queryObj, options = {}) => serialised(async () => {
    try {
      const registered = [];
      await ensureViews(config, connectionId, registered);
      const sql = queryObj && queryObj.query ? queryObj.query : queryObj;
      const maxRows = Number(options.maxRows);

      let result;
      try {
        result = maxRows > 0
          ? await duck.queryUpTo(sql, maxRows)
          : await duck.query(sql);
      } catch (err) {
        const attempt = await runInPlace(config, connectionId, sql, registered);
        if (attempt.result) return attempt.result;
        // Not a write. Report what stopped it — preferring the binder's account
        // of the statement over real tables, since the view's complaint is
        // "Can only update base table", which explains nothing.
        throw attempt.bindError || err;
      }

      // A statement that returns no columns at all changed the catalog rather
      // than reading it — an ALTER on a table in an attached database is the
      // case that matters, since it succeeds here without any staging. Tell the
      // explorer to reload those tables; their columns are what just changed.
      const catalogChanged = result.columns.length === 0;

      return {
        success: true,
        rows: result.rows,
        columns: result.columns.map((c) => c.name),
        // The engine's own types, alongside the names the contract asks for.
        // Without them the explorer has to guess a column's type from its first
        // value, which reads a MAP as an array — its entries cross into JS as
        // `[{key, value}]` — and an all-null column as nothing at all.
        columnTypes: result.columns.map((c) => ({ name: c.name, type: c.type })),
        rowCount: result.rowCount,
        // Set only on the streaming path; undefined means "we read everything".
        truncated: result.truncated,
        mutated: catalogChanged
          ? registered.filter((t) => t.kind === 'native').map((t) => ({ schema: t.schema, table: t.name }))
          : null,
      };
    } catch (error) {
      return { success: false, message: error.message, rows: [], columns: [] };
    }
  }),

  // The instance is shared and owned by public/duckdb; nothing per-connection
  // to tear down.
  closeConnection: async () => {},

  configSchema: {
    fields: [
      {
        name: 'dbPath',
        type: 'string',
        label: 'File',
        placeholder: '/path/to/data.csv',
        required: true,
        sensitive: false,
      },
    ],
  },

  // A dotted name given as one string ("main.orders") is a schema-qualified
  // table name, so each part is quoted separately. Quoting it whole would name
  // one table with a dot in it, which never matches the unquoted form the
  // insert path builds — the same rule the PostgreSQL connector follows, which
  // is the dialect DuckDB tracks.
  quoteIdentifier: (identifier, schema = null) => {
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

    if (schema) return `${duck.quoteIdentifier(schema)}.${duck.quoteIdentifier(identifier)}`;
    if (typeof identifier === 'string' && identifier.includes('.')) {
      return identifier.split('.').map((part) => duck.quoteIdentifier(part)).join('.');
    }
    return duck.quoteIdentifier(identifier);
  },

  getPreviewQuery: (tableName, limit = 100) => `SELECT * FROM ${tableName} LIMIT ${limit}`,

  /**
   * Data Explorer dialect. Keyword and function lists are unioned with the
   * shared ANSI baseline in public/database/dialect.js, so only what is
   * distinctly DuckDB belongs here.
   *
   * `sqlDialect` is PostgreSQL because node-sql-parser has no DuckDB grammar
   * (see public/database/validate.js) and DuckDB's syntax is closest to it.
   */
  explorer: {
    language: 'sql',
    sqlDialect: 'PostgreSQL',
    formatter: 'postgresql',
    // runQuery honours { maxRows } by streaming the result and stopping, so
    // the Data Explorer never has to pull a whole file into memory to show the
    // first page of it. The statement itself is passed through untouched.
    maxRowsOption: true,
    // Every local file shares one DuckDB instance, so opening one is really
    // opening all of them: the explorer sends the others as `config.siblings`,
    // each becomes its own schema, and a worksheet can join across files.
    siblingConnections: true,
    container: 'Database',
    objectLabel: 'Table',
    quote: '"',
    keywords: [
      'QUALIFY', 'EXCLUDE', 'REPLACE', 'PIVOT', 'UNPIVOT', 'ASOF', 'POSITIONAL',
      'SUMMARIZE', 'DESCRIBE', 'SAMPLE', 'USING SAMPLE', 'ATTACH', 'DETACH',
      'COPY', 'MACRO', 'STRUCT', 'LIST', 'MAP', 'UNION BY NAME',
    ],
    functions: [
      'READ_CSV_AUTO', 'READ_JSON_AUTO', 'READ_PARQUET', 'GLOB', 'RANGE',
      'LIST_VALUE', 'STRUCT_PACK', 'UNNEST', 'STRING_SPLIT', 'REGEXP_MATCHES',
      'STRFTIME', 'STRPTIME', 'DATE_TRUNC', 'DATE_DIFF', 'EPOCH',
      'ARRAY_AGG', 'STRING_AGG', 'QUANTILE', 'MEDIAN', 'MODE', 'HISTOGRAM',
      'TO_JSON', 'FROM_JSON', 'JSON_EXTRACT', 'JSON_EXTRACT_STRING',
    ],
  },
};
