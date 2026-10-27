/**
 * Vector Database Executor - Join Hooks
 *
 * Narrow helpers consumed by the standard join executor (handleExecuteJoin).
 * The skill is NOT the orchestrator — handleExecuteJoin still runs the join
 * end-to-end. It just calls into here when a source is a vector DB (to pull
 * rows) or when the destination is a vector DB (to embed and upsert).
 *
 * Two hooks:
 *   - fetchVectorSourceRecords: pull from vector source, flatten to rows
 *   - embedAndUpsertJoinedRows: embed a column on joined output, upsert
 */

const path = require('path');

const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

const isVectorConn = (conn) =>
  !!conn && (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType));

/**
 * A vector as a plain numeric array, or null when the value is not one.
 *
 * Normalise at the boundary, because a vector arrives in three shapes and only
 * the first survives an `Array.isArray` check downstream or a spread in
 * AI-written code:
 *
 *   - a plain array (Pinecone `values`, generated code)
 *   - a Float32Array (`Vector.toArray()`, embedding helpers)
 *   - an Apache Arrow `Vector` — what a LanceDB read actually yields. It is
 *     none of the above and is not even index-accessible (`v[0]` is
 *     undefined), so anything that reaches for a dimension sees nothing.
 */
function toPlainVector(value) {
  if (value == null || typeof value === 'string') return null;
  const v = (!Array.isArray(value) && !ArrayBuffer.isView(value) && typeof value.toArray === 'function')
    ? value.toArray()
    : value;
  if (Array.isArray(v)) return v.length > 0 ? v : null;
  // Every typed array iterates as numbers; a DataView does not, and would
  // flatten to an empty array that reads like a vector but is not one.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return v.length > 0 ? Array.from(v, Number) : null;
  }
  if (typeof v[Symbol.iterator] === 'function') {
    const arr = Array.from(v, Number);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

/**
 * Flatten a vector record into a row-shaped object. Metadata fields are
 * promoted to top-level keys. Pinecone records are normalised to look like
 * LanceDB ones so the join executor can treat them uniformly.
 *
 * Vector dimensions are dropped by default — they are not useful as join keys,
 * which is what this was written for. A caller doing a full READ of the source
 * (javascript-executor, whose function may pass the vector straight through to
 * a new vector table) asks for them back with `includeVector`.
 */
function flattenVectorRecord(record, { includeVector = false } = {}) {
  if (!record || typeof record !== 'object') return record;
  const flat = { id: record.id };
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    Object.assign(flat, record.metadata);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'metadata' || key === 'vector' || key === 'values' || key === '_distance') continue;
    if (flat[key] === undefined) flat[key] = value;
  }
  if (includeVector) {
    // Pinecone calls it `values`, LanceDB `vector`; callers only ever see the
    // latter, matching the field name every write path expects.
    const vector = toPlainVector(record.vector) || toPlainVector(record.values);
    if (vector) flat.vector = vector;
  }
  return flat;
}

/**
 * Pull rows from a vector source for the join executor.
 *
 * sourceConfig.vectorFetchOperation shape (provided by the AI):
 *   {
 *     useEmbeddingSearch: boolean,
 *     searchQuery: string | null,
 *     filter: string ("WHERE …" for LanceDB) | object (Pinecone metadata) | "" | {},
 *     topK: number (default 10000),
 *     embeddingProvider?, embeddingModel?  // only if useEmbeddingSearch=true
 *   }
 *
 * `includeVector` keeps each record's vector on the returned row (as a plain
 * numeric array). Off by default: a join has no use for the dimensions and
 * they would bloat every row it carries. A caller reading the source in full
 * — javascript-executor, whose function may hand the vector straight to a new
 * vector table — turns it on.
 */
