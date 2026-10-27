# Snowflake connector

Snowflake's cloud data warehouse. Two distinguishing features: every
query runs against a specific warehouse (which determines compute
cost), and identifiers are uppercase by convention.

## What it lets you do

- Test that Ternlux can reach Snowflake with your credentials.
- List databases, schemas, tables, and views.
- List columns of any table.
- Run any Snowflake SQL query.
- Stream large query results in batches.
- Insert rows in bulk.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Account | Yes | Yes | — |
| Username | Yes | Yes | — |
| Password | Yes | Yes | — |
| Warehouse | Yes | No | — |
| Database | Yes | No | — |
| Schema | No | No | PUBLIC |
| Role | No | No | (empty) |

The account identifier follows Snowflake's format —
`<account>.<region>` (e.g. `xy12345.us-east-1`). The warehouse
determines how compute is billed; the role can be used to run as a
different Snowflake role for permission scoping.

## Setting up credentials

### Step 1 — Sign in as ACCOUNTADMIN

Open the Snowflake web UI and run the following in a worksheet as
`ACCOUNTADMIN` (or another role with the privileges to create roles
and users).

### Step 2 — Create a dedicated role and user

```sql
USE ROLE ACCOUNTADMIN;

-- Create a role for Ternlux
CREATE ROLE ternlux_role;

-- Create a user with that role as default
CREATE USER ternlux
  PASSWORD = 'Choose-A-Strong-Password!'
  DEFAULT_ROLE = ternlux_role
  DEFAULT_WAREHOUSE = COMPUTE_WH
  MUST_CHANGE_PASSWORD = FALSE;

-- Assign the role to the user
GRANT ROLE ternlux_role TO USER ternlux;
```

### Step 3 — Grant warehouse access

```sql
-- Allow the role to use the compute warehouse
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE ternlux_role;
```

### Step 4 — Grant database, schema, and table access

```sql
-- Allow accessing the database and one schema
GRANT USAGE ON DATABASE MYDB TO ROLE ternlux_role;
GRANT USAGE ON SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;

-- Read + write on existing tables
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;

-- Same permissions on tables created in the future
GRANT SELECT, INSERT, UPDATE, DELETE
  ON FUTURE TABLES IN SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;

-- Allow creating new tables (needed for new-table transformations and joins)
GRANT CREATE TABLE ON SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;
```

### Step 5 — Read-only variant

If you'll only use the connection for sources:

```sql
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE ternlux_role;
GRANT USAGE ON DATABASE MYDB TO ROLE ternlux_role;
GRANT USAGE ON SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;
GRANT SELECT ON ALL TABLES IN SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;
GRANT SELECT ON FUTURE TABLES IN SCHEMA MYDB.PUBLIC TO ROLE ternlux_role;
```

### Step 6 — Find your account identifier

Your account identifier is in the Snowflake URL:
`https://<account>.snowflakecomputing.com` — copy the part before
`.snowflakecomputing.com`. For some regions Snowflake includes the
region (e.g. `xy12345.us-east-1`).

### Step 7 — Enter the credentials in Ternlux

- **Account** — the identifier from step 6.
- **Username / Password** — what you set in step 2.
- **Warehouse** — the warehouse the role can use (e.g. `COMPUTE_WH`).
- **Database** — the database you granted access to.
- **Schema** — the schema you granted access to (defaults to `PUBLIC`).
- **Role** — `ternlux_role`. Leave empty to use the user's default
  role.

## Behaviour notes

- Schema defaults to `PUBLIC` (uppercase, as Snowflake stores them).
- Identifier quoting uses double quotes.
- Column metadata is reported in uppercase column names.
- Primary keys are not enforced; the flag is informational only.
- The AI's transform prompts produce Snowflake-flavoured SQL that
  uses the warehouse and role context you configured.
- **Case folding is resolved against the catalog.** Snowflake stores an
  unquoted identifier upper-cased, so a table recorded as
  `pg_txn_customers` may really be `PG_TXN_CUSTOMERS`. Before an output
  loads into a table, the connector asks the catalog which of the two
  the name actually names and uses that — which is what keeps a load
  from quietly creating a second, lower-case table beside the real one.
- In the Data Explorer, autocomplete quotes an identifier only when the
  name would not survive Snowflake's upper-case folding.
