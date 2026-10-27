# Vector Database Executor skill

A skill that handles every operation involving embeddings or vector
stores. It is the bridge between regular tabular / document data and
vector indexes, and the engine behind every vector-aware behaviour in
joins, transformers, and outputs.

Its category is "both" — it can be selected for transformer nodes and it
is called directly by other nodes (join, output, data preview) when they
need to read or write vectors.

## Transformer or Join — which node this belongs in

Selecting this skill does not decide the node type; the node type is
chosen first, and only some vector work belongs in a transformer:

- **Transformer** — when the operation stays within a single source:
  embedding a column into a vector table (Mode 1), or in-place
  maintenance of a vector store's own records — update, delete, or tag
  them, optionally selected by a similarity or metadata search (Mode 2).
  A transformer never produces "row + its matches" output.
- **Join** — for all similarity *matching*: "for each row, find the top-K
  most similar rows and combine / enrich / attach the matches"
  (recommendations, semantic join, "find similar items"). This is true
  even when the matches come from the same vector table. Mode 2 is the
  wrong fit, because it only rewrites each record in place — it cannot
  emit each row joined to its neighbours. Route these through a Join; the
  join engine calls this skill's hooks itself.

A search from **one fixed probe** — a query text you supply rather than a
column of rows — has no left-hand side, so it is a transformer, and it
runs through the JavaScript executor rather than this skill.

## When the AI picks this skill

Whenever the request involves embedding text into vectors, semantic
similarity search, a vector source or destination, or words like
"embeddings", "vectors", "similarity search", "vectorise this column",
"find rows similar to …".

If no embedding key is configured, the skill returns a clear error before
any work starts.

## Embedding providers and models

- **OpenAI**, using the same key as the rest of the app.
  - `text-embedding-3-small` (1536 dimensions) — recommended default.
  - `text-embedding-3-large` (3072 dimensions) — higher quality.
  - `text-embedding-ada-002` (1536 dimensions) — legacy.

## Vector destinations

- **LanceDB** — a local vector database. No API key required, and the
  default when no other vector connection exists. Tables are created on
  first upsert.
- **Pinecone** — requires a saved connection. If exactly one connection
  of that type exists the skill selects it; otherwise it asks you which.
  Indexes must already exist — Ternlux does not create them.

## The two modes

### Mode 1 — regular data in, vectors out

The "embed and insert" path:

1. Load every row from the source. **The source data is not filtered** —
   there is no way to narrow it on the way in, so filter upstream (with a
   transformer) if you need a subset.
2. Take the column you nominate, plus the embedding provider and model.
3. Give every row a stable id and a fingerprint of both its embedded text
   and the columns stored beside it, then decide what actually needs
   doing (see below) — all before a single embedding is generated.
4. For OpenAI, estimate the cost from the token count before sending
   anything; a high estimate is flagged in the run log.
5. Generate embeddings in batches of 100, which is also where a stop
   lands.
6. Tag each record with the original text, the provider, the model, and
   an embedded-at timestamp.
7. Upsert the vectors into the destination, with the rest of the row
   preserved as metadata (Pinecone) or as flat columns (LanceDB).

If the data already contains a vector field, the embedding step is
skipped and the rows are upserted as they are — which is what makes
moving vectors between stores cheap.

#### Re-running is cheap by default

A record's identity is a **row key**, not its text. One rule decides the
id for every vector write — a Transformer embed, an Output, and a Join
into a vector store:

1. **The ID column** — the row's primary key (`product_id`, `sku`,
   `order_id`). The builder picks it for a Transformer or Join; on an
   Output the user picks it (optional, Append mode only). A column is
   never used just because it is called `id`.
2. **Otherwise** — a hash of the whole row (vector and fingerprint fields
   left out), whether the write upserts or truncates first. Not a hash of
   the embedded text: rows that share their text but differ elsewhere would
   collide on one id. The same rule in both modes, so switching a node
   between them finds the records it wrote. A row whose fields change gets
   a new id, so an upsert adds it and the old record stays until a
   truncate — name an ID column for a changed row to replace its record.

Ids are never random: a random id can never match an existing record, so
every run would add another copy.

With that identity in hand, a second run compares fingerprints and does
the least work that is correct:

- **Unchanged rows are skipped** — never re-embedded, and never stacked
  into the index as a second copy.
- **Changed text is re-embedded** and, when the id comes from an ID
  column, *replaces* the old vector rather than joining it.
- **Changed metadata beside an unchanged vector is rewritten in place**,
  with no embedding call and so no tokens spent — when there is an ID
  column. Without one the id is a hash of the whole row, so a changed row is
  a new record: it is embedded and written, and the old one stays.

