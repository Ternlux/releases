# Workflow builder

When you ask the [chat assistant](README.md) to create or change a
workflow, a focused workflow-builder takes over the conversation. Its job
is to turn what you describe in plain language into a real workflow — a
graph of nodes and edges — without you drawing the graph yourself.

The builder never changes anything on its own. It produces a **plan** you
review, and only your acceptance turns that plan into nodes.

## New workflow vs. modify

The first thing the builder decides is the target:

- **A brand-new workflow** when your request describes a self-contained
  pipeline that doesn't refer back to anything that already exists.
- **A change to an existing workflow** when your request adds to, removes
  from, fixes, or otherwise refers to a specific workflow.

Having a workflow open in the editor does **not** by itself mean you want
to change it — the builder treats "open" as a hint and confirms if it's
ambiguous. It also honours a mid-conversation change of mind: if you
start by modifying and then say "make it a new workflow," the latest
intent wins.

## Gathering the details

Before it can plan, the builder asks one short, specific question at a
time, naming the connections, tables and columns it already knows so you
can answer quickly. Each question and answer become part of the
conversation, and it never re-asks something already answered.

It forwards your answer even when the answer looks vague — "whatever you
think", "just use the defaults", "the second one" are all answers, and
the planner is the one that decides whether it has enough.

The details it gathers map to the per-node templates documented under
[Chat prompts](../chat-prompts/README.md), because each node is
ultimately built by them. Broadly:

- **Start** — how the workflow is triggered.
- **Data source** — which saved connection, and which table, collection
  or index it reads.
- **Transformer** — the reshaping logic in concrete terms, whether it
  creates a new table or updates in place, and where the result lives.
- **Join** — for every pair of sources, the join keys and join type, the
  columns to keep, and the destination.
- **Output** — where the result is written, and (for a connection
  destination that keeps rows between runs) whether to append or
  truncate.

The builder is told to describe **only what you asked for**. Anything you
left unsaid is the planner's and the node builders' to decide — they know
each node type's defaults. An invented detail would become part of the
brief the change reviewer later grades the build against.

### Calling a REST API before planning around it

A database tells you its shape; a REST endpoint only answers by being
called. So when the workflow reads from a REST API connection, the
builder must call it first — generating a function that resolves the
connection's saved credentials itself, which you approve — read the rows
that come back, and only then propose a plan describing the fields it
actually saw. This is enforced, not merely advised: a plan submitted
without a successful call is refused with the reason.

If the call fails or returns nothing, the builder stops and tells you what
it called and what came back, rather than guessing at another endpoint.

### What chat can't configure

**Cloud-storage** sources and destinations (S3, GCS, Azure Blob,
Dropbox, Google Drive, OneDrive) and **Google Sheets** need the editor's
native picker. If your pipeline needs one, the builder tells you to add
and configure that node in the editor first; chat can then build every
transformer, join and output downstream of it, because its data is
materialised on disk and read in place.

## Proposing a plan

Once it has enough, the builder submits the request to the **planner**,
which writes a fresh, self-contained description of the workflow you want
*now* — synthesised from the whole conversation, not just your first
message — and produces one of three results:

- **A clarifying question**, surfaced to you directly; your next message
  is the answer.
- **A finished plan** — a flat, ordered list of build steps, one per
  node, each carrying the exact instructions used to build that node.
- **An error**, when it could not produce a valid plan after retrying.
  The plan envelope is validated on every attempt and the validator's
  complaint is fed back to the model, so a malformed plan is corrected
  rather than shown to you. If the plan was simply cut off mid-way, you
  get a Continue button that finishes it.

### The plan model

The planner thinks in the five node types the editor uses, wired as a
directed graph that flows `start → data source → (transformer | join)*
→ (output?)`:

- **Start** is always step zero and decides only *when* the workflow
  runs; data sources attach to it automatically.
- **Data source** is the only node that brings external data in — one
  connection per node, so N inputs means N data-source nodes. Each names
  the exact saved connection.
- **Transformer** takes exactly one upstream and reshapes it. It is a
  terminal write, and its destination can only be its own source
  connection or local storage.
- **Join** takes two or more distinct upstreams and merges them —
  including similarity matching — and also writes its result as it runs.
  Each names where it writes: a saved connection, a local table, or a
  local vector table.
- **Output** is added only to deliver the result somewhere the upstream
  can't write itself: a file export, a different connection or table, or
  the same table under a write mode a transformer lacks. A join appends or
  merges by itself (its own append / merge modes), so it needs no Output for
  that. If the
  pipeline already ends at a transformer or join's own target, no output
  node is planned.

A modify plan is the **complete** target step list, not a patch: every
existing node appears exactly once, as a keep, a modification, or in the
list of nodes to delete. That invariant is checked before anything is
built.

## Accept or cancel

A finished plan is shown as an **Accept / Cancel** card describing the
steps it would build.

- **Accept** applies the plan. If the editor has unsaved canvas changes
  they are committed first — a build plans against the saved workflow, so
  it would otherwise overwrite them. Then the builder runs every step in
  order and writes the workflow once. Triggers declared by the start node
  are registered immediately.
- **Cancel** discards the plan and changes nothing.

Proposing is not applying: a plan never modifies your workflow until you
accept it.

## Watching it build

The build streams its progress. Each node's card appears on the canvas
the moment its step starts and fills in as it completes, and the chat
shows a live log of the steps and the stage each one is in. When the walk
finishes, the settled layout and edges are drawn and the workflow is
saved.

A step decides for itself whether to build, rebuild or keep: a node the
plan asked to keep is rebuilt only if an upstream node's **output shape**
actually moved under it, in which case it is rebuilt from its own prior
conversation rather than from a stale first request.

## Pauses and resumes

A build can stop mid-way and come back:

- **A builder needs an answer** (including a question raised by a skill).
  The question is put to you in the chat, and the steps already built are
  carried forward so answering resumes from the step that asked instead
  of rebuilding the whole plan.
- **A step's AI call ran out of room.** You get a Continue button that
  finishes just that call.

A build that fails says why in the thread — the builder's own reason,
which is usually actionable ("the API call for X returned no rows —
check the endpoint and the credentials on the connection") — and the
workflow is left as it was.

## How a built node matches a hand-built one

Each step is built by the same logic the assistant uses for a single
node, so a node the builder creates is configured exactly as one you'd
build by hand: it samples live tables to confirm columns, generates the
same kind of operation (SQL, document operation, JavaScript, REST fetch,
or a skill), and records the same deterministic local paths. Where a
request is a better fit for a skill, that skill takes over the step.

Nothing the build produces has **run**: every node it materialises is
recorded as not-yet-executed, so previews and downstream readers know the
table is not there yet.

## After the build

The finished workflow is reviewed against the conversation that produced
it before you run it — see the change review in
[Chat assistant](README.md#after-a-build-the-change-review).

## Related

- [Chat assistant](README.md) — the conversation panel and the two-agent
  hand-off that reaches the builder
- [Chat prompts](../chat-prompts/README.md) — the templates each node is
  built from
- [Nodes](../nodes/README.md) — what each node type does at run time
- [Externalized node code](../architecture/workflow-code.md) — how the
  SQL/JS/Python a built node carries is stored on disk
