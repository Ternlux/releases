/**
 * Shared chunked-write plumbing for local file imports.
 *
 * Every importer in this folder follows the same shape: pull rows out of the
 * source a few thousand at a time, infer column types from a leading sample,
 * and write each batch inside its own transaction. Nothing ever materialises
 * the whole file, and the event loop is handed back between batches so the
 * main process keeps answering IPC — that is what stops the window freezing
 * on multi-GB imports.
 */

const fs = require('fs');

// Rows per INSERT transaction. Large enough that fsync cost disappears into
// the batch, small enough that a batch's worth of bound values is cheap to
// hold in memory.
const DEFAULT_BATCH_SIZE = 2000;

// Rows buffered before the table is created. Types are inferred from these
// and then fixed — we cannot re-read the front of a stream, so this is the
// whole basis for the schema.
const TYPE_SAMPLE_ROWS = 1000;

// Don't spam the renderer: at most one progress event per this many ms.
const PROGRESS_INTERVAL_MS = 250;

// Numeric strings longer than this lose precision as JS numbers (order ids,
// account numbers, phone numbers), so they stay TEXT instead.
const MAX_SAFE_DIGITS = 15;

const runSql = (db, sql) => new Promise((resolve, reject) => {
  db.run(sql, (err) => (err ? reject(err) : resolve()));
});

/** Hand control back to the event loop so pending IPC/UI work can run. */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const fileSizeOf = (filePath) => {
  try { return fs.statSync(filePath).size; } catch { return 0; }
};

/** Column name → safe SQLite identifier, with a positional fallback. */
const normalizeHeader = (header, index) => {
  const text = header === null || header === undefined ? '' : String(header).replace(/^\uFEFF/, '').trim();
  return text === '' ? `column_${index + 1}` : text.replace(/[^a-zA-Z0-9_]/g, '_');
};

/** Suffix repeats so `id, id, id` becomes `id, id_2, id_3`. */
const dedupeHeaders = (rawHeaders) => {
  const seen = new Map();
  return rawHeaders.map((header) => {
    const count = seen.get(header) || 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header}_${count + 1}`;
  });
};

/** Build deduped, sanitized headers straight from a raw header row. */
const buildHeaders = (rawHeaderRow) =>
  dedupeHeaders((rawHeaderRow || []).map(normalizeHeader));

const isBlank = (value) => value === null || value === undefined || value === '';

/**
 * SQLite affinity for one column, from whatever sample values we have.
 *
 * Strings that only look numeric are deliberately kept as TEXT when coercing
 * them would change the value: leading zeros (`007`, zip codes) and integers
 * too long to survive a round trip through a JS number.
 */
const inferColumnType = (values) => {
  let sawValue = false;
  let allInteger = true;

  for (const raw of values) {
    if (isBlank(raw)) continue;
    sawValue = true;

    if (typeof raw === 'boolean') continue;              // stored as 0/1
    if (typeof raw === 'bigint') continue;               // integral by definition
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return 'TEXT';
      if (!Number.isInteger(raw)) allInteger = false;
      continue;
    }
    if (typeof raw !== 'string') return 'TEXT';          // Date, Buffer, nested object

    const text = raw.trim();
    if (text === '') continue;

    const num = Number(text);
    if (!Number.isFinite(num)) return 'TEXT';
    // `007` and `1.50` are text the moment a number would lose their shape.
    if (/^[+-]?0\d/.test(text)) return 'TEXT';
    if (text.replace(/[^0-9]/g, '').length > MAX_SAFE_DIGITS) return 'TEXT';
    if (!Number.isInteger(num)) allInteger = false;
  }

  if (!sawValue) return 'TEXT';
  return allInteger ? 'INTEGER' : 'REAL';
};

/**
 * Infer a type per column from sampled rows (arrays aligned to the headers).
 * @param {Array<Array<any>>} sampleRows
 * @param {number} columnCount
 * @returns {Array<'INTEGER'|'REAL'|'TEXT'>}
 */
const inferColumnTypes = (sampleRows, columnCount) => {
  const types = [];
  for (let col = 0; col < columnCount; col++) {
    types.push(inferColumnType(sampleRows.map((row) => (row ? row[col] : null))));
  }
  return types;
};

/**
 * Bind-ready value for one cell.
 *
 * Types come from a sample, so a later row can always contradict them. When a
 * value won't convert we store its text rather than a null — a wrong affinity
 * should never silently delete data (SQLite columns are dynamically typed, so
 * the row still lands).
 */
const coerceValue = (value, type) => {
  if (isBlank(value)) return null;
  if (Buffer.isBuffer(value)) return value;                       // BLOB
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    return (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER))
      ? Number(value)
      : value.toString();
  }

  if (type === 'TEXT') {
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }

  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  const num = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(num)) return String(value);
  return type === 'INTEGER' ? Math.trunc(num) : num;
};

/**
 * Read a handful of rows back out of a freshly written table so the caller can
 * ship a schema preview alongside the import result.
 */
function buildSchemaFromInferredTypes(tableName, db, headers, columnTypes, sampleLimit = 5) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM "${tableName}" LIMIT ${sampleLimit}`, (err, rows) => {
      if (err) { reject(err); return; }

      const columns = headers.map((header, index) => ({
        name: header,
        type: columnTypes[index],
        nullable: true,
        isPrimary: false,
      }));

      const sampleData = (rows || []).map((row) => {
        const trimmed = {};
        Object.keys(row).forEach((key) => {
          const value = row[key];
          trimmed[key] = (typeof value === 'string' && value.length > 100)
            ? `${value.substring(0, 100)}...`
            : value;
        });
        return trimmed;
      });

      resolve({ tableName, columns, sampleData });
    });
  });
}

