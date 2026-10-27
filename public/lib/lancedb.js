/**
 * LanceDB integration for local vector database operations
 */

const lancedb = require('@lancedb/lancedb');
const arrow = require('apache-arrow');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Get LanceDB database path
 * @param {String} customPath - Optional custom path
 * @returns {String} Database path
 */
function getLanceDBPath(customPath) {
  const rejected = customPath ? invalidLanceDirReason(customPath) : null;
  if (customPath && !rejected) {
    return customPath;
  }

  const dbPath = path.join(app.getPath('userData'), 'data', 'lancedb');

  // Ensure directory exists
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }

  // Say so. A silent redirect means the caller's recorded target and where its
  // rows actually land disagree, and nothing downstream — which reads the
  // recorded path — can find them. That is a node misconfiguration to fix, not
  // something to absorb quietly.
  if (customPath) {
    console.warn(
      `[lancedb] "${customPath}" is not a LanceDB directory (${rejected}); `
      + `writing to the default store at "${dbPath}" instead. Whatever recorded that path `
      + `will look for these rows in the wrong place — repoint the node's target.`,
    );
  }

  return dbPath;
}

/**
 * LanceDB needs a *directory*. A SQLite/DuckDB file path (e.g. *.db) or
 * any existing regular file would make LanceDB try to create a table inside a
 * file ("Unable to walk dir: ... Not a directory"). Detect those so callers can
 * fall back to the default LanceDB directory instead of crashing — this guards
 * against stored node configs whose targetLocalPath still points at a source
 * data file or at the workflow's own DuckDB database.
 *
 * Returns why the path was rejected (for the log), or null when it is usable.
 */