async function fetchVectorSourceRecords({
  sourceConnection,
  sourceTableSchema,
  vectorFetchOperation,
  pluginManager,
  getFullConfig,
  helpers,
  includeVector = false
}) {
  const dbType = sourceConnection.dbType;
  const tableName = sourceTableSchema.tableName;
  const indexName = sourceTableSchema.indexName || sourceConnection.indexName;
  let namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

  const op = vectorFetchOperation || {};
  const useEmbeddingSearch = op.useEmbeddingSearch === true;
  const searchQuery = op.searchQuery || null;
  let filter = op.filter !== undefined ? op.filter : (dbType === 'pinecone' ? {} : '');

  // `namespace` is a field the connector puts on each record it returns (and
  // flattenVectorRecord keeps as a column), not metadata stored with the
  // vector. A model that
  // sees it in the source's columns writes { namespace: 'e2e' } into the fetch
  // filter, the store applies it as a metadata filter, and every record misses:
  // "Total vectors in namespace: 27 / fetched 0", and the join reported success
  // with 0 rows. It is the store's coordinate, so it is read as one — and it
  // never overrides the namespace the source node names.
  if (filter && typeof filter === 'object' && !Array.isArray(filter)
      && Object.prototype.hasOwnProperty.call(filter, 'namespace')) {
    const { namespace: asked, ...rest } = filter;
    const wanted = typeof asked === 'string' ? asked
      : (asked && typeof asked === 'object' && typeof asked.$eq === 'string' ? asked.$eq : null);
    if (wanted !== null && namespace && wanted !== namespace) {
      throw new Error(`This source reads namespace "${namespace}", but its fetch filter asks for namespace "${wanted}". `
        + 'Point the data source at that namespace, or rebuild the join.');
    }
    if (wanted !== null && !namespace) namespace = wanted;
    filter = rest;
  }
  const topK = op.topK || 10000;

  // Embed the search text if requested.
  let queryVector = null;
  if (useEmbeddingSearch && searchQuery && op.embeddingProvider && op.embeddingModel) {
    // OpenAI is the only embedding provider; its key is stored under 'chatgpt'
    // (or 'openai' on some installs).
    // Anything else has no key to resolve and fails in generateEmbeddings,
    // naming the provider rather than silently embedding with the wrong one.
    const apiKey = op.embeddingProvider === 'openai'
      ? (helpers?.apiKeys?.chatgpt || helpers?.apiKeys?.openai)
      : null;
    const embedded = await helpers.embeddings.generateEmbeddings({
      data: [{ query: searchQuery }],
      columnToEmbed: 'query',
      provider: op.embeddingProvider,
      model: op.embeddingModel,
      apiKey
    });
    queryVector = embedded[0]?.vector || null;
  }

  let vectors = [];

  if (dbType === 'lancedb') {
    const dbPath = sourceConnection.localPath || sourceConnection.dbConfig?.dbPath;
    if (!dbPath) throw new Error('LanceDB path not found in connection config');
    if (!helpers || !helpers.lancedb || typeof helpers.lancedb.getLanceDBConnection !== 'function') {
      throw new Error('fetchVectorSourceRecords requires helpers.lancedb.getLanceDBConnection (electron must inject helpers).');
    }
    const db = await helpers.lancedb.getLanceDBConnection({ dbPath });
    const table = await db.openTable(tableName);
    // @lancedb/lancedb 0.4.x: `table.search(...)` was removed. Build the
    // similarity query through `table.query().nearestTo(vector)` instead.
    let q = queryVector
      ? table.query().nearestTo(queryVector).limit(topK)
      : table.query().limit(topK);
    if (typeof filter === 'string' && filter.trim() !== '') q = q.where(filter);
    vectors = await q.toArray();
  } else {
    const fullConfig = await getFullConfig(sourceConnection.id);
    const connector = pluginManager.getConnector(dbType);
    if (!connector || !connector.queryVectors) {
      throw new Error(`${dbType} connector does not support queryVectors`);
    }
    const result = await connector.queryVectors(fullConfig, sourceConnection.id, {
      indexName,
      namespace,
      queryVector,
      filter: filter || {},
      topK,
      // Cloud stores only send the dimensions back when asked, so the flag has
      // to reach the query as well as the flattening below.
      includeValues: includeVector,
      includeMetadata: true
    });
    if (!result.success) throw new Error(`Failed to query vectors: ${result.message}`);
    vectors = result.rows || [];
  }

  return vectors.map((record) => flattenVectorRecord(record, { includeVector }));
}

