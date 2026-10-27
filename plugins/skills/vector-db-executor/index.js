/**
 * Vector Database Executor Skill Plugin
 * Handles vector operations with embedding generation for LanceDB and Pinecone
 */

const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { generateId, prepareVectorRecords, formatVectorResults, sanitizeTableName } = require('./lib/utils');
const joinHandler = require('./joinHandler');

// Load source data helpers (similar to python-executor)
// The app's own connections metadata store (see loadConnection below) — not
// user data, which lives in DuckDB.
const Datastore = require('@seald-io/nedb');
const fs = require('fs');

// Vector libs (embeddings + lancedb) live at host level (public/lib) and
// arrive via params.helpers. They're bound to module-locals once at the
// start of each lifecycle method so internal call sites stay unchanged.
let generateEmbeddings, estimateOpenAICost, getEmbeddingDimension;
let executeLanceDBOperation, listLanceTables, getLanceDBConnection, toPlainRows, normalizeRecordsForArrow;

// Cooperative stop, injected by the host alongside the vector libs above (see
// buildSkillHelpers in public/electron.js). `throwIfCancelled` raises when the
// user has stopped the run this skill is executing inside; `isCancelledError`
// is how the best-effort catches below tell that raise apart from a real
// failure they are meant to swallow.
//
// Defaulted to no-ops rather than required: a host that predates them, or a
// direct test of this skill, still runs — it just cannot be stopped part-way.
let throwIfCancelled = () => {};
let isCancelledError = () => false;

// The host's unified local/remote data access. Bound the same way as the libs
// above so internal call sites can write a local DuckDB table without every
// signature having to carry `helpers` down to them.
let runLocalQuery = null;

function bindLibs(helpers) {
  if (!helpers || !helpers.embeddings || !helpers.lancedb) {
    throw new Error('vector-db-executor requires helpers.embeddings and helpers.lancedb (electron must inject helpers).');
  }
  ({ generateEmbeddings, estimateOpenAICost, getEmbeddingDimension } = helpers.embeddings);
  ({ executeLanceDBOperation, listTables: listLanceTables, getLanceDBConnection, toPlainRows, normalizeRecordsForArrow } = helpers.lancedb);
  ({
    throwIfCancelled = () => {},
    isCancelledError = () => false,
  } = helpers.cancel || {});
  runLocalQuery = typeof helpers.runQuery === 'function' ? helpers.runQuery : null;
}

// Normalize a vector value into a PLAIN number array. Vectors read back from
// LanceDB arrive as a Float32Array / Arrow vector (NOT a JS Array), so the old
// `Array.isArray(v) ? v : [v]` wrapped a 1536-element typed array into a
// length-1 array — which made Pinecone auto-create the index with dimension 1
// and then reject the real 1536-dim vectors ("dimension 1536 does not match the
// dimension of the index 1"). Array.from() unwraps typed arrays / iterables to
// real numbers; only a genuine scalar is wrapped as a single-element vector.
const toVectorArray = (v) => {
  if (v == null) return v;
  if (Array.isArray(v)) return v;
  if (typeof v.toArray === 'function') return Array.from(v.toArray()); // Arrow vector
  if (ArrayBuffer.isView(v) || typeof v.length === 'number') return Array.from(v); // TypedArray / array-like
  return [v]; // genuine scalar
};

/**
 * The id a record is written under — the ONE rule every vector write uses
 * (Transformer embed, Output, Join into a vector store), in every write mode.
 *
 *   1. `idColumn` — the row's primary key, named explicitly: chosen by the
 *      model for a Transformer or Join, picked by the user on an Output.
 *   2. Otherwise a hash of the whole row (vector and fingerprint fields
 *      excluded), for upsert and truncate alike.
 *
 * Not a hash of the embedded text: rows that share their text but differ in
 * their other fields would collide on one id and overwrite each other. And the
 * same rule in both modes, so switching a node between Truncate and Append
 * finds the records it wrote instead of adding a second copy.
 *
 * Without an idColumn a row whose fields change gets a new id: an upsert adds
 * it and the old record stays until a truncate. Naming an idColumn is what
 * lets a changed row replace its record.
 *
 * Never the row's own `id` field by name (it need not be a key), and never a
 * random id — a random id can never match an existing record, so every run
 * added another copy.
 */
function resolveRecordId(row, { idColumn = null } = {}) {
  const usable = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  if (idColumn && usable(row?.[idColumn])) return String(row[idColumn]);
  return `row_${rowHashOf(row)}`;
}

/** Fingerprint of a row's content, ignoring the vector and write bookkeeping. */
function rowHashOf(row) {
  const out = {};
  for (const k of Object.keys(row || {}).sort()) {
    if (k === 'vector' || k === 'values' || k === 'embedding' || k.startsWith('_embedded') || k.startsWith('_embedding')
      || k === CONTENT_HASH_FIELD || k === META_HASH_FIELD) continue;
    out[k] = row[k];
  }
  return contentHashOf(JSON.stringify(out));
}

/**
 * Fingerprint of the text that was actually embedded.
 *
 * Identity and freshness are separate questions. `idColumn` answers "which row
 * is this" — it stays put when the row is edited, which is the whole point of a
 * key. This answers "is the stored vector still the right one for this text",
 * which is what `skipExisting` actually needs to decide.
 *
 * It also removes any need for the caller to understand HOW the embedded value
 * was produced. A concatenation, a CASE expression or a rewritten column all
 * arrive as one resolved string on the row, and the hash covers that string —
 * so a derived value is tracked exactly as accurately as a plain column.
 */
function contentHashOf(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 24);
}

// Metadata key holding the fingerprint. Written alongside every vector and read
// back during the existence check; kept out of the user-facing target columns.
const CONTENT_HASH_FIELD = '_content_hash';
const META_HASH_FIELD = '_meta_hash';

// Fields that describe the embedding rather than the row, so they never count
// as a metadata change.
const INTERNAL_FIELDS = new Set([
  'vector', 'values', 'embedding', 'id', '_id', '__vid',
  CONTENT_HASH_FIELD, META_HASH_FIELD,
  '_embedded_column', '_embedding_provider', '_embedding_model', '_embedded_at'
]);

/**
 * Fingerprint of everything stored ALONGSIDE the vector.
 *
 * Separate from the content hash because the two imply different work: changed
 * text needs a new embedding, changed metadata does not. A price edit should
 * refresh the stored price without paying to re-embed a name that never moved.
 */
function metadataHashOf(row) {
  const parts = Object.keys(row || {})
    .filter((k) => !INTERNAL_FIELDS.has(k))
    .sort()
    .map((k) => {
      const v = row[k];
      return `${k}=${v === null || v === undefined ? '' : String(v)}`;
    });
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

/**
 * The columns an embed-and-upsert writes on TOP of the ones the model named.
 *
 * They used to be left out of the declared target columns as "not user-facing",
 * which made the node advertise an output shape narrower than what it actually
 * wrote. The next node then read the REAL table, recorded all of them as its
 * input, and the two records disagreed from that moment on — enough for the
 * build executor's schema gate to rebuild a downstream node on every later
 * plan, unasked.
 *
 * WHICH ones depends on the store, because the two write paths differ:
 *   - LanceDB gets the whole embedded record, so the four provenance fields
 *     that generateEmbeddings stamps on (public/lib/embeddings.js) land in the
 *     table as columns.
 *   - Pinecone and the other cloud stores take { id, vector, metadata }, and
 *     the metadata is built by DELETING those same four fields (see the upsert
 *     in execute()). Declaring them there would advertise columns that will
 *     never exist, and a downstream node configured from this list would
 *     reference them.
 * Both keep `id` and the two fingerprints this skill reads back for change
 * detection.
 */
const VECTOR_RECORD_COLUMNS = [
  { name: 'id', type: 'TEXT' },
  { name: CONTENT_HASH_FIELD, type: 'TEXT' },
  { name: META_HASH_FIELD, type: 'TEXT' },
];
const EMBEDDING_PROVENANCE_COLUMNS = [
  { name: '_embedded_column', type: 'TEXT' },
  { name: '_embedding_provider', type: 'TEXT' },
  { name: '_embedding_model', type: 'TEXT' },
  { name: '_embedded_at', type: 'TEXT' },
];

const writtenVectorColumns = (vectorDbType) => (
  String(vectorDbType || '').toLowerCase() === 'lancedb'
    ? [...VECTOR_RECORD_COLUMNS, ...EMBEDDING_PROVENANCE_COLUMNS]
    : VECTOR_RECORD_COLUMNS
);

/**
 * Declared columns plus the ones an upsert to THIS store always adds, without
 * duplicating anything the model already named. "*" means "the source's
 * columns pass through unchanged" and stays as it is — the builder resolves it
 * against the real source schema, and appending to it would turn a wildcard
 * into a partial list.
 */
function withWrittenVectorColumns(targetColumns, vectorDbType) {
  if (!Array.isArray(targetColumns)) return targetColumns;
  if (targetColumns.some((c) => c === '*' || c?.name === '*')) return targetColumns;
  const have = new Set(
    targetColumns.map((c) => String(typeof c === 'string' ? c : c?.name || '').toLowerCase()),
  );
  return [
    ...targetColumns,
    ...writtenVectorColumns(vectorDbType).filter((c) => !have.has(c.name.toLowerCase())),
  ];
}

/** Metadata payload for a row: everything except the vector and the internals. */
function metadataPayload(row) {
  const meta = { ...row };
  ['vector', 'values', 'embedding', '_embedded_column', '_embedding_provider',
   '_embedding_model', '_embedded_at', '__vid'].forEach((k) => delete meta[k]);
  return meta;
}

/**
 * Decide, before anything is embedded, what each row of a vector write needs —
 * the same rule for every node that writes vectors (Transformer embed, Output,
 * Join):
 *
 *   - every row gets its id (resolveRecordId, carried on `__vid` so a source's
 *     own `id` column is never mistaken for it) and two fingerprints: of the
 *     embedded text and of the other columns;
 *   - when upserting, the ids already stored are looked up and
 *       unchanged rows are skipped (no tokens spent),
 *       rows whose other columns changed are rewritten without re-embedding,
 *       new rows and rows whose text changed are returned to be embedded;
 *   - truncate & load embeds every row (the target is emptied first).
 *
 * `target` addresses the destination for the lookup — the same shape
 * findExistingRecords / applyMetadataUpdates take. Returns
 * { toEmbed, skipped, metadataUpdated, changedText } — changedText counts the
 * stored records among toEmbed whose embedded text changed.
 */
async function prepareRowsForWrite(rows, { idColumn = null, columnToEmbed = null, mode = 'upsert', target = null } = {}) {
  const prepared = (rows || []).map((row) => ({
    ...row,
    __vid: resolveRecordId(row, { idColumn }),
    [CONTENT_HASH_FIELD]: contentHashOf(columnToEmbed ? row?.[columnToEmbed] : ''),
    [META_HASH_FIELD]: metadataHashOf(row),
  }));
  if (mode !== 'upsert' || !target || prepared.length === 0) {
    return { toEmbed: prepared, skipped: 0, metadataUpdated: 0, changedText: 0 };
  }

  const existing = await findExistingRecords({ ...target, ids: prepared.map((r) => r.__vid) });
  if (existing.size === 0) return { toEmbed: prepared, skipped: 0, metadataUpdated: 0, changedText: 0 };

  const toEmbed = [];
  const metadataOnly = [];
  let skipped = 0;
  let changedText = 0;
  for (const row of prepared) {
    const stored = existing.get(row.__vid);
    if (!stored || stored.content !== row[CONTENT_HASH_FIELD]) {                    // new, or text changed
      if (stored) changedText += 1;
      toEmbed.push(row);
    } else if (stored.meta !== row[META_HASH_FIELD]) metadataOnly.push(row);          // vector still right
    else skipped += 1;                                                              // unchanged
  }
  const metadataUpdated = await applyMetadataUpdates({
    rows: metadataOnly.map(({ __vid, ...r }) => ({ ...r, id: __vid })),
    ...target,
  });
  console.log(`[vector] ${skipped} unchanged record(s) skipped; ${metadataOnly.length} metadata-only; `
    + `${toEmbed.length} to embed (${changedText} with changed text).`);
  return { toEmbed, skipped, metadataUpdated, changedText };
}

/**
 * Rewrite metadata for records whose vector is still correct. Returns how many
 * were updated. Never calls the embedding API — that is the entire point.
 */
async function applyMetadataUpdates({
  rows,
  vectorDbType,
  targetTable,
  indexName,
  namespace = '',
  targetLocalPath = null,
  targetConnectionId = null,
  pluginManager = null,
  getFullConfig = null
}) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  try {
    if (vectorDbType === 'lancedb') {
      // LanceDB updates by delete+add, so the row has to be written back whole.
      // Read the stored vectors and reuse them rather than regenerating.
      const dbPath = targetLocalPath || path.join(app.getPath('userData'), 'data', 'lancedb');
      const db = await getLanceDBConnection({ dbPath });
      const table = await db.openTable(targetTable);

      const quoted = rows.map((r) => `'${String(r.id).replace(/'/g, "''")}'`).join(', ');
      const stored = await table.query().where(`id IN (${quoted})`).toArray();
      const vectorById = new Map(stored.map((r) => [String(r.id), toVectorArray(r.vector)]));

      const updates = rows
        .filter((r) => vectorById.has(String(r.id)))
        .map((r) => ({ ...metadataPayload(r), id: String(r.id), vector: vectorById.get(String(r.id)) }));

      if (updates.length === 0) return 0;

      // Written back through the upsert, which merges by id in one atomic
      // rewrite. The 'update' operation deleted the records and then added
      // them back — a failure between the two lost them.
      await executeLanceDBOperation({
        operation: 'upsert',
        data: updates,
        config: { dbPath, tableName: targetTable }
      });
      return updates.length;
    }

    if (!pluginManager || !getFullConfig || !targetConnectionId) return 0;
    const connector = pluginManager.getConnector(vectorDbType);
    if (!connector || typeof connector.executeVectorOperation !== 'function') return 0;
    const fullConfig = await getFullConfig(targetConnectionId);
    if (!fullConfig) return 0;

    // Pinecone updates metadata in place, one record per call — there is no
    // bulk metadata endpoint.
    let updated = 0;
    for (const row of rows) {
      // One network call per row, so this loop is unbounded in time on a large
      // refresh and has to be stoppable.
      throwIfCancelled('refreshing vector metadata', `${updated} of ${rows.length} updated`);

      const res = await connector.executeVectorOperation(fullConfig, targetConnectionId, {
        operation: 'update',
        indexName,
        namespace,
        id: String(row.id),
        metadata: metadataPayload(row)
      });
      if (res && res.success !== false) updated += 1;
    }
    return updated;
  } catch (error) {
    // A stop is not a failed refresh. This catch exists to swallow provider
    // errors so a best-effort step cannot fail the node — swallowing a stop
    // here instead would let the run carry on to the next step as if the user
    // had never pressed anything.
    if (isCancelledError(error)) throw error;
    // Metadata refresh is best-effort: the vectors themselves are already
    // correct, so a failure here must not fail the node.
    console.warn(`[vector] metadata refresh failed: ${error.message}`);
    return 0;
  }
}

