/**
 * Output Execution Helper Functions
 * Shared utilities for executing output operations (export to file or insert to connection)
 */

const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const path = require('path');
const parquet = require('parquetjs');
const avro = require('avsc');
const { batchChunkSizeFor } = require('../lib/batchChunkSize');
const { throwIfCancelled, isCancelledError } = require('./executionCancel');
const { setBatchWindow } = require('./executionLog');
const { openSourcePages, readSourceSchema } = require('./sourcePages');
const {
  destinationType, valueConverters, convertRow, zonedInstantColumns,
} = require('./columnTypes');
const { resolveTableRef } = require('../lib/tableRef');
const { probeTargetTable } = require('../lib/targetShape');
// Needed by the READ as well as the write: an Excel destination has a row
// ceiling, and the reader stops at it rather than filling memory with rows the
// writer can never take.
const xlsxFile = require('../duckdb/xlsx');
const duckdb = require('../duckdb');
const lanceLib = require('../lib/lancedb');

/**
 * Drain a page stream into one array.
 *
 * For the destinations that genuinely cannot take rows a page at a time — a
 * file rewritten whole, an object PUT to cloud storage, a vector upsert — the
 * whole set has to exist at once and there is no way around it. What has gone
 * is the CAP: this reads however many rows there are, where the old path
 * stopped at a million and said nothing.
 */
async function collectPages(pages, { guard = null } = {}) {
  const all = [];
  for await (const page of pages) {
    throwIfCancelled('reading the source', `${all.length} rows read so far`);
    // push-spread would blow the stack on a page of any size; this is the
    // boring loop that doesn't.
    for (const row of page) all.push(row);

    // Stop the moment the destination's own ceiling is passed.
    //
    // Without this, an Excel export of a ten-million-row source read all ten
    // million — minutes of work and gigabytes of heap — and only then handed
    // them to a writer that cannot take a tenth of them, dying with
    // "RangeError: Too many properties to enumerate" from inside SheetJS. The
    // rows past the limit can never be written, so reading them is pure waste;
    // one page over is enough to know.
    //
    // The guard is given the FIRST ROW as well as the count, because the real
    // ceiling depends on the column count and that is not knowable until a row
    // has been seen. It throws; it never trims. Silently writing the first
    // 1,048,575 rows of a larger source is exactly the kind of quiet truncation
    // this whole change set exists to remove.
    if (guard) guard(all.length, all[0]);
  }
  return all;
}

/**
 * Read the first page without losing it.
 *
 * Two things need the first rows before the load can start — the column list
 * and types for a CREATE TABLE, and the answer to "is this source empty at
 * all" — and both used to come free from an array that was already fully read.
 * Streaming has to ask for one page and then carry on from where it left off,
 * which is what `rest` is: the same stream, first page included.
 *
 * @returns {Promise<{ firstPage: object[]|null, rest: AsyncIterable<object[]> }>}
 *   `firstPage` is null when the source yielded nothing.
 */