/**
 * Writes rows into one SQLite table in transactional batches.
 *
 * Callers push rows in as they arrive from the source; the writer decides when
 * to flush. `addRow` returns a promise that only settles once any triggered
 * flush has committed, which is what applies backpressure to the reader — the
 * source stream stays paused instead of queueing millions of statements.
 */
class SqliteBatchWriter {
  constructor(db, {
    tableName,
    headers,
    columnTypes,
    batchSize = DEFAULT_BATCH_SIZE,
    onProgress = null,
    progressMeta = {},
  }) {
    this.db = db;
    this.tableName = tableName;
    this.headers = headers;
    this.columnTypes = columnTypes;
    this.batchSize = batchSize;
    this.onProgress = onProgress;
    this.progressMeta = progressMeta;

    this.pending = [];
    this.rowCount = 0;
    this.lastProgressAt = 0;

    const columnList = headers.map((h) => `"${h}"`).join(', ');
    const placeholders = headers.map(() => '?').join(', ');
    this.insertSQL = `INSERT INTO "${tableName}" (${columnList}) VALUES (${placeholders})`;
  }

  /** Drop any previous import of this table and create it fresh. */
  async createTable() {
    const columnDefs = this.headers
      .map((header, index) => `"${header}" ${this.columnTypes[index]}`)
      .join(', ');
    await runSql(this.db, `DROP TABLE IF EXISTS "${this.tableName}"`);
    await runSql(this.db, `CREATE TABLE "${this.tableName}" (${columnDefs})`);
  }

  /** Queue one row (an array aligned to `headers`), flushing when the batch fills. */
  async addRow(rawValues) {
    const values = this.headers.map((_, index) => coerceValue(rawValues ? rawValues[index] : null, this.columnTypes[index]));
    this.pending.push(values);
    if (this.pending.length >= this.batchSize) await this.flush();
  }

  async addRows(rows) {
    for (const row of rows) await this.addRow(row);
  }

  /** Commit whatever is queued, then yield so the UI can breathe. */
  async flush() {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];

    await this._writeBatch(batch);
    this.rowCount += batch.length;

