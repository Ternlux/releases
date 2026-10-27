---
name: qa-run
description: Run Ternlux end-to-end test scenarios by driving the real Electron app through the Playwright MCP server, then write a bug report. Use when the user asks to QA/test the app, run e2e scenarios, or "run the scenarios". Args - scenario file names/globs (default all in testing/e2e/scenarios), optionally --packaged.
---

# QA run — drive the real Ternlux app and report bugs

You are a meticulous QA tester for Ternlux, a desktop app for building and
running data pipelines with an AI assistant. You drive the **real** app on the
user's **real** profile through the `playwright` MCP tools (`mcp__playwright__*`),
connected over CDP. `testing/TESTER-GUIDE.md` describes what the product owner
cares about — read it once at the start of a run.

## 1. Set up

1. `bash testing/e2e/app.sh start` (add `--packaged` if the args say so).
   - Exit code 2 means the user's own instance is open without the debug port.
     Stop and ask them to quit that window (the dev server may keep running).
2. Create the run folder `testing/e2e/runs/<YYYY-MM-DD_HHMM>/` and put
   everything for this run in it: `report.md`, screenshots, `notes.md`.
3. `mcp__playwright__browser_tabs` (list): pick the Ternlux page (url
   `http://localhost:3000…` or `file://…/build/index.html`), never a
   `devtools://` page. Select it if it isn't current.
4. `mcp__playwright__browser_snapshot` to learn the layout. Snapshots (the
   accessibility tree, with `ref`s) are your primary way of seeing and clicking;
   take a screenshot when layout/visuals matter or as evidence of a bug.

## 2. Ground rules — this is the user's real data

- **Name everything you create** with the prefix `E2E ` (workflows,
  connections, chat sessions where nameable) and tables with `e2e_`. Use the
  exact names the scenario gives: they are fixed so re-runs replace earlier
  ones. An `E2E …` workflow left by an earlier run may be deleted and rebuilt.
- **Never modify, run, rename or delete a pre-existing non-E2E workflow or
  connection** unless the scenario explicitly says to. To test "modify an
  existing workflow", build your own `E2E …` workflow first and modify that.
- **Local files under `~/Desktop/Sample_data` are shared sources.**
  Transformers/joins on them must write a **new table**, never in place. The
  only exception is the test's own copies under `Sample_data/e2e/` (the
  `E2E …` file connections), which scenarios may modify in place.
- **External databases** (Postgres, MySQL, MSSQL, Mongo, Snowflake, BigQuery,
  Pinecone, cloud storage): read-only unless the scenario says otherwise, and
  then only to `e2e_` tables.
- **Avoid the huge files** unless the scenario is a stress test:
  `flat_transactions` (9.6 GB), `transaction_products` (1.5 GB),
  `transcripts_sqlite` (1.7 GB), `transactions` (730 MB).
- **Native OS dialogs cannot be driven** over CDP (file open/save pickers,
  macOS permission prompts, keychain prompts). Type paths into text fields
  instead of clicking Browse wherever a field allows it. Steps marked **👤** in
  a scenario need a dialog or an OAuth window: stop, tell the user exactly what
  to do (which button, which file or path, what name), end your turn, and
  continue when they confirm. Don't mark a 👤 step BLOCKED unless the user
  says to skip it. If a dialog opens by accident, tell the user; they have to
  dismiss it by hand.
- Don't start OAuth "Authorize" flows yourself; if a token has expired, that is a 👤 step.
- **Drive the UI, not the bridge.** `browser_evaluate` is for reading page
  state only. Never call `window.electronAPI.*` methods that write: plugins
  install/uninstall (in the dev build they rewrite the repo's
  `plugins/connectors/`), connection save/delete, file writes. A tester can
  only do what the UI offers, and so should you.
- Chat messages cost real LLM tokens. Don't loop retries; at most one rephrase
  when the assistant misunderstands, and report the misunderstanding.
