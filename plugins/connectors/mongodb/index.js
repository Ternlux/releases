/**
 * MongoDB Connector Plugin for Ternlux
 * Handles all MongoDB database operations
 */

const mongoose = require('mongoose');

// Connection cache
const connections = new Map();

/**
 * Get or create MongoDB connection
 */
async function getConnection(config, connectionId) {
  const key = connectionId || JSON.stringify(config);
  const uri = config.uri;

  if (!uri) {
    throw new Error('MongoDB URI is required');
  }

  if (!connections.has(key)) {
    const connection = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 10,
      minPoolSize: 0,
    }).asPromise();

    connections.set(key, connection);
  }

  return connections.get(key);
}

// ── Data Explorer: shell-syntax parsing ────────────────────────────────────
// The explorer's editor lets people write what they'd type in mongosh
// (`db.events.find({ ts: { $gte: ISODate("...") } }).limit(50)`). runQuery
// wants a params object, so these helpers bridge the two. Raw JSON params are
// still accepted unchanged, which is what the AI-generated nodes emit.

/**
 * Methods we can execute, in mongosh spelling.
 *
 * `operation` is what runQuery switches on. `args` names the positional
 * arguments in shell order, so `.updateMany(f, u, o)` arrives as
 * `{ filter, update, options }`, and `required` is how many of them the driver
 * will not default for us. `cursor` marks the reads a `.sort()/.limit()/…`
 * chain may follow — `'pipeline'` for aggregate, whose ordering and projection
 * belong in the pipeline itself.
 */
const SHELL_METHODS = {
  // reads
  find: { operation: 'find', args: ['filter', 'projection'], cursor: true },
  findOne: { operation: 'find', args: ['filter', 'projection'], limit: 1 },
  aggregate: { operation: 'aggregate', args: ['pipeline'], required: 1, cursor: 'pipeline' },
  count: { operation: 'count', args: ['filter'] },
  countDocuments: { operation: 'count', args: ['filter'] },
  estimatedDocumentCount: { operation: 'estimatedDocumentCount', args: [] },
  distinct: { operation: 'distinct', args: ['field', 'filter'], required: 1 },

  // writes. The filter is required rather than defaulted: mongosh refuses a
  // bare .deleteMany(), and "every document in the collection" should have to
  // be written out as .deleteMany({}) here too.
  insertOne: { operation: 'insertOne', args: ['document'], required: 1 },
  insertMany: { operation: 'insertMany', args: ['documents'], required: 1 },
  updateOne: { operation: 'updateOne', args: ['filter', 'update', 'options'], required: 2 },
  updateMany: { operation: 'updateMany', args: ['filter', 'update', 'options'], required: 2 },
  replaceOne: { operation: 'replaceOne', args: ['filter', 'replacement', 'options'], required: 2 },
  deleteOne: { operation: 'deleteOne', args: ['filter', 'options'], required: 1 },
  deleteMany: { operation: 'deleteMany', args: ['filter', 'options'], required: 1 },
  findOneAndUpdate: { operation: 'findOneAndUpdate', args: ['filter', 'update', 'options'], required: 2 },
  findOneAndReplace: { operation: 'findOneAndReplace', args: ['filter', 'replacement', 'options'], required: 2 },
  findOneAndDelete: { operation: 'findOneAndDelete', args: ['filter', 'options'], required: 1 },
  bulkWrite: { operation: 'bulkWrite', args: ['operations', 'options'], required: 1 },

  // collection and index administration
  drop: { operation: 'drop', args: [] },
  renameCollection: { operation: 'renameCollection', args: ['target', 'dropTarget'], required: 1 },
  createIndex: { operation: 'createIndex', args: ['keys', 'options'], required: 1 },
  dropIndex: { operation: 'dropIndex', args: ['index'], required: 1 },
  getIndexes: { operation: 'listIndexes', args: [] },
  indexes: { operation: 'listIndexes', args: [] },
  listIndexes: { operation: 'listIndexes', args: [] },
};

/** The same, for the commands written against `db` itself rather than a collection. */
const DB_METHODS = {
  getCollectionNames: { operation: 'listCollections', args: [], fixed: { namesOnly: true } },
  getCollectionInfos: { operation: 'listCollections', args: ['filter'] },
  createCollection: { operation: 'createCollection', args: ['name', 'options'], required: 1 },
  runCommand: { operation: 'runCommand', args: ['command'], required: 1 },
  stats: { operation: 'dbStats', args: [] },
};

/** Operations that name no collection. Everything else needs one. */
const DB_LEVEL_OPS = new Set(['listCollections', 'createCollection', 'runCommand', 'dbStats']);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * What each named argument has to be, so a mistyped call fails here — with a
 * sentence about the call the user wrote — rather than deep inside the driver.
 */
const ARG_SHAPES = {
  pipeline: [Array.isArray, 'an array pipeline'],
  documents: [Array.isArray, 'an array of documents'],
  operations: [Array.isArray, 'an array of write operations'],
  update: [(v) => isPlainObject(v) || Array.isArray(v), 'an update document or an aggregation pipeline'],
  index: [(v) => typeof v === 'string' || isPlainObject(v), 'an index name or a key pattern'],
  field: [(v) => typeof v === 'string', 'a field name'],
  target: [(v) => typeof v === 'string', 'the new collection name'],
  name: [(v) => typeof v === 'string', 'a collection name'],
  dropTarget: [(v) => typeof v === 'boolean', 'true or false'],
  filter: [isPlainObject, 'an object'],
  projection: [isPlainObject, 'an object'],
  options: [isPlainObject, 'an object'],
  document: [isPlainObject, 'a document object'],
  replacement: [isPlainObject, 'a replacement document'],
  keys: [isPlainObject, 'a key pattern object'],
  command: [isPlainObject, 'a command document'],
};

/**
 * Walk forward from an opening bracket to its match, skipping over anything
 * inside string literals. Returns the index of the closing bracket, or -1.
 */
function matchBracket(text, openIndex) {
  const open = text[openIndex];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  let depth = 0;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }

    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an argument list on top-level commas only. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }

  const tail = text.slice(start);
  if (tail.trim()) args.push(tail);
  return args.map((a) => a.trim()).filter(Boolean);
}

/**
 * Parse a value written in shell syntax (unquoted keys, ISODate(...),
 * ObjectId(...)) into plain JS. mongodb-query-parser is the same parser
 * Compass uses, so anything valid there is valid here.
 */
function parseShellValue(text) {
  const { parseFilter } = require('mongodb-query-parser');
  return parseFilter(text);
}

