# 12-conn-mssql

**Area:** connection: SQL Server (source, transform, join, output)
**Uses:** `mssql`, local `stores` / `employees` / `products` / `products_store`
**Cost:** 5 assistant builds
**Requires:** nothing

Follow **Recipe D** in `_DATASET.md` with:

| | |
|---|---|
| CONN | `mssql` |
| T(x) | `dbo.x` |
| COUNT | Data Explorer: `SELECT COUNT(*) FROM dbo.x;` |

## SQL Server-specific checks
- [ ] Output tables land in `dbo` with sized `NVARCHAR(n)`/`VARCHAR(n)` columns.
- [ ] Part 3 left join returns 108 rows. SQL Server pages with
      `OFFSET … FETCH NEXT`, so check no rows are lost or duplicated across pages.
- [ ] All Recipe D checks.

## Cleanup
Leave the `e2e_*` tables; scenario 30 reads them.
