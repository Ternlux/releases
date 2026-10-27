# 57-edge-cross-joins

**Area:** cross-connection join edge cases: staged sources, nested and vector sides, many-to-many, reported counts, stopping, re-pointing, collisions (R9)
**Uses:** the `e2e_*` tables from 10–15 and 30, the edge fixtures, `customers_store` (CSV, 300,000 rows)
**Cost:** about 10 AI builds
**Requires:** 10–15, 50

Every join below should be built in the Join node's chat with the exact
sentence given. After each run, compare the **row count the app reports**
(node message or execution log) with a COUNT on the destination. Every engine
must report the true count; a "0 rows inserted" when rows exist is a bug
(watch for this on SQL Server and BigQuery).

| # | Inputs → destination | Sentence | Expect |
|---|---|---|---|
| E1 | mongo `e2e_nested` (54) + Postgres `e2e_stores` → **mssql** | *"Match customer.address.city to location (case-insensitive), keep id and store_id, target dbo.e2e_e1."* | **0** rows, with a warning. Watch the staging load: nested documents into an SQL temp table must not crash ("[object Object]") |
| E2 | Postgres `e2e_products_store` + mysql `e2e_products_store` → **Postgres** | *"Inner join on product_id, keep both store_ids, target e2e_e2."* | Many-to-many: **414** rows (Σ over products of (stores stocking it)²), from 108 per side. Does the assistant warn about the row multiplication? |
| E3 | Postgres `e2e_employees` + snowflake `e2e_stores` + BigQuery `ternlux.e2e_products` → **local** | *"Employees with their store location, and also attach all products — every combination."* | 20 × 30 = **600** (a deliberate cross join); the assistant should confirm a cartesian product before building |
| E4 | `E2E edge values` (local CSV) + mysql `e2e_stores` → **mysql** | *"Left join edge values to stores where city = location, keep id, city, emoji, note, location, target e2e_e4."* | **200** rows; staging into MySQL keeps emoji and newlines; no matches, so location is all NULL |
| E5 | `product_name_vectors` (LanceDB, read-only) + mssql `dbo.e2e_products` → **snowflake** | *"Inner join on product_id, keep product_id, name and price from SQL Server, target e2e_e5."* | **30** rows; no vector column staged |
| E6 | `customers_store` (local CSV, 300,000 rows) + Postgres `e2e_stores` → **Postgres** | *"Inner join on store_id, keep visit_id, customer_id, location, target e2e_e6."* | **300000** rows (every visit's store exists). Note the staging time: 300k rows pushed into Postgres |

## Lifecycle edge cases
1. **Stop mid-join:** re-run E6 and press **Stop** while it's staging. Check
   that it stops within a few seconds, that the message says how far it got,
   and whether staging tables (`temp_…`) are left in Postgres. Run E6 again: it
   succeeds and leaves no `temp_…` tables.
2. **Re-point a source:** in E2, change the mysql Data Source to `e2e_products`
   (a different table). The join must **refuse to run** and name what changed
   (documented behaviour). Rebuild it from chat to clear it.
3. **Disconnect a source:** delete the edge from one input of E4 to the join
   and run. It must refuse, naming the missing input.
4. **R9 staging-table collision:** export the E6 workflow (⋯ → Export) and
   import it twice (👤 if the import needs a file dialog). Start **both**
   imported copies at the same time. Both should finish with the right count;
   a "table already exists", a wrong count or a missing table on one of them is R9.
5. **Re-run:** run E1–E5 a second time. Counts are identical; nothing is appended.

## Checks
- [ ] E1–E6 counts as expected; reported counts equal the actual COUNT on every engine
- [ ] Nested and vector sources stage cleanly into SQL; unicode survives staging into MySQL
- [ ] Many-to-many and cartesian joins: correct counts, and the assistant flags them
- [ ] Stop is prompt and recovers on the next run; no orphan `temp_…` tables after a successful run
- [ ] Re-pointed or disconnected sources are refused with a clear message
- [ ] Concurrent copies don't collide (R9)
- [ ] No renderer console errors or main-process errors