/** `db.<collection>.<method>(` and `db.<method>(`, the two call shapes. */
const COLLECTION_CALL = /^db\s*\.\s*(?:getCollection\(\s*['"]([^'"]+)['"]\s*\)|([A-Za-z0-9_$][\w$.-]*))\s*\.\s*([A-Za-z]+)\s*\(/;
const DB_CALL = /^db\s*\.\s*([A-Za-z][\w$]*)\s*\(/;

/** Cursor methods aggregate accepts; the rest are pipeline stages there. */
const PIPELINE_CHAIN = new Set(['limit', 'explain', 'toArray', 'pretty']);
const STAGE_FOR = { sort: '$sort', skip: '$skip', project: '$project', projection: '$project', count: '$count' };

/**
 * Positional shell arguments → the named params runQuery reads, checked
 * against the method's spec.
 */
function applyArgs(spec, method, args, params) {
  const names = spec.args || [];
  const required = spec.required || 0;

  if (args.length < required) {
    throw new Error(`.${method}() needs (${names.slice(0, required).join(', ')})`);
  }
  if (args.length > names.length) {
    throw new Error(
      names.length
        ? `.${method}() takes at most ${names.length} argument(s): (${names.join(', ')})`
        : `.${method}() takes no arguments`,
    );
  }

  names.forEach((name, i) => {
    if (i >= args.length) return;
    const value = parseShellValue(args[i]);
    const shape = ARG_SHAPES[name];
    if (shape && !shape[0](value)) {
      throw new Error(`.${method}() expects ${name} to be ${shape[1]}`);
    }
    params[name] = value;
  });

  if (spec.fixed) Object.assign(params, spec.fixed);
  if (spec.limit) params.limit = spec.limit;
}

/**
 * Turn one statement of editor text into the params object runQuery expects.
 * Accepts a `db.<collection>.<method>(...)` chain, a `db.<method>(...)` command,
 * or raw JSON params.
 *
 * @throws {Error} when the text is none of those, or an argument won't parse
 */
function parseExplorerQuery(text) {
  const body = String(text || '').trim().replace(/;\s*$/, '');
  if (!body) throw new Error('Nothing to run');

  // Raw params object — `{ collection: "x", filter: {...} }`.
  if (body.startsWith('{')) {
    const params = parseShellValue(body);
    if (!params.collection && !DB_LEVEL_OPS.has(params.operation)) {
      throw new Error('A raw query object needs a "collection" field');
    }
    return params;
  }

  const head = COLLECTION_CALL.exec(body);
  const dbCall = head ? null : DB_CALL.exec(body);
  if (!head && !dbCall) {
    throw new Error('Expected db.<collection>.<method>(…), db.<method>(…), or a raw { collection: … } object');
  }

  const method = head ? head[3] : dbCall[1];
  const spec = head ? SHELL_METHODS[method] : DB_METHODS[method];
  if (!spec) {
    throw new Error(head
      ? `Unsupported method ".${method}()" — this connection runs ${Object.keys(SHELL_METHODS).join(', ')}`
      : `Unsupported command "db.${method}()" — use ${Object.keys(DB_METHODS).join(', ')}, or db.<collection>.${method}()`);
  }

  const params = { operation: spec.operation };
  if (head) params.collection = head[1] || head[2];

  const call = head || dbCall;
  const openParen = body.indexOf('(', call[0].length - 1);
  const closeParen = matchBracket(body, openParen);
  if (closeParen === -1) throw new Error(`Unclosed "(" after .${method}`);

  applyArgs(spec, method, splitArgs(body.slice(openParen + 1, closeParen)), params);

  // Trailing chain: .sort({...}).limit(n).skip(n).project({...}).toArray()
  let rest = body.slice(closeParen + 1);
  const CHAIN = /^\s*\.\s*(sort|limit|skip|project|projection|count|explain|toArray|pretty)\s*\(/;
  while (CHAIN.test(rest)) {
    const chained = CHAIN.exec(rest);
    const name = chained[1];

    if (!spec.cursor) {
      throw new Error(`.${name}() cannot follow .${method}(), which returns no cursor`);
    }
    if (spec.cursor === 'pipeline' && !PIPELINE_CHAIN.has(name)) {
      throw new Error(`.${name}() cannot follow .aggregate() — use a ${STAGE_FOR[name]} stage in the pipeline instead`);
    }

    const open = rest.indexOf('(', chained[0].length - 1);
    const close = matchBracket(rest, open);
    if (close === -1) throw new Error(`Unclosed "(" after .${name}`);

    const raw = rest.slice(open + 1, close).trim();
    if (name === 'toArray' || name === 'pretty') {
      // Shell punctuation: both only decide how mongosh PRINTS a cursor, and
      // the grid does its own rendering. Accepted and ignored so a line pasted
      // out of a shell session runs unedited.
      if (raw) throw new Error(`.${name}() takes no arguments`);
    } else if (name === 'explain') {
      // `true` is the driver's default verbosity; a string names another.
      params.explain = raw ? parseShellValue(raw) : true;
    } else if (name === 'count') {
      params.operation = 'count';
      delete params.projection;
    } else if (name === 'limit' || name === 'skip') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`.${name}() expects a non-negative number`);
      params[name] = n;
    } else if (raw) {
      params[name === 'projection' ? 'projection' : name] = parseShellValue(raw);
    }

    rest = rest.slice(close + 1);
  }

  if (rest.trim()) throw new Error(`Unexpected trailing input: ${rest.trim().slice(0, 40)}`);
  return params;
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
  // The driver numbers the condition and names it — e.g. 48 / 'NamespaceExists'.
  code: error.code,
  codeName: error.codeName,
});

// A schema scan reads at most this many documents, for at most this long.
const SCHEMA_SCAN_LIMIT = 1000000;
const SCHEMA_SCAN_MS = 120000;

/** The BSON type name for a JS value — the fallback when the scan cannot run. */
function jsBsonType(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'string') return 'string';
  if (v && v._bsontype === 'ObjectId') return 'objectId';
  if (v && v._bsontype === 'Long') return 'long';
  if (v && v._bsontype === 'Decimal128') return 'decimal';
  if (typeof v === 'object') return 'object';
  return 'string';
}

