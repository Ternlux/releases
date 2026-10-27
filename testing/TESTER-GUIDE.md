# Ternlux — Tester Guide

You are testing a desktop app for building and running data pipelines, with an
AI assistant built in.

**Work however you like.** There are no scripted steps and no "expected result"
column. Use your own judgement about what good looks like, and tell us where it
fell short. Skip anything you can't set up — just say you skipped it.

## What we need back

1. **Does it work?** — the checklist in Part 1.
2. **Is it ready to release?** — Part 2.
3. **Who is this for?** — Part 3. Your opinion is the deliverable.

---

## Reporting an issue

For anything that breaks, confuses, or surprises you:

- [ ] **Export the chat** — 3-dots menu on the conversation → **Export Chat**
      (downloads a JSON file). Send it.
- [ ] **Export the workflow** — in the workflow editor, the **⋯** menu beside
      Save → **Export Workflow** (downloads a JSON file). Send it.
- [ ] Note the **OS**, what you were trying to do, and what happened.
- [ ] Screenshot or short screen recording if it's visual.
- [ ] If a run failed: the **execution id** from the Executions tab.

If we ask for more, the app data folder is:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Ternlux` |
| Windows | `%APPDATA%\Ternlux` |
| Linux | `~/.config/Ternlux` |

⚠️ **Never send** `llm-config.dat` or `db-credentials.dat` — they hold your API
keys and database passwords.

---

## Before you start

- [ ] Install on **macOS, Linux and Windows** if you can. Note which OS each
      finding came from, and tell us which you couldn't cover.
- [ ] **AI keys** — Claude (Anthropic), OpenAI, Gemini, and one
      OpenAI-compatible third party (OpenRouter / Groq / Together / Mistral /
      NVIDIA / Ollama / LM Studio).
- [ ] **Accounts** — Snowflake, Pinecone, BigQuery. Tell us if you couldn't sign
      up for any of them.
- [ ] **Databases** — use the docker compose files we give you, or your own
      (Postgres, MySQL, SQL Server, MongoDB).
- [ ] **Cloud storage** — at least one of S3 / GCS / Azure Blob / Dropbox /
      Google Drive / OneDrive, plus Google Sheets.
- [ ] **Files to work with** — CSV, multi-sheet Excel, JSON, Parquet, Avro, and
      a `.sqlite` or `.duckdb` file. Include one **large** file (1M+ rows) and
      one **messy** one (nulls, unicode, nested JSON, spaces in column names).
- [ ] Use the **AI assistant** whenever you get stuck — then tell us whether it
      actually helped.

---

# Part 1 — Functionality

## Install & first run

- [ ] Download and install on each OS you have
- [ ] Sign up / sign in
- [ ] Terms screen and the analytics opt-in — is the choice clear?
- [ ] Add each AI key in settings; switch the default provider and model
- [ ] Linux only: if the machine has no desktop keyring, a warning about weaker
      key storage should appear where you type secrets — does it?
- [ ] Quit and reopen — does everything come back?

## Connections

- [ ] Add each database you have: Postgres, MySQL, SQL Server, MongoDB,
      Snowflake, BigQuery, Pinecone
- [ ] Add each local file type: CSV, Excel (multi-sheet), JSON, Parquet, Avro,
      `.sqlite`, `.duckdb`, LanceDB folder
- [ ] Add a REST API connection with your own key/value credentials
- [ ] Test connection before saving — is the error useful when it fails?
- [ ] OAuth connectors (BigQuery, Drive, Sheets, GCS, OneDrive, Dropbox): the
      Authorize flow, and what happens if you close the dialog half way
- [ ] Edit a saved connection, change the password, run something — does it use
      the new credentials?
- [ ] Delete a connection that a workflow depends on — what happens?
- [ ] How clear is the setup documentation for each connector?

## Data Explorer — as a replacement for DBeaver / Studio 3T

- [ ] Open a database connection and browse the tree
- [ ] Double-click a table for a preview; click one to see its columns
- [ ] Write and run SQL; run only a selection; run with `Cmd/Ctrl+Enter`
- [ ] Keep several worksheets open; close and reopen the connection — are they
      still there?
- [ ] Query history — find and re-run something from earlier
- [ ] Autocomplete: tables, columns, keywords — is it fast and right?
- [ ] Syntax checking — does it flag real errors without nagging on valid SQL?
- [ ] Format a messy statement
- [ ] Run a write statement (`INSERT` / `UPDATE` / `CREATE`) — does it do what
      you expect, with no confirmation step?
- [ ] MongoDB: shell syntax (`db.orders.find({}).limit(50)`), aggregates
- [ ] Local files: query a CSV directly, join two local files in one statement,
      write to a `.sqlite` table, `UPDATE` a CSV
- [ ] Export results as CSV / JSON; copy a selection; pin a result
- [ ] Big result (100k+ rows) — what happens, and how fast?
- [ ] **Verdict: would you use this instead of your current SQL client? What's
      missing before you would?**

## Building workflows in the UI

- [ ] Create a workflow, drag in nodes, wire them up
- [ ] Try invalid wiring (two inputs into a transformer, a source into a source)
      — is the refusal clear?
- [ ] Configure Start, Data Source and Output nodes in the side panel
- [ ] Rename nodes; move them; delete one in the middle of a chain
- [ ] Data Preview / Details on each node
- [ ] Reorder the Execution Steps and run again
- [ ] Save, close, reopen — is everything as you left it?
- [ ] Import a workflow JSON (Workflows tab → Import)
- [ ] Workflow version history — make several edits, then revert

## The chat assistant — building workflows

- [ ] Ask it to build a whole workflow from one description
- [ ] Answer its clarifying questions — does it ask the right ones, and does it
      ever re-ask something you already answered?
- [ ] Review the plan card before accepting; try **Cancel** too
- [ ] Watch the canvas draw the nodes as it builds
- [ ] Ask it to **modify** an existing workflow (add a step, change a filter)
- [ ] Select a Transformer or Join on the canvas and build it from chat
- [ ] Refine a node ("also exclude 2023", "match on name instead")
- [ ] After a build, read the review verdict — if it says something doesn't
      match, try **Fix it**, and judge whether the fix was right
- [ ] Ask for something impossible (a cloud-storage source, an append-mode join)
      — is the explanation honest and useful?
- [ ] Use the **Run this node** button it offers after a build
- [ ] **How much did you have to know about the app to get a working result?**

## The chat assistant — as an analyst

- [ ] Ask questions about a table's data; ask for a chart
- [ ] Ask about your workflows, connections and past runs
- [ ] Ask it to query an API (public, and one needing a saved credential)
- [ ] Ask it something that needs computation, not just a query (per-row
      classification, embeddings, joining two sources) — it should generate code
      and ask you to approve it before running
- [ ] Decline generated code once; approve it another time
- [ ] Ask it to **change** data ("delete the test rows") — it should refuse
- [ ] Ask it how a feature of the app works
- [ ] Ask something it can't answer — how does it handle not knowing?
- [ ] Judge the answer quality, the speed, and the cost per question

## Transformers & joins

- [ ] Transformer: filter, aggregate, rename, derive a column, cast types
- [ ] Transformer **in place** vs **new table**
- [ ] Transformer storing to the source database vs storing locally
- [ ] Transformer on a local file — in place (it rewrites the file) and new table
- [ ] Join two tables on one connection
- [ ] Join across different systems (Postgres ↔ Mongo, database ↔ local file)
- [ ] Try each join type (inner, left, right, full) and confirm the row counts
- [ ] Join to each destination: a database, a local table, a document store
- [ ] Chain it all: several sources → joins → transformers → output
- [ ] Complex logic: multi-stage aggregation, dedupe, anti-join (only rows not
      already in the destination), self-join
- [ ] Re-run a finished workflow twice — are the results the same, and is
      anything duplicated?

## Skills

- [ ] **Python** — a transformation that needs pandas/numpy (rolling window,
      stats). Run the setup script first; report how that went
- [ ] **JavaScript** — per-row logic, an external API call per row, or an AI
      call per row
- [ ] **Vector — transformer**: embed a column into LanceDB, then into Pinecone
- [ ] **Vector — transformer**: maintain records in place (update / delete / tag
      by similarity or metadata filter)
- [ ] **Vector — join, plain**: read a vector store as a normal table and join on
      a key
- [ ] **Vector — join, similarity**: "for each row find the top-5 most similar"
      — with LanceDB, and with Pinecone
- [ ] Re-run an embed step — does it re-embed everything, or only what changed?
- [ ] Take the key away (wrong/removed OpenAI key) — is the error clear?
- [ ] Does the assistant pick the right skill on its own, or do you have to
      name it?

## Triggers (Start node)

- [ ] Manual run
- [ ] Schedule — hourly, daily, weekly, monthly; check it actually fires
- [ ] File watch — a single file, and a folder; add / change / delete events
- [ ] Close the app, reopen, and confirm a schedule still fires
- [ ] Let a trigger fire while the same workflow is still running — it should be
      skipped
- [ ] Desktop notifications on start / success / failure

## Outputs

- [ ] Local file export in each format: JSON, CSV, Excel, Parquet, Avro, DuckDB,
      SQLite, LanceDB
- [ ] Two output nodes writing different sheets into one Excel file, and
      different tables into one `.sqlite`
- [ ] Output to a database table — **append**, then **truncate and insert**, and
      check the row counts both times
- [ ] Output to a table that doesn't exist yet
- [ ] Output to a table whose columns don't match the data — is the failure
      clear, and is anything written?
- [ ] Output to a vector index (append vs truncate)
- [ ] Output to cloud storage, and to a Google Sheets tab
- [ ] Output from an **empty** source — what does it report, and is the
      destination left alone?
- [ ] Source and destination on the **same** connection (should be fast)

## Cloud storage

- [ ] Set up each service you have access to — how painful was each one?
- [ ] Browse buckets/folders and pick a file
- [ ] Use a cloud file as a source and re-run — does it pull a fresh copy?
- [ ] Write a result back to cloud storage
- [ ] Google Sheets as a source and as a destination
- [ ] A big file (hundreds of MB) — download time, memory, whether the UI stays
      responsive
- [ ] Expired or revoked token — what does it say?

## REST API source

- [ ] Create an API connection and describe what to fetch in plain language
- [ ] An endpoint needing **pagination**, and one needing a **cursor**
- [ ] Different credential styles: header token, API key, query-string key,
      basic auth
- [ ] A request that fails (wrong URL, wrong key) — is the reason clear?
- [ ] An endpoint returning nested JSON — do the rows come out usable?
- [ ] Re-run the workflow — does it fetch fresh data?
- [ ] Chain transformers and joins off the API data

## Running, monitoring and failing

- [ ] Run from the canvas, from the workflows list, and a single node
- [ ] Execution monitor: live progress, current step, the log filling in
- [ ] **Stop** a long-running workflow mid-write — how quickly does it stop, and
      does it tell you what was already written?
- [ ] Run two workflows at once
- [ ] Executions tab: per-node timings, row counts, the SQL that ran, errors
- [ ] Break something on purpose (wrong password, drop a table, disconnect the
      network mid-run) — judge the error messages
- [ ] Force-quit the app during a run, reopen, and see how that run is reported
- [ ] **Validate workflow output** (Execution Steps → generate a validation
      function) — run it, then break the data and run again
- [ ] Edit the workflow afterwards — are you told the validation may no longer
      fit?

## Keeping things in sync

- [ ] Point a data source at a different table, then run the transformer that
      reads it — it should refuse rather than write to the wrong place
- [ ] Use the rebuild prompt that appears on the canvas when a source moves
- [ ] Add a column upstream and re-run — does the downstream node notice?
- [ ] Open a node's SQL from `workflow-code/` in your own editor, change it,
      save — does the canvas pick it up?
- [ ] Delete a workflow — is its code folder cleaned up?

## Providers & models

- [ ] Do the same build with OpenAI, Claude, Gemini, and your third-party
      provider — compare quality, speed and failure modes
- [ ] Remove the key for your default provider — does it fall back cleanly?
- [ ] Change the model and the max-tokens setting
- [ ] A very long conversation — does it stay coherent once history is trimmed?
- [ ] A local model (Ollama / LM Studio) if you can — does it work at all?
- [ ] Report anything where the AI confidently got it wrong

## Safety & secrets

- [ ] Ask the assistant for a password or API key from a connection
- [ ] Open an exported workflow JSON and the `workflow-code/` files — are there
      any credentials in them?
- [ ] Confirm a generated REST fetch uses placeholders, not your real key
- [ ] Try a data-modifying query through the chat — it should be blocked

## Scale & stress

- [ ] A 1M+ row file as a source; a multi-million row table
- [ ] An Excel export bigger than a sheet can hold
- [ ] A very wide table (100+ columns)
- [ ] Messy data: nulls, unicode, emoji, spaces and dots in column names,
      deeply nested JSON
- [ ] A workflow with 10+ nodes
- [ ] Leave the app open for a day with a schedule running — memory, stability

## Housekeeping

- [ ] Install a plugin from the catalog; uninstall one
- [ ] Auto-update, if a newer build is available
- [ ] Uninstall and reinstall — what is left behind?
- [ ] Anything in the UI that felt slow, confusing, or unfinished

---

# Part 2 — Is it ready to release?

Answer in your own words:

- [ ] **Would you ship this?** Yes / no, and why.
- [ ] What is **broken enough to block** a release? List them.

---

# Part 3 — Who is this for?

Your opinion, from actually using it:

- [ ] Would **you** use this daily as an all-in-one tool for analysis and
      pipeline building? What would you still open another tool for?
- [ ] Who is the user? Technical (data engineer, analyst who writes SQL)?
      Non-technical SMB? Somewhere between?
- [ ] How does it compare to what you've used — Alteryx, Make/Zapier, Fivetran,
      dbt, Airflow, Power Query, a SQL client?
- [ ] What does it do **better** than those?
- [ ] What does it do **worse**?
- [ ] Is the AI assistant a real advantage here, or a wrapper on things you
      could do yourself faster?
- [ ] Is there enough value to pay for it? Roughly what, and per what?
- [ ] What one change would most increase its value for the user you have in
      mind?
