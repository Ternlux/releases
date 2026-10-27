# PostgreSQL connector

Representative relational connector. The other relational connectors
(MySQL, MSSQL, BigQuery, Snowflake) follow the same overall
behaviour with dialect-specific differences in identifier quoting,
preview syntax, and supported types.

## What it lets you do

- Test that Ternlux can reach your PostgreSQL server with the credentials
  you provided.
- List every database schema and the tables and views inside each.
- List the columns of any table, with type, nullability, and primary-key
  flag.
- Run any SQL query, with results returned as rows and columns.
- Stream large query results in batches so big tables don't have to fit
  in memory.
- Insert rows in bulk, in chunks, inside a transaction.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Host | Yes | Yes | — |
| Port | Yes | No | 5432 |
| Database | Yes | No | — |
| Username | Yes | Yes | — |
| Password | Yes | Yes | — |
| Schema | No | No | `public` |
| Use SSL | No | No | false |

## Setting up credentials

You need a PostgreSQL user with permissions on the schemas Ternlux will
read from and write to. Best practice is to create a dedicated user
rather than reusing an admin account.

### Step 1 — Connect as a privileged user

Open `psql` or any SQL client connected to your PostgreSQL server as a
user with the `CREATEROLE` privilege (commonly `postgres`).

### Step 2 — Create a dedicated user

Replace the password with a strong one of your own.

```sql
CREATE USER ternlux WITH PASSWORD 'choose-a-strong-password';
```

### Step 3 — Grant read + write access on a schema

If Ternlux only needs to read from and write to the `public` schema:

```sql
-- Allow connecting and using the schema
GRANT CONNECT ON DATABASE mydb TO ternlux;
GRANT USAGE ON SCHEMA public TO ternlux;

-- Read + write on existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ternlux;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ternlux;

-- Same permissions on tables created in the future
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ternlux;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ternlux;

-- Allow Ternlux to create new tables (needed for new-table transformations and joins)
GRANT CREATE ON SCHEMA public TO ternlux;
```

### Step 4 — Read-only variant (if you don't need write access)

If you'll only ever use this connection for sources (no transformer
or join writing into it), drop the `INSERT, UPDATE, DELETE, CREATE`
grants and keep just `SELECT`:

```sql
GRANT CONNECT ON DATABASE mydb TO ternlux;
GRANT USAGE ON SCHEMA public TO ternlux;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ternlux;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ternlux;
```

### Step 5 — Allow network access

If your PostgreSQL server is firewalled, make sure your machine's IP
address is allowed in `pg_hba.conf` and (if hosted) in the cloud
provider's firewall rules. Cloud providers (AWS RDS, GCP Cloud SQL,
Azure Database for PostgreSQL, Supabase, etc.) all expose this
through their console.

### Step 6 — Enter the credentials in Ternlux

Use the user, password, and database you set up. Pick the schema you
granted access to. Enable SSL if your server requires it (most cloud
providers do).

## How transformations are generated

When you ask the AI assistant to transform data sitting in PostgreSQL,
the assistant uses prompts written specifically for PostgreSQL. The
shape of the result depends on the storage location and operation mode
you choose — see [Nodes — Transformer](../../nodes/transformer.md).

## Behaviour notes

- Ternlux maintains a small connection pool per saved connection so
  repeated queries don't pay reconnection cost. Updating credentials
  closes the pool so the next query reconnects with the new values.
- Reading large tables happens cursor-style — Ternlux pulls a batch,
  hands it to the next step, then asks for the next batch. This is what
  lets joins move millions of rows from a remote PostgreSQL into a
  destination database without buffering the whole result.
