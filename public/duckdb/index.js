/**
 * DuckDB — the query engine for local files.
 *
 * Local files are no longer imported into another store before they can be used.
 * They stay where the user put them and are queried in place: a CSV, JSON,
 * Parquet, Excel or Avro file is addressed by path and read straight off disk,
 * so opening a 5 GB file costs the same as opening a 5 MB one.
 *
 * Excel and Avro were once converted to Parquet at add time. They no longer
 * are: DuckDB's `excel` and `avro` extensions ship with the app (see
 * ./extensions), so a workbook is read where it lies — one table per sheet —
 * and an edit to it is written back into the workbook itself.
 *
 * The instance itself is in-memory: source files are read where they lie, so
 * there is nothing to persist at this level.
 *
 * Node outputs (transformer / join / API results) DO persist — as tables in
 * their workflow's own database, `workflow-data/<workflowId>.duckdb`, attached
 * to this same connection. One database per workflow means two workflows
 * running at once never touch the same file, and a node's result supports
 * ALTER / UPDATE / DELETE like any other table. See the "Workflow databases"
 * section below.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { EXTENSION_FOR_FORMAT, ensureExtension, resetExtensions } = require('./extensions');
const { throwIfCancelled } = require('../NodeExecution/executionCancel');
const xlsxFile = require('./xlsx');
const readOptions = require('./readOptions');

// Formats DuckDB reads. csv / json / parquet are built in; xlsx and avro need
// an extension, which ships with the app and is loaded on first use — see
// ./extensions. Nothing is converted on the way in any more: every one of these
// is read, and written, where the user put it.
const FORMAT_BY_EXT = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
  '.json': 'json',
  '.ndjson': 'json',
  '.jsonl': 'json',
  '.parquet': 'parquet',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.avro': 'avro',
};

// DuckDB type names that should render and aggregate as numbers.
const NUMERIC_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL)/i;

// Integer types come back from getRowObjectsJson as strings so nothing is lost
// on the way out of C++. Anything that fits a JS number is converted back, so
// the UI and downstream JS see 42 rather than "42"; genuinely huge ids stay
// strings rather than silently losing their last digits.
const INTEGER_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)/i;

let instancePromise = null;
let connectionPromise = null;

/**
 * Bumped whenever the instance is thrown away and rebuilt.
 *
 * Everything catalog-level goes with the old instance — attachments, and the
 * views connectors register over files — so anything that remembers "I already
 * registered that" has to forget it. Callers hold this alongside their own
 * cache key rather than being notified: a stale epoch simply misses, and the
 * work is done again.
 */
let sessionGeneration = 0;
const sessionEpoch = () => sessionGeneration;

/**
 * The shared instance. Held separately from the connection because a streaming
 * read needs a connection of its OWN (see streamRows) while everything else
 * keeps using the shared one — and both must be looking at the same catalog,
 * or the aliases attachDb hands out would name nothing.
 *
 * ATTACH and CREATE VIEW here are catalog-level, not connection-local, so a
 * second connection on this instance sees every attached database and every
 * registered source without repeating the work.
 */
async function getInstance() {
  if (!instancePromise) {
    instancePromise = (async () => {
      const { DuckDBInstance } = require('@duckdb/node-api');
      return DuckDBInstance.create(':memory:');
    })().catch((err) => {
      instancePromise = null; // let a later call retry
      throw err;
    });
  }
  return instancePromise;
}

/**
 * The shared connection. Created on first use — an Electron main process that
 * never touches a local file never pays for loading the native binding.
 */
async function getConnection() {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const instance = await getInstance();
      return instance.connect();
    })().catch((err) => {
      connectionPromise = null; // let a later call retry
      throw err;
    });
  }
  return connectionPromise;
}

/**
 * Errors that leave the DATABASE unusable rather than just the statement.
 *
 * DuckDB answers an internal error by invalidating the whole instance: every
 * call after one gets "database has been invalidated … must be restarted",
 * forever, because the instance here is a process-wide singleton. Since these
 * come from statements a user is entitled to write — `ALTER TABLE t ADD COLUMN
 * c STRUCT(…) DEFAULT {…}` is one, on any table past a single vector of rows —
 * a session that cannot recover from one means the Data Explorer stays broken
 * until the app is restarted.
 *
 * Recognised by what DuckDB calls itself. The two are one condition: the
 * INTERNAL error is the statement that poisons the instance, the FATAL error is
 * every statement after it.
 */
const isFatalError = (err) => /^(INTERNAL|FATAL) Error/.test(String(err && err.message));

/**
 * Drop the poisoned instance so the NEXT call builds a fresh one.
 *
 * Everything the old instance held goes with it — attachments, the views the
 * connectors register over files, anything created in the session — so the
 * attachment cache is cleared too, or a re-attach would be skipped as already
 * done. The connectors re-register on their next query (their views are
 * CREATE OR REPLACE and their attach is cached here), so recovery costs the
 * session its temporary tables and nothing else.
 *
 * The statement that hit the error still fails. Only the ones after it are
 * saved.
 */
function resetConnection() {
  // Before anything else: whatever a connector remembers about this session's
  // catalog stops being true the moment the instance goes.
  sessionGeneration += 1;
  connectionPromise = null;
  // The INSTANCE is what DuckDB invalidates, so it has to go too. It used to be
  // created inline inside getConnection, which made dropping the connection
  // enough; now that streamRows shares it, dropping only the connection would
  // rebuild a connection onto the same poisoned instance.
  instancePromise = null;
  attached.clear();
  attachedPaths.clear();
  // Extensions are loaded into an INSTANCE, so the new one starts without them.
  // Leaving the cache populated would have the next xlsx read skip the LOAD it
  // now needs and fail on an unknown function instead.
  resetExtensions();
}

/**
 * Run something against the shared connection, watching for the kind of failure
 * that takes the connection with it.
 */
async function withConnection(fn) {
  return holdDatabases(async () => {
    const connection = await getConnection();
    try {
      return await fn(connection);
    } catch (err) {
      if (isFatalError(err)) resetConnection();
      throw err;
    }
  });
}

/** Escape a value for inclusion as a SQL string literal. */
const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Escape an identifier for inclusion in SQL. */
const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Format for a path, from its extension. Null when DuckDB can't read it. */
const detectFormat = (filePath) => FORMAT_BY_EXT[path.extname(String(filePath)).toLowerCase()] || null;

const isReadable = (filePath) => detectFormat(filePath) !== null;

/**
 * Is this path a DATABASE to attach, rather than a data file to read in place?
 *
 * The DuckDB connector draws the same line (its `isDatabase`), and the two must
 * agree — a local source that the connector attaches but a workflow reader
 * treats as a CSV fails with "no such format" on a file that browses fine.
 * SQLite counts: DuckDB's sqlite extension makes a .sqlite/.db behave exactly
 * like a .duckdb once attached.
 */
const isDatabaseFile = (filePath) => /\.(duckdb|sqlite|sqlite3|db)$/i.test(String(filePath || ''));

/**
 * The FROM expression for a file — this is what makes a path behave like a
 * table. `union_by_name` keeps JSON files with varying keys readable.
 *
 * A workbook holds several tables in one file, so `sheet` picks which. Omitted,
 * DuckDB reads the first one. `header = true` is not optional: without it the
 * header row comes back AS DATA and the columns are named `A1`, `B1`, …
 *
 * Building the expression is all this does. For xlsx and avro the extension
 * behind it still has to be loaded, which is why `tableRef` is what call sites
 * should reach for.
 */
function sourceRef(filePath, format = null, { sheet = null, allVarchar = false } = {}) {
  const resolved = format || detectFormat(filePath);
  const literal = quoteLiteral(filePath);
  switch (resolved) {
    case 'csv': {
      // A header below line 1 (a banner line above it): skip what precedes it.
      const headerRow = readOptions.headerRowFor(filePath, null);
      return headerRow > 1
        ? `read_csv_auto(${literal}, skip = ${headerRow - 1})`
        : `read_csv_auto(${literal})`;
    }
    case 'json':
      // `sample_size = -1` infers from the WHOLE file: correct whatever the
      // data does, and the fallback `jsonRef` drops to when it cannot pin a
      // schema of its own. It is NOT what the explorer registers a view with —
      // see the note above jsonRef for why full inference is the wrong price to
      // pay for a name in the sidebar.
      return `read_json_auto(${literal}, union_by_name = true, sample_size = -1)`;
    case 'parquet':
      return `read_parquet(${literal})`;
    case 'xlsx': {
      // A header below row 1 (a title above it): read from the header row to
      // the sheet's last used cell. Read from A1 instead, DuckDB takes the
      // title as the header and stops at the first empty header cell, so the
      // other columns are silently lost — see readOptions.js.
      const headerRow = readOptions.headerRowFor(filePath, sheet);
      const used = headerRow > 1 ? xlsxFile.usedRange(filePath, sheet) : null;
      const range = used && used.endRow >= headerRow
        ? `, range = ${quoteLiteral(`${used.startCol}${headerRow}:${used.endCol}${used.endRow}`)}`
        : '';
      return `read_xlsx(${literal}${sheet ? `, sheet = ${quoteLiteral(sheet)}` : ''}, header = true${range}`
        + `${allVarchar ? ', all_varchar = true' : ''})`;
    }
    case 'avro':
      return `read_avro(${literal})`;
    default:
      throw new Error(
        `DuckDB cannot read "${path.basename(String(filePath))}" — supported formats are `
        + 'csv, json, parquet, xlsx and avro',
      );
  }
}

// ── workbook type repair ───────────────────────────────────────────────────
//
// read_xlsx infers each column's type from a sample of leading rows. A column
// that is empty for the first several hundred rows gets typed from nothing —
// DOUBLE, in practice — and the first real value then fails the read OUTRIGHT:
// `Failed to parse cell 'K1500'`. One stray cell makes the whole sheet
// unreadable, and no projection avoids it: selecting only the other columns
// fails exactly the same way.
//
// The reader takes no per-column type override, and its two escape hatches are
// each wrong on their own:
//
//   ignore_errors = true  keeps the sniffed type and NULLS everything that
//     disagrees with it, so the mistyped column comes back empty. Measured on
//     a real 200k-row sheet: 133 notes in, 0 out. Silent, total loss.
//
//   all_varchar = true    reads every column as text, which costs the sheet's
//     other types — and dates arrive as raw Excel serials ("46055"), which is
//     worse than useless to something expecting a date.
//
// So the repair is: read as text, then put back the type the sniffer asked for,
// but only on the columns where every value actually supports it. A column that
// disagrees stays text and keeps its contents — nothing is dropped, and nothing
// is mistyped. The check costs ONE pass, and only for a sheet the plain read
// cannot handle; a sheet that reads cleanly keeps using the native reader.