function invalidLanceDirReason(customPath) {
  if (/\.(db|sqlite|sqlite3|duckdb)$/i.test(customPath)) {
    return 'it names a database file, not a directory';
  }
  try {
    if (fs.existsSync(customPath) && fs.statSync(customPath).isFile()) {
      return 'it already exists as a regular file';
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Is this path a Lance *dataset* (one table) rather than a LanceDB *database*?
 *
 * A database is a directory whose children are `<table>.lance` dataset
 * directories; a dataset is one of those children. The distinction matters
 * because `connect()` on a dataset SUCCEEDS and then reports zero tables —
 * there are no `.lance` children inside it — so a path that is one level too
 * deep looks like a healthy but empty database rather than an error. Every
 * caller downstream then behaves as if the store were empty.
 *
 * Lance stamps each dataset with a manifest and a `_versions` directory, so the
 * two are cheap to tell apart without opening anything.
 */
function isLanceDatasetDir(dirPath) {
  if (!dirPath) return false;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dirPath, '_versions'))
    || fs.existsSync(path.join(dirPath, '_latest.manifest'));
}

/**
 * Resolve a `{ dbPath, tableName }` pair against what `dbPath` actually points
 * at, so a path naming a TABLE where a DATABASE was expected still works.
 *
 * This is a real and silent failure mode rather than a hypothetical one: the
 * LanceDB export hands back the dataset path it wrote, the connection form
 * offers a `.lance` filter in its directory picker, and either route saves a
 * connection whose `fileInfo.filePath` is a dataset. Nothing rejects it, so the
 * connection lists no tables and the assistant is left asking the user which
 * table to search.
 *
 * When `dbPath` is a dataset, the parent becomes the database and the dataset's
 * own name becomes the table. The dataset name WINS over a caller-supplied
 * `tableName`: the path already names exactly one table, so honouring a
 * different name would open a sibling dataset in the parent directory — for an
 * export dropped in ~/Downloads that parent holds every unrelated download, and
 * quietly reading one of those is far worse than failing.
 */
function normalizeLanceTarget({ dbPath, tableName } = {}) {
  if (!isLanceDatasetDir(dbPath)) return { dbPath, tableName };

  const datasetTable = path.basename(dbPath).replace(/\.lance$/i, '');
  if (tableName && tableName !== datasetTable) {
    console.warn(
      `[lancedb] "${dbPath}" is the table "${datasetTable}", but table "${tableName}" was requested; `
      + `reading "${datasetTable}". Point the connection at the database DIRECTORY `
      + `("${path.dirname(dbPath)}") if you meant a different table.`,
    );
  }
  return { dbPath: path.dirname(dbPath), tableName: datasetTable, datasetTable };
}

/**
 * Get or create LanceDB connection
 * @param {Object} config - Configuration object
 * @param {String} config.dbPath - Optional custom database path
 * @returns {Promise<Object>} LanceDB connection
 */
async function getLanceDBConnection(config = {}) {
  // Every open goes through here, including the vector skill's direct ones
  // (joinHandler, the embed/search handlers), so a path naming a `.lance`
  // dataset is resolved to its parent database once, here, rather than in each
  // caller. Callers then open the dataset's own table by name, which is the
  // name getTables reports for such a connection.
  const dbPath = getLanceDBPath(normalizeLanceTarget(config).dbPath);
  const db = await lancedb.connect(dbPath);
  return db;
}

/**
 * Execute LanceDB operation
 * @param {Object} params - Parameters
 * @param {String} params.operation - 'upsert', 'query', 'delete', or 'update'
 * @param {Array} params.data - Data to upsert (for upsert operation)
 * @param {Object} params.config - LanceDB configuration
 * @param {String} params.config.tableName - Table name
 * @param {String} params.config.dbPath - Optional custom database path
 * @param {Array} params.config.queryVector - Query vector (for query operation)
 * @param {Number} params.config.limit - Result limit (for query operation)
 * @param {String} params.config.filter - Filter expression (for delete/update)
 * @param {Array} params.config.updates - Update data (for update operation)
 * @returns {Promise<Object>} Operation result
 */
async function executeLanceDBOperation({ operation, data, config }) {
  const target = normalizeLanceTarget(config);
  const db = await getLanceDBConnection({ ...config, dbPath: target.dbPath });
  const tableName = target.tableName || 'vectors';
  try {
    switch (operation) {
      case 'upsert':
        return await upsertVectors(db, tableName, data, { overwrite: config.overwrite === true });

      case 'query':
        return await queryVectors(db, tableName, config);

      case 'delete':
        return await deleteVectors(db, tableName, config);

      case 'update':
        return await updateVectors(db, tableName, config);

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  } catch (error) {
    throw new Error(`LanceDB operation failed: ${error.message}`);
  }
}

/**
 * Upsert vectors to LanceDB table
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Array} data - Array of vector records with { id, vector, ...metadata }
 * @returns {Promise<Object>} Result
 */
async function upsertVectors(db, tableName, data, opts = {}) {
  if (!data || data.length === 0) {
    throw new Error('No data provided for upsert');
  }

  // Validate that all records have vectors
  for (const record of data) {
    if (!record.vector || !Array.isArray(record.vector)) {
      throw new Error(`Invalid vector in record: ${JSON.stringify(record)}`);
    }
  }

  // Normalize so every column has ONE consistent Arrow type across ALL records.
  // The AI-generated join can emit columns that are numeric for some rows and
  // missing/empty for others (e.g. similar_3_id is a number when a match exists
  // and '' when it doesn't). Arrow rejects such mixed columns ("Unable to infer
  // Vector type") and also can't infer an all-missing column. Resolving the type
  // from the WHOLE batch (not just data[0]) and coercing accordingly fixes both.
  const { records, schema } = normalizeRecordsForArrow(data);

  let table;
  let isNewTable = false;

  // Overwrite: replace the whole table in ONE step, after the records are
  // already converted. A "new_table" write is then idempotent — re-runs neither
  // append duplicates nor trip over a batch schema that drifted from last run's
  // ("Append with different schema") — and a write that fails leaves the old
  // table intact. (This used to drop the table first and then create it, so a
  // create that failed lost every record.)
  if (opts.overwrite) {
    table = await db.createTable(tableName, records, { schema, mode: 'overwrite' });
    console.log(`Replaced LanceDB table ${tableName} with ${records.length} records (overwrite)`);
    return {
      success: true,
      data: records,
      recordCount: records.length,
      message: `Replaced table '${tableName}' with ${records.length} vectors`,
    };
  }

  try {
    // Try to open existing table
    table = await db.openTable(tableName);
    console.log(`Opened existing LanceDB table: ${tableName}`);
  } catch (err) {
    // Table doesn't exist, create it with explicit schema to avoid dictionary encoding
    console.log(`Creating new LanceDB table: ${tableName} with explicit schema`);

    try {
      // Try to create table with schema (v0.4.0+ API)
      table = await db.createTable(tableName, records, { schema });
      isNewTable = true;
    } catch (schemaErr) {
      // Fallback: create without explicit schema if schema API not supported.
      // The normalized records are already type-consistent, so plain inference
      // works here too.
      console.warn('Could not create table with explicit schema, falling back to default:', schemaErr.message);
      table = await db.createTable(tableName, records);
      isNewTable = true;
    }
  }

  if (!isNewTable) {
    // A table's vector column is a FIXED-size list: appending a different width
    // fails inside Lance with a Rust-level message that names neither the table
    // that has to change nor how it got that way. Check first and say it.
    await assertVectorWidthMatches(table, records, tableName);

    // Upsert = merge by id: a record whose id is already stored REPLACES it,
    // the rest are added, everything else stays. `table.add` alone appended a
    // second copy of every re-written record. LanceDB 0.4 has no mergeInsert,
    // so the merged set is written back in one atomic overwrite — a failure
    // leaves the table as it was.
    const usableId = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    if (records.every((r) => usableId(r.id))) {
      const incoming = new Set(records.map((r) => String(r.id)));
      const kept = toPlainRows(await table.query().toArray())
        .filter((r) => !incoming.has(String(r.id)))
        .map((r) => ({ ...r, vector: Array.from(r.vector || []) }));
      const merged = normalizeRecordsForArrow([...kept, ...records]);
      table = await db.createTable(tableName, merged.records, { schema: merged.schema, mode: 'overwrite' });
      console.log(`Upserted ${records.length} vectors into ${tableName} `
        + `(${kept.length} other records kept, ${merged.records.length} total)`);
    } else {
      await table.add(records);
      console.log(`Added ${records.length} vectors to existing table ${tableName}`);
    }
  }

  return {
    success: true,
    data: records,
    recordCount: records.length,
    message: isNewTable
      ? `Created new table '${tableName}' with ${records.length} vectors`
      : `Added ${records.length} vectors to table '${tableName}'`
  };
}

/**
 * Plain-JS value for anything Arrow hands back.
 *
 * A vector column arrives as an Arrow `Vector`, which BSON/JSON serialisers
 * cannot represent; byte columns stay as they are, since a Uint8Array is
 * exactly what a binary field should be.
 */
function toPlainValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array || value instanceof Int8Array || value instanceof Uint8ClampedArray) {
    return value; // binary payload, not a list of numbers
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value, Number);
  if (Array.isArray(value)) return value.map(toPlainValue);
  if (typeof value.toArray === 'function') return Array.from(value.toArray(), Number); // Arrow Vector
  if (typeof value.toJSON === 'function') return toPlainRow(value);                    // nested StructRow
  return value;
}

