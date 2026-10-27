/**
 * A node's source, as PAGES of rows — however many there are.
 *
 * The output node used to read its source with `readTableHeadAt(path, table,
 * 1000000)` and friends: one array, built whole, capped at a million rows. Both
 * halves of that were wrong. The cap silently dropped everything past the
 * millionth row — a ten-million-row table loaded as one million and the run
 * reported success — and under writeMode 'truncate' that is a destination
 * emptied and refilled with a tenth of the data. Raising the number would only
 * have traded a silent truncation for an out-of-memory crash, because ten
 * million row objects do not fit in a renderer-sized heap.
 *
 * So the read is paged instead, and unbounded. Nothing here has a row limit.
 *
 * Every source yields `object[]` pages. What differs is how hard each one tries
 * to keep the whole set out of memory:
 *
 *   TRUE STREAMING — peak is one page, whatever the table's size:
 *     · EVERY local source but LanceDB. They all read through DuckDB —
 *       a .duckdb or .sqlite/.db is attached (SQLite via DuckDB's sqlite
 *       extension) and a csv/json/parquet/xlsx is read in place — so one call,
 *       duck.streamLocalRows, covers the lot in ~2048-row chunks.
 *     · remote SQL connectors that expose `streamQuery` — which is all of them
 *       that matter: postgres, mysql, mssql, bigquery, snowflake, redshift,
 *       google-sheets (cursor-based, with backpressure)
 *
 *   BUFFERED, BUT UNCAPPED — the whole set still lands in memory once, because
 *   the underlying API has no cursor to page. The million-row ceiling is gone;
 *   the memory profile is what it always was:
 *     · MongoDB, vector stores (LanceDB / Pinecone), and any SQL connector
 *       without `streamQuery`
 *
 * The distinction is deliberate and worth keeping visible: `pagesAreStreamed`
 * on the result says which kind you got, so a caller can say so in a log rather
 * than everyone assuming the good case.
 */

const { streamPluginRows } = require('../lib/pluginRowStream');
const { throwIfCancelled } = require('./executionCancel');
const { qualifierFor } = require('../lib/tableRef');

// Rows per page handed to the consumer. Independent of the DESTINATION's batch
// size (see lib/batchChunkSize.js) — the consumer re-chunks to whatever its
// writer wants, so this only decides the reader's own peak.
const DEFAULT_PAGE_SIZE = 5000;

