# Chat assistant

The chat assistant is the app-wide conversation panel. It talks about
your whole workspace — your saved workflows, your connections, your
execution history — runs live queries and requests to answer questions
with real data, builds and modifies workflows, and configures the two
node types that have no form of their own.

## What it can do

- **Answer questions about your workspace** — list and inspect workflows,
  connections, and past executions, and read this documentation to
  explain how Ternlux behaves.
- **Fetch live data** — run a read-only query against any saved
  connection, call a public HTTP endpoint, or generate a one-off
  JavaScript function for logic a single query can't express (per-row AI
  calls, embeddings, orchestrating several sources, an authenticated API
  call). These compute an answer to show you; they do not save anything.
- **Chart results** — when a result reads better as a picture, the answer
  can include visuals (bar, line, pie, scatter, KPI, or a table) built
  from the rows it just fetched. Anything that would otherwise be a
  markdown table is rendered as a real grid.
- **Build and modify workflows** — when you ask to create or change a
  workflow, the assistant hands the conversation to a focused
  workflow-builder that gathers the missing details and proposes a plan
  for you to accept. See [Workflow builder](workflow-builder.md).
- **Build the node you have selected** — with a Transformer, a Join, or a
  REST API Data Source selected on the canvas, the assistant gains one
  build tool for that node and nothing else.
- **Author an output-validation function** — a workflow can be given a
  function that checks its own output at the end of every run. See
  [Output validation](../architecture/output-validation.md).

## What it cannot do

- **Change data.** Its query tool is read-only in both modes, and a
  generated function's data access is wrapped read-only too. Writes
  happen when a workflow runs.
- **Start a run.** After building a node it offers you a Run button;
  accepting a plan builds the workflow but does not execute it. Running
  is always your click.
- **Pick a bucket, object or spreadsheet.** Cloud storage and Google
  Sheets need the editor's native picker.
- **Configure a Start, Data Source or Output node's form.** Those are
  filled in beside the canvas; the assistant's one exception is
  authoring a REST API request on a Data Source.
- **Touch a node you haven't selected.** Only the focused node's build
  tool exists, so changing another node means selecting it — or asking
  for a workflow-level change, which goes through the planner. One
  exception keeps a conversation intact: while a node's builder is waiting
  for your answer, that node stays in focus even if you close its panel or
  click the canvas, until the question is answered (or you select another
  node, remove the chip, or close the workflow).
- **Make an authenticated request itself.** It has no headers, no body
  and no credentials on its HTTP tool; anything needing a saved
  credential goes through a generated function that resolves it at run
  time, after you approve the code.

## Two agents, one conversation

Behind the single panel the assistant runs in one of two modes and
switches between them automatically. You never pick a mode.

- **Main mode** is the general-purpose helper. It knows how to look at
  workflows, connections and executions, run queries, call endpoints,
  read the docs, and build the focused node. It knows nothing about
  designing a whole workflow — its only whole-workflow action is to
  recognise that you want one and hand over.

- **Workflow mode** is a focused sub-agent that takes over after that
  hand-off. It owns the node and chat-prompt reference material, asks the
  clarifying questions needed to build what you described, and asks the
  planner to produce a plan. When the plan is accepted, the build is
  cancelled, or you change the subject, it hands control back.

The hand-off is explicit each way. Until the builder hands back, your
messages are answered by the builder, not by the main assistant. Each
reply is labelled with the agent that wrote it — main assistant, workflow
builder, planner, node builder, change reviewer, or a named skill.

A node's **Run this node** card only works while that node's workflow
is open: with the workflow closed, or another one open, the button is
disabled and says which workflow to open.

Every message also records what it was about — the workflow in view and
the node in focus — and that travels with the history the assistant
reads, as a `[context: …]` line ahead of each earlier turn. So the
assistant can tell a node builder's question from its own replies, and
which node and workflow a past exchange concerned, even after you have
moved on. Closing the assistant only hides it; the conversation, a
half-typed message and any pending approval are exactly as you left them
when you open it again.

## How a turn works

The assistant works one turn at a time. On each turn it either runs tools
and waits for the results, or answers you. Independent look-ups are
batched into a single turn (up to five); anything that depends on a
previous result waits for the next. A short live status line is shown
while it works, and on providers that expose it, the model's reasoning is
available in an expandable block.

A question is given at most eight turns. The same tool called twice with
identical arguments is refused with a pointer back to the earlier result —
unless that call failed, or its result has since been trimmed out of the
window, in which case it stays retryable.

Providers with a real tool API get structured tool calls; everything else
(Gemini, local model servers, unknown OpenAI-compatible endpoints) uses a
JSON reply contract instead. When a reply cannot be parsed, the assistant
is shown its own output once to repair it; if that fails you get a short
message, the raw text in an expandable panel, and a Retry button.

## Building the selected node

Selecting a Transformer or Join on the canvas — or a REST API Data
Source — focuses it in the chat. The assistant is then offered exactly
one build tool, for that node type, and:

