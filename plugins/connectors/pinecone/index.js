/**
 * Pinecone.io Connector Plugin for Ternlux
 * Vector database connector
 * Requires vector-db-executor skill to be installed
 */

const { Pinecone } = require('@pinecone-database/pinecone');

// Connection cache
const connections = new Map();

/**
 * Get or create Pinecone client
 */
async function getConnection(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!config.apiKey) {
    throw new Error('Pinecone API key is required');
  }

  if (!connections.has(key)) {
    const pinecone = new Pinecone({
      apiKey: config.apiKey
    });

    connections.set(key, pinecone);
  }

  return connections.get(key);
}

/**
 * The real Pinecone name for an index the caller asked for.
 *
 * Pinecone only accepts lowercase letters, digits and hyphens, so a name like
 * "product_values" cannot exist as written: the upsert path has always mapped
 * it to "product-values" when creating the index. Every OTHER path used the
 * raw string, so a write went to one index and a read, a delete or a truncate
 * went looking for another — which comes back as a bare 404 that names no
 * index. Applying the same mapping everywhere is what keeps them addressing
 * one index; it can never point at a different real index, because the
 * unmapped form is not a name Pinecone can hold.
 */
const sanitizeIndexName = (name) => String(name || '')
  .toLowerCase()                 // Convert to lowercase
  .replace(/[^a-z0-9-]/g, '-')   // Replace invalid chars with hyphens
  .replace(/--+/g, '-')          // Replace multiple hyphens with single
  .replace(/^-|-$/g, '');        // Remove leading/trailing hyphens

/**
 * Whether a record's metadata satisfies a Pinecone metadata filter — the same
 * operators Pinecone evaluates server-side ($eq $ne $gt $gte $lt $lte $in $nin
 * $exists $and $or, and a bare value meaning $eq). Used where records are
 * enumerated by id (listing), which Pinecone cannot filter.
 */
function matchesPineconeFilter(metadata, filter) {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return Array.isArray(cond) && cond.every((f) => matchesPineconeFilter(metadata, f));
    if (key === '$or') return Array.isArray(cond) && cond.some((f) => matchesPineconeFilter(metadata, f));
    const value = metadata[key];
    const ops = (cond && typeof cond === 'object' && !Array.isArray(cond)) ? cond : { $eq: cond };
    return Object.entries(ops).every(([op, target]) => {
      switch (op) {
        case '$eq': return Array.isArray(value) ? value.includes(target) : value === target;
        case '$ne': return Array.isArray(value) ? !value.includes(target) : value !== target;
        case '$gt': return typeof value === 'number' && value > target;
        case '$gte': return typeof value === 'number' && value >= target;
        case '$lt': return typeof value === 'number' && value < target;
        case '$lte': return typeof value === 'number' && value <= target;
        case '$in': return Array.isArray(target) && (Array.isArray(value) ? value.some((v) => target.includes(v)) : target.includes(value));
        case '$nin': return Array.isArray(target) && (Array.isArray(value) ? !value.some((v) => target.includes(v)) : !target.includes(value));
        case '$exists': return target ? value !== undefined : value === undefined;
        default: return false; // an operator we do not know never matches
      }
    });
  });
}

/**
 * The metadata fields of a namespace, from a sample of its records: one column
 * per key seen, typed from the first non-null value. Keys that only some
 * records carry (a tag set on a few) are included. Returns [] when the
 * namespace is empty or cannot be listed, and the caller falls back to a
 * single JSON `metadata` column.
 */
async function sampleMetadataColumns(index, namespace, sampleSize = 50) {
  try {
    const ns = namespace ? index.namespace(namespace) : index;
    const listFn = typeof ns.listPaginated === 'function'
      ? ns.listPaginated.bind(ns)
      : (typeof ns.list === 'function' ? ns.list.bind(ns) : null);
    if (!listFn) return [];
    const listed = await listFn({ limit: sampleSize });
    const ids = (listed?.vectors || []).map((v) => v.id).filter(Boolean);
    if (ids.length === 0) return [];
    const fetched = await ns.fetch(ids);
    const typeOf = (v) => {
      if (typeof v === 'number') return 'DOUBLE';
      if (typeof v === 'boolean') return 'BOOLEAN';
      if (Array.isArray(v)) return 'LIST';
      return 'TEXT';
    };
    const types = new Map();
    for (const record of Object.values(fetched?.records || {})) {
      for (const [key, value] of Object.entries(record?.metadata || {})) {
        // The record's own columns are listed by the caller; a metadata field
        // of the same name (a source row's `id`) would list twice.
        if (key === 'id' || key === 'values' || key === 'namespace') continue;
        if (value === null || value === undefined) {
          if (!types.has(key)) types.set(key, null);
        } else if (!types.get(key)) {
          types.set(key, typeOf(value));
        }
      }
    }
    return [...types].map(([name, type]) => ({
      name,
      type: type || 'TEXT',
      nullable: true,
      isPrimary: false,
      description: 'Metadata field',
    }));
  } catch (error) {
    console.warn(`[pinecone] could not sample metadata fields: ${error.message}`);
    return [];
  }
}

