# AI-driven E2E testing (Claude Code + Playwright MCP)

Claude Code drives the **real** Ternlux app — your real profile, connections and
workflows — through the Playwright MCP server, which attaches to Electron over
the Chrome DevTools Protocol (port 9333). It works through the scenarios in
`scenarios/`, checks results against ground truth computed from
`~/Desktop/Sample_data`, and writes a bug report.

## Run it

1. Quit any Ternlux window already open on your profile (Cmd+Q). The
   `npm run electron-dev` dev server can stay up — it's reused.
2. In Claude Code, from `frontend/`:
   ```
   /qa-run                                  # all scenarios
   /qa-run 04-chat-build-join-workflow      # one scenario
   /qa-run 01 02 --packaged                 # against /Applications/Ternlux.app
   ```
   The first time, Claude Code asks you to approve the project MCP server
   `playwright` (from `.mcp.json`). Restart Claude Code after adding/changing
   `.mcp.json`.
3. The report lands in `runs/<date_time>/report.md`, next to its screenshots.

Manual control of the app:

```
bash testing/e2e/app.sh start [--packaged]   # launch with the CDP port
bash testing/e2e/app.sh status
bash testing/e2e/app.sh logs                 # main-process log (IPC errors show here)
bash testing/e2e/app.sh stop
```

## Pieces

| File | Role |
|---|---|
| `.mcp.json` | Playwright MCP, pinned, `--cdp-endpoint http://127.0.0.1:9333` |
| `testing/e2e/app.sh` | Starts the app with `--remote-debugging-port`, captures the main-process log |
| `.claude/skills/qa-run/SKILL.md` | How the agent tests: data-safety rules, evidence, report format |
| `testing/e2e/scenarios/*.md` | What to test. Copy `_TEMPLATE.md` to add one |
| `testing/e2e/runs/` | Reports, screenshots, logs (git-ignored) |

## Scenarios

| # | Covers |
|---|---|
| 01–06 | App tour, Data Explorer, editor, chat builder, chat modify, chat analyst |
| 10–15 | One per database (Postgres, MySQL, SQL Server, Snowflake, BigQuery, MongoDB): output (seed), source, transform (new / local / in place), join (same connection, join types), output from a join. All follow **Recipe D** in `scenarios/_DATASET.md` |
| 20 | Local file types: CSV, JSON, Excel (multi-sheet), Parquet, Avro, DuckDB, SQLite. Write each, read each back, transform in place, join across formats |
| 21 | Cloud storage (S3, GCS, Azure, Dropbox, Drive, OneDrive) and Google Sheets: output, source, refresh, joins |
| 22 | REST API: fetch, failures, credential placeholders, transform, join two APIs, output |
| 30 | Cross-connection joins: every database joined with a different one, into every destination kind (SQL, document, local); all four join types plus an anti-join |
| 31 | Join chains: transformer (new table / in place / local) → join, pull local → join into a DB, local join → output, an output or join writing into its own source, join → join, self-join, incremental anti-join; regression checks for the 2026-10-03 join fixes |
| 32 | Joins with LanceDB / Pinecone: vector store into SQL, two vector stores, similarity joins into SQL and Mongo, SQL joins into LanceDB / Pinecone, chains through a vector read |
| 33 | Join write modes (replace / append) on SQL, local, Mongo and Snowflake; local DuckDB on the shared CREATE + INSERT contract; target-is-also-a-source guards for joins and outputs; regression checks for the 2026-10-05 fixes |
| 40 | Vectors, LanceDB: embed, re-run skipping, update/delete/tag records, plain join, similarity join, join into a vector table |
| 41 | Vectors, Pinecone: the same, plus Output write modes and moving vectors from LanceDB without re-embedding |

