# Triggers

Triggers are what cause a workflow to run when you're not running it
yourself. They live on Start nodes and are registered with Ternlux when
the node is saved, and again for every saved workflow at startup.

## Trigger types

- **Manual** — no trigger is registered. You run the workflow yourself,
  from the canvas or the workflows list.
- **Schedule** — a recurring job fires on the schedule you chose: hourly,
  daily, weekly, monthly or yearly, at a time you pick. The form builds a
  standard five-field CRON expression, validated before it is registered,
  and it fires in your machine's local time zone.
- **File watch** — a watcher on a file or directory. The workflow runs
  when the watched location changes; you choose which events count
  (added, changed, deleted, and for a directory the same three for
  directories).

There is **no webhook trigger**. Ternlux does not listen on an HTTP port
and registers no endpoint.

## Lifecycle

Saving a Start node registers its trigger immediately, replacing whatever
was registered for that node before — so a schedule you just built starts
firing without restarting the app, and switching a node back to Manual
tears its old trigger down.

At startup Ternlux walks every saved workflow and registers the triggers
its Start nodes declare, so a scheduled workflow fires even if you never
open it. A workflow built by the chat assistant registers its triggers as
part of the build.

When you quit, all schedules and watchers are stopped before storage is
closed, so a trigger can never fire into a half-shut-down engine.

## Concurrency

Two safeguards keep triggered runs sane:

- **No overlapping runs.** If the same workflow is already running when a
  trigger fires, that fire is skipped.
- **Run isolation.** Each fire creates its own execution record, with its
  own id, log timeline and per-node metrics.

## Notifications and monitoring

Triggered runs send desktop notifications when the run starts, completes,
fails, or is stopped. They also appear in the app-wide execution monitor
like any other run, with the step they are on and a stop button — a
scheduled run is the one nobody was watching, so it gets the same live
account and the same per-node trace as a manual one.

Manual runs don't send notifications, since you're already watching the
canvas.
