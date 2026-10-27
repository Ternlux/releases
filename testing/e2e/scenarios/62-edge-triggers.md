# 62-edge-triggers

**Area:** Start-node triggers — Schedule (CRON) and File watch: firing, persistence across a
restart, failures, and runs that need approval (a pending join rebuild)
**Uses:** `stores` (CSV), Postgres; a scratch folder `~/Desktop/Sample_data/e2e/watch/`
**Cost:** none (no AI builds), about 25 minutes of wall time for the waits
**Requires:** 10 (Postgres `e2e_stores`), 33 Part 1c (E2E M3 exists — merge on employee_id)

## Ground truth
- `stores` has 5 rows.
- A CRON trigger set to "every minute" fires within ~60 s while the app is open.
- Code: `public/triggers/cronTriggers.js`, `fileWatchTriggers.js`, `registerAllTriggers.js`
  (triggers are re-registered at startup). A triggered run passes **no** approvals, so a
  join with `joinSettings.targetRebuild.pending` must be refused (see
  `joinTargetRebuildGate` in `public/NodeExecution/workflowExecutionHelpers.js`).

## Steps
1. **Schedule fires.** Workflow `E2E Trigger Cron`: Start (Schedule, the most frequent
   schedule the panel allows — every minute if offered) → Data Source `stores` → Output
   Postgres `e2e_trigger_cron`, **Append**. Save. Without touching the app, wait (poll
   the Executions tab every ~30 s, ≤ 3 min): runs appear with a trigger label; the table
   grows by 5 per run.
2. **Survives a restart.** Note the run count, restart the app
   (`app.sh stop` + start), wait 2–3 minutes: new runs keep appearing (re-registered
   at startup). Then set the Start node back to **Manual** and save; wait 2 minutes:
   no new runs (the cron is unregistered).
3. **Failure is recorded.** Point the Output at a table name the database rejects
   (e.g. a name over 63 characters on Postgres, or a schema that doesn't exist), set
   Schedule again, wait for one run: the Executions tab shows it **failed** with the
   database's message; the app shows no crash. Set back to Manual.
4. **File watch.** Create `~/Desktop/Sample_data/e2e/watch/` with `in.csv` (copy of
   `stores.csv`). Workflow `E2E Trigger Watch`: Start (File watch on that folder or
   file) → Data Source on the file (add it as a connection `E2E watch` — 👤 if a picker
   is needed) → Output Postgres `e2e_trigger_watch`, Truncate & insert. Save. Then, from
   a terminal, append a row to `in.csv` (`echo 'ST-999,Tucson' >> …/in.csv`): exactly
   **one** run fires (not one per write event); the table has 6 rows. Touch the file
   twice quickly: note whether it debounces. Set back to Manual.
5. **Triggered run + pending join rebuild.** Open E2E M3 (merge on employee_id, table
   `dbo.e2e_m3` has PRIMARY KEY). In the Join's own chat: *"Switch to append mode."* —
   the Run card shows the "Drops dbo.e2e_m3 … and recreates it" warning. Click **Not
   now**, save the workflow, set its Start node to Schedule (every minute), save. Wait
   for one triggered run: it must be **refused** ("…has to be dropped and recreated… Nothing
   was changed…"), and `dbo.e2e_m3` still has its 20 rows and its primary key. Set the
   Start node back to Manual and save. (Leave the join pending; or Execute with approval
   to finish it.)

## Checks
- [ ] Cron fires on schedule while the app is open; runs are labelled as triggered
- [ ] Cron re-registers after a restart; switching to Manual stops it
- [ ] A failing triggered run is recorded with the real error; no crash, no retry storm
- [ ] File watch fires once per change, reads the new content
- [ ] A triggered run with a pending, unapproved rebuild is refused and changes nothing
- [ ] No renderer console errors or main-process errors

## Cleanup
Set every E2E trigger back to **Manual** (leaving a schedule running is the one thing that
must not be left behind). Leave the tables; list them.
