# Connectors

A connector is the bridge between Ternlux and one external system: a
database, a vector store, a cloud bucket, a spreadsheet service, a REST
API, or local files.

Each connector tells Ternlux:

- How to test that the connection works.
- How to list the things you can read from (tables, collections, buckets,
  indexes).
- How to list the columns or fields of one of those.
- How to run a query, fetch records, upload an object, or whatever the
  underlying system supports.
- Optionally: how to quote an identifier, how to stream a large read, how
  to insert in batches, which type names to use when creating a table,
  how to resolve a name against its catalog, which grammar the Data
  Explorer should check against — and how to write the AI prompt that
  produces transformations for that engine, so the dialect's idioms live
  in one place.

## Categories

### Relational databases (SQL)

Generated transformations produce SQL; joins produce SQL, with temporary
tables where a source has to be staged in the destination. Every SQL
connector here declares **merge support**, so a join into it can run in
merge mode: MERGE on PostgreSQL (15+), SQL Server, Snowflake, BigQuery and
DuckDB (local joins); `INSERT … ON DUPLICATE KEY UPDATE` on MySQL, which
needs a PRIMARY KEY on the merge key. MongoDB and the vector stores declare
none.

| Connector | Notes |
| --- | --- |
| [PostgreSQL](postgres.md) | Multi-schema, SSL support, system schemas hidden |
| [MySQL](mysql.md) | Standard pooling, dialect-specific batch inserts |
| [MSSQL (SQL Server)](mssql.md) | Named instances, default `dbo` schema |
| [BigQuery](bigquery.md) | Google data warehouse, OAuth, `dataset.table` naming, larger write batches (each call is a load job) |
| [Snowflake](snowflake.md) | Cloud warehouse, account identifier, warehouse + role context |

<!-- Redshift ships but is not loaded — see the disabled-connector note in
     plugins/plugin-manager.md. Restore this row when it is re-enabled:
| [Redshift](redshift.md) | AWS warehouse, JDBC URL parsing |
-->

### Document databases

Operations are object-shaped (collections, filters, aggregation
pipelines). Generated transformations may use filters, updates, deletes,
aggregation, or custom JavaScript.

| Connector | Notes |
| --- | --- |
| [MongoDB](mongodb.md) | Aggregation pipelines, batched JS transformations |

A local JSON file is not a document store: DuckDB reads it as a table
like any other local file.

### Vector databases

Special paths in transformers, joins, outputs and the assistant handle
embeddings and similarity search. See the
[Vector Database Executor](../skills/vector-db-executor.md) skill for the
full behaviour.

| Connector | Notes |
| --- | --- |
| [Pinecone](pinecone.md) | Cloud vector index, index + namespace model |
| [LanceDB](lancedb.md) | Local vector database, backed by the local-file path — no separate connector to install |

### Cloud storage

File picker and object listing screens. See
[Cloud storage](cloud-storage/README.md).

| Connector | Notes |
| --- | --- |
| [Amazon S3](cloud-storage/s3.md) | AWS keys, S3-compatible endpoints (MinIO, etc.) |
| [Google Cloud Storage](cloud-storage/gcs.md) | OAuth, project-scoped bucket listing |
| [Azure Blob Storage](cloud-storage/azure-blob.md) | Connection string or account key |
| [Google Drive](cloud-storage/google-drive.md) | OAuth, file IDs, format export |
| [OneDrive](cloud-storage/onedrive.md) | OAuth, Microsoft Graph, multi-tenant |
| [Dropbox](cloud-storage/dropbox.md) | OAuth, team-space detection |
| [SharePoint](cloud-storage/sharepoint.md) | OAuth, Microsoft Graph. Ships, but not currently offered in the connection picker |

### Spreadsheet services

| Connector | Notes |
| --- | --- |
| [Google Sheets](google-sheets.md) | OAuth. Browsed like cloud storage — the spreadsheet is the container, its tabs are the files — and written like one |

### REST API

| Connector | Notes |
| --- | --- |
| [REST API](rest-api.md) | Base URL plus your own key/value credentials; the request itself is generated per Data Source node |

### Local files

Local files are handled by a built-in DuckDB connector, so there is
nothing to install and nothing to import. A path is one of two things,
and the difference decides everything:

- A **data file** (CSV, JSON, Parquet, Excel, Avro) is registered as a
  view and read where it lies. A view cannot be written to, so a
  statement that modifies one takes a copy-and-write-back path.
- A **database** (`.duckdb`, `.sqlite`, `.db`) is attached under its own
  alias. Its tables are real tables, so `UPDATE`, `INSERT`, `DELETE` and
  `ALTER` run natively — nothing is copied and nothing is rewritten.
  SQLite goes through DuckDB's `sqlite` extension.

A workbook is the one file holding several tables: each sheet is its
own, all over the same path.

Excel and Avro are read through DuckDB extensions that **ship with the
app**, so a first spreadsheet never waits on a download; the binaries are
matched to the engine's exact version and platform, and a missing one
falls back to fetching it. SQLite's extension is the one that is fetched
on first use and then cached per machine.

LanceDB directories are handled separately: reads go through the built-in
LanceDB library ([LanceDB](lancedb.md)), embedding and vector writes through
the vector skill.
