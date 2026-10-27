# Transformer generation

The transformer templates turn a description of how one source should be
reshaped into the operation that does it. The shape of that operation
depends on the source's engine, the storage location, and the operation
mode.

## Phase 1 — analysis

The source's columns and a few sample rows are re-read first (unless the
upstream is a transformer or join, which declares its own output shape).
Without columns the analyser would invent them, so a source that still
has none becomes a question — "which table or collection should it
transform?" — rather than a guess.

The analyser then reads the request against that schema and settles:

- **Operation mode** — `new_table` or `in_place`. Never inferred beyond
  what the request says; if it is ambiguous, that becomes the question.
- **Storage location** — `database` (the source's own connection) or
  `local`. Not asked at all when the source is already local (a file, a
  REST API source, or another node's local output) — that is always
  `local`. When it is
  `local`, the operation mode is forced to `new_table` — you cannot
  update a remote database in place while storing the result locally.
- **Target name** — the table or collection the result is called. If you
  named one, it is used verbatim, stripped of any schema qualifier (the
  schema is its own field). If you didn't, the analyser coins a short
  snake_case name describing what the result *contains* —
  `denied_stores`, `orders_2024` — because that name becomes the node's
  label on the canvas. The app then adds the last 6 digits of the node's
  id (`denied_stores_713683`), so a coined name never collides with
  another node's table or with one already in the destination database.
  A rebuild keeps the node's existing name unless you give a new one. For
  `in_place` there is no name to coin: the result goes back to the source.
- **Skill choice** — whether a skill (Python, JavaScript, vector
  operations) fits better than plain SQL or document operations.

There are exactly two outcomes: `generate_transformation`, or
`ask_questions` with what it needs — and routing to a skill counts as
building. Anything else is treated as a question, so a reply the
analyser did not intend as an approval can never be saved as a finished
node.

It only asks about settings the request left genuinely open, and never
about output formats or steps beyond this single transformation. Where
several settings are unclear it can raise them together, as one question
listing each.

What it does **not** re-decide is the node's identity. The output
table's name is kept across a refinement — downstream nodes were built
to read it — unless the analyser explicitly names a new one, which is
how a rename is asked for. A full rebuild (you gave a new instruction)
takes the analyser's settings as they stand; a cascade rebuild (an
upstream's shape moved, with no new instruction) keeps the node's own.

## Phase 2 — generation

### Local sources (DuckDB)

A source is local when it is a file or another node's table. Both modes
read the source by name — a file by its own name, an upstream node's
table by the table's name, and a file staged for an in-place update by a
per-node staging name that the template and the executor derive the same
way.

- **New table** — one `SELECT` that produces the transformed result. No
  `CREATE TABLE`, no `INSERT`: the rows the `SELECT` returns *become* the
  table. The target is replaced wholesale on every run, so the `SELECT`
  always describes the whole table — nothing is merged, de-duplicated, or
  filtered out "because an earlier run handled it".
- **In place** — the `ALTER` / `UPDATE` / `DELETE` statements that make
  the change, separated by semicolons and run as one unit. Adding a
  column and populating it is the common two-statement case. A `SELECT`
  is explicitly not acceptable: it changes nothing while reporting
  success.

Both replies carry an explanation, a preview `SELECT` limited to 100
rows, and `targetColumns` — the columns the result actually has, aliases
included, because downstream nodes are configured from that list. For an
in-place change that leaves the shape alone, `targetColumns` is `*`.

The templates also carry the DuckDB specifics the model needs: it is
PostgreSQL-flavoured with `SELECT * EXCLUDE`, `REPLACE`, `QUALIFY` and
`GROUP BY ALL`; nested values read as `STRUCT`, `LIST` or `MAP` and are
reached with dot notation, 1-based indexing and bracket-by-key
respectively; and a nested field cannot be assigned to — the whole value
has to be rebuilt with its siblings carried forward.

### Remote sources

Every other engine's prompt comes from its own connector, so what is
generated follows that dialect:

- **New table in the same database** — a `CREATE TABLE`, an
  `INSERT INTO … SELECT`, and a preview query. The executor drops the
  target first, so the DDL never has to.
- **New table stored locally** — a `SELECT` that runs on the source
  through its connector; the rows are streamed into the local table.
- **In place** — an `ALTER TABLE`, an `UPDATE` / `DELETE`, or both.
  Filtering intent like "keep only X" becomes a delete of the rows that
  don't match.
- **Document source** — an aggregation pipeline, a filter, an update, a
  delete, or a JavaScript transformation, whichever fits; in-place
  JavaScript is applied in batches.

## Statement rules

- Each SQL field is handed to the driver as **one statement**.
  Multi-statement strings and transaction wrappers are not supported —
  transactions are the executor's concern. The exception is an in-place
  transform on local DuckDB storage, where semicolon-separated statements
  are expected.
- At most one structural statement and one data statement per node. A
  node with only a data statement is the normal shape for an in-place
  change whose columns already exist.
- DDL is not written defensively. A second run's `ADD COLUMN` failing
  with "column already exists" is handled by the executor, which lets the
  data statement decide the node and reports the skipped statement as a
  warning.

## Output

Every reply is a single JSON object carrying the operation, a short
plain-language explanation (which may use `**bold**` and `\n`), a
preview query the editor uses to show a sample, and the target column
list.
