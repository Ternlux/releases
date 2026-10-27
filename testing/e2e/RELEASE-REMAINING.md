# Release QA — remaining tests (run plan for /qa-run)

**How to use:** `/qa-run testing/e2e/RELEASE-REMAINING.md start a new session`

This file is a **run plan**, not a scenario. Run the scenarios it lists, in the order
below, with the part selections and overrides given here. Everything else in the
qa-run skill applies unchanged: E2E naming, never touching non-E2E data, no bridge
writes, 👤 steps, and the report format.

Background: `testing/e2e/runs/2026-10-05_1232_release/remaining-tests.md` (the coverage
analysis) and `report.md` / `notes.md` in that folder (what already passed and how).
Scenarios 04–06, 10–15, 20–22, 30–33, 40–41 have passed and **are not re-run**.
The regression re-runs for code changed after they passed also passed on 2026-10-06.

---

## 0. Before you start (lessons from the last runs — follow them)

- **Starting the app.** Use `perl -e 'alarm 150; exec @ARGV' bash testing/e2e/app.sh start`.
  Then wait for "Ternlux is up" with an until-loop (≤ 120 s). Never put the user-data-dir
  path in a command (the launcher's `pgrep` matches it).
- **Keep every wait short.** No single tool call longer than ~90 s. Poll in bounded
  loops. If a Playwright call is moved to the background, stop it and look at the
  page instead of waiting.
- **Tab.** After every restart, list the tabs and select the `localhost:3000` one,
  never DevTools.
- **Helpers.** Reuse `testing/e2e/runs/2026-10-05_1232_release/install.js`. Copy it into
  your run folder and fix the screenshot path. It installs helpers on `page.__L`
  (`globalThis` doesn't persist).
- **Hidden window.** If clicks hang on "waiting for element to be stable",
  `document.visibilityState` is `hidden`. Wake it with a CDP session:
  `Emulation.setFocusEmulationEnabled {enabled:true}` +
  `Page.setWebLifecycleState {state:'active'}` (install.js already does this at the end).
- **Sticky toast.** The success toast covers Execute; hide `.ant-message` before clicking.
  The `run()` helper does this.
- **A node's chat.** Keep the node's panel open while you type. Closing the panel
  drops the node from the chat context (known BUG-25), and the message goes to the
  main assistant instead.
- **Data you must NOT change:**
  - Pinecone namespaces `e2e` (27 records, no Socks) and `products` (30).
    Don't run the workflow **E2E Pinecone**: it appends to `e2e`. Scratch
    namespaces for writes: `e2e-join2`, `e2e-trunc`, or new `e2e-*` ones.
  - The LanceDB table `product_name_vectors` is read-only.
  - Under `~/Desktop/Sample_data`, write only inside `e2e/`.
- **Never run git.**

## 1. Known state of the profile (2026-10-06)
- The `e2e_*` seed tables on SQL Server, Mongo, Snowflake and BigQuery were reseeded
  from the CSVs (locations in CSV case, e.g. `Phoenix`). Compare locations ignoring case.
- E2E V8 is saved in **append** mode. E2E M1 and M2 are in append mode (no primary key now).
- The edge fixtures exist in `~/Desktop/Sample_data/e2e/edge/` with `EXPECTED.json`. The 7
  `E2E edge …` connections have **not** been created yet (👤, in 50).
- Open bugs, don't report them as new: BUG-05 (MSSQL `NVARCHAR(MAX)` from
  transformers), BUG-06 (int8 counts stored locally as VARCHAR), BUG-25, BUG-H (a
  just-built workflow counts as unsaved), the sticky toast, and the Parquet Output
  metric showing 0 records.

## 2. Run order

### Day 1: cheap, no or little AI
1. **01-smoke-navigation**: full. Never run before.
2. **02-explorer-local-files**: full. Never run as a scenario.
3. **03-editor-build-manually**: full. Never run before.
4. **66-packaged-smoke**: new. Needs the installed `/Applications/Ternlux.app`; if it is
   missing, mark the scenario BLOCKED and say so.
5. **50-edge-setup-and-load**: full (prerequisite for 51–61). Step 1 (the fixture
   script) is already done; re-run it only if `EXPECTED.json` is missing.
6. **51-edge-messy-values-everywhere**: full. **Highest priority.** Code reading
   predicts:
   - R6: leading-zero zips like `02947` become integers;
   - R5: values above 2^31 overflow a 32-bit `INTEGER`;
   - R4: types inferred from the first page, so a later value fails the load after
     the destination was already truncated.

   For every failure, record exactly what was **already written or deleted**:
   data loss = blocker.

### Day 2: data safety and lifecycle
7. **56-edge-data-safety: Parts 3 and 4 only.** Parts 1–2 (R1/R2) are covered by 31 C7
   and 33 G1–G5; skip them. Part 3 (R3: transformer new table = its own source)
   has no guard in the code, so expect possible data loss. Use only the
   sacrificial tables.
8. **58-edge-workflow-ops**: full. Pay special attention to step 1: the workflow name
   contains `../x`, so check `~/Library/Application Support/Ternlux/workflow-code/`
   to confirm nothing was written outside its own folder (path traversal).
9. **59-edge-chat: C1, C3, C5, C8, C9, C11, C12 only.** C2/C4/C6/C7/C10 are optional at
   the end.
10. **61-edge-sqlite-duckdb-sheets: A5, A7 and Part B (B5, S3, S5) only.** A1–A4 and A6
    are covered by 20 and the SQLite/DuckDB fixes. Note the A2 10M-row preview time
    if you pass by it.
11. **62-edge-triggers**: new.
12. **63-edge-auth-and-gating**: new, many 👤 steps (sign-in).
13. **67-edge-rebuild-approval-extra**: new.

### Day 3: unusual inputs, scale, upgrade
14. **52-edge-messy-column-names**: Part 1 (no AI) and Part 3. Part 2 is optional.
15. **55-edge-join-keys: Parts 1 and 2.** Part 3 (empty inputs) is covered by the
    0-row warning and C11's +0; run it only if time allows.
16. **57-edge-cross-joins: E2, E4, E6, plus lifecycle 1 (Stop mid-join) and 4 (R9:
    concurrent copies).** E1/E3/E5 are covered by 30/31/32. Lifecycle 2–3 are covered
    by 31's staleness checks; skip them. Lifecycle 5 (re-run) only for E2/E4.
17. **54-edge-nested-json: Parts 3 and 5.** Part 1 if time allows; Part 2 overlaps 20
    Part 5; Part 4 is optional.
18. **53-edge-wide-tables**: full (cheap). Checks the R10/R11 messages.
19. **64-edge-providers-and-network**: new, 👤 for anything that changes Settings or the
    network.
20. **65-edge-upgrade-and-secrets**: new.

### If time allows
21. **60-edge-plugins-and-explorer**: Part 1 (observe only) and Part 2 D1, D2, D7, D10.
22. Remaining optional parts listed above.

## 3. Report
Write one report for the whole plan in the run folder, with one Summary row per
scenario and the parts that were run. Also include:
- **R1–R12** each marked confirmed / refuted / not reached, with evidence (`_EDGE.md`
  asks for this).
- A **release verdict**: blockers (data loss, a security issue such as path traversal or
  secrets in logs, a crash) listed first.
- A **Left behind** section listing every E2E workflow, table, namespace and file created.
