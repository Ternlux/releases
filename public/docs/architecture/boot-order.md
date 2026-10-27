# Startup and shutdown

Ternlux goes through a fixed sequence before showing you the main window,
and another on the way out. Understanding both explains why the first
moment after launch can feel slower than navigating afterwards, and why
quitting during a run is not instantaneous.

## What happens at launch

1. **Secret storage is settled.** On Linux, Ternlux decides whether the
   desktop keyring is usable before anything is encrypted; when there is
   none it enables the in-memory fallback so saving a key still works.
   The choice is reported to the UI, which warns wherever a secret is
   about to be typed in.
2. **Execution engine is wired up.** The components that run
   transformations, joins, REST API fetches and skills are connected to
   the credential store and the AI helpers.
3. **Plugins are discovered.** Every installed connector and every
   installed AI skill is loaded from the plugin folder. Each is checked
   to make sure it implements the required behaviours; broken plugins
   are skipped and logged, and the rest of the app carries on.
4. **Interrupted runs are closed out.** Nothing survives a process exit,
   so any execution still marked "running" belongs to a previous session
   that was quit or crashed mid-run. Those rows are marked failed with
   "Execution was interrupted", which is what keeps the execution monitor
   from showing a ghost run forever. The node it died on is left recorded.
5. **Saved triggers are reactivated.** Ternlux walks through every saved
   workflow and re-registers any schedule or file watcher its Start node
   declares. From this moment on, scheduled workflows can fire even if
   you never open the workflow.
6. **Main window appears**, and the auto-update check is set up.

## What happens at shutdown

When you quit Ternlux, the background engine performs a graceful
teardown:

1. All scheduled jobs stop firing.
2. All file watchers stop watching.
3. The editor's code watchers stop.
4. Every attached workflow database is checkpointed and DuckDB is closed,
   so no workflow is left with a write-ahead log beside its file.

Triggers stop before storage is torn down, so a trigger can never fire
into a half-shut-down engine.
