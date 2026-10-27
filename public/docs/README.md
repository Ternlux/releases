# Ternlux Documentation

Ternlux is a desktop application for designing, automating, and running
data workflows. You assemble a workflow as a graph of typed nodes — a
trigger, one or more data sources, transformations, joins, and outputs —
and let the built-in AI assistant translate plain-language descriptions
into the exact operations that will run.

This documentation is the conceptual map of the product. It explains how
each part of Ternlux behaves, what it can do, and how the pieces fit
together. It does not document source code.

It is also working material: the assistant reads these files at run time
(it can list and open any of them), and the node and chat-prompt pages
are loaded verbatim into the prompts that build each node. What is
written here is what the builder is told.

## How Ternlux works in one minute

You start with a blank canvas and drop nodes onto it. Each node has a job:

- A **Start** node decides when the workflow runs (manually, on a
  schedule, or when a file changes).
- A **Data Source** node points at one input — a database table, a cloud
  bucket file, a local spreadsheet, a REST API, etc.
- A **Transformer** node reshapes data from a single upstream source.
- A **Join** node merges data from two or more upstream sources.
- An **Output** node writes results to a file, a database, a cloud
  bucket, or a vector store.

Start, Data Source and Output are configured with a form in the node
panel. Transformer and Join are built by the chat assistant: you select
the node, describe what it should do, and the assistant generates the
operation, shows it to you, and offers to run that node on its own.

When the workflow runs, Ternlux executes nodes in the saved order, traces
every step, and records the result so you can inspect what happened.

Throughout, your credentials and AI provider keys stay encrypted on your
machine and are never visible inside generated workflows or sent
anywhere except to the service the connection actually targets.

## Documentation map

| Section | What it covers |
| --- | --- |
| [Architecture](architecture/README.md) | How Ternlux is structured, what runs locally, how runs are recorded |
| [Plugins](plugins/README.md) | How Ternlux is extended with connectors and AI skills |
| [Connections](connections/README.md) | Saved data sources, credential storage, OAuth, querying a database directly |
| [AI providers](ai-providers/README.md) | Which AI providers Ternlux supports and how it uses them |
| [Nodes](nodes/README.md) | What each node type does and how it behaves at run time |
| [Chat assistant](chat-assistant/README.md) | The app-wide AI assistant that answers questions, runs queries, and builds workflows |
| [Chat prompts](chat-prompts/README.md) | The templates that turn a description into a concrete operation |
| [Triggers](triggers/README.md) | Scheduled and file-based automation |

## What Ternlux can do

In one workflow you can:

- Pull data from any supported database (relational, document, or vector),
  cloud storage bucket, local file, spreadsheet service, or REST API.
- Reshape it with AI-generated SQL, document operations, or custom code,
  either creating a new table or modifying the source in place.
- Combine data from multiple sources with joins — including hybrid joins
  that mix relational, document, and vector sources, and joins that
  perform similarity search per row.
- Write the result to a local file (in eight formats), back into a
  database, into a cloud bucket, or into a vector index (with embeddings
  generated automatically).
- Run the whole workflow on demand, on a schedule, or when a file
  changes — and stop a run that is already going.

Local files are never imported or converted. A CSV, JSON, Parquet,
Excel or Avro file stays where you put it and is queried in place by
DuckDB, so adding a 5 GB file costs the same as a 5 MB one. Node results
(a transformer's table, a join's output, a REST API fetch) are tables in
the workflow's own DuckDB database.

Outside of workflows, you can open any database connection in the
[Data Explorer](connections/data-explorer.md) — a worksheet-based query
workspace with schema browsing, autocomplete and per-connection history.

Ternlux ships with a curated set of integrations and can install more
on demand from the plugin catalog.
