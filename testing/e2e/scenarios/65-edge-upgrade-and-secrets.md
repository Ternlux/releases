# 65-edge-upgrade-and-secrets

**Area:** workflows saved by older builds still running correctly; importing a workflow whose
connections don't exist here; a sweep for secrets in every file the app writes
**Uses:** existing E2E workflows built before 2026-10-05; Postgres, Pinecone
**Cost:** none (no AI builds)
**Requires:** 30, 31, 32 (their workflows exist)

## Ground truth
- Workflows built before the 2026-10-05 changes: local joins saved as a bare SELECT (E2E X7
  before its rebuild, E2E X9), joins with no `operationMode`, Pinecone sources saved
  without a namespace (E2E V4 — known to run with 0 rows), outputs from 10–15.
- Secrets that must never appear in logs, prompt logs, `workflow-code/`, exports or chat
  exports: LLM API keys (`sk-…`, `sk-ant-…`, `AIza…`), database passwords, Pinecone key,
  OAuth access/refresh tokens, the account JWT. `llm-config.dat` and `db-credentials.dat`
  are encrypted stores — never print or copy their contents.

## Steps
1. **Old workflows still run.** Execute, without rebuilding: E2E X9 (old local 3-way →
   Phoenix 7439.05 / LA 1640.20), E2E X2 (mssql, 108), E2E C3 (local transformer → Postgres,
   108), E2E V7 (SQL join → local LanceDB, 108), E2E Postgres Seed (5/20/30/108). All succeed
   with the same results as their original reports.
2. **Old Pinecone join without a namespace.** Execute E2E V4: it runs with **0 rows**. Does
   anything warn the user (toast, execution log, node)? A silent 0 is the finding to record
   (severity: correctness on upgrade). Do not rebuild it.
3. **Import with missing connections.** Take any E2E workflow's export (export it from the
   Workflows list; 👤 if a save dialog appears), edit a copy so one Data Source names a
   connection id/name that doesn't exist (`E2E missing conn`), import it as
   `E2E Import Missing`. Expected: a warning naming the unmatched source(s); the editor
   opens; Execute is refused or that node fails with a clear message — never a crash or a
   run against a wrong connection.
4. **Secrets sweep.** In a terminal (read-only), search for secret-looking strings in:
   - the main-process logs under `testing/e2e/runs/logs/`
   - `dev-logs/` (prompt logs)
   - `~/Library/Application Support/Ternlux/workflow-code/`
   - any workflow export and chat export you created in this run
   Patterns: `sk-[A-Za-z0-9_-]{20,}`, `sk-ant-`, `AIza[0-9A-Za-z_-]{30,}`, `pcsk_`,
   `password"?\s*[:=]\s*"[^"]{3,}`, `refresh_token`, `access_token"?\s*[:=]`, `Bearer [A-Za-z0-9._-]{20,}`,
   `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` (JWT). Report the file and line **with the
   secret redacted** (first 4 characters only). Any hit is a release blocker.
5. **Chat export.** From the chat's ⋯ menu export one conversation that used a database
   connection and a REST API (👤 if a save dialog appears) and run the same patterns on it.

## Checks
- [ ] Older workflows run unchanged with their original results
- [ ] The no-namespace Pinecone join's 0-row result is reported to the user (or the silent 0 is recorded as a finding)
- [ ] Import with a missing connection: named in a warning, never runs against the wrong source
- [ ] Secrets sweep: no hits in logs, prompt logs, workflow-code, exports
- [ ] No renderer console errors or main-process errors

## Cleanup
Delete `E2E Import Missing` if it can't be fixed; list everything left behind.
