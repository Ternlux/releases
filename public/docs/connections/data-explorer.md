# Data Explorer

The Data Explorer is a worksheet-based query workspace for a saved
connection. You browse the schema on the left, write statements in the
middle, and read results below — the same kind of tool as a standalone
database client, built into Ternlux so you don't have to leave the app to
look at your data.

Open it from the **Connections** tab: pick a connection and choose
**Explore DB** (or just click the card). It opens in a panel over the
connections list.

The Explorer needs the desktop app. Connections are made by the local
background engine, so outside the desktop app the panel shows a notice
instead of a schema tree.

## Which connections can be explored

- Every **database** connection whose connector can list tables, list
  columns, and run queries — which covers every relational and document
  database Ternlux ships a connector for.
- Every **local file** connection: a CSV, JSON, Parquet, Avro or Excel
  file read in place, and a `.duckdb` or `.sqlite` file attached as the
  real database it is. File connections keep their quicker **Preview
  Data** action as well.

Vector stores (including a local LanceDB directory), cloud storage and
REST API connections have no Explore action. Those have their own paths:
vector indexes are read through the vector skill, cloud objects through
the storage browser, and REST endpoints through the generated fetch
function on a Data Source node.

## Worksheets

The editor is a notepad of worksheets, not a single box. You can keep
several open per connection, and they are saved as you type — reopening
the connection restores exactly the sheets you were working on. Each
connection has its own set.

## The object panel

The left panel loads as soon as the Explorer opens, with a refresh button
for when the database changes underneath you.

It lists what the connection can see: containers, and the tables, views
and collections inside them, grouped by kind and counted. What a
container is called follows the engine — *Schema* on PostgreSQL, SQL
Server and Snowflake, *Database* on MySQL, MongoDB and local files,
*Dataset* on BigQuery — and so does what its contents are called
(*Table*, or *Collection*).

- The schema the connection itself owns starts expanded. For a local
  file, sibling connections are listed too — so you can join across them
  — and those start collapsed.
- **Clicking** a table expands its columns inline: name, type, and a
  marker on primary keys. **Double-clicking** it opens a new worksheet
  with a preview of its first 100 rows, written in the connector's own
  preview syntax and quoted the way that engine expects.
- The filter box searches every object in the connection; while it has
  text the tree is replaced by a flat list of matches, so a deep object
  is one click away.
- Objects can be starred into a Favorites section, and the panel also
  lists your open worksheets for this connection.

If a listing comes back empty, the connector's own message is shown
rather than a bare "none found". A refresh keeps the tree it already has
while it reloads; only a first, cold load shows a skeleton.

## Writing statements

The editor knows the connection's dialect. It offers:

- **Schema-aware autocomplete** — objects in the selected container
  first,
  then the columns of whichever table the caret is talking about, then
  the engine's own keywords and functions. Columns are fetched once per
  table and cached, so typing never waits.
- **Advisory syntax checking** — SQL is parsed against the engine's own
  grammar, and a document store's query is parsed as the shell syntax you
  actually type. Findings are marked *error* (confidently malformed) or
  *warning* (unparseable, possibly just unmodelled syntax) and never
  block Run: no parser models 100% of any vendor's grammar.
- **Formatting**, on demand.

### Document stores

For MongoDB the editor speaks **shell syntax** — what you would type in
`mongosh`. Selecting a collection pre-fills a preview you could have
typed yourself:

```javascript
db.orders.find({}).limit(100)
```

The whole call surface is available — `find`, `aggregate`, `count`,
`distinct`, the insert / update / delete family, `bulkWrite`, index and
database commands — along with the trailing `.sort()`, `.limit()`,
`.skip()` and `.project()` chain, and the shell constructors
(`ObjectId(…)`, `ISODate(…)`, `NumberLong(…)`). Autocomplete covers the
methods, pipeline stages, query and update operators, and accumulators.
Syntax checking parses the statement exactly the way running it would,
so what it rejects is what the driver would reject.

A connector that doesn't supply its own preview falls back to a plain
query document (`{ "collection": …, "filter": {}, "limit": 100 }`).

## Running a statement