module.exports = {
  type: 'connector',
  id: 'pinecone',
  name: 'Pinecone',
  icon: './icon.svg',
  dbCategory: 'Vector', // New category for vector databases

  // Dependency on vector skill
  requiredSkills: ['vector-db-executor'],

  /**
   * Configuration schema for UI
   */
  configSchema: {
    fields: [
      {
        name: 'apiKey',
        type: 'password',
        label: 'API Key',
        placeholder: 'Enter your Pinecone API key',
        required: true,
        sensitive: true,
        helpText: 'Your Pinecone API key from the Pinecone console'
      }
    ]
  },

  /**
   * Test Pinecone connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const pinecone = await getConnection(config, connectionId);

      // Test by listing indexes
      const indexes = await pinecone.listIndexes();

      return {
        success: true,
        message: `Connection successful. Found ${indexes.indexes?.length || 0} indexes.`
      };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${error.message}`
      };
    }
  },

  /**
   * Get list of indexes (equivalent to tables)
   * For Pinecone, each namespace within an index is listed as a separate table
   * The namespace is stored in the 'schema' field
   */
  getTables: async (config, connectionId = null) => {
    try {
      const pinecone = await getConnection(config, connectionId);
      const indexList = await pinecone.listIndexes();

      const tables = [];

      // For each index, get its namespaces and create a table entry for each
      for (const indexInfo of indexList.indexes || []) {
        try {
          const index = pinecone.index(indexInfo.name);
          const stats = await index.describeIndexStats();

          // Get all namespaces (including default '')
          const namespaces = Object.keys(stats.namespaces || {});

          // If no namespaces found, add the default namespace
          if (namespaces.length === 0) {
            namespaces.push('');
          }

          // Create a table entry for each namespace
          for (const namespace of namespaces) {
            const namespaceStats = stats.namespaces?.[namespace] || {};

            tables.push({
              schema: namespace, // Namespace stored in schema field
              name: indexInfo.name,
              type: 'INDEX',
              metadata: {
                dimension: stats.dimension || indexInfo.dimension,
                metric: indexInfo.metric,
                // SDK v3 reports `recordCount`; older builds `vectorCount`.
                // Reading only the old name reported 0 for every namespace.
                vectorCount: namespaceStats.recordCount ?? namespaceStats.vectorCount ?? 0,
                pods: indexInfo.spec?.pod?.pods || 0,
                replicas: indexInfo.spec?.pod?.replicas || 1,
                podType: indexInfo.spec?.pod?.podType || 'p1.x1'
              }
            });
          }
        } catch (indexError) {
          console.error(`Failed to get namespaces for index ${indexInfo.name}:`, indexError);
          // Fallback: add index with default namespace
          tables.push({
            schema: '',
            name: indexInfo.name,
            type: 'INDEX',
            metadata: {
              dimension: indexInfo.dimension,
              metric: indexInfo.metric,
              pods: indexInfo.spec?.pod?.pods || 0,
              replicas: indexInfo.spec?.pod?.replicas || 1,
              podType: indexInfo.spec?.pod?.podType || 'p1.x1'
            }
          });
        }
      }

      return {
        success: true,
        tables
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        tables: []
      };
    }
  },

  /**
   * Get index metadata (columns/fields)
   * For vector DBs, this returns namespace and vector dimension info
   */
  getColumns: async (config, connectionId, schema, indexName) => {
    try {
      const pinecone = await getConnection(config, connectionId);
      const index = pinecone.index(sanitizeIndexName(indexName));

      // Get index stats to find namespaces
      const stats = await index.describeIndexStats();

      // The metadata FIELDS, sampled from the namespace — not one opaque
      // `metadata` column. Joins and the JavaScript skill hand generated code
      // each record with its metadata fields at top level, so that is the shape
      // the builder (and the checker after it) must be shown. Listed as a single
      // JSON column, the builder asked which key held a field and the checker
      // "fixed" working `record.tier` code to `record.metadata.tier`.
      const metadataColumns = await sampleMetadataColumns(index, schema);

      const columns = [
        {
          name: 'id',
          type: 'TEXT',
          nullable: false,
          isPrimary: true,
          description: 'Vector ID'
        },
        ...(metadataColumns.length ? metadataColumns : [{
          name: 'metadata',
          type: 'JSON',
          nullable: true,
          isPrimary: false,
          description: 'Vector metadata (no records to sample its fields from)'
        }]),
        {
          name: 'values',
          type: 'VECTOR',
          nullable: false,
          isPrimary: false,
          description: `Vector embeddings (dimension: ${stats.dimension || 'unknown'})`
        },
        {
          name: 'namespace',
          type: 'TEXT',
          nullable: true,
          isPrimary: false,
          description: 'Vector namespace'
        }
      ];

      return {
        success: true,
        columns,
        metadata: {
          dimension: stats.dimension,
          totalVectorCount: stats.totalRecordCount ?? stats.totalVectorCount,
          namespaces: Object.keys(stats.namespaces || {})
        }
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        columns: []
      };
    }
  },

  /**
   * Run query against Pinecone
   * @param {Object} config - Connection config
   * @param {String} connectionId - Connection ID
   * @param {Object} queryObj - Query object with:
   *   - indexName: Index to query
   *   - operation: 'list' | 'query' | 'fetch' | 'count' | 'delete' | 'upsert' | 'update'
   *   - limit: Records to return for 'list' (default 10, at most 1000)
   *   - vector: Query vector for similarity search
   *   - topK: Number of results
   *   - namespace: Namespace to search
   *   - filter: Metadata filter
   *   - ids: IDs to fetch/delete
   *   - vectors: Vectors to upsert
   */
  runQuery: async (config, connectionId, queryObj) => {
    try {
      const pinecone = await getConnection(config, connectionId);
      const { indexName, operation, namespace = '', ...params } = queryObj;

      if (!indexName) {
        // Name what was expected and what arrived: a caller that sent `index`
        // (as the chat assistant did) can correct itself from this message.
        return {
          success: false,
          message: 'Index name is required: pass "indexName" (got: '
            + `${Object.keys(queryObj || {}).join(', ') || 'nothing'}). `
            + 'Supported operations: list, query, fetch, count, upsert, update, delete.'
        };
      }

      const index = pinecone.index(sanitizeIndexName(indexName));
      // console.log('index: ', pinecone, index, indexName)
      const ns = namespace ? index.namespace(namespace) : index;

      let result;
      let rows = [];

      switch (operation) {
        case 'query': {
          // Similarity search. The prompts (and LanceDB) call the search vector
          // `queryVector`; Pinecone's own SDK calls it `vector`. Accept either so
          // one generated function works against both stores.
          const queryVector = params.vector || params.queryVector;

          if (!queryVector || !Array.isArray(queryVector)) {
            return {
              success: false,
              message: 'Query vector is required for similarity search. To read records without a search vector, use operation "list" (with limit).'
            };
          }

          // Pinecone rejects an empty `filter` object outright ("must enter a
          // filter object with at least one key-value pair") rather than
          // treating it as "no filter". Generated code routinely passes `{}` to
          // mean "match everything", so drop the key when there is nothing in it.
          const hasFilter = params.filter
            && typeof params.filter === 'object'
            && Object.keys(params.filter).length > 0;

          result = await ns.query({
            vector: queryVector,
            topK: params.topK || 10,
            includeMetadata: params.includeMetadata !== false,
            includeValues: params.includeValues !== false,
            ...(hasFilter ? { filter: params.filter } : {})
          });

          rows = (result.matches || []).map(match => ({
            id: match.id,
            score: match.score,
            values: match.values,
            metadata: match.metadata,
            namespace: namespace
          }));

          return {
            success: true,
            rows,
            columns: ['id', 'score', 'values', 'metadata', 'namespace'],
            rowCount: rows.length
          };
        }

        case 'list': {
          // Browse records — no query vector, no ids. Without this there was
          // no way to LOOK at a namespace: the chat tried 'fetch' with no ids
          // and 'query' with no vector, both refused, and the builder's sample
          // read (a SQL string to every non-LanceDB store) failed with "Index
          // name is required". Values are left out: a sample is for reading
          // fields, and a 1536-wide array per row is noise. Same enumeration
          // the join executor uses (fetchAllVectors).
          const res = await module.exports.fetchAllVectors(config, connectionId, {
            indexName,
            namespace,
            filter: params.filter || {},
            includeValues: false,
            includeMetadata: true,
            limit: Math.min(Math.max(Number(params.limit) || 10, 1), 1000),
          });
          if (!res.success) return res;
          return {
            success: true,
            rows: res.rows,
            columns: res.columns,
            rowCount: res.rows.length,
          };
        }

        case 'count': {
          // Record count of the namespace (or the whole index when none is
          // given), from the index stats — no records are read. Stats cannot
          // be filtered by metadata on serverless indexes, so a filtered count
          // is refused rather than answered with the unfiltered total.
          if (params.filter && Object.keys(params.filter).length > 0) {
            return {
              success: false,
              message: 'count does not take a metadata filter: Pinecone index stats only count a whole namespace.'
            };
          }
          const stats = await index.describeIndexStats();
          // SDK v3 reports `recordCount` / `totalRecordCount`; older ones
          // `vectorCount` / `totalVectorCount`.
          const nsStats = namespace ? stats.namespaces?.[namespace] : null;
          const count = namespace
            ? (nsStats?.recordCount ?? nsStats?.vectorCount ?? 0)
            : (stats.totalRecordCount ?? stats.totalVectorCount ?? 0);
          return {
            success: true,
            rows: [{ count }],
            columns: ['count'],
            rowCount: 1
          };
        }

        case 'fetch':
          // Fetch by IDs
          if (!params.ids || !Array.isArray(params.ids)) {
            return {
              success: false,
              message: 'IDs array is required for fetch operation'
            };
          }

          result = await ns.fetch(params.ids);

          rows = Object.entries(result.records || {}).map(([id, record]) => ({
            id,
            values: record.values,
            metadata: record.metadata,
            namespace: namespace
          }));

          return {
            success: true,
            rows,
            columns: ['id', 'values', 'metadata', 'namespace'],
            rowCount: rows.length
          };

        case 'upsert':
          // Upsert vectors
          if (!params.vectors || !Array.isArray(params.vectors)) {
            return {
              success: false,
              message: 'Vectors array is required for upsert operation'
            };
          }

          result = await ns.upsert(params.vectors);

          // Handle different response formats from Pinecone SDK
          const upsertedCount = result?.upsertedCount || params.vectors.length;

          return {
            success: true,
            message: `Upserted ${upsertedCount} vectors`,
            rowCount: upsertedCount,
            result: result  // Include raw result for debugging
          };

        case 'update':
          // Update vector
          if (!params.id) {
            return {
              success: false,
              message: 'Vector ID is required for update operation'
            };
          }

          await ns.update({
            id: params.id,
            values: params.values,
            metadata: params.metadata
          });

          return {
            success: true,
            message: `Updated vector ${params.id}`,
            rowCount: 1
          };

        case 'delete':
          // Delete vectors
          if (params.deleteAll) {
            await ns.deleteAll();
            return {
              success: true,
              message: `Deleted all vectors in namespace '${namespace || 'default'}'`
            };
          }

          if (params.ids && Array.isArray(params.ids)) {
            await ns.deleteMany(params.ids);
            return {
              success: true,
              message: `Deleted ${params.ids.length} vectors`,
              rowCount: params.ids.length
            };
          }

          if (params.filter) {
            await ns.deleteMany({ filter: params.filter });
            return {
              success: true,
              message: 'Deleted vectors matching filter'
            };
          }

          return {
            success: false,
            message: 'Delete operation requires ids, filter, or deleteAll flag'
          };

        default:
          return {
            success: false,
            message: `Unknown operation: ${operation}. Supported: list, query, fetch, count, upsert, update, delete`
          };
      }
    } catch (error) {
      console.log('pinecone_error: ', error)
      return {
        success: false,
        message: `Query failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Fetch ALL vectors from index for local transformations
   * Similar to a document store's find() pattern - enables bulk data extraction
   * @param {Object} config - Connection config
   * @param {String} connectionId - Connection ID
   * @param {Object} params - Parameters:
   *   - indexName: Index to fetch from
   *   - namespace: Optional namespace (default: '')
   *   - filter: Optional metadata filter
   *   - includeValues: Include vector values (default: true)
   *   - includeMetadata: Include metadata (default: true)
   *   - limit: Max records to fetch (default: 10000)
   */
  fetchAllVectors: async (config, connectionId, params) => {
    try {
      const pinecone = await getConnection(config, connectionId);
      const {
        indexName,
        namespace = '',
        filter = {},
        includeValues = true,
        includeMetadata = true,
        limit = 10000
      } = params;

      // Parse filter if it's a string
      let parsedFilter = filter;
      if (typeof filter === 'string') {
        if (filter === '' || filter === '{}') {
          parsedFilter = {};
        } else {
          try {
            parsedFilter = JSON.parse(filter);
          } catch (e) {
            console.warn('Failed to parse filter as JSON, treating as empty:', filter);
            parsedFilter = {};
          }
        }
      }

      if (!indexName) {
        return {
          success: false,
          message: 'Index name is required'
        };
      }

      const index = pinecone.index(sanitizeIndexName(indexName));
      const ns = namespace ? index.namespace(namespace) : index;

      // Get index stats to determine total vectors
      const stats = await index.describeIndexStats();
      // SDK v3 reports `recordCount` / `totalRecordCount`; older ones used
      // `vectorCount` / `totalVectorCount`. Reading only the old spelling made
      // this report 0 for a populated index.
      const nsStats = namespace ? stats.namespaces?.[namespace] : null;
      const nsCount = nsStats?.recordCount ?? nsStats?.vectorCount;
      const totalVectors = nsCount
        ?? stats.totalRecordCount
        ?? stats.totalVectorCount
        ?? 0;

      console.log(`Fetching vectors from index '${indexName}' (namespace: '${namespace || 'default'}')`);
      console.log(`Total vectors in namespace: ${totalVectors}`);

      // Pinecone doesn't have a direct "list all" API
      // Strategy: Use listPaginated if available in newer SDK, otherwise use query with pagination
      const allRecords = [];
      const hasFilter = !!parsedFilter && typeof parsedFilter === 'object' && Object.keys(parsedFilter).length > 0;

      // SDK v3 names this `listPaginated`; other versions expose `list`. Probing
      // only for `list` sent every v3 install down the query fallback below,
      // which cannot enumerate an index (see the zero-vector note there).
      const listFn = typeof ns.listPaginated === 'function'
        ? ns.listPaginated.bind(ns)
        : (typeof ns.list === 'function' ? ns.list.bind(ns) : null);

      try {
        if (listFn) {
          let paginationToken = null;
          let fetchedCount = 0;

          do {
            const listParams = {
              limit: Math.min(100, limit - fetchedCount),
              ...(paginationToken && { paginationToken })
            };

            const listResult = await listFn(listParams);

            if (listResult.vectors && listResult.vectors.length > 0) {
              // Fetch full vector data for the IDs
              const ids = listResult.vectors.map(v => v.id);
              const fetchResult = await ns.fetch(ids);

              if (fetchResult.records) {
                Object.entries(fetchResult.records).forEach(([id, record]) => {
                  // Listing cannot filter by metadata, so the filter is applied
                  // here. Without it a "price over 100" update matched every
                  // record in the namespace and changed all of them.
                  if (hasFilter && !matchesPineconeFilter(record.metadata || {}, parsedFilter)) return;
                  allRecords.push({
                    id,
                    values: includeValues ? record.values : null,
                    metadata: includeMetadata ? record.metadata : null,
                    namespace: namespace
                  });
                });
              }

              fetchedCount += listResult.vectors.length;
            }

            paginationToken = listResult.pagination?.next;

            if (fetchedCount >= limit || !paginationToken) break;

          } while (paginationToken && fetchedCount < limit);

        } else {
          // Fallback: Use query with dummy vector for pagination
          console.log('Using query-based pagination (older SDK)');

          // A zero vector cannot rank against anything on a cosine index — its
          // magnitude is 0, so similarity is undefined and Pinecone returns no
          // matches. Use a random unit vector instead: the ordering is arbitrary
          // either way (this path only exists to enumerate), but it returns rows.
          const dimension = stats.dimension || 1536;
          const dummyVector = Array.from({ length: dimension }, () => Math.random() - 0.5);
          const magnitude = Math.sqrt(dummyVector.reduce((sum, v) => sum + v * v, 0)) || 1;
          for (let i = 0; i < dimension; i++) dummyVector[i] /= magnitude;

          let paginationToken = null;
          let fetchedCount = 0;

          do {
            const queryParams = {
              vector: dummyVector,
              topK: Math.min(100, limit - fetchedCount),
              includeMetadata,
              includeValues,
              filter: Object.keys(parsedFilter).length > 0 ? parsedFilter : undefined,
              ...(paginationToken && { paginationToken })
            };

            const queryResult = await ns.query(queryParams);

            if (queryResult.matches && queryResult.matches.length > 0) {
              queryResult.matches.forEach(match => {
                allRecords.push({
                  id: match.id,
                  values: match.values,
                  metadata: match.metadata,
                  namespace: namespace,
                  score: match.score
                });
              });

              fetchedCount += queryResult.matches.length;
            }

            paginationToken = queryResult.pagination?.next;

            if (fetchedCount >= limit || !paginationToken) break;

          } while (paginationToken && fetchedCount < limit);
        }

      } catch (listError) {
        console.error('Error during vector fetching:', listError);
        throw listError;
      }

      console.log(`Successfully fetched ${allRecords.length} vectors`);

      return {
        success: true,
        rows: allRecords,
        columns: ['id', 'values', 'metadata', 'namespace'],
        rowCount: allRecords.length,
        totalVectors: totalVectors,
        // Raw stats, so an empty fetch can be told apart from a fetch against
        // the wrong namespace. `totalVectors` above reads `vectorCount` /
        // `totalVectorCount`, which newer SDKs renamed to `recordCount` /
        // `totalRecordCount` — it reports 0 for a populated index on those.
        indexStats: {
          requestedNamespace: namespace || '(default)',
          usedListApi: Boolean(listFn),
          raw: stats
        },
        message: `Fetched ${allRecords.length} vectors from ${indexName}`
      };

    } catch (error) {
      return {
        success: false,
        message: `Fetch failed: ${error.message}`,
        error: error.stack,
        rows: []
      };
    }
  },

  /**
   * Close connection
   */
  closeConnection: async (connectionId) => {
    if (connections.has(connectionId)) {
      connections.delete(connectionId);
      return { success: true };
    }
    return { success: false, message: 'Connection not found' };
  },

  /**
   * The real index name for one the caller asked for — see sanitizeIndexName.
   *
   * Exposed because a caller comparing a configured name against `getTables`
   * (which reports the names Pinecone actually holds) has to compare like with
   * like: "product_values" never appears in that list, only "product-values".
   */
  normalizeTableName: (name) => sanitizeIndexName(name),

  /**
   * Execute vector operation with automatic index creation
   * @param {Object} config - Connection config with apiKey
   * @param {String} connectionId - Connection ID
   * @param {Object} params - Operation parameters:
   *   - operation: 'upsert' | 'query' | 'delete' | 'update'
   *   - indexName: Index name
   *   - namespace: Namespace (optional)
   *   - data: Array of vectors for upsert [{id, vector, metadata}]
   *   - queryVector: Query vector for search
   *   - topK: Number of results
   *   - filter: Metadata filter
   */
  executeVectorOperation: async (config, connectionId, params) => {
    try {
      // console.log('config, connectionId, params: ', config, connectionId, params, params['data'][0])
      let {
        operation,
        indexName,
        namespace = '',
        data = [],
        queryVector,
        topK = 10,
        filter = {}
      } = params;

      // Parse filter if it's a string
      if (typeof filter === 'string') {
        if (filter === '' || filter === '{}') {
          filter = {};
        } else {
          try {
            filter = JSON.parse(filter);
          } catch (e) {
            console.warn('Failed to parse filter as JSON, treating as empty:', filter);
            filter = {};
          }
        }
      }

      if (!indexName) {
        return {
          success: false,
          message: 'Index name is required'
        };
      }

      // Sanitize index name for Pinecone requirements
      // Pinecone requires: lowercase alphanumeric characters or '-'
      const originalIndexName = indexName;
      indexName = sanitizeIndexName(indexName);

      if (indexName !== originalIndexName) {
        console.log(`Sanitized index name from "${originalIndexName}" to "${indexName}"`);
      }

      // Validate sanitized name
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(indexName) && indexName.length > 1) {
        return {
          success: false,
          message: `Invalid index name: "${originalIndexName}". Pinecone requires lowercase letters, numbers, and hyphens only. Suggested: "${indexName}"`
        };
      }

      const pinecone = await getConnection(config, connectionId);

      // Step 1: Check if index exists for upsert operations
      if (operation === 'upsert' && data.length > 0) {
        const indexList = await pinecone.listIndexes();
        const indexExists = indexList.indexes?.some(idx => idx.name === indexName);

        if (!indexExists) {
          console.log(`Index "${indexName}" does not exist. Creating...`);

          // Get dimension from first vector
          const dimension = data[0].vector?.length || data[0].values?.length;
          if (!dimension) {
            return {
              success: false,
              message: 'Cannot determine vector dimension from data'
            };
          }

          console.log(`Creating index with dimension: ${dimension}`);

          // Create the index
          await pinecone.createIndex({
            name: indexName,
            dimension,
            metric: 'cosine',
            spec: {
              serverless: {
                cloud: 'aws',
                region: 'us-east-1'
              }
            }
          });

          console.log(`Index "${indexName}" created successfully. Waiting for it to be ready...`);

          // Wait for index to be ready
          let retries = 0;
          const maxRetries = 30;
          while (retries < maxRetries) {
            try {
              const testIndex = pinecone.index(indexName);
              await testIndex.describeIndexStats();
              console.log('Index is ready');
              break;
            } catch (error) {
              retries++;
              if (retries >= maxRetries) {
                throw new Error('Index creation timeout - index not ready after 60 seconds');
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        } else {
          console.log(`Index "${indexName}" already exists`);
        }
      }

      // Step 2: Execute the operation using runQuery
      const queryObj = {
        indexName,
        operation,
        namespace
      };

      if (operation === 'upsert') {
        // Helper to sanitize metadata: Pinecone doesn't accept null values
        const sanitizeMetadata = (metadata) => {
          const sanitized = {};
          for (const [key, value] of Object.entries(metadata)) {
            if (value === null || value === undefined) {
              sanitized[key] = '';  // Replace null/undefined with empty string
            } else if (Array.isArray(value)) {
              // For arrays, filter out nulls and keep only strings
              sanitized[key] = value
                .filter(v => v !== null && v !== undefined)
                .map(v => String(v));
            } else if (typeof value === 'object') {
              // Skip nested objects (Pinecone doesn't support them)
              continue;
            } else {
              sanitized[key] = value;
            }
          }
          return sanitized;
        };

        // Prepare vectors in Pinecone format
        queryObj.vectors = data.map(record => ({
          id: record.id,
          values: record.vector || record.values,
          metadata: sanitizeMetadata(record.metadata || {})
        }));
      } else if (operation === 'query') {
        queryObj.vector = queryVector;
        queryObj.topK = topK;
        queryObj.includeMetadata = true;
        queryObj.includeValues = true;
        queryObj.filter = filter;
      } else if (operation === 'fetch') {
        // Used by the existence check before embedding — without this the ids
        // never reached runQuery and every fetch failed as "IDs array required".
        queryObj.ids = params.ids;
      } else if (operation === 'delete') {
        if (params.ids) {
          queryObj.ids = params.ids;
        } else if (filter && Object.keys(filter).length > 0) {
          queryObj.filter = filter;
        } else {
          return {
            success: false,
            message: 'Delete operation requires ids or filter'
          };
        }
      } else if (operation === 'update') {
        queryObj.id = params.id;
        queryObj.values = params.values;
        queryObj.metadata = params.metadata;
      }

      return await module.exports.runQuery(config, connectionId, queryObj);

    } catch (error) {
      console.error('executeVectorOperation error:', error);
      return {
        success: false,
        message: `Vector operation failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Filter out duplicate records in Pinecone
   * Checks both vector similarity and metadata equality
   * @param {Object} config - Database configuration
   * @param {String} connectionId - Connection ID
   * @param {Object} params - Parameters
   * @param {Array} params.embeddedData - Array of records with embedded vectors
   * @param {String} params.indexName - Pinecone index name
   * @param {String} params.namespace - Pinecone namespace
   * @returns {Array} Filtered array of non-duplicate records
   */
  filterDuplicates: async (config, connectionId, params) => {
    try {
      const { embeddedData, indexName, namespace = '' } = params;
      const newRecords = [];
      const SIMILARITY_THRESHOLD = 0.99; // Very high threshold for exact match

      // Check each record
      for (const record of embeddedData) {
        const queryResult = await module.exports.runQuery(
          config,
          connectionId,
          {
            operation: 'query',
            indexName,
            namespace,
            vector: record.vector,
            topK: 1,
            includeMetadata: true
          }
        );

        // Check if exact match exists
        let isDuplicate = false;
        if (queryResult.success && queryResult.matches && queryResult.matches.length > 0) {
          const topMatch = queryResult.matches[0];

          // Check similarity score (Pinecone returns score, higher is better)
          if (topMatch.score >= SIMILARITY_THRESHOLD) {
            // Check metadata equality
            const recordMeta = { ...record };
            delete recordMeta.vector;
            delete recordMeta._embedded_column;
            delete recordMeta._embedding_provider;
            delete recordMeta._embedding_model;
            delete recordMeta._embedded_at;
            delete recordMeta.id;

            const resultMeta = { ...topMatch.metadata };

            // Compare metadata
            if (JSON.stringify(recordMeta) === JSON.stringify(resultMeta)) {
              isDuplicate = true;
            }
          }
        }

        if (!isDuplicate) {
          newRecords.push(record);
        }
      }

      return newRecords;

    } catch (error) {
      console.warn(`Failed to check Pinecone duplicates: ${error.message}`);
      // On error, return all records to avoid data loss
      return params.embeddedData;
    }
  },

  /**
   * Query vectors using embedding search or metadata filter
   * @param {Object} config - Database configuration
   * @param {String} connectionId - Connection ID
   * @param {Object} params - Query parameters
   * @param {String} params.indexName - Pinecone index name
   * @param {String} params.namespace - Pinecone namespace
   * @param {Array} params.queryVector - Query vector for embedding search (optional)
   * @param {Object} params.filter - Metadata filter (optional)
   * @param {Number} params.topK - Number of results to return
   * @param {Boolean} params.includeValues - Include vector values in response
   * @param {Boolean} params.includeMetadata - Include metadata in response
   * @returns {Object} Query results with vectors
   */
  queryVectors: async (config, connectionId, params) => {
    try {
      const {
        indexName,
        namespace = '',
        queryVector,
        filter = {},
        topK = 10000,
        includeValues = true,
        includeMetadata = true
      } = params;
      // Parse filter if it's a string
      let parsedFilter = filter;
      if (typeof filter === 'string') {
        if (filter === '' || filter === '{}') {
          parsedFilter = {};
        } else {
          try {
            parsedFilter = JSON.parse(filter);
          } catch (e) {
            console.warn('Failed to parse filter as JSON, treating as empty:', filter);
            parsedFilter = {};
          }
        }
      }

      const pinecone = await getConnection(config, connectionId);
      const index = pinecone.index(sanitizeIndexName(indexName));
      const ns = namespace ? index.namespace(namespace) : index;

      let vectors = [];

      if (queryVector) {
        // Embedding search - use query with vector
        const result = await ns.query({
          vector: queryVector,
          topK: topK,
          filter: Object.keys(parsedFilter).length > 0 ? parsedFilter : undefined,
          includeValues: includeValues,
          includeMetadata: includeMetadata
        });

        // Convert matches to rows format
        vectors = result.matches.map(match => ({
          id: match.id,
          vector: match.values,
          values: match.values,
          metadata: match.metadata || {},
          score: match.score,
          namespace: namespace
        }));

      } else {
        // Metadata filter only - use fetchAllVectors method
        const fetchResult = await module.exports.fetchAllVectors(
          config,
          connectionId,
          {
            indexName: indexName,
            namespace: namespace,
            filter: parsedFilter,
            includeValues: includeValues,
            includeMetadata: includeMetadata,
            limit: topK
          }
        );

        if (!fetchResult.success) {
          return {
            success: false,
            message: fetchResult.message
          };
        }

        vectors = (fetchResult.rows || []).map(row => ({
          id: row.id,
          vector: row.values,
          values: row.values,
          metadata: row.metadata || {},
          namespace: namespace
        }));
      }

      return {
        success: true,
        rows: vectors,
        recordCount: vectors.length,
        message: `Found ${vectors.length} vectors`
      };

    } catch (error) {
      console.error('queryVectors error:', error);
      return {
        success: false,
        message: `Query failed: ${error.message}`,
        error: error.stack
      };
    }
  },

  /**
   * Update and delete vectors in a single operation
   * @param {Object} config - Database configuration
   * @param {String} connectionId - Connection ID
   * @param {Object} params - Operation parameters
   * @param {String} params.indexName - Pinecone index name
   * @param {String} params.namespace - Pinecone namespace
   * @param {Array} params.toUpdate - Array of vectors to update
   * @param {Array} params.toDelete - Array of vector IDs to delete
   * @returns {Object} Operation result
   */
  updateAndDeleteVectors: async (config, connectionId, params) => {
    try {
      const { indexName, namespace = '', toUpdate = [], toDelete = [] } = params;

      const pinecone = await getConnection(config, connectionId);
      const index = pinecone.index(sanitizeIndexName(indexName));
      const ns = namespace ? index.namespace(namespace) : index;

      let updatedCount = 0;
      let deletedCount = 0;

      // Perform updates (upsert)
      if (toUpdate.length > 0) {
        // Sanitize metadata
        const sanitizeMetadata = (metadata) => {
          const sanitized = {};
          for (const [key, value] of Object.entries(metadata)) {
            if (value === null || value === undefined) {
              sanitized[key] = '';
            } else if (Array.isArray(value)) {
              sanitized[key] = value
                .filter(v => v !== null && v !== undefined)
                .map(v => String(v));
            } else if (typeof value === 'object') {
              continue;
            } else {
              sanitized[key] = value;
            }
          }
          return sanitized;
        };

        const vectors = toUpdate.map(record => ({
          id: record.id,
          values: record.vector || record.values,
          metadata: sanitizeMetadata(record.metadata || {})
        }));

        const result = await ns.upsert(vectors);
        updatedCount = result?.upsertedCount || vectors.length;
      }

      // Perform deletes
      if (toDelete.length > 0) {
        await ns.deleteMany(toDelete);
        deletedCount = toDelete.length;
      }

      return {
        success: true,
        message: `Updated ${updatedCount} vectors, deleted ${deletedCount} vectors`,
        updated: updatedCount,
        deleted: deletedCount
      };

    } catch (error) {
      console.error('updateAndDeleteVectors error:', error);
      return {
        success: false,
        message: `Operation failed: ${error.message}`,
        error: error.stack
      };
    }
  }
};
