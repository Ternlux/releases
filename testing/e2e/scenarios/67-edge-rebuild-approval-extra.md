# 67-edge-rebuild-approval-extra

**Area:** the remaining paths of the "kept target no longer fits → drop and recreate with
approval" feature (33 Part 1c covered the main ones)
**Uses:** E2E M3 (mssql, merge on employee_id, table has PRIMARY KEY), E2E M2 (mysql, now
append without a key), E2E C11 / `e2e_c11_catalog`
**Cost:** about 5 AI builds
**Requires:** 33 (Parts 1b, 1c), 31 Part 0

## Ground truth
- `joinSettings.targetRebuild` is recorded at build when an append/merge join's existing
  table has a missing column or a different primary key, or the generator says it can't
  write into it. The run re-reads the table; it drops only with approval (build-time,
  bound to the exact CREATE statement, or "Run this node" / the Execute prompt), and never
  for a triggered run.

## Steps
1. **Two rebuilds in one Execute.** Make one workflow `E2E Two Rebuilds` with two joins that
   each need a rebuild: copy the M3 join pattern twice into two merge targets
   (`dbo.e2e_r1`, `dbo.e2e_r2`, merge on employee_id — build them in merge mode first and
   run once so the tables get their key), then switch **both** to append in their chats
   (click Not now on both cards). Execute: one prompt lists **both** tables with row counts
   and reasons; Cancel → nothing runs; Execute again → approve → both recreated (20 each,
   no key); run again → 40 each.
2. **Approval reset by an edit.** In the workflow builder: switch M3's join to append →
   the build pauses → **approve** (the node records the approval). Before running, change
   the join again in its chat (*"Also keep the employee name in upper case."*): if the
   CREATE statement changed, Execute must **ask again** (the approval was for the old
   statement). If the statement is unchanged, it runs without asking — record which.
3. **Rebuild needed + target is a source.** In E2E C11 (the join reads `e2e_c11_catalog` and
   appends to it), ask in the Join's chat: *"Also add a column source_tag with the value
   'csv' to every appended row."* (`e2e_c11_catalog` has no such column → rebuild needed,
   but the table is also a source). Expected: either the builder refuses to drop a table
   the join reads (preferred), or the warning makes clear the source data is lost and the
   run is refused without approval. **Never** an approved drop that then reads an empty
   source silently — if that happens, record exactly what was lost.
4. **Rebuild then manual change outside Ternlux.** After step 1, in the Explorer add a
   column to `dbo.e2e_r1` (`ALTER TABLE dbo.e2e_r1 ADD extra INT NULL`) and run: append
   still works (an extra nullable column doesn't block it), or the database's own error is
   shown on that step — never a silent drop.
5. **Merge mode with an existing table that has no key** (mysql). In E2E M2 (append, no key
   now), ask: *"Switch back to merge on employee_id."* MySQL's upsert needs a key: expect the
   rebuild warning (key missing) and, after approval, a merged table (20 after two runs).

## Checks
- [ ] Two pending rebuilds: one prompt, both listed; Cancel runs nothing; approve recreates both
- [ ] An approval is bound to the CREATE statement; a changed statement asks again
- [ ] A rebuild on a table the join also reads is refused or clearly warned — no silent source loss
- [ ] Outside changes: the database decides; no drop without approval
- [ ] Merge back on mysql recreates with the key after approval; no duplicates
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the E2E workflows and `e2e_r*` tables; list them.