/**
 * A LanceDB row as an ordinary object.
 *
 * `table.query().toArray()` yields Arrow `StructRow` PROXIES, not plain
 * objects, and their `set` trap rejects unknown properties. Anything that
 * writes to a row it was handed then fails — the MongoDB driver stamps `_id`
 * onto each document before an insert and dies with "'set' on proxy: trap
 * returned falsish for property '_id'", which names neither LanceDB nor Arrow.
 * The proxies are also not serialisable, so every consumer that forwards these
 * rows (an output node, a preview, a file export) needs real objects.
 */
function toPlainRow(row) {
  if (!row || typeof row !== 'object') return row;
  const source = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const out = {};
  for (const [key, value] of Object.entries(source)) out[key] = toPlainValue(value);
  return out;
}

/** Every row of a LanceDB read, as ordinary objects. See toPlainRow. */
const toPlainRows = (rows) => (Array.isArray(rows) ? rows.map(toPlainRow) : rows);

/**
 * Refuse an append whose vectors are a different width than the table's.
 *
 * Lance stores `vector` as a fixed-size list, so the width is part of the
 * schema and cannot vary between rows. Its own error for this ("`vector` should
 * have type fixed_size_list:float:0 but type was fixed_size_list:float:1536",
 * quoting a path inside the Rust crate) says nothing about which table is
 * wrong or what to do, and a width of 0 is the tell-tale of a table created by
 * an earlier run that wrote empty vectors.
 */