/**
 * Empty a namespace of a cloud vector index (Pinecone and the like) before a
 * replace-mode write, keeping the index itself and every other namespace.
 * Shared by the Output node (Truncate & insert) and a join in new-table mode.
 *
 * An index that does not exist yet has nothing to clear — the upsert that
 * follows creates it — and some services answer a clear of an empty or absent
 * namespace with a 404, which is not a failure to clear.
 *
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function clearVectorNamespace({ connector, fullConfig, connectionId, indexName, namespace = '' }) {
  if (typeof connector?.runQuery !== 'function') {
    return { ok: false, message: 'this connector cannot empty an index before loading' };
  }
  let indexExists = null;
  if (typeof connector.getTables === 'function') {
    try {
      const listed = await connector.getTables(fullConfig, connectionId);
      const tables = Array.isArray(listed) ? listed : (listed && listed.tables);
      if ((!listed || listed.success !== false) && Array.isArray(tables)) {
        // A store that rewrites names (Pinecone maps "a_b" to "a-b") lists the
        // name it really holds.
        const wanted = String(
          typeof connector.normalizeTableName === 'function' ? connector.normalizeTableName(indexName) : indexName,
        ).toLowerCase();
        indexExists = tables.some((t) => String((typeof t === 'string' ? t : t && t.name) || '').toLowerCase() === wanted);
      }
    } catch (err) {
      console.log('[Vector] Could not list indexes:', err.message || err);
    }
  }
  if (indexExists === false) return { ok: true, message: `${indexName} does not exist yet — nothing to clear` };
  const cleared = await connector.runQuery(fullConfig, connectionId, {
    operation: 'delete', indexName, namespace, deleteAll: true,
  });
  const benign = /not found|does not exist|empty|404/i;
  if (cleared && cleared.success === false && !benign.test(cleared.message || '')) {
    return { ok: false, message: cleared.message || 'unknown error' };
  }
  return { ok: true };
}

/**
 * Embed a single column on the joined output and upsert into the vector
 * destination. The join executor calls this after running the JS join, in
 * place of a normal "INSERT INTO target".
 *
 * Required params:
 *   joinedRows         - array produced by the join function
 *   columnToEmbed      - field name to embed
 *   vectorDbType       - 'lancedb' | 'pinecone' | …
 *   targetTable        - table/index name
 *   embeddingProvider  - 'openai'
 *   embeddingModel     - provider-specific model id
 *
 * For cloud vector DBs (non-lancedb), also: targetConnectionId, indexName,
 * namespace.
 *
 * For LanceDB, also: targetLocalPath (defaults to userData/data/lancedb).
 */