Skipping is the default, and is turned off only for a request that
genuinely needs the vectors rewritten — a different embedding model, a
different embedded column, an explicit "re-embed everything". If the
existence check itself fails, the skill writes everything rather than
silently dropping rows.

### Writing: upsert or truncate-and-load

Every vector write is one of two things:

- **Upsert** — records are written under their ids: a record whose id is
  already stored is **replaced**, new ones are added, nothing else is
  touched. Before anything is embedded, the stored ids are checked: unchanged
  rows are skipped, rows whose other columns changed are rewritten without
  re-embedding, and only new or edited text is embedded — the same for a
  Transformer, an Output in Append mode and a Join. Pinecone upserts natively; LanceDB has no merge operation in
  this version, so the merged table is written back in one atomic step (a
  failure leaves it as it was). A **Transformer** embed and a **Join** into
  a vector store always upsert.
- **Truncate and load** — the index namespace or table is emptied, then
  this run's records are written. An **Output** node does this when its
  write mode is *Truncate & insert*. Every row is embedded, since the target is
  emptied. It is the way to clear out vectors whose source rows no longer
  exist — nothing upstream reports a deletion.

An Output can write to Pinecone, a saved LanceDB connection, or a LanceDB
local file — all three the same way: Append (upsert, with the optional ID
column) or Truncate & insert. A LanceDB file is just a LanceDB database at
the path the node names.

An Output in *Append* mode upserts.

### Mode 2 — the source is a vector store

Here the skill behaves like a document-style transformer. You describe
what should happen in plain language ("set archived vectors to inactive",
"delete vectors with fewer than 10 views", "tag everything similar to
'product documentation'"), and it works in three steps:

1. **Find the records to act on.** Either an **embedding search** — your
   description is embedded and used as a similarity query — or a
   **metadata filter**: a filter object for Pinecone, a SQL `WHERE`
   clause for LanceDB. An empty filter means every record, and the skill
   warns when that is what a request implies.
2. **Apply a transform function to each record.** The AI writes a small
   function that receives the record and a state object shared across the
   whole loop, and returns both. What it returns decides the operation:
   - a modified record → **update**;
   - `null` → **delete**;
   - the record unchanged → **skip**;
   - the state → passed to the next record, which is how counting,
     grouping and tracking across a run work. You can seed an initial
     state.
3. **Apply the changes**, batched. For LanceDB an update is a delete
   followed by an add, and if the transform introduced a new field the
   table is recreated with the merged schema so nothing is lost.

The skill always explains what it is about to do before running it.

## Used by joins

Two narrow hooks the join engine calls:

- **Pull rows from a vector source** — fetches records with an embedding
  search or a metadata filter, then flattens each so the id and metadata
  fields are top-level keys (the vector itself is dropped, being useless
  as a join key). From the join's perspective the source then looks like
  any other table.
- **Embed and upsert joined rows** — after the join produces its rows,
  embeds the nominated column and upserts the vectors under the join's
  `idColumn` (else a hash of the whole row), so a re-run replaces
  what it wrote instead of adding a copy. For LanceDB the rest of the row
  is flattened into the record; for Pinecone it is kept as metadata.

This is what lets a join mix vector and non-vector sources freely, and
land the result anywhere — including back into a vector store.

## Used by outputs

Choosing a vector store as an Output destination delegates the embedding
and the write here, and so does the LanceDB local-file export format.
Rows that already carry vectors are written as they are; plain rows are
embedded from the node's **Column to embed** first. The write follows the
node's write mode (upsert or truncate-and-load, above), keyed by the
optional **ID column** in Append mode.

## Used by data previews

Previewing a vector source also comes through here. Vectors are shown
compactly (`[N dimensions]`) rather than as raw float arrays, with the
id, metadata and namespace shown in full.

## Common failure modes

- **No embedding key configured** — reported before anything else
  happens.
- **Dimension mismatch** — a Pinecone index's dimension must match the
  model's. If it doesn't, the upsert fails with both numbers named.
- **No valid text in the embedding column** — empty and null values are
  skipped rather than embedded as empty strings; a column with nothing
  usable at all is an error.
- **Index does not exist (Pinecone)** — create it in the Pinecone
  dashboard first. LanceDB tables are created automatically.

## What is stored per record

- The vector.
- Every original column from the source row (metadata for Pinecone, flat
  columns for LanceDB — where nulls become empty strings, because the
  storage format requires it).
- The text that was embedded, the provider, the model, and the timestamp.