/** Re-chunk an async iterable of rows into fixed-size pages. */
async function* pageRows(rows, pageSize) {
  let page = [];
  for await (const row of rows) {
    page.push(row);
    if (page.length >= pageSize) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
}

/** One already-materialised array, handed over in pages. */
async function* pageArray(rows, pageSize) {
  for (let i = 0; i < rows.length; i += pageSize) {
    yield rows.slice(i, i + pageSize);
  }
}

/**
 * The rows of a vector store. Buffered — neither client pages usefully here.
 */
async function readVectorAll(sourceConnection, sourceTableSchema, pluginManager, getFullConfig, lanceLib) {
  const indexName = sourceTableSchema.indexName || sourceTableSchema.tableName;
  const namespace = sourceTableSchema.schema || sourceTableSchema.namespace || '';

  if (sourceConnection.dbType === 'lancedb') {
    // fileInfo.filePath first — that is where the connection form records a
    // picked LanceDB directory.
    const configuredPath = sourceConnection.fileInfo?.filePath
      || sourceConnection.localPath
      || sourceConnection.dbConfig?.dbPath;
    if (!configuredPath) throw new Error('LanceDB path not found in connection config');

    const { dbPath, tableName } = lanceLib.normalizeLanceTarget({
      dbPath: configuredPath,
      tableName: indexName,
    });

    const lancedb = require('@lancedb/lancedb');
    const db = await lancedb.connect(dbPath);
    const table = await db.openTable(tableName);
    // No .limit(): LanceDB's query builder defaults to returning everything
    // when none is given, and a limit here is exactly the cap being removed.
    // Arrow StructRow proxies, not objects: a destination driver that writes to
    // the row it was given (the MongoDB driver stamps `_id` onto every
    // document) fails on the proxy's set trap, and none of them serialise.
    return lanceLib.toPlainRows(await table.query().toArray());
  }

  const plugin = pluginManager.getConnector(sourceConnection.dbType);
  if (!plugin || !plugin.fetchAllVectors) {
    throw new Error(`${sourceConnection.dbType} connector does not support fetchAllVectors`);
  }
  const fullConfig = await getFullConfig(sourceConnection.id);
  const result = await plugin.fetchAllVectors(fullConfig, sourceConnection.id, {
    indexName,
    namespace,
    filter: {},
    includeValues: true,
    includeMetadata: true,
  });
  if (!result.success) throw new Error(`Failed to load vectors: ${result.message}`);
  return result.rows || [];
}

/**
 * Open a node's source for reading.
 *
 * @returns {{ pages: AsyncIterable<object[]>, pagesAreStreamed: boolean }}
 *   `pages` yields non-empty row arrays until the source is exhausted. A source
 *   with no rows yields nothing at all — callers decide what empty means.
 */
function openSourcePages({
  sourceConnection,
  sourceTableSchema,
  pluginManager,
  getFullConfig,
  lanceLib,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  const plugin = pluginManager.getConnector(sourceConnection.dbType);
  const isVector = plugin?.dbCategory === 'Vector'
    || sourceConnection.dbType === 'pinecone'
    || sourceConnection.dbType === 'lancedb';

  // ── vector stores (buffered) ──────────────────────────────────────────────
  if (isVector) {
    return {
      pagesAreStreamed: false,
      pages: (async function* () {
        const rows = await readVectorAll(
          sourceConnection, sourceTableSchema, pluginManager, getFullConfig, lanceLib,
        );
        yield* pageArray(rows, pageSize);
      })(),
    };
  }

  // ── local sources ─────────────────────────────────────────────────────────
  //
  // Everything local except LanceDB is read by DuckDB — that is what
  // the local connections ARE, whatever their dbType says. A 'sqlite' local
  // connection is backed by the DuckDB connector too: DuckDB attaches the file
  // through its sqlite extension and reads it as real tables. So there is one
  // branch here, not one per extension, and `streamLocalRows` makes the
  // attach-or-read-in-place decision with the same predicate the connector uses.
  if (sourceConnection.localPath) {
    const tableName = sourceTableSchema?.tableName || sourceConnection.tableName;

    const duck = require('../duckdb');
    // DuckDB's own ~2048-row chunks are re-cut to the requested page size so
    // every source hands the consumer pages of the same shape.
    return {
      pagesAreStreamed: true,
      pages: pageRows(
        flatten(duck.streamLocalRows(sourceConnection.localPath, tableName, {
          // fileInfo.format first — that is where the connection form records a
          // picked file's format, and the join reader already reads it there.
          format: sourceConnection.fileInfo?.format || sourceConnection.dbConfig?.format || null,
          sheet: duck.sheetFor(sourceConnection.localPath, tableName),
        })),
        pageSize,
      ),
    };
  }

  // ── remote connections ────────────────────────────────────────────────────
  const dbType = sourceConnection.dbType;

  // Everything below talks to a connector. A source that reaches here without
  // one — a cloud-storage connection whose download-to-local step never ran, a
  // connector that failed to load — used to die on `plugin.runQuery is not a
  // function`, which names neither the connection nor the reason. Cloud stores
  // in particular have NO query interface at all: their files are downloaded by
  // the data-source node and read locally, so a cloud source landing here means
  // that step was skipped, and the error should say so.
  if (!plugin || typeof plugin.runQuery !== 'function') {
    const isCloud = plugin?.storageType === 'cloud-storage' || sourceConnection.dbCategory === 'CloudStorage';
    throw new Error(isCloud
      ? `${sourceConnection.name || dbType} is a cloud-storage connection with no local copy of its file — `
        + 'run its data-source node first so the file is downloaded, then re-run this node.'
      : `No connector can read this source (dbType "${dbType}").`);
  }
  const dbCategory = plugin?.dbCategory || sourceConnection.dbCategory || null;
  const isNoSQL = dbType === 'mongodb' || dbCategory === 'NoSQL';
  const isSheets = dbType === 'google-sheets';
  const schema = sourceConnection.dbConfig?.schema;

  // A NoSQL connector prefers `query` when present and tries to JSON.parse it,
  // so it must never be handed SQL.
  //
  // One that can stream (MongoDB's cursor) is read a batch at a time, like a
  // SQL source — the JSON envelope is its query, as for Sheets below. Only a
  // connector without streamQuery still reads the collection whole.
  if (isNoSQL && typeof plugin?.streamQuery === 'function') {
    const envelope = JSON.stringify({ collection: sourceTableSchema.tableName, filter: {} });
    return {
      pagesAreStreamed: true,
      pages: (async function* () {
        const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        yield* pageRows(streamPluginRows(plugin, fullConfig, sourceConnection.id, envelope, pageSize), pageSize);
      })(),
    };
  }
  if (isNoSQL) {
    return {
      pagesAreStreamed: false,
      pages: (async function* () {
        const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        // 0 = no cap, matching the "read it whole — uncapped" contract this
        // reader has for every other source type. The connector's default is
        // 100, so an output node reading a document store silently wrote only
        // the first 100 documents of its source and reported success.
        const result = await plugin.runQuery(fullConfig, sourceConnection.id, {
          collection: sourceTableSchema.tableName,
          filter: {},
        }, 0);
        if (result && result.success === false) {
          throw new Error(
            `Failed to read ${sourceTableSchema.tableName} from `
            + `${sourceConnection.name || dbType}: ${result.message || 'unknown error'}`,
          );
        }
        yield* pageArray(result.rows || result.data || [], pageSize);
      })(),
    };
  }

  // Google Sheets streams like a SQL connector but does NOT speak SQL: its
  // streamQuery JSON.parses whatever it is handed and reads
  // { spreadsheetId, range, sheetName }. Sending it a SELECT would throw inside
  // the connector before a row moved, so it gets its own envelope — as a JSON
  // STRING, because streamQuery's third argument is the query in string form.
  if (isSheets && typeof plugin?.streamQuery === 'function') {
    const envelope = JSON.stringify({
      spreadsheetId: sourceTableSchema.tableName,
      sheetName: sourceTableSchema.sheetName,
      range: sourceTableSchema.sheetName,
    });
    return {
      pagesAreStreamed: true,
      pages: (async function* () {
        const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        yield* pageRows(streamPluginRows(plugin, fullConfig, sourceConnection.id, envelope, pageSize), pageSize);
      })(),
    };
  }

  // Generic SQL. Hand the connector ONE qualifier — see lib/tableRef.js for why
  // a name that already carries its schema must not also be given one.
  const table = sourceTableSchema.tableName;
  const qualifier = qualifierFor(table, schema);
  let fullTableName;
  if (plugin && typeof plugin.quoteIdentifier === 'function') {
    fullTableName = plugin.quoteIdentifier(table, qualifier, sourceConnection.dbConfig);
  } else {
    fullTableName = qualifier ? `${qualifier}.${table}` : table;
  }
  const sql = `SELECT * FROM ${fullTableName}`;

  if (typeof plugin?.streamQuery === 'function') {
    return {
      pagesAreStreamed: true,
      pages: (async function* () {
        const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        yield* pageRows(streamPluginRows(plugin, fullConfig, sourceConnection.id, sql, pageSize), pageSize);
      })(),
    };
  }

  // No cursor to page with. Read it whole — uncapped.
  return {
    pagesAreStreamed: false,
    pages: (async function* () {
      const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
      const queryObj = isSheets
        ? {
          spreadsheetId: sourceTableSchema.tableName,
          sheetName: sourceTableSchema.sheetName,
          range: sourceTableSchema.sheetName,
        }
        // `qualifier`, not `schema`, for the same reason as above: a connector
        // that reads these instead of `query` must not be handed a qualified
        // name AND a schema.
        : { query: sql, tableName: table, schema: qualifier };
      const result = await plugin.runQuery(fullConfig, sourceConnection.id, queryObj);
      // A failed read comes back as { success: false } with no rows. Falling
      // through with an empty array would look like a source that legitimately
      // has no data — and under writeMode 'truncate' the destination is emptied
      // before the load, so an unreadable source would WIPE the target and
      // report success.
      if (result && result.success === false) {
        throw new Error(
          `Failed to read ${sourceTableSchema.tableName} from `
          + `${sourceConnection.name || dbType}: ${result.message || 'unknown error'}`,
        );
      }
      yield* pageArray(result.rows || result.data || [], pageSize);
    })(),
  };
}

/** An async iterable of row ARRAYS, flattened to an iterable of rows. */
async function* flatten(pages) {
  for await (const page of pages) {
    for (const row of page) yield row;
  }
}

/**
 * The source's column types, as canonical types (see columnTypes.js), for
 * exactly what openSourcePages reads — or null when the source cannot say.
 *
 * Asked of the same place each branch above reads from: DuckDB describes the
 * same ref for a local source; a SQL connector's getColumns describes the
 * table its `SELECT *` reads. A schemaless source (Mongo, Sheets, a vector
 * store) has no types to give and answers null, and so does a lookup that
 * fails — the caller then guesses from values, as it always did.
 */
async function readSourceSchema({ sourceConnection, sourceTableSchema, pluginManager, getFullConfig }) {
  const { canonicalFromDuckType, canonicalSchema } = require('./columnTypes');
  try {
    // A vector store has no column types to give: its rows are typed from
    // their values (all of them — the read is buffered).
    const sourcePlugin = pluginManager.getConnector(sourceConnection.dbType);
    if (sourcePlugin?.dbCategory === 'Vector' || ['pinecone', 'lancedb'].includes(sourceConnection.dbType)) {
      return null;
    }
    if (sourceConnection.localPath) {
      const tableName = sourceTableSchema?.tableName || sourceConnection.tableName;
      const duck = require('../duckdb');
      const columns = await duck.describeLocalSource(sourceConnection.localPath, tableName, {
        format: sourceConnection.fileInfo?.format || sourceConnection.dbConfig?.format || null,
        sheet: duck.sheetFor(sourceConnection.localPath, tableName),
      });
      return canonicalSchema(columns, (col) => canonicalFromDuckType(col.type));
    }

    const plugin = pluginManager.getConnector(sourceConnection.dbType);
    if (!plugin || typeof plugin.getColumns !== 'function' || typeof plugin.toCanonicalType !== 'function') {
      return null;
    }
    const table = sourceTableSchema?.tableName;
    if (!table) return null;
    const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
    const qualifier = qualifierFor(table, sourceConnection.dbConfig?.schema);
    const result = await plugin.getColumns(fullConfig, sourceConnection.id, qualifier, table);
    if (!result || result.success === false) return null;
    return canonicalSchema(result.columns, (col) => plugin.toCanonicalType(col));
  } catch (err) {
    console.log(`[Output] Could not read the source's column types (${err.message}) — guessing them from values`);
    return null;
  }
}

module.exports = {
  openSourcePages,
  readSourceSchema,
  DEFAULT_PAGE_SIZE,
};
