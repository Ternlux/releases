# 55-edge-join-keys

**Area:** join-key traps: NULLs, duplicates (row multiplication), trailing spaces, leading zeros, case, integer vs text, empty inputs
**Uses:** `E2E edge sqlite` (`keys_left`, `keys_right`, `empty_table`); Postgres, mysql
**Cost:** about 8 AI builds
**Requires:** 50

`keys_left.cust_key` (INTEGER): `1,2,3,3,4,5,NULL,7,8,9,10,11` (12 rows)
`keys_right.cust_key` (TEXT): `"1","2","3","4 ","05","7","7","8","a","A","",NULL` (12 rows)

Expected (`EXPECTED.json` → `edge.sqlite`):

| Join | Exact text match | Numeric match (cast, trim) |
|---|---|---|
| inner | **7** | **9** |
| left | **13** | 13 |
| right | **13** | 13 |
| full | **19** | 17 |
| left anti-join (left rows with no match) | **6** | 4 |

NULL never matches NULL. Left key `3` appears twice and right key `7` twice, so those rows multiply.

## Part 1 — Local join, all four types
Workflow `E2E Edge Keys`: `E2E edge sqlite`/`keys_left` + `E2E edge sqlite`/`keys_right` → Join, local:
1. *"Inner join on cust_key, keep order_id, cust_key and cust_name."* The two
   columns are INTEGER vs TEXT, so check whether the assistant **asks or states**
   how to compare them (exact text, or numeric after trim). The count must match
   the stated rule: 7 or 9. Record which.
2. Refine to *"left join"*, then *"right join"*, then *"full outer join"*, then
   *"only left rows with no match"*. Run after each and compare with the table.
3. Check: the NULL-key rows from both sides appear only as unmatched rows, never paired.

## Part 2 — Across engines (integer vs text)
1. Output `keys_left` → Postgres `e2e_keys_left` and `keys_right` → mysql `e2e_keys_right` (Truncate).
2. Postgres `e2e_keys_left` + mysql `e2e_keys_right` → Join, destination
   **Postgres**, inner on cust_key. A Postgres `integer = varchar` comparison
   errors unless something casts, so check the generated SQL casts and the count is 7 or 9 as stated.
   - If it fails with "operator does not exist: integer = character varying", that is a bug: the build should have handled the type mismatch.
3. Same join, destination **mysql**. MySQL compares loosely (`'05' = 5` is true),
   so it may return 9 even when the assistant said "exact". Report any mismatch between the stated rule and the count.

## Part 3 — Empty inputs
1. `empty_table` + `keys_right` → Join, local, inner on id = cust_key → **0** rows,
   reported as "0 rows" with a warning, not a failure.
2. `empty_table` → Output → Postgres `e2e_keys_left`, **Truncate & insert**.
   `e2e_keys_left` must still hold **12** rows: an empty source never truncates.

## Checks
- [ ] Part 1: the assistant addresses the int-vs-text comparison · counts match the stated rule for all 5 variants · NULLs never pair
- [ ] Part 2: cross-engine joins run (cast present) and agree with the stated rule on both destinations
- [ ] Part 3: 0-row join warns · empty source leaves the destination at 12
- [ ] No renderer console errors or main-process errors