async function assertVectorWidthMatches(table, records, tableName) {
  const width = Array.isArray(records[0]?.vector) ? records[0].vector.length : null;
  if (!width) return;

  let existing = null;
  try {
    const field = (await table.schema()).fields.find((f) => f.name === 'vector');
    existing = typeof field?.type?.listSize === 'number' ? field.type.listSize : null;
  } catch {
    return; // Can't read the schema — let the write attempt report whatever is wrong.
  }
  if (existing === null || existing === width) return;

  const cause = existing === 0
    ? `Table '${tableName}' stores 0-dimension vectors, so it was created by a run that wrote empty ones.`
    : `Table '${tableName}' stores ${existing}-dimension vectors.`;
  throw new Error(
    `${cause} This batch has ${width}-dimension vectors, and a table's vector width cannot change. `
    + `Drop the table (or write to a different table name) and run again.`,
  );
}

/**
 * Normalize a batch of vector records into Arrow-safe rows + an explicit schema.
 *
 * Resolves ONE column type from the whole batch (not a single sample row), then
 * coerces every row to it so a column is never a mix of e.g. numbers and empty
 * strings — the case that makes Arrow throw "Unable to infer Vector type from
 * input values". Empty string / null / undefined are all treated as "missing".
 *
 * Type resolution per column:
 *   - any string value present      → Utf8   (missing → '')
 *   - else any number present       → Float64 (missing → null)
 *   - else any boolean present      → Bool    (missing → null)
 *   - all values missing            → Utf8   (all '')  — keeps the column writable
 * The `vector` column stays a non-nullable FixedSizeList<Float32>.
 *
 * @param {Array<Object>} data - records with { id, vector, ...scalars }
 * @returns {{ records: Array<Object>, schema: arrow.Schema }}
 */
function normalizeRecordsForArrow(data) {
  const isMissing = (v) => v === null || v === undefined || v === '';
  const total = data.length;

  // 1. Walk the WHOLE batch to record every column in first-seen order and, per
  //    scalar column, the concrete types seen + how many rows actually have a
  //    value. Preserving column ORDER matters: LanceDB's table.add() requires an
  //    appended batch's fields to be in the SAME order as the existing table, so
  //    we must NOT reorder (e.g. hoisting `vector` to the front breaks append).
  const order = [];                 // all column keys (incl. 'vector') in first-seen order
  const seen = new Set();
  const typesSeen = new Map();       // scalar key -> Set<'number'|'boolean'|'string'>
  const presentCount = new Map();    // scalar key -> # rows with a non-missing value
  let vectorKey = null;
  let vectorLen = 0;
  for (const rec of data) {
    if (!rec) continue;
    for (const [k, v] of Object.entries(rec)) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
      if (k === 'vector' && Array.isArray(v)) { vectorKey = 'vector'; vectorLen = v.length; continue; }
      if (typeof v === 'object' && v !== null) continue; // skip nested (should already be flattened)
      if (!typesSeen.has(k)) { typesSeen.set(k, new Set()); presentCount.set(k, 0); }
      if (isMissing(v)) continue;
      typesSeen.get(k).add(typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
      presentCount.set(k, presentCount.get(k) + 1);
    }
  }

  // 2. Resolve ONE type per scalar column. A column keeps a numeric/boolean type
  //    ONLY when it is fully populated (every row has a value) and that type is
  //    unambiguous — otherwise it becomes Utf8 with '' for the gaps. This is
  //    deliberate: LanceDB rejects nulls in a column it derives as non-nullable
  //    ("declared as non-nullable but contains null values"), so we emit NO
  //    nulls at all — missing cells are empty strings in a string column.
  const colType = new Map();
  for (const k of typesSeen.keys()) {
    const set = typesSeen.get(k);
    const full = presentCount.get(k) === total;
    colType.set(k, (full && set.size === 1) ? [...set][0] : 'string');
  }

  // Emit columns in their original order; drop skipped nested-object keys.
  const cols = order.filter((k) => k === vectorKey || colType.has(k));

  // 3. Coerce every record to the resolved per-column type, filling missing keys.
  //    number/boolean columns are fully populated by construction, so they never
  //    receive a missing value; string columns turn missing into '' (never null).
  const coerce = (v, t) => {
    if (t === 'number') { const n = typeof v === 'number' ? v : Number(v); return Number.isNaN(n) ? 0 : n; }
    if (t === 'boolean') return typeof v === 'boolean' ? v : Boolean(v);
    return isMissing(v) ? '' : (typeof v === 'string' ? v : String(v));
  };
  const records = data.map((rec) => {
    const out = {};
    for (const k of cols) {
      out[k] = (k === vectorKey) ? (rec ? rec[k] : undefined) : coerce(rec ? rec[k] : undefined, colType.get(k));
    }
    return out;
  });

  // 4. Build the explicit Arrow schema from the resolved types, same order.
  //    Explicit Utf8 (not Dictionary) avoids LanceDB IPC/dictionary-encoding issues.
  const fields = cols.map((k) => {
    if (k === vectorKey) {
      return new arrow.Field(
        k,
        new arrow.FixedSizeList(vectorLen, new arrow.Field('item', new arrow.Float32())),
        false,
      );
    }
    const t = colType.get(k);
    const type = t === 'number' ? new arrow.Float64()
      : t === 'boolean' ? new arrow.Bool()
      : new arrow.Utf8();
    return new arrow.Field(k, type, true);
  });
  return { records, schema: new arrow.Schema(fields) };
}