- It takes **no arguments**: the builder reads your message verbatim and
  the node's own chat history, so literal values (URLs, column names,
  request bodies) are never paraphrased.
- A Join with no destination cannot be built at all, so the assistant is
  given a destination tool instead and asks where the result should go.
- The builder cannot see the app-wide conversation. When the assistant
  answers you itself and establishes something the builder will need, it
  records that fact onto the node.
- When the builder needs more information it asks you directly, and the
  turn ends with its exact question.
- Success means the node's **configuration** was updated. Nothing has run
  and nothing has been written: you are shown what it will do and offered
  a button to run that one node.

When the builder is already waiting on an answer, a small gate decides
whether your next message is that answer or something else entirely.

A question counts as waiting only while it is still the last thing said
on that node — once you have replied to it, it is spent, so the gate
doesn't sit in front of every later build judging fresh requests against
a settled question. A skill's question clears itself when the skill
converges.

A short reply that names one of the options the question offered
("Inner join." to "INNER, LEFT, RIGHT or FULL?") goes straight to the
builder without asking the AI. Otherwise the gate reads the node's whole
conversation, the question and your reply — plus a few lines on what that
builder asks about — and decides. Only when it cannot tell without a fact
(is that word a column?) does a separate lookup run read-only tools, and
the gate then decides once more with what was found; a fact found that
way is recorded onto the node for the builder.

It never writes to you: a message that isn't an answer is handed back to
the main assistant, which replies with its own tools and voice. It leans
toward forwarding — a slightly-off reply costs the builder one question,
while a wrongly withheld one costs you your answer. If it cannot decide,
the message is forwarded, and once two replies to the same question have
been held back, the next one is forwarded regardless.

## After a build: the change review

Every workflow created, every workflow modified, and every node rebuilt
from chat is reviewed before it runs, against **what you actually asked
for** — your own words, your answers to clarifying questions, and facts
recorded from you. Text the AI wrote about the build is description, not
specification.

- A rebuilt node is judged against your **newest** request for it (plus
  your answers to questions about that request). Its earlier requests are
  shown to the reviewer as background only, so "make it an inner join"
  is not failed for wording from the node's first build.
- A node's sources are the nodes wired into it, which only you can change.
  Table names you typed are taken as references to those sources, so a
  review never reports the "wrong" source table or proposes re-pointing one.
- A review that passes adds a one-line confirmation, and names any
  downstream node whose input shape just changed.
- A review that fails explains what does not match and offers to fix it.
  The proposed edits are re-sent to the builder only if you accept. The
  workflow is saved either way — the review never blocks your work.
- Fix-it rounds are capped at two in a row, so one wrong verdict cannot
  keep rewriting a node further from what you asked. Typing your own
  instruction resets the count.
- A review that cannot run at all is inconclusive and stays silent.

## Running generated code

`run_javascript` **generates** a function and stops. You see the source
and its explanation, and nothing runs until you approve it. On approval
the function runs with read-only data access and the real result is
replayed to the model, so it never reasons about code it only intended to
run. Declining drops the function.

## Reading large results safely

- Query results are capped at 50 rows per call, and large or wide results
  are truncated in the assistant's working memory — so before running a
  broad query it is told to count first, then narrow or limit.
- Large workflows come back as an outline (each node as an id, type and
  one-line description) and the assistant drills into only the nodes
  relevant to your question.
- When the conversation outgrows the model's context window, the oldest
  turns go first, then tool *results* are replaced with a note while the
  calls that made them stay visible, and only then whole call/result
  pairs. A call whose result was dropped becomes repeatable again.

## Safety and scope

- **Read-and-compute, not silent changes.** In main mode the assistant
  reads your workspace and runs queries, HTTP calls and approved scripts
  to answer you — none of which save anything. Every query is classified
  before it runs and anything that could modify data is blocked, in both
  agent modes; an unreadable verdict blocks too, and says that is what
  happened. Writes happen when a workflow runs, never through the chat's
  tools.
- **Secrets stay in the engine.** The assistant refers to connections by
  name and sees credential *names*, never values. The one way it can make
  an authenticated request is to generate a function that resolves the
  credential itself while running — so neither the assistant nor the
  generator ever sees it.
- **Cloud storage and Google Sheets cannot be configured from chat.**
  Picking a bucket, object or spreadsheet needs the editor's native
  picker. The assistant says so and points you there instead of proposing
  a build that would stall.
- **Honest about actions.** The assistant only claims to have done
  something when a tool actually did it; if a tool errors, it reads the
  error and adjusts rather than pretending.

## Related

- [Workflow builder](workflow-builder.md) — how a described workflow
  becomes a plan and then real nodes
- [Chat prompts](../chat-prompts/README.md) — the templates each node is
  built from
- [Nodes](../nodes/README.md) — what each node type does
- [AI providers](../ai-providers/README.md) — which models power the
  assistant
