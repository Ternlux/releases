# Execution log

Every workflow run writes a record into the execution history. This is
what the Executions tab displays, what the live execution monitor reads,
and what you use to confirm a run succeeded, debug a failure, or audit
when a workflow last produced output.

## What's captured for each run

- A unique execution id, and the workflow's id and name.
- The status: running, completed, failed, or cancelled.
- Start time, end time, and total duration.
- How the run was triggered (manually, as a single node, by a schedule,
  or by a file change), including which trigger node fired it.
- Which node is executing **right now**, and how many steps there are —
  written before each node starts and cleared when the run ends. This is
  what lets the canvas and the monitor light up a node while it works.
- A per-node breakdown: node name and type, when it started, how long it
  took, whether it completed, failed or was cancelled, and how many
  records it processed. Each entry is written as soon as that node
  finishes, not at the end of the run.
- A timeline of log entries, each tagged info / warn / error and with the
  node it belongs to.
- A summary with the total records processed and a one-line outcome.
- The [output-validation](output-validation.md) verdict, when the
  workflow has one.

## The per-node trace

Beyond "node X completed", each node records what it actually did: the
SQL and DDL that ran, a DDL that was skipped and why, which connector
call was made against which table, how far a chunked load had got, and
the error text a driver returned. Connector and skill calls are traced
automatically, so the trace covers transformers, joins, outputs, skills
and output validation alike.

Two limits keep the record readable and the store healthy: a single
statement is truncated past a few thousand characters (with a note
saying how much was dropped), and a run stops adding entries after
5,000, with a line saying the output was truncated. Connection configs
are never logged — only an allowlist of identifying, non-secret fields
such as host, database, schema, warehouse, project or bucket.

## How a run progresses

1. The execution record is created with status "running".
2. Ternlux walks the workflow's execution order step by step.
3. For each node it records which node is in flight, dispatches it to the
   right handler, drains that node's trace, and writes the node's result.
4. A node that fails stops the run: the failure is logged and the
   execution is marked failed with the error message.
5. A node that succeeded but had nothing to do — an empty source, a join
   that matched nothing — is logged at warn level and shown amber, so a
   run that wrote nothing never looks like one that wrote everything.
6. If every node succeeds, output validation runs (when enabled), the
   summary is filled in, and the run is marked completed.

## Stopping a run

A run in flight can be stopped from the execution monitor.

Cancellation is **cooperative**. There is no abort signal threaded
through a driver, and killing a connector call mid-write would leave a
half-written table with nothing recording how far it got. So a stop is
observed in two places: between steps, and inside the long loops within
a node — batch inserts, chunked source reads, embedding batches. The
call already in flight finishes; the next one does not start.

That means:

- The granularity of a stop is one batch, not one row.
- Rows already written stay written. Nothing is rolled back, and the
  summary names the node it stopped inside and how far that write got
  ("12,000 rows already written to sales").
- A stopped run is recorded as **cancelled**, not failed, and the node it
  interrupted is marked cancelled rather than ringed red.
- Output validation is skipped for a cancelled run: a run that was cut
  short never got the chance to produce what it was meant to.

## Concurrency rules for triggered runs

When a workflow is fired by a schedule or a file change, Ternlux ensures
the same workflow does not start a second run while a previous one is
still in progress. Triggers that arrive during an active run are skipped
and noted. This protects you from overlapping runs that double-write to
the same destination.

## Interrupted runs

Nothing survives a process exit, so an execution still marked "running"
at startup belongs to a session that was quit or crashed. Those are
closed out as failed with "Execution was interrupted (the app closed
while it was running)", keeping the node they died on.

## Notifications

Triggered runs send desktop notifications when the run starts, when it
completes, when it fails, and when it is stopped. Manual runs do not —
you are already watching them, and the execution monitor shows their
progress live.