/**
 * Build explicit Arrow schema for LanceDB table
 * This prevents dictionary encoding issues by using plain utf8 strings
 * @param {Object} sampleRecord - Sample record to infer schema from
 * @returns {arrow.Schema} Arrow schema
 */
function buildLanceDBSchema(sampleRecord) {
  const fields = [];

  for (const [key, value] of Object.entries(sampleRecord)) {
    if (key === 'vector' && Array.isArray(value)) {
      // Vector field: use FixedSizeList of Float32
      fields.push(
        new arrow.Field(
          key,
          new arrow.FixedSizeList(value.length, new arrow.Field('item', new arrow.Float32())),
          false // not nullable
        )
      );
    } else if (typeof value === 'string') {
      // String field: use Utf8 (NOT Dictionary) to avoid IPC errors
      fields.push(new arrow.Field(key, new arrow.Utf8(), true));
    } else if (typeof value === 'number') {
      // Number field: use Float64 for safety
      fields.push(new arrow.Field(key, new arrow.Float64(), true));
    } else if (typeof value === 'boolean') {
      // Boolean field
      fields.push(new arrow.Field(key, new arrow.Bool(), true));
    } else if (typeof value === 'object' && value !== null) {
      // Skip objects/arrays - they should have been flattened before reaching schema builder
      console.warn(`Skipping object field '${key}' in schema - objects should be flattened`);
      continue;
    } else {
      // Null, undefined, or other types: default to Utf8 string
      fields.push(new arrow.Field(key, new arrow.Utf8(), true));
    }
  }

  return new arrow.Schema(fields);
}

/**
 * Query similar vectors from LanceDB table
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Object} config - Query configuration
 * @param {Array} config.queryVector - Query vector
 * @param {Number} config.limit - Result limit (default: 10)
 * @param {String} config.filter - Optional filter expression
 * @returns {Promise<Object>} Query results
 */
async function queryVectors(db, tableName, config) {
  const { queryVector, limit = 10, filter } = config;

  if (!queryVector || !Array.isArray(queryVector)) {
    throw new Error('Query vector is required for similarity search');
  }

  try {
    const table = await db.openTable(tableName);

    // @lancedb/lancedb 0.4.x removed `table.search(...)` and `query.execute()`.
    // Use `query().nearestTo(vector)` and `toArray()` per the current API.
    let query = table.query().nearestTo(queryVector).limit(limit);

    if (typeof filter === 'string' && filter.trim() !== '') {
      query = query.where(filter);
    } else if (filter && typeof filter === 'object' && Object.keys(filter).length > 0) {
      // Metadata-object filter (Pinecone-style) isn't supported by LanceDB —
      // surface a clear error rather than silently ignoring it.
      throw new Error('LanceDB filter must be a SQL WHERE string, not an object');
    }

    const results = toPlainRows(await query.toArray());

    return {
      success: true,
      data: results,
      recordCount: results.length,
      message: `Found ${results.length} similar vectors`
    };
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return {
        success: false,
        message: `Table '${tableName}' does not exist`,
        data: [],
        recordCount: 0
      };
    }
    throw error;
  }
}

/**
 * Delete vectors from LanceDB table
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Object} config - Delete configuration
 * @param {String} config.filter - Filter expression (e.g., "id = '123'")
 * @returns {Promise<Object>} Delete result
 */
