# Join node

A Join node merges data from two or more upstream sources. It has no
configuration form: you wire two or more sources into it, select it, and
describe in the chat assistant how they should be combined.

## Required information

Before generating the join, the assistant insists on:

- **The exact column relationships between every pair of tables.** Even
  if two columns are obviously named the same, it asks for confirmation.
- **The join type for every pair** — inner, left, right, or full outer.
  Never inferred from column-name similarity.
- **The columns to keep** in the final result, per source (`*` means all
  of that source's columns).
- **A target table or collection name**, always — a join creates the
  object it writes.

It asks one question at a time, building on what you've already said, and
only generates when it is certain from your explicit statements. How
involved the join is — several stages, a filter between them, a
de-duplication pass — is never by itself a reason to ask: the generated
SQL, or the JavaScript function for a document destination, can express
any number of stages.

The two sources must be two **distinct** nodes. The same node listed
twice is rejected, and a source is never added just to reach two.

Every input must name the table it contributes. A data source whose
table — or, for cloud storage, whose file — was never picked is
unfinished: the join is not built on it, and a run stops at that node
with a message naming it, rather than failing later on a missing table.

## Write modes: replace, append or merge

A join has three write modes (`joinSettings.operationMode`):

- **Replace** (`new_table`, the default) — every run rebuilds the target
  from this run's rows: the target is dropped, the generated
  `CREATE TABLE` runs, then the `INSERT`. A document store drops the
  collection first.
- **Append** (`append`) — the target keeps its rows and this run's rows are
  added. The `CREATE TABLE` runs only when the target does not exist yet
  (checked in the destination's catalog), and nothing is ever dropped.
- **Merge** (`merge`) — like append (created only when missing, never
  dropped), but the generated statement is the destination's MERGE or
  upsert on the key column(s) in `joinSettings.mergeKeys`: rows whose key
  exists are updated, the rest inserted. Offered only where the destination
  connector declares **merge support** (every SQL connector, and local
  DuckDB); the model gets that connector's own guidance for writing it. On
  MySQL the upsert needs a PRIMARY KEY on the key, which the generated
  `CREATE TABLE` declares — a table that already exists without one gets
  duplicates instead of updates. A JavaScript join, a document store or a
  destination without merge support is asked once and built as append.

Replace and append work on every table destination, on a document store and
on a **vector destination**: replace leaves the store holding exactly this
run's records (a LanceDB table is rewritten; a Pinecone namespace is emptied
first, the index and its other namespaces kept), append upserts by id and
keeps the rest. Merge on a vector store is append — records are matched by id. Ask the assistant to switch ("append mode", "merge on customer_id");
a refinement that does not mention the mode keeps it.

To add only the rows that aren't already there without updating any, use
append with an anti-join: the target is readable, so the join can LEFT join
it on the identity column and keep the rows with no match.

**When the table already there no longer fits.** Append and merge write
into whatever table exists, so the builder first reads that table's columns
and primary key from the destination's catalog (lib/targetShape, the same
lookup the Output node uses) and shows them to the generator. If the join's
output cannot go into it unchanged — a column it lacks, a type that cannot
hold the values, or a primary key that would reject the rows (typically a key
an earlier **merge** created, left behind when the join is switched to
**append**) — the node records `joinSettings.targetRebuild`: the reason, the
row count, and the `CREATE TABLE` it needs. The table is then **dropped and
recreated once**, and only with your approval:

- in a workflow-builder plan, the build pauses on an approval card (like an
  API call it has to run) — approving records it on the node; "Don't run"
  stops the build and saves nothing;
- from the node's own chat, the "Run this node" card names the table and its
  row count — Run is the approval;
