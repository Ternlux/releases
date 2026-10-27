# Shared reference for the edge-case scenarios (50–60)

<!-- Starts with "_", so it is never run on its own. Read it, plus _DATASET.md
     (naming, 👤 steps), before running any 5x/60 scenario. -->

## Fixtures

Built by `python3 testing/e2e/fixtures/make_edge_fixtures.py` into
`~/Desktop/Sample_data/e2e/edge/`. The script is deterministic and writes the
exact expected answers to `EXPECTED.json` next to the files. **Read that file
for any number not given in a scenario.** Never work out expectations from the app.

| File | Connection name to create (👤 once) | What's inside |
|---|---|---|
| `edge_values.csv` | `E2E edge values` | 200 rows of messy but valid **values**: unicode cities (São Paulo, 東京, القاهرة…), ZWJ emoji and flags, quotes, commas, embedded newlines, apostrophes, padded text, backslashes, leading-zero zips (`02947`), decimals, dates, a DST-edge timestamp, empty cells (66), "12.5%" strings, and a **prompt-injection** sentence in `note` (33 rows). UTF-8 **BOM** and **CRLF** line endings |
| `edge_names.csv` | `E2E edge names` | 30 rows, 15 messy **column names**: `first name`, `e.mail`, `Amount ($)`, `order`, `select`, `user`, `Ünïcødé`, `名前`, `🚀 launch`, `1st_col`, `MixedCase`, a **70-character** name, `dup` twice, and an empty header |
| `edge_nested.json` | `E2E edge nested` | 500 records nested **8 levels** deep, arrays of objects with arrays inside, `promo` **null for records 1–300** then an object, `mixed` alternating string and object, empty `{}` and `[]` |
| `edge_nested_big.json` | `E2E edge nested big` | The same shape, **120,000** records, about **56 MB** |
| `edge.sqlite` | `E2E edge sqlite` | 11 tables: `keys_left` / `keys_right` (join-key traps), `empty_table`, `trap_int32`, `trap_late_long`, `trap_late_mixed`, `trap_late_bool`, `trap_bigint`, `sparse_late`, `wide_150` (150 columns), `very_wide_1100` (1,100 columns) |
| `edge_book.xlsx` | `E2E edge book` | Sheets `Sales 2024` (merged title row **above** the header), `数据` (unicode sheet name), `Empty` (no rows), `Dates & %` (real Excel date-times and percent cells) |
| `o'brien data (1) ✓.csv` | `E2E edge quirky` | `stores` again (5 rows), but the **file name** has an apostrophe, spaces, parentheses and ✓ |

How DuckDB itself reads them, checked with the app's own engine; anything different in the app is the app's doing:
- `edge_names.csv` columns come out as … `dup`, `dup_1`, `column14` (the empty header).
- `edge_values.csv`: `zip` is **VARCHAR** (leading zeros kept), `created_at` is `TIMESTAMP WITH TIME ZONE`, 66 nulls, 34 notes contain a newline.
- `edge_nested.json`: nested STRUCTs, `items` is a STRUCT list, `mixed` is JSON, `promo` non-null in **200**. The big file loads in about 0.25 s in plain DuckDB.

## Sacrificial tables

Destructive tests run only on these, seeded fresh at the start of the
scenario that uses them, as Output `stores` → Postgres with **Truncate & insert** (5 rows each):
`e2e_victim_join`, `e2e_victim_tx`, `e2e_victim_out`.

## Risks found by reading the code (confirm or refute each)

| # | Where | Expected bug if it's real |
|---|---|---|
| R1 | Output, same connection, source = destination table, **Truncate** (`outputExecutionHelpers` same-connection copy) | Truncates the table, then copies from the now-empty table: **all rows lost**, reported as success |
| R2 | Join with a SQL destination whose **target name = one of its input tables** (`NodeExecution` drops the target before the join SQL) | The input is dropped, so the join fails or produces 0 rows, and **the input table is gone** |
| R3 | Transformer "new table" whose target = its own source name | Same: the source is dropped |
| R4 | Output column types are inferred from the **first 100 rows** | A text value after row 100 that's longer than the inferred `VARCHAR(255)`, or "N/A" in a column that looked like integers, or "yes" in a column that looked boolean, fails mid-load. Check **what was already written** |
| R5 | Integers map to 32-bit `INTEGER`/`INT` on Postgres, MySQL and SQL Server | 10-digit phone numbers and epoch-ms values fail with "out of range" |
| R6 | Numeric-looking strings are inferred as numbers | Leading-zero zips (`02947`) arrive as `2947` in SQL outputs; 19-digit ids lose precision (`…993` → `…992`) |
| R7 | SQL Output takes its **column list from the first row** | A field missing from the first document (Mongo, heterogeneous) is silently **dropped** |
| R8 | The plugin catalog has **no uninstall in the UI**; the internal uninstall deletes `plugins/connectors/<id>` next to the app code | In the dev build that is the **repo's** folder. Never call it. Just report that there's no UI |
| R9 | Join staging tables are named from source node ids | Two copies of one imported workflow, run at the same time into the same destination, use the **same staging table names** |
| R10 | MySQL row-size limit (65,535 bytes) | `wide_150` (150 × `VARCHAR(255)` at 4 bytes per character) fails with "Row size too large" |
| R11 | SQL Server allows at most 1,024 columns | `very_wide_1100` fails, and the message should say why |
| R12 | Avro field names must be `[A-Za-z_][A-Za-z0-9_]*` | `edge_names` → Avro fails or renames columns. Either is fine **if clearly reported** |

## Verdict per check
Record each as PASS / FAIL / BLOCKED. When a risk is confirmed, quote the
exact error and say whether **data was lost or partly written**: that decides
the severity (data loss = blocker).
