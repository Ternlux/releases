# REST API generation

The REST API template turns a description of what you want from an HTTP
endpoint into a fetch function. The function handles credentials, base
URL, pagination, and shaping the response into rows.

## Setup

You first save a REST API connection, which captures:

- The base URL (optional — you can give absolute URLs instead).
- Up to 50 key/value **parameters and credentials**: auth headers, API
  keys, tenant ids, fixed query parameters — whatever the endpoint needs.
  Keys must be unique; values are encrypted.

You then add a Data Source node pointing at that connection and describe
what you want in the chat ("pull every order from the last 30 days",
"fetch the user list across all pages").

## What is generated

A single asynchronous JavaScript function expression that:

- Takes one argument: an object carrying an HTTP client.
- Loops over pages, cursor tokens, or related endpoints as needed.
- Returns the rows as an array of plain objects — a single object is
  wrapped as a one-element array, nothing becomes an empty array.
- Uses no imports and no top-level statements: the function expression is
  the whole reply.
- Lets HTTP errors fail. A 4xx/5xx is a failed fetch — and the runtime
  enforces it even if the function tries to accept one — so a wrong endpoint
  or a rejected key fails the build with the status and the endpoint, and
  never becomes rows. An empty object (`{}`) is not a row either.

Alongside the function the reply names the **endpoint** it calls
(`GET {{BASE_URL}}latest`); the node's card on the canvas shows it, with the
base URL filled in and the query string left out.

## Placeholders, never credentials

The function references the connection only through placeholder tokens,
and only inside string or template literals. The vocabulary is built from
that specific connection:

- `{{BASE_URL}}` — always available.
- One token per saved key/value entry, derived from the key name: a key
  called `X-API-Key` becomes `{{X_API_KEY}}`, `access_key` becomes
  `{{ACCESS_KEY}}`.

The model is told the key **names** and never the values, and it decides
from the name and your request where each belongs — a request header, a
query-string parameter, or a body field.

Connections saved before the key/value editor existed still carry a
legacy auth scheme, and the vocabulary is scoped to it:

- **None** — only the base URL.
- **Bearer** — a resolved auth header name and value, plus the raw token
  for query-string or body use.
- **API key** — a resolved header name and value (defaulting to
  `X-API-Key`), plus the raw value.
- **Basic** — a pre-encoded `Basic <base64>` header value, plus the raw
  username and password. The encoding is done for you.

## Sensible defaults

The generated function is steered toward defaults you'd otherwise have to
remember: GET, a JSON `Accept` header, a request timeout, a reasonable
page size, and a hard upper bound on the pagination loop so a
misbehaving API can't loop forever.

## Behaviour at build time and run time

The function is **never run without your approval** — it is generated
code making an outbound call with your credentials.

- Built from the node's chat: the node gets the function and nothing is
  called. The approval card's **Run this node** is the first call; that
  run writes the table and gives the node its columns (read back from the
  table, with real types).
- Built as part of a workflow plan: the steps after the source are built
  from its columns, so the build pauses on a **Run this call / Don't
  run** card showing the function: Run calls it once, stores the rows as
  the node's table, and the build goes on from that table; Don't run
  stops the build and nothing is saved. This is separate from the call
  the assistant makes (also with your approval) to see the API before it
  plans: that look-up is different code, and its request need not match
  the node's, so its rows are only used for planning.

A call that throws, returns an HTTP error, returns no rows, or returns rows
with no readable columns fails with the reason — there is no
empty-collection fallback.

At run time the background engine substitutes the placeholders with the
decrypted values just before evaluating the function, and the rows it
returns are written as this node's table in the workflow's DuckDB
database. The resolved source is never logged, because by that point it
holds the real credentials.

## The table name

The fetched rows are stored as a table, and the model names it alongside
the function — for what the rows are ("exchange_rates", "github_issues"),
never after the wording of your request. When an existing source is
rebuilt, the model is told the table it already writes and keeps that
name unless you ask to rename it: every node downstream reads the table
by name, so a rename would cut them off.

## When it asks instead

Exactly two outcomes: a finished function, or one clear question — which
is also how it answers something informational, or says why it cannot
proceed. A reply that is neither — no function, and nothing left to ask
because the question was already answered — fails the build with the
model's reason. A REST source is never saved without a fetch function.