module.exports = {
  type: 'connector',
  id: 'mongodb',
  name: 'MongoDB',
  icon: './icon.svg',
  dbCategory: 'NoSQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const uri = config.uri;
      if (!uri) {
        return { success: false, message: 'MongoDB URI is required' };
      }

      const connection = mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: 8000
      });
      await connection.asPromise();
      await connection.close();
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Get list of collections
   */
  /**
   * Resolve the server's version across every MongoDB version and privilege
   * level. buildInfo is the one universally available, privilege-exempt command
   * (a readWrite-scoped user can call it; serverStatus/listDatabases cannot),
   * and admin() is a free Db handle — the privilege check is on the command,
   * not the handle. Prefer versionArray ([major, minor, patch, ...]) over the
   * version string, which can carry -alpha / -gitHash suffixes. Never throws —
   * an unknown version is a prompt-quality problem, not a reason to block the
   * caller — so it returns version: null and lets the caller degrade. Note the
   * value is advisory: Mongo-compatible emulations (DocumentDB, Cosmos) report
   * an emulated version they don't fully implement.
   */
  getServerVersion: async (config, connectionId = null) => {
    try {
      const connection = await getConnection(config, connectionId);
      const db = connection.db;
      if (!db) return { success: false, version: null, versionArray: null };

      const info = await db.admin().command({ buildInfo: 1 });

      const arr = Array.isArray(info?.versionArray)
        ? info.versionArray
        : (typeof info?.version === 'string'
            ? info.version.split(/[.\-+]/).map(Number).filter(n => !Number.isNaN(n))
            : null);

      return {
        success: true,
        version: info?.version || (arr ? arr.slice(0, 3).join('.') : null),
        versionArray: arr,
      };
    } catch (err) {
      console.warn('[mongodb:getServerVersion]', err.message);
      return { success: false, version: null, versionArray: null, message: err.message };
    }
  },

  getTables: async (config, connectionId = null) => {
    try {
      const connection = await getConnection(config, connectionId);
      const db = connection.db;
      const dbName = db.databaseName;

      const collections = await db.listCollections().toArray();

      return {
        success: true,
        tables: collections.map(c => ({
          schema: dbName,
          name: c.name,
          type: 'COLLECTION'
        }))
      };
    } catch (error) {
      return { success: false, message: error.message, tables: [] };
    }
  },

  /**
   * Get collection fields (inferred from documents)
   */
  getColumns: async (config, connectionId, schema, table) => {
    try {
      const connection = await getConnection(config, connectionId);

      // If schema (database name) is provided, switch to it
      const db = schema
        ? connection.useDb(schema).db
        : connection.db;

      const coll = db.collection(table);

      // Field ORDER comes from the first documents (the $group below has
      // none); every field the scan finds that they lack follows, A→Z.
      const firstDocs = await coll.find({}).limit(100).toArray();
      const order = [];
      firstDocs.forEach((doc) => Object.keys(doc).forEach((k) => { if (!order.includes(k)) order.push(k); }));

      // The schema is computed BY MongoDB, over the collection: one row per
      // (field, BSON type) with its count. Nothing but those rows comes back,
      // so the cost here does not grow with the collection — and a field that
      // first appears on document 6,000, or holds a number in some documents
      // and text in others, is seen. It used to be the keys of the first 100
      // documents, every one typed 'mixed'.
      //
      // Past SCHEMA_SCAN_LIMIT documents only that many are scanned, and the
      // columns say so (`scannedDocuments`, `sampled`), rather than a schema
      // scan quietly taking minutes on a very large collection.
      let types = null;
      let total = null;
      try {
        total = await coll.estimatedDocumentCount();
        const pipeline = [
          ...(total > SCHEMA_SCAN_LIMIT ? [{ $limit: SCHEMA_SCAN_LIMIT }] : []),
          { $project: { kv: { $objectToArray: '$$ROOT' } } },
          { $unwind: '$kv' },
          { $group: { _id: { k: '$kv.k', t: { $type: '$kv.v' } }, n: { $sum: 1 } } },
        ];
        types = await coll.aggregate(pipeline, { allowDiskUse: true, maxTimeMS: SCHEMA_SCAN_MS }).toArray();
      } catch (scanError) {
        console.log(`[mongodb] Schema scan of ${table} failed (${scanError.message}) — using its first documents`);
        types = null;
      }

      const byField = new Map();
      if (types) {
        for (const row of types) {
          const k = row._id.k;
          if (!byField.has(k)) byField.set(k, {});
          byField.get(k)[row._id.t] = row.n;
        }
      } else {
        // Fallback: the first documents, their JS types.
        firstDocs.forEach((doc) => Object.entries(doc).forEach(([k, v]) => {
          if (!byField.has(k)) byField.set(k, {});
          const t = jsBsonType(v);
          byField.get(k)[t] = (byField.get(k)[t] || 0) + 1;
        }));
      }
      const names = [
        ...order.filter((k) => byField.has(k)),
        ...[...byField.keys()].filter((k) => !order.includes(k)).sort(),
      ];
      const scanned = types ? Math.min(total ?? 0, SCHEMA_SCAN_LIMIT) : firstDocs.length;
      const sampled = types ? (total ?? 0) > SCHEMA_SCAN_LIMIT : true;

      const columns = names.map((field) => {
        const bsonTypes = byField.get(field);
        const present = Object.keys(bsonTypes).filter((t) => t !== 'null');
        const seen = Object.values(bsonTypes).reduce((a, b) => a + b, 0);
        return {
          name: field,
          // One BSON type, or 'mixed' when the documents disagree.
          type: present.length === 1 ? present[0] : (present.length === 0 ? 'null' : 'mixed'),
          bsonTypes,
          // Missing from some documents, or null in some.
          nullable: (bsonTypes.null || 0) > 0 || seen < scanned ? 'YES' : 'NO',
          isPrimary: field === '_id',
          scannedDocuments: scanned,
          sampled,
        };
      });

      return { success: true, columns };
    } catch (error) {
      return { success: false, message: error.message, columns: [] };
    }
  },

  /**
   * A field's BSON types (a getColumns entry) as a canonical type — see
   * public/NodeExecution/columnTypes.js. A field whose documents disagree
   * takes the type that holds every value: int + long → BIGINT, any number
   * with a double → DOUBLE, anything else mixed → text.
   */
  toCanonicalType: (column) => {
    const present = Object.keys(column?.bsonTypes || {}).filter((t) => t !== 'null' && t !== 'undefined');
    if (present.length === 0) return { kind: 'NULL' };
    const set = new Set(present);
    const only = (...allowed) => present.every((t) => allowed.includes(t));
    if (only('int')) return { kind: 'INTEGER' };
    if (only('int', 'long')) return { kind: 'BIGINT' };
    if (only('int', 'long', 'decimal') && set.has('decimal')) return { kind: 'DECIMAL', precision: null, scale: null };
    if (only('int', 'long', 'double', 'decimal')) return { kind: 'DOUBLE' };
    if (only('bool')) return { kind: 'BOOLEAN' };
    // A BSON date is an instant (UTC); a BSON timestamp is too.
    if (only('date', 'timestamp')) return { kind: 'TIMESTAMPTZ' };
    if (only('object', 'array')) return { kind: 'OBJECT' };
    // string, objectId, binData, regex… and every mixed case.
    return { kind: 'STRING', length: null };
  },

  /**
   * Stream a find, a batch at a time — the contract every SQL connector's
   * streamQuery has (see public/lib/pluginRowStream.js): `onBatch` is awaited
   * before the cursor reads on, and a rejected `onBatch` stops the read and
   * closes the cursor. `query` is a JSON string, `{ collection, filter,
   * database? }`, since this connector does not speak SQL.
   *
   * An Output used to read a whole collection into one array before writing a
   * row of it; now at most one batch is in memory.
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    let cursor = null;
    try {
      const params = typeof query === 'string' ? JSON.parse(query) : (query || {});
      if (!params.collection) return { success: false, message: 'A stream needs a collection' };
      const connection = await getConnection(config, connectionId);
      const db = params.database ? connection.useDb(params.database).db : connection.db;
      cursor = db.collection(params.collection).find(params.filter || {}).batchSize(batchSize);
      let batch = [];
      let totalRows = 0;
      for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= batchSize) {
          totalRows += batch.length;
          await onBatch(batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        totalRows += batch.length;
        await onBatch(batch);
      }
      return { success: true, totalRows };
    } catch (error) {
      return { success: false, message: error.message };
    } finally {
      if (cursor) await cursor.close().catch(() => {});
    }
  },

  /**
   * Run one MongoDB operation.
   *
   * `query` is a params object — `{ collection, filter, sort, skip, limit,
   * projection }` for a find, or `{ collection, operation, … }` for anything
   * else. `operation` is the driver method by its own name:
   *
   *   reads    find · aggregate · count · estimatedDocumentCount · distinct
   *   writes   insertOne · insertMany · updateOne · updateMany · replaceOne ·
   *            deleteOne · deleteMany · findOneAndUpdate · findOneAndReplace ·
   *            findOneAndDelete · bulkWrite
   *   admin    drop · renameCollection · createIndex · dropIndex · listIndexes
   *   database listCollections · createCollection · runCommand · dbStats
   *
   * The Data Explorer reaches all of them through `explorer.parseQuery`, which
   * translates the mongosh line the user typed into these params.
   */
  /**
   * @param {number|{maxRows:number}|0|null} [limitOrOptions] - Historically a
   *   plain row limit. The Data Explorer passes `{ maxRows }` instead, which
   *   additionally reports whether more documents were waiting. Pass `0` (or
   *   null) for NO cap — a workflow reading a whole collection. Either way the
   *   cap is applied to the CURSOR; the user's filter or pipeline is never
   *   edited.
   *
   *   The 100 default is a PREVIEW default. It belongs to the Data Explorer and
   *   to the sample reads that populate a node's schema, and it silently
   *   truncated every execution path that did not override it: a join's
   *   anti-join source saw only the first 100 existing documents, so everything
   *   past position 100 looked new on every run and was re-appended forever.
   *   Callers that mean "all of it" now say so.
   */
  runQuery: async (config, connectionId, query, limitOrOptions = 100) => {
    try {
      const noCap = limitOrOptions === 0 || limitOrOptions === null;
      const opts = (limitOrOptions && typeof limitOrOptions === 'object') ? limitOrOptions : null;
      // 0 reaches the driver as cursor.limit(0), which is MongoDB's own
      // spelling of "no limit".
      const limit = opts ? (Number(opts.maxRows) || 100) : (noCap ? 0 : limitOrOptions);
      // Read one past the cap so "there is more" is observed, not guessed.
      // Never with noCap — opts is null there and nothing is being capped.
      const probe = opts ? limit + 1 : null;
      const connection = await getConnection(config, connectionId);
      query = query?.query ? query.query : query;
      const params = typeof query === 'string' ? JSON.parse(query) : query;
      const db = connection.db;

      // Handle different operation types. An explicit `operation: "find"` is
      // the same as omitting `operation` — fall through to the default find
      // path below instead of failing with "Unknown operation type: find".
      if (params.operation && params.operation !== 'find') {
        // Database-level commands first: they name no collection, so
        // db.collection() below would have nothing to open.
        if (DB_LEVEL_OPS.has(params.operation)) {
          switch (params.operation) {
            case 'listCollections': {
              const infos = await db.listCollections(params.filter || {}).toArray();
              // getCollectionNames() is the same listing narrowed to the names,
              // which is what makes it a one-column result rather than a dump.
              const rows = params.namesOnly ? infos.map((c) => ({ name: c.name })) : infos;
              return {
                success: true,
                rows,
                columns: rows.length ? Object.keys(rows[0]) : ['name'],
                rowCount: rows.length,
                json: true,
              };
            }

            case 'createCollection': {
              const name = params.name || params.collection;
              if (!name) {
                return { success: false, message: 'createCollection requires params.name' };
              }
              await db.createCollection(name, params.options || {});
              return {
                success: true,
                message: `Created collection "${name}"`,
                rowCount: 0,
                mutated: [{ schema: db.databaseName, table: name }],
              };
            }

            case 'runCommand': {
              if (!params.command || typeof params.command !== 'object') {
                return { success: false, message: 'runCommand requires params.command (object)' };
              }
              const out = await db.command(params.command);
              // A command replies with one document, except the cursor-returning
              // ones, which put documents in cursor.firstBatch. That is the FIRST
              // BATCH only — the cursor is never iterated here, so a command with
              // more than a batch's worth is better run through its own method
              // (getCollectionInfos, getIndexes, aggregate).
              const batch = out && out.cursor && Array.isArray(out.cursor.firstBatch)
                ? out.cursor.firstBatch
                : null;
              const rows = batch || [out];
              return {
                success: true,
                rows,
                columns: rows.length ? Object.keys(rows[0]) : [],
                rowCount: rows.length,
                json: true,
              };
            }

            case 'dbStats': {
              const stats = await db.stats();
              return {
                success: true,
                rows: [stats],
                columns: Object.keys(stats),
                rowCount: 1,
                json: true,
              };
            }

            default:
              break;
          }
        }

        if (!params.collection) {
          return { success: false, message: `Operation "${params.operation}" needs a collection` };
        }
        const coll = db.collection(params.collection);

        switch (params.operation) {
          case 'drop':
            // Drop collection
            try {
              await coll.drop();
              return {
                success: true,
                message: `Collection "${params.collection}" dropped successfully`,
                rowCount: 0,
                // The tree and the completions built from it are now describing
                // something that isn't there; the explorer reloads what it's told.
                mutated: [{ schema: db.databaseName, table: params.collection }]
              };
            } catch (err) {
              // If collection doesn't exist, that's fine
              if (err.code === 26) { // NamespaceNotFound
                return {
                  success: true,
                  message: `Collection "${params.collection}" does not exist`,
                  rowCount: 0
                };
              }
              throw err;
            }

          case 'deleteMany': {
            // Empty a collection (or the part of it a filter names) WITHOUT
            // dropping it — an output node's truncate-and-insert wants the
            // collection and its indexes to survive the load.
            const deleted = await coll.deleteMany(params.filter || {});
            return {
              success: true,
              message: `Deleted ${deleted.deletedCount} document(s) from "${params.collection}"`,
              rowCount: deleted.deletedCount,
              deletedCount: deleted.deletedCount
            };
          }

          case 'insertMany': {
            // Insert many documents.
            //
            // An empty set is a no-op, not an error. The driver disagrees —
            // insertMany([]) throws `MongoInvalidArgumentError: Invalid
            // BulkOperation, Batch cannot be empty` — and a caller with
            // nothing to write is an ordinary outcome, not a broken one. This
            // connector's own batchInsert has always answered it this way;
            // runQuery now agrees rather than being the one path that throws.
            const documents = Array.isArray(params.documents) ? params.documents : [];
            if (documents.length === 0) {
              return {
                success: true,
                message: `No documents to insert into "${params.collection}"`,
                rowCount: 0,
                insertedCount: 0
              };
            }
            const result = await coll.insertMany(documents);
            return {
              success: true,
              message: `Inserted ${result.insertedCount} documents into "${params.collection}"`,
              rowCount: result.insertedCount,
              insertedCount: result.insertedCount
            };
          }

          case 'insertOne': {
            const document = params.document
              || (Array.isArray(params.documents) ? params.documents[0] : null);
            if (!isPlainObject(document)) {
              return { success: false, message: 'insertOne requires params.document (object)' };
            }
            const inserted = await coll.insertOne(document);
            return {
              success: true,
              message: `Inserted 1 document into "${params.collection}" (_id: ${String(inserted.insertedId)})`,
              rowCount: 1,
              insertedCount: 1,
              insertedId: inserted.insertedId
            };
          }

          // One case for the three: they differ only in which document the
          // driver is handed and how many documents it is allowed to touch.
          case 'updateOne':
          case 'updateMany':
          case 'replaceOne': {
            const isReplace = params.operation === 'replaceOne';
            const change = isReplace ? params.replacement : params.update;
            if (!change || typeof change !== 'object') {
              return {
                success: false,
                message: `${params.operation} requires params.${isReplace ? 'replacement (object)' : 'update (object or pipeline)'}`
              };
            }
            const updated = await coll[params.operation](
              params.filter || {},
              change,
              params.options || {}
            );
            const upserted = updated.upsertedId
              ? ` · upserted _id: ${String(updated.upsertedId)}`
              : '';
            return {
              success: true,
              message: `Matched ${updated.matchedCount}, modified ${updated.modifiedCount} document(s) in "${params.collection}"${upserted}`,
              // The documents actually rewritten — the count a caller means by
              // "how many rows did this change".
              rowCount: updated.modifiedCount,
              matchedCount: updated.matchedCount,
              modifiedCount: updated.modifiedCount,
              upsertedCount: updated.upsertedCount || 0,
              upsertedId: updated.upsertedId || null
            };
          }

          case 'deleteOne': {
            const deleted = await coll.deleteOne(params.filter || {}, params.options || {});
            return {
              success: true,
              message: `Deleted ${deleted.deletedCount} document(s) from "${params.collection}"`,
              rowCount: deleted.deletedCount,
              deletedCount: deleted.deletedCount
            };
          }

          // The findAndModify family: a write that answers with the document.
          case 'findOneAndUpdate':
          case 'findOneAndReplace':
          case 'findOneAndDelete': {
            const filter = params.filter || {};
            const options = params.options || {};
            let outcome;

            if (params.operation === 'findOneAndDelete') {
              outcome = await coll.findOneAndDelete(filter, options);
            } else if (params.operation === 'findOneAndReplace') {
              if (!isPlainObject(params.replacement)) {
                return { success: false, message: 'findOneAndReplace requires params.replacement (object)' };
              }
              outcome = await coll.findOneAndReplace(filter, params.replacement, options);
            } else {
              if (!params.update || typeof params.update !== 'object') {
                return { success: false, message: 'findOneAndUpdate requires params.update (object or pipeline)' };
              }
              outcome = await coll.findOneAndUpdate(filter, params.update, options);
            }

            // Driver 5 wraps the document in { value, lastErrorObject, ok };
            // driver 6 returns the document itself. Read either.
            const doc = outcome && typeof outcome === 'object' && 'value' in outcome
              ? outcome.value
              : outcome;

            return {
              success: true,
              rows: doc ? [doc] : [],
              columns: doc ? Object.keys(doc) : [],
              rowCount: doc ? 1 : 0,
              message: doc ? null : `No document in "${params.collection}" matched`,
              json: true
            };
          }

          case 'bulkWrite': {
            const operations = Array.isArray(params.operations) ? params.operations : [];
            // Nothing to do is an ordinary outcome, and the driver rejects an
            // empty batch — the same reasoning as insertMany above.
            if (operations.length === 0) {
              return {
                success: true,
                message: `No write operations for "${params.collection}"`,
                rowCount: 0
              };
            }
            const bulk = await coll.bulkWrite(operations, params.options || {});
            const counts = {
              insertedCount: bulk.insertedCount || 0,
              matchedCount: bulk.matchedCount || 0,
              modifiedCount: bulk.modifiedCount || 0,
              deletedCount: bulk.deletedCount || 0,
              upsertedCount: bulk.upsertedCount || 0
            };
            return {
              success: true,
              message: `Inserted ${counts.insertedCount}, modified ${counts.modifiedCount}, `
                + `deleted ${counts.deletedCount}, upserted ${counts.upsertedCount} in "${params.collection}"`,
              rowCount: counts.insertedCount + counts.modifiedCount
                + counts.deletedCount + counts.upsertedCount,
              ...counts
            };
          }

          case 'count': {
            // Document count for params.filter (defaults to all docs).
            const n = await coll.countDocuments(params.filter || {});
            return {
              success: true,
              rows: [{ count: n }],
              columns: ['count'],
              rowCount: 1,
              count: n,
              json: true,
            };
          }

          case 'estimatedDocumentCount': {
            // Metadata rather than a scan: no filter is possible, and on a
            // large collection this is the count you can afford.
            const n = await coll.estimatedDocumentCount();
            return {
              success: true,
              rows: [{ count: n }],
              columns: ['count'],
              rowCount: 1,
              count: n,
              json: true,
            };
          }

          case 'distinct': {
            if (typeof params.field !== 'string' || !params.field) {
              return { success: false, message: 'distinct requires params.field (string)' };
            }
            // distinct answers with a bare array; the cap has to be applied
            // here, where we can still tell whether anything was left behind.
            const all = await coll.distinct(params.field, params.filter || {});
            const values = probe ? all.slice(0, limit) : all;
            return {
              success: true,
              // Scalars need a column to sit in, and the field the user asked
              // about is the one to name it after.
              rows: values.map((v) => ({ [params.field]: v })),
              columns: [params.field],
              rowCount: values.length,
              truncated: probe ? all.length > values.length : undefined,
              values,
              json: true,
            };
          }

          case 'createIndex': {
            if (!isPlainObject(params.keys)) {
              return { success: false, message: 'createIndex requires params.keys (object)' };
            }
            const name = await coll.createIndex(params.keys, params.options || {});
            return {
              success: true,
              message: `Created index "${name}" on "${params.collection}"`,
              rowCount: 0,
              indexName: name,
            };
          }

          case 'dropIndex': {
            if (!params.index) {
              return { success: false, message: 'dropIndex requires params.index (name or key pattern)' };
            }
            await coll.dropIndex(params.index);
            const label = typeof params.index === 'string'
              ? `"${params.index}"`
              : JSON.stringify(params.index);
            return {
              success: true,
              message: `Dropped index ${label} on "${params.collection}"`,
              rowCount: 0,
            };
          }

          case 'listIndexes': {
            const indexes = await coll.indexes();
            return {
              success: true,
              rows: indexes,
              columns: indexes.length ? Object.keys(indexes[0]) : [],
              rowCount: indexes.length,
              json: true,
            };
          }

          case 'renameCollection': {
            if (typeof params.target !== 'string' || !params.target) {
              return { success: false, message: 'renameCollection requires params.target (new name)' };
            }
            await coll.rename(params.target, { dropTarget: Boolean(params.dropTarget) });
            return {
              success: true,
              message: `Renamed "${params.collection}" to "${params.target}"`,
              rowCount: 0,
              // Both names moved: one is gone from the tree, the other is new.
              mutated: [
                { schema: db.databaseName, table: params.collection },
                { schema: db.databaseName, table: params.target },
              ],
            };
          }

          case 'aggregate': {
            // Run an aggregation pipeline. `params.pipeline` is required.
            if (!Array.isArray(params.pipeline)) {
              return { success: false, message: 'aggregate requires params.pipeline (array)' };
            }
            if (params.explain) {
              const plan = await coll.aggregate(params.pipeline)
                .explain(params.explain === true ? undefined : params.explain);
              return { success: true, rows: [plan], columns: Object.keys(plan), rowCount: 1, json: true };
            }
            // Consume the cursor only as far as the cap, rather than appending
            // a $limit stage — the pipeline stays exactly as the user wrote it.
            //
            // Two caps can apply: the explorer's (`probe`) and a `.limit(n)` the
            // user chained onto the call. The tighter one stops the iteration,
            // but only the explorer's makes the result TRUNCATED — a user who
            // asked for 10 and got 10 was not cut short. The plain `limit`
            // argument is deliberately not a cap here: callers reading a whole
            // collection through a pipeline pass no limit and must keep getting
            // everything.
            const asked = Number(params.limit) > 0 ? Number(params.limit) : Infinity;
            const ceiling = probe ? limit : Infinity;
            const stopAt = Math.min(asked, ceiling);

            let docs;
            let more = false;
            if (stopAt !== Infinity) {
              const cursor = coll.aggregate(params.pipeline);
              docs = [];
              try {
                // eslint-disable-next-line no-restricted-syntax
                for await (const doc of cursor) {
                  if (docs.length >= stopAt) { more = stopAt === ceiling; break; }
                  docs.push(doc);
                }
              } finally {
                await cursor.close().catch(() => {});
              }
            } else {
              docs = await coll.aggregate(params.pipeline).toArray();
            }
            const columns = docs.length ? Object.keys(docs[0]) : [];
            return {
              truncated: more,
              success: true,
              rows: docs,
              columns,
              rowCount: docs.length,
              json: true,
            };
          }

          default:
            return {
              success: false,
              message: `Unknown operation type: ${params.operation}`
            };
        }
      }

      // Default: run find query (honors optional sort / skip / projection)
      if (!params.collection) {
        return { success: false, message: 'A query needs a collection' };
      }
      const coll = db.collection(params.collection);
      let cursor = coll.find(params.filter || {});
      if (params.sort) cursor = cursor.sort(params.sort);
      if (params.skip) cursor = cursor.skip(params.skip);
      if (params.projection) cursor = cursor.project(params.projection);

      if (params.explain) {
        // A plan, not documents — the cap and the "is there more" probe below
        // have nothing to apply to.
        const plan = await cursor.explain(params.explain === true ? undefined : params.explain);
        return { success: true, rows: [plan], columns: Object.keys(plan), rowCount: 1, json: true };
      }
      // The cursor does the limiting. When the explorer asked for a cap we read
      // one extra document to tell whether more were waiting, then drop it.
      const requested = params.limit || limit;
      const fetched = await cursor
        .limit(probe ? Math.min(requested, limit) + 1 : requested)
        .toArray();

      const keep = probe ? Math.min(requested, limit) : requested;
      const docs = probe ? fetched.slice(0, keep) : fetched;
      const columns = docs.length ? Object.keys(docs[0]) : [];

      return {
        success: true,
        rows: docs,
        columns,
        rowCount: docs.length,
        truncated: probe ? fetched.length > docs.length : undefined,
        json: true
      };
    } catch (error) {
      console.log('error: ', error)
      return { success: false, message: error.message, rows: [], columns: [] };
    }
  },

  /**
   * Transform MongoDB data (aggregation, filter, update, delete, javascript)
   */
  transformData: async (config, connectionId, {
    sourceCollection,
    targetCollection,
    operationType,
    nosqlOperation,
    transformFunction,
    storageLocation,
    operationMode
  }) => {
    try {
      console.log('transformData: ',     sourceCollection,
      targetCollection,
      operationType,
      nosqlOperation,
      transformFunction,
      storageLocation,
      operationMode)
      const uri = config.uri;

      if (!uri) {
        return { success: false, message: 'MongoDB URI is required' };
      }

      const connection = await mongoose
        .createConnection(uri, { serverSelectionTimeoutMS: 8000 })
        .asPromise();

      const db = connection.db;
      const sourceColl = db.collection(sourceCollection);

      let transformedDocs = [];
      let totalProcessed = 0;

      // Parse the transform function if provided
      let transformFn = null;
      if (transformFunction) {
        try {
          // Create function from string
          transformFn = eval(`(${transformFunction})`);
        } catch (err) {
          await connection.close();
          return { success: false, message: `Failed to parse transform function: ${err.message}` };
        }
      }

      // Handle different operation types
      if (operationType === 'aggregation') {
        // Parse aggregation pipeline
        const pipeline = JSON.parse(nosqlOperation);

        if (storageLocation === 'database' && operationMode === 'new_table') {
          // Drop the target collection if it exists before creating new one
          try {
            await db.collection(targetCollection).drop();
          } catch (err) {
            // Ignore error if collection doesn't exist
            if (err.code !== 26) {  // 26 = NamespaceNotFound
              console.warn('Could not drop collection:', err.message);
            }
          }

          // Run aggregation and output to new collection in database
          if(!pipeline.find((e) => e.$out)) pipeline.push({ $out: targetCollection });
          await sourceColl.aggregate(pipeline).toArray();

          const targetColl = db.collection(targetCollection);
          const count = await targetColl.countDocuments();

          await connection.close();
          return {
            success: true,
            message: `Aggregation completed. ${count} documents in new collection "${targetCollection}"`,
            documentsProcessed: count
          };
        } else {
          // Stream aggregation results
          const cursor = sourceColl.aggregate(pipeline);

          for await (const doc of cursor) {
            totalProcessed++;

            // Apply JavaScript transformation if provided
            const finalDoc = transformFn ? transformFn(doc) : doc;

            if (finalDoc !== null && finalDoc !== undefined) {
              transformedDocs.push(finalDoc);
            }
          }
        }

      } else if (operationType === 'delete') {
        // Parse delete filter
        const filter = JSON.parse(nosqlOperation);

        if (operationMode === 'in_place') {
          const result = await sourceColl.deleteMany(filter);
          await connection.close();
          return {
            success: true,
            message: `Deleted ${result.deletedCount} documents`,
            documentsProcessed: result.deletedCount
          };
        }

      } else if (operationType === 'update') {
        // Parse update operation
        const updateOp = JSON.parse(nosqlOperation);

        if (operationMode === 'in_place') {
          const result = await sourceColl.updateMany(
            updateOp.filter,
            updateOp.update
          );
          await connection.close();
          return {
            success: true,
            message: `Updated ${result.modifiedCount} documents`,
            documentsProcessed: result.modifiedCount
          };
        }

      } else if (operationType === 'javascript') {
        // JavaScript transformation. `nosqlOperation` may be a plain filter
        // object OR an aggregation pipeline array (e.g. $group for DISTINCT
        // before the per-doc transform). In-place mode only supports a filter.
        const parsedOp = nosqlOperation ? JSON.parse(nosqlOperation) : {};
        const isPipeline = Array.isArray(parsedOp);
        const filter = isPipeline ? {} : parsedOp;

        // For in-place mode with JavaScript transformation, process in batches
        if (operationMode === 'in_place' && transformFn) {
          const BATCH_SIZE = 10000;
          let skip = 0;
          let totalUpdated = 0;

          while (true) {
            // Fetch batch of documents
            const docs = await sourceColl.find(filter).skip(skip).limit(BATCH_SIZE).toArray();

            if (docs.length === 0) {
              break; // No more documents to process
            }

            // Process batch: transform and prepare bulk update operations
            const bulkOps = [];
            for (const doc of docs) {
              totalProcessed++;

              try {
                const transformedDoc = transformFn(doc);

                if (transformedDoc !== null && transformedDoc !== undefined) {
                  // Remove _id from transformed doc to avoid update errors
                  const { _id, ...updateFields } = transformedDoc;
                  console.log('updateFields: ', updateFields, doc._id)
                  // Prepare bulk update operation
                  bulkOps.push({
                    updateOne: {
                      filter: { _id: doc._id },
                      update: { $set: updateFields }
                    }
                  });
                }
              } catch (transformErr) {
                console.error(`Transform error for doc ${doc._id}:`, transformErr);
              }
            }
            // console.log('bulkOps: ', bulkOps)
            // Execute bulk update for this batch
            if (bulkOps.length > 0) {
              const result = await sourceColl.bulkWrite(bulkOps);
              totalUpdated += result.modifiedCount;
            }

            skip += BATCH_SIZE;
          }

          await connection.close();
          return {
            success: true,
            message: `JavaScript transformation completed. ${totalUpdated} documents updated in place (${totalProcessed} documents processed)`,
            documentsProcessed: totalProcessed,
            documentsUpdated: totalUpdated
          };
        }

        // For new_table mode, fetch source docs via the connector's own
        // runQuery — it already routes a filter object → find() and a pipeline
        // array → aggregate(), so we don't duplicate that branching here.
        const sourceQuery = isPipeline
          ? { collection: sourceCollection, operation: 'aggregate', pipeline: parsedOp }
          : { collection: sourceCollection, filter, limit: Number.MAX_SAFE_INTEGER };

        const sourceResult = await module.exports.runQuery(config, connectionId, sourceQuery);
        if (!sourceResult.success) {
          await connection.close();
          return { success: false, message: `Failed to read source documents: ${sourceResult.message}` };
        }

        for (const doc of (sourceResult.rows || [])) {
          totalProcessed++;

          if (transformFn) {
            const transformedDoc = transformFn(doc);

            if (transformedDoc !== null && transformedDoc !== undefined) {
              transformedDocs.push(transformedDoc);
            }
          }
        }
      } else if (operationType === 'filter') {
        // Simple filter operation
        const filter = JSON.parse(nosqlOperation);

        const cursor = sourceColl.find(filter);

        for await (const doc of cursor) {
          totalProcessed++;

          // Apply JavaScript transformation if provided
          const finalDoc = transformFn ? transformFn(doc) : doc;

          if (finalDoc !== null && finalDoc !== undefined) {
            transformedDocs.push(finalDoc);
          }
        }
      }

      // Handle where to store the results (database only - local storage handled in electron.js)
      if (transformedDocs.length > 0) {
        if (storageLocation === 'database') {
          // Drop the target collection if it exists before creating new one
          if (operationMode === 'new_table') {
            try {
              await db.collection(targetCollection).drop();
            } catch (err) {
              // Ignore error if collection doesn't exist
              if (err.code !== 26) {  // 26 = NamespaceNotFound
                console.warn('Could not drop collection:', err.message);
              }
            }
          }

          // Insert into new collection in MongoDB
          const targetColl = db.collection(targetCollection);
          await targetColl.insertMany(transformedDocs);
          await connection.close();

          return {
            success: true,
            message: `Transformation completed. ${transformedDocs.length} documents inserted into "${targetCollection}"`,
            documentsProcessed: totalProcessed,
            documentsInserted: transformedDocs.length
          };
        } else {
          // For local storage, return the documents for electron.js to handle
          await connection.close();
          return {
            success: true,
            transformedDocs,
            totalProcessed,
            needsLocalStorage: true
          };
        }
      }

      await connection.close();
      return {
        success: true,
        message: `Transformation completed. ${totalProcessed} documents processed, 0 output (all filtered out)`,
        documentsProcessed: totalProcessed,
        documentsInserted: 0
      };

    } catch (err) {
      return {
        success: false,
        message: `Transformation failed: ${err.message}`,
        error: err.stack
      };
    }
  },

  /**
   * Close MongoDB connection
   */
  closeConnection: async (connectionId) => {
    if (connections.has(connectionId)) {
      const connection = connections.get(connectionId);
      await connection.close();
      connections.delete(connectionId);
    }
  },

  /**
   * Batch insert documents into a collection (uses insertMany with ordered: false)
   */
  batchInsert: async (config, connectionId, collectionName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const connection = await getConnection(config, connectionId);
      const db = connection.db(config.database);
      const collection = db.collection(collectionName);

      // Convert rows to MongoDB documents
      const documents = rows.map(row => {
        const doc = {};
        columns.forEach(col => {
          const val = row[col];
          if (val !== null && val !== undefined) {
            doc[col] = val;
          }
        });
        return doc;
      });

      // Use insertMany with ordered: false for better performance
      const result = await collection.insertMany(documents, { ordered: false });

      return {
        success: true,
        rowsInserted: result.insertedCount
      };
    } catch (error) {
      return queryError(error);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'uri',
        type: 'string',
        label: 'Connection URI',
        placeholder: 'mongodb://localhost:27017/mydb',
        required: true,
        sensitive: true,
        helpText: 'Full MongoDB connection string (e.g., mongodb://user:pass@host:port/database)'
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating transformations specific to MongoDB
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName, _fullTableName, serverVersion) => `You are a MongoDB expert helping create a new transformed collection.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Source Collection: ${sourceTableSchema.tableName}
    Target Collection: ${targetTableName}
    Storage Location: ${settings.storageLocation === 'database' ? 'MongoDB database' : 'Local file'}
    MongoDB server version: ${serverVersion || 'unknown — assume a MongoDB 4.0 baseline and use only widely-supported operators'}

    **Instructions**:

    You are creating a NEW collection with transformed data. The target
    collection is TRUNCATED AND LOADED on every run — it is replaced wholesale
    by what this operation produces, and nothing from a previous run survives.
    Do not try to merge, upsert, or de-duplicate against what was there last
    time, and do not skip documents on the grounds that an earlier run already
    handled them. Choose the appropriate transformation approach:

    1. **Aggregation Pipeline** (Recommended for MongoDB):
       - Use for: filtering, grouping, projecting fields, lookups, mathematical operations
       - Most efficient for complex transformations
       - Returns aggregation pipeline as JSON array
       - The $out stage is injected automatically, don't include it
       - Only use operators available on the server version above. As a guide: $regexMatch requires 4.2, $getField / $setField require 5.0, and $function / $accumulator require 4.4 (but see the ban below — do not use them regardless).

    2. **Filter Operation**:
       - Simple document filtering based on criteria
       - Returns filter object

    3. **JavaScript Transformation**:
       - Use when aggregation cannot handle the transformation
       - Complex string manipulations, custom business logic, conditional transformations
       - Returns a JavaScript function that transforms each document
       - Function signature: function transformDocument(doc) { return transformedDoc; }
       - Return null to exclude a document from the output
       - This runs in Node.js, so require('crypto') and other Node modules ARE available here — unlike inside the aggregation pipeline.

    **CRITICAL — never use server-side JavaScript operators in the aggregation pipeline**:
    - Do NOT emit $function, $accumulator, $where, or mapReduce. They are rejected outright on Atlas shared tiers (M0/M2/M5) and any server started with --noscripting, and even where enabled their JS scope has NO require() and no Node modules — so require('crypto') inside a $function body always fails.
    - If the transformation needs logic aggregation operators cannot express — hashing, cryptographic digests, arbitrary string algorithms — do NOT reach for $function. Instead return "operationType": "javascript" with a transformFunction, which runs server-side of this app in Node.js where require('crypto') works. Example: to build a stable id, hash inside transformDocument with require('crypto').createHash('sha256').

    **Important Notes**:
    - You are creating a NEW collection, not modifying the source
    - All source documents matching your criteria will be transformed and inserted into "${targetTableName}"
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "operationType": "aggregation" | "filter" | "javascript",
      "nosqlOperation": "MongoDB aggregation pipeline array or filter object as JSON string",
      "targetColumns": [{"name": "field", "type": "TYPE"}],   // EVERY top-level field the output documents have — downstream nodes are configured from this, so it must match what the operation actually emits ("*" if the fields are unchanged from the source)
      "transformFunction": "JavaScript function code as string (ONLY if operationType is 'javascript', otherwise null). Also still provide nosqlOperation for the query filter"
    }

    **Examples**:

    Aggregation (filtering + projection):
    {
      "explanation": "Filter orders over $100 and project customer info",
      "operationType": "aggregation",
      "nosqlOperation": "[{ \\"$match\\": { \\"total\\": { \\"$gt\\": 100 } } }, { \\"$project\\": { \\"customerId\\": 1, \\"total\\": 1, \\"date\\": 1 } }]",
      "targetColumns": [{"name": "_id", "type": "ObjectId"}, {"name": "customerId", "type": "string"}, {"name": "total", "type": "number"}, {"name": "date", "type": "date"}],
      "transformFunction": null
    }

    Filter operation:
    {
      "explanation": "Filter documents matching criteria",
      "operationType": "filter",
      "nosqlOperation": "{ \\"status\\": \\"active\\", \\"total\\": { \\"$gt\\": 100 } }",
      "targetColumns": "*",
      "transformFunction": null
    }

    JavaScript transformation:
    {
      "explanation": "Custom validation and formatting that requires complex logic",
      "operationType": "javascript",
      "nosqlOperation": "{ \\"status\\": \\"active\\" }",
      "transformFunction": "function transformDocument(doc) { if (!doc.email || !doc.email.includes('@')) return null; return { ...doc, email: doc.email.toLowerCase().trim(), validated: true }; }"
    }

    Provide working MongoDB operations.`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceTableSchema, _targetSchema, _fullTableName, serverVersion) => `You are a MongoDB expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Source Collection: ${sourceTableSchema.tableName}
    Operation Mode: In-Place (modifying source collection directly)
    MongoDB server version: ${serverVersion || 'unknown — assume a MongoDB 4.0 baseline and use only widely-supported operators'}

    **Instructions**:

    You are modifying the EXISTING collection. Choose the appropriate operation:

    1. **Delete Operation**:
       - Remove documents that match specific criteria
       - Returns deleteMany filter object
       - Documents matching the filter will be permanently deleted from "${sourceTableSchema.tableName}"

    2. **Update Operation**:
       - Update fields in documents that match specific criteria
       - Returns filter object and update operations
       - Uses MongoDB update operators like $set, $unset, $inc, etc.
       - Best for simple updates (setting values, incrementing, removing fields)
       - If you use an aggregation-pipeline update, only use operators available on the server version above, and never $function / $accumulator / $where (see the ban below).

    3. **JavaScript Transformation** (for complex logic):
       - Use when update operators cannot handle the transformation
       - Complex string manipulations, conditional logic, calculations across multiple fields
       - Returns a JavaScript function that transforms each document in-place
       - Function signature: function transformDocument(doc) { /* modify doc fields */ return doc; }
       - Documents are processed in batches of 10,000 for efficiency
       - Return the modified document (do NOT return null to skip - that's not supported for in-place updates)
       - nosqlOperation should contain the filter to select documents to transform
       - This runs in Node.js, so require('crypto') and other Node modules ARE available here — reach for this (not $function) whenever the logic needs hashing or other Node-only capabilities.

    **CRITICAL — never use server-side JavaScript operators**:
    - Do NOT emit $function, $accumulator, $where, or mapReduce. They are rejected on Atlas shared tiers and any --noscripting server, and their JS scope has no require()/Node modules. For hashing/crypto/arbitrary algorithms use operationType "javascript" (runs in Node) instead.

    **Important Notes**:
    - You are MODIFYING the source collection "${sourceTableSchema.tableName}" directly
    - Changes are permanent and irreversible
    - Delete removes documents completely from the collection
    - Update modifies existing documents in-place (using MongoDB operators)
    - JavaScript transformation modifies documents in-place with custom logic (processed in 10k batches)
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of what will be deleted or updated and why",
      "operationType": "delete" | "update" | "javascript",
      "nosqlOperation": "For delete: filter object. For update: { \\"filter\\": {...}, \\"update\\": {...} }. For javascript: filter object as JSON string",
      "targetColumns": [{"name": "field", "type": "TYPE"}],   // the collection's top-level fields AFTER the change, or "*" when the change adds no new field (plain delete / value update)
      "transformFunction": "JavaScript function code as string (ONLY if operationType is 'javascript', otherwise null)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders from the collection",
      "operationType": "delete",
      "nosqlOperation": "{ \\"status\\": \\"cancelled\\" }",
      "targetColumns": "*",
      "transformFunction": null
    }

    Update operation:
    {
      "explanation": "Mark all old orders as archived",
      "operationType": "update",
      "nosqlOperation": "{ \\"filter\\": { \\"createdAt\\": { \\"$lt\\": \\"2024-01-01\\" } }, \\"update\\": { \\"$set\\": { \\"archived\\": true, \\"archivedDate\\": \\"{{current_date}}\\" } } }",
      "targetColumns": [{"name": "_id", "type": "ObjectId"}, {"name": "createdAt", "type": "date"}, {"name": "archived", "type": "boolean"}, {"name": "archivedDate", "type": "date"}],
      "transformFunction": null
    }

    Update with multiple fields:
    {
      "explanation": "Update pricing for premium products",
      "operationType": "update",
      "nosqlOperation": "{ \\"filter\\": { \\"category\\": \\"premium\\" }, \\"update\\": { \\"$set\\": { \\"discounted\\": true }, \\"$inc\\": { \\"price\\": -10 } } }",
      "transformFunction": null
    }

    JavaScript transformation (complex logic):
    {
      "explanation": "Apply complex pricing calculation based on multiple fields that cannot be done with update operators. Documents will be processed in batches of 10,000.",
      "operationType": "javascript",
      "nosqlOperation": "{ \\"status\\": \\"active\\" }",
      "transformFunction": "function transformDocument(doc) { if (doc.quantity > 100 && doc.category === 'premium') { doc.price = doc.price * 0.9; doc.discountApplied = true; } doc.lastModified = new Date().toISOString(); return doc; }"
    }

    Provide working MongoDB operations.`
  }),

  /**
   * Data Explorer dialect. Read by public/database/dialect.js.
   *
   * Document stores start from an empty keyword baseline (SQL words would only
   * pollute completions), so everything the editor offers is listed here.
   */
  explorer: {
    language: 'json',
    container: 'Database',
    objectLabel: 'Collection',
    quote: '"',
    // runQuery accepts { maxRows } and caps the cursor with it — find() via
    // .limit(), aggregate() by stopping the iteration. The query the user
    // typed is never edited to add a limit.
    maxRowsOption: true,
    keywords: [
      // everything SHELL_METHODS and DB_METHODS accept, plus the cursor chain
      'db', 'find', 'findOne', 'aggregate', 'count', 'countDocuments',
      'estimatedDocumentCount', 'distinct',
      'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
      'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace',
      'findOneAndDelete', 'bulkWrite',
      'drop', 'renameCollection', 'createIndex', 'dropIndex', 'getIndexes',
      'getCollectionNames', 'getCollectionInfos', 'createCollection',
      'runCommand', 'stats',
      'sort', 'limit', 'skip', 'project', 'explain', 'toArray',
      // pipeline stages
      '$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind',
      '$lookup', '$addFields', '$set', '$unset', '$replaceRoot', '$facet',
      '$bucket', '$count', '$sample', '$sortByCount', '$graphLookup', '$merge',
      // query operators
      '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or',
      '$not', '$nor', '$exists', '$type', '$regex', '$options', '$elemMatch',
      '$size', '$all', '$expr',
      // update operators — updateOne/updateMany/findOneAndUpdate run here now
      '$inc', '$mul', '$rename', '$currentDate', '$setOnInsert', '$pull',
      '$pullAll', '$pop', '$each', '$position',
    ],
    functions: [
      // accumulators and expression operators worth completing
      '$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet',
      '$count', '$concat', '$substr', '$toLower', '$toUpper', '$dateToString',
      '$dateFromString', '$dateTrunc', '$year', '$month', '$dayOfMonth',
      '$cond', '$ifNull', '$switch', '$round', '$multiply', '$divide',
      '$subtract', '$add', '$size', '$arrayElemAt', '$filter', '$map',
      // shell constructors
      'ISODate', 'ObjectId', 'NumberLong', 'NumberDecimal', 'Date',
    ],

    /** Editor text → the params object runQuery expects. */
    parseQuery: parseExplorerQuery,

    /**
     * Preview a collection in the same shell syntax the editor teaches, so
     * what opens in a new worksheet is something the user could have typed.
     */
    previewQuery: (schema, collection, limit = 100) =>
      `db.${collection}.find({}).limit(${limit})`,

    /**
     * Syntax check. The generic JSON check can't help here — `db.x.find({…})`
     * isn't JSON — so this parses the statement exactly the way running it
     * would, and reports whatever that rejects.
     *
     * `handled: true` tells public/database/validate.js not to add its own
     * findings on top.
     */
    validate: (text) => {
      try {
        parseExplorerQuery(text);
        return { handled: true, issues: [] };
      } catch (err) {
        const msg = String(err.message || 'Invalid query');
        // mongodb-query-parser reports (line:col) against a source it wraps in
        // a leading newline, with 0-based columns. Correct both, and clamp so
        // an end-of-input error still lands on a real line.
        const at = /\((\d+):(\d+)\)/.exec(msg);
        const lines = String(text || '').split('\n');
        let line = 1;
        let column = 1;
        if (at) {
          line = Math.min(Math.max(1, Number(at[1]) - 1), lines.length);
          column = Math.min(Math.max(1, Number(at[2]) + 1), (lines[line - 1] || '').length + 1);
        }
        // The raw text is "Unexpected token (3:0) in (\n…source…\n)" — drop the
        // echoed source and the position, both of which we report separately.
        const clean = msg.split('\n')[0]
          .replace(/\s*in\s*\($/, '')
          .replace(/\s*\(\d+:\d+\)/, '')
          .trim();

        return {
          handled: true,
          issues: [{ line, column, message: clean || 'Invalid query', severity: 'error' }],
        };
      }
    },
  }
};
