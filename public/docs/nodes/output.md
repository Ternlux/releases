# Output node

An Output node takes data from one upstream source and writes it
somewhere. It is configured with a form: choose a destination, then say
what the destination needs.

An Output node delivers a result somewhere the transformer or join that
produced it cannot write itself. It has a **write mode** (a Join has its
own replace / append modes; a Transformer has none).

## Destination

Either a **local file** or a **saved connection**. The questions the form
asks change completely between the two.

## Loading the source

The source is read in **pages**, with no row limit. How hard Ternlux
tries to keep the whole set out of memory depends on what it is reading:

- **Streamed** (peak memory is one page, whatever the table's size):
  every local source read through DuckDB — a data file, an attached
  `.duckdb`/`.sqlite`, an upstream node's table — and every remote SQL
  connector that exposes a cursor, which is all the ones that matter
  (PostgreSQL, MySQL, SQL Server, BigQuery, Snowflake, Google Sheets).
- **Buffered but uncapped** (the whole set lands in memory once, because
  the underlying API has no cursor): MongoDB, vector stores, and any
  connector without streaming.

A read that fails is reported as a failure. It is never allowed to look
like a source that legitimately had no rows — which matters most under
"truncate", where that would empty the destination for nothing.

## The same-connection shortcut

When the source and the destination are the same SQL connection, the
engine does the copy itself: Ternlux resolves both names against the live
catalog, counts the rows, truncates if asked, and issues one
`INSERT INTO … SELECT`. No row travels through the app. If anything about
that is not possible — a different connection, a vector or document or
cloud destination, a table that does not exist yet — it falls back to the
paged path below without comment.

## Local file export

Eight formats:

- **JSON** — a JSON array, written row by row straight to disk.
- **CSV** — written page by page; the column list is fixed from the first
  page so the columns stay aligned down the file.
- **Excel** — one sheet per output node. An existing workbook keeps its
  other sheets, so several nodes pointed at one path with different sheet
  names build up a multi-sheet file. A sheet holds at most 1,048,576 rows
  (fewer when the data is wide); the reader stops one page past the limit
  and says which limit it hit rather than reading millions of rows it
  could never write.
- **DuckDB** — a local database file. You name the table it writes; an
  existing file keeps its other tables and only that one is replaced.
- **SQLite** — same table-per-node rule. Ternlux infers column types from
  the data, drops any pre-existing table of that name, creates it, and
  inserts the rows in a single transaction.
- **Parquet** — columnar, with a schema inferred from the data.
- **Avro** — record format, with a schema inferred from the data.
- **LanceDB** — a local vector table, written through the
  [Vector Database Executor](../plugins/skills/vector-db-executor.md)
  skill. You name the table; the **Save to** path is the database folder
  itself (a name ending in `.lance` is fine), and a LanceDB connection
  pointed at that folder lists the table. Plain rows need a **Column to embed**
  (`outputSettings.embedColumn`, with `embeddingModel`, default
  `text-embedding-3-small`); rows that already carry a `vector` (from an
  embedding step or another vector store) are written as they are. Unlike
  the other files, a LanceDB file is a vector database and is written
  exactly like a LanceDB connection: it has the **Write mode** control
  (Append upserts, with the optional **ID column** and the skip rule;
  Truncate & insert replaces the table) — see *Vector destination* below.

JSON and CSV are written to a temporary file beside the destination and
renamed into place only once complete, so a run that fails or is stopped
half way leaves the previous export intact rather than a truncated file
that still looks like one.

A **file is rewritten whole every run** (or, for the multi-dataset
formats, the named table or sheet is replaced). There is no append,
merge, or upsert to a file, and the write-mode control is not offered —
except for **LanceDB**, which takes Append / Truncate & insert like a
vector connection.

## Database export

- **Relational destination** — Ternlux resolves the table name against
  the live catalog (engines disagree about case, so the name you typed is
  not necessarily the name the engine stored), infers column types from
  the first page, and creates the table if it does not exist. If the
  table *does* exist, its columns are checked against the incoming data
  first: a destination missing a column fails the node, naming both sets,
  **without writing or removing anything**. Rows are then loaded in
  chunks through the connector's batch insert.
- **Document destination** — the documents are inserted a page at a time,
  with any `_id` from the source collection dropped so the destination
  mints its own.
- **Vector destination** — delegated to the vector skill. Plain rows are
  embedded from the node's **Column to embed** (`outputSettings.embedColumn`,
  OpenAI `embeddingModel`, default `text-embedding-3-small`, 1536
  dimensions — a Pinecone index must match) and upserted with the rest of
  the row as metadata (Pinecone) or as columns (a saved LanceDB
  connection). **Append** upserts: a record whose id is already stored is
  replaced, new ones are added — and before embedding, unchanged rows are
  skipped and rows whose other columns changed are updated without
  re-embedding, so only new or edited text costs tokens. Ids come from the optional **ID
  column** (`outputSettings.idColumn`, Append mode only — the row's primary
  key), else a hash of the whole row — in both modes, so switching between
  them never doubles a table. Without an ID column a row whose fields change
  gets a new id: Append adds it and the old record stays until a Truncate,
  and the "update without re-embedding" step only applies with an ID
  column. **Truncate & insert** empties the namespace/table first. Rows that already carry vectors are copied
  without re-embedding. With neither, the run fails and says so. For
  Pinecone the table name accepts both `index-name` and
  `index-name/namespace`.
