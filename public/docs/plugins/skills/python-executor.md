# Python Executor skill

A transformer-only skill that runs AI-authored Python for
transformations that plain SQL or document operations can't express
cleanly.

## When the analysis picks this skill

- The logic doesn't translate well to SQL — rolling windows, statistical
  calculations, data-science transformations, fuzzy text processing.
- It benefits from the Python ecosystem (pandas, numpy, scikit-learn).
- It mixes data shaping with analytical computation in a way SQL would
  obscure.

For pure data movement and reshaping the analysis prefers SQL or document
operations.

## How it works at run time

1. The source is loaded — a local file or an upstream node's table is
   read through DuckDB; a remote source through its connector.
2. The rows and the AI-written script are handed to a Python process,
   which returns the transformed rows.
3. The result is written as a **table in the workflow's own DuckDB
   database**, under the name the builder gave the node — the same name
   its preview query selects from and every downstream node reads.

Like the JavaScript skill, its output is **local only**: it cannot write
back to a SQL or document server. A request that needs Python *and* a
result living in a database is two steps — this node, then an Output
node.

The generated code is stored on the node like any other generated code,
as a `.py` file on disk (see
[Externalized node code](../../architecture/workflow-code.md)).

## Prerequisites

- Python 3 installed on your machine. The skill ships with Ternlux and
  needs no setup of its own.

It uses the same Python your terminal does, with whatever packages are
installed globally there — there is no separate environment. If Python
isn't found, the step fails with the command to install it. If the script
imports a package that isn't installed, the step fails naming the package
and the exact `pip install` command for that Python.