// Excel keeps dates and times as days since this epoch. (Workbooks written in
// the old Mac "1904 date system" count from 1904-01-01 instead; the flag lives
// in workbook.xml and is not worth a full parse to recover, so those dates land
// four years early on the rare file that is both 1904-based AND mistyped.)
const EXCEL_EPOCH = "DATE '1899-12-30'";

const isVarcharType = (type) => /^VARCHAR/i.test(String(type));
const isTemporalType = (type) => /^(DATE|TIMESTAMP|TIME)/i.test(String(type));

/** Put a column back into the type the sniffer reported, from its text form. */
function repairedColumn(name, type) {
  const col = quoteIdentifier(name);
  if (/^DATE$/i.test(type)) return `(${EXCEL_EPOCH} + CAST(${col} AS INTEGER))`;
  if (isTemporalType(type)) {
    // A fractional serial is the time of day, so the whole number is carried
    // through seconds rather than truncated to a day.
    return `(${EXCEL_EPOCH}::TIMESTAMP + INTERVAL 1 SECOND * (CAST(${col} AS DOUBLE) * 86400))`;
  }
  return `CAST(${col} AS ${type})`;
}

/** Counts the values in one column that do NOT support its sniffed type. */
function disagreeingValues(name, type) {
  const col = quoteIdentifier(name);
  // A temporal column is stored as a NUMBER, so "does this hold a date?" is
  // really "is this numeric?" — casting the text "46055" to DATE would fail on
  // a column that is in fact perfectly good.
  const target = isTemporalType(type) ? 'DOUBLE' : type;
  return `count(*) FILTER (WHERE ${col} IS NOT NULL AND TRY_CAST(${col} AS ${target}) IS NULL)`;
}

// path@mtime#sheet → promise of the FROM expression to use for it.
const xlsxRefCache = new Map();

/**
 * The FROM expression for one sheet: the native read where that works, and a
 * repaired one where it does not.
 *
 * Cached per file version and sheet, because the connector re-registers its
 * views on every query and the verifying pass must not be paid again.
 */
function xlsxRef(filePath, sheet) {
  const key = `${cacheKeyFor(filePath)}#${sheet || ''}`;
  if (!xlsxRefCache.has(key)) {
    const pending = (async () => {
      const native = sourceRef(filePath, 'xlsx', { sheet });

      // The sniffer's own answer. LIMIT 0 reads no rows, so this succeeds even
      // on a sheet whose data cannot be read — which is what makes it usable
      // as the starting point for repairing that sheet.
      const columns = await describe(native);
      const claimed = columns.filter((c) => !isVarcharType(c.type));
      if (claimed.length === 0) return native;

      const asText = sourceRef(filePath, 'xlsx', { sheet, allVarchar: true });
      const probes = claimed.map((c, i) => `${disagreeingValues(c.name, c.type)} AS c${i}`);
      const { rows } = await query(`SELECT ${probes.join(', ')} FROM ${asText}`);

      const disagrees = new Set(
        claimed.filter((c, i) => Number(rows[0][`c${i}`] || 0) > 0).map((c) => c.name),
      );
      // Every column holds what it claims, so the native reader would have
      // managed. Prefer it — it is the engine's own conversion, not ours.
      if (disagrees.size === 0) return native;

      const projection = columns.map((c) => {
        const col = quoteIdentifier(c.name);
        if (disagrees.has(c.name) || isVarcharType(c.type)) return col;
        return `${repairedColumn(c.name, c.type)} AS ${col}`;
      });
      console.warn(
        `[duckdb] ${path.basename(filePath)}${sheet ? ` (${sheet})` : ''}: `
        + `read as text for ${[...disagrees].join(', ')} — the values there do not match the `
        + 'type Excel implies, and would otherwise fail the read',
      );
      return `(SELECT ${projection.join(', ')} FROM ${asText})`;
    })().catch((err) => {
      xlsxRefCache.delete(key); // let a later call retry
      throw err;
    });
    xlsxRefCache.set(key, pending);
  }
  return xlsxRefCache.get(key);
}

/**
 * The sheet a table name means, for a file whose tables are sheets.
 *
 * A workbook's tables are registered under their sheet names, unchanged — so
 * for a caller that already knows which table it wants, the sheet is that name.
 * Every other format has one table per file and gets null, which reads the file
 * whole. This is what lets a call site that only ever had a path and a table
 * name address the right sheet without carrying a new field.
 */
const sheetFor = (filePath, tableName) => (
  tableName && xlsxFile.isWorkbook(filePath) ? tableName : null
);

/** Load the extension a format needs, if it needs one. */
async function ensureFormatSupport(format) {
  const extension = EXTENSION_FOR_FORMAT[format];
  if (extension) await ensureExtension(extension, { exec, query });
}

// A CSV column whose values overflow BIGINT is sniffed as DOUBLE, which
// silently rounds it — 12345678901234567890 comes back as ...567000. Order
// numbers and external ids land in exactly that range, so those columns are
// forced to VARCHAR instead. 16+ digits is the threshold: 2^63 is 19 digits,
// and a JS double is only exact to 15.
const PRECISION_LOSING_INTEGER = /^[+-]?[0-9]{16,}$/;
const TYPE_OVERRIDE_SAMPLE = 1000;

// Keyed by `path@mtime` so an edited file is re-inspected but a stable one is
// inspected once per session.
const typeOverrideCache = new Map();

const cacheKeyFor = (filePath) => {
  try { return `${filePath}@${fs.statSync(filePath).mtimeMs}`; } catch { return filePath; }
};

/**
 * Columns that must be read as text to survive intact. Sampled — a value that
 * only appears far into a huge file can still be missed, exactly as DuckDB's
 * own sniffer can miss it.
 */