async function embedAndUpsertJoinedRows({
  joinedRows,
  columnToEmbed,
  vectorDbType,
  targetTable,
  targetLocalPath,
  targetConnectionId,
  indexName,
  namespace = '',
  embeddingProvider,
  embeddingModel,
  embeddingApiKey,
  pluginManager,
  getFullConfig,
  helpers,
  // The row's primary key, as the join builder named it; and the skill's
  // write preparation (index.js prepareRowsForWrite — ids, fingerprints, the
  // unchanged / metadata-only / re-embed split), handed in so there is only one.
  idColumn = null,
  prepareRowsForWrite,
  // 'truncate' — the join is in new-table (replace) mode: the target ends up
  // holding exactly this run's rows (a LanceDB table is rewritten, a cloud
  // namespace emptied first). 'append' — append / merge: records are upserted
  // by id and the rest of the target is kept.
  writeMode = 'append',
}) {
  const replace = writeMode === 'truncate';
  if (!Array.isArray(joinedRows) || joinedRows.length === 0) {
    return { success: true, message: 'No rows to embed', recordCount: 0 };
  }
  if (!columnToEmbed) throw new Error('columnToEmbed is required');
  if (!embeddingProvider || !embeddingModel) {
    throw new Error('embeddingProvider and embeddingModel are required');
  }

  const apiKey = embeddingApiKey
    || (embeddingProvider === 'openai' ? (helpers?.apiKeys?.chatgpt || helpers?.apiKeys?.openai) : null);
  if (!apiKey) {
    throw new Error(`No API key configured for embedding provider: ${embeddingProvider}`);
  }

  const dbPath = vectorDbType === 'lancedb'
    ? (targetLocalPath || path.join(require('electron').app.getPath('userData'), 'data', 'lancedb'))
    : null;

  // A join writes into a vector store as an UPSERT, by the same rule as every
  // vector write: each record under a stable id (the idColumn, else a hash of
  // the embedded text); unchanged rows are skipped, rows whose other columns
  // changed are rewritten without re-embedding, and only new or changed text
  // is embedded.
  // A replace writes every row fresh, so nothing is skipped as "already stored".
  const plan = await prepareRowsForWrite(joinedRows, {
    idColumn,
    columnToEmbed,
    mode: replace ? 'truncate' : 'upsert',
    target: {
      vectorDbType,
      targetTable,
      indexName: indexName || targetTable,
      namespace,
      targetLocalPath: dbPath,
      targetConnectionId,
      pluginManager,
      getFullConfig,
    },
  });
  if (plan.toEmbed.length === 0) {
    return {
      success: true,
      message: plan.metadataUpdated > 0
        ? `No re-embedding needed; refreshed metadata on ${plan.metadataUpdated} record(s).`
        : `All ${plan.skipped} record(s) are already stored and unchanged — nothing to embed.`,
      recordCount: 0,
      ...(dbPath ? { targetLocalPath: dbPath } : {}),
    };
  }

  const embedded = await helpers.embeddings.generateEmbeddings({
    data: plan.toEmbed,
    columnToEmbed,
    provider: embeddingProvider,
    model: embeddingModel,
    apiKey
  });
  const counts = (plan.skipped || plan.metadataUpdated)
    ? ` (${plan.skipped} unchanged skipped, ${plan.metadataUpdated} metadata-only updated)` : '';

  if (vectorDbType === 'lancedb') {
    const records = embedded.map((row) => {
      const rec = { id: row.__vid, vector: row.vector };
      for (const [k, v] of Object.entries(row)) {
        if (k === 'id' || k === 'vector' || k === '__vid') continue;
        if (typeof v === 'object' && v !== null) continue;
        rec[k] = (v === null || v === undefined) ? '' : v;
      }
      return rec;
    });
    const written = await helpers.lancedb.executeLanceDBOperation({
      operation: 'upsert',
      data: records,
      // Append: merged by id (an atomic rewrite), like every vector write.
      // Replace: the table is rewritten with exactly these records.
      config: { dbPath, tableName: targetTable, overwrite: replace }
    });
    if (written && written.success === false) throw new Error(`LanceDB write failed: ${written.message}`);
    return {
      success: true,
      message: `Embedded ${records.length} rows and ${replace ? 'replaced' : 'upserted into'} LanceDB table "${targetTable}"${counts}`,
      recordCount: records.length,
      targetLocalPath: dbPath
    };
  }

  // Cloud vector DBs
  if (!targetConnectionId) {
    throw new Error(`${vectorDbType} requires a target connection ID`);
  }
  const fullConfig = await getFullConfig(targetConnectionId);
  const connector = pluginManager.getConnector(vectorDbType);
  if (!connector || typeof connector.executeVectorOperation !== 'function') {
    throw new Error(`${vectorDbType} connector does not support executeVectorOperation`);
  }

  if (replace) {
    const cleared = await clearVectorNamespace({
      connector, fullConfig, connectionId: targetConnectionId,
      indexName: indexName || targetTable, namespace: namespace || '',
    });
    if (!cleared.ok) throw new Error(`Could not empty ${indexName || targetTable}${namespace ? '/' + namespace : ''} before replacing it: ${cleared.message}`);
    console.log(`[Vector Join] Replace mode: ${cleared.message || `emptied ${indexName || targetTable}${namespace ? '/' + namespace : ''}`} before writing ${joinedRows.length} rows`);
  }

  const vectorData = embedded.map((row) => {
    const meta = { ...row };
    delete meta.vector;
    delete meta.__vid;
    return {
      id: row.__vid,
      vector: row.vector,
      metadata: meta
    };
  });

  const result = await connector.executeVectorOperation(fullConfig, targetConnectionId, {
    operation: 'upsert',
    indexName: indexName || targetTable,
    namespace: namespace || '',
    data: vectorData
  });

  if (!result.success) throw new Error(`Vector upsert failed: ${result.message}`);

  return {
    success: true,
    message: `Embedded ${vectorData.length} rows and ${replace ? 'replaced' : 'upserted into'} ${vectorDbType} index "${indexName || targetTable}"${namespace ? `/${namespace}` : ''}${counts}`,
    recordCount: vectorData.length
  };
}

module.exports = {
  isVectorConn,
  flattenVectorRecord,
  fetchVectorSourceRecords,
  embedAndUpsertJoinedRows,
  clearVectorNamespace
};