Press **Run**, or `Cmd/Ctrl+Enter`. Exactly one block runs: the text you
have selected, or otherwise the statement the caret sits in. Splitting is
quote- and comment-aware, so a `;` inside a string or a comment never
ends a statement.

**Statements execute immediately.** There is no preview, no approval, and
no confirmation. Whatever runs is sent to the database exactly as
written, using that connection's credentials. If it modifies or removes
data — `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER` — it does so the
moment you run it, and Ternlux cannot undo it. The statement is executed
**exactly once** on every path: nothing here classifies it by its text,
and nothing is retried.

This is deliberate: the Explorer is a direct client, not a guided
builder. It behaves differently from the chat assistant, whose query tool
is read-only and whose generated operations are shown to you before they
are saved or run. Two habits are worth keeping:

- **Read before you write.** Start from the pre-filled preview, narrow it
  until the rows are the ones you mean, and only then turn it into a
  change.
- **Scope the credential.** If a connection only ever needs to read,
  create it with a read-only database user. That puts the limit in the
  database, where it holds regardless of what gets typed into an editor.

### Local files

A file connection accepts `INSERT`, `UPDATE`, `DELETE` and `ALTER` too,
even though no file format supports changing a row where it lies. The
statement is run first; if it fails — which is what DuckDB does when
asked to write to a file, since files are exposed as read-only views —
the target is worked out and the statement runs against a copy, which is
written back over the original in its own format. The write goes to a
temp file and is renamed into place, so a failure leaves the file as it
was.

Two consequences worth knowing:

- **The file is rewritten, not edited.** A CSV comes back with the
  quoting and formatting DuckDB writes, which is not necessarily
  character-for-character what was there before. Only the file the
  statement actually changed is rewritten.
- **Any attached file, not just the one you opened.** Other local files
  are attached so you can join across them — and you can write to them
  too.

### Local databases

A `.duckdb` or `.sqlite` file behaves like a real database, because it is
one. Its tables are attached and addressed where they live, so `UPDATE`,
`INSERT`, `DELETE` and `ALTER` run natively — nothing is copied and no
file is rewritten. SQLite goes through DuckDB's `sqlite` extension, which
it fetches the first time and caches per machine; that one moment needs
a network connection, and everything after it is local. (The Excel and
Avro extensions ship with the app, so those never wait on a download.)

Several databases can be open at once and joined to each other, and to
CSV/JSON/Parquet files, in a single statement.

## Reading results

The result area reports how many rows came back, then renders them as a
grid, or as formatted JSON for document results and rows holding nested
objects — you can switch between the two, and it picks the sensible
default for the result in hand. Nulls are shown as a distinct `NULL`
rather than an empty cell. You can select and copy cells, inspect a
focused cell or a whole row, and export the result as CSV or JSON. A
result can be pinned, so later runs happen behind it instead of
replacing it.

A run returns at most **5,000 rows**, and the cap is applied by the
driver — no `LIMIT` is appended and nothing is wrapped in a subquery, so
the statement the engine runs is the statement you wrote.

If a statement fails, the database's own error message is shown and your
text is left alone so you can correct it and run again.

## History

Every statement you actually run is kept, per connection — the most
recent 500 — and opens as a second tab beside the results. Loading one
puts it back in the editor.

Explorer statements are ad-hoc: they are not part of a workflow and do
not create entries in the execution history. Only workflow runs are
recorded there.

## What leaves your machine

The statement goes from the background engine to the database the
connection points at. Results come back to your machine and are
displayed.

Nothing goes to Ternlux, and the Explorer makes **no AI calls at all** —
statements you write here and the rows they return are not sent to any AI
provider. The one exception is deliberate and visible: while the Explorer
is open, the worksheet you are looking at is offered to the chat
assistant as context, so you can ask about the query in front of you.

## Related

- [Connections](README.md) — what a connection holds and how forms are
  built
- [Credentials and authentication](credentials-and-auth.md) — how the
  secret part of a connection is stored and used at query time
- [Transformer generation](../chat-prompts/transformer.md) — the guided,
  preview-before-save path for generating an operation instead of writing
  it yourself
