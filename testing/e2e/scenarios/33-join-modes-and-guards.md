# 33-join-modes-and-guards

**Area:** join write modes (replace / append / merge) on every destination kind, the local DuckDB join on the
shared CREATE + INSERT contract, the "target is also a source" guards for joins and outputs, and
regression checks for the 2026-10-05 fixes (BUG-B, BUG-F, BUG-C/D/G, Pinecone `list`, one-click save)
**Uses:** the `e2e_*` tables from 10–15, scenario 31's Part 0 seed (re-run it first), local CSVs,
Pinecone `products-index` namespace `e2e` (27 records, from 41)
**Cost:** about 12 assistant builds
**Requires:** 10, 11, 15 (Part 1), 31 Part 0, 41 Parts 1–3

Ground truth: `employees` ⋈ `stores` = **20** (18 Phoenix / 2 LA); products not in
`e2e_c11_catalog` (12 premium) = **18**; `products_store` ⋈ Pinecone `e2e` = **95**.

## Part 1 — Append mode on each destination kind
For each: build with one message, run twice, then switch the mode in the Join's chat and run once.

| # | Message (destination) | Run 1 | Run 2 | *"Switch this join back to replace mode."* |
|---|---|---|---|---|
| A1 | *"Build a workflow named E2E A1 that inner joins e2e_employees from Postgres with e2e_stores from mysql on store_id, keeps all employee columns plus location, and APPENDS to a Postgres table e2e_a1."* | **20** | **40** | **20** |
| A2 | same join, *"…appends to a local table e2e_a2"* (local DuckDB) | **20** | **40** | **20** |
| A3 | same join, *"…appends to a new mongo collection e2e_a3"* | **20** docs | **40** | **20** |
| A4 | same join, *"…appends to a snowflake table e2e_a4"* | **20** | **40** | **20** |

Checks per row:
- The join's details show write mode **append**; the plan / reply says it appends, not replaces.
- Run 1 creates the table (it did not exist); run 2 adds without dropping it (no "CREATE"
  in the log for run 2).
- The run message says how many were appended and the total ("20 row(s) appended to … (40 in total)").
- After switching back, the run replaces: **20**.

## Part 1b — Merge mode (update matching rows, insert the rest)
Join for every row: Postgres `e2e_employees` + mysql `e2e_stores` on store_id, all employee columns
plus location, **merge on employee_id**. Message: *"Build a workflow named E2E M<n> that inner joins
e2e_employees from Postgres with e2e_stores from mysql on store_id, keeps all employee columns plus
location, and MERGES into <destination> table e2e_m<n> on employee_id."*

| # | Destination | Statement expected in joinSql.sql |
|---|---|---|
| M1 | Postgres | `MERGE INTO "public"."e2e_m1" … WHEN MATCHED … WHEN NOT MATCHED …` (or `ON CONFLICT` with a PRIMARY KEY in targetDdl) |
| M2 | mysql | `INSERT INTO … ON DUPLICATE KEY UPDATE …`, and targetDdl declares `PRIMARY KEY (employee_id)` |
| M3 | mssql | `MERGE … ;` (terminating semicolon) |
| M4 | local DuckDB | `MERGE INTO {{TARGET}} …` (or `ON CONFLICT` with a PRIMARY KEY) |
| M5 (optional) | snowflake / BigQuery | `MERGE …` |

For each:
1. Run 1 → **20** rows. Run 2 → still **20** (merged, not appended).
2. In the Data Explorer, damage the target: set EMP-001's location to `STALE` and delete EMP-020.
   Run 3 → **20** rows, EMP-001's location is back to its store's (PHOENIX), EMP-020 is back.
3. The node details show write mode **merge** and merge key **employee_id**.

Merge refusals:
- **M6, document store:** same join, *"…merges into a new mongo collection e2e_m6 on employee_id."* → the
  assistant says the destination can't merge and offers append / append with an anti-join / replace.
  Answer *"append"* → built in append mode (20, then 40).
- **M7, no key:** *"…merge into Postgres table e2e_m7."* (no key) → asked which column identifies a row.
- **M8, refine:** in M1's Join chat: *"Switch to append mode."* → mode append, run → **40** (each
  employee twice). Then *"Merge on employee_id again."* → mode merge, run → still **40**: a merge
  updates matching rows (both copies) but never deletes the duplicates the append added. Note
  whether the assistant warns about the existing duplicates.

## Part 1c — A kept target that no longer fits (drop and recreate, with approval)
Uses the merge tables from Part 1b (each has PRIMARY KEY (employee_id)).

| # | Where | Steps | Expect |
|---|---|---|---|
| R1 | E2E M1 (Postgres), the Join's own chat | *"Switch to append mode."* | Run card: "Drops e2e_m1 (20 rows) and recreates it — …primary key…"; node card: WRITE Append/Merge · recreate pending; Details: Write mode + Pending change |
| R2 | E2E M1, canvas | Execute → prompt "Recreate tables before running?" → **Cancel** | nothing runs; e2e_m1 unchanged (20, PK) |
| R3 | E2E M1, canvas | Execute → **Drop, recreate and run**; Execute again | 20, no PRIMARY KEY; then 40 (20 distinct); reopening asks nothing |
| R4 | E2E M2 (mysql), workflow builder | *"In this workflow, switch the join to append mode instead of merging."* → Accept | build pauses on "Approve drop and recreate" (20 rows, reason); approve → built; Execute shows NO prompt → 20, no PK; again → 40 |
| R5 | E2E M3 (mssql), workflow builder | same message → Accept → **Don't run** | "Not approved. The build stopped, nothing was saved…"; saved join still merge on employee_id |
| R6 | E2E A1 (append, table fits), Join chat | *"Rebuild this join and keep it in append mode."* | no drop warning, no pending flag |
| R7 | E2E M4 (local DuckDB), Join chat | *"Switch to append mode."* → **Run this node** | warning names e2e_m4 (20 rows); run says "(e2e_m4 was recreated, as approved.)"; 20, then 40 on Execute |
| R8 | any | a run with a pending, unapproved rebuild that is not started from the card or the Execute prompt (trigger) | refused: "…has to be dropped and recreated… Nothing was changed." |

