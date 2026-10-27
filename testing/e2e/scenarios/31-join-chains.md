# 31-join-chains

**Area:** joins inside longer chains (transformer → join, join → join, join → output), sources already on the
destination, a join or output that writes back into one of its own sources, incremental anti-join loads,
and regression checks for the 2026-10-03 join fixes
**Uses:** the `e2e_*` tables from 10–15, local CSVs `stores`, `employees`, `products`, `products_store`
**Cost:** about 14 assistant builds
**Requires:** 10, 11, 12, 15 (Part 1 each, and Part 2 step 1 of 10 for Postgres `e2e_products_premium`)

Ground truth (from the CSVs; see `_DATASET.md` for the base answers):

| Question | Answer |
|---|---|
| `products_store` ⋈ products, rows per price band (low < 50, mid 50–100, high > 100) | low **22**, mid **46**, high **40** |
| Products stocked at each employee's store | EMP-001 **14**, EMP-002 **29**, EMP-003 **14**; sum over all 20 employees **421** |
| Pairs of employees at the same store (each pair once) | **35** |
| Products not premium (price ≤ 100) | **18** |

`e2e_stores` may be upper case (Recipe D Part 2), so compare locations ignoring case.

## Part 0 — Seed the sacrificial tables
Create workflow `E2E Chains Seed` (Start, then one Data Source → Output pair per row, every
Output **Truncate & insert**). Run it once.

| Source | Destination | Table | Rows |
|---|---|---|---|
| CSV `stores` | Postgres | `e2e_c7_stores` | 5 |
| CSV `employees` | Postgres | `e2e_c6_employees` | 20 |
| CSV `stores` | mysql | `e2e_c2_stores` | 5 |
| Postgres `e2e_products_premium` | Postgres | `e2e_c11_catalog` | 12 |

Parts 2 and 5 change these tables; re-run this seed before re-running those parts.

## Part 1 — Transformer, then join
Build each with one message to the workflow builder (fallback: the Join's own chat; report it).

1. **C1, new-table transformer on the destination, then join.** *"Build a workflow named E2E C1:
   from the Postgres e2e_products table make a new Postgres table e2e_c1_premium with the products
   priced over 100, then inner join it with e2e_products_store from the mysql connection on
   product_id, keeping store_id, product_id, name and price, into a new Postgres table e2e_c1."*
   → `e2e_c1_premium` **12**, `e2e_c1` **40**. The transformer's output is on the destination, so
   the join reads it in place: the Join card must **not** show "NEW SOURCE NOT READ", and the run
   must not be refused.
2. **C2, in-place transformer, then join on the same table.** *"Build a workflow named E2E C2:
   lower-case the location column of e2e_c2_stores on mysql in place, then inner join e2e_employees
   from Postgres to it on store_id, keeping all employee columns plus location, into a new mysql
   table e2e_c2."* → `e2e_c2` **20**, every location lower case (`phoenix` **18**,
   `los angeles` **2**). Check in Execution Steps that the transformer runs before the join. Run it
   twice: still 20, still lower case.
3. **C3, local transformer, then join into a database.** *"Build a workflow named E2E C3: add a
   price_band column to the local products CSV (low under 50, mid 50 to 100, high over 100) as a local
   table, then inner join it with e2e_products_store from Postgres on product_id into a new Postgres
   table e2e_c3 with store_id, product_id, price and price_band."* → **108** rows: low **22**, mid
   **46**, high **40**. The local transformer's table has to be staged into Postgres.

## Part 2 — Pull data locally, then join into a database
4. **C4.** *"Build a workflow named E2E C4: copy the e2e_products collection from mongo into a
   local table, then inner join that local table with dbo.e2e_products_store from mssql on
   product_id into a new mssql table dbo.e2e_c4 with store_id, product_id, name and price."* →
   **108**; Σprice **9079.25**. No `_id` column in `dbo.e2e_c4` unless the assistant asked about it.

## Part 3 — Join locally, then insert into a database
5. **C5, local join → Output.** *"Build a workflow named E2E C5: inner join e2e_employees from
   Postgres with e2e_stores from mysql on store_id into a local table, keeping all employee columns
   plus location, then write the result to a new Postgres table e2e_c5 with truncate and insert."* →
   `e2e_c5` **20**. Run again → **20**. Switch the Output to **Append**, run → **40**. Switch back
   to Truncate, run → **20**.
6. **C6, the Output writes into one of the workflow's own sources.** *"Build a workflow named E2E
   C6: inner join e2e_c6_employees from Postgres with the local stores CSV on store_id, keep only
   employees at Phoenix stores and only the employee columns, then append the result to the
   Postgres table e2e_c6_employees."*
   - Did the assistant point out that the Output writes into a table the workflow reads, and that
     each run will re-read its own output? (A note is enough; silently building it is an
     observation, not a failure.)
   - Run 1: the join reads 20 rows and keeps the **18** Phoenix ones → table **38**.
   - Run 2: it reads 38 and keeps **36** → table **74**. The growth is the expected result of
     append-into-your-source; anything else (a lock error, a partial write, a different count)
     is a bug.
   - Switch the Output to **Truncate & insert**, run 3: the run is **refused** before anything is
     written ("…also read by … earlier in this workflow — truncating it would empty the source…"),
     and the table still holds **74**. (Guard added 2026-10-05.)
7. **C7, the join's target is one of its own sources.** In the Join's chat, with Postgres
   `e2e_c7_stores` + CSV `employees` wired in and destination Postgres: *"Inner join employees to
   stores on store_id, keep all employee columns plus location, target table e2e_c7_stores."*
   - Expected: the build is **refused** with a message that the target is also a source and the
     replace would empty it, offering a different table or append mode. `e2e_c7_stores` still
     holds its **5** stores.
   - Also run the OLD E2E C7 workflow (built before the guard, if it still exists): Execute is
     **refused** ("…replace would empty it before it is read… Nothing was changed.") and the table
     is untouched.

