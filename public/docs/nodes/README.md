# Nodes

A workflow is a directed graph of typed nodes. Each node has one job, and
at execution time each is dispatched to a handler that knows how to run
it.

## Node types

| Node | What it does | Configured by |
| --- | --- | --- |
| [Start](start.md) | Decides when the workflow runs | Form |
| [Data Source](data-source.md) | Pulls data from one input | Form (REST API requests: chat) |
| [Transformer](transformer.md) | Reshapes data from a single upstream source | Chat assistant |
| [Join](join.md) | Merges data from two or more upstream sources | Chat assistant |
| [Output](output.md) | Writes the result somewhere | Form |

## How nodes flow into each other

You connect nodes by drawing edges from one node's output handle to
another's input handle. The canvas enforces the shape of a valid
workflow:

- A **Start** node connects only to Data Source nodes, and may feed
  several of them.
- A **Data Source** takes exactly one incoming edge, and it must come
  from the Start node. It can feed transformers, joins and outputs.
- A **Transformer** takes exactly one input. To combine two sources, use
  a Join.
- A **Join** takes two or more inputs, and they must be distinct nodes.
- An **Output** takes exactly one input.

A node can only be opened for configuration once its inputs exist — a
transformer needs its upstream, a join needs two.

## Two ways a node is configured

- **Form nodes** (Start, Data Source, Output) are configured in the panel
  beside the canvas: structured choices — which connection, which table,
  which format, which schedule. Nothing is generated and nothing is
  guessed.
- **Chat-built nodes** (Transformer, Join) have no form. Selecting one
  shows its details and focuses the chat assistant, where you describe
  what it should do in plain language. The assistant generates the
  operation, writes it onto the node, and offers to run that node on its
  own so you can see the result before running the whole workflow. A
  REST API Data Source is a hybrid: the connection and the node are
  chosen in the form, and the fetch request is authored in chat.

Once a node is configured, the saved operation runs every time the
workflow runs — without re-asking the AI — until you change it.

## Execution order

When a workflow runs, Ternlux follows the saved execution order (the
Execution Steps list), calling each node's handler in turn. Order is not
derived from the edges at run time; it is the list you can reorder in the
editor.

Each node logs its result, the records processed, the duration, the
statements it ran, and any error. If a node fails, the run stops there.
A node that succeeds with nothing to do is recorded as a warning rather
than a plain success.

## Nodes that materialise something

Transformer, Join and Output nodes produce something that did not exist
before the node ran — a table, a collection, a file. The workflow records
which of them have actually run, so a preview or a downstream reader can
tell "this node names a table" from "that table exists". Building or
rebuilding a node clears the flag; running it sets it.
