# 52-edge-messy-column-names

**Area:** column names with spaces, dots, symbols, reserved words, unicode, emoji, 70 characters, duplicates and blanks: through outputs, transformers and joins (R12)
**Uses:** `E2E edge names`, `employees`; Postgres, mysql, mssql, snowflake, Google Bigquery, mongo
**Cost:** about 4 AI builds
**Requires:** 50

## Part 1 — Output to every destination
Workflow `E2E Edge Names`: Data Source `E2E edge names` → Outputs (Truncate & insert):
Postgres `e2e_edge_names`, mysql `e2e_edge_names`, mssql `dbo.e2e_edge_names`,
snowflake `e2e_edge_names`, BigQuery `ternlux.e2e_edge_names`, mongo
`e2e_edge_names`, and local **Avro**, **Parquet** and **Excel** files under
`~/Desktop/Sample_data/e2e/edge/out/names.<ext>`.

Run each. For each destination record: success, or the exact error; and the
column names as stored (Data Explorer column list). Known engine limits a good
result handles clearly, by renaming or a clear refusal:
- Postgres truncates names at **63** characters, MySQL at **64**. Does the 70-char column still load, and can it be read back?
- BigQuery doesn't allow `.` or `$` in column names.
- MongoDB treats a dot in a field name (`e.mail`) as nesting.
- Avro allows only `[A-Za-z_][A-Za-z0-9_]*` (**R12**).
- SQL Server and MySQL: `order`, `select` and `user` must be quoted.

## Part 2 — Transformer using the odd names
1. Postgres `e2e_edge_names` → Transformer: *"New table e2e_edge_names_sum in
   this database: total of "Amount ($)" for rows where "order" is greater than 5,
   grouped by "名前"."* → one row, **4500**.
2. Same request on Data Source `E2E edge names` (local) → **4500**.

## Part 3 — Join on an odd-named column
`E2E edge names` + `employees` (CSV) → Join, local destination: *"Left join on
"1st_col" = the number in employee_id (EMP-001 → 1). Keep "first name",
"🚀 launch", employee name."* → **30** rows; rows 1–20 have an employee name.

## Checks
- [ ] Part 1: per destination, loaded or clearly refused; names as stored recorded; the 70-char name survives somewhere readable
- [ ] Part 2: 4500 on both
- [ ] Part 3: 30 rows, 20 matched
- [ ] No generated SQL fails on quoting (reserved words, spaces, unicode)
- [ ] No renderer console errors or main-process errors