## Part 4 — Join chains and shapes
8. **C8, join → join.** *"Build a workflow named E2E C8: inner join e2e_employees from Postgres with
   e2e_stores from mysql on store_id into a local table, then join that with dbo.e2e_products_store
   from mssql on store_id and count the products stocked at each employee's store, into a new
   Postgres table e2e_c8 with employee_id, name, location and product_count."* → **20** rows;
   EMP-001 **14**, EMP-002 **29**; Σ product_count **421**.
9. **C9, two sources already on the destination + one staged.** *"Build a workflow named E2E C9:
   join e2e_products_store and e2e_products, both from Postgres, with e2e_stores from mysql, and
   write the total price per location to a new Postgres table e2e_c9."* → Phoenix **7439.05**,
   Los Angeles **1640.20**. Two sources are read in place and one is staged, so this
   is the `{{SOURCE_1..3}}` mix (see Part 6).
10. **C10, self-join.** Two Data Sources on Postgres `e2e_employees` (a node can't be wired into one
    join twice) → Join, destination Postgres: *"Pairs of employees who work at the same store, each
    pair once (employee_a < employee_b), with store_id, target e2e_c10."* → **35** rows, no
    employee paired with itself.
11. **C11, incremental anti-join load.** *"Build a workflow named E2E C11: find the products in the
    local products CSV whose product_id is not already in e2e_c11_catalog on Postgres, and append
    them to e2e_c11_catalog."* → run 1 appends **18**, catalog **30**; run 2 appends **0**, catalog
    still **30**. A run that reports success with 0 rows should say so without failing.
12. **C12, one Data Source feeding two joins into the same destination.** In one workflow
    `E2E C12`: Data Source mysql `e2e_stores` wired into **Join A** (with Postgres `e2e_employees`,
    target Postgres `e2e_c12a`) and **Join B** (with Postgres `e2e_products_store`, target Postgres
    `e2e_c12b`). Both stage the same mysql source into Postgres. → `e2e_c12a` **20**, `e2e_c12b`
    **108**; run twice; no `temp_…` table left in Postgres.

## Part 5 — Re-runs and cleanup checks
- Re-run C1, C3, C8 and C9: identical counts, nothing appended.
- In the Data Explorer on Postgres, mysql and mssql: no `temp_…` staging tables left by this
  scenario.

## Part 6 — Regression checks for the 2026-10-03 join fixes
Use the workflows built above; no extra builds unless stated.

- **BUG-01 (source on the destination counted as unread):** C1, C9 and C10 have sources already on
  the destination. Right after each build, no Join card shows "NEW SOURCE NOT READ", and the
  first Execute is not refused. In the saved workflow every source wired into the join has a
  `sourcesConfig` entry (a source read in place has just its id and connection).
- **BUG-02 (staging names written by the model):** for every SQL-destination join above, open
  `~/Library/Application Support/Ternlux/workflow-code/<workflow>/<join>/joinSql.sql` and the
  per-source `ddl.sql`: no `{{SOURCE_` text is left, and each staged table name in the join SQL
  is exactly the one the matching `ddl.sql` creates.
- **BUG-03 (Mongo source into a local join):** build *"Build a workflow named E2E C13 that joins the
  local CSV connection products with the e2e_products_store collection from the mongo connection
  on product_id (inner join), keeps all products_store fields plus name and price, and stores the
  result locally as a new table e2e_c13."* → **108** rows on the first run, no
  `"[object Object]" is not valid JSON`.
- **BUG-04 (save gate):** open `E2E C5`, drag any node a little (unsaved change), then in a new
  chat ask *"Add an Output after the join that writes a CSV to
  ~/Desktop/Sample_data/e2e/c5.csv"*.
  1. The chat answers **at once** that the workflow has unsaved changes and nothing was started,
     and the Execution Steps dialog is open. The chat is not left on "Workflow builder…".
  2. Save in the dialog, then press **Retry** on the message: the plan appears and builds normally.
  3. Repeat with **Cancel** in the dialog: the canvas keeps the unsaved move, and the chat stays
     usable.
  4. With an unsaved change, press **Accept plan** on a plan card: the card says to save and
     accept again; after saving, Accept builds.
- **BUG-05 (plan card numbering):** on the C1, C8 and C9 plan cards the "←" inputs equal the step
  numbers shown (a join fed by steps 2 and 3 reads "← 2, 3"). On a modify plan (BUG-04 step 2) kept
  steps show node names, not ids like `dataSource-1791…`.

## Checks
- [ ] Part 0: seed 5 / 20 / 5 / 12
- [ ] C1 12 → 40 · C2 20 all lower case, twice · C3 108 with bands 22/46/40
- [ ] C4 108, Σprice 9079.25
- [ ] C5 20 → 20 → append 40 → truncate 20
- [ ] C6 38 → 74 → truncate **refused**, table still 74
- [ ] C7 refused at build; the old C7 refused at run; the source table keeps its 5 rows
- [ ] C8 20 rows, Σ 421 · C9 7439.05 / 1640.20 · C10 35 · C11 +18 then +0 · C12 20 / 108
- [ ] Re-runs identical; no `temp_…` tables left on Postgres, mysql or mssql
- [ ] Part 6: BUG-01 … BUG-05 regression checks all pass
- [ ] The builder produced a correct workflow from one message (note which needed the fallback)
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the `E2E C*` workflows and the `e2e_c*` tables; list them in the report.
