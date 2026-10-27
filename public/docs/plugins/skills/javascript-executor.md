# JavaScript Executor skill

A **transformer** skill that runs AI-authored JavaScript inside the
background engine. Used when a transformation needs logic that doesn't
map cleanly to SQL or document operations.

It is not offered for joins — a join that needs per-row JavaScript gets
it from the join template itself, which emits a join function for a
document or vector destination.

## When the analysis picks this skill

- The work needs to cross-reference another saved connection mid-flight.
- It needs to call an AI model per record (classify, extract, summarise).
- It needs to hit an external HTTP API.
- It needs branching or multi-step orchestration that would otherwise be
  a forest of CASE expressions and CTEs.
- It needs a vector search from one fixed probe — "the five most similar
  to *clothes*" — where there are no left-hand rows to match and so no
  join.

For plain data movement and reshaping the analysis prefers SQL or
document operations: they're cheaper to run and easier to read. This
skill also orchestrates its own AI calls rather than handing a prompt
back to the builder, so its planning and its code generation both happen
inside it.

## The shape of the code

A single async function over the source's records, plus a context object
carrying the shared helper surface — connection lookup, unified read,
table and column listing, AI calls, embedding, HTTP, logging. See
[Skill capabilities at run time](../../ai-providers/helpers-bundle.md).

## Where the result goes

**Local only.** The output is a table in the workflow's own DuckDB
database — or a LanceDB table when the records it produces carry a
vector field, which the skill decides from the data rather than from the
request. It cannot write back to a SQL or document server, so a request
needing per-row JavaScript *and* a result living in Mongo or SQL is two
steps: this node, then an Output node.

## What it cannot do

The script is confined to the helpers above. It does not get raw
file-system, operating-system, or network access beyond what they expose,
and it never sees a decrypted password or token — credentials are
resolved inside the engine.

## The same skill in the chat

When you ask the assistant a question that needs computation rather than
a query — per-row AI calls, an authenticated API call, orchestrating
several sources — it uses this skill to *generate* a one-off function and
then stops. You read the source, approve it, and only then does it run,
with read-only data access. Nothing is saved either way; the rows come
back as an answer.
