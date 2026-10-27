# Skills

Skills are AI-routable executors the analysis can choose instead of plain
SQL or document operations when a request calls for it.

## Shipped skills

| Skill | Category | Purpose |
| --- | --- | --- |
| [Vector Database Executor](vector-db-executor.md) | Both | Generates embeddings, runs every vector store operation (upsert, query, delete, update), and powers vector-aware transformers, joins and outputs |
| [JavaScript Executor](javascript-executor.md) | Transformer | Runs AI-authored JavaScript in the background engine for cross-system, per-row or API-calling work |
| [Python Executor](python-executor.md) | Transformer | Runs AI-authored Python (pandas, numpy, …) for transformations that don't map cleanly to SQL |
| [Presentation](presentation.md) | Chat | Builds a dashboard presentation of headline numbers, charts and written findings from saved data, in the main chat only |

A skill's **category** decides which analyses it is offered to:
`transformer`, `join`, or `both`. A `chat` skill is offered to none of
them: only the main chat assistant uses it, through a tool of its own. Two consequences of the table above are
worth stating plainly:

- Only the vector skill is eligible for joins — and the join builder
  excludes it on purpose, because the join engine calls its vector hooks
  itself rather than routing a whole join through it. So no shipped skill
  currently routes a join; a join is built as SQL or as a JavaScript join
  function by the join template itself.
- The JavaScript and Python skills are transformer-only.

## How a skill turn works

Once the analysis names a skill, that skill drives the build one round
per user message:

1. **The skill builds its own prompt** from the request, the node's
   context (source connection and schema, operation mode, storage
   location, target name, and — for a local result — the exact path the
   node will write), and whatever state earlier rounds accumulated.
2. **One AI call** is made with that prompt and the node's conversation,
   and the skill parses the reply itself. A skill that prefers to
   orchestrate its own calls returns a finished result instead, and no
   call is made here.
3. **The result is one of three things**: execute (here are the
   parameters to run), ask (here is my question), or "this isn't my
   territory". Anything unrecognised is treated as a question — never as
   a success.
4. **State carries forward.** What a round settled travels with the pause
   and is handed back on the next round, so answering one question does
   not restart the dialogue.

Whatever the skill calls its question — a single field, or a map of
fields it still needs — the text reaches you as an ordinary question in
the chat.

## Behaviour rules

- **Vector source auto-routing.** A transformer pointed at a vector
  source always goes through the vector skill — vectors are not something
  SQL or plain document operations can talk to.
- **Once routed, a node stays routed.** A node already built by a skill
  keeps using it and the analysis is not re-run, so a follow-up can't
  silently change the node's execution strategy. Routing is dropped when
  the skill bows out, or when that skill is no longer available for the
  node type.
- **A skill that cannot start** — no embedding key configured, say —
  stops the build with its own reason. It is not handed to the model as a
  prompt, which would turn a hard error into a chatty "how to fix it"
  reply and lose the failure.
- **Bounded.** Five consecutive questions about one node and the build
  falls back to the standard path, recording why in the node's
  conversation so the analysis doesn't immediately re-pick the skill. The
  same applies to a skill that asks without saying what it needs, or
  reports the request isn't its territory.
- **Except embedding.** Plain SQL cannot embed anything, so a *vector*
  skill that gives up fails the build and names the settings it still
  needed, rather than falling through to invented SQL.
- **The skill picks the local store.** A skill writing locally chooses
  LanceDB when the records it produces carry a vector and DuckDB
  otherwise; the node records which, and downstream nodes read whichever
  it picked.

## What skills can use

Every skill execution receives the same predictable surface from
Ternlux — see
[Skill capabilities at run time](../../ai-providers/helpers-bundle.md).
Skill calls are also traced into the execution log, so a run shows which
skill ran and what it did, not just that the node finished.

## Installation

Skills live beside connectors in the plugin folder, and the folder name
is the skill's id. The first install of one requires a restart so the
interactive layer picks it up. After that it is automatically considered
by the analysis whenever it generates an operation it's eligible for.
