# 51-edge-messy-values-everywhere

**Area:** messy values written to every destination and read back; type-inference traps (risks R4, R5, R6)
**Uses:** `E2E edge values`, `E2E edge sqlite`; Postgres, mysql, mssql, snowflake, Google Bigquery, mongo
**Cost:** none (no AI builds)
**Requires:** 50

## Part 1 — Round trip of valid messy values
Workflow `E2E Edge Values Out`: Data Source `E2E edge values` → one Output per
destination, all **Truncate & insert**:

| Destination | Target |
|---|---|
| Postgres | `e2e_edge_values` |
| mysql | `e2e_edge_values` |
| mssql | `dbo.e2e_edge_values` |
| snowflake | `e2e_edge_values` |
| Google Bigquery | `ternlux.e2e_edge_values` |
| mongo | `e2e_edge_values` |
| local JSON / Parquet / Avro / Excel (sheet `values`) / SQLite (table `values`) | `~/Desktop/Sample_data/e2e/edge/out/values.<ext>` |

Run. For each destination, check in the Data Explorer (or python3 for JSON and
SQLite), comparing with `EXPECTED.json` → `edge_values.csv`:
- 200 rows; 66 empty `maybe_null` (empty or NULL; note which)
- id 13: `zip` = `02947` (**R6**: leading zero kept?)
- the 6 cities are byte-exact: `SELECT … WHERE city = '東京'` → 34
- emoji intact, including the family 👨‍👩‍👧‍👦 and 🇺🇸 (MySQL needs utf8mb4; SQL Server needs NVARCHAR)
- a newline note is still one value with the newline; `O'Brien's order` keeps its apostrophe
- `amount` sum = **2050.00** (no float drift beyond 2 decimals)
- `created_at` id 3 is the same instant as `2024-03-10T02:30:00-07:00` (note how the time zone was handled)

## Part 2 — Trap tables, one Output each to Postgres
Workflow `E2E Edge Traps`: for each trap table in `E2E edge sqlite`, Data Source →
Output → Postgres `e2e_<table name>`, **Truncate & insert**. Run **each Output node on its own**.

| Source table | Risk | A pass looks like | Record |
|---|---|---|---|
| `trap_int32` | R5 | 20 rows, `phone` values exact (5550000001…) | the error if it fails ("out of range") |
| `trap_late_long` | R4 | 150 rows, row 130 has all 400 characters | the error; **how many rows were written before it** |
| `trap_late_mixed` | R4 | 150 rows; `code` is text; row 150 = `N/A` | the error; rows written |
| `trap_late_bool` | R4 | 150 rows; row 140 = `yes` | the error; rows written |
| `trap_bigint` | R6 | 5 rows; `9007199254740993` and `9223372036854775807` exact; `12345678901234567890` kept as text or refused clearly | the values as stored |
| `sparse_late` | – | 200 rows, `extra` not null in **50** | – |

Repeat the **failing** ones against `mysql` and `snowflake` (one Output each),
to see which engines share the failure.

## Part 3 — Partial-write check
For every failed Output in Part 2: COUNT the destination table. If it holds some
rows from a run that reported **failure**, say so and how many. A half-loaded
table after a failed run is a separate **major** bug.

## Checks
- [ ] Part 1: each destination round-trips the values (list any engine and column that didn't)
- [ ] Part 2: each trap passes, or fails with a clear message naming the column and value
- [ ] Part 3: no destination is left half-written by a failed run (or the run says exactly what it wrote)
- [ ] No renderer console errors or main-process errors
