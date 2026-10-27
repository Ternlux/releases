# 66-packaged-smoke

**Area:** the installed app (`/Applications/Ternlux.app`) — everything so far ran on the dev build
**Uses:** `employees`, `stores` (CSV); Postgres, mysql; `product_name_vectors` (LanceDB); Pinecone
**Cost:** about 3 AI builds
**Requires:** a packaged build of the current code installed in `/Applications`. If the
installed app is older than the code under test, say so and mark the scenario BLOCKED.

## Ground truth
- `employees` ⋈ `stores` = **20** (18 Phoenix / 2 Los Angeles).
- Packaged-only failure modes to watch: plugins loaded from the app's resources (connector
  list complete?), native modules (DuckDB, LanceDB, SQL drivers), `app.getPath` paths,
  `public/docs` shipped (the builder reads them into prompts), file pickers and paths with
  spaces, the app's own DuckDB/LanceDB folders.

## Steps
1. Stop the dev app; start the packaged one: `bash testing/e2e/app.sh start --packaged`
   (same profile). Record the version shown in Settings / About.
2. **Smoke.** Workflows, Connections, Executions, Settings all load; the connector picker
   lists the same connectors as the dev build (compare with `plugins/connectors/`); the
   Data Explorer previews `employees` (20 rows) and runs a query on Postgres.
3. **Local engine.** Run `E2E X7` (CSV + Postgres → local) → **20**; preview the result.
4. **Database staging.** Run `E2E X1` (Postgres + mysql → mysql) → **20**; no `temp_…` left.
5. **Vector.** Run `E2E V5b` (CSV + LanceDB similarity → Postgres) → **90**, scores filled.
   Run `E2E Pinecone Truncate` → namespace `e2e-trunc` 30.
6. **Builder (reads docs + plugins at run time).** Build *"Build a workflow named E2E Packaged
   Build that inner joins the employees CSV with the stores CSV on store_id into a local
   table e2e_packaged."* → plan, build, review ✓, run → **20**.
7. **Chat analyst.** *"How many stores are in Phoenix?"* → **4**.
8. **Logs.** The packaged main-process log (app.sh prints its path) has no "Cannot find
   module", no native-module load errors, no missing-docs warnings.
9. Stop the packaged app; start the dev app again for the rest of the plan.

## Checks
- [ ] Packaged app starts on the existing profile; version recorded
- [ ] Connector list complete; local, staging and vector runs give the same results as dev
- [ ] Builder works (docs and plugins found); analyst answers
- [ ] No module/native/doc load errors in the packaged log
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave `E2E Packaged Build`; restart the dev app.
