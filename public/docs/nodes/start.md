# Start node

Every workflow begins with one Start node. Its only job is to decide when
the workflow runs. It is configured with a form: you pick a trigger type
and fill in what that type needs.

## Trigger types

- **Manual** — the workflow only runs when you run it yourself. This is
  the default and the right choice while you are building.
- **Schedule** — the workflow runs automatically on a recurring schedule.
- **File watch** — the workflow runs whenever a watched file or directory
  changes.

## Schedule

You choose a frequency and the fields it needs:

- **Hourly** — at a chosen minute past every hour.
- **Daily** — at a chosen time each day.
- **Weekly** — at a chosen time on a chosen day of the week.
- **Monthly** — at a chosen time on a chosen day of the month.
- **Yearly** — at a chosen time on a chosen day of a chosen month.

The form builds a standard five-field CRON expression and a
human-readable description ("Every Monday at 9:30 am") side by side, so
you can confirm the schedule reads the way you intended before saving.
Schedules fire in your machine's local time zone. The form defaults to
daily at 09:00 and will not save a schedule with a missing day or time.

## File / folder watch

You pick a path with the native file picker — a single file or a whole
directory — then choose which file-system events fire the workflow:

- For a file: added, changed, deleted.
- For a directory: the same three, plus directory added, changed and
  deleted.

Multi-select is allowed, and the default is "added" plus "changed". The
event list narrows to match whether you picked a file or a directory.

## What the Start node does at run time

At execution time the Start node is a no-op — it reads and writes
nothing. Its real role is to be registered with Ternlux's trigger system,
so that a schedule or watcher can fire the workflow even when you have it
closed. Saving the node registers its trigger immediately, and switching
it back to Manual unregisters whatever was there before, so you never end
up with an orphaned background job.

Triggers are also re-registered from every saved workflow at startup.

## Concurrency

The trigger system never starts a second run of the same workflow while a
previous run is still in progress. Trigger fires that arrive during an
active run are skipped.

## Persistence across reopens

The form reads the node's saved configuration, so reopening it restores
every selection — trigger type, frequency, day and time, watched path and
events.

## What is not supported

There is no webhook trigger. Nothing in Ternlux listens on an HTTP port
or registers an endpoint, so manual, schedule and file-watch are the
three ways a workflow starts.