Also check the write-mode field on cards and in Details: join **Append/Merge** / **New table**,
transformer **Modify in place** (E2E C2) / **New table** (E2E C1), output **Append/Merge**
(E2E C6) / **New table** (E2E C5, truncate and file exports).

## Part 2 — Local DuckDB on the shared contract
1. Open `workflow-code/E2E_A2/<join>/`: the join has a `targetDdl.sql` (`CREATE TABLE {{TARGET}} …`) and
   `joinSql.sql` is `INSERT INTO {{TARGET}} SELECT … FROM "src1_…" … "src2_…"` — sources as the
   registered view names, `{{TARGET}}` kept for the run.
2. Re-run an OLD local join built before this change (E2E X7 or E2E X9): still **20** / Phoenix
   7439.05 — the old bare-SELECT joins still run.
3. A local self-join: two Data Sources on CSV `employees` → Join, local: *"Pairs of employees at the
   same store, each pair once, target e2e_a5."* → **35** (the two sides get different view names).

## Part 3 — Guards
1. **Join, replace into its own source (refused at build):** canvas: Postgres `e2e_c7_stores` + CSV
   `employees` → Join, Postgres: *"Inner join employees to stores on store_id, keep all employee columns
   plus location, target table e2e_c7_stores."* → build refused, naming the table and offering append
   or another table. `e2e_c7_stores` still **5**.
2. **Join, append into its own source (allowed):** canvas: CSV `products` + Postgres `e2e_c11_catalog`
   (re-seeded to 12) → Join, Postgres, in its chat: *"Append to e2e_c11_catalog the products whose
   product_id is not already in it."* → run 1: **+18**, catalog **30**; run 2: **+0** (warning,
   not failure), still **30**.
3. **Output, truncate into a table the workflow reads (refused at run):** E2E C6 (from 31) with its
   Output on Truncate & insert → Execute is refused before anything is written; table unchanged.
4. **Output, append into the same table (allowed):** switch C6's Output to Append → runs, table grows
   (38 → 74 pattern from 31).
5. **Old C7** (built before the guard): Execute → refused, table untouched.

## Part 4 — Regression checks for the 2026-10-05 fixes
- **BUG-B (Mongo read with no collection):** build *"Build a workflow named E2E C13b that joins the
  local CSV connection products with the e2e_products_store collection from mongo on product_id,
  keeps all products_store fields plus name and price, locally as e2e_c13b."* → **108** rows. Also
  re-run the old E2E C13 (saved with no collection): **108**.
- **BUG-F (vector source searched inside the function):** re-run old **E2E V6** without rebuilding:
  no `ctx.vectorize is not a function`; mongo `e2e_v6` **30** docs, no Socks matches. Then build a new
  similarity join (V6's message) and check its saved config: the Pinecone source is in
  `directReadSources`, and the function takes `(productsRows, ctx)`.
- **BUG-C / BUG-D:** a new one-message Pinecone join (V2's message) saves `sourceNamespace "e2e"` and
  returns **95** rows.
- **BUG-G:** E2E V9 re-run → Snowflake `e2e_v9` **40**; no `temp_…` left in Snowflake.
- **Pinecone `list` / builder sample:** in a new chat: *"Show me 3 records from the e2e namespace of
  the Pinecone products-index."* → one `run_query` with `{"operation":"list", …, "limit":3}`, 3 records
  with metadata, no failed `fetch`/`query` attempts. A new Pinecone Data Source built by the builder
  saves sample rows (no "sample query … Index name is required" warning).
- **One-click save:** Save on any workflow commits with no Execution Steps dialog; Execute with unsaved
  changes shows the Save / Don't save / Cancel prompt with no steps section; Edit Steps → reorder →
  Save Steps commits the order.
- **Fix it with a node in focus (BUG-E):** in a Join's own chat, get a review verdict with a
  "Fix it" button (e.g. ask for a column that does not exist, so the review flags it), then click
  Fix it. The turn goes to the WORKFLOW planner (a plan card / workflow rebuild), not to the node's
  builder: no "can only create a new-table join" reply, and the flagged problem is fixed.
- **Save check in chat:** with an unsaved change, a builder request is refused at once ("…Save it
  (Save, above the canvas), then press Retry"), with a toast and no dialog.

## Checks
- [ ] A1–A4: 20 → 40 → replace 20; append creates on run 1, never drops
- [ ] M1–M4: 20 → 20 → damaged row restored and deleted row re-inserted (20); the right statement per engine
- [ ] M6 refused for Mongo then built as append; M7 asks for the key; M8 mode switches work
- [ ] R1–R8: a kept target that no longer fits is recreated once, only after approval; write-mode field on all three node types
- [ ] Local join saved as CREATE + INSERT with {{TARGET}} / view names; old local joins still run; local self-join 35
- [ ] Join replace into own source refused at build and at run; append into own source works (+18 then +0)
- [ ] Output truncate into an upstream source refused at run; append allowed
- [ ] BUG-B, BUG-F, BUG-C/D, BUG-G, BUG-E (Fix it at workflow level), Pinecone list, one-click save, chat save check all pass
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the `E2E A*` / `E2E C13b` workflows and `e2e_a*` tables; list them. Re-seed with 31 Part 0.