async function csvTypeOverrides(filePath) {
  const key = cacheKeyFor(filePath);
  if (typeOverrideCache.has(key)) return typeOverrideCache.get(key);

  let overrides = [];
  try {
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT * FROM read_csv(${quoteLiteral(filePath)}, all_varchar = true${readOptions.headerRowFor(filePath, null) > 1 ? `, skip = ${readOptions.headerRowFor(filePath, null) - 1}` : ''}) LIMIT ${TYPE_OVERRIDE_SAMPLE}`,
    );
    const rows = reader.getRowObjectsJson();
    overrides = reader.columnNames().filter((name) =>
      rows.some((row) => typeof row[name] === 'string' && PRECISION_LOSING_INTEGER.test(row[name])));
  } catch {
    // An unreadable file will fail again, with a better message, on the real
    // read — don't turn a sniffing problem into a different error here.
  }

  typeOverrideCache.set(key, overrides);
  return overrides;
}

// ── JSON schema pinning ────────────────────────────────────────────────────
//
// Reading JSON means inferring its schema, and DuckDB re-infers on every BIND —
// not just on every read. A view over a JSON file is stored as its SQL text and
// re-bound each time it is used, so `CREATE OR REPLACE VIEW`, `SELECT … LIMIT 0`
// and every query behind them each pay inference again. With
// `sample_size = -1` that is a full parse of the file: measured at 2,784 ms for
// a 442 MB file, EVERY time, and the Data Explorer re-registers its views on
// the schema tree, on each column load and on each run.
//
// So the schema is worked out once and then PINNED into the read as an explicit
// `columns = {…}`, which takes binding to ~1 ms. What it costs to work out is
// the whole design:
//
//   sampled types      78 ms   what the first JSON_SAMPLE_RECORDS records say
//   empty-column probe 80 ms   which of those held no value at all
//   full key set      263 ms   every key in the file, via read_json_objects
//                              (raw JSON per record — no type inference)
//
// ~420 ms once per file version, against 2,784 ms per bind.
//
// A sample alone would be wrong in exactly the way full inference was chosen to
// avoid, and in one more way besides:
//
//   a column that is null through the whole sample has no type to read off it.
//     Sampling reports VARCHAR here, but only as its own fallback — so the rule
//     is made explicit rather than borrowed: no non-null value in the sample
//     means VARCHAR, which is unbounded in DuckDB and so holds any value the
//     rest of the file turns out to have. Nothing is assumed to be empty just
//     because the first records are.
//
//   a key that first appears PAST the sample is missing from the schema
//     entirely, and its column would be dropped with no error. This is what the
//     key-set scan is for: read_json_objects hands back each record as raw JSON
//     without typing it, so `json_keys` over the whole file names every column
//     for a fraction of what typing them costs. Keys found only there are
//     VARCHAR for the same reason as above.
//
// Pinning also fixes a defect that plain sampling has on its own: a column the
// sniffer typed from nothing comes back holding RAW JSON — the string
// `value 260000` arrives as `"value 260000"`, quotes included. Pinned as
// VARCHAR it is parsed properly.
//
// The residual limit, and it is a real one: `json_keys` reads TOP-LEVEL keys, so
// a field that first appears past the sample INSIDE a struct is still dropped.
// Full inference caught that. A file that needs it can still be read correctly —
// jsonRef falls back to `sourceRef`, which is full inference — but nothing
// detects the case automatically.

// Records the type sample reads. DuckDB's own default is ~20k; this is higher
// because the cost is per record read, not per byte of file, and a wider sample
// leaves less for the key-set scan to have to repair.
const JSON_SAMPLE_RECORDS = 50000;

/** Types the sniffer reports when it had no value to go on. */
const isUninformativeType = (type) => /^(JSON|NULL|SQLNULL)$/i.test(String(type || '').trim());

// path@mtime → promise of the FROM expression to use for it.
const jsonRefCache = new Map();

/**
 * `[{ name, type }]` to pin a JSON file's columns to, or null when the file is
 * not records-with-keys and there is nothing to pin.
 */
async function jsonColumnSpec(filePath) {
  const literal = quoteLiteral(filePath);
  const sampled = `read_json_auto(${literal}, union_by_name = true, `
    + `sample_size = ${JSON_SAMPLE_RECORDS})`;

  const columns = await describe(sampled);
  if (!columns.length) return null;

  // Which sampled columns carried no value at all? Counted over the same
  // records the types came from — a column that is empty there is a column the
  // sample cannot speak for.
  const probes = columns.map((c, i) => `count(${quoteIdentifier(c.name)}) AS c${i}`);
  const { rows } = await query(
    `SELECT ${probes.join(', ')} FROM `
    + `(SELECT * FROM ${sampled} LIMIT ${JSON_SAMPLE_RECORDS})`,
  );
  const empty = new Set(
    columns.filter((c, i) => Number(rows[0][`c${i}`] || 0) === 0).map((c) => c.name),
  );

  // Every top-level key in the file, typed by nobody.
  const { rows: keyRows } = await query(
    `SELECT DISTINCT unnest(json_keys(json)) AS k `
    + `FROM read_json_objects(${literal}, format = 'auto')`,
  );
  const keys = keyRows.map((r) => r.k).filter((k) => typeof k === 'string' && k.length);
  // No keys means the records are not objects — an array of scalars, say. There
  // are no columns to pin, so the caller falls back.
  if (!keys.length) return null;

  const spec = columns.map((c) => ({
    name: c.name,
    type: (empty.has(c.name) || isUninformativeType(c.type)) ? 'VARCHAR' : c.type,
  }));

  // Keys the sample never saw, appended in the order the scan found them so the
  // columns a user already knows keep their positions.
  const sampledNames = new Set(spec.map((c) => c.name));
  for (const key of keys) {
    if (!sampledNames.has(key)) spec.push({ name: key, type: 'VARCHAR' });
  }
  return spec;
}

/**
 * The FROM expression for a JSON file, with its schema pinned so that binding
 * it is free. Cached per file version; falls back to full inference if the
 * schema cannot be worked out, so the worst case is today's behaviour.
 */
function jsonRef(filePath) {
  const key = cacheKeyFor(filePath);
  if (!jsonRefCache.has(key)) {
    const pending = (async () => {
      const spec = await jsonColumnSpec(filePath);
      if (!spec || !spec.length) return sourceRef(filePath, 'json');

      const columns = spec
        .map((c) => `${quoteLiteral(c.name)}: ${quoteLiteral(c.type)}`)
        .join(', ');
      return `read_json(${quoteLiteral(filePath)}, format = 'auto', columns = {${columns}})`;
    })().catch((err) => {
      // Inference is an optimisation, never a reason to fail a read. Drop the
      // entry so a later call can try again, and hand back the expression that
      // needs no inference of ours.
      jsonRefCache.delete(key);
      console.warn(
        `[duckdb] ${path.basename(filePath)}: could not pin a JSON schema `
        + `(${err.message}) — falling back to full inference`,
      );
      return sourceRef(filePath, 'json');
    });
    jsonRefCache.set(key, pending);
  }
  return jsonRefCache.get(key);
}

/**
 * The FROM expression to use for a file, with type corrections applied.
 *
 * Prefer this over `sourceRef` wherever the call site can await — it is what
 * keeps long numeric ids intact. `sourceRef` remains the raw primitive.
 */
async function tableRef(filePath, format = null, { sheet = null } = {}) {
  const resolved = format || detectFormat(filePath);
  if (resolved !== 'csv') {
    await ensureFormatSupport(resolved);
    // A workbook's columns are typed by a sniffer that only sees the first
    // rows, so the expression it takes to read one is worked out per sheet.
    if (resolved === 'xlsx') return xlsxRef(filePath, sheet);
    // JSON's schema is inferred on every bind unless it is pinned; see above.
    if (resolved === 'json') return jsonRef(filePath);
    return sourceRef(filePath, resolved, { sheet });
  }

  const overrides = await csvTypeOverrides(filePath);
  if (overrides.length === 0) return sourceRef(filePath, resolved);

  const types = overrides.map((name) => `${quoteLiteral(name)}: 'VARCHAR'`).join(', ');
  // The same header-row setting sourceRef applies — this path builds its own
  // read_csv and would otherwise read the banner line as the header.
  const headerRow = readOptions.headerRowFor(filePath, null);
  const skip = headerRow > 1 ? `, skip = ${headerRow - 1}` : '';
  return `read_csv(${quoteLiteral(filePath)}, auto_detect = true${skip}, types = {${types}})`;
}

/** Column descriptors in the shape the Data Explorer and previews expect. */
const describeColumns = (reader) => {
  const names = reader.deduplicatedColumnNames
    ? reader.deduplicatedColumnNames()
    : reader.columnNames();
  const types = reader.columnTypes().map((t) => String(t));
  return names.map((name, i) => ({
    name,
    type: types[i],
    numeric: NUMERIC_TYPES.test(types[i]),
    nullable: true,
    isPrimary: false,
  }));
};

const isIntegerType = (type) => INTEGER_TYPES.test(String(type));

/**
 * Does this type hold a string-encoded integer anywhere inside it?
 *
 * Answered once per column so a result with nothing to convert — the common
 * case — is handed back untouched rather than rebuilt row by row.
 */
function containsIntegerType(type) {
  if (!type) return false;
  if (Array.isArray(type.entryTypes)) return type.entryTypes.some(containsIntegerType);
  if (type.keyType || type.valueType) {
    return containsIntegerType(type.keyType) || containsIntegerType(type.valueType);
  }
  return isIntegerType(type);
}

/**
 * Undo the string-encoding of one value, following its TYPE.
 *
 * The type is what decides, never the value: a string is the encoding for a
 * large integer AND for an ordinary VARCHAR, so reading the value alone would
 * turn a zip code of "007" into 7. Walking the declared type means only columns
 * that really are integers are touched.
 *
 * STRUCT, LIST, ARRAY and MAP carry their children on the type object
 * (`entryTypes`, `valueType`, `keyType`), so nesting is followed to any depth.
 */
function coerceValue(value, type) {
  if (value === null || value === undefined || !type) return value;

  // STRUCT — children addressed by name.
  if (Array.isArray(type.entryNames) && Array.isArray(type.entryTypes)) {
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    const out = {};
    for (const key of Object.keys(value)) {
      const at = type.entryNames.indexOf(key);
      out[key] = at === -1 ? value[key] : coerceValue(value[key], type.entryTypes[at]);
    }
    return out;
  }

  // MAP — arrives as a list of { key, value } entries, and either side can be
  // an integer.
  if (type.keyType && type.valueType) {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...entry, key: coerceValue(entry.key, type.keyType), value: coerceValue(entry.value, type.valueType) }
      : entry));
  }

  // LIST / ARRAY — one child type for every element.
  if (type.valueType) {
    return Array.isArray(value) ? value.map((item) => coerceValue(item, type.valueType)) : value;
  }

  if (typeof value !== 'string' || value === '' || !isIntegerType(type)) return value;
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : value;
}

/**
 * Undo the string-encoding of integers, at every depth.
 *
 * getRowObjectsJson emits the types a JS number cannot hold exactly — BIGINT,
 * HUGEINT, UBIGINT and DECIMAL — as strings, so nothing is lost coming out of
 * C++. Anything that fits a JS number safely is converted back, and genuinely
 * huge ids stay strings rather than losing their last digits. DECIMAL keeps its
 * string: exactness a double cannot represent is the whole reason to use one.
 *
 * This used to look only at top-level columns, which left a BIGINT inside a
 * STRUCT, LIST or MAP quoted — `{"qty": "1"}` in a preview, and in the sample
 * rows handed to the model, which reads as a text column that needs casting.
 */
function coerceRows(rows, reader) {
  const names = reader.deduplicatedColumnNames
    ? reader.deduplicatedColumnNames()
    : reader.columnNames();
  const types = reader.columnTypes();

  const affected = names
    .map((name, i) => [name, types[i]])
    .filter(([, type]) => containsIntegerType(type));
  if (affected.length === 0) return rows;

  return rows.map((row) => {
    const out = { ...row };
    for (const [name, type] of affected) out[name] = coerceValue(out[name], type);
    return out;
  });
}

/**
 * Run a statement and read the whole result.
 * @returns {Promise<{ rows: object[], columns: object[], rowCount: number, ms: number }>}
 */
async function query(sql, { params = null } = {}) {
  return withConnection(async (connection) => {
    const started = Date.now();
    const reader = params && params.length
      ? await connection.runAndReadAll(sql, params)
      : await connection.runAndReadAll(sql);
    const columns = describeColumns(reader);
    const rows = coerceRows(reader.getRowObjectsJson(), reader);
    return { rows, columns, rowCount: rows.length, ms: Date.now() - started };
  });
}

/**
 * Run a statement and read AT MOST `maxRows` rows, streaming.
 *
 * DuckDB produces the result in chunks (~2048 rows) and only computes the next
 * one when asked, so a `SELECT *` over a hundred-million-row file costs one
 * chunk here rather than the whole table in this process's heap. The user's SQL
 * is passed through untouched — no injected LIMIT, no wrapping subquery, which
 * would break statements DuckDB accepts but a rewrite wouldn't survive.
 *
 * Because rows arrive a chunk at a time the reader usually overshoots the
 * target; the caller gets the exact cap it asked for and `truncated` tells it
 * whether more was waiting.
 *
 * @returns {Promise<{rows, columns, rowCount, ms, truncated: boolean}>}
 */
async function queryUpTo(sql, maxRows, { params = null } = {}) {
  return withConnection(async (connection) => {
    const started = Date.now();
    const cap = Math.max(1, Number(maxRows) || 1);

    const reader = params && params.length
      ? await connection.streamAndRead(sql, params)
      : await connection.streamAndRead(sql);

    // One past the cap, so "is there more?" is observed rather than assumed.
    await reader.readUntil(cap + 1);

    const columns = describeColumns(reader);
    const all = coerceRows(reader.getRowObjectsJson(), reader);
    const rows = all.slice(0, cap);

    return {
      rows,
      columns,
      rowCount: rows.length,
      ms: Date.now() - started,
      // More rows exist if we saw past the cap, or if the stream isn't drained.
      truncated: all.length > cap || !reader.done,
    };
  });
}

/**
 * Run a statement and yield its rows a chunk at a time, for as long as there
 * are rows. No cap, and never more than one chunk in this process's heap.
 *
 * This is what `query` and `queryUpTo` cannot do: `query` materialises the
 * whole result, and `queryUpTo` stops at a number. Reading a ten-million-row
 * table to load it somewhere else needs neither — it needs every row, and it
 * needs them a handful at a time.
 *
 * DuckDB hands back ~2048-row chunks and computes the next only when asked, so
 * the peak here is one chunk regardless of the table's size.
 *
 * ON ITS OWN CONNECTION, deliberately. A streaming result stays open across
 * every await the consumer makes — for a load that is minutes, while rows are
 * written to some remote database — and any other statement issued on the same
 * connection in that window would be interleaved with a read in flight. The
 * shared connection is used by every other caller in this module, so a stream
 * that borrowed it would make an unrelated node's query the thing that breaks
 * this one. Connections are cheap; the catalog is shared at the instance.
 *
 * @param {string} sql
 * @yields {object[]} One chunk of coerced row objects.
 */
async function* streamRows(sql, { params = null } = {}) {
  // Held for the whole stream, not per chunk: the consumer's awaits between
  // chunks are idle time to everything else here, and a database released in
  // one of them would end the read mid-table.
  busy += 1;
  try {
    yield* streamRowsHeld(sql, { params });
  } finally {
    letGo();
  }
}

async function* streamRowsHeld(sql, { params = null } = {}) {
  const instance = await getInstance();

  // The search path is SESSION state, and the callers of this function depend
  // on it. Views are registered by bare name (registerAddressableViews, and
  // the DuckDB connector's ensureViews) into whatever schema the SHARED
  // connection currently points at, and the SQL then refers to them unqualified.
  // A fresh connection starts at `main`, so without copying this across, a
  // statement that resolves perfectly on the shared connection would fail here
  // with "table does not exist" — for the join and transformer readers in
  // particular, whose sources are exactly those bare-named views.
  //
  // Read before connecting so a failure to read it cannot leak the connection.
  let searchPath = null;
  try {
    const { rows } = await query(`SELECT current_setting('search_path') AS p`);
    searchPath = rows[0]?.p || null;
  } catch (_) {
    // Older builds may not expose it; `main` is then the right default anyway.
  }

  const connection = await instance.connect();
  try {
    if (searchPath) {
      await connection.run(`SET search_path = ${quoteLiteral(searchPath)}`);
    }

    const result = params && params.length
      ? await connection.stream(sql, params)
      : await connection.stream(sql);

    // `result` answers the same column questions a reader does, which is what
    // lets coerceRows run per chunk — big integers keep the same treatment
    // they get on the materialised path rather than silently differing.
    for await (const page of result.yieldRowObjectJson()) {
      if (page.length > 0) yield coerceRows(page, result);
    }
  } catch (err) {
    if (isFatalError(err)) resetConnection();
    throw err;
  } finally {
    // Runs on early exit too — a consumer that throws or stops reading (a
    // cancelled run) must not leave the connection open.
    try { connection.closeSync(); } catch (_) { /* already gone */ }
  }
}

/**
 * The `<alias>.<table>` expression for a table in a database addressed by PATH,
 * attaching the database if it is not attached yet.
 *
 * Works for any database DuckDB can ATTACH — .duckdb natively, .sqlite/.db
 * through the sqlite extension (ATTACH sniffs the file). Several readers build
 * exactly this ref; sharing it keeps the quoting and sanitising in one place.
 */
async function attachedTableRef(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  return `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
}

/**
 * Every row of a table in a database addressed by PATH, streamed.
 * The unbounded counterpart to readTableHeadAt.
 */
async function* streamTableRowsAt(dbPath, tableName) {
  const ref = await attachedTableRef(dbPath, tableName);
  yield* streamRows(`SELECT * FROM ${ref}`);
}

/**
 * Every row of a data FILE (csv/json/parquet/xlsx), streamed.
 * The unbounded counterpart to readHead.
 */
async function* streamFileRows(filePath, format = null, { sheet = null } = {}) {
  const ref = await tableRef(filePath, format, { sheet });
  yield* streamRows(`SELECT * FROM ${ref}`);
}

/**
 * Every row of a LOCAL SOURCE, whichever of the two kinds of path it is.
 *
 * The distinction is the same one the DuckDB connector makes, and it has to be
 * made the same way in both places or a local source reads correctly through
 * the Data Explorer and fails in a workflow:
 *
 *   a DATABASE — .duckdb, and .sqlite/.sqlite3/.db through DuckDB's sqlite
 *     extension — is ATTACHed, and its tables are real tables;
 *   a DATA FILE — csv/json/parquet/xlsx/avro — is read in place.
 *
 * `.db` is a database here because that is what the connector means by it.
 * Nothing else claims the extension any more, so it never has to
 * carry the decision on its own.
 */
async function* streamLocalRows(filePath, tableName, { format = null, sheet = null } = {}) {
  if (isDatabaseFile(filePath)) {
    yield* streamTableRowsAt(filePath, tableName);
    return;
  }
  yield* streamFileRows(filePath, format, { sheet });
}

/**
 * The columns streamLocalRows would yield for the same arguments, read without
 * reading a row: the same ref, `LIMIT 0`. An Output copies these types rather
 * than guessing them from values (see NodeExecution/columnTypes.js).
 *
 * @returns {Promise<{name: string, type: string}[]>}
 */
async function describeLocalSource(filePath, tableName, { format = null, sheet = null } = {}) {
  const ref = isDatabaseFile(filePath)
    ? await attachedTableRef(filePath, tableName)
    : await tableRef(filePath, format, { sheet });
  const { columns } = await query(`SELECT * FROM ${ref} LIMIT 0`);
  return columns;
}

/** Run a statement for its side effects. */
async function exec(sql) {
  await withConnection((connection) => connection.run(sql));
}

/** The trailing semicolon a worksheet leaves behind, dropped. */
const trimStatement = (sql) => String(sql || '').trim().replace(/;+\s*$/, '');

/**
 * How many statements DuckDB sees in this script.
 *
 * Not the same as how many the user typed, in BOTH directions. A worksheet may
 * hold several, and DuckDB expands some single statements into a transaction of
 * its own making: `ALTER TABLE t ADD COLUMN c … DEFAULT <expr>` becomes BEGIN,
 * the ADD COLUMN, an UPDATE that backfills the rows that already exist, a SET
 * DEFAULT, COMMIT — five — for every default but a bare literal. (`true` is a
 * cast to the parser, not a literal, so it expands too.)
 *
 * Extraction parses without binding: a syntax error throws here, an unknown
 * table does not.
 */
async function statementCount(sql) {
  return withConnection(async (connection) => {
    const extracted = await connection.extractStatements(trimStatement(sql));
    return Number(extracted.count) || 0;
  });
}

/**
 * What KIND of statement number `index` is, straight from DuckDB: `SELECT`,
 * `UPDATE`, `INSERT`, `DELETE`, `ALTER`, `COPY`, `MERGE_INTO`, `TRANSACTION`, …
 *
 * This is how a caller asks the ENGINE what a statement is instead of reading
 * its text: `WITH x AS (…) INSERT …` starts with a keyword that says SELECT,
 * and no amount of pattern matching gets that right. Preparing a statement
 * plans and binds it but runs NOTHING, so asking is free of side effects.
 *
 * Because it binds, a statement that cannot run as written throws HERE, before
 * anything has been read or copied. Callers use that: the throw is the answer.
 * In particular DuckDB refuses to bind a write against a view, which is how the
 * connectors tell a write apart from a read over a file.
 *
 * One statement at a time, by index, because `prepare` takes exactly one and
 * refuses a script outright — which is what an expanded ALTER looks like to it.
 * A statement is re-extracted on every call: an extracted statement can only be
 * prepared ONCE, and the same index is asked about repeatedly while a caller
 * works out what a script touches.
 *
 * Binding a statement mid-script can fail for a reason that is not a fault —
 * the backfilling UPDATE above names a column the ADD COLUMN in front of it has
 * not created yet. So a throw means "not as the catalog stands right now",
 * which is only the whole answer for the statement a script starts with.
 *
 * @returns {Promise<string>} a StatementType name
 */
async function statementType(sql, index = 0) {
  return withConnection(async (connection) => {
    // Required here rather than at module load for the same reason the instance
    // is: a main process that never opens a local file never loads the binding.
    const { StatementType } = require('@duckdb/node-api');
    const extracted = await connection.extractStatements(trimStatement(sql));
    const prepared = await extracted.prepare(index);
    try {
      // The enum maps both ways, so a numeric type reads back as its name.
      return StatementType[prepared.statementType] || String(prepared.statementType);
    } finally {
      prepared.destroySync();
    }
  });
}

/**
 * Does DuckDB's PARSER see this as ONE SELECT-family query — the only thing
 * `CREATE OR REPLACE TABLE … AS <sql>` will take?
 *
 * The same "ask the engine, don't read the text" rule as statementType, for the
 * one caller that cannot use statementType: a workflow BUILD validating SQL it
 * is not yet able to run. statementType prepares, and preparing BINDS, so it
 * throws `Catalog Error: Table … does not exist` for a join whose source views
 * are only registered at execution time. json_serialize_sql parses and stops.
 *
 * It answers exactly the question asked: it refuses anything that is not a
 * single SELECT (INSERT, CREATE TABLE AS, a two-statement script) and accepts
 * every shape a SELECT comes in — a CTE, a parenthesised set operation, and
 * DuckDB's own FROM-first forms (`FROM t SELECT c`, bare `FROM t`), which a
 * leading-keyword test rejects as readily as it accepts `WITH x AS (…) INSERT`.
 *
 * @returns {Promise<{ok: boolean, message: string|null}|null>} null when the
 *   question could not be asked at all, which a caller must not read as "no".
 */
async function parsesAsSelectQuery(sql) {
  const text = trimStatement(sql);
  if (!text) return { ok: false, message: 'the statement is empty' };
  let parsed;
  try {
    const { rows } = await query(`SELECT json_serialize_sql(${quoteLiteral(text)}) AS j`);
    parsed = JSON.parse(rows[0]?.j || '{}');
  } catch (_err) {
    // The parser could not be reached at all. A caller cannot tell a bad
    // statement from an unanswered question, so say so rather than condemning
    // SQL that may be perfectly good.
    return null;
  }
  if (parsed.error) return { ok: false, message: parsed.error_message || null };
  return { ok: true, message: null };
}

/**
 * Run a script ONE STATEMENT AT A TIME, tolerating a statement that fails while
 * a later one still succeeds.
 *
 * `exec` hands the whole script to the driver, which stops at the first error
 * and reports it as the script's error. That is right for a script whose
 * statements are all load-bearing, and wrong for the shape an in-place
 * transform actually has: a structural change followed by the statement that
 * uses it. On the SECOND run the structural change is already applied — the
 * ALTER reports "column already exists" precisely because the first run
 * worked — and failing the whole script there makes every in-place ALTER a
 * one-shot node.
 *
 * So the LAST statement is the one that decides. Anything before it may fail
 * and be recorded instead: those statements exist to make the last one
 * possible, and the last one succeeding is proof enough that they did. A
 * one-statement script has nothing to fall back on and is simply run.
 *
 * Statements are separated by DuckDB's own extractor, never by splitting the
 * text on semicolons — a semicolon inside a string literal is not a boundary,
 * and the parser is the only thing that knows the difference. Each is prepared
 * only when its turn comes, so it binds against the catalog the statements in
 * front of it have already changed.
 *
 * @returns {Promise<{tolerated: string[]}>} the errors that were tolerated, in
 *   order. Empty means every statement ran.
 */
async function execScript(sql) {
  const trimmed = trimStatement(sql);
  const tolerated = [];
  await withConnection(async (connection) => {
    const extracted = await connection.extractStatements(trimmed);
    const count = Number(extracted.count) || 0;
    // Nothing to be tolerant WITH: one statement is the whole script, and an
    // empty extraction means there is nothing to run at all.
    if (count <= 1) {
      await connection.run(trimmed);
      return;
    }
    for (let index = 0; index < count; index += 1) {
      try {
        // Preparing binds, so a statement that cannot run as the catalog now
        // stands throws here rather than at run(); both are the same failure
        // from this loop's point of view.
        const prepared = await extracted.prepare(index);
        try {
          await prepared.run();
        } finally {
          prepared.destroySync();
        }
      } catch (err) {
        if (index === count - 1) throw err;
        tolerated.push(err.message);
      }
    }
  });
  return { tolerated };
}

/**
 * A cheap signature for a table: its column shape, its row count, and an
 * order-independent hash of its rows, as one string.
 *
 * Used to tell whether a statement actually changed a table, so only what
 * changed gets written back to disk. Two different signatures are proof of a
 * change; identical ones mean no change short of a hash collision, which at 64
 * bits is not a thing that happens by accident. Row ORDER is deliberately not
 * part of it — a rewrite that only reshuffles rows is not worth rewriting a
 * file for.
 *
 * The SHAPE — column names and types, in order — is part of it because DDL is a
 * change the rows do not show. `ADD COLUMN c INTEGER[]` fills every row with
 * NULL, and a NULL list contributes nothing to `hash(row)`: DuckDB hashes the
 * widened column to exactly what the row hashed to without it, so a
 * content-only signature calls the ALTER a no-op and the column is never
 * written to the file. RENAME COLUMN and a type change are invisible to row
 * content for the same reason — they do not touch a value. Reading the shape
 * costs no rows; `SELECT * … LIMIT 0` is answered from the catalog.
 *
 * Rows are summed rather than XORed. XOR is self-inverse, so identical rows
 * cancel in PAIRS: a table whose every distinct row appears an even number of
 * times hashes to 0 no matter what those rows hold, and an UPDATE across them
 * lands on 0 again. Summing has no such identity — duplicate rows accumulate
 * instead of erasing each other — and it stays order-independent, which is the
 * one property XOR was chosen for. The cast to HUGEINT is what keeps the sum
 * from overflowing a 64-bit accumulator.
 */
async function fingerprint(ref) {
  const { columns } = await query(`SELECT * FROM ${ref} LIMIT 0`);
  const shape = columns.map((c) => `${c.name}:${c.type}`).join(',');
  const { rows } = await query(
    `SELECT count(*) AS n, sum(hash(t)::HUGEINT) AS h FROM ${ref} t`,
  );
  const row = rows[0] || {};
  return `${shape}|${row.n ?? 0}:${row.h ?? 'empty'}`;
}

/**
 * Columns of a file (or of any FROM expression) without reading its rows.
 * DESCRIBE only touches enough of the file to infer the schema.
 */
async function describe(fromExpression) {
  const { columns } = await query(`SELECT * FROM ${fromExpression} LIMIT 0`);
  return columns;
}

/** First `limit` rows of a file, plus its columns. The preview primitive. */
async function readHead(filePath, limit = 1000, format = null, { sheet = null } = {}) {
  const ref = await tableRef(filePath, format, { sheet });
  return query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 1000}`);
}

/** Total rows in a file. Cheap for Parquet (metadata), a scan for CSV/JSON. */
async function countRows(filePath, format = null, { sheet = null } = {}) {
  const ref = await tableRef(filePath, format, { sheet });
  const { rows } = await query(`SELECT count(*) AS c FROM ${ref}`);
  return Number(rows[0]?.c ?? 0);
}

/**
 * Schema in the `{ tableName, columns, sampleData }` shape the node chats,
 * prompts and preview grid all already speak.
 */
async function fileSchema(filePath, { sampleLimit = 5, format = null, sheet = null } = {}) {
  const { rows, columns } = await readHead(filePath, sampleLimit, format, { sheet });
  const sampleData = rows.map((row) => {
    const trimmed = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      trimmed[key] = (typeof value === 'string' && value.length > 100)
        ? `${value.substring(0, 100)}...`
        : value;
    }
    return trimmed;
  });
  return {
    tableName: path.basename(filePath, path.extname(filePath)),
    columns: columns.map(({ name, type, nullable, isPrimary }) => ({ name, type, nullable, isPrimary })),
    sampleData,
  };
}

/** Make sure a node output's folder exists before writing into it. */
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** COPY options per format, so a file is rewritten in the format it already is. */
function copyOptionsFor(format, outPath, { sheet = null } = {}) {
  switch (format) {
    case 'csv': {
      // Keep the delimiter the file already uses; .tsv is still 'csv' to us.
      const delimiter = /\.tsv$/i.test(outPath) ? '\t' : ',';
      return `FORMAT CSV, HEADER, DELIMITER ${quoteLiteral(delimiter)}`;
    }
    case 'json':
      // A .json file is an array; .ndjson / .jsonl are one object per line.
      return /\.(ndjson|jsonl)$/i.test(outPath) ? 'FORMAT JSON' : 'FORMAT JSON, ARRAY true';
    case 'parquet':
      return 'FORMAT PARQUET';
    case 'xlsx':
      // HEADER is not a nicety here. Reads use `header = true`, so a sheet
      // written without one comes back with its first data row consumed as the
      // column names.
      return `FORMAT xlsx, HEADER true${sheet ? `, SHEET ${quoteLiteral(sheet)}` : ''}`;
    case 'avro':
      return 'FORMAT avro';
    default:
      throw new Error(`Cannot write ${format || 'this format'} — expected csv, json, parquet, xlsx or avro`);
  }
}

/**
 * Materialise a query as a data file, in the format the path implies.
 *
 * The write goes to a sibling temp file and is renamed into place, so a failed
 * run can't leave a half-written file behind, and so a caller can safely
 * overwrite the same path it read from.
 *
 * A workbook with more than one sheet is the exception, and takes the other
 * path below: DuckDB's xlsx writer builds a whole new file out of what it is
 * given, so writing one sheet through it would drop every other sheet.
 */
async function copyToFile(selectSql, outPath, format = null, { sheet = null } = {}) {
  const resolved = format || detectFormat(outPath);
  await ensureFormatSupport(resolved);

  if (resolved === 'xlsx' && fs.existsSync(outPath)) {
    return writeIntoWorkbook(selectSql, outPath, sheet);
  }

  return copyThroughTemp(selectSql, outPath, copyOptionsFor(resolved, outPath, { sheet }));
}

/**
 * Write into a workbook that already exists, without losing the rest of it.
 *
 * DuckDB's xlsx writer builds a NEW workbook out of whatever it is handed, so
 * COPYing one sheet over an existing file keeps that sheet and drops every
 * other. Which means a caller that forgets to say WHICH sheet it is writing
 * does not get a mistake — it gets a workbook with one sheet in it, named
 * `Sheet1`, and no error. That is a data loss this refuses to perform: the
 * guard lives here rather than at each call site precisely because forgetting
 * is the failure mode.
 */
async function writeIntoWorkbook(selectSql, outPath, sheet) {
  const sheets = xlsxFile.listSheets(outPath);

  // A single-sheet workbook has no ambiguity — the one sheet is the target,
  // and naming it keeps it from being renamed `Sheet1` on the way through.
  const target = sheet || (sheets.length === 1 ? sheets[0] : null);

  if (!target) {
    throw new Error(
      `Refusing to write ${path.basename(outPath)}: it holds ${sheets.length} sheets `
      + `(${sheets.join(', ')}) and no sheet was named, so the write would keep only one.`,
    );
  }

  // Several sheets means the workbook has to be rewritten around this one.
  if (sheets.length > 1) return replaceWorkbookSheet(selectSql, outPath, target);

  return copyThroughTemp(selectSql, outPath, copyOptionsFor('xlsx', outPath, { sheet: target }));
}

/**
 * COPY to a sibling temp file and rename into place, so a failed run can't
 * leave a half-written file behind and a caller can safely overwrite the same
 * path it read from.
 */
async function copyThroughTemp(selectSql, outPath, options) {
  ensureDir(outPath);
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await exec(`COPY (${selectSql}) TO ${quoteLiteral(tempPath)} (${options})`);
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return outPath;
}

/**
 * Rewrite one sheet of a multi-sheet workbook, keeping the others.
 *
 * The rows come back into this process to do it, which is the cost of not
 * losing the rest of the book — a sheet is capped at about a million rows by
 * the format itself, and the xlsx package holds the whole workbook in memory
 * regardless, so the ceiling is the file's, not ours.
 */
async function replaceWorkbookSheet(selectSql, outPath, sheet) {
  const { rows, columns } = await query(selectSql);
  ensureDir(outPath);
  return xlsxFile.replaceSheet(outPath, sheet, rows, columns.map((c) => c.name));
}

const copyToParquet = (selectSql, outPath) => copyToFile(selectSql, outPath, 'parquet');

/**
 * Spool rows to a newline-delimited JSON file and hand the path back.
 *
 * DuckDB infers the column types from the staged file — better inference than
 * we could do in JS, and it keeps the streaming readers on the producing side
 * unchanged. The caller owns the file and must delete it.
 *
 * @param {AsyncIterable<object>|Iterable<object>} rows
 * @param {{ onProgress?: (info: {rows: number}) => void }} options
 * @returns {Promise<{ stagePath: string, count: number }>}
 */
async function stageRowsAsNdjson(rows, { onProgress = null } = {}) {
  const stagePath = path.join(
    os.tmpdir(),
    `ternlux-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ndjson`,
  );
  const stage = fs.createWriteStream(stagePath);
  let count = 0;
  let lastReport = 0;

  const write = async (chunk) => {
    if (!stage.write(chunk)) await new Promise((resolve) => stage.once('drain', resolve));
  };

  try {
    let buffer = '';
    for await (const row of rows) {
      buffer += `${JSON.stringify(row)}\n`;
      count++;
      if (buffer.length > (1 << 20)) { await write(buffer); buffer = ''; }
      // A remote table landing locally spends its whole time in this one loop,
      // so a stop has to be able to reach it. Sampled rather than checked per
      // row: this runs millions of times and the check is an AsyncLocalStorage
      // lookup, while a thousand rows either way makes no difference to how
      // responsive the button feels. The catch below removes the stage file, so
      // stopping here leaves nothing behind.
      if (count % 1000 === 0) throwIfCancelled('loading rows', `${count} rows staged so far`);
      if (onProgress && Date.now() - lastReport >= 250) {
        lastReport = Date.now();
        onProgress({ rows: count });
      }
    }
    if (buffer) await write(buffer);
    await new Promise((resolve, reject) => {
      stage.on('error', reject);
      stage.end(resolve);
    });
    return { stagePath, count };
  } catch (error) {
    fs.rmSync(stagePath, { force: true });
    throw error;
  }
}

/**
 * The FROM expression that reads a staged NDJSON file back.
 *
 * `sample_size = -1` infers the schema from the WHOLE file rather than the
 * first ~20k rows. Documents out of a schemaless source do not agree about
 * their shape, and a field that first appears after the sample is otherwise
 * dropped from the table with no error at all — measured: a field introduced at
 * row 30,001 is simply absent, at the top level and inside a nested struct
 * alike. The cost is one more pass over a file we already write and read in
 * full; losing columns silently is the one outcome worth paying to avoid.
 */
const stagedRef = (stagePath) =>
  `read_json_auto(${quoteLiteral(stagePath)}, format = 'newline_delimited', `
  + 'union_by_name = true, sample_size = -1)';

/**
 * Write rows from an async iterable to a data file, in the format its path
 * implies.
 *
 * The format is detected rather than assumed: writing Parquet bytes into a file
 * the user named `.csv` or `.xlsx` produces something nothing can open, and
 * says nothing about it. A workbook goes through copyToFile, so writing one
 * sheet of an existing book keeps the others.
 *
 * Node outputs do not come through here — those are tables in the workflow's
 * own database (see ingestRowsToTable).
 *
 * @param {AsyncIterable<object>|Iterable<object>} rows
 * @param {string} outPath
 * @param {{ onProgress?: (info: {rows: number}) => void, format?: string, sheet?: string }} options
 */
async function ingestRows(rows, outPath, { onProgress = null, format = null, sheet = null } = {}) {
  ensureDir(outPath);
  const resolved = format || detectFormat(outPath) || 'parquet';
  const { stagePath, count } = await stageRowsAsNdjson(rows, { onProgress });
  try {
    if (count === 0) throw new Error('No rows to write');
    await copyToFile(`SELECT * FROM ${stagedRef(stagePath)}`, outPath, resolved, { sheet });
    if (onProgress) onProgress({ rows: count });
    return { rowCount: count, path: outPath };
  } finally {
    fs.rmSync(stagePath, { force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Workflow databases
//
// A node's output is a TABLE in its workflow's own database file,
// `workflow-data/<workflowId>.duckdb`, attached to the shared connection under
// a stable alias. Two things follow from that:
//
//   • ALTER / UPDATE / DELETE / INSERT work directly. An in-place transform is
//     the statement the user asked for, not a full-file rewrite expressed as a
//     SELECT projection (which silently dropped any column the model forgot to
//     list).
//   • One database per workflow, so two workflows running at once never touch
//     the same file. Within a workflow, writes are serialized by
//     withWorkflowLock — the same workflow can be triggered twice at once
//     (a cron firing while the user hits Execute), and DuckDB would otherwise
//     fail the second writer rather than queue it.
//
// Everything is attached to the ONE in-memory instance, so a node can join its
// own table against a Parquet/CSV source file in a single query.
// ───────────────────────────────────────────────────────────────────────────

/** `[^a-zA-Z0-9_]` collapsed, so the result is always a legal identifier. */
const sanitizeIdentifier = (value) => String(value || '')
  .replace(/[^a-zA-Z0-9_]/g, '_')
  .slice(0, 80);

/**
 * The schema a connection's tables live under — `sales_csv.orders`.
 *
 * USER-FACING: it is what the Data Explorer's tree shows, what a double-click
 * puts in the editor, and therefore what anyone (a person or a model reading
 * their SQL) learns to type. It lives here, in the core, rather than in the
 * connector, because the workflow executor has to arrive at the SAME name — a
 * qualified name the Explorer displayed but the executor rejects is the whole
 * bug this exists to prevent.
 *
 * Returns null when the name sanitizes to nothing; callers fall back to the
 * bare table name.
 */
function sanitizeSchemaName(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!cleaned) return null;
  return /^[0-9]/.test(cleaned) ? `f_${cleaned}` : cleaned;
}

/**
 * Expose one source under every name that can legitimately address it.
 *
 * `body` is the SELECT that reads it — `SELECT * FROM read_csv_auto('…')` for a
 * file, `SELECT * FROM "wf_123"."orders"` for an upstream node's table.
 *
 * Two addressing styles have to work, because the app teaches both:
 *
 *   bare            `FROM orders`            — the Data Explorer puts the open
 *                                              connection's schema on the
 *                                              search_path, so this is what a
 *                                              worksheet writes.
 *   schema-qualified `FROM sales_csv.orders` — the connection's own schema. It
 *                                              is what the tree DISPLAYS, what
 *                                              reaches a file you don't have
 *                                              open, and what a model copies
 *                                              out of either.
 *
 * The executor used to register only the bare form, so a perfectly ordinary
 * `FROM sales_csv.orders` failed with 'schema "sales_csv" does not exist'.
 * Registering both makes the executor agree with the Explorer.
 *
 * @param {string}   body            SELECT expression that reads the source.
 * @param {string[]} names           Bare names it should answer to (table name,
 *                                   file basename, a join's temp-table alias).
 * @param {string}   [connectionName] Owning connection; omit for a node output,
 *                                   which has no connection and is already
 *                                   reachable as `<workflowAlias>.<table>`.
 * @returns {Promise<{schema: string|null, created: string[]}>} `created` holds
 *          quoted refs, ready to hand back to `dropViews`.
 */
async function registerAddressableViews({ body, names = [], connectionName = null }) {
  if (!body) throw new Error('registerAddressableViews requires a body SELECT');
  const bare = [...new Set((names || []).filter(Boolean).map(String))];
  if (bare.length === 0) throw new Error('registerAddressableViews requires at least one name');

  const created = [];
  for (const name of bare) {
    const ref = quoteIdentifier(name);
    await exec(`CREATE OR REPLACE VIEW ${ref} AS ${body}`);
    created.push(ref);
  }

  const schema = sanitizeSchemaName(connectionName);
  if (schema) {
    await exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    for (const name of bare) {
      const ref = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
      await exec(`CREATE OR REPLACE VIEW ${ref} AS ${body}`);
      created.push(ref);
    }
  }
  return { schema: schema || null, created };
}

/**
 * Drop views registered by registerAddressableViews. Best-effort per view: one
 * that has already gone must not stop the rest being cleaned up, or a name
 * left behind would shadow whatever answers to it next.
 *
 * The SCHEMA is deliberately left in place. It is empty, it costs nothing, and
 * dropping it would race any other source of the same connection.
 */
async function dropViews(created = []) {
  for (const ref of created) {
    try { await exec(`DROP VIEW IF EXISTS ${ref}`); } catch { /* best effort */ }
  }
}

/** The folder every workflow's database lives in. */
function workflowDataDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'workflow-data');
}

/** Where a workflow's database lives. */
function workflowDbPath(workflowId) {
  if (!workflowId) throw new Error('A workflow id is required to resolve its database');
  return path.join(workflowDataDir(), `${sanitizeIdentifier(workflowId)}.duckdb`);
}

/**
 * Is this a workflow's own database — where node outputs are tables — rather
 * than a .duckdb file the user owns? Decided by location, never by extension:
 * a user's .duckdb connection ends in .duckdb too, and treating it as a
 * workflow database reads its tables out of the wrong file.
 */
function isWorkflowDatabase(dbPath) {
  if (!dbPath || !/\.duckdb$/i.test(String(dbPath))) return false;
  let dir;
  try {
    dir = workflowDataDir();
  } catch (_) {
    return false; // outside Electron there are no workflow databases
  }
  return path.dirname(path.resolve(String(dbPath))) === path.resolve(dir);
}

/**
 * The alias a database file is attached under. Derived from the file, so the
 * same database gets the same alias whether the caller has the workflow id or
 * only the path recorded on a node's config.
 */
const aliasForDbPath = (dbPath) => `wf_${sanitizeIdentifier(path.basename(String(dbPath), '.duckdb'))}`;

/** The alias a workflow's database is attached under. */
const workflowAlias = (workflowId) => aliasForDbPath(workflowDbPath(workflowId));

// alias → promise of the completed ATTACH. Cached so concurrent callers share
// one attach rather than racing to issue it twice.
const attached = new Map();
// alias → the file behind it, so the idle release below knows which are the
// user's files and which are the app's own.
const attachedPaths = new Map();

// ── holding the user's database files only while they are in use ──────────
//
// An ATTACHed .duckdb is locked by this process: DuckDB, Python or a second app
// instance opening it gets "Could not set lock on file … held in Electron". The
// app's OWN databases (a workflow's file, the shared imports store — anything
// under userData) are nobody else's business and stay attached. A file the user
// owns — an output written to their Desktop, a .duckdb or .sqlite connection —
// is attached for the work that needs it and detached once nothing here is
// using the engine any more, so it is locked only while it is being executed.
//
// "Using" is counted, not guessed: every statement on the shared connection,
// every open stream and every holdDatabases() block counts as busy. A node run
// is wrapped in holdDatabases as a whole, because it registers views over an
// attached database and then may spend seconds fetching rows from somewhere
// else before reading them — idle to the engine, but not finished. The release
// waits a moment after the count reaches zero so one operation's consecutive
// statements (attach, then read) never see their database leave in between.

const RELEASE_AFTER_MS = 1000;
let busy = 0;
let releaseTimer = null;
// Set while a release is detaching, so an attach in that window waits for it
// rather than finding a cache entry that is about to be removed.
let releasing = null;

/** Is this one of the app's own databases (kept attached), rather than the user's? */
function isAppDatabase(dbPath) {
  let userData = null;
  try {
    // eslint-disable-next-line global-require
    userData = require('electron').app.getPath('userData');
  } catch (_) {
    return false; // outside Electron there is no app-owned location
  }
  const rel = path.relative(userData, path.resolve(String(dbPath)));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function letGo() {
  busy = Math.max(0, busy - 1);
  if (busy > 0 || releaseTimer) return;
  const hasExternal = [...attachedPaths.values()].some((p) => !isAppDatabase(p));
  if (!hasExternal) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (busy === 0) releasing = releaseUserDatabases().finally(() => { releasing = null; });
  }, RELEASE_AFTER_MS);
  if (typeof releaseTimer.unref === 'function') releaseTimer.unref();
}

/**
 * Run `fn` with the user's attached databases kept attached until it settles.
 * Re-entrant: nested holds simply count.
 */
async function holdDatabases(fn) {
  busy += 1;
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  try {
    return await fn();
  } finally {
    letGo();
  }
}

/** Detach every user-owned database, flushing it first. Never throws. */
async function releaseUserDatabases() {
  for (const [alias, dbPath] of [...attachedPaths]) {
    if (busy > 0) return; // something started; it will schedule the next release
    if (isAppDatabase(dbPath)) continue;
    attached.delete(alias);
    attachedPaths.delete(alias);
    try {
      const connection = await getConnection();
      // CHECKPOINT folds the WAL back into the file, so what is left on disk is
      // one self-contained database rather than a .duckdb plus a .wal beside it.
      // A SQLite attachment has no checkpoint of DuckDB's; that failure is fine.
      try { await connection.run(`CHECKPOINT ${quoteIdentifier(alias)}`); } catch (_) { /* sqlite */ }
      await connection.run(`DETACH ${quoteIdentifier(alias)}`);
    } catch (_) {
      // Already gone, or the instance was reset. Nothing left to release.
    }
  }
}

/**
 * Is this an existing SQLite database file? Decided by the file's own header
 * ("SQLite format 3\0"), never by its extension: `.db` is used by both engines,
 * and the imported-file store is a `.db` that is SQLite.
 */
function isSqliteFile(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    return read === 16 && header.toString('latin1') === 'SQLite format 3\u0000';
  } catch (_) {
    return false; // missing or unreadable — not a SQLite file to attach
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* already closed */ } }
  }
}

/**
 * Attach a database file (once per session) and return its alias.
 * Creates the file if it does not exist yet.
 */
async function attachDb(dbPath, { sqlite = false } = {}) {
  if (releasing) await releasing;
  const alias = aliasForDbPath(dbPath);
  if (!attached.has(alias)) {
    attachedPaths.set(alias, dbPath);
    const pending = (async () => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      // A SQLite file is read by DuckDB's sqlite extension. Loaded through
      // ensureExtension, not left to ATTACH's autoload: autoload always goes
      // to the network, while ensureExtension installs the copy bundled with
      // the app where there is one (see ./extensions) — the same offline-first
      // rule the excel and avro readers follow. TYPE is stated rather than
      // sniffed so the attach never depends on autoload being enabled.
      // `sqlite` is the caller saying what a file that does not exist yet
      // should BE — an output node writing .sqlite — since there is no header
      // to read until something has written one.
      if (sqlite || isSqliteFile(dbPath)) {
        await ensureExtension('sqlite_scanner', { exec, query });
        await exec(`ATTACH IF NOT EXISTS ${quoteLiteral(dbPath)} AS ${quoteIdentifier(alias)} (TYPE sqlite)`);
        return alias;
      }
      await exec(`ATTACH IF NOT EXISTS ${quoteLiteral(dbPath)} AS ${quoteIdentifier(alias)}`);
      return alias;
    })().catch((err) => {
      attached.delete(alias); // let a later call retry
      attachedPaths.delete(alias);
      throw err;
    });
    attached.set(alias, pending);
  }
  return attached.get(alias);
}

/** Attach a workflow's database and return its alias. */
const attachWorkflow = (workflowId) => attachDb(workflowDbPath(workflowId));

/** First `limit` rows of a table in a database addressed by PATH. */
async function readTableHeadAt(dbPath, tableName, limit = 1000) {
  const alias = await attachDb(dbPath);
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
  return query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 1000}`);
}