- on the canvas, Execute lists every such table first ("Drop, recreate and
  run" or Cancel);
- a run started by a trigger is refused, and nothing is touched.

Before dropping, the run reads the table again: if it already fits (or is
gone), nothing is dropped and the flag clears. After the one recreate, the
join appends or merges as usual. An approval is bound to the exact
`CREATE TABLE`; rebuilding the node with a different one asks again.

The node card and the Details tab show the write mode as **New table**,
**Append/Merge** (with which, and the merge key) or, for a transformer,
**Modify in place**; a pending recreate is marked on both.

**A target that is also a source.** In replace mode the target would be
emptied before the join reads it, so the builder refuses it ("write to a
different table, or ask for append mode") and the executor refuses to run
it. In append and merge mode it is allowed — the target is never dropped.

## Picking the destination

A Join can't be configured at all until it knows where its result goes —
the destination decides the SQL dialect, whether sources have to be
staged, and where the output lands. So selecting a Join with no
destination puts a picker in front of the conversation. You can also just
name the destination in the chat.

The picker lists only connections a join can write to — databases (SQL
and MongoDB) and vector stores — grouped by category and de-duplicated,
so you never see the same connection twice. Cloud storage and API
connections have no table to create, and a local file connection is not
written to, so none of those are offered, and naming one in the chat or
in a plan is refused with the list of real destinations. Alongside your saved connections
there is one local option, which writes the joined rows as a table in the
workflow's own DuckDB database.

A plan built by the workflow builder, or a destination you name in the
chat, can also target a **local vector table** (`local-lancedb`), which
is what a similarity join needs when you have no saved vector connection.
Naming a local vector table is never collapsed into the local DuckDB
option.

## Destination types

### Relational destination

Ternlux makes the destination database the venue of the join. A source
that already lives on the destination connection is read **in place** —
no copy, no staging. For every source that doesn't, Ternlux creates a
temporary table inside the destination, loads that source's rows into it
in batches, and then runs the AI-generated join SQL against the temp
tables and the tables already living there. The temp tables are dropped
when the join finishes.

Each temp table is named after its source node. The AI writes it as a
placeholder (`{{SOURCE_1}}`), and Ternlux puts in the real name, already quoted
for the destination's dialect, in both the DDL and the join SQL — so
the table the `CREATE` makes and the table the load writes to are the
same object on every engine. The DDL's column types are the
*destination's* types, not the source's: MySQL and SQL Server reject a
bare `VARCHAR`, where Postgres, DuckDB and Snowflake accept one.

### Local destination

The workflow's own DuckDB database is the venue. Local files are read
where they lie — SQLite files included, attached through DuckDB's sqlite
extension, never copied — and an upstream node's output is already a
table in that database. Only genuinely remote sources are pulled across, and those are
staged as tables in the same database. The generated SQL follows the same
contract as a SQL database — `CREATE TABLE {{TARGET}}` plus
`INSERT INTO {{TARGET}} SELECT …`, with each source written as
`{{SOURCE_n}}` (a view the executor registers) — and the staging tables and
views are dropped afterwards whether the join succeeded or not.

### Document destination

Ternlux loads every source's rows into memory in the background engine,
then runs an AI-generated JavaScript join function over them. The
function's return value (an array of joined documents) is bulk-inserted
into the destination collection, which is dropped first. A function that
is missing, does not compile, or returns anything other than an array
fails the join — it never empties the collection and reports success.
Any `_id` a
source document carried is stripped — it names a document in *its own*
collection, and two Mongo sources can collide with each other on it.

This is what lets Ternlux join data that lives in entirely different
systems — a relational source with a document source, for example — into
a single collection.

### Vector destination

Like a document destination, with one additional step: after the join
function produces the joined rows, Ternlux delegates to the
[Vector Database Executor](../plugins/skills/vector-db-executor.md)
skill, which embeds the column you nominated and **upserts** the
resulting vectors: each record is written under the join's `idColumn`
(the joined row's primary key, chosen by the builder), else a hash of the
embedded text, so a re-run replaces the records it wrote instead of
adding copies. Records nothing writes any more are not removed — to
rebuild the index from scratch, end the pipeline in an Output with
*Truncate & insert*. The rest of each row is preserved as metadata for Pinecone, or
as flat columns for LanceDB.

## Vector sources

If one of your sources is a vector store, the assistant decides between
two intents — and reads the request literally, because a vector source on
its own does not imply similarity search:

- **Scenario A — read the vector store as a regular database.** Records
  are pulled with an optional metadata filter, and the id and metadata
  fields are flattened into row-shaped objects (the vector itself is
  dropped, being useless as a join key). From there the join is treated
  like any other.
- **Scenario B — similarity search participates in the join.** For
  example, "for each customer, find the five most similar articles".
  Ternlux generates a JavaScript join function that embeds the driving
  values once per unique value, then performs per-row similarity searches
  against the vector source.

A Scenario B join is always a **JavaScript** join, whatever the
destination — no SQL engine here can call an embedding model. The same
holds for any join SQL on its destination cannot express, such as
matching on values inside arrays or nested documents written to a SQL
database; see `requiresFunction` in the join generation docs. Nested
values are never reshaped without asking you how they should come out. The
function runs in the background engine and its rows are written to the
destination: inserted into a collection, embedded into a vector store,
written as this node's table in the workflow's DuckDB database, or
inserted into a SQL table created from the generated `CREATE TABLE`. For
a SQL destination every key the function returns must be a column of
that table, and values must be flat. A Scenario B join that comes back
as SQL fails the build rather than running as a plain key join with the
similarity step missing.

The vector skill is excluded from the skill list the join builder can
route through: the join engine invokes those hooks itself when the
request needs them. Since it is also the only shipped skill whose
category covers joins, a join is always built by the join template —
as SQL, or as a JavaScript join function — and never handed to a skill.

## Reading sources in pages

Each external SQL source is read in chunks. The generated read carries a
`{LIMIT_OFFSET_HERE}` marker that the executor fills with the pagination
the SOURCE engine speaks — `OFFSET … FETCH NEXT` for SQL Server,
`LIMIT … OFFSET` elsewhere — so a large source loads a page at a time
without the query being rewritten per dialect. Local sources are read
directly by DuckDB rather than paged.

## When the sources change under the join

A join step records the connection, the table, the read SQL, the temp
table and its DDL — all generated together, for one specific source.
Three things leave that set behind, and all three are refused rather than
run:

- A source **re-pointed** at another table or connection. The re-point
  passes move the identity and deliberately leave the SQL alone.
- A source **disconnected or deleted**, whose step the SQL still names
  and whose connection the step still carries — so the run would go on
  reading a source that is no longer part of the workflow.
- A source **added** that the generated SQL has never heard of, which the
  run would ignore while reporting success.

The node is marked and the join refuses to run, naming what changed. Only
rebuilding the join clears it: nothing else regenerates the statements.

A source whose **columns** changed but whose table is the same is
refreshed silently — the step still reads what it names.

## Persistence across reopens

The node keeps the full join configuration — destination, target name,
per-source temp tables and reads, join SQL or JS function — and the
conversation that produced it, so reopening it restores everything you
have decided.
