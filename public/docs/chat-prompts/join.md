# Join generation

The join templates gather how two or more sources should be combined, and
then emit the operation for the destination that was chosen.

## Phase 1 — analysis

**Every source is re-read live first** — its columns and a sample of its
rows, one lookup per source against its own database. Join keys are
chosen from column names, so a source that has gained or lost a column
since its node was configured would otherwise produce conditions on
columns that are not there. A transformer or join upstream is exempt: it
declares the shape it writes, and it rewrites its table before this node
runs, so its declaration is the newer account.

A source that still has no columns is not analysed around. The builder
asks you for the key columns each such source contributes, and folds
your answer into the request the analyser sees.

Before generating, the analyser insists on:

- **The exact column relationships between every pair of tables.** Even
  when two columns are obviously named the same, it asks for
  confirmation.
- **The join type for every pair** — INNER, LEFT, RIGHT or FULL. Never
  inferred from column-name similarity, and different pairs may differ.
- **The columns to keep, per source.** `["*"]` on its own means all of
  that source's columns.
- **A target table or collection name.** Always required.

It asks one specific question per turn, naming the tables and columns it
has already seen, and writes for someone who has never seen the app's
internals — never about "settings", a response format, or what the JSON
can express. It does not ask a question whose only sensible answer is
"yes", and it does not treat a complicated join as a reason to ask: the
generated SQL (or JavaScript) can express any number of stages.

There are exactly two outcomes: `generate_join`, or `ask_questions` with
what it needs — including when you asked something informational, or when
the request names something that isn't among the sources. Anything else
is treated as a question rather than as a finished join, so a refusal can
never leave a join wired to whatever it was built against last time.

The analysis also records the destination and a **vector flag** saying
which of the two vector scenarios applies. It is the single authority on
that flag: the generation step below gates the whole embedding path on
it.

**Where the destination comes from**, in order: the plan, if the workflow
builder already declared one (it is authoritative, and overrides the
analyser's guess); then the analyser; then whatever the node already had
— the destination you picked in the assistant's picker, or an earlier
build's. Only when none of those exists is the question asked, and then
it names the choices: a saved connection, a local table, or a local
vector table.

A file connection (a CSV, Excel, Parquet, `.duckdb` or `.sqlite` file
you added) cannot receive a join result. The analyser is shown those
connections under "NOT join destinations". Asked to write into one, it
asks instead of choosing: it says the file can't be the destination,
names where the join writes now, and offers to keep that, use a saved
database, or use `local-duckdb`. `local-duckdb` is a table in the
workflow's own database, not the file. The destination only changes to
one you name.

The operation mode comes from the analysis (`new_table`, `append` or
`merge`, plus `mergeKeys` for merge); on a rebuild that does not mention it,
the node's saved mode is kept. Any other value reads as `new_table`.

**Skills are effectively not part of a join today.** The analyser is
shown the skills whose category covers joins, minus the vector skill —
which is excluded deliberately, because the join engine calls its hooks
itself and its prompts are built for single-source transformer flows. Of
the shipped skills that leaves none, so unless you install one that
declares itself for joins, the list the analyser sees is empty.

## Vector-aware behaviour

When a source or the destination is a vector store, or you mention
embeddings or similarity, the analyser picks a scenario — reading the
request literally, because a vector source on its own does not imply
similarity search:

- **Scenario A — vector store as a regular database.** You want to read
  records (id and metadata fields) and join them on a normal key. No
  embeddings, no search. The step becomes a metadata-only fetch, the rows
  are flattened, and the join proceeds like any other.
- **Scenario B — embedding or similarity search inside the join.** You
  want embeddings to participate in the join logic itself, e.g. "for each
  customer match the five most similar articles". The whole
  embed-search-match flow is expressed inside a JavaScript join function
  that runs in the background engine.

For Scenario B the destination does **no** compute — it is only where the
final rows are written. That is why any destination — a document store, a
vector table, a local table or a SQL database — is a perfectly good one
for it, and why the assistant never
asks you to "switch to a SQL engine that can execute embeddings": no such
engine is required. It asks only what the scenario actually needs — which
column to embed, which vector source to search, an embedding provider and
model if there's a choice, and the top-K.

## SQL or a JavaScript function — `requiresFunction`

Every join is either SQL or a JavaScript function, and the analyser
reports which as `requiresFunction`. It is always **true** — nothing to
decide — for a MongoDB or vector destination (those only join in
JavaScript) and for any Scenario B join. The builder applies those cases
itself, so a reply that leaves the flag false for them changes nothing.

For a SQL database or `local-duckdb` destination it defaults to **false**
and stays false whenever SQL there can do the job. It becomes true only
when it cannot:

- a join key, or a value to keep, sits inside an array or a nested
  document / JSON value and the rows go to a SQL database — a Mongo
  sub-document, a JSON or JSONB column, a nested field in a JSON file;
- the match is something SQL cannot express — fuzzy matching, a per-row
  API or AI call, a rule described step by step.

It follows the data and the destination, never the source's engine: a
Postgres JSONB column needs it as much as a Mongo array, and a flat Mongo
collection needs nothing. `local-duckdb` reads nested values natively
(dot notation, `unnest()`), so nested data alone never needs it there.

Nested data is never reshaped on the user's behalf. Before building a
join over array or nested values — SQL or function — the analyser asks
how they should come out, for example "one row per item, or one row per
order with the items kept as JSON text?", unless the user already said.

The flag is saved on the node, so a rebuild that skips the analyser
builds the same kind of join. A function join that comes back as SQL
fails the build.

## Phase 2 — destination-aware generation

### Relational destination

Per-source reads that load each external source into a temporary table,
plus the final SQL that joins those temp tables and any tables already in
the destination.

- Every per-source `SELECT` ends with a `{LIMIT_OFFSET_HERE}` marker,
  which the executor replaces with the source engine's own pagination.
- The model never writes a destination table name for a source. It writes
  `{{SOURCE_1}}`, `{{SOURCE_2}}`, … (in the per-source DDL and the join
  SQL), and the builder puts in the real name, quoted for the destination:
  the temp table for a staged source, the table itself for one already
  there. A join SQL that skips a source, a DDL that creates some other
  table, or a placeholder that names no source fails the build.
- A source already on the destination still gets a `sourcesConfig` entry
  (just its id) — the builder adds one if the model left it out, because
  that list is also what the staleness checks compare against.
- The column order in the DDL, in the `SELECT`, and in the column list
  must match, because the load is built from that order.
- The DDL's types are the **destination's** types. MySQL and SQL Server
  reject a bare `VARCHAR`; Postgres, DuckDB and Snowflake accept one.
- `targetDdl` is a single `CREATE TABLE` and nothing else — the executor
  has already dropped the target.

### Local destination

The same contract as a relational destination: `targetDdl` is
`CREATE TABLE {{TARGET}} (…)` and the join SQL is
`INSERT INTO {{TARGET}} SELECT … FROM {{SOURCE_1}} …`. Every source is
already readable (a view the executor registers under the placeholder's
name), so no source has a `ddl`; only genuinely remote sources need a read.
`{{TARGET}}` is resolved when the join runs, once the workflow database is
attached.

### Function join into a relational or local destination

When `requiresFunction` is true for a SQL or local destination, neither of
the two contracts above applies. Each source gets only the read that
loads it, nothing is staged, and the model writes a JavaScript join
function and no join SQL. For a SQL destination it also writes a
`targetDdl`: the executor drops the target, creates it, and inserts the
function's rows by column name, so every key the function returns must be
a column and every value a scalar. For a local destination the rows
simply become the node's table.

### Document destination

Per-source fetch operations plus a JavaScript join function that takes
each source's rows as an argument and returns the joined documents.

### Vector destination

Per-source fetches, a JavaScript join function, and a vector-destination
block naming the column to embed, the vector store, the target index or
table, the embedding provider and model, and `idColumn` — the joined
row's primary key the vectors are upserted under (omitted when nothing
qualifies; never chosen just because a column is called `id`). No SQL is
emitted.