async function deleteVectors(db, tableName, config) {
  const { filter } = config;

  if (!filter) {
    throw new Error('Filter is required for delete operation');
  }

  try {
    const table = await db.openTable(tableName);

    await table.delete(filter);

    return {
      success: true,
      message: `Deleted vectors matching filter from table '${tableName}'`
    };
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return {
        success: false,
        message: `Table '${tableName}' does not exist`
      };
    }
    throw error;
  }
}

/**
 * Update vectors in LanceDB table
 * Note: LanceDB doesn't have direct update, so we delete and re-add
 * @param {Object} db - LanceDB connection
 * @param {String} tableName - Table name
 * @param {Object} config - Update configuration
 * @param {String} config.filter - Filter to identify records to update
 * @param {Array} config.updates - Updated records with new data
 * @returns {Promise<Object>} Update result
 */
async function updateVectors(db, tableName, config) {
  const { filter, updates } = config;

  if (!filter) {
    throw new Error('Filter is required for update operation');
  }

  if (!updates || updates.length === 0) {
    throw new Error('No update data provided');
  }

  try {
    const table = await db.openTable(tableName);

    // Delete old records
    await table.delete(filter);

    // Add updated records
    await table.add(updates);

    return {
      success: true,
      recordCount: updates.length,
      message: `Updated ${updates.length} vectors in table '${tableName}'`
    };
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return {
        success: false,
        message: `Table '${tableName}' does not exist`
      };
    }
    throw error;
  }
}

/**
 * List all tables in LanceDB
 * @param {Object} config - Configuration
 * @returns {Promise<Array<String>>} Array of table names
 */
async function listTables(config = {}) {
  // Pointed straight at a dataset: that path names one table and one table
  // only. Listing the parent instead would report every unrelated `.lance`
  // sitting next to it, which for an export saved to ~/Downloads is the whole
  // folder — so answer with the single table the path actually names.
  if (isLanceDatasetDir(config.dbPath)) {
    return [path.basename(config.dbPath).replace(/\.lance$/i, '')];
  }
  const db = await getLanceDBConnection(config);
  const tables = await db.tableNames();
  return tables;
}

/**
 * Get table info
 * @param {String} tableName - Table name
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Table information
 */
async function getTableInfo(tableName, config = {}) {
  const target = normalizeLanceTarget({ ...config, tableName });
  const db = await getLanceDBConnection({ ...config, dbPath: target.dbPath });

  try {
    const table = await db.openTable(target.tableName);
    const count = await table.countRows();

    return {
      success: true,
      tableName: target.tableName,
      recordCount: count
    };
  } catch (error) {
    return {
      success: false,
      message: `Table '${target.tableName}' not found`
    };
  }
}

/**
 * Drop table
 * @param {String} tableName - Table name
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Result
 */
