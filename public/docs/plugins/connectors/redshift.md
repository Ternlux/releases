# Amazon Redshift connector

> **Disabled.** Redshift is turned off for now: the plugin still ships under
> `plugins/connectors/redshift/`, but it is listed in `DISABLED_CONNECTORS` in
> `public/pluginManager.js` so it never registers, and it is commented out of
> the connector picker. This page describes the connector as it behaves once
> re-enabled.

AWS data warehouse. PostgreSQL-compatible at the wire level, so most
SQL idioms carry over, but the metadata catalog is Redshift-specific.

## What it lets you do

- Test that Ternlux can reach your Redshift cluster.
- List schemas, tables, and views.
- List columns with type, nullability, and primary-key flag.
- Run any Redshift SQL query.
- Stream large query results in batches.
- Insert rows in bulk.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Cluster Endpoint (host) | Yes | Yes | — |
| Port | Yes | No | 5439 |
| Database | Yes | No | — |
| Username | Yes | Yes | — |
| Password | Yes | Yes | — |
| Schema | No | No | public |
| Use SSL | No | No | true |

The cluster endpoint is the long hostname AWS gives you for the
Redshift cluster. JDBC-format URLs (`jdbc:redshift://hostname:port/database`)
are also accepted — the connector parses them automatically.

## Setting up credentials

### Step 1 — Connect as a privileged user

Connect to your Redshift cluster as the master user (the `awsuser` or
similar account created when you launched the cluster) using the
Redshift query editor or any PostgreSQL client.

### Step 2 — Create a dedicated user

```sql
CREATE USER ternlux PASSWORD 'Choose-A-Strong-Password!';
```

### Step 3 — Grant read + write access

```sql
-- Allow connecting and using the schema
GRANT USAGE ON SCHEMA public TO ternlux;

-- Read + write on existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ternlux;

-- Same permissions on tables created in the future
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ternlux;

-- Allow creating new tables (needed for new-table transformations and joins)
GRANT CREATE ON SCHEMA public TO ternlux;
```

### Step 4 — Read-only variant

```sql
GRANT USAGE ON SCHEMA public TO ternlux;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ternlux;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ternlux;
```

### Step 5 — Allow network access

In the AWS console, go to your Redshift cluster's **Properties →
Network and security**. Make sure the security group attached to the
cluster has an inbound rule allowing TCP traffic on port 5439 from
your machine's IP. For VPC-only clusters, ensure your machine can
reach the VPC (over a VPN, Direct Connect, or with the cluster set
to publicly accessible).

### Step 6 — Enter the credentials in Ternlux

- **Cluster Endpoint** — the full hostname from the AWS console
  (e.g. `my-cluster.abc123.us-east-1.redshift.amazonaws.com`).
- **Database** — the database name (defaults to `dev` for new
  Redshift clusters).
- **Username / Password** — the user you created.
- **Schema** — the schema you granted access to (defaults to
  `public`).
- **Use SSL** — keep enabled; Redshift requires SSL by default.

## Behaviour notes

- Internal AWS schemas are hidden from the table listing.
- Primary keys are not enforced in Redshift; the flag is
  informational only.
- AI transform prompts use Redshift-specific SQL, including
  `DISTKEY` and `SORTKEY` suggestions when creating large new tables.