/** Tables held in a database addressed by PATH. */
async function tablesAt(dbPath) {
  const alias = await attachDb(dbPath);
  const { rows } = await query(
    `SELECT table_name FROM duckdb_tables() WHERE database_name = ${quoteLiteral(alias)} ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/**
 * Detach a database addressed by PATH.
 *
 * The counterpart to attachDb, for when the thing behind the path is going
 * away: a workflow's file being deleted, or a saved connection that pointed at
 * a database being removed. Leaving it attached would keep the file open and
 * keep its tables answering to a name whose owner no longer exists.
 */
async function detachDb(dbPath) {
  const alias = aliasForDbPath(dbPath);
  if (!attached.has(alias)) return;
  attached.delete(alias);
  attachedPaths.delete(alias);
  try {
    await exec(`DETACH ${quoteIdentifier(alias)}`);
  } catch {
    // Already gone, or never finished attaching. Nothing left to release.
  }
}

/** Detach a workflow's database — used when its file is being replaced/removed. */
async function detachWorkflow(workflowId) {
  const alias = workflowAlias(workflowId);
  if (!attached.has(alias)) return;
  attached.delete(alias);
  attachedPaths.delete(alias);
  try {
    await exec(`DETACH ${quoteIdentifier(alias)}`);
  } catch {
    // Already gone, or never finished attaching. Either way there is nothing
    // left to release.
  }
}

/**
 * The qualified reference for a node's output table, e.g. `"wf_abc"."orders"`.
 * Attaches the database first, so this is the only call a writer needs.
 */
async function workflowTableRef(workflowId, tableName) {
  const alias = await attachWorkflow(workflowId);
  return `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
}

// workflowId → tail of its write queue. Keyed by id, so unrelated workflows
// never wait on each other.
const workflowLocks = new Map();

/** Run `fn` with exclusive access to one workflow's database. */
function withWorkflowLock(workflowId, fn) {
  const key = workflowAlias(workflowId);
  const previous = workflowLocks.get(key) || Promise.resolve();
  // Chain off the previous holder's SETTLEMENT, not its value — one failed
  // write must not poison every write queued behind it.
  const next = previous.then(fn, fn);
  // Keep the queue tail non-rejecting for the same reason.
  workflowLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

// Guards anything that changes CONNECTION state rather than one database's
// contents. There is a single shared connection, so a `USE` issued for one
// workflow is visible to every other caller that runs between our statements.
let sessionQueue = Promise.resolve();
function withSession(fn) {
  const next = sessionQueue.then(fn, fn);
  sessionQueue = next.then(() => {}, () => {});
  return next;
}

// The catalog the connection starts in, to return to after a `USE`.
let defaultDatabase = null;
async function currentDatabase() {
  if (!defaultDatabase) {
    const { rows } = await query('SELECT current_database() AS d');
    defaultDatabase = rows[0]?.d || 'memory';
  }
  return defaultDatabase;
}

/**
 * Run `fn` with `alias` as the current catalog, so an unqualified `orders`
 * means that database's orders table.
 *
 * Qualifying the identifiers instead would mean rewriting the SQL the model
 * wrote, and wrapping the table in a view is not an option — DuckDB can only
 * update a base table.
 *
 * Takes the session lock, so callers that also hold a workflow lock must take
 * that one FIRST to keep the ordering consistent and avoid deadlock.
 */
async function withCatalog(alias, fn) {
  const home = await currentDatabase();
  return withSession(async () => {
    await exec(`USE ${quoteIdentifier(alias)}`);
    try {
      return await fn();
    } finally {
      await exec(`USE ${quoteIdentifier(home)}`);
    }
  });
}

/**
 * Run statements against a workflow's database. `sql` may contain several
 * separated by semicolons; they run as one unit.
 */
async function execInWorkflow(workflowId, sql) {
  const alias = await attachWorkflow(workflowId);
  return withCatalog(alias, () => exec(sql));
}

/**
 * Run statements against the database at `dbPath`, addressed by path rather
 * than by workflow id. Unqualified names resolve inside it, so a statement can
 * modify one of its tables directly — no copy, no write-back.
 */
async function execInDb(dbPath, sql, run = exec) {
  const alias = await attachDb(dbPath);
  return withCatalog(alias, () => run(sql));
}

/** `execInDb`, statement by statement — see `execScript` for what that buys. */
const execScriptInDb = (dbPath, sql) => execInDb(dbPath, sql, execScript);

/** Row count of a table in the database at `dbPath`. */
async function tableRowCountIn(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const { rows } = await queryIn(alias, `SELECT count(*) AS c FROM ${quoteIdentifier(tableName)}`);
  return Number(rows[0]?.c ?? 0);
}

/** Run a read against an attached database, resolving unqualified names in it. */
async function queryIn(alias, sql) {
  return withCatalog(alias, () => query(sql));
}

/** Replace a node's output table with the result of `selectSql`. */
async function createTableAs(workflowId, tableName, selectSql) {
  const ref = await workflowTableRef(workflowId, tableName);
  await exec(`CREATE OR REPLACE TABLE ${ref} AS ${selectSql}`);
  return ref;
}

/** Does the database at this PATH already hold that table? */
async function tableExistsAt(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const { rows } = await query(
    `SELECT count(*) AS c FROM duckdb_tables()
      WHERE database_name = ${quoteLiteral(alias)} AND table_name = ${quoteLiteral(sanitizeIdentifier(tableName))}`,
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

/** Does this workflow's database already hold that table? */
const tableExists = (workflowId, tableName) => tableExistsAt(workflowDbPath(workflowId), tableName);

/**
 * A table's columns and primary key, in a database addressed by PATH — read
 * from the catalog (duckdb_columns / duckdb_constraints), never from the
 * table's own SQL. null when the table does not exist.
 */
async function describeTableAt(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const where = `database_name = ${quoteLiteral(alias)} AND table_name = ${quoteLiteral(sanitizeIdentifier(tableName))}`;
  const { rows } = await query(
    `SELECT column_name, data_type FROM duckdb_columns() WHERE ${where} ORDER BY column_index`,
  );
  if (!rows.length) return null;
  const { rows: keys } = await query(
    `SELECT constraint_column_names AS cols FROM duckdb_constraints() WHERE ${where} AND constraint_type = 'PRIMARY KEY'`,
  );
  const raw = keys[0]?.cols;
  const keyCols = new Set((Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.replace(/^\[|\]$/g, '').split(',') : []))
    .map((c) => String(c).trim().replace(/^"|"$/g, '')).filter(Boolean));
  return rows.map((r) => ({ name: r.column_name, type: r.data_type, isPrimary: keyCols.has(r.column_name) }));
}

/** describeTableAt for a table in this workflow's database. */
const describeTable = (workflowId, tableName) => describeTableAt(workflowDbPath(workflowId), tableName);

/** Rows currently in a table, in a database addressed by PATH. */
async function tableRowCountAt(dbPath, tableName) {
  const alias = await attachDb(dbPath);
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
  const { rows } = await query(`SELECT count(*) AS c FROM ${ref}`);
  return Number(rows[0]?.c ?? 0);
}

/** Rows currently in a node's output table. */
const tableRowCount = (workflowId, tableName) =>
  tableRowCountAt(workflowDbPath(workflowId), tableName);

/** First `limit` rows of a node's output table, plus its columns. */
async function readTableHead(workflowId, tableName, limit = 1000) {
  const ref = await workflowTableRef(workflowId, tableName);
  return query(`SELECT * FROM ${ref} LIMIT ${Number(limit) || 1000}`);
}

/**
 * Write rows from an async iterable into a table, in a database addressed by
 * PATH.
 *
 * @param {AsyncIterable<object>|Iterable<object>} rows
 * @param {{ mode?: 'replace'|'append', onProgress?: function }} options
 */
async function ingestRowsToTableAt(rows, dbPath, tableName, { mode = 'replace', onProgress = null, sqlite = false } = {}) {
  return holdDatabases(() => ingestRowsHeld(rows, dbPath, tableName, { mode, onProgress, sqlite }));
}

async function ingestRowsHeld(rows, dbPath, tableName, { mode, onProgress, sqlite }) {
  const alias = await attachDb(dbPath, { sqlite });
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
  const { stagePath, count } = await stageRowsAsNdjson(rows, { onProgress });
  try {
    if (count === 0) throw new Error('No rows to write');
    if (mode === 'append' && await tableExistsAt(dbPath, tableName)) {
      // BY NAME so a row missing a column lands as NULL instead of failing on
      // column order. It does NOT cover the other direction — a batch carrying
      // a field the table has never seen errors — so add those columns first.
      // These rows come from schemaless places (an API response, a JS
      // transform), where a new field appearing is ordinary.
      const existing = new Set((await describe(ref)).map((c) => c.name));
      const incoming = await describe(stagedRef(stagePath));
      for (const column of incoming.filter((c) => !existing.has(c.name))) {
        await exec(`ALTER TABLE ${ref} ADD COLUMN ${quoteIdentifier(column.name)} ${column.type}`);
      }
      await exec(`INSERT INTO ${ref} BY NAME SELECT * FROM ${stagedRef(stagePath)}`);
    } else {
      await exec(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${stagedRef(stagePath)}`);
    }
    if (onProgress) onProgress({ rows: count });
    return { rowCount: count, tableName: sanitizeIdentifier(tableName) };
  } finally {
    fs.rmSync(stagePath, { force: true });
  }
}

/** Write rows into a table in a workflow's database. */
const ingestRowsToTable = (rows, workflowId, tableName, options = {}) =>
  ingestRowsToTableAt(rows, workflowDbPath(workflowId), tableName, options);

// ── staging ────────────────────────────────────────────────────────────────
//
// Work that only has to survive one operation — a join source pulled from a
// remote database, the scratch copy an in-place file update mutates — lives in
// a schema of its own inside the workflow's database. Keeping it there rather
// than in the OS temp directory means one file holds everything a workflow
// touches, and a staging table can be joined against a node's output without
// leaving the database.
//
// The schema is separate from `main` so a staging table may safely carry the
// same name as a node output: the model writes `UPDATE people ...` about the
// source it was given, and that must not overwrite a node output called
// `people`.
const STAGING_SCHEMA = 'ternlux_staging';

/** The staging schema in a database, created on first use. Returns its alias. */
async function ensureStagingSchema(dbPath) {
  const alias = await attachDb(dbPath);
  await exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(alias)}.${quoteIdentifier(STAGING_SCHEMA)}`);
  return alias;
}

/** Fully-qualified reference to a staging table. */
async function stagingRef(dbPath, tableName) {
  const alias = await ensureStagingSchema(dbPath);
  return `${quoteIdentifier(alias)}.${quoteIdentifier(STAGING_SCHEMA)}.${quoteIdentifier(sanitizeIdentifier(tableName))}`;
}

/** Load rows into a staging table in `dbPath`, replacing any previous one. */
async function ingestRowsToStaging(rows, dbPath, tableName, { onProgress = null } = {}) {
  const ref = await stagingRef(dbPath, tableName);
  const { stagePath, count } = await stageRowsAsNdjson(rows, { onProgress });
  try {
    if (count === 0) throw new Error('No rows to write');
    await exec(`CREATE OR REPLACE TABLE ${ref} AS SELECT * FROM ${stagedRef(stagePath)}`);
    if (onProgress) onProgress({ rows: count });
    return { rowCount: count, ref };
  } finally {
    fs.rmSync(stagePath, { force: true });
  }
}

/**
 * Run statements with the staging schema first on the search path, so an
 * unqualified name in the caller's SQL means its staging table.
 */
async function execInStaging(dbPath, sql, run = exec) {
  const alias = await ensureStagingSchema(dbPath);
  return withCatalog(alias, async () => {
    await exec(`SET search_path = ${quoteLiteral(`${STAGING_SCHEMA},main`)}`);
    try {
      return await run(sql);
    } finally {
      await exec("SET search_path = 'main'");
    }
  });
}

/** `execInStaging`, statement by statement — see `execScript`. */
const execScriptInStaging = (dbPath, sql) => execInStaging(dbPath, sql, execScript);

/** Drop staging tables once the operation that created them is done. */
async function dropStaging(dbPath, tableNames) {
  for (const name of tableNames || []) {
    try {
      await exec(`DROP TABLE IF EXISTS ${await stagingRef(dbPath, name)}`);
    } catch (err) {
      console.warn('[duckdb] Could not drop staging table', name, err.message);
    }
  }
}

/** Delete a workflow's database entirely — called when the workflow is deleted. */
async function dropWorkflowDb(workflowId) {
  await detachWorkflow(workflowId);
  const dbPath = workflowDbPath(workflowId);
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}.wal`, { force: true });
}

/** Release the connection — called on app shutdown. */
async function close() {
  if (!connectionPromise) return;
  const pending = connectionPromise;
  connectionPromise = null;
  try {
    const connection = await pending;
    // Fold each workflow database's write-ahead log into the database itself.
    // Without this every workflow-data folder is left holding a `.duckdb.wal`
    // beside its database — recoverable (DuckDB replays it on the next attach)
    // but alarming to find, and it keeps growing across sessions.
    for (const alias of attached.keys()) {
      try { await connection.run(`CHECKPOINT ${quoteIdentifier(alias)}`); } catch { /* nothing to flush */ }
    }
    attached.clear();
    attachedPaths.clear();
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    connection.closeSync();
  } catch {
    // Already gone; nothing to release.
  }
}

module.exports = {
  getConnection,
  query,
  queryUpTo,
  // Unbounded streaming reads — see streamRows.
  streamRows,
  streamTableRowsAt,
  streamFileRows,
  streamLocalRows,
  describeLocalSource,
  isDatabaseFile,
  isSqliteFile,
  attachedTableRef,
  exec,
  statementCount,
  statementType,
  parsesAsSelectQuery,
  fingerprint,
  describe,
  describeColumns,
  readHead,
  countRows,
  fileSchema,
  copyToParquet,
  copyToFile,
  ingestRows,
  sourceRef,
  tableRef,
  sessionEpoch,
  detectFormat,
  isReadable,
  sheetFor,
  listSheets: xlsxFile.listSheets,
  isWorkbook: xlsxFile.isWorkbook,
  isLegacyWorkbook: xlsxFile.isLegacyWorkbook,
  legacyWorkbookMessage: xlsxFile.legacyMessage,
  quoteLiteral,
  quoteIdentifier,
  close,
  FORMAT_BY_EXT,
  detachDb,
  // Workflow databases — a node output is a table in its workflow's own file.
  workflowDbPath,
  isWorkflowDatabase,
  workflowAlias,
  aliasForDbPath,
  attachDb,
  holdDatabases,
  attachWorkflow,
  detachWorkflow,
  readTableHeadAt,
  tablesAt,
  workflowTableRef,
  describeTable,
  describeTableAt,
  withWorkflowLock,
  withSession,
  withCatalog,
  currentDatabase,
  execInWorkflow,
  execInDb,
  execScript,
  execScriptInDb,
  tableRowCountIn,
  queryIn,
  createTableAs,
  tableExists,
  tableExistsAt,
  tableRowCount,
  tableRowCountAt,
  readTableHead,
  ingestRowsToTable,
  ingestRowsToTableAt,
  ingestRowsToStaging,
  stagingRef,
  execInStaging,
  execScriptInStaging,
  dropStaging,
  STAGING_SCHEMA,
  dropWorkflowDb,
  sanitizeIdentifier,
  // Addressing — shared by the connector (Data Explorer) and the workflow
  // executor so both resolve a source to the same names. See the note on
  // sanitizeSchemaName.
  sanitizeSchemaName,
  registerAddressableViews,
  dropViews,
};
