# 56-edge-data-safety

**Area:** operations that could destroy data: same source and target, hostile or odd table names (R1, R2, R3)
**Uses:** `stores`, `employees` (CSV); Postgres, snowflake. **Only** the sacrificial tables from `_EDGE.md`.
**Cost:** about 4 AI builds
**Requires:** 50 (for the reference), and 10 (`e2e_stores` / `e2e_employees` in Postgres)

Before each part, (re)seed its sacrificial table: Output `stores` → Postgres
`<victim>` with Truncate & insert → **5** rows.

## Part 1 — R1: Output into its own source
1. Seed `e2e_victim_out`.
2. Workflow `E2E Edge Safety`: Data Source Postgres `e2e_victim_out` → Output →
   Postgres `e2e_victim_out`, **Truncate & insert**. Run.
3. COUNT `e2e_victim_out`. A pass is **5** (or the app refuses to run, naming
   the same-table problem). **0 rows with a success message confirms R1: blocker.**
4. Re-seed, switch the Output to **Append**, and run: **10** is expected and acceptable.

## Part 2 — R2: Join target = one of its inputs
1. Seed `e2e_victim_join`.
2. Postgres `e2e_employees` + Postgres `e2e_victim_join` → Join, destination
   Postgres. Chat: *"Inner join employees to the stores in e2e_victim_join on
   store_id, keep employee columns plus location, target table e2e_victim_join."*
3. A pass: the assistant warns about or refuses the target name, or the run
   refuses it. Otherwise run it and COUNT `e2e_victim_join`. Check whether the
   table still exists and what it holds now. **Source data destroyed → R2
   confirmed, blocker.** (A correct outcome could be 20 joined rows replacing 5
   stores *only if* the user was warned and the join read the source first.)

## Part 3 — R3: Transformer new table = its source
1. Seed `e2e_victim_tx`.
2. Data Source Postgres `e2e_victim_tx` → Transformer: *"Create a new table
   called e2e_victim_tx with only the Phoenix stores."*
3. A pass: the assistant points out that the name is the source and asks, or
   switches to in place with a warning. Otherwise run it and COUNT: **4** with a
   warning is acceptable; **0, an error with the table gone, or a missing table → R3 confirmed.**

## Part 4 — Hostile and odd table names (Outputs from `stores`, Truncate & insert, to Postgres)
| Target name | A pass looks like |
|---|---|
| `e2e_order` (`order` is reserved) | Created; 5 rows |
| `e2e_o'brien` | Created with the apostrophe, or refused clearly; 5 rows if created |
| `e2e_x"; DROP TABLE e2e_stores; --` | Refused, or created as an odd-named table. **Then `e2e_stores` must still have 5 rows** (injection check) |
| `E2E_MixedCase` | One table; a later Data Source finds it and previews 5 (no second lower-case copy) |
| `e2e_` + 70 characters (e.g. `e2e_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`) | Postgres truncates to 63 characters: a re-run must find the **same** table (5 rows, not 10), and a Data Source can read it |
| `e2e_unicode_表` | Created and readable; 5 rows |

Repeat `E2E_MixedCase` and the 70-character name against **snowflake**, which
upper-cases unquoted names and allows 255 characters.

## Checks
- [ ] R1: no data loss when output = source (refused, or 5 rows kept)
- [ ] R2: join target = input is caught, or at least doesn't destroy the input without warning
- [ ] R3: transformer target = source is caught
- [ ] Hostile names: `e2e_stores` intact (5); each odd name created and readable, or clearly refused
- [ ] Case and length: re-runs hit the same table on Postgres and Snowflake
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the victims (they're re-seeded each run); list any odd-named tables created.
