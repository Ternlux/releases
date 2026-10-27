# How plugins are loaded and managed

When Ternlux starts, it scans its plugin folder, validates each plugin,
and registers the ones that pass.

## Discovery

Plugins live in a dedicated folder split in two: one sub-folder for
connectors, one for skills. Each plugin sits in its own directory, and
**the directory name is the plugin's id** (`postgres`, `mongodb`,
`pinecone`, `python-executor`). The id never changes after install, so
saved workflows always know which plugin to use.

A connector can be shipped but deliberately switched off. Such a plugin
is skipped at load, so nothing downstream — the assistant's connector
list, the IPC handlers, the transform prompts — ever sees it. (Redshift
is currently in that state.)

## Validation

A plugin is registered only if it declares its type correctly and
implements the behaviours that type requires:

- A **cloud-storage connector** must be able to test the connection, list
  containers, list objects, download, upload and delete objects.
- Every **other connector** must be able to test the connection, list
  tables, list columns, and run queries.
- A **skill** must provide a description and an execute action, and
  declare its category: transformer, join, or both.

A plugin that doesn't meet its requirements is skipped — the problem is
logged and the rest of Ternlux keeps running.

## Optional behaviours that unlock features

A plugin can opt into extra capabilities that Ternlux uses when present:

- **Streaming reads** — large sources are read a page at a time rather
  than all at once (this is what the output node's streaming path
  depends on).
- **Batch inserts** — destination writes happen in chunks. A connector
  can declare its own chunk size when the default is wrong for it:
  BigQuery turns each call into a load job against a daily quota, so it
  asks for larger chunks.
- **Quoting** — dialect-aware identifier quoting, used everywhere a
  generated statement names a table or column.
- **Table resolution** — asking the engine which object a configured name
  really names, so a name whose case doesn't match the catalog reaches
  the right table instead of creating a second one.
- **Preview queries** — the data preview uses the connector's own preview
  syntax.
- **Column types** — the type names used when a destination table has to
  be created. A connector without them falls back to SQLite's names,
  which is usually wrong, so the omission is logged loudly.
- **OAuth flows** — the connection form gets an Authorize button.
- **Transform prompts** — the AI uses the connector's own prompt when
  generating transformations for that engine.
- **Explorer behaviour** — its grammar for syntax checking, and a
  driver-level row cap so the Data Explorer never has to rewrite a
  statement to limit it.
- **Vector bulk fetch** and **vector operations** — the extra hooks the
  join and output paths use for vector stores.
- **Merge support** (`mergeSupport`) — the statement forms the engine
  accepts for "update the rows that match, insert the rest" (MERGE,
  `ON CONFLICT … DO UPDATE`, `ON DUPLICATE KEY UPDATE`) and one paragraph of
  dialect guidance. A join destination that declares it is offered the
  **merge** write mode, and the guidance is handed to the model that writes
  the statement; one without it is never offered merge. Nothing in it is
  executed, and the core never names an engine to decide this.

## Tracing

Connector and skill calls are wrapped so that, during a run, they land in
the execution log automatically: the query that was run, the table a
batch was written to, how far a chunked load had got, which object a name
resolved to. Configs are never logged — only an allowlist of
non-secret identifying fields.

## Install and uninstall

You can install a plugin from the catalog at any time. Ternlux downloads
the package, replaces the existing folder if any, and reloads the plugin
list, so the new connector or skill is available immediately. Installing
a **skill** for the first time needs a restart before the interactive
layer offers it.

Uninstall removes the plugin's folder and unregisters it. Workflows that
reference an uninstalled plugin fail to execute until it is reinstalled.
