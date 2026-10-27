# Chat prompts

These are the templates that turn a plain-language description into a
concrete operation a node can run. They are what the
[workflow builder](../chat-assistant/workflow-builder.md) uses for every
step it builds, and what the assistant uses when you ask it to build the
node you have selected on the canvas.

There are no longer separate per-node chat panels for Transformer and
Join. Those node types are configured through the app-wide
[chat assistant](../chat-assistant/README.md), which runs these same
templates on your behalf. Start, Data Source and Output are configured
with forms; only the REST API request on a Data Source is generated.

## Contents

- [Transformer](transformer.md) — how a single-source reshape is analysed
  and generated
- [Join](join.md) — how joins are generated, including the vector-aware
  paths
- [REST API](rest-api.md) — how REST fetch functions are generated for
  each credential scheme

## How a node is built

Every build of a Transformer or a Join runs the same sequence. Knowing it
explains what a question you're being asked is really for, and why a
build sometimes pauses.

**1. Read the source, live.** A data source's stored schema is a snapshot
from when that node was configured, and join keys and column lists are
chosen from column names — so every source is re-read before anything is
analysed. A transformer or join *upstream* is exempt: it declares the
shape it will write, and that declaration outranks whatever its last run
happened to leave on disk.

A source that still has no columns after that is not guessed at. The
builder asks you which table it should read, or which key columns each
source contributes.

**2. Analyse.** One AI call decides what kind of operation this is and
settles the choices that shape it (operation mode, storage location,
target name — or, for a join, the destination, the columns and the vector
scenario). It ends in exactly one of two ways: it has enough, or it asks
**one** question.

There is deliberately no third "answer the user" outcome. A question you
asked, a request that cannot be met, a table that isn't among the
sources — all come back as a question, with the answer inside it. That
rule exists so a refusal can never be mistaken for a finished node and
saved on top of a working one.

**3. Route.** If a skill fits the request better than plain SQL or
document operations, the analysis names it and the skill takes over —
see below.

**4. Generate.** A second AI call produces the operation itself, using
the template for the source's engine and the destination's shape.

**5. Assemble.** The generated statements, the target, the schema the
node will produce, and the deterministic local paths are written onto the
node, along with the conversation that produced them.

## Questions, answers and resuming

A builder does not hold a conversation open. When it needs something it
raises its question, the build pauses, the question is put to you in the
chat, and both the question and your reply are committed to the **node's
own transcript**.

On the next attempt the builder re-runs from the top and looks its
question up again — matched by the exact text it asked — and finds your
answer sitting after it. That is why a rephrased question never orphans
an answer you already gave, and why a builder that rejects an answer
("there's no connection called that") can ask again and read your
correction rather than the reply it already refused.

Steps that already finished are cached, so answering resumes the build at
the step that asked rather than rebuilding everything before it.

The conversation is also what the analysis and generation calls see, so
anything settled earlier on that node — including a fact the assistant
recorded for the builder — is in front of the model on every later round.

## Skill routing

The analysis carries the list of installed skills eligible for this node
type. If one is a better fit, it returns that skill instead of an
operation, and the skill drives the rest of the build:

- **Once routed, a node stays routed.** A node already built by a skill
  keeps using it, and the analysis is not re-run — a follow-up cannot
  silently switch the node's whole execution strategy. Routing is dropped
  only when the skill bows out, or when it is no longer available for
  that node type.
- **A skill turn is one round per message**, exactly like a builder's own
  question. It either executes, asks, or hands back.
- **A skill that cannot start at all** — no embedding key, for instance —
  stops the build with its own reason rather than having that reason
  handed to the model as if it were a prompt.
- **Bounded.** Five consecutive questions about one node, and the build
  falls back to the standard path with a note in the node's
  conversation explaining why — which also stops the analysis from
  immediately re-picking the same skill.
- **Except embedding.** Plain SQL cannot embed anything, so a vector
  skill that gives up fails the build instead of falling through to
  invented SQL that would die at run time.

See [Skills](../plugins/skills/README.md) for what each skill does and
the contract a skill turn follows.

## The reply contract

Every template requires a **single raw JSON object** as the reply, with
all prose inside the JSON's own fields — a question goes in the question
field, not in text around the object. A reply that cannot be parsed gets
one repair attempt, where the model is shown its own output and the
parser's complaint; if that fails the turn is reported as invalid and the
raw text is available to read.

An AI call that runs out of output room mid-answer is not a failure
either: what was written is kept and you are offered a Continue, which
finishes that one call and resumes the build from there.

## Where the dialect comes from

Only local (DuckDB) transformations use templates in this section. Every
remote engine supplies its own transform prompt through its connector, so
a dialect's idioms, quoting and type names live with that connector and
nowhere else. A connector that supplies none cannot be the target of a
generated transformation, and the build says so.

## Runtime placeholders

Generated operations may include named placeholders such as
`{{current_date}}` and `{{current_timestamp}}`, which are substituted
with the actual values when the workflow executes — so "set
archived_date to today" keeps working on every future run.