- **Cloud storage destination** — the cloud browser picks the bucket and
  path. Ternlux serialises the rows to JSON or CSV based on the file
  extension and uploads one object, which replaces whatever was there.
- **Google Sheets destination** — the rows are written into the tab the
  picker chose.

## Write mode

For a destination that keeps rows **between runs** — a table, a
collection, a vector index, a LanceDB file, a Sheets tab — the node asks what should
happen to what is already there:

- **Append** (the default) — the rows are added to whatever is there.
  Re-running adds another copy. For a vector destination (including a
  LanceDB file) Append upserts by id instead, so a re-run does not copy.
- **Truncate & insert** — the destination is emptied first, so it holds
  only this run's rows. The table, index, namespace or tab itself is
  kept: `TRUNCATE` where the engine supports it, `DELETE` otherwise, and
  a failure of both fails the node rather than silently appending.

Truncate matters most for a vector destination, where vectors are
upserted by a content-derived id: re-running an append against changed
data leaves the old vectors beside the new ones and every similarity
search keeps finding rows that no longer exist upstream.

A file destination is rewritten whole regardless, so the setting does not
apply there — a LanceDB file excepted.

**Truncate into a table the workflow reads is refused.** When a Data Source
earlier in the same workflow reads the very table an Output would truncate
(same connection, same table), the run stops with a message instead of
emptying it — the truncate would remove the rows before (or while) they are
read. Write to a different table, or use Append (which never empties it).

## An empty source

If the source yields no rows, the node **succeeds with a warning** and
the destination is left exactly as it is — it is never truncated for
nothing. A single-dataset file export still writes its (headers-only)
file, because that is what the node was asked to do, and says why it has
no rows in it.

## Saving and running

Saving an output node only saves it — nothing is written to the
destination. Running it is a separate, deliberate act: the panel header
offers a Run button once the configuration is saved, and the node also
runs as part of every workflow run.

That separation is deliberate. When saving ran the node, correcting a
wrong destination meant writing to the wrong destination first, and a run
that failed for an unrelated reason threw away settings that were
perfectly good.

## Type inference

For the formats and destinations that need a schema, Ternlux infers
column types from a sample of the data: dates, timestamps, booleans,
integers, floats and strings (with a sized `VARCHAR` where the dialect
requires one). The type *names* come from the destination connector, so a
Snowflake table is created with Snowflake's types and a SQLite file with
SQLite's.
