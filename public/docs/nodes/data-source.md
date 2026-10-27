# Data Source node

A Data Source node points at exactly one input. It is the only node type
that brings external data into a workflow, and it is configured with a
form: pick a saved connection, then pick what to read from it.

The source is picked, not queried. There is no filter step and no load
options — narrowing the data is a transformer's job.

## What you can point it at

The connection's category decides the second step:

- **Relational database** — pick a schema and a table. Downstream nodes
  read the live database.
- **Document database (MongoDB)** — pick a collection.
- **Vector database** — pick an index or table (plus a namespace, for
  Pinecone).
- **Local file** — pick the table the connection owns. A CSV, JSON,
  Parquet, Excel or Avro file is read where it lies by DuckDB; a
  workbook offers one table per sheet; a `.duckdb` or `.sqlite` file
  offers the tables inside it.
- **Cloud storage** — browse the bucket and pick an object, then choose
  where the downloaded copy is kept on disk.
- **Google Sheets** — browsed like cloud storage: the spreadsheet is the
  container and its tabs are the files.
- **REST API** — the form saves the connection choice and hands off to
  the chat assistant, which authors the fetch request.

## Sample data and schema

When you select a table, collection or index, Ternlux reads its columns
and a small sample of rows and stores them on the node. Downstream
builders read that schema to write their SQL, so a source whose schema
could not be read is reported rather than silently left empty.

If a list of tables comes back empty, the form shows the connector's own
message — the file that moved, the extension that would not load, the
port that is closed — rather than a bare "none found".

## What the node does at run time

- **Local file** — nothing is imported. The node checks the file is still
  there and reports its row count; downstream nodes query it in place. A
  missing file fails the node with the path that is gone.
- **Cloud storage / Google Sheets** — the object is downloaded and
  written over the local path you chose, then read in place. A Sheets tab
  downloads as CSV. A node recorded before cloud files were kept on disk
  has no path to refresh and says so, asking you to re-pick a save
  location.
- **REST API** — the saved fetch function runs again, with credentials
  substituted in by the background engine, and the rows it returns are
  written as this node's table in the workflow's DuckDB database.
- **Database, document store, vector store** — nothing to do. The node
  validates its configuration; downstream nodes read the live source.

## The REST API path

You describe in plain language what data you want, and the assistant
generates a single asynchronous JavaScript function that:

- Receives an HTTP client.
- Loops over pages, cursor tokens, or related endpoints as the API
  requires.
- Returns rows as an array of plain objects.

The function references the connection through placeholder tokens —
`{{BASE_URL}}`, plus one per saved key/value parameter — never literal
credentials. The placeholders are filled in inside the background engine
in the moment before the function runs.

**The function only runs once you approve it.** A REST endpoint is the
one source whose shape cannot be looked up, so its columns come from a
real call — but that call is generated code using your credentials, so it
waits for you. Built from the node's chat, the first **Run this node**
makes the call, writes the table and records the node's columns. Built in
a workflow plan, the build pauses on a **Run this call** card (the steps
after it need the columns) and carries on once you approve. A call that
fails, returns an HTTP error, returns nothing, or returns rows with no
readable columns fails and says why — the endpoint, the credentials, or
the parameters.

## Idempotency

A refreshed cloud object replaces the file it was saved to. A REST API
fetch replaces this node's table. Re-running a workflow therefore gives a
deterministic result.

## Where the data lives afterwards

- A file source stays a file, in its own format, read in place.
- A database source stays in its database.
- A REST API source becomes a table in `workflow-data/<workflow>.duckdb`.