| 50 | Edge setup: generate fixtures (`fixtures/make_edge_fixtures.py`), add them, load-check messy CSV, odd file names, Excel layouts, nested and 56 MB JSON, 150/1,100-column tables |
| 51 | Messy values into every destination and back; type-inference traps (late long text, late "N/A", int32 overflow, leading zeros, big ints); partial writes |
| 52 | Messy column names (spaces, dots, `$`, reserved words, unicode, emoji, 70 characters, duplicates) through outputs, transformers, joins |
| 53 | Wide tables in the UI, the AI and each engine's column/row-size limits |
| 54 | Deeply nested JSON into Mongo, Postgres, Snowflake, BigQuery; flattening; a late-appearing field; big JSON |
| 55 | Join-key traps: NULLs, duplicates, spaces, leading zeros, case, int vs text across engines, empty inputs |
| 56 | Data safety: output into its own source, join or transformer target = input, hostile and odd table names |
| 57 | Cross-join edges: nested/vector/unicode staging, many-to-many, cartesian, 300k staging, reported vs actual counts, stop, re-point, concurrent copies |
| 58 | Workflow ops: odd names, deleting in-use connections and mid-chain nodes, invalid wiring, concurrency, 12 nodes, version revert, persistence |
| 59 | Chat edges: prompt injection in data, hallucination checks, ambiguity, long and multilingual input, cancel and concurrent messages |
| 61 | Existing SQLite/DuckDB file connections (incl. 1M- and 10M-row files) as source, in-place transformer, join input and output target; file locks; self-overwrite. Google Sheets source, new tab, append/truncate, mismatched columns, odd tab names |
| 60 | Plugin catalog (install; uninstall gap) and Data Explorer edges |
| 62 | Start-node triggers: CRON and file watch firing, re-registered after restart, failures recorded, a triggered run with a pending join rebuild refused |
| 63 | Account sign-in (email, Google), plugin-connector gating, sign-out, expired token, offline start (👤) |
| 64 | AI provider switch and failures (invalid key, timeout), network loss mid-build and mid-run (👤) |
| 65 | Old workflows still run after upgrades; importing with missing connections; secrets sweep of logs, prompt logs, workflow-code and exports |
| 66 | Smoke on the installed (packaged) app: plugins, native modules, docs, local/staging/vector runs, a build |
| 67 | Remaining kept-target rebuild paths: two rebuilds in one Execute, approval reset by an edit, rebuild on a table the join reads, merge back on MySQL |

**Release plan:** `RELEASE-REMAINING.md` lists what is left before release, in order, with the
parts to run and skip. Run it with `/qa-run testing/e2e/RELEASE-REMAINING.md`.

`scenarios/_EDGE.md` lists the R1–R12 risks found by reading the code; the edge
scenarios confirm or refute each.

Run 10–15 before 21 (step 2 of Part 3), 30, 31 and 32, since they seed the `e2e_*` tables; 32 also needs 40 and 41.
Every expected number comes from four small CSVs (5 stores, 20 employees,
30 products, 108 product listings) and is listed in `scenarios/_DATASET.md`.
Steps marked 👤 need a macOS file dialog or OAuth window: the agent stops and asks you to do them.

## Writing scenarios

Describe **goals and checks**, not click paths — the agent explores the UI the
way a new user would, and anything hard to find becomes a finding. Put the
expected numbers under **Ground truth**, computed from the source files, never
from the app itself.

## Limits

- **Real data.** The agent prefixes everything it creates with `E2E ` / `e2e_`,
  never edits pre-existing workflows or connections, and writes new tables
  rather than in place. Your profile will still accumulate `E2E …` workflows
  and chat sessions; delete them when you like. Runs also send the app's
  normal analytics events.
- **Native OS dialogs** (file pickers, save dialogs, keychain prompts) are
  outside the web page, so the agent can't drive them. Use connections that
  are already imported, and outputs that don't ask for a path.
- **OAuth flows** open the system browser, so they aren't covered.
- **The AI is non-deterministic**, so scenarios check outcomes (row counts,
  columns, refusals), not wording. Chat scenarios cost real LLM tokens.