async function dropTable(tableName, config = {}) {
  const target = normalizeLanceTarget({ ...config, tableName });
  const db = await getLanceDBConnection({ ...config, dbPath: target.dbPath });

  try {
    await db.dropTable(target.tableName);
    return {
      success: true,
      message: `Table '${target.tableName}' dropped successfully`
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to drop table '${target.tableName}': ${error.message}`
    };
  }
}

/**
 * Single-entry runQuery wrapper used by buildSkillHelpers / ctx.runQuery.
 * Dispatches to the existing executeLanceDBOperation switch.
 *
 * query shape: {
 *   operation: 'query' | 'queryVectors' | 'upsert' | 'delete' | 'update' | 'list' | 'count',
 *   tableName?, table?,
 *   data?,                           // upsert
 *   queryVector?, limit?, topK?,     // query
 *   filter?,                         // query/delete/update
 *   updates?                         // update
 * }
 *
 * 'list' is a convenience for "give me everything (or filtered) up to limit".
 * 'count' returns [{ count }] — the table's row count, or the rows matching a
 * where-filter — without reading a single row.
 * 'queryVectors' is a synonym for 'query' so the AI's mental model lines up
 * with the connector-side API used by Pinecone.
 */
async function runQuery({ dbPath, ...query } = {}) {
  const op = (query.operation || 'list').toLowerCase();
  // A connection pointed at a `.lance` dataset resolves to its parent database
  // plus that dataset's name, so a query works whether the saved path names the
  // database or the table (see normalizeLanceTarget).
  const config = normalizeLanceTarget({ dbPath, tableName: query.tableName || query.table });
  const { tableName } = config;

  if (op === 'upsert') {
    // `overwrite` has to survive this hop: it is what makes a "new table" write
    // idempotent, and dropping it here silently turned every re-run into an
    // append onto the previous run's schema.
    return executeLanceDBOperation({
      operation: 'upsert',
      data: query.data,
      config: { ...config, overwrite: query.overwrite === true },
    });
  }

  if (op === 'query' || op === 'queryvectors') {
    const limit = query.topK || query.limit || 10;
    const result = await executeLanceDBOperation({
      operation: 'query',
      config: { ...config, queryVector: query.queryVector, limit, filter: query.filter }
    });
    return result.data || [];
  }

  if (op === 'delete') {
    return executeLanceDBOperation({
      operation: 'delete',
      config: { ...config, filter: query.filter }
    });
  }

  if (op === 'update') {
    return executeLanceDBOperation({
      operation: 'update',
      config: { ...config, filter: query.filter, updates: query.updates }
    });
  }

  // 'list': open the table, optionally apply a where-filter, return rows up
  // to limit. No query vector → LanceDB returns rows in insertion order.
  // Without a limit every row comes back — a plain LanceDB query has none of
  // its own. It used to default to 1000, so code that counted or scanned a
  // bigger table got a silently short answer.
  if (op === 'list') {
    const db = await getLanceDBConnection(config);
    const table = await db.openTable(tableName);
    let q = table.query();
    const limit = Number(query.limit);
    if (Number.isFinite(limit) && limit > 0) q = q.limit(limit);
    if (typeof query.filter === 'string' && query.filter.trim() !== '') q = q.where(query.filter);
    return toPlainRows(await q.toArray());
  }

  if (op === 'count') {
    const db = await getLanceDBConnection(config);
    const table = await db.openTable(tableName);
    const filter = typeof query.filter === 'string' && query.filter.trim() !== '' ? query.filter : undefined;
    return [{ count: await table.countRows(filter) }];
  }

  throw new Error(`Unknown LanceDB operation: ${op}. Supported: list, count, query (queryVectors), upsert, delete, update.`);
}

/** getTables({ dbPath }) — lists all tables in the LanceDB database. */
async function getTables({ dbPath } = {}) {
  return listTables({ dbPath });
}

/** getColumns({ dbPath, table }) — infer columns from one sample row. */
async function getColumns({ dbPath, table } = {}) {
  if (!table) return [];
  const target = normalizeLanceTarget({ dbPath, tableName: table });
  const db = await getLanceDBConnection({ dbPath: target.dbPath });
  const t = await db.openTable(target.tableName);
  const sample = await t.query().limit(1).toArray();
  if (!sample.length) return [];
  // Through toPlainRow first: a raw sample row is an Arrow StructRow whose
  // embedding column is a Float32Array, which `Array.isArray` says no to — so
  // the one column a vector search actually needs was reported as a generic
  // 'object' and nothing downstream could pick it out.
  return Object.entries(toPlainRow(sample[0])).map(([name, value]) => ({
    name,
    type: Array.isArray(value)
      ? 'vector'
      : (typeof value === 'object' && value !== null ? 'object' : typeof value)
  }));
}

module.exports = {
  getLanceDBConnection,
  executeLanceDBOperation,
  listTables,
  getTableInfo,
  dropTable,
  runQuery,
  getTables,
  getColumns,
  // Path shape helpers — callers that open LanceDB through the client directly
  // still need to tell a database directory from a single `.lance` dataset.
  isLanceDatasetDir,
  normalizeLanceTarget,
  // For callers that read a table through the LanceDB client directly and
  // still need ordinary objects to hand on (see toPlainRow).
  toPlainRow,
  toPlainRows,
  // One Arrow type per column, no nulls, first-seen order — for callers that
  // rewrite a table through the client directly (vector maintenance).
  normalizeRecordsForArrow,
  // How to read LanceDB and Pinecone through runQuery, for prompts. Exposed
  // here because skills reach this module through helpers.lancedb.
  VECTOR_QUERY_GUIDE: require('./vectorQueryGuide').VECTOR_QUERY_GUIDE,
};
