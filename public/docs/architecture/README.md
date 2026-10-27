# Architecture

Ternlux is a desktop application that runs entirely on your machine. The
visual canvas, the AI chat panel, and the workflow editor live in the
foreground. A background engine handles secret storage, plugin loading,
external connections, AI calls, scheduled triggers, and the actual
execution of workflows.

## Contents

- [Runtime topology](runtime-topology.md) — what runs where, and what's
  stored locally
- [Boot order](boot-order.md) — what happens when Ternlux starts up and
  shuts down
- [Execution log](execution-log.md) — how each workflow run is recorded,
  traced, and stopped
- [Output validation](output-validation.md) — how a workflow checks its
  own output when a run finishes
- [Externalized node code](workflow-code.md) — how node SQL/JS/Python is
  stored as files under `workflow-code/` and kept in sync with the editor

## Key ideas

- **Your data stays local.** Workflows, connections, execution history,
  chat sessions, and node results live in files inside your user data
  directory — they are not stored on Ternlux's servers. A Ternlux account
  is used only to sign in and to download plugins; the data you work with
  never leaves your machine except to the services you choose to connect
  (see [Runtime topology](runtime-topology.md)).
- **Secrets are encrypted at the OS level.** Database passwords, API
  keys, and AI provider keys are stored using the operating system's
  secure storage (Keychain on macOS, Credential Store on Windows,
  Secret Service on Linux). They are decrypted only at the moment a
  connection or AI call is made. On a Linux session with no keyring,
  Ternlux falls back to a key that is not yours and says so in the UI
  rather than pretending the keys are protected.
- **The visual canvas never sees secrets.** Generated SQL, JavaScript,
  and REST API fetch code uses placeholder tokens for credentials. The
  background engine substitutes real values just before executing.
- **Files are queried, not imported.** Local files are read where they
  lie by DuckDB. Nothing is copied into a staging store when you add a
  file, and nothing is converted.
- **One database per workflow.** Everything a workflow materialises — a
  transformer's new table, a join's result, the rows a REST API source
  fetched — is a table in `workflow-data/<workflowId>.duckdb`. Two
  workflows running at once never touch the same file, and a table name
  only has to be unique within one workflow.
- **One execution log.** Every run — manual, single-node, scheduled, or
  file-watch — appends to the same execution history, with per-node
  timing, record counts, a full statement-level trace, and the reason it
  ended.
