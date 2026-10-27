# LanceDB

A local vector database: a folder on disk holding one or more tables
(each a `<table>.lance` dataset inside it). Unlike the other stores it is
not a connector plugin — it is built into the app (`public/lib/lancedb.js`)
and needs nothing installed. Embedding and every vector write go through
the [Vector Database Executor](../skills/vector-db-executor.md) skill; this
page covers reading.

## Where LanceDB data comes from

- **A saved LanceDB connection** — a folder you added from the Connections
  tab. Its table list is read from the folder each time, so a table added
  later (by an Output node, say) shows up.
- **An Output node** with the *LanceDB* local format, or one pointed at a
  saved LanceDB connection.
- **A Transformer or Join** that embeds into the local LanceDB directory.

A path that names a single `.lance` dataset rather than the database folder
is resolved to its parent folder plus that table, so either works.

## Reading from code and from the chat

`ctx.runQuery` (JavaScript transforms, joins, validation functions) and the
chat's `run_query` take an operation object. Address a saved connection by
name; a folder no connection covers is `ctx.runQuery('lancedb', {...}, '<folder>')`.

```
{ operation: 'count', tableName, filter? }               -> [{ count }]
{ operation: 'list',  tableName, filter?, limit? }       -> rows
{ operation: 'query', tableName, queryVector, topK?, filter? }
                                                         -> nearest rows, closest first
```

- **count** — the table's row count, or the rows matching `filter`. Reads no
  rows; this is how to count, never `list` and `.length`.
- **list** — rows in insertion order. Without `limit` every row is returned.
- **query** (alias `queryVectors`) — similarity search. Each row carries
  `_distance`: lower is closer. `topK` defaults to 10.
- `filter` is a SQL where-clause string: `"price > 100"`,
  `"name LIKE '%Socks%'"`.

Rows are the table's own columns; `vector` is the stored embedding, and
records written by Ternlux carry `id` plus fingerprint columns
(`_content_hash`, `_meta_hash`, `_embedded_column`, `_embedding_model`, …).

There is no other read operation — no SQL string, no aggregate. Anything
beyond a count (a sum, a group-by) is a `list` read and plain JavaScript.
The chat's `run_query` is read-only: `upsert`, `delete` and `update` are
refused there and only run inside a built workflow.
