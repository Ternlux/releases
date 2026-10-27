# Transformer node

A Transformer node reshapes data from a single upstream source. It has no
configuration form: you select it on the canvas, describe what you want
in the chat assistant, and the assistant generates the operation and
writes it onto the node.

A transformer is a terminal write: it persists its own result as part of
running, so nothing has to be added after it to save the output.

## Storage location

Where the transformed data lives:

- **Database** — generated and stored inside the same database the source
  comes from.
- **Local** — pulled from the source and written to a table in the
  workflow's own DuckDB database, `workflow-data/<workflow>.duckdb`.
  Previews and downstream nodes query that table with SQL.

A source whose rows are already local — a **file**, a **REST API** source
(its rows are a table in the workflow's database), or another node's local
output — has no catalog to add a table to, so "database" is not available
for it: its new table always lands in the workflow's local database,
whatever the request said, and the storage question is never asked.

When the storage location is local, the operation mode is forced to
"new table" — you cannot perform an in-place update on a remote database
while storing the result locally.

A transformer can only write to its own source connection or to local
storage. It has no field for a different saved connection, so it can
never move data from connection A into connection B — that is an Output
node's job, and a data source can feed one directly.

## Operation mode

- **New table** — create a brand-new table or collection holding the
  transformed data. The source is left untouched. The target is dropped
  and rebuilt on every run, so nothing from a previous run survives.
- **In place** — modify the data by updating, deleting, or altering rows
  or documents rather than producing a separate result. This changes the
  source itself: a database table is altered where it stands, and a local
  file is rewritten. An in-place transformer's target IS its source table.

## One structural and one data change per node

A transformer runs at most one DDL statement and at most one DML
statement, in that order. A request that needs two structural changes, or
a structural change interleaved with two data changes, is two transformer
nodes.

On a re-run, a failing DDL is not fatal **when there is DML behind it** —
the second run of an `ADD COLUMN` reporting "column already exists" is
exactly what a working node looks like. The data statement decides the
node's verdict, and the skipped statement is reported as a warning. A DDL
with no DML behind it is the whole node, so its failure is the node's.

The one exception to single statements is an in-place transform on local
DuckDB storage, where semicolon-separated statements are supported and
run one at a time.

## How the operation is generated

The assistant first analyses the request to settle the operation mode,
the storage location and the target name, asking one specific question at
a time if any of them is ambiguous. Then it generates the operation with
a prompt tuned to the source's engine:

- Local sources (files, and tables in the workflow database) use the
  DuckDB templates.
- Every remote engine supplies its own prompt through its connector, so
  the dialect's idioms, quoting and types live in one place.

## What gets generated

- **Relational source, new table in the same database** — a `CREATE
  TABLE`, an `INSERT INTO … SELECT`, and a preview query. The executor
  drops the target first, so the generated SQL never has to.
- **Relational source, new table stored locally** — the `SELECT` runs on
  the source through its own connector and the rows are streamed into the
  local table. DuckDB writes the result; the `SELECT` defines the shape,
  so no local `CREATE TABLE` is generated.
- **Local source, new table** — one `SELECT` over the source. The rows it
  returns become the node's table (`CREATE OR REPLACE`).
- **Relational source, in place** — an `ALTER TABLE`, an `UPDATE` /
  `DELETE`, or both. Filtering intent like "keep only X" becomes a delete
  of the records that don't match.
- **Document source, new collection** — an aggregation pipeline, a filter
  operation, or a custom JavaScript function. When the destination is
  local, the documents the pipeline returns are written as a table in the
  workflow database.
- **Document source, in place** — an update, delete, or in-place
  JavaScript transformation, applied in batches.
- **Local file, in place** — the `ALTER` / `UPDATE` / `DELETE` statements
  that make the change. The file is copied into a per-node staging table,
  the statements run against that, and the result is **written back over
  the file**. Only what those statements touch changes. The write-back
  happens only if the whole script got through, so a failure leaves the
  file as it was, and the staging table is dropped either way. A local
  *database* file (`.duckdb`, `.sqlite`) is modified directly, with no
  copy — its tables are real tables.
- **Vector source** — routed through the
  [Vector Database Executor](../plugins/skills/vector-db-executor.md)
  skill. Vectors are not something SQL or plain document operations can
  talk to.

## Skill-routed transformations

If the request is a better fit for a skill (Python, JavaScript, vector
operations) than for plain SQL or document operations, the analyser
routes the transformation through that skill, which generates and runs
its own logic.

A skill that keeps asking without converging, or that reports the request
is not its territory, hands back to the standard path and the node is
built normally — except for embedding work, which no engine can express:
if the vector skill cannot resolve it, the build fails and says so rather
than inventing SQL that dies at run time.

A skill also chooses where a local result goes: LanceDB when the records
it produces carry a vector, DuckDB otherwise. The node records which, and
downstream nodes read whichever it picked.

The JavaScript and Python skills both write **locally only** — neither
can write back to a SQL or document server. So a request needing per-row
JavaScript (or pandas) *and* a result living in Mongo or SQL is two
steps: the transformer, then an Output node.

## Vector work that is not a transformer

A transformer can embed a column into a vector table, maintain a vector
store's own records in place, or search a vector store from one fixed
probe ("the five most similar to `clothes`"). Matching each row of one
side against another's by similarity — top-K per row, recommendations,
semantic join — is a **Join**, even when the same vector table is
searched against itself.

## Refining the operation

Send a follow-up message ("also exclude records older than 2020", "use
the customer name column not the email") and the assistant regenerates
with the node's own conversation as context. The node's chat history is
kept on the node, so refinement continues where it left off.

## When the source moves out from under the transformer

A transformer's generated SQL names its source table, and an in-place
transformer's target IS that table. So if the source node is later
rebuilt onto a **different table or connection**, Ternlux re-points the
node's recorded input at the new object but leaves the SQL and the target
alone — they describe the old one.

The node is then marked and **the transformer refuses to run**, naming
what moved. Only rebuilding it clears that. Without the refusal an
in-place transformer would go on writing to the table its source had
abandoned, and report success.

Being re-wired to a *different* node is judged the same way: if the node
now feeding it reads the same table on the same connection, the run
continues; if it reads something else, the run is refused.

A source whose **columns** changed but whose table is the same is
refreshed silently, and the review after a rebuild names any downstream
node whose logic still uses a column that has gone.

## Preview and run

After the assistant writes the node, the chat shows what it will do and
offers to run **that node alone**. Building never runs anything: the
generated operation is saved, and the write happens when you run the
node or the workflow. A single-node run is recorded in the execution
history like any other.