    await yieldToEventLoop();
    this._reportProgress(false);
  }

  async _writeBatch(batch) {
    await runSql(this.db, 'BEGIN');
    try {
      await new Promise((resolve, reject) => {
        this.db.serialize(() => {
          const stmt = this.db.prepare(this.insertSQL);
          let failure = null;
          for (const values of batch) {
            stmt.run(values, (err) => { if (err && !failure) failure = err; });
          }
          stmt.finalize((finalizeErr) => {
            const err = failure || finalizeErr;
            if (err) reject(err); else resolve();
          });
        });
      });
      await runSql(this.db, 'COMMIT');
    } catch (error) {
      await runSql(this.db, 'ROLLBACK').catch(() => {});
      throw error;
    }
  }

  _reportProgress(force) {
    if (typeof this.onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    try {
      this.onProgress({ table: this.tableName, rows: this.rowCount, ...this.progressMeta });
    } catch {
      // Progress reporting must never break an import.
    }
  }

  /** Flush the tail and return the total row count. */
  async close() {
    await this.flush();
    this._reportProgress(true);
    return this.rowCount;
  }
}

/**
 * Drives the "buffer a sample, then stream" pattern every importer shares.
 *
 * Rows go in one at a time. The first `sampleSize` are held back to infer
 * types; once the sample is full (or the source ends) the table is created,
 * the sample is written, and everything after that flows straight through.
 */
class SampledTableWriter {
  constructor(db, { tableName, batchSize, sampleSize = TYPE_SAMPLE_ROWS, onProgress, progressMeta }) {
    this.db = db;
    this.tableName = tableName;
    this.batchSize = batchSize;
    this.sampleSize = sampleSize;
    this.onProgress = onProgress;
    this.progressMeta = progressMeta;

    this.headers = null;
    this.columnTypes = null;
    this.writer = null;
    this.sample = [];
  }

  setHeaders(headers) {
    this.headers = headers;
  }

  async addRow(row) {
    if (!this.writer) {
      this.sample.push(row);
      if (this.sample.length >= this.sampleSize) await this._start();
      return;
    }
    await this.writer.addRow(row);
  }

  async _start() {
    if (this.writer) return;
    if (!this.headers || this.headers.length === 0) {
      throw new Error('No columns found — the file has no usable header row');
    }
    this.columnTypes = inferColumnTypes(this.sample, this.headers.length);
    this.writer = new SqliteBatchWriter(this.db, {
      tableName: this.tableName,
      headers: this.headers,
      columnTypes: this.columnTypes,
      batchSize: this.batchSize,
      onProgress: this.onProgress,
      progressMeta: this.progressMeta,
    });
    await this.writer.createTable();

    const buffered = this.sample;
    this.sample = [];
    for (const row of buffered) await this.writer.addRow(row);
  }

  /** True once at least one row (or an empty-but-headed file) has been seen. */
  get hasData() {
    return Boolean(this.writer) || this.sample.length > 0;
  }

  /**
   * Finish the table and return { rowCount, schema, headers, columnTypes }.
   * Safe to call on a header-only file: the empty table is still created.
   */
  async finish() {
    await this._start();
    const rowCount = await this.writer.close();
    let schema = null;
    try {
      schema = await buildSchemaFromInferredTypes(this.tableName, this.db, this.headers, this.columnTypes, 5);
    } catch (error) {
      console.error(`[import] Failed to build schema for ${this.tableName}:`, error);
    }
    return { rowCount, schema, headers: this.headers, columnTypes: this.columnTypes };
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  TYPE_SAMPLE_ROWS,
  SqliteBatchWriter,
  SampledTableWriter,
  buildHeaders,
  buildSchemaFromInferredTypes,
  coerceValue,
  dedupeHeaders,
  fileSizeOf,
  inferColumnType,
  inferColumnTypes,
  normalizeHeader,
  runSql,
  yieldToEventLoop,
};
