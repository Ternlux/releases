# Embeddings

Ternlux uses embeddings — fixed-length numeric vectors produced from text
— for any operation that involves a vector store: writing rows into a
vector index, performing similarity search inside a join, or exporting a
dataset to a vector destination.

## Provider

**OpenAI** is the embedding provider. Its key is the one you configure
for OpenAI generally; if it isn't configured, any operation that needs
embeddings fails fast with a clear error rather than part way through.
No other embedding provider is supported.

## Models

Three OpenAI models are offered, and the default is the small
current-generation one:

- `text-embedding-3-small` — 1536 dimensions, the default.
- `text-embedding-3-large` — 3072 dimensions, higher quality.
- `text-embedding-ada-002` — 1536 dimensions, legacy.

The model decides the dimension of the vectors produced, and Ternlux
passes that dimension through to the destination index. A Pinecone index
whose dimension does not match fails the upsert with both numbers named.

## How text is embedded

- Texts are embedded in batches of 100 per request.
- A row whose chosen column is empty, null, or not a value that can be
  read as text is skipped rather than embedded as an empty string. A
  column that yields no usable text at all is an error.
- A dotted column name resolves into nested objects, so
  `properties.channel` works as well as a flat key.
- Each embedded record keeps the text that was embedded, the provider,
  the model, and a timestamp, so a later question about how a vector got
  there has an answer.
- Embedding is the longest thing a vector write does and every batch is
  billed, so it can be stopped: a cancelled run stops between batches and
  reports how many were embedded.
- For OpenAI, the cost is estimated from the token count before the first
  request and a high estimate is flagged in the run log.

## Where embeddings are produced

- **Joins that perform similarity search per row** — the driving values
  are embedded once per unique value, then per-row similarity searches
  run against the vector source. This avoids re-embedding the same text
  many times.
- **Joins or transformations writing into a vector destination** — the
  join or transformation runs first, then the nominated column is
  embedded and the vectors are upserted.
- **Outputs to a vector destination** — the same pattern: embed the
  node's **Column to embed**, then upsert (Append, keyed by the optional
  ID column) or truncate and load, with the rest of the row preserved as
  metadata.
- Data that already carries a vector field is upserted as-is, with no
  embedding step — which is what makes moving vectors between stores
  cheap.
- Re-running an embed step — a Transformer, an Output in Append mode, or a
  Join into a vector store — does not re-embed what hasn't changed: rows
  are identified by a key, fingerprinted, and only new or edited text is
  sent to the provider. See the
  [Vector Database Executor](../plugins/skills/vector-db-executor.md).