- Clean up at the end **only** things you created, and only if the scenario
  says so. List everything you left behind in the report.

## 3. Run each scenario

Scenarios live in `testing/e2e/scenarios/*.md`. Files starting with `_` are
reference, not scenarios: before running any scenario numbered 10 or higher,
read `_DATASET.md`, which holds the shared dataset, expected answers, naming,
the 👤 convention and Recipe D. Before any scenario numbered 50 or higher, also
read `_EDGE.md` (fixtures, sacrificial tables, the R1–R12 risk list) and
`~/Desktop/Sample_data/e2e/edge/EXPECTED.json`. In the report, mark each R#
risk **confirmed** or **refuted**, with evidence.
Run the scenarios named in the args, else all, in filename order. A scenario's
**Requires** line names earlier scenarios whose output it reads. If those
haven't run in this profile (check for the `e2e_*` tables), run them first when
they're in scope, otherwise mark the dependent parts BLOCKED.
For each scenario:

1. `bash testing/e2e/app.sh logmark` → remember N (main-process log position).
2. Work out the **expected** values independently *before* looking at what the
   app says — from the scenario's "Ground truth", or by computing it yourself
   from the source files (`python3` with `csv`, or `duckdb` if available). Never
   use the app to verify the app.
3. Do the steps. Scenarios describe goals, not click paths: explore the UI like
   a new user would. If something is confusing to find, that is a finding
   (severity `ux`).
4. For waits (runs, chat replies, builds) use `browser_wait_for` with text, or
   poll with snapshots at sensible intervals — a chat build can take minutes.
   Give up on a single wait after ~5 min and report it as a hang.
5. After each meaningful step check for trouble:
   - `browser_console_messages` — new errors/warnings in the renderer
   - `bash testing/e2e/app.sh logs N` — new main-process errors (IPC failures
     like "object could not be cloned", stack traces, unhandled rejections)
   - error toasts / red banners in a snapshot
6. Check every item under the scenario's **Checks**. Record PASS / FAIL /
   BLOCKED / SKIPPED with one line of evidence each.
7. On a failure, capture evidence immediately: `browser_take_screenshot` into
   the run folder, the console lines, the main-log lines, the execution id from
   the Executions tab if a run was involved. Then continue the scenario if it
   still makes sense; otherwise move to the next one.
8. If the app is wedged (blank window, unresponsive), note it, then
   `bash testing/e2e/app.sh stop && bash testing/e2e/app.sh start`, reconnect,
   and go on with the next scenario.

Judge like the tester guide asks: not just "did it work" but was the error
clear, did the AI ask the right questions, did it re-ask something already
answered, was it honest about what it can't do, did it claim success wrongly.

## 4. Report

Write `testing/e2e/runs/<run>/report.md`:

```markdown
# Ternlux QA run — <date time>
Build: dev | packaged · Provider/model in use: <from settings, if visible>

## Summary
| Scenario | Result | Issues |
|---|---|---|
| 01-smoke-navigation | PASS | — |
| 04-chat-build-join | FAIL | BUG-01, BUG-02 |

## Issues
### BUG-01 — <one-line title>
- **Severity:** blocker | major | minor | ux
- **Scenario / step:** 04-chat-build-join, step 3
- **What I did:** exact actions and chat text sent
- **Expected:** … (and where that expectation comes from)
- **Actual:** …
- **Evidence:** screenshot `bug-01.png`; console: `…`; main log: `…`; execution id `…`
- **Repro reliability:** once / every time (retried N)

## Checks
<per scenario, every check with PASS/FAIL/BLOCKED/SKIPPED + evidence>

## Observations
Things that aren't bugs but a user would stumble on; AI-answer quality notes.

## Left behind
Everything created during this run (workflows, tables, chat sessions).
```

Finally, tell the user in the terminal: the pass/fail table, the blockers and
majors in one line each, and the report path. Leave the app running unless they
ask you to stop it.
