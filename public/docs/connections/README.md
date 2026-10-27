# Connections

A connection is a saved, named handle to one external system. You set up
a connection once and then reference it from any number of nodes in any
number of workflows.

## What a connection holds

- A name you choose (e.g. "Production Postgres", "Sales Snowflake").
- A type (which connector backs it).
- A category — database, file, REST API, cloud storage, or vector.
- The non-secret configuration (host, port, base URL, default schema,
  bucket region, etc.).
- The secret configuration (passwords, tokens, API keys), stored
  separately and encrypted.
- For a file connection, what it points at: the path, the tables it owns,
  and for a workbook, which sheet each table is.

## Connection types

| Type | What it points at | Examples |
| --- | --- | --- |
| Local file | A file read in place by DuckDB | CSV / Excel, JSON, Parquet, Avro, DuckDB, SQLite, LanceDB |
| Database | Plugin-driven database connection | PostgreSQL, MySQL / MariaDB, SQL Server, MongoDB, BigQuery, Snowflake |
| Cloud storage | Bucket-style storage with object pickers | S3, Google Cloud Storage, Azure Blob, Dropbox, Google Drive, OneDrive, Google Sheets |
| API | REST API base URL plus your own key/value credentials | Auth headers, API keys, tenant ids, query parameters |
| Vector | Vector index | Pinecone (cloud), LanceDB (local, under Local file) |

Adding a local file does not import or convert it. Ternlux asks DuckDB
what tables the file holds and records them; the file stays where you put
it. A workbook contributes one table per sheet, and a `.duckdb` or
`.sqlite` file contributes the tables inside it.

Every local file connection is backed by the same DuckDB engine whatever
its format — the format is recorded alongside the path rather than
changing what reads it — which is why a CSV, a workbook and a SQLite
database all browse, query and join the same way. A LanceDB directory is
the exception: it is a vector store and is read through the vector
skill.

## How forms are built

Most connection forms are generated from the connector's own
configuration schema. Each field has a name, a type (text, number,
password, boolean, key/value list), a label, an optional default, and a
flag saying whether it is sensitive. Sensitive fields go to the encrypted
credential store; everything else is saved with the public connection
record. A few connectors with richer setup needs use hand-tailored forms
(local file imports and spreadsheet uploads among them); the end result
is the same.

A **key/value field** (used by the REST API connector) lets you enter up
to 50 entries of your own. Keys must be unique within a connection, and
rows left without a key are discarded when you save. The values are
encrypted and never sent to the chat: the assistant sees only your key
names and refers to each value by a placeholder, so a key named
`X-API-Key` appears in the generated request as `{{X_API_KEY}}` and is
filled in at run time. When you edit a saved connection the values come
back blank — leave one blank to keep what's stored, or delete the row to
remove it.

## Testing and editing

Connection forms offer a test before you save, and OAuth-based connectors
offer an Authorize button (see
[Credentials and authentication](credentials-and-auth.md)). Updating a
saved connection's credentials replaces the stored blob wholesale and
closes any cached pooled connection, so the next query reconnects with
the new values.

## Contents

- [Credentials and authentication](credentials-and-auth.md) — how
  secrets are stored and how OAuth-based connections are authorised
- [Data Explorer](data-explorer.md) — browsing a connection's schema and
  running statements against it directly