## The helper surface for JavaScript joins

A join function receives each source's rows, and a final context object
with the same helpers every AI-generated function in Ternlux sees:
looking up connections, reading any connection or local file with one
call, listing tables and columns, calling the AI, embedding text, making
HTTP requests, and logging. A local store is addressed by its type plus
an absolute path; a saved connection by its name.

## Identifiers and ids

Source ids, table names, column names and the destination are supplied to
the model pre-quoted for the destination's engine and must be copied
verbatim. Engines disagree about bare names — Snowflake folds them up,
MySQL and PostgreSQL down — so a name written by hand is how a join comes
to read an object that does not exist while the same one answers
perfectly to the form it was given.

## Two column lists, deliberately different

- `selectedColumns` records which columns are **read** from each source.
- `targetColumns` records what the joined output **contains**, aliases
  included. Downstream nodes are configured from this one, so a column
  named after its source rather than its alias produces SQL further down
  the pipeline that selects something the result does not have.

## Write modes

`new_table` replaces the target every run; `append` keeps its rows and adds
this run's, creating the target only when it is missing; `merge` is append
whose `joinSql` is a MERGE / upsert on `mergeKeys`. Each destination in the
analyser's list is marked `merge: yes / no` from the connector's own
`mergeSupport` declaration, and merge is chosen only for a "yes" one, with
the key named (else it asks). For merge, the generator is given the
destination's guidance (`destinationConfig.mergeGuidance`) and the keys. The
builder re-checks: no support, a JavaScript join or a document store → one
question, then append. A target that is also one of the join's sources is
refused in `new_table` mode (it would be emptied before it is read) and
allowed in `append` and `merge`.

**Existing target (append / merge).** When the target already exists, the
generator is shown its live columns and primary key
(`destinationConfig.existingTarget`) and returns two extra fields:
`targetSchemaChange: {required, reason}` — required when its statements cannot
run against that table unchanged (a missing column, an incompatible type, a
key that would reject the rows, a merge needing a key the table lacks) — and
`targetPrimaryKey` (the key its `targetDdl` declares, or `[]`). The builder
also compares the structured column lists itself (lib/targetShape: a missing
column, or a different primary key on the live table). Either one records
`joinSettings.targetRebuild`, and the table is dropped and recreated once,
after the user approves (plan-build pause, "Run this node", or the Execute
prompt). The reviewer treats a pending rebuild as expected, not as an issue.
