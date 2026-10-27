# MySQL connector

Standard relational connector for MySQL and MySQL-compatible
databases (MariaDB, Aurora MySQL, etc.).

## What it lets you do

- Test that Ternlux can reach your MySQL server.
- List schemas, tables, and views.
- List columns of any table with type, nullability, and primary-key
  flag.
- Run any SQL query.
- Stream large query results in batches without loading everything
  into memory.
- Insert rows in bulk inside a transaction.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Host | Yes | Yes | — |
| Port | Yes | No | 3306 |
| Database | Yes | No | — |
| Username | Yes | Yes | — |
| Password | Yes | Yes | — |
| Use SSL | No | No | false |

Connection pooling caps at ten concurrent connections per saved
connection so repeated queries don't pay reconnection cost.

## Setting up credentials

### Step 1 — Connect as a privileged user

Open `mysql` or any SQL client as a user with `GRANT OPTION` on the
target database (commonly `root`).

### Step 2 — Create a dedicated user

```sql
-- Replace the password with a strong one of your own
CREATE USER 'ternlux'@'%' IDENTIFIED BY 'choose-a-strong-password';
```

The `'%'` host allows the user to connect from any IP. If you want
to restrict it to a specific network, replace `'%'` with the CIDR
or hostname.

### Step 3 — Grant read + write access

```sql
-- Read + write on every table in the database
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'ternlux'@'%';

-- Allow creating new tables (needed for new-table transformations and joins)
GRANT CREATE, DROP, ALTER, INDEX ON mydb.* TO 'ternlux'@'%';

FLUSH PRIVILEGES;
```

### Step 4 — Read-only variant

If you'll only use the connection for sources:

```sql
GRANT SELECT ON mydb.* TO 'ternlux'@'%';
FLUSH PRIVILEGES;
```

### Step 5 — Allow network access

If your MySQL server is firewalled, make sure your machine's IP is
allowed (in your provider's security group, in `iptables`, in the
cloud console firewall, etc.). For SSL-only servers, enable the SSL
checkbox in the form.

### Step 6 — Enter the credentials in Ternlux

Use the user and password you created. Enter the database name. Leave
the port at 3306 unless your server uses a custom port.

## How transformations are generated

When you ask the AI to transform data sitting in MySQL, the assistant
uses prompts written specifically for MySQL. The shape of the result
follows the same patterns as PostgreSQL — see
[PostgreSQL](postgres.md) for the breakdown of new-table vs in-place,
and database-vs-local storage.
