# MongoDB connector

Representative document-store connector. The same general approach
(collections listed as tables, fields inferred from sample documents,
queries are filter / pipeline objects) applies to other document
stores.

## What it lets you do

- Test that Ternlux can reach your MongoDB cluster.
- List every collection in the connected database, with the database
  name shown as its "schema".
- Inspect the fields of any collection — Ternlux samples up to one
  hundred documents and reports the union of the fields it sees. The
  document id is marked as the primary field.
- Read: `find`, `aggregate`, `count`, `estimatedDocumentCount`,
  `distinct`.
- Write: `insertOne` / `insertMany`, `updateOne` / `updateMany` /
  `replaceOne`, `deleteOne` / `deleteMany`, `findOneAndUpdate` /
  `findOneAndReplace` / `findOneAndDelete`, `bulkWrite`, and `drop`.
- Manage indexes and run database-level commands (`listCollections`,
  `createCollection`, `runCommand`, `dbStats`, `createIndex`,
  `dropIndex`, `listIndexes`).
- Accept **shell syntax** as well as raw parameters. In the Data
  Explorer you can type what you'd type in `mongosh` —
  `db.events.find({ ts: { $gte: ISODate("…") } }).limit(50)` — and the
  connector translates the call and its trailing
  `.sort()` / `.limit()` / `.skip()` / `.project()` chain. AI-generated
  nodes emit the raw parameter form, which is accepted unchanged.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Connection URI | Yes | Yes | — |

A single MongoDB URI carries host, port, username, password, and
database name. The full URI is stored encrypted.

## Setting up credentials

### Step 1 — Open MongoDB shell as an admin

Connect to your MongoDB instance with `mongosh` as a user with
`userAdminAnyDatabase` or `dbOwner` on the target database.

### Step 2 — Create a dedicated user

Switch to the `admin` database to create the user:

```javascript
use admin;

db.createUser({
  user: "ternlux",
  pwd: "choose-a-strong-password",
  roles: [
    { role: "readWrite", db: "mydb" }
  ]
});
```

For read-only access, use the `read` role instead of `readWrite`.

### Step 3 — Allow network access

If your MongoDB server is firewalled (especially MongoDB Atlas), add
your machine's IP to the access list:

- **MongoDB Atlas** — go to **Network Access** in the cluster page
  and add your IP.
- **Self-hosted** — open port 27017 (or your custom port) in your
  firewall / security group.

### Step 4 — Build the connection URI

The URI format is:

```
mongodb://USERNAME:PASSWORD@HOST:PORT/DATABASE?retryWrites=true
```

Or for MongoDB Atlas:

```
mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/DATABASE?retryWrites=true&w=majority
```

URL-encode the password if it contains special characters.

### Step 5 — Enter the URI in Ternlux

Paste the full URI into the **Connection URI** field. Ternlux uses
the database from the URI as the default; you can still browse other
databases on the same cluster from the picker.

## How transformations are generated

When you ask the AI to transform data in MongoDB, the assistant
chooses the right approach for the request — see
[Nodes — Transformer](../../nodes/transformer.md) for the full
breakdown.

## Behaviour notes

- Ternlux keeps a small connection pool per saved connection (up to ten
  connections, with an eight-second server-selection timeout).
- There is no cursor-based streaming read, so a node that reads a whole
  collection buffers it — uncapped, but resident. Reads through a node
  are deliberately uncapped: the connector's own default of 100
  documents applies only to sampling.
- Updating credentials closes the cached connection so the next query
  reconnects with the new URI.
- The connector is also used as a destination for joins and outputs.
  In those modes it accepts bulk inserts of documents assembled by the
  background engine or read from another source. An `_id` carried over
  from a source collection is stripped before insert, so the destination
  mints its own — an id names a document within its own collection, and
  two sources can collide on it.
