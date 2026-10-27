# 30-cross-connection-joins

**Area:** joins between different connection types, into every destination type
**Uses:** the `e2e_*` tables seeded by scenarios 10–15, local CSVs
**Cost:** about 12 assistant builds
**Requires:** 10, 11, 12, 13, 14 and 15 have run (Part 1 of each at least, plus
Part 2 step 1 for `e2e_products_premium` on Snowflake). A join whose inputs are
missing is BLOCKED, not failed.

`e2e_stores` locations may be upper case (Recipe D Part 2 changed them), so
compare locations ignoring case.

## How to build each join
Preferred: one message to the workflow builder in a new chat, for example:

> *"Build a workflow named E2E X1 that joins e2e_employees from the Postgres
> connection with e2e_stores from the mysql connection on store_id (inner
> join), keeps all employee columns plus location, and writes a new table
> e2e_x1 on mysql."*

Fallback if the builder can't: in the editor, add the two Data Sources and a
Join, select the Join, and say the same thing in its chat. Report that the builder failed.

## The joins

| # | Left | Right | Type / key | Destination (kind) | Target | Expect |
|---|---|---|---|---|---|---|
| X1 | Postgres `e2e_employees` | mysql `e2e_stores` | inner, store_id | mysql (SQL) | `e2e_x1` | **20** |
| X2 | mysql `e2e_products_store` | mssql `dbo.e2e_products` | inner, product_id | mssql (SQL) | `dbo.e2e_x2` | **108** |
| X3 | mssql `dbo.e2e_employees` | snowflake `e2e_stores` | inner, store_id | snowflake (SQL) | `e2e_x3` | **20** |
| X4 | snowflake `e2e_products_store` | BigQuery `ternlux.e2e_products` | inner, product_id | BigQuery (SQL) | `ternlux.e2e_x4` | **108** |
| X5 | BigQuery `ternlux.e2e_employees` | mongo `e2e_stores` | inner, store_id | mongo (document) | `e2e_x5` | **20** docs |
| X6 | mongo `e2e_products` | Postgres `e2e_products_store` | inner, product_id | Postgres (SQL) | `e2e_x6` | **108** |
| X7 | local CSV `employees` | Postgres `e2e_stores` | inner, store_id | local DuckDB | `e2e_x7` | **20** |
| X8 | local CSV `products` | mongo `e2e_products_store` | inner, product_id | local DuckDB | `e2e_x8` | **108** |
| X9 | Postgres `e2e_products_store` + mysql `e2e_products` + local CSV `stores` | 3-way, then total price per location | – | local DuckDB | `e2e_x9` | Phoenix **7439.05**, LA **1640.20** |
| X10 | mssql `dbo.e2e_products_store` | snowflake `e2e_products_premium` | **left**, product_id | Postgres (SQL) | `e2e_x10` | **108**, 68 without a price |

Join types (X10): in the X10 Join's chat, refine one step at a time and re-run after each:
1. *"Make it an inner join."* → **40**
2. *"Make it a full outer join."* → **108**
3. *"Keep only the products_store rows that have no premium match."* (anti-join) → **68**

## Append and merge across connections (added 2026-10-05)
Run after X1–X10 have passed. Change the mode in each Join's own chat; run twice after each change.

| Join | Message in its chat | Run 1 | Run 2 | Then |
|---|---|---|---|---|
| X1 (mysql) | *"Switch to append mode."* | **40** | **60** | *"Back to replace mode."* → **20** |
| X5 (mongo) | *"Switch to append mode."* | **40** docs | **60** | *"Back to replace mode."* → **20** |
| X7 (local) | *"Switch to append mode."* | **40** | **60** | *"Back to replace mode."* → **20** |
| X6 (Postgres) | *"Merge on store_id and product_id instead of replacing."* | **108** | **108** | damage one row's price in the Explorer, run → restored |
| X3 (snowflake) | *"Merge on employee_id."* | **20** | **20** | — |

Also check: the first run after switching to append does NOT drop the table (the existing rows are
still there), and X5 in merge mode is refused for Mongo with a choice of append / anti-join / replace.

## After the joins
- **Staging cleanup:** in the Data Explorer, each SQL destination (mysql, mssql,
  snowflake, BigQuery, Postgres) shows no temporary staging tables left over:
  only the `e2e_*` tables named above.
- **Replace, not append:** re-run X1 and X5. Still **20** each (a join always rebuilds its target).
- **Spot check:** in X1, X3 and X5, EMP-001 → ST-004 (Phoenix).
- **Mongo destination (X5):** documents carry no `_id` from either source.

## Checks
- [ ] X1–X8 row counts as listed
- [ ] X9 totals 7439.05 / 1640.20
- [ ] X10: left 108 (68 empty) → inner 40 → full 108 → anti 68
- [ ] No staging tables left in any SQL destination
- [ ] Re-runs replace the target (20, not 40)
- [ ] Append across connections: 40 → 60 → replace 20 on mysql, mongo and local; merge on Postgres and snowflake keeps 108 / 20 and restores a damaged row
- [ ] The builder produced a correct workflow from one message (note which ones needed the fallback)
- [ ] No renderer console errors or main-process errors (watch for "could not be cloned")

## Cleanup
Leave the `E2E X*` workflows and `e2e_x*` tables; list them.