/**
 * Which of `ids` are already stored, mapped to the fingerprints each was written
 * with ({content, meta}; null entries when the record predates fingerprinting).
 * An empty Map
 * means "insert everything", which is also what a missing table/index yields,
 * so a first run behaves normally.
 */
async function findExistingRecords({
  vectorDbType,
  ids,
  targetTable,
  indexName,
  namespace = '',
  targetLocalPath = null,
  targetConnectionId = null,
  pluginManager = null,
  getFullConfig = null
}) {
  const found = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return found;

  try {
    if (vectorDbType === 'lancedb') {
      const dbPath = targetLocalPath || path.join(app.getPath('userData'), 'data', 'lancedb');
      const db = await getLanceDBConnection({ dbPath });
      const tables = await db.tableNames();
      if (!tables.includes(targetTable)) return found;

      const table = await db.openTable(targetTable);
      // The fingerprint column only exists on tables written since it was
      // introduced; ask for it, and fall back to ids alone if it isn't there.
      const cols = ['id', CONTENT_HASH_FIELD, META_HASH_FIELD];
      // Quote ids for the SQL-ish filter LanceDB accepts, chunked so the
      // expression stays a sane length on large batches.
      for (let i = 0; i < ids.length; i += 500) {
        throwIfCancelled('checking which vectors already exist', `${i} of ${ids.length} checked`);

        const chunk = ids.slice(i, i + 500)
          .map((id) => `'${String(id).replace(/'/g, "''")}'`)
          .join(', ');
        let rows;
        try {
          rows = await table.query().where(`id IN (${chunk})`).select(cols).toArray();
        } catch {
          rows = await table.query().where(`id IN (${chunk})`).select(['id']).toArray();
        }
        rows.forEach((r) => found.set(String(r.id), {
          content: r[CONTENT_HASH_FIELD] || null,
          meta: r[META_HASH_FIELD] || null
        }));
      }
      return found;
    }

    // Cloud stores: fetch by id through the connector.
    if (!pluginManager || !getFullConfig || !targetConnectionId) return found;
    const connector = pluginManager.getConnector(vectorDbType);
    if (!connector || typeof connector.executeVectorOperation !== 'function') return found;

    const fullConfig = await getFullConfig(targetConnectionId);
    if (!fullConfig) return found;

    // Pinecone caps ids per fetch; batch well under it.
    for (let i = 0; i < ids.length; i += 100) {
      // 100 ids per round-trip, so a 100k-row upsert probes a thousand times
      // before it embeds anything.
      throwIfCancelled('checking which vectors already exist', `${i} of ${ids.length} checked`);

      const batch = ids.slice(i, i + 100);
      const res = await connector.executeVectorOperation(fullConfig, targetConnectionId, {
        operation: 'fetch',
        indexName,
        namespace,
        ids: batch
      });
      if (res && res.success !== false) {
        (res.rows || []).forEach((r) => {
          if (r?.id != null) found.set(String(r.id), {
            content: r.metadata?.[CONTENT_HASH_FIELD] || null,
            meta: r.metadata?.[META_HASH_FIELD] || null
          });
        });
      }
    }
    return found;
  } catch (error) {
    // A stop must not be read as a failed probe. The fallback below is "insert
    // everything", so swallowing a stop here would do the opposite of what the
    // user asked: it would go on to embed and write the whole source.
    if (isCancelledError(error)) throw error;
    // A failed existence probe must not block the write — fall back to
    // inserting everything rather than silently dropping the user's data.
    console.warn(`[vector] existence check failed, inserting all records: ${error.message}`);
    return new Map();
  }
}

const replaceNulls = (value) => {
  if (value === null) return '';

  if (Array.isArray(value)) {
    return value.map(replaceNulls);
  }

  if (typeof value === 'object' && value !== null) {
    const result = {};
    for (const key in value) {
      result[key] = replaceNulls(value[key]);
    }
    return result;
  }

  return value;
}