async function peekPages(pages) {
  const iterator = pages[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return { firstPage: null, rest: (async function* () {})() };

  return {
    firstPage: first.value,
    rest: (async function* () {
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })(),
  };
}

/**
 * SQLite's column-type names, kept here for ONE reason: as the last-resort
 * fallback when a connector declares no `types` block of its own.
 *
 * Every dialect's names live on its connector now (`plugin.types`, see
 * plugins/connectors/snowflake/index.js). They used to be a hardcoded table in
 * this file with five entries and a silent `|| DIALECTS.sqlite`, so every
 * destination it did not happen to name — snowflake, redshift, duckdb — was
 * handed SQLite's names without a word. A Snowflake output node created
 * `("total_amount" REAL, "transaction_date" TEXT)` and survived only because
 * REAL and TEXT are aliases there; on Redshift a bare TEXT silently means
 * VARCHAR(256) and truncates every longer value on load.
 */
const SQLITE_TYPES = {
  NULL: () => 'TEXT',
  DATE_ONLY: () => 'TEXT',
  TIMESTAMP: () => 'TEXT',
  BOOLEAN: () => 'INTEGER',
  INTEGER: () => 'INTEGER',
  FLOAT: () => 'REAL',
  OBJECT: () => 'TEXT',
  STRING: () => 'TEXT',
};

/**
 * The type names to build this destination's CREATE TABLE with.
 *
 * A SQL connector with no `types` block is a bug in that connector, not a
 * situation to paper over: the old fallback was silent, which is why a
 * Snowflake destination emitted SQLite DDL for as long as it did. Name the
 * connector that needs the block so the next one is a one-line fix.
 *
 * @param {Object|null} plugin - The destination connector.
 * @param {string} dbType - Its id, for the message.
 * @returns {Object} A map of the shape in SQLITE_TYPES.
 */
function dialectFor(plugin, dbType) {
  if (plugin && plugin.types) return plugin.types;
  console.warn(
    `[Output] Connector "${dbType}" declares no "types" block — falling back to `
    + `SQLite's column types, which are probably wrong for it. Add a "types" block `
    + `to plugins/connectors/${dbType}/index.js (see the snowflake connector).`,
  );
  return SQLITE_TYPES;
}

// Helper for VARCHAR size logic
/**
 * Infer the SQL column type for one column from its sampled values.
 *
 * This decides what the column HOLDS — all integers, has a time component,
 * nested objects. What that is CALLED belongs to the destination, and arrives
 * as `dialect` (a `plugin.types` map; see dialectFor above). Passing a dbType
 * string instead is what let an unrecognised engine quietly receive SQLite's
 * names, so the name is no longer this function's business.
 *
 * @param {string} columnName - Column name (unused; kept for call-site clarity).
 * @param {Array} sampleValues - Sampled values from the column.
 * @param {Object} dialect - The destination's type map.
 * @returns {string} SQL column type definition.
 */
function inferColumnType(columnName, sampleValues, dialect = SQLITE_TYPES) {
  const validValues = sampleValues.filter(v => v !== null && v !== undefined);

  // Through destinationType so a kind the dialect lacks (BIGINT on SQLite)
  // takes its fallback rather than coming back undefined.
  const typeName = (key, len) => {
    const named = destinationType(dialect, { kind: key }, len);
    if (named) return named;
    const entry = SQLITE_TYPES[key];
    return typeof entry === 'function' ? entry(len) : entry;
  };

  if (validValues.length === 0) {
    // Nothing to infer from — the dialect's own answer for a column of nulls.
    return typeName('NULL', 0);
  }

  // 2. State tracking for single-pass detection
  let isAllDates = true;
  let hasTimeComponent = false;
  let isAllBools = true;
  let isAllInts = true;
  let needs64Bits = false;
  let isAllFloats = true;
  let hasObjects = false;
  let maxLength = 0;

  // 3. Single Pass Loop
  for (const v of validValues) {
    const strV = String(v);
    if (strV.length > maxLength) maxLength = strV.length;

    // Object Check
    const isObj = typeof v === 'object' && v !== null && !(v instanceof Date);
    if (isObj) hasObjects = true;

    // Date/Timestamp Check
    if (isAllDates) {
      const isDateInstance = v instanceof Date;
      const isDateStr = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
      
      if (isDateInstance || isDateStr) {
        // If any value contains a colon (:) or 'T', it has a time component
        if (strV.includes(':') || strV.includes('T')) {
          hasTimeComponent = true;
        }
      } else {
        isAllDates = false;
      }
    }

    // Boolean Check — real booleans only. Text that reads "true"/"false" on
    // the first rows is still text: a later "yes" in the same column was
    // silently stored as TRUE once the column had been made BOOLEAN.
    if (isAllBools && typeof v !== 'boolean') isAllBools = false;

    // Number Check. A string with a leading zero ("02947", a ZIP or a code)
    // is an identifier, not a number: as one it loses the zero for good.
    if (isAllFloats) {
      const isNum = typeof v === 'number'
        || (typeof v === 'string' && strV.trim() !== '' && !isNaN(Number(v))
          && !/^\s*[+-]?0\d/.test(strV));
      if (!isNum) {
        isAllInts = false;
        isAllFloats = false;
      } else if (isAllInts && !Number.isInteger(Number(v))) {
        isAllInts = false;
      } else if (isAllInts && Math.abs(Number(v)) > 2147483647) {
        needs64Bits = true;
      }
    }
  }

  // 4. Final Type Resolution
  if (isAllDates) {
    return typeName(hasTimeComponent ? 'TIMESTAMP' : 'DATE_ONLY', maxLength);
  }
  if (isAllBools) return typeName('BOOLEAN', maxLength);
  // Past 2^31 a 32-bit INTEGER overflows on the first such row.
  if (isAllInts) return typeName(needs64Bits ? 'BIGINT' : 'INTEGER', maxLength);
  if (isAllFloats) return typeName('FLOAT', maxLength);
  if (hasObjects) return typeName('OBJECT', maxLength);

  // Default to String
  return typeName('STRING', maxLength);
}

/**
 * Infer column types for all columns from sample data
 * @param {Array} data - Array of data rows
 * @param {Object} dialect - The destination's type map (see dialectFor)
 * @param {number} sampleSize - Number of rows to sample for type inference
 * @param {string[]} [columns] - Columns to type; defaults to the first row's keys.
 * @returns {Object} Map of column names to SQL types
 */
function inferColumnTypes(data, dialect = SQLITE_TYPES, sampleSize = 100, columns = null) {
  if (!data || data.length === 0) return {};

  columns = columns || Object.keys(data[0]);
  const columnTypes = {};

  // Sample rows for type inference (use first N rows)
  const sampleRows = data.slice(0, Math.min(sampleSize, data.length));

  columns.forEach(col => {
    const sampleValues = sampleRows.map(row => row[col]);
    columnTypes[col] = inferColumnType(col, sampleValues, dialect);
  });

  return columnTypes;
}

/**
 * Infer Parquet schema from data
 * @param {Array} data - Array of data rows
 * @returns {Object} Parquet schema definition
 */
/**
 * The shape of one column, decided ONCE and then used by both the schema and
 * the row writer.
 *
 * Inference and writing used to be independent: the schema was read off the
 * first sampled value while every row was written as-is. Anything the
 * inference had no case for — an embedding vector, a nested object — became
 * `string`/`UTF8` in the schema and was still handed over as an array, so the
 * encoder rejected it ("invalid [\"null\",\"string\"]: [0.0375…]"). A column
 * of mixed types failed the same way.
 *
 * Returns { kind, items? } where kind is one of:
 *   boolean | long | double | timestamp | array | string
 */
function inferColumnShape(sampleValues) {
  if (sampleValues.length === 0) return { kind: 'string' };

  const every = (test) => sampleValues.every(test);

  if (every((v) => typeof v === 'boolean')) return { kind: 'boolean' };
  if (every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { kind: every(Number.isInteger) ? 'long' : 'double' };
  }
  if (every((v) => v instanceof Date)) return { kind: 'timestamp' };
  if (every(Array.isArray)) {
    const elements = sampleValues.flat().filter((v) => v !== null && v !== undefined);
    if (elements.length === 0) return { kind: 'array', items: 'string' };
    if (elements.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { kind: 'array', items: elements.every(Number.isInteger) ? 'long' : 'double' };
    }
    return { kind: 'array', items: 'string' };
  }
  // Mixed types, objects, or anything else: text, written as JSON where the
  // value is not already a string.
  return { kind: 'string' };
}

/** Per-column shapes for a batch of rows, keyed by column name. */
function inferColumnShapes(data) {
  const shapes = {};
  if (!data || data.length === 0) return shapes;
  const sample = data.slice(0, 100);
  Object.keys(data[0]).forEach((col) => {
    shapes[col] = inferColumnShape(
      sample.map((row) => row[col]).filter((v) => v !== null && v !== undefined),
    );
  });
  return shapes;
}

/** A single value in the shape its column was declared as. */
function coerceExportValue(value, shape, { arraysAsJson = false } = {}) {
  if (value === null || value === undefined) return null;
  switch (shape.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : Boolean(value);
    case 'long':
    case 'double':
      return typeof value === 'number' ? value : Number(value);
    case 'timestamp':
      return value instanceof Date ? value.getTime() : Number(value);
    case 'array': {
      if (!Array.isArray(value)) return arraysAsJson ? JSON.stringify(value) : [];
      // A null inside a typed list has no representation in either encoder;
      // substitute the zero value for the item type rather than fail the row.
      const items = value.map((v) => {
        if (v === null || v === undefined) return shape.items === 'string' ? '' : 0;
        if (shape.items === 'string') return typeof v === 'string' ? v : JSON.stringify(v);
        return typeof v === 'number' ? v : Number(v);
      });
      return arraysAsJson ? JSON.stringify(items) : items;
    }
    default:
      if (typeof value === 'string') return value;
      if (value instanceof Date) return value.toISOString();
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** A whole row in the shapes its columns were declared as. */
function coerceExportRow(row, shapes, options) {
  const out = {};
  Object.keys(row).forEach((key) => {
    const shape = shapes[key] || { kind: 'string' };
    out[key] = coerceExportValue(row[key], shape, options);
  });
  return out;
}

function inferParquetSchema(data, shapes = inferColumnShapes(data)) {
  if (!data || data.length === 0) return {};

  const schema = {};
  Object.keys(shapes).forEach((col) => {
    const shape = shapes[col];
    if (shape.kind === 'boolean') {
      schema[col] = { type: 'BOOLEAN', optional: true };
    } else if (shape.kind === 'long') {
      schema[col] = { type: 'INT64', optional: true };
    } else if (shape.kind === 'double') {
      schema[col] = { type: 'DOUBLE', optional: true };
    } else if (shape.kind === 'timestamp') {
      schema[col] = { type: 'TIMESTAMP_MILLIS', optional: true };
    } else {
      // Lists included: this writer emits them as JSON text rather than a
      // repeated field, so a vector column stays readable without depending on
      // the library's list support.
      schema[col] = { type: 'UTF8', optional: true };
    }
  });

  return schema;
}

/**
 * Infer Avro schema from data
 * @param {Array} data - Array of data rows
 * @returns {Object} Avro schema definition
 */
function inferAvroSchema(data, shapes = inferColumnShapes(data)) {
  if (!data || data.length === 0) {
    return {
      type: 'record',
      name: 'ExportedData',
      fields: []
    };
  }

  const avroTypeFor = (shape) => {
    switch (shape.kind) {
      case 'boolean': return 'boolean';
      case 'long': return 'long';
      case 'double': return 'double';
      case 'timestamp': return 'long'; // Store as timestamp
      // A list keeps its element type here — an embedding exports as a real
      // array of doubles, which is what any Avro reader expects to find.
      case 'array': return { type: 'array', items: shape.items };
      default: return 'string';
    }
  };

  const fields = Object.keys(shapes).map((col) => ({
    name: col,
    // Make all fields nullable
    type: ['null', avroTypeFor(shapes[col])],
  }));

  return {
    type: 'record',
    name: 'ExportedData',
    fields: fields
  };
}

/**
 * Execute output operation - export to local file or insert to database connection
 * @param {Object} sourceConnection - Source connection configuration
 * @param {Object} sourceTableSchema - Source table schema with columns and tableName
 * @param {Object} outputSettings - Output settings (outputType, format, savePath, connectionId, tableName, sheetName)
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @param {Function} getDb - Function to get an app-metadata datastore by collection name
 * @param {Object} [skillHelpers] - Helpers bundle for skill calls (e.g. vector-db-executor)
 * @returns {Promise<Object>} Result with success, message, filePath/rowsInserted
 */
// What a vector store keeps next to a row's own data: the vector itself and the
// embedding bookkeeping the vector skill writes (see INTERNAL_FIELDS in
// plugins/skills/vector-db-executor). The record `id` is kept — it is data.
const VECTOR_MACHINERY_FIELDS = new Set([
  'vector', 'values', 'embedding', '__vid',
  '_content_hash', '_meta_hash',
  '_embedded_column', '_embedding_provider', '_embedding_model', '_embedded_at',
]);

const isVectorType = (plugin, dbType) =>
  plugin?.dbCategory === 'Vector' || dbType === 'pinecone' || dbType === 'lancedb';

function isVectorSource(sourceConnection, pluginManager) {
  if (!sourceConnection) return false;
  return isVectorType(pluginManager.getConnector(sourceConnection.dbType), sourceConnection.dbType);
}

async function isVectorDestination(outputSettings, pluginManager, getDb) {
  if (outputSettings.outputType === 'local') return outputSettings.format === 'lancedb';
  if (outputSettings.outputType !== 'connection' || !outputSettings.connectionId) return false;
  const target = (await getDb('connections').findAsync({}))
    .find((c) => c.id === outputSettings.connectionId);
  return !!target && isVectorType(pluginManager.getConnector(target.dbType), target.dbType);
}

function stripVectorFields(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (VECTOR_MACHINERY_FIELDS.has(k)) continue;
    // Pinecone rows carry their fields under `metadata`, bookkeeping included.
    out[k] = (k === 'metadata' && v && typeof v === 'object' && !Array.isArray(v))
      ? stripVectorFields(v)
      : v;
  }
  return out;
}

async function* withoutVectorColumns(pages) {
  for await (const page of pages) yield page.map(stripVectorFields);
}

async function executeOutput(
  sourceConnection,
  sourceTableSchema,
  outputSettings,
  pluginManager,
  getFullConfig,
  getDb,
  skillHelpers = null
) {
  try {
    const { outputType, format, savePath, connectionId, tableName, sheetName } = outputSettings;
    // How this node treats what is already at the destination.
    //
    //   'append'   add these rows to whatever is there (the default, and what
    //              every output node did before this option existed)
    //   'truncate' empty the table/collection/tab/index first, then insert
    //
    // Only a destination that can hold rows ACROSS runs has a choice to make.
    // A file — local export or an object in cloud storage — is rewritten whole
    // every time by definition, so it is always effectively 'truncate' and the
    // setting is ignored rather than half-honoured. The exception is a LanceDB
    // file: it is a vector database, and it is written exactly like a LanceDB
    // connection (append = upsert, truncate = replace).
    const writeMode = outputSettings.writeMode === 'truncate' ? 'truncate' : 'append';
    // A vector destination (LanceDB file, Pinecone, a LanceDB connection) fed
    // plain rows embeds this column on the way out. Ignored by every other
    // destination, and by rows that already carry vectors.
    const embedding = outputSettings.embedColumn
      ? {
        columnToEmbed: outputSettings.embedColumn,
        embeddingProvider: outputSettings.embeddingProvider || 'openai',
        embeddingModel: outputSettings.embeddingModel || 'text-embedding-3-small',
      }
      : null;
    // The row's primary key for a vector destination — optional, picked on the
    // node in Append mode. Kept when the node is switched to Truncate & insert,
    // so its records keep the same ids and a later Append replaces them rather
    // than adding a second copy under a different id scheme.
    const idColumn = outputSettings.idColumn || null;

    // A local export is a file, rewritten whole whatever the setting says. A
    // connection's effective mode is logged once its destination is known (see
    // insertToConnection): a cloud object is a file too.
    console.log(outputType === 'local'
      ? (format === 'lancedb'
        ? `[Output] Starting local LanceDB output operation: ${writeMode}`
        : '[Output] Starting local output operation (replace: the file is rewritten whole)')
      : `[Output] Starting ${outputType} output operation`);

    // Step 0: source and destination on ONE connection? Then the engine can do
    // the copy itself and no row needs to travel through this process. Returns
    // null whenever that is not possible, and everything below runs unchanged.
    const copied = await trySameConnectionCopy({
      sourceConnection,
      sourceTableSchema,
      outputSettings,
      pluginManager,
      getFullConfig,
      getDb,
      sourceName: sourceTableSchema?.tableName || sourceConnection?.name || 'the source',
    });
    if (copied) return copied;

    // Step 1: Open the source for reading — in PAGES, with no row limit.
    //
    // This used to build one array, capped at a million rows by every branch
    // (`readTableHeadAt(path, table, 1000000)`, `.limit(1000000)`, and so on).
    // A ten-million-row source loaded as one million, the node reported
    // "Successfully inserted 1000000 rows", and the run went green — and with
    // writeMode 'truncate' the destination had been emptied first, so the
    // silent truncation was silent data loss. See NodeExecution/sourcePages.js
    // for what each source type can and cannot stream.
    let { pages, pagesAreStreamed } = openSourcePages({
      sourceConnection,
      sourceTableSchema,
      pluginManager,
      getFullConfig,
      lanceLib,
    });

    console.log(
      `[Output] Reading ${sourceTableSchema?.tableName || 'source'} `
      + `(${pagesAreStreamed ? 'streamed' : 'buffered'})`,
    );

    // A vector source written anywhere that is not itself a vector store sends
    // its rows' data, not the store's machinery: the stored vector and the
    // embedding bookkeeping (_content_hash, _embedded_at, …) are dropped. They
    // mean nothing in a SQL table or a file, and a 1536-wide vector serialised
    // into a text column is noise the user never asked for.
    if (isVectorSource(sourceConnection, pluginManager)
      && !(await isVectorDestination(outputSettings, pluginManager, getDb))) {
      console.log('[Output] Vector source → non-vector destination: dropping vector and embedding bookkeeping columns');
      pages = withoutVectorColumns(pages);
    }

    // Whether the destination can take rows a page at a time, or needs the
    // whole set at once.
    //
    // Only a database connection can be fed progressively — its rows go in
    // through repeated batchInserts, which is what the write loop has always
    // done anyway. Everything else here is write-the-whole-thing by nature: a
    // local file is rewritten in full, a cloud object is one PUT, and a vector
    // upsert hands the skill one array. Those still buffer; they are simply no
    // longer capped.
    const destinationTakesPages = outputType === 'connection';


    const sourceName = sourceTableSchema?.tableName || sourceConnection?.name || 'the source';

    // An empty source is not a failure of this node.
    //
    // The write paths below had no notion of "nothing to do": a SQL
    // destination fell through insertToConnection to `success: false, 'No data
    // to insert'`, which failed the node and, with it, the whole run — an
    // empty upstream table reported as a broken output. Mongo was worse: it
    // handed insertMany an empty array, which throws.
    //
    // It is also the one case where writeMode 'truncate' is destructive for
    // nothing. Emptying the destination and then writing zero rows turns an
    // empty source into data loss, which is the same reasoning the failed-read
    // check in sourcePages already applies.
    //
    // Emptiness is now "the reader yielded no pages" rather than "the array is
    // length zero" — which is the same question asked without reading the whole
    // source to answer it. The page-consuming path below learns it from the
    // first page; the buffering path from the array it drains.

    // A local JSON or CSV file is written front to back, so it can be fed
    // straight from the page reader — no array, and no single string holding
    // the whole export. This is the path a large export takes: building it as
    // one string first hit V8's ~512MB string cap and failed the node with
    // "RangeError: Invalid string length", however much memory was free.
    if (outputType === 'local' && STREAMABLE_LOCAL_FORMATS.has(format)) {
      const { rows } = await streamToLocalFile(pages, format, savePath, {
        // Only reached when the source turns out to be empty, so a CSV still
        // gets its header row from the schema the node was configured with.
        fallbackColumns: (sourceTableSchema?.columns || [])
          .map((c) => c?.name).filter(Boolean),
      });
      console.log(`[Output] Wrote ${rows} rows to ${savePath}`);
      const message = `Successfully exported ${rows} rows to ${format === 'json' ? 'JSON' : 'CSV'}`;
      if (rows === 0) {
        return {
          success: true,
          warning: true,
          message: `${message} — "${sourceName}" is empty, so the file contains no rows.`,
          filePath: savePath,
        };
      }
      return { success: true, message, filePath: savePath };
    }

    if (!destinationTakesPages) {
      // Destinations that need the whole set at once. Uncapped, EXCEPT where
      // the destination format has a ceiling of its own — see below.
      //
      // An .xlsx sheet holds at most 1,048,576 rows — a limit of the file
      // format, not of this app, and not one any amount of streaming can lift —
      // and this writer runs out of cells before that on a wide source. Reading
      // past either and then failing wastes the whole read, so the reader stops
      // one page over and says which limit it hit.
      const guard = (outputType === 'local' && format === 'excel')
        ? (seen, sample) => xlsxFile.assertSheetBudgetSoFar(
          seen, sample ? Object.keys(sample).length : 0,
        )
        : null;

      const sourceData = await collectPages(pages, { guard });
      const sourceIsEmpty = sourceData.length === 0;
      console.log(`[Output] Read ${sourceData.length} rows from ${sourceName}`);

      if (outputType === 'local') {
        // Export to local file. An Excel sheet name — and, for the database
        // formats, a table name — falls back to the source table when the node
        // never got one: an older node, or one the AI built before the field
        // existed. That way a workbook still gets a meaningful tab and a
        // database a meaningful table, rather than every node fighting over
        // "Data".
        //
        // A single-dataset file is rewritten whole every run, so an empty source
        // still writes a (headers-only) file rather than being skipped — that is
        // what the node was asked to do. It carries the warning so the run can
        // say why the file has no rows in it.
        const result = await exportToLocalFile(
          sourceData, format, savePath, pluginManager, skillHelpers,
          sheetName || sourceTableSchema?.tableName || null,
          tableName || sourceTableSchema?.tableName || null,
          embedding,
          // LanceDB only: a LanceDB file keeps its records between runs, so it
          // takes the same Append (upsert) / Truncate choice as a connection.
          { writeMode, idColumn },
        );
        if (sourceIsEmpty && result?.success) {
          return {
            ...result,
            warning: true,
            message: `${result.message} — "${sourceName}" is empty, so the file contains no rows.`,
          };
        }
        return result;
      }

      return {
        success: false,
        message: `Invalid output type: ${outputType}`
      };
    }

    // A database destination: rows go in a page at a time and the whole source
    // is never resident.
    //
    // Its column types come from the SOURCE's schema where the source has one
    // (see columnTypes.js); a buffered source with none — Mongo — has every
    // row in hand already, so it is typed over all of them rather than a page.
    const sourceSchema = await readSourceSchema({
      sourceConnection, sourceTableSchema, pluginManager, getFullConfig,
    });
    return await insertToConnection(
      pages, connectionId, tableName, pluginManager, getFullConfig, getDb,
      skillHelpers, writeMode,
      { sourceName, embedding, idColumn, sourceSchema, scanAll: !pagesAreStreamed },
    );

  } catch (error) {
    // A stop the user asked for is not an output failure, and it must reach the
    // runner as an exception: flattened into { success: false } here it would
    // be indistinguishable from a broken write, and the run would be recorded
    // as failed. Every catch between a throwIfCancelled and the runner needs
    // this — see public/NodeExecution/executionCancel.js.
    if (isCancelledError(error)) throw error;

    console.error('Output execution error:', error);
    return {
      success: false,
      message: `Output execution failed: ${error.message}`,
      error: error.stack
    };
  }
}

/**
 * A table name SQLite and DuckDB will both accept. Same rules as
 * duckdb.sanitizeIdentifier, applied here so the SQLite path — which builds its
 * SQL by hand and cannot bind an identifier as a parameter — can never be handed
 * a name that closes the quoting. Returns null when nothing usable is left, so
 * the caller can fall back rather than write to a table called "_".
 */
function sanitizeTableIdentifier(name) {
  const cleaned = String(name || '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(?=\d)/, '_')
    .slice(0, 80);
  return cleaned && /[a-zA-Z0-9]/.test(cleaned) ? cleaned : null;
}

/**
 * The local formats that are SERIAL — written front to back, one row after
 * another, with nothing to seek back and fix up at the end. Those can be
 * streamed straight to disk; the rest (an .xlsx workbook, a parquet/avro file
 * with a schema and footer, a SQLite/DuckDB database) need the whole set.
 */
const STREAMABLE_LOCAL_FORMATS = new Set(['json', 'csv']);

/**
 * Make sure the folder a local export is being written into exists.
 *
 * The save path is typed or picked in the output node's chat, and nothing
 * guarantees its folder is there — a path under a folder the user has not
 * created yet is an ordinary thing to configure. Every writer below opens the
 * destination directly, so the missing folder surfaced as a raw
 * `ENOENT: no such file or directory, open '…/s01.csv.part'` naming the scratch
 * file rather than the folder, from a node that had already read its source.
 *
 * Creating it is what the rest of the app does for paths it owns (a cloud file
 * refreshed in place, a workflow database), and it is the only reading of the
 * user's intent that makes sense: they named where the file goes.
 */
function ensureSaveDir(savePath) {
  const dir = path.dirname(String(savePath || ''));
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write a JSON or CSV export to disk a page at a time.
 *
 * Neither the rows nor the text is ever resident in full, and that matters for
 * more than memory. `JSON.stringify(allRows, null, 2)` on a large export died
 * with "RangeError: Invalid string length": V8 refuses to build a single string
 * past ~512MB, a ceiling no amount of RAM lifts and which a pretty-printed
 * export reaches at a few million rows. Serializing one row at a time has no
 * such limit — the biggest string here is one row (JSON) or one 5,000-row page
 * (CSV).
 *
 * The file is built beside the destination and renamed over it only once it is
 * complete, so a run that fails or is cancelled half way leaves the previous
 * export intact instead of a truncated file that still looks like one.
 *
 * @param {AsyncIterable<object[]>} pages - The source, in pages
 * @param {string} format - 'json' or 'csv'
 * @param {string} savePath - File path to write
 * @param {{ fallbackColumns?: string[] }} options - Column names to use for a
 *   CSV header when the source turns out to be empty, so an empty export is
 *   still a readable headers-only file rather than a blank one.
 * @returns {Promise<{ rows: number }>}
 */
async function streamToLocalFile(pages, format, savePath, { fallbackColumns = null } = {}) {
  ensureSaveDir(savePath);
  const partPath = `${savePath}.part`;
  const stream = fs.createWriteStream(partPath, { encoding: 'utf8' });

  // One error listener for the life of the stream. Attaching a fresh one per
  // write would pile up thousands of listeners on a large export.
  let streamError = null;
  stream.on('error', (err) => { streamError = streamError || err; });

  // Respecting backpressure is what makes this actually stream: without the
  // drain wait, every chunk queues in the stream's internal buffer and the
  // whole file ends up in memory regardless.
  const write = (chunk) => {
    if (streamError) return Promise.reject(streamError);
    if (stream.write(chunk)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        stream.off('drain', onDrain);
        stream.off('error', onError);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  };

  const close = () => new Promise((resolve, reject) => {
    stream.end((err) => ((err || streamError) ? reject(err || streamError) : resolve()));
  });

  let rows = 0;
  let fields = null;

  try {
    for await (const page of pages) {
      throwIfCancelled('writing the export', `${rows} rows written so far`);
      if (!page.length) continue;

      if (format === 'json') {
        for (const row of page) {
          // Each row is serialized alone and indented to sit inside the array,
          // reproducing exactly what JSON.stringify(rows, null, 2) produced —
          // without ever building that string.
          const body = JSON.stringify(row, null, 2).split('\n').join('\n  ');
          await write(`${rows === 0 ? '[\n' : ',\n'}  ${body}`);
          rows += 1;
        }
      } else {
        // The column list is fixed from the FIRST page and every later page is
        // written against it, so the columns stay aligned down the file. A
        // whole-array parse could union the keys of every row; a streaming one
        // cannot see rows it has not read yet, and a source whose shape changes
        // half way through would misalign either way.
        if (!fields) fields = [...new Set(page.flatMap((row) => Object.keys(row)))];
        const chunk = new Parser({ fields, header: rows === 0 }).parse(page);
        await write(rows === 0 ? chunk : `\n${chunk}`);
        rows += page.length;
      }
    }

    if (format === 'json') {
      // Close the array. An empty source never opened it, so it gets the whole
      // literal — which is what JSON.stringify([], null, 2) produces too.
      await write(rows === 0 ? '[]' : '\n]');
    } else if (rows === 0 && fallbackColumns?.length) {
      // An empty source still writes a file — that is what the node was asked
      // to do, and a missing file reads as "the run never happened". With the
      // configured columns it can at least be a readable headers-only CSV.
      // Without them it is genuinely empty; json2csv throws on that rather
      // than write nothing, which is why this is guarded.
      await write(new Parser({ fields: fallbackColumns, header: true }).parse([]));
    }

    await close();
    fs.renameSync(partPath, savePath);
    return { rows };
  } catch (err) {
    // Leave the destination as it was, and don't leave the scratch file behind.
    stream.destroy();
    try { fs.unlinkSync(partPath); } catch (_) { /* never existed, or already gone */ }
    throw err;
  }
}

/** Wrap an in-memory array as a page stream, so array callers share one writer. */
async function* pagesFromArray(rows, pageSize = 5000) {
  for (let i = 0; i < rows.length; i += pageSize) yield rows.slice(i, i + pageSize);
}

/**
 * Export data to local file
 *
 * Three of these formats hold MANY datasets in one file — an .xlsx workbook of
 * sheets, a SQLite or DuckDB database of tables — and for those the file is NOT
 * rewritten: an existing one is opened and only the named sheet/table is
 * replaced, so several output nodes can build up a single file, one dataset
 * each, and a hand-made file keeps whatever else is in it. The single-dataset
 * formats (json, csv, parquet, avro) have nothing to preserve and are still
 * written whole.
 *
 * @param {Array} sourceData - Array of data rows
 * @param {string} format - File format (json, csv, excel, duckdb, sqlite, lancedb, parquet, avro)
 * @param {string} savePath - File path to save to
 * @param {string} [sheetName] - Excel only: the sheet to write.
 * @param {string} [tableName] - SQLite / DuckDB / LanceDB only: the table to write.
 * @returns {Promise<Object>} Result with success, message, filePath
 */
async function exportToLocalFile(
  sourceData, format, savePath, pluginManager, skillHelpers = null,
  sheetName = null, tableName = null, embedding = null,
  { writeMode = 'truncate', idColumn = null } = {},
) {
  // Every branch below opens `savePath` — a workbook, a database, a parquet or
  // avro writer — and each would fail its own way on a folder that is not there.
  ensureSaveDir(savePath);

  // The serial formats go through the streaming writer even when the caller
  // already holds an array, so there is one implementation of each and an
  // array-holding caller gets the same ~512MB-string immunity. executeOutput
  // does not come through here for these — it streams from the page reader and
  // never builds the array at all.
  if (STREAMABLE_LOCAL_FORMATS.has(format)) {
    const { rows } = await streamToLocalFile(pagesFromArray(sourceData || []), format, savePath);
    return {
      success: true,
      message: `Successfully exported ${rows} rows to ${format === 'json' ? 'JSON' : 'CSV'}`,
      filePath: savePath,
    };
  }

  if (format === 'excel') {
    // One sheet per output node, named by the node. An existing workbook keeps
    // every other sheet — writing a fresh book would throw the user's other
    // sheets away while reporting success — so several output nodes can build
    // up one file, a sheet each, by pointing at the same path with different
    // sheet names. A path with no file at it gets a new workbook.
    const sheet = xlsxFile.sanitizeSheetName(sheetName);
    const columns = Object.keys(sourceData[0] || {});
    xlsxFile.writeSheet(savePath, sheet, sourceData, columns);
    return {
      success: true,
      message: `Successfully exported ${sourceData.length} rows to sheet "${sheet}" in ${path.basename(savePath)}`,
      filePath: savePath,
      sheetName: sheet
    };
  } else if (format === 'sqlite' || format === 'duckdb') {
    // The table this node writes. It used to be hard-coded to "data", so two
    // output nodes pointed at one file silently overwrote each other and the
    // file could hold only ever one dataset. The node names it now, and the
    // fallback keeps a node built before the field existed writing where it
    // always did.
    //
    // Both engines go through DuckDB: a .duckdb natively, a .sqlite through
    // DuckDB's sqlite extension (`sqlite: true` makes a file that does not
    // exist yet a SQLite database, not a DuckDB one). The file is opened, not
    // rewritten — ingestRowsToTableAt runs CREATE OR REPLACE TABLE on this one
    // table — so whatever else it holds survives, exactly as an .xlsx keeps its
    // other sheets.
    const engine = format === 'sqlite' ? 'SQLite' : 'DuckDB';
    const table = sanitizeTableIdentifier(tableName) || 'data';
    if (sourceData.length === 0) {
      // ingestRowsToTableAt refuses an empty batch (it has no columns to declare
      // a table from). Report it as the empty write it is rather than failing
      // the node — the caller adds the "source is empty" note.
      return {
        success: true,
        message: `No rows to write to table "${table}" in ${path.basename(savePath)}`,
        filePath: savePath,
        tableName: table
      };
    }
    try {
      const { rowCount } = await duckdb.ingestRowsToTableAt(
        sourceData, savePath, table, { mode: 'replace', sqlite: format === 'sqlite' },
      );
      return {
        success: true,
        message: `Successfully exported ${rowCount} rows to table "${table}" in ${path.basename(savePath)}`,
        filePath: savePath,
        tableName: table
      };
    } catch (error) {
      console.error(`${engine} export error:`, error);
      return {
        success: false,
        message: `Failed to export ${engine}: ${error.message}`
      };
    }
  } else if (format === 'parquet') {
    try {
      // Infer schema from data. The same shapes drive the rows below, so what
      // is written can never disagree with what was declared.
      const shapes = inferColumnShapes(sourceData);
      const schemaFields = inferParquetSchema(sourceData, shapes);
      const schema = new parquet.ParquetSchema(schemaFields);

      // Create writer
      const writer = await parquet.ParquetWriter.openFile(schema, savePath);

      // Write rows
      for (const row of sourceData) {
        await writer.appendRow(coerceExportRow(row, shapes, { arraysAsJson: true }));
      }

      await writer.close();

      return {
        success: true,
        message: `Successfully exported ${sourceData.length} rows to Parquet`,
        filePath: savePath
      };
    } catch (error) {
      console.error('Parquet export error:', error);
      return {
        success: false,
        message: `Failed to export Parquet: ${error.message}`
      };
    }
  } else if (format === 'avro') {
    try {
      // Infer schema from data. The same shapes drive the rows below, so what
      // is written can never disagree with what was declared.
      const shapes = inferColumnShapes(sourceData);
      const schemaDefinition = inferAvroSchema(sourceData, shapes);
      const avroType = avro.Type.forSchema(schemaDefinition);

      // Process data (dates become timestamps, lists stay lists, anything the
      // schema calls text is written as text)
      const processedData = sourceData.map(row => coerceExportRow(row, shapes));

      // Write to file. Pipe a BlockEncoder into the file stream and resolve on
      // the FILE stream's finish — avsc's encoder 'finish' fires before the
      // underlying file is flushed to disk, so resolving on it would report
      // success while the file is still empty.
      const fileStream = fs.createWriteStream(savePath);
      const encoder = new avro.streams.BlockEncoder(avroType);
      encoder.pipe(fileStream);
      processedData.forEach(row => encoder.write(row));
      encoder.end();

      return new Promise((resolve, reject) => {
        fileStream.on('finish', () => {
          resolve({
            success: true,
            message: `Successfully exported ${sourceData.length} rows to Avro`,
            filePath: savePath
          });
        });
        const fail = (error) => reject({
          success: false,
          message: `Failed to export Avro: ${error.message}`
        });
        fileStream.on('error', fail);
        encoder.on('error', fail);
      });
    } catch (error) {
      console.error('Avro export error:', error);
      return {
        success: false,
        message: `Failed to export Avro: ${error.message}`
      };
    }
  } else if (format === 'lancedb') {
    // LanceDB export uses the vector-db-executor skill
    try {
      const vectorSkill = pluginManager.getSkill('vector-db-executor');
      if (!vectorSkill) {
        return {
          success: false,
          message: 'Vector database executor skill not found. Please install the vector-db-executor skill to export to LanceDB.'
        };
      }

      const result = await vectorSkill.exportToLanceDB({
        sourceData,
        savePath,
        // A LanceDB database holds many tables, so the node names the one it
        // writes — same as a .duckdb or .sqlite export. Left unset, the skill
        // falls back to naming it after the directory, which is what it did
        // before this was passed.
        tableName,
        embedding,
        // Append upserts into the table (with the skip rule), Truncate
        // replaces it — the same as a LanceDB connection.
        writeMode,
        idColumn,
        helpers: skillHelpers
      });

      return result;
    } catch (error) {
      console.error('LanceDB export error:', error);
      return {
        success: false,
        message: `Failed to export LanceDB: ${error.message}`
      };
    }
  } else {
    return {
      success: false,
      message: `Format ${format} is not supported. Supported formats: json, csv, excel, duckdb, sqlite, lancedb, parquet, avro`
    };
  }
}

/**
 * Empty a table before a load: TRUNCATE, falling back to DELETE.
 *
 * TRUNCATE first because it is far cheaper than a row-by-row DELETE on every
 * engine that has it; SQLite has no TRUNCATE at all and some engines refuse it
 * on a table with inbound foreign keys, so DELETE is the fallback rather than
 * the first choice. Neither is swallowed — silently appending to rows the user
 * asked to have removed is the one outcome worth failing over, so the caller is
 * told when BOTH failed.
 *
 * @returns {Promise<{ok: boolean, error: Error|null}>}
 */
/**
 * How to quote a COLUMN name for this connector: its quoteColumn, which never
 * splits on a dot ("e.mail" stays one identifier). quoteIdentifier is the
 * fallback for a connector that predates quoteColumn — it is built for table
 * references and splits dotted names, which is why it is not the first choice.
 */
function columnQuoter(plugin) {
  if (plugin && typeof plugin.quoteColumn === 'function') return (c) => plugin.quoteColumn(c);
  if (plugin && typeof plugin.quoteIdentifier === 'function') return (c) => plugin.quoteIdentifier(c, null, null);
  return (c) => c;
}

async function clearTable(plugin, fullConfig, connectionId, quotedTableName, label) {
  const attempts = [
    `TRUNCATE TABLE ${quotedTableName}`,
    `DELETE FROM ${quotedTableName}`,
  ];
  let lastError = null;
  for (const query of attempts) {
    try {
      const result = await plugin.runQuery(fullConfig, connectionId, { query });
      if (result && result.success === false) throw new Error(result.message);
      console.log(`[Output] Cleared ${label} with: ${query.split(' ')[0]}`);
      return { ok: true, error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, error: lastError };
}

/**
 * An empty copy of an existing table's COLUMNS, to load a Truncate & insert
 * into before the real table is touched.
 *
 * Truncating first and then loading meant any row the destination refused —
 * a value too long, "N/A" in an integer column — failed the run AFTER the
 * table had been emptied: the old rows were gone and the new ones never
 * arrived. Loading into a copy that has the destination's own column types
 * moves every such refusal to before anything is deleted.
 *
 * Created by the engine from the table itself (no type is re-derived here), so
 * it accepts exactly what the destination would. Two spellings, tried in order
 * the way clearTable tries TRUNCATE then DELETE: CREATE TABLE … AS SELECT (most
 * engines) and SELECT … INTO (SQL Server, which has no CTAS). The name is bare,
 * like a join's staging table, so batchInsert and the swap resolve it the same
 * way the connection resolves any unqualified name.
 *
 * Returns { bare, quoted } or null when neither form worked — the caller then
 * keeps the old truncate-first path rather than refusing a load that used to run.
 */
async function createStagingLike(plugin, fullConfig, connectionId, quotedTableName) {
  const bare = `tlx_stage_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const quoted = typeof plugin.quoteIdentifier === 'function'
    ? plugin.quoteIdentifier(bare, null, fullConfig)
    : bare;
  const attempts = [
    `CREATE TABLE ${quoted} AS SELECT * FROM ${quotedTableName} WHERE 1=0`,
    `SELECT * INTO ${quoted} FROM ${quotedTableName} WHERE 1=0`,
  ];
  for (const query of attempts) {
    try {
      const result = await plugin.runQuery(fullConfig, connectionId, { query });
      if (result && result.success === false) continue;
      return { bare, quoted };
    } catch (_err) {
      // try the next spelling
    }
  }
  return null;
}

/**
 * Replace the destination's rows with the staging table's, as one unit.
 *
 * DELETE (not TRUNCATE) because TRUNCATE is DDL on MySQL and Snowflake and
 * commits on its own, which would split the pair. `WHERE 1=1` because BigQuery
 * refuses a DELETE without a WHERE clause. With a connector that can run a
 * transaction, a failing INSERT rolls the DELETE back and the destination keeps
 * its old rows; without one, the two run back to back — still after the load
 * succeeded, which is where nearly every failure used to happen.
 */
async function swapFromStaging(plugin, fullConfig, connectionId, quotedTableName, stagingQuoted, columnList) {
  const statements = [
    `DELETE FROM ${quotedTableName} WHERE 1=1`,
    `INSERT INTO ${quotedTableName} (${columnList}) SELECT ${columnList} FROM ${stagingQuoted}`,
  ];
  if (typeof plugin.runInTransaction === 'function') {
    const result = await plugin.runInTransaction(fullConfig, connectionId, statements);
    return result && result.success === false
      ? { ok: false, atomic: true, error: new Error(result.message || 'swap failed') }
      : { ok: true, atomic: true };
  }
  for (const query of statements) {
    const result = await plugin.runQuery(fullConfig, connectionId, { query });
    if (result && result.success === false) {
      return { ok: false, atomic: false, error: new Error(result.message || 'swap failed') };
    }
  }
  return { ok: true, atomic: false };
}

/**
 * Copy the source straight into the destination when both are the SAME SQL
 * connection — `INSERT INTO dst (…) SELECT … FROM src`, run by the engine.
 *
 * The ordinary path reads every row out of the database into this process and
 * sends it all back as INSERT literals: for a node whose source and destination
 * are one connection that is two network crossings and a full serialisation
 * round trip for a copy the engine can do internally. Nothing about the result
 * differs; only where the rows travel.
 *
 * Returns null when this cannot be done — the caller then takes the ordinary
 * streaming path, whose behaviour is unchanged. The cases deliberately handed
 * back are:
 *
 *   · a different connection on either side, or a non-SQL one (vector, cloud
 *     storage, Sheets, Mongo) — there is no single engine to run the statement;
 *   · a destination that does NOT already exist. The streaming path creates it,
 *     and it can only do so because it infers the column TYPES from the first
 *     page of rows it read. A path that reads nothing has nothing to infer
 *     from, so a first-ever run falls back and the table exists from then on.
 *
 * The row count comes from a COUNT(*) on the source rather than from the
 * INSERT. Snowflake's runQuery reports `rowCount: rows.length` — for an
 * INSERT…SELECT that is the one-row summary the engine returns, i.e. 1 — and
 * reading the real figure out of it means parsing a column name that is
 * engine-specific prose. The COUNT is dialect-neutral, and it answers "is the
 * source empty" as well, which is what the streaming path gets from its first
 * page.
 *
 * @returns {Promise<Object|null>} An executeOutput-shaped result, or null to fall back.
 */
async function trySameConnectionCopy({
  sourceConnection, sourceTableSchema, outputSettings,
  pluginManager, getFullConfig, getDb, sourceName,
}) {
  const { outputType, connectionId, tableName, writeMode } = outputSettings;
  if (outputType !== 'connection' || !connectionId || !tableName) return null;

  // Same connection on both sides — the whole premise.
  if (!sourceConnection?.id || sourceConnection.id !== connectionId) return null;

  const sourceTable = sourceTableSchema?.tableName;
  if (!sourceTable) return null;

  const connectionsDb = getDb('connections');
  const targetConnection = (await connectionsDb.findAsync({})).find((c) => c.id === connectionId);
  if (!targetConnection) return null;

  const plugin = pluginManager.getConnector(targetConnection.dbType);
  if (!plugin || typeof plugin.runQuery !== 'function' || typeof plugin.getColumns !== 'function') return null;

  // SQL only. A vector upsert embeds, a cloud object is a PUT, Sheets speaks an
  // API and Mongo a document protocol — none of them is a statement the engine
  // can run over its own tables.
  const isCloudStorage = plugin.storageType === 'cloud-storage' || targetConnection.dbType === 'google-sheets';
  const isVector = plugin.dbCategory === 'Vector' || targetConnection.dbType === 'pinecone' || targetConnection.dbType === 'lancedb';
  const isNoSQL = targetConnection.dbType === 'mongodb' || plugin.dbCategory === 'NoSQL';
  if (isCloudStorage || isVector || isNoSQL) return null;

  const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});
  const defaultSchema = targetConnection.dbConfig?.schema || null;

  // Which objects do these two names actually name? ASK THE CONNECTOR — see
  // lib/tableRef.resolveTableRef. Quoting alone is not enough: this used to
  // call getColumns with the name as written, and on Snowflake a destination
  // recorded as `pg_txn_customers` found nothing while PG_TXN_CUSTOMERS sat
  // next to it, so the copy declined, the streaming path created a SECOND
  // table under the quoted lower-case name, and the load went into that.
  //
  // A destination that genuinely does NOT exist still falls back: the
  // streaming path creates it, and it can only do so because it infers the
  // column TYPES from the first page of rows it read. A path that reads
  // nothing has nothing to infer from, so a first-ever run streams and the
  // table exists from then on.
  const dest = await resolveTableRef(plugin, fullConfig, targetConnection.id, tableName, defaultSchema);
  if (!dest.found) return null;

  const src = await resolveTableRef(plugin, fullConfig, targetConnection.id, sourceTable, defaultSchema);
  if (!src.found) return null;

  // Columns of the RESOLVED destination, not of the name as written.
  let destColumns = null;
  try {
    const res = dest.columns
      ? { success: true, columns: dest.columns }
      : await plugin.getColumns(fullConfig, targetConnection.id, dest.schema, dest.table);
    if (res && res.success !== false && Array.isArray(res.columns) && res.columns.length) {
      destColumns = res.columns.map((c) => c.name || String(c));
    }
  } catch (err) {
    console.log(`[Output] Same-connection copy: could not read ${dest.table}:`, err.message || err);
  }
  if (!destColumns) return null;

  // Both refs come from the resolver, which built them with the connector's own
  // quoting around the names the engine really has.
  const quotedDest = dest.quotedRef;
  const quotedSource = src.quotedRef;
  // Columns BARE — quoteIdentifier cannot tell a table from a column, and
  // MySQL's would prepend the database, which is a syntax error in a column
  // list. Same rule the streaming path's CREATE TABLE applies.
  const quotedColumns = destColumns.map(columnQuoter(plugin));
  const columnList = quotedColumns.join(', ');

  // How many rows are about to move. Also the empty-source answer, which has to
  // be known BEFORE a truncate — emptying the destination and then writing
  // nothing turns an empty source into data loss.
  let rowCount;
  try {
    const counted = await plugin.runQuery(fullConfig, targetConnection.id, {
      query: `SELECT COUNT(*) AS n FROM ${quotedSource}`,
    });
    if (!counted || counted.success === false) throw new Error(counted?.message || 'unknown error');
    const row = (counted.rows || counted.data || [])[0] || {};
    // Engines disagree about the case they hand a column alias back in.
    const raw = Object.values(row)[0];
    rowCount = Number(raw);
    if (!Number.isFinite(rowCount)) throw new Error(`unreadable count: ${JSON.stringify(row)}`);
  } catch (err) {
    // Cannot tell how much there is, or cannot read the source at all. Fall
    // back rather than guess — the streaming path reports the read failure
    // properly.
    console.log(`[Output] Same-connection copy: count of ${sourceTable} failed:`, err.message || err);
    return null;
  }

  if (rowCount === 0) {
    console.warn(`[Output] Source "${sourceName}" has no rows — ${tableName} left unchanged`);
    return {
      success: true,
      warning: true,
      message: `No rows to write: "${sourceName}" is empty, so ${tableName} was left unchanged.`,
      rowsInserted: 0,
      rowCount: 0,
    };
  }

  if (writeMode === 'truncate') {
    const cleared = await clearTable(plugin, fullConfig, targetConnection.id, quotedDest, dest.table);
    if (!cleared.ok) {
      return {
        success: false,
        message: `Could not truncate ${dest.table} before loading: ${cleared.error?.message || 'unknown error'}`,
      };
    }
  }

  // One statement, no rows through this process. A column the destination has
  // and the source does not fails here with the engine's own message — the
  // streaming path's shape check needs rows in hand and has nothing to offer.
  const insertSql = `INSERT INTO ${quotedDest} (${columnList}) SELECT ${columnList} FROM ${quotedSource}`;
  console.log(`[Output] Same-connection copy on ${targetConnection.dbType} (${writeMode}): ${insertSql}`);
  const result = await plugin.runQuery(fullConfig, targetConnection.id, { query: insertSql });
  if (!result || result.success === false) {
    return {
      success: false,
      message: `Could not copy ${src.table} into ${dest.table}: ${result?.message || 'unknown error'}`,
    };
  }

  // Report the name the rows actually went to. Where the resolver had to fold
  // the configured name to reach it, that differs from `tableName`, and the
  // run log is the only place a user would ever see which one won.
  return {
    success: true,
    message: `Successfully inserted ${rowCount} rows into ${dest.table}`,
    rowsInserted: rowCount,
    rowCount,
  };
}

/**
 * Insert data to database connection.
 *
 * Takes PAGES, not an array: a large load must not require the whole source to
 * be resident, and the cap that used to make that safe is gone. The SQL and
 * MongoDB branches consume the pages as they arrive; the vector and
 * cloud-storage branches drain them first, because a vector upsert and an
 * object PUT both need the whole set in hand.
 *
 * @param {AsyncIterable<object[]>} pages - Row pages from openSourcePages.
 * @param {string} connectionId - Target connection ID
 * @param {string} tableName - Target table/collection name
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @param {Function} getDb - Function to get an app-metadata datastore by collection name
 * @returns {Promise<Object>} Result with success, message, documentsInserted/rowsInserted
 */
async function insertToConnection(pages, connectionId, tableName, pluginManager, getFullConfig, getDb, skillHelpers = null, writeMode = 'append', {
  sourceName = 'the source', embedding = null, idColumn = null, sourceSchema = null, scanAll = false,
} = {}) {
  const connectionsDb = getDb('connections');
  const targetConnectionDocs = await connectionsDb.findAsync({});
  const targetConnection = targetConnectionDocs.find(c => c.id === connectionId);

  if (!targetConnection) {
    return {
      success: false,
      message: `Connection ${connectionId} not found`
    };
  }

  // Check target type
  const plugin = pluginManager.getConnector(targetConnection.dbType);
  const isCloudStorage = plugin?.storageType === 'cloud-storage' || targetConnection.dbType === 'google-sheets';
  const isVector = plugin?.dbCategory === 'Vector' || targetConnection.dbType === 'pinecone' || targetConnection.dbType === 'lancedb';

  // The mode that actually applies. An object in cloud storage is a file and is
  // replaced whole, so its writeMode is ignored; a Sheets tab, a table, a
  // collection and a vector index honour it.
  const replacesObject = isCloudStorage && targetConnection.dbType !== 'google-sheets';
  console.log(`[Output] Writing to ${targetConnection.name || connectionId} (${targetConnection.dbType}) `
    + `${tableName || ''}: ${replacesObject ? 'replace (the object is rewritten whole)' : writeMode}`);

  /** Nothing came out of the source: leave the destination exactly as it is. */
  const nothingToDo = () => {
    const destination = tableName || 'the destination';
    console.warn(`[Output] Source "${sourceName}" has no rows — ${destination} left unchanged`);
    return {
      success: true,
      warning: true,
      message: `No rows to write: "${sourceName}" is empty, so ${destination} was left unchanged.`,
      rowsInserted: 0,
      rowCount: 0,
    };
  };

  if (isVector) {
    // Vector database - use vector-db-executor skill. Needs the whole set: the
    // skill embeds and upserts one array.
    const sourceData = await collectPages(pages);
    if (sourceData.length === 0) return nothingToDo();
    return await insertToVectorDatabase(sourceData, targetConnection, tableName, pluginManager, getFullConfig, skillHelpers, writeMode, embedding, idColumn);
  }

  if (isCloudStorage) {
    // One object, written whole — there is no append to a PUT.
    const sourceData = await collectPages(pages);
    if (sourceData.length === 0) return nothingToDo();
    // Upload data to cloud storage as JSON or CSV
    const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});

    // Parse containerName and objectName from tableName
    // Format: "bucket-name/path/to/file.json" or "bucket-name/file.csv"
    const parts = tableName.split('/');

    let containerName, objectName, fileName;

    if (parts.length < 2) {
      // Google Sheets: "<spreadsheet>/<tab>" is what the picker records. A bare
      // name is a spreadsheet with no tab named, which writes to (or creates)
      // its first tab.
      if (targetConnection.dbType === 'google-sheets') {
        containerName = tableName;
        objectName = 'Sheet1';
        fileName = objectName;
      } else {
        return {
          success: false,
          message: 'Cloud storage output requires format: "bucket-name/path/to/file.ext" (e.g., "my-bucket/exports/data.json")'
        };
      }
    } else {
      containerName = parts[0];
      objectName = parts.slice(1).join('/');
      fileName = objectName.split('/').pop();
    }

    // Determine format from file extension
    let fileContent;
    let contentType;

    // Google Sheets takes ROWS, not a file: its uploadObject writes cells into
    // a tab. The "file name" here is the tab, so its (absent, or incidental)
    // extension must not decide the payload — always hand it JSON.
    if (targetConnection.dbType === 'google-sheets') {
      fileContent = Buffer.from(JSON.stringify(sourceData), 'utf-8');
      contentType = 'application/json';
    } else if (fileName.endsWith('.json')) {
      // Export as JSON
      fileContent = Buffer.from(JSON.stringify(sourceData, null, 2), 'utf-8');
      contentType = 'application/json';
    } else if (fileName.endsWith('.csv')) {
      // Export as CSV
      const parser = new Parser();
      const csv = parser.parse(sourceData);
      fileContent = Buffer.from(csv, 'utf-8');
      contentType = 'text/csv';
    } else {
      // Default to JSON
      fileContent = Buffer.from(JSON.stringify(sourceData, null, 2), 'utf-8');
      contentType = 'application/json';
    }

    // Upload to cloud storage.
    //
    // For an object store this REPLACES the object — dropping the old file and
    // putting this one in its place — which is the only thing a file write can
    // mean, so `writeMode` has nothing to change. Google Sheets is the
    // exception in this branch: a tab holds rows across runs, so the mode is
    // passed on and its connector either clears the tab first or appends.
    const result = await plugin.uploadObject(
      fullConfig,
      targetConnection.id,
      containerName,
      objectName,
      fileContent,
      contentType,
      { writeMode }
    );

    if (result.success) {
      return {
        success: true,
        message: `Successfully uploaded ${sourceData.length} rows to ${containerName}/${objectName}`,
        rowsUploaded: sourceData.length,
        cloudPath: `${containerName}/${objectName}`
      };
    } else {
      return {
        success: false,
        message: `Failed to upload to cloud storage: ${result.message}`
      };
    }
  }

  const isNoSQLTarget = targetConnection.dbType === 'mongodb';

  if (isNoSQLTarget) {
    // Insert to the MongoDB destination
    {
      const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});
      const plugin = pluginManager.getConnector(targetConnection.dbType);

      // Ask for the first page before touching the destination: an empty
      // source must not reach the truncate below.
      const { firstPage, rest } = await peekPages(pages);
      if (!firstPage) return nothingToDo();

      // Truncate: empty the collection, keeping the collection itself (and its
      // indexes) so this is a load, not a re-create.
      if (writeMode === 'truncate') {
        const cleared = await plugin.runQuery(fullConfig, targetConnection.id, {
          operation: 'deleteMany',
          collection: tableName,
          filter: {}
        });
        if (cleared && cleared.success === false) {
          return { success: false, message: `Failed to truncate ${tableName}: ${cleared.message}` };
        }
        console.log(`[Output] Truncated collection ${tableName}`);
      }

      // One insertMany per page rather than one for the whole source: a ten
      // million document array is not something to build, let alone hand to a
      // driver in a single call.
      let documentsInserted = 0;
      for await (const page of rest) {
        throwIfCancelled(
          'inserting documents',
          `${documentsInserted} documents already written to ${tableName}`,
        );

        // Drop `_id` before inserting. An `_id` identifies a document WITHIN
        // its own collection, and these came out of a different one — carrying
        // it over asks the destination to adopt another collection's identity
        // for the row. The destination mints its own.
        //
        // Left in, the second write of any given source document fails the
        // WHOLE batch with `E11000 duplicate key error ... index: _id_`: an
        // append that re-sends a row it already sent, or a staging collection
        // re-read across runs, becomes a hard error rather than the duplicate
        // row that was asked for.
        //
        // Deleted IN PLACE rather than rebuilt with a rest-spread: these
        // documents were just read for this insert and nothing else holds them,
        // so rebuilding would allocate a second object per row for no gain. The
        // pass is O(page) against an insertMany that already touches every
        // document in it. Only `_id` goes; every other field, including one the
        // source genuinely uses as a key, is untouched.
        for (const doc of page) {
          if (doc !== null && typeof doc === 'object' && '_id' in doc) delete doc._id;
        }

        // A failed operation comes back as { success: false } rather than
        // throwing, so an unchecked call would report every document written
        // when none were — and with writeMode 'truncate' the collection was
        // just emptied, making a silent failure a data loss rather than a no-op.
        const inserted = await plugin.runQuery(fullConfig, targetConnection.id, {
          operation: 'insertMany',
          collection: tableName,
          documents: page
        });
        if (inserted && inserted.success === false) {
          return {
            success: false,
            message: `Failed to insert into ${tableName} after ${documentsInserted} document(s): ${inserted.message}`,
          };
        }
        documentsInserted += page.length;
      }

      return {
        success: true,
        message: `Successfully ${writeMode === 'truncate' ? 'replaced' : 'inserted'} `
          + `${documentsInserted} documents in ${tableName}`,
        documentsInserted
      };
    }
  } else {
    // Insert to SQL database
    const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});
    const plugin = pluginManager.getConnector(targetConnection.dbType);

    // The first page decides the destination's shape, and answers "is there
    // anything to write at all" — both before a single row is sent, and before
    // the truncate below can empty a table for nothing.
    let { firstPage, rest } = await peekPages(pages);

    // A buffered source with no schema of its own (a document store) is typed
    // over EVERY row and every key any row has. Its rows are all in memory
    // already, so this costs no extra read — and a field that first appears on
    // document 6,000, or is a number on the first page and text later, is
    // typed for what it really holds instead of being dropped or failing.
    let allRows = null;
    let columns = null;
    if (firstPage && scanAll && !sourceSchema) {
      allRows = await collectPages(rest);
      const seen = new Set();
      for (const row of allRows) {
        for (const key of Object.keys(row || {})) seen.add(key);
      }
      columns = [...seen];
      rest = (async function* () { if (allRows.length) yield allRows; })();
    }

    if (firstPage) {
      // A source with a schema names its columns; for a document store that
      // is every field any document has (MongoDB's scan), not just the first
      // document's. A key the schema lacks is still kept.
      columns = columns || (sourceSchema
        ? [...new Set([...Object.keys(sourceSchema), ...Object.keys(firstPage[0])])]
        : Object.keys(firstPage[0]));
      // Types are inferred from the FIRST PAGE rather than the whole source.
      //
      // Not a compromise forced by streaming — an improvement. The old code
      // scanned every row it had, which on the capped path meant walking a
      // million rows to pick a column type, and on an uncapped one would mean
      // walking ten million. A page is the same sampling the file importer
      // already does (see chunkedWriter's TYPE_SAMPLE_ROWS), and it is applied
      // to the same rows the CREATE TABLE has to satisfy first.
      //
      // The trade is real and worth naming: a column that is integral for the
      // first page and fractional later now gets the narrower type. That was
      // already true past row 1,000,000; it is simply true sooner.
      const dialect = dialectFor(plugin, targetConnection.dbType);
      const columnTypes = allRows
        ? inferColumnTypes(allRows, dialect, Infinity, columns)
        : inferColumnTypes(firstPage, dialect, 100, columns);
      // With no schema, the values are the only evidence. A column holding
      // nothing but instants with a zone is still an instant: treated as if
      // the source had said TIMESTAMPTZ, so it gets that type and its values
      // are converted to UTC like any other.
      if (!sourceSchema) {
        const zonedCols = zonedInstantColumns(allRows || firstPage, columns);
        if (Object.keys(zonedCols).length > 0) sourceSchema = zonedCols;
      }
      // A column the source declares a type for keeps THAT type, mapped to
      // this destination's name for it. Only the rest are guessed. See
      // columnTypes.js — this is what keeps "02947" text and a 64-bit id
      // a BIGINT.
      if (sourceSchema) {
        const typedFromSchema = [];
        for (const col of columns) {
          const canonical = sourceSchema[col];
          if (!canonical) continue;
          const sampleMaxLen = firstPage.reduce((max, row) => {
            const v = row[col];
            return v == null ? max : Math.max(max, String(v).length);
          }, 0);
          const named = destinationType(dialect, canonical, sampleMaxLen);
          if (named) {
            columnTypes[col] = named;
            typedFromSchema.push(col);
          }
        }
        console.log(`[Output] Column types from the source schema: ${typedFromSchema.length}/${columns.length}`);
      }
      // Values the chosen types need converted on the way in (an instant
      // with an offset → UTC). null when nothing does.
      const converters = valueConverters(sourceSchema, dialect);
      // Quote column identifiers so reserved words (e.g. a "timestamp" column on
      // SQL Server) don't break the CREATE TABLE. Without this the CREATE fails
      // with a syntax error that the try/catch below swallows, leaving the table
      // uncreated — which then resurfaces as an "Invalid object name" on insert.
      // Quote columns BARE — pass neither schema nor config. quoteIdentifier
      // can't tell a table from a column, and MySQL's impl prepends
      // config.database as a qualifier: valid for a table name, but INVALID for a
      // column in a CREATE TABLE / INSERT column list (`db`.`col` is a syntax
      // error). Passing dbConfig here produced `CREATE TABLE `db`.`t`
      // (`db`.`col` INT ...)`, which failed, got swallowed, and surfaced as
      // "table doesn't exist" on insert. Only MySQL reads config; the other SQL
      // connectors ignore it, so bare-quoting is safe for all of them.
      const quoteCol = columnQuoter(plugin);
      const columnDefs = columns.map(col => `${quoteCol(col)} ${columnTypes[col]}`).join(', ');

      // Pass NO schema when the destination carries its own qualifier —
      // otherwise the connection's default ("public", the database name) would
      // win over the schema the user actually named, and the lookup would check
      // the wrong table. This is what stands between a wrong-shape load and a
      // truncate, so it has to check the table the insert will really write to.
      const lookupSchema = tableName.includes('.')
        ? null
        : (targetConnection.dbConfig?.schema || fullConfig?.schema || fullConfig?.database || null);

      // WHICH object does the configured name name? Ask the connector before
      // anything else, because every statement below has to agree about it.
      //
      // The name recorded on an output node comes from the user's prose or from
      // an AI-generated config, not from the catalog, so its case need not
      // match what the engine stored. Quoting it faithfully — which is all
      // quoteIdentifier can do — asked Snowflake for "pg_txn_customers" while
      // PG_TXN_CUSTOMERS sat beside it: the probe reported the table missing,
      // the CREATE below made a second one, and 200 rows went into it without a
      // single error. See lib/tableRef.resolveTableRef.
      const resolved = await resolveTableRef(
        plugin, fullConfig, targetConnection.id, tableName, lookupSchema,
      );

      // The name to WRITE with, and the bare name to hand batchInsert (which
      // quotes internally).
      //
      // When the resolver found nothing these fall back to the configured name,
      // unchanged from what this did before it could resolve anything: that is
      // the first-ever run, and the CREATE below brings the table into
      // existence under exactly that name. NO schema is passed on that path,
      // deliberately — `lookupSchema` falls back to the DATABASE name when the
      // connection records no schema, and on SQL Server that is never a schema
      // (tables live in `dbo`), so qualifying the CREATE with it would build
      // `[mydb].[orders]`. Splitting a qualified name is the connector's job.
      const quotedTableName = resolved.found
        ? resolved.quotedRef
        : ((plugin && plugin.quoteIdentifier)
          ? plugin.quoteIdentifier(tableName, null, targetConnection.dbConfig)
          : tableName);
      const writeTableName = resolved.table || tableName;

      // Does the destination already exist? ASK, rather than issuing a CREATE
      // and reading its failure as "yes".
      //
      // That older probe could not tell one failure from another: a permissions
      // error, an unknown dataset or a bad column type all read as "the table is
      // already there", after which the load continued and failed later with
      // something unrelated to the real cause. It also made every re-run log a
      // full error object (BigQuery's 409 dumps its whole HTTP response) for a
      // condition that is entirely normal.
      //
      // Three outcomes, because "I could not tell" is not the same as "no":
      // a connector without getColumns, or one whose lookup errors, leaves the
      // answer UNKNOWN and we fall back to the create-and-see behaviour.
      //
      // Reads the RESOLVED identity, so the shape check and the truncate below
      // are looking at the table the insert will really write to.
      // The shared probe (lib/targetShape) — the same lookup a join uses to
      // decide whether its kept target still fits. It reads the RESOLVED
      // identity, so the shape check and the truncate below look at the table
      // the insert will really write to.
      const probeTable = () => probeTargetTable({
        plugin,
        config: fullConfig,
        connectionId: targetConnection.id,
        tableName,
        defaultSchema: lookupSchema,
        resolved,
      });

      let probe = await probeTable();
      let tableIsNew = false;

      if (probe.state !== 'exists') {
        // A connector reports a failed statement by RETURNING { success: false },
        // not by throwing — see the postgres/mysql/mssql runQuery, which catch
        // the driver error themselves. Both shapes are handled so a connector
        // that does throw still works.
        // A column name this engine cannot hold fails here, by name, with the
        // fix — rather than as whatever the CREATE says (MySQL's "Identifier
        // name … is too long"), or not at all where the engine silently
        // shortens it (Postgres). The rules are the connector's own.
        if (typeof plugin.columnNameProblem === 'function') {
          const problems = columns
            .map((col) => ({ col, why: plugin.columnNameProblem(col) }))
            .filter((p) => p.why);
          if (problems.length > 0) {
            return {
              success: false,
              message: `Could not create ${writeTableName}: `
                + problems.map((p) => `column "${p.col}" ${p.why}`).join('; ')
                + '. Add a Transformer before this Output that renames '
                + (problems.length === 1 ? 'it' : 'them')
                + ', then run again.',
            };
          }
        }
        const createTableSql = `CREATE TABLE ${quotedTableName} (${columnDefs})`;
        console.log('[Output] Creating destination table:', createTableSql);
        try {
          const created = await plugin.runQuery(fullConfig, targetConnection.id, { query: createTableSql });
          if (created && created.success === false) throw new Error(created.message);
          tableIsNew = true;
        } catch (err) {
          // Ask again before deciding this is fatal: the table may have been
          // created between the probe and here, or the probe may simply have
          // looked somewhere the connector names differently.
          const message = String(err?.message || err);
          probe = await probeTable();
          // The engine saying the object is already there outranks a lookup
          // that failed to find it: whatever the probe was looking at, the
          // table exists and the load can proceed. Without this, an engine
          // whose schemas the probe cannot resolve turns a load that has
          // always worked into a hard failure.
          const saysExists = /already exists|already an object|duplicate/i.test(message);
          if (probe.state === 'exists' || saysExists) {
            console.log(`[Output] ${writeTableName} already exists; loading into it.`);
          } else if (probe.state === 'missing') {
            // It really is not there and the CREATE really did fail. Say so
            // here, where the actual reason is still in hand.
            return {
              success: false,
              message: `Could not create ${writeTableName}: ${message}`,
            };
          } else {
            console.log('Table creation skipped (may already exist):', message);
          }
        }
      }

      // The table was already there, so its shape is whatever some earlier run
      // (or someone else entirely) left behind — nothing guarantees it matches
      // what we are about to load. Check BEFORE the truncate below: the insert
      // would catch a mismatch on its own, but only after the destination had
      // been emptied, turning "wrong table" into lost data. Reported as a
      // failure naming both column sets, which is what tells the user whether
      // they meant a different table or need to drop this one.
      //
      // Advisory only: a connector without getColumns, or one that cannot read
      // them, leaves the probe UNKNOWN and the load goes ahead rather than
      // being blocked when it might well be fine.
      //
      // The columns come from the probe above — the lookup already happened
      // there to decide whether to create, so asking again would be a second
      // round trip for an answer we hold.
      // `columns` is null when existence was established by the CREATE's own
      // error rather than a lookup — there is nothing to compare then, so the
      // check is skipped exactly as it is for an UNKNOWN probe.
      if (!tableIsNew && probe.state === 'exists' && Array.isArray(probe.columns) && probe.columns.length > 0) {
        const existing = probe.columns;
        // Compare case-insensitively: the engines differ on identifier
        // folding, and a case-only difference is not what this guards against.
        const have = new Set(existing.map(c => String(c.name).toLowerCase()));
        const missing = columns.filter(c => !have.has(String(c).toLowerCase()));
        if (missing.length > 0) {
          return {
            success: false,
            message: `Destination table ${writeTableName} does not have the column`
              + `${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. `
              + `It has: ${existing.map(c => c.name).join(', ')}. `
              + `The incoming data has: ${columns.join(', ')}. `
              + `Nothing was written or removed — drop or rename ${writeTableName}, or point this `
              + `output at a different table.`,
          };
        }
      }

      // Truncate-and-insert: empty the table before loading, so a re-run
      // REPLACES the previous load instead of stacking another copy on top.
      // Skipped when the CREATE above just made the table — there is nothing in
      // it, and an empty-table TRUNCATE is a needless round trip.
      //
      // TRUNCATE first because it is far cheaper than a row-by-row DELETE on
      // every engine that has it; SQLite has no TRUNCATE at all and some
      // engines refuse it on a table with inbound foreign keys, so DELETE is
      // the fallback rather than the first choice. A failure of BOTH is
      // reported instead of swallowed: silently appending to rows the user
      // asked to have removed is the one outcome worth failing over.
      //
      // An existing table is no longer emptied FIRST. The rows are loaded into
      // a staging copy of it, and only once every row is in does one
      // transaction swap them in (createStagingLike / swapFromStaging). A row
      // the destination refuses now fails the run with the destination still
      // holding its previous rows. Only when no staging copy can be made does
      // the old truncate-first path run.
      let staging = null;
      if (writeMode === 'truncate' && !tableIsNew) {
        staging = await createStagingLike(plugin, fullConfig, targetConnection.id, quotedTableName);
        if (!staging) {
          console.log(`[Output] Could not stage ${writeTableName}; truncating before the load instead.`);
          const cleared = await clearTable(
            plugin, fullConfig, targetConnection.id, quotedTableName, writeTableName,
          );
          if (!cleared.ok) {
            return {
              success: false,
              message: `Could not truncate ${writeTableName} before loading: ${cleared.error?.message || 'unknown error'}`,
            };
          }
        }
      }
      // The table batchInsert writes: the staging copy when there is one.
      const loadTableName = staging ? staging.bare : writeTableName;
      const dropStaging = async () => {
        if (!staging) return;
        try {
          await plugin.runQuery(fullConfig, targetConnection.id, { query: `DROP TABLE IF EXISTS ${staging.quoted}` });
        } catch (err) {
          console.log(`[Output] Could not drop staging table ${staging.bare}: ${err.message}`);
        }
      };

      // Insert in chunks using the plugin's batchInsert, reading the source as
      // we go — one chunk of rows is resident at a time, whatever the size of
      // the table being loaded.
      //
      // The chunk size is the DESTINATION's, not the reader's: the connector
      // chooses when it has a reason to — BigQuery turns each call into a load
      // job and is rationing a daily job quota, not a statement length (see
      // public/lib/batchChunkSize.js). So rows are buffered up to that size
      // across page boundaries rather than one batchInsert per page, which
      // would hand BigQuery whatever the reader happened to yield.
      const CHUNK_SIZE = batchChunkSizeFor(plugin);
      let totalInserted = 0;
      let buffer = [];

      const writeChunk = async (chunk) => {
        // Use plugin's batchInsert function if available, otherwise fallback to individual inserts
        if (plugin.batchInsert) {
          // Tell the tracer which records this call carries, so its line reads
          // "records=50,001–100,000" instead of a fourth identical "rows=50000"
          // — the only thing in the log that says how far a long load has got
          // while it is still running. Purely descriptive; cleared afterwards so
          // a later call in this node cannot inherit a stale offset.
          setBatchWindow({ table: writeTableName, written: totalInserted });
          try {
            // batchInsert expects the table name UNQUOTED — it quotes
            // internally — so this is the one place the RESOLVED bare name has
            // to be used rather than the quoted ref. Handing it the configured
            // `tableName` re-introduced the wrong case after everything above
            // had resolved it correctly, and the rows went to a table nothing
            // else in this function was looking at.
            const result = await plugin.batchInsert(fullConfig, targetConnection.id, loadTableName, columns, chunk);
            if (!result.success) {
              throw new Error(result.message || 'Batch insert failed');
            }
            totalInserted += result.rowsInserted;
          } finally {
            setBatchWindow(null);
          }
        } else {
          // Fallback: individual INSERT statements (use quoted table name)
          const insertStatements = chunk.map(row => {
            const values = columns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return 'NULL';
              if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
              if (val instanceof Date) return `'${val.toISOString()}'`;
              if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
              return val;
            });
            return `INSERT INTO ${staging ? staging.quoted : quotedTableName} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
          });

          const batchInsert = insertStatements.join('; ');
          // Same convention as the CREATE above: a failed statement comes back
          // as { success: false } rather than throwing. Counting the chunk
          // without checking would report "Successfully inserted N rows" for a
          // write that never landed.
          const inserted = await plugin.runQuery(fullConfig, targetConnection.id, {query: batchInsert});
          if (inserted && inserted.success === false) {
            throw new Error(inserted.message || 'Insert failed');
          }
          totalInserted += chunk.length;
        }
      };

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        // A large load lives entirely inside this one loop — minutes of work in
        // a single node — so the between-steps check in the runner would never
        // come round. Checked before the batch, not after: the point is to not
        // start another one. Rows already written stay written, which is why the
        // count goes into the message.
        //
        // No "of N" any more: with the source streamed, the total is not known
        // until it has all been read, and inventing one would be worse than
        // reporting the number that is real.
        throwIfCancelled(
          'batch insert',
          `${totalInserted} rows already written to ${writeTableName}`,
        );
        await writeChunk(chunk);
      };

      try {
        for await (const page of rest) {
          for (const row of page) {
            buffer.push(converters ? convertRow(row, converters) : row);
            if (buffer.length >= CHUNK_SIZE) await flush();
          }
        }
        await flush();
      } catch (err) {
        if (staging) {
          // Nothing reached the destination: say so, because "the load failed"
          // after a Truncate used to mean the table had already been emptied.
          await dropStaging();
          // A Stop keeps its own error type — the runner reads it as a cancel.
          if (isCancelledError(err)) throw err;
          const reason = String(err?.message || err);
          throw new Error(`${reason} — nothing was changed in ${writeTableName}; it still has its previous rows.`);
        }
        throw err;
      }

      if (staging) {
        const columnList = columns.map(quoteCol).join(', ');
        const swapped = await swapFromStaging(
          plugin, fullConfig, targetConnection.id, quotedTableName, staging.quoted, columnList,
        );
        await dropStaging();
        if (!swapped.ok) {
          return {
            success: false,
            message: `Could not replace the rows in ${writeTableName}: ${swapped.error?.message || 'unknown error'}`
              + (swapped.atomic ? ' — nothing was changed; it still has its previous rows.' : ''),
          };
        }
      }

      return {
        success: true,
        message: `Successfully ${writeMode === 'truncate' ? 'replaced' : 'inserted'} `
          + `${totalInserted} rows in ${writeTableName}`,
        rowsInserted: totalInserted
      };
    }

    // The source yielded no pages at all: leave the destination alone rather
    // than truncating it for nothing.
    return nothingToDo();
  }
}

/**
 * Insert data to vector database (Pinecone, LanceDB, etc.)
 * Uses vector-db-executor skill to handle embedding and insertion
 * @param {Array} sourceData - Array of data rows
 * @param {Object} targetConnection - Target vector database connection
 * @param {string} tableName - Target index/table name (format: "index-name" or "index-name/namespace" for Pinecone)
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @returns {Promise<Object>} Result with success, message, vectorsInserted
 */
async function insertToVectorDatabase(sourceData, targetConnection, tableName, pluginManager, getFullConfig, skillHelpers = null, writeMode = 'append', embedding = null, idColumn = null) {
  try {
    // Parse index name and namespace for Pinecone
    let indexName = tableName;
    let namespace = '';

    if (targetConnection.dbType === 'pinecone' && tableName.includes('/')) {
      const parts = tableName.split('/');
      indexName = parts[0];
      namespace = parts.slice(1).join('/');
    }

    // Get vector-db-executor skill
    const vectorSkill = pluginManager.getSkill('vector-db-executor');
    if (!vectorSkill) {
      return {
        success: false,
        message: 'Vector database executor skill not found. Please install the vector-db-executor skill.'
      };
    }

    // Execute data-to-vector transfer using the skill.
    //
    // 'truncate' empties the target first. It matters more here than elsewhere:
    // vectors are upserted by a CONTENT-derived id, so re-running an append
    // against changed data leaves the old vectors in place beside the new ones
    // and every similarity search keeps finding rows that no longer exist
    // upstream. The skill drops the LanceDB table / clears the Pinecone
    // namespace before writing.
    const result = await vectorSkill.executeDataToVector({
      sourceData,
      targetConnection,
      targetIndexName: indexName,
      targetNamespace: namespace,
      writeMode,
      embedding,
      idColumn,
      pluginManager,
      getFullConfig,
      helpers: skillHelpers
    });

    if (result.success) {
      return {
        success: true,
        message: result.message
          || `Successfully ${writeMode === 'truncate' ? 'replaced' : 'inserted'} `
            + `${result.vectorsInserted || sourceData.length} vectors in `
            + `${indexName}${namespace ? `/${namespace}` : ''}`,
        vectorsInserted: result.vectorsInserted || sourceData.length
      };
    } else {
      return {
        success: false,
        message: `Failed to insert vectors: ${result.message}`
      };
    }
  } catch (error) {
    // A stop must stay an exception on its way to the runner — see the note on
    // executeOutput's catch above. This is the host-side wrapper around the
    // vector skill, so it is the last place a stop raised while embedding or
    // upserting could be flattened into a failed write.
    if (isCancelledError(error)) throw error;
    console.error('Vector database insertion error:', error);
    return {
      success: false,
      message: `Failed to insert vectors: ${error.message}`,
      error: error.stack
    };
  }
}

module.exports = {
  // Held for the whole node — see holdDatabases in ../duckdb.
  executeOutput: (...args) => duckdb.holdDatabases(() => executeOutput(...args)),
  exportToLocalFile,
  insertToConnection,
  trySameConnectionCopy,
  insertToVectorDatabase,
  inferColumnTypes,
  inferColumnType,
  dialectFor,
  inferParquetSchema,
  inferAvroSchema
};
