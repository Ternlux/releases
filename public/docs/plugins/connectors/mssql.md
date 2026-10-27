# SQL Server (MSSQL) connector

Relational connector for Microsoft SQL Server (including SQL Server
Express, Azure SQL Database, and Azure SQL Managed Instance).

## What it lets you do

- Test that Ternlux can reach your SQL Server instance.
- List schemas, tables, and views.
- List columns with type, nullability, and primary-key flag.
- Run any T-SQL query.
- Stream large query results in batches.
- Insert rows in bulk inside a transaction.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Server (host) | Yes | Yes | — |
| Port | No | No | 1433 |
| Database | Yes | No | — |
| Username | Yes | Yes | — |
| Password | Yes | Yes | — |
| Instance name | No | No | (empty) |
| Encrypt connection (SSL) | No | No | false |

The instance name field lets you target a named SQL Server instance
without having to encode it in the host. SSL connections automatically
use `trustServerCertificate` so self-signed certs don't break the
handshake — useful in lab and on-prem setups.

## Setting up credentials

### Step 1 — Connect as a privileged login

Open SQL Server Management Studio (SSMS) or `sqlcmd` connected as
`sa` or another sysadmin login.

### Step 2 — Create a dedicated SQL login and database user

```sql
-- Server-level login (in master)
USE master;
CREATE LOGIN ternlux WITH PASSWORD = 'Choose-A-Strong-Password!';

-- Map it to a database user inside your target database
USE mydb;
CREATE USER ternlux FOR LOGIN ternlux;
```

### Step 3 — Grant read + write access

```sql
USE mydb;

-- Read + write on every existing object
ALTER ROLE db_datareader ADD MEMBER ternlux;
ALTER ROLE db_datawriter ADD MEMBER ternlux;

-- Allow creating new tables (needed for new-table transformations and joins)
ALTER ROLE db_ddladmin ADD MEMBER ternlux;
```

### Step 4 — Read-only variant

If you'll only use the connection for sources:

```sql
USE mydb;
ALTER ROLE db_datareader ADD MEMBER ternlux;
```

### Step 5 — Allow network access

- For on-prem SQL Server, ensure TCP/IP is enabled in SQL Server
  Configuration Manager and the firewall allows port 1433 (or your
  custom port).
- For Azure SQL Database, add your machine's IP under "Set server
  firewall" in the Azure portal.

### Step 6 — Enter the credentials in Ternlux

- **Server** — hostname or IP. For Azure SQL Database, this is
  `<servername>.database.windows.net`.
- **Database** — the database name you granted access to.
- **Instance name** — for named instances like `SQLEXPRESS`, set this
  to the instance name. Leave empty for default instances.
- **Encrypt connection** — required for Azure SQL Database; optional
  but recommended otherwise.

## Behaviour notes

- Schema defaults to `dbo` if you don't specify one.
- Identifier quoting uses square brackets around schema and table
  names.
- The AI's in-place transform prompt knows that column renames in
  SQL Server use `EXEC sp_rename` rather than `ALTER TABLE ... RENAME
  COLUMN`.