module.exports = {
  type: 'skill',
  id: 'vector-db-executor',
  name: 'Vector Database Executor',
  category: 'both',
  icon: './icon.svg',
  supportsInteraction: true,


  /**
   * Get skill description and capabilities
   */
  getDescription: () => ({
    name: 'Vector Database Executor',
    description: 'Perform embedding or vector operations with automatic embedding generation',
    capabilities: [
      'Generate embeddings using OpenAI',
      'Embed column using OpenAI',
      'Upsert vectors to LanceDB (local) or Pinecone (cloud)',
      'Query similar vectors with semantic search',
      'Delete vectors by ID or filter',
      'Update vector metadata',
      'Support for both local and cloud vector databases'
    ],
    inputFormat: 'Array of objects with text/vector fields',
    outputFormat: 'Array of vector records with metadata and similarity scores',
    executionEnvironment: 'local with external API calls for embeddings',
    providers: {
      embedding: ['OpenAI'],
      vectorDB: ['LanceDB (local)', 'Pinecone (cloud)']
    },
    models: {
      openai: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002']
    }
  }),

  /**
   * Get prompts for AI to understand when/how to use this skill
   */
  getTransformPrompts: (context = {}) => {
    const { operationType, sourceSchema } = context;

    return {
      systemContext: `
        # Vector Database Executor Skill

        Use this skill for vector database operations that require:
        - Embedding text data into vectors
        - Storing vectors in LanceDB (local) or Pinecone (cloud)
        - Semantic search / similarity queries
        - Vector CRUD operations

        **When to use:**
        - User wants to embed text and store in vector database
        - User wants to perform semantic search
        - Target is a vector database (LanceDB or Pinecone)
        - Source is a vector database and the request CHANGES its records (update, tag, delete, re-embed) — only this skill can
        - NOT for reading a vector source into a NEW table (count, summarise, filter, reshape its records): that is the JavaScript Executor
        - User mentions "embeddings", "vectors", "similarity search"

        **Vector DB Types:**
        - LanceDB: Local vector database (default, no setup required)
        - Pinecone: Cloud vector database (requires API key and existing index)

        **Embedding Providers:**
        - OpenAI: text-embedding-3-small (1536 dim), text-embedding-3-large (3072 dim)
      `,

      responseFormat: `
        When using vector-db-executor skill, return JSON:
        {
          "usesSkill": true,
          "skillId": "vector-db-executor",
          "skillParams": {
            "vectorDbType": "lancedb" | "pinecone",
            "operation": "upsert" | "query" | "delete" | "update",
            "embeddingProvider": "openai",
            "embeddingModel": "text-embedding-3-small",
            "columnToEmbed": "column_name",
            "targetTable": "table_name"
          },
          "explanation": "Why this skill is needed"
        }
      `
    };
  },

  /**
   * Build skill-specific prompt for AI interaction
   */
  buildSkillPrompt: async (params) => {
    bindLibs(params.helpers);
    // console.log('params: ', params)
    const {
      userRequest,
      sourceTableSchema,
      sourceConnection,
      operation,
      operationType,
      apiKeys,
      vectorConnectors,
      pluginManager,
      getFullConfig
    } = params;

    // Fetch available connections from the database (using same pattern as electron.js getDb)
    const connectionsDbPath = path.join(app.getPath('userData'), 'ternlux-connections.db');
    const connectionsDb = new Datastore({ filename: connectionsDbPath, autoload: true });

    const availableConnections = await new Promise((resolve, reject) => {
      connectionsDb.find({}, (err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    // console.log('availableConnections: ', availableConnections)
    const columns = sourceTableSchema?.columns || [];
    const columnsList = columns.map(c => `${c.name} (${c.type})`).join(', ');
    // A Pinecone source's columns are its metadata fields plus the record's own
    // id / values / namespace (connector getColumns); only the former are fields.
    const metadataFieldNames = columns.map((c) => c.name)
      .filter((n) => !['id', 'values', 'vector', 'namespace', 'metadata'].includes(n));
    const metadataFieldList = columns.filter((c) => metadataFieldNames.includes(c.name))
      .map((c) => `${c.name} (${c.type})`).join(', ');

    // Check if we have any embedding API keys
    // OpenAI embeddings use the 'chatgpt' key (same as ChatGPT API); some
    // installs store it as 'openai'. Same lookup as the helpers bundle.
    const hasOpenAI = apiKeys && (apiKeys.chatgpt || apiKeys.openai);
    const hasAnyEmbeddingKey = hasOpenAI;

    // If no embedding keys, return error
    if (!hasAnyEmbeddingKey) {
      return {
        prompt: `Error: No embedding API keys configured.

To use vector operations, you need to set up an embedding provider API key:
- OpenAI API key (for OpenAI embeddings)

Please configure an embedding API key in settings before proceeding.`,
        context: { error: true, missingKeys: true }
      };
    }

    // Determine available embedding providers
    const availableProviders = [];
    if (hasOpenAI) {
      availableProviders.push({
        name: 'OpenAI',
        id: 'openai',
        models: [
          'text-embedding-3-small (1536 dim, $0.02/1M tokens)',
          'text-embedding-3-large (3072 dim, $0.13/1M tokens)',
          'text-embedding-ada-002 (1536 dim, $0.10/1M tokens)'
        ]
      });
    }

    // Determine available vector databases and their connections
    const vectorDbConnections = []; // Map dbType -> array of connections

    // Always include LanceDB (local, no plugin needed)
    vectorDbConnections.push({
      name: 'LanceDB',
      id: 'lancedb',
      dbType: 'LanceDB',
      cloud: 'Local'
    });

    // Add installed vector database plugins and find their connections
    if (vectorConnectors && vectorConnectors.length > 0) {
      vectorConnectors.forEach(connector => {

        // Find all connections for this vector database type
        if (availableConnections && availableConnections.length > 0) {
          const connectionsForType = availableConnections.filter(conn =>
            conn.dbType === connector.id || conn.dbCategory === 'Vector'
          );

          if (connectionsForType.length > 0) {
            connectionsForType.map(conn => vectorDbConnections.push({
              id: conn._id || conn.id,
              name: conn.name,
              dbType: conn.dbType
            }));
          }
        }
      });
    }
    // console.log('vectorConnectors; ', vectorConnectors, vectorDbConnections)

    // Check if source is already a vector database
    const isSourceVector = sourceConnection?.dbCategory === 'Vector';
    const sourceVectorDbType = isSourceVector ? sourceConnection?.dbType : null;

    // Fetch sample data from vector source if applicable
    let sampleData = [];
    let sampleDataFormatted = '';
    if (isSourceVector) {

      sampleData = await fetchVectorSampleData({
        sourceConnection,
        sourceTableSchema,
        pluginManager,
        getFullConfig,
        sampleSize: 2
      });
      // console.log('sampleData: ', sampleData)
      if (sampleData.length > 0) {
        sampleDataFormatted = sampleData.map((record, idx) => {
          const recordCopy = { ...record };

          // For Pinecone, show id, metadata, and vector dimension
          if (sourceVectorDbType === 'pinecone') {
            const vectorDim = record.values?.length || record.vector?.length || 0;
            return `Record ${idx + 1}:
  - id: ${record.id}
  - vector: [${vectorDim} dimensions]
  - metadata: ${JSON.stringify(record.metadata || {}, null, 4).split('\n').join('\n    ')}${record.namespace ? `\n  - namespace: ${record.namespace}` : ''}`;
          } else {
            // For LanceDB, show all fields directly
            const vectorDim = record.vector?.length || record.values?.length || 0;
            if (recordCopy.vector) delete recordCopy.vector;
            if (recordCopy.values) delete recordCopy.values;

            return `Record ${idx + 1}:
  - id: ${record.id}
  - vector: [${vectorDim} dimensions]
  - fields: ${JSON.stringify(recordCopy, null, 4).split('\n').join('\n    ')}`;
          }
        }).join('\n\n');
      }
    }

    // If source is vector DB, this is a transformation operation
    // If source is regular data, this is an embedding+insert operation
    const prompt = isSourceVector ? `
You are a ${sourceVectorDbType} expert helping transform vectors in-place.

**Database Type:** ${sourceVectorDbType} (vector database)
**User's request:** "${params.userRequest}"

**Source Vector Database:**
- Type: ${sourceVectorDbType}
- Index/Table: ${sourceTableSchema?.tableName || 'Unknown'}
${sourceVectorDbType === 'pinecone' ? `- Available metadata fields: ${metadataFieldList || 'None'} (in the transform function below they are under record.metadata, e.g. record.metadata.${metadataFieldNames[0] || 'price'})\n` : ''}
${sampleDataFormatted ? `**Sample Data:**\n${sampleDataFormatted}\n` : ''}
How Vector Transformations Work:

1. Search/Filter: Find vectors using either:
   - **Embedding Search** (semantic similarity): Set useEmbeddingSearch=true and provide searchQuery text
   - **Metadata Filter**: Set useEmbeddingSearch=false and provide filter

2. **Transform Each Record**: For each found vector, apply a JavaScript function:
   - Return modified record → **UPDATE** it in database
   - Return null → **DELETE** it from database
   - Return unchanged record → **SKIP** (no operation)

**Search Methods for ${sourceVectorDbType}:**
${sourceVectorDbType === 'pinecone' ? `
- **Embedding Search**: useEmbeddingSearch=true, searchQuery="your text"
  - Finds semantically similar vectors
  - Example: searchQuery="technical documentation"
- **Metadata Filter**: useEmbeddingSearch=false, filter={ "category": "tech" }
  - JSON object for Pinecone metadata filtering
  - Supports operators: { "year": { "$gte": 2020 } }
- **All Records**: useEmbeddingSearch=false, filter={}
` : `
- **Embedding Search**: useEmbeddingSearch=true, searchQuery="your text"
  - Finds semantically similar vectors
  - Example: searchQuery="technical documentation"
- **SQL Filter**: useEmbeddingSearch=false, filter="category = 'tech'"
  - SQL WHERE clause for LanceDB
  - Example: "status = 'active' AND year >= 2020"
- **All Records**: useEmbeddingSearch=false, filter=""
`}

**Transform Function:**
- Signature: \`function transformRecord(record, state) { return { record, state }; }\`
- **Input:**
  - record.id (unique identifier)
  - record.vector (embedding array)
${sourceVectorDbType === 'pinecone' ? `  - record.metadata (all metadata fields as object)
  - record.namespace (Pinecone namespace)` : `  - record fields (all data fields directly on record object, not in metadata)`}
  - state (shared object across ALL records - use to maintain state)
    - State persists between records during the loop
    - make sure that the variable types are consistent within the function and in the state
    - Useful for: counting, grouping, tracking changes across records
- **Output:** Must return object with { record, state }
  - record = modified object → UPDATE in database
  - record = null → DELETE from database
  - record = unchanged → SKIP (no operation)
  - state = updated state object → passed to next record
- **Initial State:**
  - Optionally provide initialState object to set initial values
  - Default: {} (empty object)

**Response Format:**

There are exactly TWO ways this ends — you either execute, or you ask. You are a
builder, not a chat partner: a question about the data, and anything you cannot
do, are both "ask_questions". Answer what they asked inside the question text,
then say what you still need.

**For Clarification** (need more info, user asked something, or you cannot proceed):
IMPORTANT: Ask SIMPLE, user-friendly questions. DO NOT use technical terms like "embedding search", "metadata filter", "useEmbeddingSearch", etc.
Instead, ask about WHAT the user wants to accomplish in plain language.
{
  "action": "ask_questions",
  "questionsNeeded": {
    "criteria": "Which records should be affected? All records or only specific ones?",
    "changes": "What specific changes should be made to each record?"
  }
}

**For Execution** (ready to transform):
{
  "action": "execute",
  "useEmbeddingSearch": true | false,
  "searchQuery": "text to search" | null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{ \\"field\\": \\"value\\" }" | "{}"' : '"SQL WHERE" | ""'},
  "transformFunction": "function transformRecord(record, state) { /* your code */ return { record, state }; }",
  "initialState": {},  // Optional: initial state values
  "targetColumns": [{"name": "field", "type": "TYPE"}],   // every field a transformed record carries afterwards, or "*" when transformRecord adds no new field. Downstream nodes are configured from this
  "explanation": "Brief description of what this does"
}

**Examples:**

Answer a question (still "ask_questions" — the answer goes in the question text):
{
  "action": "ask_questions",
  "questionsNeeded": {
    "data": "This vector database contains ${sourceTableSchema?.sampleData?.length || 0} vectors with metadata fields: ${columnsList}. What would you like done with them?"
  }
}

Ask for clarification (simple user-friendly questions):
{
  "action": "ask_questions",
  "questionsNeeded": {
    "scope": "Should I update all records or only specific ones?",
    "changes": "What field should I update and what should the new value be?"
  }
}

Update with embedding search:
{
  "action": "execute",
  "useEmbeddingSearch": true,
  "searchQuery": "product documentation",
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{}"' : '""'},
  "transformFunction": "function transformRecord(r, state) { ${sourceVectorDbType === 'pinecone' ? 'r.metadata.category = \'docs\'; r.metadata.updated_at = new Date().toISOString();' : 'r.category = \'docs\'; r.updated_at = new Date().toISOString();'} return { record: r, state }; }",
  "initialState": {},
  "explanation": "Find vectors similar to 'product documentation' and categorize them as docs"
}

Delete with metadata filter:
{
  "action": "execute",
  "useEmbeddingSearch": false,
  "searchQuery": null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{ \\"status\\": \\"archived\\" }"' : '"status = \'archived\'"'},
  "transformFunction": "function transformRecord(r, state) { return { record: null, state }; }",
  "initialState": {},
  "explanation": "Delete all archived vectors"
}

Conditional update/delete:
{
  "action": "execute",
  "useEmbeddingSearch": false,
  "searchQuery": null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{}"' : '""'},
  "transformFunction": "function transformRecord(r, state) { ${sourceVectorDbType === 'pinecone' ? 'if (r.metadata.views < 10) return { record: null, state }; r.metadata.popular = true;' : 'if (r.views < 10) return { record: null, state }; r.popular = true;'} return { record: r, state }; }",
  "initialState": {},
  "explanation": "Delete low-view records (<10), mark others as popular"
}

Using state (counting updates):
{
  "action": "execute",
  "useEmbeddingSearch": false,
  "searchQuery": null,
  "filter": ${sourceVectorDbType === 'pinecone' ? '"{}"' : '""'},
  "transformFunction": "function transformRecord(r, state) { state.count = (state.count || 0) + 1; ${sourceVectorDbType === 'pinecone' ? 'r.metadata.batch_number' : 'r.batch_number'} = Math.floor(state.count / 100); return { record: r, state }; }",
  "initialState": { count: 0 },
  "explanation": "Add batch_number to metadata based on processing order"
}

Provide working ${sourceVectorDbType} transformations that answer questions OR execute transformations.
` : `
You are helping embed regular data into a vector database.

**Source Data (Non-Vector):**
- Connection: ${sourceConnection?.name || 'Unknown'}
- Table: ${sourceTableSchema?.tableName || 'Unknown'}
- Columns: ${columnsList || 'None'}
- Total Records: ${sourceTableSchema?.sampleData?.length || 'Unknown'}

**User's Request:** "${params.userRequest || 'Embed and store in vector database'}"

**Important — No source filtering:** This skill does NOT filter the data
imported from the source. ALL records from the source are embedded and
included in the import; there is currently no option to narrow down,
filter, or exclude rows on the way in. If the user asks to import only a
subset of the data, explain that filtering is not supported here and that
they should filter the data upstream (e.g. with a transformer) before it
reaches this step.

**Available Embedding Providers (you have API keys for):**
${availableProviders.map((p, idx) => `
${idx + 1}. **${p.name}** (${p.id})
   Models:
${p.models.map(m => `   - ${m}`).join('\n')}
`).join('\n')}

**Available Vector Connections:**
${vectorDbConnections.map((value) =>  `\n- connectionName: "${value.name}", connectionId: "${value.id}", "dbType: "${value.dbType}"`
)}


**Your Task:**
Determine the configuration for embedding this data based on chat history and users input:
1. Which column contains the text to embed (REQUIRED)
2. Which embedding provider to use (based on available keys above)
3. Which embedding model to use
4. Which vector database to store in (based on available databases above)
5. For cloud vector databases: which connection to use (if multiple available)
6. Target table/index name

**Important Decision Rules:**
- Only use embedding providers that have API keys configured (listed above)
- If only one embedding provider is available, use it by default
- If no vector database plugins are installed, default to LanceDB
- For cloud vector databases (non-LanceDB):
  - If only ONE connection exists for that database type, use it automatically
  - If MULTIPLE connections exist, ask the user which connection to use (by connection name)
  - Return the connection name in "targetConnectionName" field
- If multiple choices exist, ask the user to clarify
- MUST determine which column to embed

**Response Format:**

**Action Type**: Determine what to do. There are exactly TWO, and every request
ends in one of them — you either execute, or you ask. You are a builder, not a
chat partner: a question that needs no embedding/transformation, and anything you
cannot do, are both "ask_questions" — answer what was asked inside the question
text, then say what you still need.
- "ask_questions": Need to ask clarifying questions before proceeding
- "execute": Ready to execute the embedding operation

If you need to ask questions:
{
  "action": "ask_questions",
  "questionsNeeded": {
    "columnToEmbed": "Which column should be embedded? (only if not specified by user)",
    "embeddingProvider": "Which embedding provider? (only if multiple available and user didn't specify)",
    "vectorDbType": "Which vector database? (only if multiple available and user didn't specify)",
    "targetConnectionName": "Which connection should be used? Options: [connection names] (only if cloud vector DB with multiple connections)",
    "targetTable": "What should the target table/index be named? (only if user didn't specify)",
    "indexName": "Which index to use? (only if applicable and user didn't specify)"
  }
}

If ready to execute:
{
  "action": "execute",
  "vectorDbType": "lancedb" | "pinecone" | "other_vector_db",
  "operation": "upsert",
  "embeddingProvider": "${availableProviders.map(p => p.id).join('" | "')}",
  "embeddingModel": "model_name",
  "columnToEmbed": "column_name",
  "targetTable": "vectors_table_name",
  "targetConnectionName": "connection_name",  // REQUIRED for cloud vector DBs, omit for LanceDB
  "indexName": "index_name",  // For databases that use indexes (Pinecone, etc.)
  "namespace": "optional_namespace",  // For databases that use namespaces
  "skipExisting": true,   // default true — see below
  "idColumn": "column_name",  // the column that identifies a row (e.g. product_id); omit if there isn't one
  "targetColumns": [{"name": "field", "type": "TYPE"}],   // every field written alongside the vector (the source columns carried over, plus anything added). Downstream nodes are configured from this; "*" if the source's columns are written through unchanged
  "explanation": "Explanation of what will happen"
}

RE-EMBEDDING EXISTING RECORDS ("skipExisting"):
- Default to true. Records already in the target are left alone and never
  re-embedded, so re-running a workflow costs nothing extra and does not stack
  duplicate copies of the same row into the index.
- Set it to false ONLY when the user asks for something that needs the vectors
  rewritten — changing the embedding model or the embedded column, refreshing
  text that has since been edited, or an explicit "re-embed everything".
- "idColumn" identifies the ROW, not the embedded value — it is normally a
  DIFFERENT column from "columnToEmbed". Use the source's key column when the
  schema has one (product_id, order_id, sku). Two rows can legitimately share
  the same embedded text, and a real key keeps them as separate records.
- Only name a column you can see in the schema and that plausibly identifies a
  row. If nothing qualifies, OMIT idColumn — identity then falls back to a hash
  of the embedded text, which is correct but merges rows with identical text.
- You do not need to reason about how the embedded value was produced. Whether
  it is a plain column or something an upstream node derived, freshness is
  tracked from a fingerprint of the text computed at run time: changed text is
  re-embedded and replaced in place, changed metadata is rewritten WITHOUT
  re-embedding, and untouched rows cost nothing.
- Do not ask the user about either of these. Infer idColumn from the schema and
  leave skipExisting at its default unless the request clearly implies a rewrite.

IMPORTANT:
- For LanceDB: Do NOT include "targetConnectionName", "indexName", or "namespace"
- For cloud vector DBs: MUST include "targetConnectionName" (use the connection name from available connections list)
- If only one connection exists for a cloud vector DB, use that connection's name automatically
- For Pinecone indexName: MUST use lowercase letters, numbers, and hyphens only (no underscores, no uppercase)
  - Good: "my-index-name", "embeddings-2024", "user-vectors"
  - Bad: "My_Index", "root_test_embeddings" (has underscores), "UserVectors" (has uppercase)
`;

    // Close the conditional prompt

    return {
      prompt,
      context: {
        sourceTableSchema,
        sourceConnection,
        operation,
        isSourceVector,
        sourceVectorDbType,
        vectorDbConnections,
        availableConnections
      }
    };
  },

  /**
   * Process AI response for skill execution
   */
  processSkillResponse: (aiResponse, operationType, currentState = {}, availableConnections = []) => {
    try {
      let parsed;
      if (typeof aiResponse === 'string') {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = aiResponse.match(/```json?\n?([\s\S]*?)\n?```/) || aiResponse.match(/{[\s\S]*}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        } else {
          // No JSON envelope came back. That is not an answer to hand the
          // user as though the node were built — ask, carrying whatever the
          // model did say so the question is not empty.
          return {
            action: 'ask_questions',
            questionsNeeded: { request: aiResponse }
          };
        }
      } else {
        parsed = aiResponse;
      }
      console.log('parsed: ', parsed)
      // Check if this is a vector source transformation
      const isSourceVector = currentState.isSourceVector === true;

      // Validate required fields
      if (parsed.action === 'execute') {
        if (isSourceVector) {
          // For vector source transformations
          if (!parsed.transformFunction) {
            return {
              action: 'ask_questions',
              message: 'I need to know how to transform the data',
              questionsNeeded: { transformLogic: 'What changes should I make to each record?' }
            };
          }

          // Validate search method
          if (parsed.useEmbeddingSearch && !parsed.searchQuery) {
            return {
              action: 'ask_questions',
              message: 'I need to know which records to find',
              questionsNeeded: { searchCriteria: 'What should I search for to find the relevant records?' }
            };
          }

          // Warn if no filter and no embedding search
          if (!parsed.useEmbeddingSearch && (!parsed.filter || parsed.filter === '' || parsed.filter === '{}')) {
            console.warn('No filter or search query - transformation will affect ALL vectors');
          }

        } else {
          // For regular embedding operations
          const required = ['vectorDbType', 'operation'];
          for (const field of required) {
            if (!parsed[field]) {
              return {
                action: 'ask_questions',
                message: `Missing required field: ${field}`,
                questionsNeeded: { [field]: true }
              };
            }
          }

          // For upsert/query operations, embeddings are usually needed
          if (['upsert', 'query'].includes(parsed.operation)) {
            if (!parsed.embeddingProvider || !parsed.columnToEmbed) {
              return {
                action: 'ask_questions',
                message: 'Missing embedding configuration',
                questionsNeeded: {
                  embeddingProvider: !parsed.embeddingProvider,
                  columnToEmbed: !parsed.columnToEmbed
                }
              };
            }
          }
        }

        // Map targetConnectionName to targetConnectionId for cloud vector databases
        if (parsed.vectorDbType && parsed.vectorDbType !== 'lancedb') {
          const connectionsForType = availableConnections.filter(conn =>
            conn.dbType === parsed.vectorDbType || conn.dbCategory === 'Vector'
          );

          // If targetConnectionName provided, map it to ID
          if (parsed.targetConnectionName) {
            const connection = connectionsForType.find(conn =>
              conn.name === parsed.targetConnectionName
            );
            // console.log('connectionsForType: ', availableConnections, connectionsForType, connection, parsed.targetConnectionName)
            if (connection) {
              parsed.targetConnectionId = connection.id;
              console.log(`Mapped connection "${parsed.targetConnectionName}" to ID: ${connection.id}`);
            } else {
              return {
                action: 'ask_questions',
                message: `Connection "${parsed.targetConnectionName}" not found for ${parsed.vectorDbType}`,
                questionsNeeded: {
                  targetConnectionName: `Which connection should be used? Available: ${
                    connectionsForType.map(c => c.name).join(', ')
                  }`
                }
              };
            }
          }
          // If no connection name provided, check if we can auto-select
          else if (connectionsForType.length === 1) {
            // Only one connection exists, use it automatically
            parsed.targetConnectionId = connectionsForType[0].id;
            parsed.targetConnectionName = connectionsForType[0].name;
            console.log(`Auto-selected connection "${parsed.targetConnectionName}" (ID: ${parsed.targetConnectionId})`);
          }
          else if (connectionsForType.length > 1) {
            // Multiple connections, need to ask user
            return {
              action: 'ask_questions',
              message: `Multiple ${parsed.vectorDbType} connections available. Which one should be used?`,
              questionsNeeded: {
                targetConnectionName: `Which connection should be used? Available: ${
                  connectionsForType.map(c => c.name).join(', ')
                }`
              }
            };
          }
          else {
            // No connections found
            return {
              action: 'ask_questions',
              message: `No ${parsed.vectorDbType} connections found. Please create a connection first.`,
              questionsNeeded: {}
            };
          }
        }

        // Declare what this node will really write. Only for an upsert that
        // embeds: a vector-source transformation (in-place maintenance, a
        // search) writes through its own function and adds nothing.
        if (!isSourceVector && parsed.operation === 'upsert') {
          parsed.targetColumns = withWrittenVectorColumns(parsed.targetColumns, parsed.vectorDbType);
        }

        return {
          action: 'execute',
          skillParams: parsed,
          readyToExecute: true,
          // Include these at top level for UI display
          transformFunction: parsed.transformFunction,
          initialState: parsed.initialState,
          explanation: parsed.explanation,
          useEmbeddingSearch: parsed.useEmbeddingSearch,
          searchQuery: parsed.searchQuery,
          filter: parsed.filter
        };
      }

      return parsed;
    } catch (error) {
      console.error('Failed to process skill response:', error);
      return {
        action: 'ask_questions',
        questionsNeeded: { request: `I need more information to proceed. ${error.message}` }
      };
    }
  },

  /**
   * Main execution function
   * Similar to python-executor's execute method
   */
  execute: async (params) => {
    bindLibs(params.helpers);
    const startTime = Date.now();

    try {
      const {
        sourceConnection,
        sourceTableSchema,
        vectorDbType,
        operation,
        embeddingProvider,
        embeddingModel,
        embeddingApiKey,
        columnToEmbed,
        // Default ON: check the target first and embed only what isn't there.
        // Embedding is the expensive step, so this both saves cost and stops
        // re-runs from piling duplicate vectors into the index.
        skipExisting = true,
        idColumn = null,
        targetTable,
        targetConnectionId,
        pineconeConfig,
        lancedbConfig,
        queryText,
        queryVector,
        topK = 10,
        filter,
        transformFunction,
        initialState,
        useEmbeddingSearch,
        searchQuery,
        operationType,
        nodeId,
        sourceNodeId,
        pluginManager,
        getFullConfig,
        appSqliteDbPath,
        targetLocalPath, // Path for local LanceDB storage
        storageLocation,
        operationMode
      } = params;
      // Check if this is a vector source transformation (UPDATE/DELETE with JavaScript).
      //
      // By dbType as well as dbCategory: a Transformer's saved config does not
      // carry the source's category, so a LanceDB / Pinecone source arrived
      // looking like any other connection, fell through to the embed path with
      // no operation, and failed "Unsupported LanceDB operation: undefined".
      // Only a node with a transform function maintains records — one that
      // embeds FROM a vector store (no function) still takes the embed path.
      const sourceIsVectorStore = sourceConnection?.dbCategory === 'Vector'
        || sourceConnection?.sourceDbCategory === 'Vector'
        || ['lancedb', 'pinecone'].includes(String(sourceConnection?.dbType || '').toLowerCase());
      const isSourceVector = sourceIsVectorStore && !!transformFunction;

      if (isSourceVector) {
        console.log(`\n=== Vector Source Transformation ===`);
        console.log(`Source Vector DB: ${sourceConnection.dbType}`);
        console.log(`Search method: ${useEmbeddingSearch ? 'Embedding search' : 'Filter'}`);

        // Handle JavaScript transformations for vector sources
        return await executeVectorSourceTransformation({
          sourceConnection,
          sourceTableSchema,
          transformFunction,
          initialState,
          useEmbeddingSearch,
          searchQuery,
          filter,
          embeddingProvider,
          embeddingModel,
          embeddingApiKey,
          pluginManager,
          getFullConfig,
          appSqliteDbPath,
          nodeId,
          sourceNodeId,
          startTime,
          targetLocalPath, // Pass targetLocalPath for potential local storage
          storageLocation,
          operationMode,
          helpers: params.helpers
        });
      }

      console.log(`\n=== Vector DB Executor: ${operation} operation ===`);
      console.log(`Vector DB: ${vectorDbType}`);
      console.log(`Embedding Provider: ${embeddingProvider} (${embeddingModel})`);

      let sourceData = [];
      let embeddedData = [];
      // Outcome of the skipExisting pass, reported on the final result.
      let skippedExisting = 0;
      let refreshedStale = 0;
      let metadataUpdated = 0;
      let result;

      // Step 1: Load source data (for upsert/update operations)
      if (['upsert', 'update'].includes(operation)) {
        console.log('Loading source data...');
        sourceData = await loadSourceData({
          sourceConnection,
          sourceTableSchema,
          operationType,
          pluginManager,
          getFullConfig,
          appSqliteDbPath
        });

        console.log(`Loaded ${sourceData.length} records from source`);

        if (sourceData.length === 0) {
          return {
            success: false,
            message: 'No data found in source table'
          };
        }

        // Step 2: ids, fingerprints and the skip rule — the shared
        // prepareRowsForWrite, the same function the Output and the Join use.
        // Done BEFORE embedding: skipping after the embed call would avoid the
        // duplicate but still pay for the tokens. `skipExisting: false` (a
        // model change, "re-embed everything") skips the lookup, so every row
        // is embedded.
        const writeTarget = {
          vectorDbType,
          targetTable: targetTable || sanitizeTableName(sourceTableSchema?.tableName || 'vectors'),
          indexName: params.indexName || targetTable || sourceTableSchema?.tableName,
          namespace: params.namespace || '',
          targetLocalPath,
          targetConnectionId,
          pluginManager,
          getFullConfig
        };
        const plan = await prepareRowsForWrite(sourceData, {
          idColumn,
          columnToEmbed,
          mode: 'upsert',
          target: skipExisting && operation === 'upsert' ? writeTarget : null,
        });
        skippedExisting = plan.skipped;
        metadataUpdated = plan.metadataUpdated;
        refreshedStale = plan.changedText;
        // The write below addresses each record by `id`.
        sourceData = plan.toEmbed.map(({ __vid, ...row }) => ({ ...row, id: __vid }));

        if (sourceData.length === 0) {
          return {
            success: true,
            message: metadataUpdated > 0
              ? `No re-embedding needed; refreshed metadata on ${metadataUpdated} record(s).`
              : `All ${skippedExisting} record(s) are already in the database and unchanged — nothing to embed.`,
            recordCount: 0,
            skippedExisting,
            metadataUpdated,
            executionTime: Date.now() - startTime
          };
        }

        // Step 2b: Generate embeddings
        console.log(`Generating embeddings for column: ${columnToEmbed}...`);

        // Estimate cost for OpenAI
        if (embeddingProvider === 'openai') {
          const texts = sourceData.map(row => row[columnToEmbed]).filter(t => t);
          const { tokens, estimatedCost } = estimateOpenAICost(texts, embeddingModel);
          console.log(`Estimated cost: $${estimatedCost.toFixed(4)} (${tokens.toLocaleString()} tokens)`);

          if (estimatedCost > 1.0) {
            console.warn(`⚠️  High embedding cost: $${estimatedCost.toFixed(2)}`);
          }
        }

        embeddedData = await generateEmbeddings({
          data: sourceData,
          columnToEmbed,
          provider: embeddingProvider,
          model: embeddingModel,
          apiKey: embeddingApiKey
        });

        console.log(`Generated ${embeddedData.length} embeddings`);

        // Duplicate filtering now happens before embedding (Step 2 above), so
        // skipped rows never cost embedding tokens.
      }

      // Step 3: Execute vector operation
      if (vectorDbType === 'lancedb') {
        // Build LanceDB config with targetLocalPath if provided
        const lancedbConfigToUse = {
          ...(lancedbConfig || {}),
          // Use targetLocalPath if provided (for transformer nodes with local storage)
          ...(targetLocalPath ? { dbPath: targetLocalPath } : {})
        };

        result = await executeLanceDB({
          operation,
          data: embeddedData,
          queryText,
          queryVector,
          topK,
          filter,
          targetTable: targetTable || sanitizeTableName(sourceTableSchema?.tableName || 'vectors'),
          lancedbConfig: lancedbConfigToUse,
          embeddingProvider,
          embeddingModel,
          embeddingApiKey,
          columnToEmbed,
          // An embed is an UPSERT: records are merged by id, so a re-run
          // replaces what it re-embeds and keeps the rest. (It used to
          // overwrite on new_table — after the unchanged rows had already been
          // skipped, which would have rewritten the table with ONLY the
          // changed ones.)
          overwrite: false
        });
      } else {
        // For cloud vector databases (Pinecone, etc.), use connector's executeVectorOperation
        if (!targetConnectionId) {
          throw new Error(`${vectorDbType} requires a target connection ID`);
        }

        const fullConfig = await getFullConfig(targetConnectionId);
        // console.log('fullConfig: ', fullConfig);

        if (!fullConfig || !fullConfig.apiKey) {
          throw new Error(`Unable to load credentials for connection: ${targetConnectionId}`);
        }

        const connector = pluginManager.getConnector(vectorDbType);
        if (!connector) {
          throw new Error(`${vectorDbType} connector not found`);
        }

        if (typeof connector.executeVectorOperation !== 'function') {
          throw new Error(`${vectorDbType} connector does not support executeVectorOperation`);
        }

        // Prepare data for vector operation
        const vectorData = embeddedData.map(record => ({
          // Already set by resolveRecordId in step 2; the same rule as a fallback.
          id: record.id || resolveRecordId(record, { idColumn, columnToEmbed }),
          vector: record.vector,
          metadata: (() => {
            const meta = { ...record };
            delete meta.vector;
            delete meta._embedded_column;
            delete meta._embedding_provider;
            delete meta._embedding_model;
            delete meta._embedded_at;
            return meta;
          })()
        }));

        result = await connector.executeVectorOperation(
          fullConfig,
          targetConnectionId,
          {
            operation,
            indexName: params.indexName || targetTable || sourceTableSchema?.tableName,
            namespace: params.namespace || '',
            data: vectorData,
            queryVector,
            topK,
            filter
          }
        );
      }

      // Bail out before saving if the operation itself failed — otherwise we'd
      // wrap a failed result in a success envelope.
      if (!result || result.success === false) {
        return {
          success: false,
          message: result?.message || `${vectorDbType} ${operation} operation failed`,
          error: result?.error,
          data: result?.data || [],
          recordCount: result?.recordCount || 0,
          executionTime: Date.now() - startTime
        };
      }

      // Step 4: Save results to local storage
      const savedConfig = await saveVectorResults({
        result,
        operation,
        vectorDbType,
        targetTable: targetTable || sourceTableSchema?.tableName || 'vectors',
        nodeId,
        sourceNodeId,
        sourceConnection,
        sourceTableSchema,
        appSqliteDbPath,
        targetConnectionId,
        namespace: params.namespace || '',
        indexName: params.indexName || targetTable || sourceTableSchema?.tableName,
        targetLocalPath,
        targetConnectionName: sourceConnection?.name,
        embeddingProvider,
        embeddingModel,
        columnToEmbed,
        embeddedData
      });

      const executionTime = Date.now() - startTime;

      console.log(`=== Vector operation completed in ${executionTime}ms ===\n`);

      return {
        success: true,
        data: result.data || [],
        recordCount: result.recordCount || 0,
        skippedExisting,
        refreshedStale,
        metadataUpdated,
        config: savedConfig,
        message: result.message,
        executionTime
      };

    } catch (error) {
      // A stop leaves as an exception — see the note on executeDataToVector's
      // catch. This is the path that embeds, so it is the one most likely to be
      // stopped part-way.
      if (isCancelledError(error)) throw error;
      console.error('Vector DB execution failed:', error);

      return {
        success: false,
        message: `Vector database operation failed: ${error.message}`,
        error: error.stack,
        executionTime: Date.now() - startTime
      };
    }
  },

  /**
   * Query vector database for preview (first 10 records)
   * Called from DataPreview component
   */
  queryVectorPreview: async (params) => {
    bindLibs(params.helpers);
    try {
      const {
        vectorDbType,
        tableName,
        namespace = '',
        dbConfig,
        connectionId,
        pluginManager,
        getFullConfig,
        targetLocalPath,
        // Records to read. The panel preview shows 10; a schema read asks for
        // more so a field only some records carry is still found.
        limit: previewLimit = 10,
        // Pinecone addresses an INDEX, not a table. A node writing to Pinecone
        // records both `indexName` and a `targetTableName`, and they are not the
        // same string — so substituting the table name here asked for an index
        // that was never created under that name.
        indexName: paramIndexName = null
      } = params;
      // LanceDB genuinely has tables, so `tableName` remains right for it. For
      // Pinecone the index name wins, falling back to the table name only when
      // nothing better was recorded (older nodes).
      const pineconeIndex = paramIndexName || dbConfig?.indexName || tableName;

      // console.log(`Querying ${vectorDbType} for preview: ${tableName}`);
      // console.log('queryVectorPreview: ', params)
      if (vectorDbType === 'lancedb') {
        // Use targetLocalPath first, then dbConfig.dbPath, then default
        const dbPath = targetLocalPath || dbConfig?.dbPath || path.join(
          require('electron').app.getPath('userData'),
          'data',
          'lancedb'
        );

        const db = await getLanceDBConnection({ dbPath });
        const table = await db.openTable(tableName);

        // Get table info
        const count = await table.countRows();
        console.log('dbPath: ', dbPath, tableName, table, count)

        // Fetch first 10 vectors using query (not search which requires a vector)
        const iterator = await table.query().limit(10).toArray();

        // Format for display - compact vector representation
        const formattedResults = iterator.map(row => ({
          ...row,
          vector: `[${row.vector?.length || 0} dims]`
        }));

        return {
          success: true,
          data: formattedResults,
          recordCount: formattedResults.length,
          totalRows: count,
          isJson: true,
          storageType: 'LanceDB'
        };

      } else if (vectorDbType === 'pinecone') {
        // For Pinecone, use the connector to fetch first 10 vectors
        if (!pluginManager || !getFullConfig) {
          return {
            success: false,
            message: 'Pinecone preview requires pluginManager and getFullConfig'
          };
        }

        const connector = pluginManager.getConnector('pinecone');
        if (!connector) {
          return {
            success: false,
            message: 'Pinecone connector not found'
          };
        }

        const fullConfig = await getFullConfig(connectionId);

        if (!fullConfig || !fullConfig.apiKey) {
          return {
            success: false,
            message: 'Unable to load Pinecone credentials'
          };
        }

        const result = await connector.fetchAllVectors(
          fullConfig,  // fullConfig is now { apiKey: 'key' } directly
          connectionId,
          {
            indexName: pineconeIndex,
            namespace: namespace || dbConfig?.namespace || '',
            filter: {},
            includeValues: true,
            includeMetadata: true,
            limit: previewLimit
          }
        );

        if (!result.success) {
          return {
            success: false,
            message: `Failed to fetch Pinecone vectors: ${result.message}`
          };
        }

        // Format for display - compact vector representation
        const formattedResults = (result.rows || []).map(row => ({
          ...row,
          values: `[${row.values?.length || 0} dims]`
        }));

        return {
          success: true,
          data: formattedResults,
          recordCount: formattedResults.length,
          isJson: true,
          storageType: 'Pinecone',
          // Carried through so the renderer can show which index/namespace was
          // actually read and what the index reports holding.
          queriedIndex: pineconeIndex,
          queriedNamespace: namespace || dbConfig?.namespace || '',
          indexStats: result.indexStats
        };
      }

      return {
        success: false,
        message: `Unknown vector database type: ${vectorDbType}`
      };

    } catch (error) {
      console.error('Vector preview failed:', error);
      return {
        success: false,
        message: `Preview failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Execute data-to-vector transfer
   * Takes data from any source and inserts into vector database
   * Used by Output nodes to transfer data to vector databases
   */
  executeDataToVector: async (params) => {
    bindLibs(params.helpers);
    const {
      sourceData: inputData,
      targetConnection,
      targetIndexName,
      targetNamespace = '',
      idColumn = null,
      // The column the node embeds also keys the record ids, so a re-run
      // upserts onto the same vectors instead of adding new ones.
      columnToEmbed = params.embedding?.columnToEmbed || null,
      // 'truncate' clears the target before writing; 'append' upserts into
      // whatever is already there (the default). Vectors are keyed by a
      // content-derived id, so an append against changed data leaves the old
      // vectors alongside the new ones and every search keeps returning rows
      // that no longer exist upstream — which is what truncate is for.
      writeMode = 'append',
      pluginManager,
      getFullConfig
    } = params;

    let sourceData = inputData;
    try {
      const dbType = targetConnection.dbType;
      const startTime = Date.now();

      console.log(`[Vector Output] Starting data-to-vector transfer to ${dbType}`);
      console.log(`[Vector Output] Source data: ${sourceData.length} rows`);

      // Check if we have data to insert
      if (!sourceData || sourceData.length === 0) {
        return {
          success: false,
          message: 'No data to insert'
        };
      }

      const idMode = writeMode === 'truncate' ? 'truncate' : 'upsert';
      const lanceDir = dbType === 'lancedb' ? lanceDbPathOf(targetConnection) : null;

      // Plain rows are embedded here when the node names a column to embed —
      // after the same check the Transformer makes: unchanged rows are skipped,
      // rows whose other columns changed are rewritten without re-embedding,
      // and only new or changed text is embedded. Rows that already carry
      // vectors (an embedding step upstream, another vector store) are written
      // as they are.
      let skippedExisting = 0;
      let metadataUpdated = 0;
      const needsEmbedding = !!columnToEmbed
        && !sourceData.some((row) => row && (row.vector || row.values || row.embedding));
      if (needsEmbedding) {
        const plan = await prepareRowsForWrite(sourceData, {
          idColumn,
          columnToEmbed,
          mode: idMode,
          target: {
            vectorDbType: dbType,
            targetTable: targetIndexName,
            indexName: targetIndexName,
            namespace: targetNamespace,
            targetLocalPath: lanceDir,
            targetConnectionId: targetConnection.id,
            pluginManager,
            getFullConfig,
          },
        });
        skippedExisting = plan.skipped;
        metadataUpdated = plan.metadataUpdated;
        if (plan.toEmbed.length === 0) {
          return {
            success: true,
            message: metadataUpdated > 0
              ? `No re-embedding needed; refreshed metadata on ${metadataUpdated} record(s).`
              : `All ${skippedExisting} record(s) are already stored and unchanged — nothing to embed.`,
            vectorsInserted: 0,
            skippedExisting,
            metadataUpdated,
            executionTime: Date.now() - startTime,
          };
        }
        ({ rows: sourceData } = await embedRowsForOutput(plan.toEmbed, params.embedding || {}, params.helpers));
      }

      const hasVectors = sourceData.some(row =>
        row.vector || row.values || row.embedding
      );

      if (!hasVectors) {
        return {
          success: false,
          message: 'The data has no vectors to write. Pick a column to embed in this Output node, or connect it to a step that produces embeddings.'
        };
      }

      // Prepare vector records. Ids follow the one rule every vector write
      // uses (resolveRecordId): the ID column the user picked on the node,
      // else a content hash suited to the write mode.
      const vectorRecords = sourceData.map((row, idx) => {
        const vector = row.vector || row.values || row.embedding;
        const id = row.__vid || resolveRecordId(row, { idColumn, columnToEmbed, mode: idMode });

        if (dbType === 'pinecone') {
          // Pinecone: metadata structure
          // Check if source already has metadata field (from another vector DB)
          let metadata;
          if (row.metadata && typeof row.metadata === 'object') {
            // Source is already a vector DB with metadata - use it directly
            metadata = { ...row.metadata };
          } else {
            // Source is regular data - create metadata from all fields
            metadata = { ...row };
            delete metadata.vector;
            delete metadata.values;
            delete metadata.embedding;
            delete metadata.id;
            delete metadata._id;
            delete metadata.__vid;
            delete metadata.namespace;
            delete metadata.metadata; // In case it exists but is not an object
          }

          return {
            id,
            values: toVectorArray(vector),
            metadata,
            namespace: targetNamespace
          };
        } else {
          // LanceDB: flat structure
          const record = { ...row, id };
          record.vector = toVectorArray(vector);
          delete record.values;
          delete record.embedding;
          delete record._id;
          delete record.__vid;

          // Flatten metadata object if it exists (from Pinecone source)
          if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
            const metadataFields = { ...record.metadata };
            delete record.metadata;
            Object.assign(record, metadataFields);
          }

          // Replace null values with empty strings to avoid Arrow IPC dictionary issues
          Object.keys(record).forEach(key => {
            if (record[key] === null || record[key] === undefined) {
              record[key] = '';
            }
          });

          return record;
        }
      });

      console.log(`[Vector Output] Prepared ${vectorRecords.length} vector records`);

      // Insert vectors based on database type
      if (dbType === 'lancedb') {
        // LanceDB: Use embedded library. A saved LanceDB connection keeps its
        // folder in fileInfo.filePath (lanceDbPathOf).
        const dbPath = lanceDir;
        if (!dbPath) {
          return {
            success: false,
            message: 'LanceDB path not found in connection config'
          };
        }

        // executeLanceDBOperation reads BOTH of these off `config` — passing
        // them at the top level left it connecting to an undefined path.
        const result = await executeLanceDBOperation({
          operation: 'upsert',
          data: vectorRecords,
          config: {
            dbPath,
            tableName: targetIndexName,
            // The library's own truncate: it drops the table before writing,
            // which also lets the new batch define the schema.
            overwrite: writeMode === 'truncate',
          },
        });

        if (result.success) {
          return {
            success: true,
            message: `Successfully ${writeMode === 'truncate' ? 'loaded' : 'upserted'} ${vectorRecords.length} vectors into LanceDB table '${targetIndexName}'`
              + (skippedExisting || metadataUpdated ? ` (${skippedExisting} unchanged skipped, ${metadataUpdated} metadata-only updated)` : ''),
            vectorsInserted: vectorRecords.length,
            skippedExisting,
            metadataUpdated,
            executionTime: Date.now() - startTime
          };
        } else {
          return {
            success: false,
            message: `Failed to insert vectors into LanceDB: ${result.message}`
          };
        }

      } else {
        // All other vector DBs: use connector plugin with executeVectorOperation
        const fullConfig = await getFullConfig(targetConnection.id);
        const connector = pluginManager.getConnector(targetConnection.dbType);

        if (!connector) {
          return {
            success: false,
            message: `Connector not found for ${dbType}`
          };
        }

        if (!connector.executeVectorOperation) {
          return {
            success: false,
            message: `${dbType} connector does not support executeVectorOperation`
          };
        }

        // Truncate: empty the namespace being written to, keeping the index
        // itself (and every other namespace in it) untouched. Shared with a
        // join in replace mode (joinHandler.clearVectorNamespace).
        if (writeMode === 'truncate') {
          const cleared = await joinHandler.clearVectorNamespace({
            connector, fullConfig, connectionId: targetConnection.id,
            indexName: targetIndexName, namespace: targetNamespace,
          });
          if (!cleared.ok) {
            return { success: false, message: `Failed to truncate ${targetIndexName}: ${cleared.message}` };
          }
          console.log(`[Vector Output] ${cleared.message || `Cleared ${targetIndexName}${targetNamespace ? '/' + targetNamespace : ''}`}`);
        }

        // Use executeVectorOperation which handles index creation and upsert
        const result = await connector.executeVectorOperation(
          fullConfig,
          fullConfig.id,
          {
            operation: 'upsert',
            indexName: targetIndexName,
            namespace: targetNamespace,
            data: vectorRecords
          }
        );

        if (result.success) {
          return {
            success: true,
            message: `Successfully ${writeMode === 'truncate' ? 'loaded' : 'upserted'} ${vectorRecords.length} vectors into ${dbType} index '${targetIndexName}'${targetNamespace ? `/${targetNamespace}` : ''}`
              + (skippedExisting || metadataUpdated ? ` (${skippedExisting} unchanged skipped, ${metadataUpdated} metadata-only updated)` : ''),
            vectorsInserted: vectorRecords.length,
            skippedExisting,
            metadataUpdated,
            executionTime: Date.now() - startTime
          };
        } else {
          return {
            success: false,
            message: `Failed to insert vectors: ${result.message}`
          };
        }
      }

    } catch (error) {
      // A stop must leave this skill as an exception. Flattened to
      // { success: false } it reaches the runner indistinguishable from a
      // broken write, and the run is recorded as FAILED — see
      // public/NodeExecution/executionCancel.js.
      if (isCancelledError(error)) throw error;
      console.error('[Vector Output] Error:', error);
      return {
        success: false,
        message: `Vector insertion failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Export data to LanceDB as a local file
   * Used by Output nodes when exporting to local LanceDB
   */
  exportToLanceDB: async (params) => {
    bindLibs(params.helpers);
    const { savePath, tableName: requestedTable } = params;
    // A LanceDB file is written like a LanceDB connection: 'append' upserts
    // (unchanged rows skipped, metadata-only changes rewritten without
    // re-embedding, only new or changed text embedded), 'truncate' replaces the
    // table. Callers that pass nothing get the old behaviour, a replace.
    const writeMode = params.writeMode === 'append' ? 'append' : 'truncate';

    try {
      console.log(`[LanceDB Export] Starting export to ${savePath} (${writeMode})`);
      console.log(`[LanceDB Export] Source data: ${(params.sourceData || []).length} rows`);

      const path = require('path');

      // The export writes a LanceDB DATABASE exactly at savePath — the folder
      // the user typed or picked — holding one `<table>.lance` dataset.
      //
      // It used to strip a trailing `.lance` and write the database beside the
      // chosen path ("e2e_vectors.lance" → "e2e_vectors/"), so the data landed
      // somewhere the user never named, an empty folder was left at the path
      // they did name, and a connection pointed at that path listed no tables.
      // A folder called `x.lance` is a perfectly good database directory: the
      // dataset check (isLanceDatasetDir) looks for `_versions` /
      // `_latest.manifest` inside, not at the name.
      //
      // The one exception: savePath is an EXISTING dataset (a single table's
      // folder). Writing a database inside it would nest tables in a table, so
      // that table itself is written — its parent is the database.
      const sanitizeTable = (name) => String(name || '').trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/^_+|_+$/g, '');
      let dbPath = savePath;
      // The caller names the table when it has one to name — a LanceDB database
      // holds many. Falling back to the folder's own name (minus `.lance` /
      // `.lancedb`) covers nodes saved before the name was passed through.
      let tableName = sanitizeTable(requestedTable)
        || sanitizeTable(path.basename(savePath).replace(/\.(lance|lancedb)$/i, ''))
        || 'data';
      if (params.helpers?.lancedb?.isLanceDatasetDir?.(savePath)) {
        dbPath = path.dirname(savePath);
        tableName = path.basename(savePath).replace(/\.lance$/i, '');
        console.warn(`[LanceDB Export] ${savePath} is an existing table; writing table "${tableName}" in ${dbPath}`);
      }
      const fs = require('fs');
      if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
      }

      // The write itself is the LanceDB-connection write: same id rule
      // (resolveRecordId), same skip rule, same atomic upsert / overwrite.
      const result = await module.exports.executeDataToVector({
        ...params,
        targetConnection: { dbType: 'lancedb', localPath: dbPath },
        targetIndexName: tableName,
        targetNamespace: '',
        writeMode,
        idColumn: params.idColumn || null,
      });

      if (!result.success) {
        return { ...result, message: `Failed to export LanceDB: ${result.message}` };
      }
      return {
        ...result,
        message: `${result.message} (${dbPath})`,
        // The DATABASE directory, which is what a LanceDB connection has to
        // point at. Returning the `${tableName}.lance` dataset inside it is
        // what produced connections that listed no tables.
        filePath: dbPath,
        tableName,
        recordCount: result.vectorsInserted,
      };
    } catch (error) {
      if (isCancelledError(error)) throw error;
      console.error('[LanceDB Export] Error:', error);
      return {
        success: false,
        message: `Failed to export LanceDB: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * List all tables in a LanceDB database
   */
  listLanceDBTables: async (params) => {
    bindLibs(params.helpers);
    const { dbPath } = params;

    try {
      if (!dbPath || !fs.existsSync(dbPath)) {
        return {
          success: false,
          message: 'LanceDB directory not found',
          tables: []
        };
      }

      // Use the listTables function from lancedb.js
      // Pass dbPath as config object
      console.log('dbPath: ', dbPath)
      const tables = await listLanceTables({ dbPath });
      console.log('tables: ', tables)
      return {
        success: true,
        tables: tables,
        message: `Found ${tables.length} table(s)`
      };
    } catch (error) {
      console.error('[LanceDB List Tables] Error:', error);
      return {
        success: false,
        message: `Failed to list LanceDB tables: ${error.message}`,
        tables: [],
        error: error.stack
      };
    }
  },

  // ─── Join hooks ──────────────────────────────────────────────────────────
  // Called by the standard join executor (handleExecuteJoin) when a source
  // is a vector DB, or when the destination is a vector DB. The skill is not
  // the orchestrator — these are narrow, side-effect-only hooks.

  isVectorConnection: joinHandler.isVectorConn,

  fetchVectorSourceRecords: async (params) => {
    bindLibs(params.helpers);
    return await joinHandler.fetchVectorSourceRecords(params);
  },

  embedAndUpsertJoinedRows: async (params) => {
    bindLibs(params.helpers);
    // The join writes under the same id rule as every other vector write.
    return await joinHandler.embedAndUpsertJoinedRows({ ...params, prepareRowsForWrite });
  },

  metadata: {
    displayName: 'Vector Database Executor',
    description: 'Generate embeddings and run vector operations on LanceDB or Pinecone — embed columns, upsert vectors, and run semantic search via OpenAI.',
    version: '1.0.0',
    author: 'Ternlux'
  }
};

/**
 * An Output node writing plain rows to a vector store names the column to
 * embed; embed it here so the rows arrive carrying `vector` like any other
 * vector data. Rows that already carry a vector are returned untouched — an
 * Output fed from an embedding step must not pay for a second embedding.
 * Returns { rows, embedded } where `embedded` is how many rows were embedded.
 */
async function embedRowsForOutput(rows,{ columnToEmbed, embeddingProvider = 'openai', embeddingModel = 'text-embedding-3-small', embeddingApiKey = null } = {}, helpers = null) {
  const hasVectors = rows.some((row) => row && (row.vector || row.values || row.embedding));
  if (hasVectors || !columnToEmbed) return { rows, embedded: 0 };
  if (!rows.some((row) => row && Object.prototype.hasOwnProperty.call(row, columnToEmbed))) {
    throw new Error(`Column "${columnToEmbed}" to embed is not in the data. Available columns: ${Object.keys(rows[0] || {}).join(', ')}.`);
  }
  const apiKey = embeddingApiKey
    || (embeddingProvider === 'openai' ? (helpers?.apiKeys?.chatgpt || helpers?.apiKeys?.openai) : null);
  if (!apiKey) {
    throw new Error(`No API key configured for embedding provider "${embeddingProvider}". Add one in Settings → AI Provider.`);
  }
  console.log(`[Vector Output] Embedding "${columnToEmbed}" for ${rows.length} rows with ${embeddingProvider} ${embeddingModel}`);
  const embedded = await generateEmbeddings({
    data: rows,
    columnToEmbed,
    provider: embeddingProvider,
    model: embeddingModel,
    apiKey,
  });
  return { rows: embedded, embedded: embedded.length };
}

/**
 * The directory of a LanceDB source. A saved LanceDB FILE connection keeps it in
 * `fileInfo.filePath`, which the lookups below used to skip — the sample read
 * came back empty and an in-place update threw "LanceDB path not found".
 * `fallbacks` are tried last, in order.
 */
function lanceDbPathOf(sourceConnection = {}, ...fallbacks) {
  return sourceConnection.localPath
    || sourceConnection.sourceLocalPath
    || sourceConnection.dbConfig?.dbPath
    || sourceConnection.fileInfo?.filePath
    || fallbacks.find(Boolean)
    || null;
}

/**
 * Fetch sample data from vector source for prompt context
 */
async function fetchVectorSampleData({
  sourceConnection,
  sourceTableSchema,
  pluginManager,
  getFullConfig,
  sampleSize = 2
}) {
  try {
    const dbType = sourceConnection.dbType;
    const tableName = sourceTableSchema.tableName;
    // For Pinecone the source's table IS the index.
    const indexName = sourceTableSchema.indexName || sourceConnection.indexName || tableName;
    const namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

    let sampleRecords = [];

    if (dbType === 'lancedb') {
      // LanceDB: embedded library
      const dbPath = lanceDbPathOf(sourceConnection, sourceTableSchema.localPath);
      if (!dbPath) {
        return [];
      }

      const db = await getLanceDBConnection({ dbPath });
      try {
        const table = await db.openTable(tableName);
        const query = table.query().limit(sampleSize);
        sampleRecords = await query.toArray();
      } catch (error) {
        console.warn('Failed to fetch LanceDB sample data:', error.message);
        return [];
      }

    } else {
      // All other vector DBs: use connector plugin
      const fullConfig = await getFullConfig(sourceConnection.id);
      const connector = pluginManager.getConnector(sourceConnection.dbType);
      if (!connector || !connector.queryVectors) {
        return [];
      }
      const result = await connector.queryVectors(
        fullConfig,
        sourceConnection.id,
        {
          indexName: indexName,
          namespace: namespace,
          queryVector: null,
          filter: {},
          topK: sampleSize,
          includeValues: true,
          includeMetadata: true
        }
      );

      if (result.success) {
        sampleRecords = result.rows || [];
      }
    }

    return sampleRecords;
  } catch (error) {
    console.warn('Failed to fetch vector sample data:', error.message);
    return [];
  }
}

/**
 * Execute JavaScript transformation on vector source data
 * Similar to a document-store transformation but for vector databases
 */
async function executeVectorSourceTransformation({
  sourceConnection,
  sourceTableSchema,
  transformFunction,
  initialState,
  useEmbeddingSearch,
  searchQuery,
  filter,
  embeddingProvider,
  embeddingModel,
  embeddingApiKey,
  pluginManager,
  getFullConfig,
  appSqliteDbPath,
  nodeId,
  sourceNodeId,
  startTime,
  targetLocalPath,
  storageLocation,
  operationMode,
  helpers = null
}) {
  try {
    const dbType = sourceConnection.dbType || sourceConnection.sourceDbType;

    // For Pinecone, use indexName instead of tableName — and the source's
    // table IS its index, which is all a Transformer's saved schema carries.
    const tableName = sourceTableSchema.tableName;
    const indexName = sourceTableSchema.indexName || sourceConnection.indexName || tableName;

    // For Pinecone, the namespace is stored in the schema field
    const namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

    console.log(`Loading vectors from ${dbType}...`);
    if (dbType === 'pinecone') {
      console.log(`Pinecone index: '${tableName}', namespace: '${namespace}'`);
    }

    // Step 1: Handle embedding search if requested
    let queryVector = null;
    if (useEmbeddingSearch && searchQuery) {
      console.log(`Embedding search query: "${searchQuery}"`);

      // The query must be embedded the way the STORED vectors were, or the
      // dimensions differ and the search is meaningless. A maintenance build
      // rarely names a model, so read it off the records (every embedded record
      // carries _embedding_provider / _embedding_model), then default.
      const sample = (sourceTableSchema?.sampleData || [])[0] || {};
      const stored = sample.metadata && typeof sample.metadata === 'object' ? sample.metadata : sample;
      const provider = embeddingProvider || stored._embedding_provider || 'openai';
      const model = embeddingModel || stored._embedding_model || 'text-embedding-3-small';
      const apiKey = embeddingApiKey
        || (provider === 'openai' ? (helpers?.apiKeys?.chatgpt || helpers?.apiKeys?.openai) : null);
      if (!apiKey) {
        throw new Error(`No API key configured for embedding provider "${provider}" — needed to embed the search text. Add one in Settings → AI Provider.`);
      }

      // Generate embedding for the search query
      const embeddedQuery = await generateEmbeddings({
        data: [{ query: searchQuery }],
        columnToEmbed: 'query',
        provider,
        model,
        apiKey
      });

      queryVector = embeddedQuery[0].vector;
      console.log(`Generated query embedding (${queryVector.length} dimensions)`);
    }

    // Step 2: Fetch vectors from source using search or filter
    let vectors = [];
    let fullConfig = null;
    let connector = null;

    if (dbType === 'lancedb') {
      // LanceDB: embedded library, no connector needed
      const dbPath = lanceDbPathOf(sourceConnection, sourceTableSchema.localPath);
      if (!dbPath) {
        throw new Error('LanceDB path not found in connection config');
      }

      const db = await getLanceDBConnection({ dbPath });

      try {
        const table = await db.openTable(tableName);

        let query;
        if (queryVector) {
          // Embedding search
          // @lancedb/lancedb 0.4.x has no table.search(); results come back
          // nearest first, which is what "the 5 most similar" relies on.
          query = table.query().nearestTo(toVectorArray(queryVector)).limit(100);
        } else {
          // Regular query
          query = table.query().limit(10000);
        }

        // Apply SQL filter if provided
        if (filter && typeof filter === 'string' && filter.trim() !== '') {
          query = query.where(filter);
        }

        vectors = await query.toArray();
      } catch (error) {
        if (error.message.includes('does not exist')) {
          throw new Error(`Table '${tableName}' does not exist in LanceDB`);
        }
        throw error;
      }

    } else {
      // All other vector DBs: use connector plugin
      fullConfig = await getFullConfig(sourceConnection.id);
      const dbType = sourceConnection.dbType || sourceConnection.sourceDbType
      connector = pluginManager.getConnector(dbType);

      if (!connector) {
        throw new Error(`Connector not found: ${dbType}`);
      }

      if (!connector.queryVectors) {
        throw new Error(`${dbType} connector does not support queryVectors method`);
      }
      const id = sourceConnection.id || sourceConnection.connectionId
      const result = await connector.queryVectors(
        fullConfig,
        id,
        {
          indexName: indexName,
          namespace: namespace,
          queryVector: queryVector,
          filter: filter || {},
          topK: queryVector ? 100 : 10000, // Limit results for embedding search
          includeValues: true,
          includeMetadata: true
        }
      );

      if (!result.success) {
        throw new Error(`Failed to query vectors: ${result.message}`);
      }

      vectors = result.rows || [];
    }

    console.log(`Found ${vectors.length} vectors from ${useEmbeddingSearch ? 'embedding search' : 'filter'}`);

    if (vectors.length === 0) {
      return {
        success: true,
        message: 'No vectors found matching the search criteria',
        recordCount: 0,
        executionTime: Date.now() - startTime
      };
    }

    // Step 3: Apply transform function to each record
    if (!transformFunction) {
      throw new Error('transformFunction is required');
    }

    // Create the transform function from string
    const transformFn = eval(`(${transformFunction})`);

    // Initialize state (defaults to empty object)
    let state = initialState || {};

    // Apply transformation to each vector and collect results
    const toUpdate = [];
    const toDelete = [];

    for (const record of vectors) {
      try {
        // Deep clone record before passing to transform function to prevent mutation
        const clonedRecord = JSON.parse(JSON.stringify(record));
        const result = transformFn(clonedRecord, state);
        // console.log('vectors: ', record, result)
        // Handle different return formats for backward compatibility
        let transformedRecord;
        let newState;

        if (result && typeof result === 'object' && 'record' in result) {
          // New format: { record, state }
          transformedRecord = result.record;
          newState = result.state;
        }

        // Update state for next iteration
        state = newState;

        if (transformedRecord === null || transformedRecord === undefined) {
          // Return null → DELETE this record
          toDelete.push(record.id);
        } else if (JSON.stringify(transformedRecord) !== JSON.stringify(record)) {
          // Return modified record → UPDATE it
          if(dbType ==='lancedb'){
            toUpdate.push(replaceNulls(transformedRecord))
          }else{
            toUpdate.push({
              id: transformedRecord.id || record.id,
              vector: transformedRecord.vector || transformedRecord.values || record.vector || record.values,
              metadata: transformedRecord.metadata || record.metadata,
              namespace: namespace
            });
          }
        }
        // If returned same record → SKIP (no operation)
      } catch (error) {
        console.error(`Error transforming record ${record.id}:`, error);
        throw new Error(`Transformation failed for record ${record.id}: ${error.message}`);
      }
    }

    console.log(`Final state:`, toUpdate);

    console.log(`Transform results: ${toUpdate.length} updates, ${toDelete.length} deletes, ${vectors.length - toUpdate.length - toDelete.length} skipped`);

    // Step 4: Execute updates and deletes
    let totalOperations = 0;

    if (dbType === 'lancedb') {
      // LanceDB: embedded library
      // Must be the SAME store step 2 read from: the source first, so an
      // in-place update can never land in a different directory.
      const dbPath = lanceDbPathOf(sourceConnection, sourceTableSchema.localPath, targetLocalPath);

      if (!dbPath) {
        throw new Error('LanceDB path not found in connection config, targetLocalPath, or sourceTableSchema');
      }

      const db = await getLanceDBConnection({ dbPath });
      const table = await db.openTable(tableName);

      if (toUpdate.length === 0 && toDelete.length === 0) {
        console.log(`[LanceDB] Nothing changed in ${tableName}; table left as it is`);
      } else {
      // Rewrite the table in ONE atomic step, never delete-then-add.
      //
      // The old flow deleted the matching records, then added the updated ones;
      // an update that adds a field (tag "tier") failed the add on the schema
      // change, and its fallback then DROPPED the table before re-creating it —
      // and the re-create failed too (vectors read back are typed arrays, not
      // plain arrays), so every record was lost. Here the final record set is
      // built in memory and converted first; only then is it written, as a new
      // version of the same table (`mode: 'overwrite'`). Anything that fails
      // fails before the write, and the table is left exactly as it was.
      const current = toPlainRows(await table.query().toArray());
      // Records are addressed by id. A table written without ids (an older
      // LanceDB export) cannot be maintained safely: every record would share
      // the id "undefined", and one delete would match them all.
      const usableId = (v) => v !== undefined && v !== null && String(v).trim() !== '';
      if (current.some((r) => !usableId(r.id))) {
        throw new Error(`Table "${tableName}" has records without an id, so they cannot be updated or deleted individually. `
          + 'Re-export it (exports now write an id per record) and run this step again. Nothing was changed.');
      }
      const deleteIds = new Set(toDelete.filter(usableId).map(String));
      const updatedById = new Map(toUpdate.filter((v) => usableId(v.id)).map((v) => [String(v.id), v]));
      const finalRecords = [];
      for (const row of current) {
        const id = String(row.id);
        if (deleteIds.has(id)) continue;
        const upd = updatedById.get(id);
        // The transform saw a JSON clone, which turns a typed-array vector into
        // a {"0": …} object; keep the table's own vector unless the function
        // really returned a new one.
        const vec = upd && (Array.isArray(upd.vector) || ArrayBuffer.isView(upd.vector)) ? upd.vector : row.vector;
        const merged = { ...row, ...(upd || {}), vector: toVectorArray(vec) };
        // Search-only fields a similarity query adds to each result; they are
        // not columns of the table and must not become ones.
        delete merged._distance;
        delete merged._relevance_score;
        delete merged._score;
        finalRecords.push(merged);
      }
      if (finalRecords.length === 0 && current.length > 0 && deleteIds.size < current.length) {
        throw new Error('Refusing to rewrite the table: the update would leave it empty without deleting every record.');
      }
      const { records, schema } = normalizeRecordsForArrow(finalRecords);
      await db.createTable(tableName, records, { schema, mode: 'overwrite' });
      console.log(`[LanceDB] Rewrote ${tableName}: ${records.length} records `
        + `(${toUpdate.length} updated, ${toDelete.length} deleted, was ${current.length})`);
      }

      totalOperations = toUpdate.length + toDelete.length;

    } else {
      // All other vector DBs: use connector plugin
      if (!connector.updateAndDeleteVectors) {
        throw new Error(`${dbType} connector does not support updateAndDeleteVectors method`);
      }

      const result = await connector.updateAndDeleteVectors(
        fullConfig,
        fullConfig.id,
        {
          indexName: indexName,
          namespace: namespace,
          toUpdate: toUpdate,
          toDelete: toDelete
        }
      );

      if (!result.success) {
        throw new Error(`Failed to update/delete vectors: ${result.message}`);
      }

      totalOperations = toUpdate.length + toDelete.length;
    }

    // Build config using helper function.
    // toUpdate holds the just-written transformed records — use them as the sample.
    const config = buildVectorConfig({
      operation: 'transform',
      vectorDbType: dbType,
      targetTable: tableName,
      sourceNodeId,
      sourceConnection,
      sourceTableSchema,
      recordCount: totalOperations,
      namespace: namespace,
      indexName: indexName,
      targetLocalPath,
      transformFunction,
      initialState,
      filter,
      searchQuery,
      useEmbeddingSearch,
      sampleRecords: toUpdate
    });

    return {
      success: true,
      message: `Transformed ${vectors.length} vectors: ${toUpdate.length} updated, ${toDelete.length} deleted`,
      recordCount: totalOperations,
      updated: toUpdate.length,
      deleted: toDelete.length,
      skipped: vectors.length - toUpdate.length - toDelete.length,
      executionTime: Date.now() - startTime,
      config
    };

  } catch (error) {
    console.error('Vector source transformation failed:', error);
    return {
      success: false,
      message: `Vector transformation failed: ${error.message}`,
      error: error.stack,
      executionTime: Date.now() - startTime
    };
  }
}

/**
 * Filter out duplicate records in LanceDB
 * Checks both vector similarity and metadata equality
 */
// async function filterDuplicatesLanceDB({ embeddedData, targetTable }) {
//   try {
//     const newRecords = [];
//     const SIMILARITY_THRESHOLD = 0.99; // Very high threshold for exact match

//     const lancedb = require('@lancedb/lancedb');
//     const dbPath = path.join(
//       require('electron').app.getPath('userData'),
//       'data',
//       'lancedb'
//     );

//     const db = await lancedb.connect(dbPath);
//     const tableNames = await db.tableNames();

//     // If table doesn't exist, all records are new
//     if (!tableNames.includes(targetTable)) {
//       return embeddedData;
//     }

//     const table = await db.openTable(targetTable);

//     // Check each record
//     for (const record of embeddedData) {
//       const results = await table
//         .search(record.vector)
//         .limit(1)
//         .toArray();

//       // Check if exact match exists
//       let isDuplicate = false;
//       if (results.length > 0) {
//         const topResult = results[0];

//         // Check similarity score (LanceDB returns _distance, lower is better)
//         // For cosine similarity, distance = 1 - similarity
//         const similarity = 1 - (topResult._distance || 0);

//         if (similarity >= SIMILARITY_THRESHOLD) {
//           // Check metadata equality (excluding internal fields)
//           const recordMeta = { ...record };
//           delete recordMeta.vector;
//           delete recordMeta._embedded_column;
//           delete recordMeta._embedding_provider;
//           delete recordMeta._embedding_model;
//           delete recordMeta._embedded_at;

//           const resultMeta = { ...topResult };
//           delete resultMeta.vector;
//           delete resultMeta._distance;
//           delete resultMeta._embedded_column;
//           delete resultMeta._embedding_provider;
//           delete resultMeta._embedding_model;
//           delete resultMeta._embedded_at;

//           // Compare metadata
//           if (JSON.stringify(recordMeta) === JSON.stringify(resultMeta)) {
//             isDuplicate = true;
//           }
//         }
//       }

//       if (!isDuplicate) {
//         newRecords.push(record);
//       }
//     }

//     return newRecords;

//   } catch (error) {
//     console.warn(`Failed to check LanceDB duplicates: ${error.message}`);
//     // On error, return all records to avoid data loss
//     return embeddedData;
//   }
// }

/**
 * Load source data from various connection types
 * Similar to python-executor pattern (lines 378-462)
 */
async function loadSourceData({
  sourceConnection,
  sourceTableSchema,
  operationType,
  pluginManager,
  getFullConfig,
  appSqliteDbPath
}) {
  const tableName = sourceTableSchema.tableName;

  // Local SQLite
  if (sourceConnection.dbType === 'sqlite') {
    // For local SQLite, check multiple sources for the path:
    // 1. sourceConnection.localPath (external SQLite file)
    // 2. appSqliteDbPath (app's internal SQLite database)
    // 3. sourceConnection.dbConfig.path (fallback)
    const dbPath = sourceConnection.localPath
      || appSqliteDbPath
      || sourceConnection.dbConfig?.path
      || sourceConnection.dbConfig?.database;

    return await loadFromSQLite(tableName, { path: dbPath });
  }

  // Remote database via plugin
  if (pluginManager && sourceConnection.id) {
    const fullConfig = await getFullConfig(sourceConnection.id);
    const connector = pluginManager.getConnector(sourceConnection.dbType);

    if (connector) {
      // Different connectors expect different query shapes — runQuery is
      // intentionally polymorphic. SQL connectors take a SQL string;
      // MongoDB takes a JSON object with collection / filter / limit.
      // Build the right shape per dbType so we don't hand a SQL string
      // to a doc store (which
      // would JSON.parse-throw inside the connector and return success:
      // false, surfacing here as "Unable to load data from source").
      const dbType = String(sourceConnection.dbType || '').toLowerCase();
      let queryPayload;
      if (dbType === 'mongodb') {
        queryPayload = { collection: tableName, filter: {}, limit: 10000 };
      } else {
        // SQL-shaped connectors (Postgres, MySQL, MSSQL, Snowflake,
        // BigQuery, Redshift, …): keep the SELECT * the previous code
        // emitted. Tables with schemas are referenced as
        // "schema.table" by the planner so the literal form is fine.
        queryPayload = {
          query: `SELECT * FROM ${tableName}`,
          tableName: tableName,
          limit: 10000,
        };
      }

      // getFullConfig returns the merged connection config (with `uri`,
      // `database`, etc. at the top level — NOT nested under `.dbConfig`).
      // Every other call site in this codebase (electron.js handlers, the
      // executor helpers) passes `fullConfig` directly. Match that, or
      // the connector's getConnection reads `.uri` from undefined.
      const queryResult = await connector.runQuery(
        fullConfig,
        sourceConnection.id,
        queryPayload,
        10000,
      );

      if (queryResult && queryResult.success) {
        return queryResult.rows || [];
      }
      // Surface the connector's error message instead of the generic
      // "Unable to load data" — the caller wraps it with the dbType so
      // the user still sees that context.
      if (queryResult && queryResult.message) {
        throw new Error(`Source query failed on ${sourceConnection.dbType}: ${queryResult.message}`);
      }
    }
  }

  throw new Error(`Unable to load data from source: ${sourceConnection.dbType}`);
}

/**
 * Load data from a local SQLite FILE.
 *
 * Reads the file by path with its own connection. It used to borrow a
 * connection from the app's shared SQLite pool, which is gone — nothing writes
 * to that database any more — and the pool could only ever open one file
 * anyway, so a source pointing at the user's own .sqlite was read from the
 * wrong place.
 */
function loadFromSQLite(tableName, dbConfig) {
  const dbPath = dbConfig?.path || dbConfig?.database;

  if (!dbPath || !fs.existsSync(dbPath)) {
    return Promise.reject(new Error(`SQLite database not found: ${dbPath}`));
  }
  if (!runLocalQuery) {
    return Promise.reject(new Error('vector-db-executor cannot read SQLite: helpers.runQuery was not injected.'));
  }
  return runLocalQuery('sqlite', { query: `SELECT * FROM ${tableName} LIMIT 10000` }, dbPath)
    .then((rows) => rows || []);
}

/**
 * Execute LanceDB operation
 */
async function executeLanceDB({
  operation,
  data,
  queryText,
  queryVector,
  topK,
  filter,
  targetTable,
  lancedbConfig,
  embeddingProvider,
  embeddingModel,
  embeddingApiKey,
  columnToEmbed,
  overwrite = false
}) {
  const config = {
    ...lancedbConfig,
    tableName: targetTable,
    // Forwarded to upsertVectors: true replaces the table (truncate & load),
    // false upserts — merged by id.
    overwrite: overwrite === true
  };

  if (operation === 'upsert') {
    // Prepare records for LanceDB
    const records = data.map(record => {
      const cleanRecord = {
        id: record.id || resolveRecordId(record, { columnToEmbed }),
        vector: record.vector
      };

      // Flatten metadata object if it exists (from Pinecone or other sources)
      let flattenedRecord = { ...record };
      if (flattenedRecord.metadata && typeof flattenedRecord.metadata === 'object' && !Array.isArray(flattenedRecord.metadata)) {
        const metadataFields = { ...flattenedRecord.metadata };
        delete flattenedRecord.metadata;
        flattenedRecord = { ...flattenedRecord, ...metadataFields };
      }

      // Add other fields, replacing null/undefined with empty strings to avoid Arrow IPC dictionary issues
      for (const [key, value] of Object.entries(flattenedRecord)) {
        if (key === 'id' || key === 'vector') continue; // Already added

        // Skip object/array types (shouldn't happen after flattening, but safety check)
        if (typeof value === 'object' && value !== null) {
          continue;
        }

        // Replace null/undefined with empty string
        if (value === null || value === undefined) {
          cleanRecord[key] = '';
        } else {
          cleanRecord[key] = value;
        }
      }

      return cleanRecord;
    });

    console.log(`LanceDB: Processed ${records.length} records for upsert`);

    return await executeLanceDBOperation({ operation, data: records, config });
  }

  if (operation === 'query') {
    // If queryText provided, embed it first
    if (queryText && !queryVector) {
      const embeddedQuery = await generateEmbeddings({
        data: [{ query: queryText }],
        columnToEmbed: 'query',
        provider: embeddingProvider,
        model: embeddingModel,
        apiKey: embeddingApiKey
      });
      queryVector = embeddedQuery[0].vector;
    }

    config.queryVector = queryVector;
    config.limit = topK;
    config.filter = filter;

    const result = await executeLanceDBOperation({ operation, data: [], config });

    // Format results
    result.data = formatVectorResults(result.data);

    return result;
  }

  if (operation === 'delete') {
    config.filter = filter;
    return await executeLanceDBOperation({ operation, data: [], config });
  }

  if (operation === 'update') {
    config.filter = filter;
    config.updates = data;
    return await executeLanceDBOperation({ operation, data: [], config });
  }

  throw new Error(`Unsupported LanceDB operation: ${operation}`);
}

/**
 * Build vector database config for transformer node
 * Used by both embedding operations and vector source transformations
 */
function buildVectorConfig({
  operation,
  vectorDbType,
  targetTable,
  sourceNodeId,
  sourceConnection,
  sourceTableSchema,
  recordCount = 0,
  targetLocalPath = null,
  targetConnectionId = null,
  namespace = '',
  indexName = null,
  transformFunction = null,
  initialState = null,
  filter = null,
  searchQuery = null,
  useEmbeddingSearch = false,
  sampleRecords = null,
  // Parameters for saveVectorResults
  targetConnectionName = null,
  embeddingProvider = null,
  embeddingModel = null,
  columnToEmbed = null
}) {
  // Build sample data: compact vector arrays to '[N dims]' for display, drop embedding meta
  const formatSample = (records) => {
    if (!Array.isArray(records) || records.length === 0) return [];
    return records.slice(0, 5).map(record => {
      const formatted = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === '_embedded_column' || key === '_embedding_provider'
            || key === '_embedding_model' || key === '_embedded_at') continue;
        if ((key === 'vector' || key === 'values') && Array.isArray(value)) {
          formatted[key] = `[${value.length} dims]`;
        } else if (typeof value === 'string' && value.length > 100) {
          formatted[key] = value.substring(0, 100) + '...';
        } else {
          formatted[key] = value;
        }
      }
      return formatted;
    });
  };

  const sampleData = formatSample(sampleRecords);

  // Derive columns from the actual sample when available; otherwise fall back to the
  // generic id/vector/metadata layout.
  const inferType = (value) => {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'string' && /^\[\d+ dims\]$/.test(value)) return 'VECTOR';
    if (typeof value === 'string') return 'TEXT';
    if (typeof value === 'object') return 'JSON';
    return 'unknown';
  };

  const columns = sampleData.length > 0
    ? Object.keys(sampleData[0]).map(name => ({
        name,
        type: inferType(sampleData[0][name]),
        nullable: name !== 'id',
        isPrimary: name === 'id'
      }))
    : [
        { name: 'id', type: 'TEXT', nullable: false, isPrimary: true },
        { name: 'vector', type: 'VECTOR', nullable: false, isPrimary: false },
        { name: 'metadata', type: 'JSON', nullable: true, isPrimary: false }
      ];

  // Build target table schema for vector databases
  const targetTableSchema = {
    tableName: targetTable,
    columns,
    sampleData
  };

  // Determine target connection ID
  let finalTargetConnectionId;
  if (targetConnectionId) {
    finalTargetConnectionId = targetConnectionId;
  } else if (vectorDbType === 'lancedb') {
    finalTargetConnectionId = 'local-lancedb';
  } else {
    // For Pinecone without explicit targetConnectionId, use sourceConnection (for vector transformations)
    finalTargetConnectionId = sourceConnection?.id;
  }

  const config = {
    nodeType: 'transformer',
    sourceNodeId,
    sourceConnectionId: sourceConnection?.id,
    sourceTableName: sourceTableSchema?.tableName,
    targetConnectionId: finalTargetConnectionId,
    targetDbType: vectorDbType,
    targetTableName: targetTable,
    targetTableSchema: targetTableSchema,
    targetPreviewSql: null,  // Vector DBs don't use SQL
    transformationRequest: `Vector ${operation} operation`,
    skillId: 'vector-db-executor',
    usesSkill: true,
    skillExecution: {
      operation,
      vectorDbType,
      recordCount
    },
    needsSchemaLoad: false,  // Schema already provided in targetTableSchema

    // Transformation function parameters (for vector source transformations)
    transformFunction: transformFunction,
    initialState: initialState,

    // Query parameters
    filter: filter,
    searchQuery: searchQuery,
    useEmbeddingSearch: useEmbeddingSearch,

    // Parameters for saveVectorResults (embedding operations)
    targetConnectionName: targetConnectionName,
    embeddingProvider: embeddingProvider,
    embeddingModel: embeddingModel,
    columnToEmbed: columnToEmbed,
    indexName: indexName,
    namespace: namespace
  };

  // Add type-specific configuration
  if (vectorDbType === 'lancedb') {
    // For LanceDB, include the database path
    const lancedbPath = targetLocalPath || path.join(
      require('electron').app.getPath('userData'),
      'data',
      'lancedb'
    );

    // Set targetLocalPath for LanceDB (it's a directory, will be handled by dbType check)
    config.targetLocalPath = lancedbPath;
    config.targetDbConfig = {
      dbPath: lancedbPath,
      tableName: targetTable
    };
    // Explicitly ensure targetDbType is set
    config.targetDbType = 'lancedb';
    config.storageLocation = 'local'

  } else if (vectorDbType === 'pinecone') {
    // For Pinecone, include connection type and ensure dbType is set
    config.targetConnectionType = 'pinecone';
    config.targetDbType = 'pinecone';
    config.storageLocation = 'database'
    // Store namespace and index name for preview queries
    config.targetNamespace = namespace;
    config.targetIndexName = indexName || targetTable;

    // If source schema has namespace (for Pinecone), preserve it in target
    if (sourceTableSchema?.schema) {
      config.targetTableSchema.schema = sourceTableSchema.schema;
    }
  }
  config.targetDbCategory = 'Vector'
  
  return config;
}

/**
 * Save vector results to local storage
 */
async function saveVectorResults({
  result,
  operation,
  vectorDbType,
  targetTable,
  nodeId,
  sourceNodeId,
  sourceConnection,
  sourceTableSchema,
  appSqliteDbPath,
  targetConnectionId = null,
  namespace = '',
  indexName = null,
  targetLocalPath = null,
  targetConnectionName = null,
  embeddingProvider = null,
  embeddingModel = null,
  columnToEmbed = null,
  embeddedData = null
}) {
  // Query results land in a local DuckDB database, like every other local
  // result in the app. `${targetTable}_query_results` is the table inside it,
  // so re-running the node replaces that table and leaves anything else in the
  // file alone.
  if (operation === 'query' && result.data && result.data.length > 0) {
    const localDbPath = path.join(
      require('electron').app.getPath('userData'),
      'local-collections',
      `${targetTable}_query_results.duckdb`
    );

    const localDbDir = path.dirname(localDbPath);
    if (!fs.existsSync(localDbDir)) {
      fs.mkdirSync(localDbDir, { recursive: true });
    }

    if (!runLocalQuery) {
      throw new Error('vector-db-executor cannot save query results: helpers.runQuery was not injected.');
    }
    await runLocalQuery(
      'duckdb',
      {
        operation: 'insert',
        docs: result.data,
        tableName: `${targetTable}_query_results`,
        mode: 'replace',
      },
      localDbPath,
    );

    return {
      nodeType: 'transformer',
      sourceNodeId,
      sourceConnectionId: sourceConnection?.id,
      sourceTableName: sourceTableSchema?.tableName,
      targetConnectionId: 'local',
      targetDbType: 'duckdb',
      targetTableName: `${targetTable}_query_results`,
      targetLocalPath: localDbPath,
      skillExecution: {
        skillId: 'vector-db-executor',
        operation,
        vectorDbType,
        executionTime: result.executionTime,
        recordCount: result.recordCount
      },
      needsSchemaLoad: true
    };
  }

  // For upsert/delete/update, use helper function.
  // Prefer the actual operation result rows; fall back to the embedded data we just wrote.
  const sampleRecords = (Array.isArray(result?.data) && result.data.length > 0)
    ? result.data
    : embeddedData;

  return buildVectorConfig({
    operation,
    vectorDbType,
    targetTable,
    sourceNodeId,
    sourceConnection,
    sourceTableSchema,
    recordCount: result.recordCount || 0,
    targetConnectionId,
    namespace,
    indexName,
    targetLocalPath,
    targetConnectionName,
    embeddingProvider,
    embeddingModel,
    columnToEmbed,
    sampleRecords
  });
}
