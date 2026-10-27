/**
 * How to read a vector store through ctx.runQuery / run_query — the operation
 * objects lib/lancedb.js `runQuery` and the Pinecone connector's `runQuery`
 * actually accept.
 *
 * One copy, shared by every prompt that writes code against these stores (the
 * javascript-executor skill gets it through helpers.lancedb, chat/prompts.js
 * requires it). Prompts that each described the stores in their own words
 * drifted: the JavaScript prompt showed only a Pinecone search, so a model
 * asked for a LanceDB count invented an operation that does not exist.
 *
 * Keep it in step with public/docs/plugins/connectors/lancedb.md and
 * pinecone.md, and with the two runQuery implementations.
 */

const LANCEDB_QUERY_GUIDE = `LanceDB — ctx.runQuery('<connection name>', { operation, tableName, ... })
  (or ctx.runQuery('lancedb', {...}, '<database folder>') for a folder no
  saved connection covers):
    { operation: 'count', tableName, filter? }          -> [{ count }]  (reads no rows)
    { operation: 'list',  tableName, filter?, limit? }  -> rows (no limit = every row)
    { operation: 'query', tableName, queryVector, topK?, filter? }
                                                        -> nearest rows, closest first,
                                                           each with _distance (lower = closer)
  filter is a SQL where-clause string: "price > 100", "name LIKE '%Socks%'".
  Rows are the table's own columns; \`vector\` is the stored embedding.
  There is no other operation — no countRows, no aggregate, no SQL string.`;

const PINECONE_QUERY_GUIDE = `Pinecone — ctx.runQuery('<connection name>', { operation, indexName, namespace?, ... })
    { operation: 'count', indexName, namespace? }       -> [{ count }]  (the whole namespace,
                                                           or the whole index without one;
                                                           no metadata filter)
    { operation: 'list', indexName, namespace?, limit?, filter? }
                                                        -> [{ id, metadata, namespace }]  (browse
                                                           records without a vector; limit
                                                           default 10, at most 1000)
    { operation: 'query', indexName, namespace?, queryVector, topK?, filter? }
                                                        -> [{ id, score, values, metadata, namespace }]
    { operation: 'fetch', indexName, namespace?, ids: [...] }
                                                        -> [{ id, values, metadata, namespace }]
  filter is a Pinecone metadata filter object: { price: { $gt: 100 } }.
  \`values\` is the stored vector, \`metadata\` the record's own fields.
  'query' needs a queryVector — to just look at records use 'list'. There is
  no filtered count.`;

const VECTOR_QUERY_GUIDE = `${LANCEDB_QUERY_GUIDE}\n\n${PINECONE_QUERY_GUIDE}`;

module.exports = { LANCEDB_QUERY_GUIDE, PINECONE_QUERY_GUIDE, VECTOR_QUERY_GUIDE };
