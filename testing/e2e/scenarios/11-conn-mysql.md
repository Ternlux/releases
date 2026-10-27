# 11-conn-mysql

**Area:** connection: MySQL (source, transform, join, output)
**Uses:** `mysql`, local `stores` / `employees` / `products` / `products_store`
**Cost:** 5 assistant builds
**Requires:** nothing

Follow **Recipe D** in `_DATASET.md` with:

| | |
|---|---|
| CONN | `mysql` |
| T(x) | `x` (database `database`) |
| COUNT | Data Explorer: ``SELECT COUNT(*) FROM `x`;`` |

## MySQL-specific checks
- [ ] Seeded tables have sized `VARCHAR(n)` text columns (MySQL rejects a bare
      `VARCHAR`); open a table's columns in the Data Explorer.
- [ ] Transformer C (in place) runs as an `UPDATE` on the table itself.
- [ ] All Recipe D checks.

## Cleanup
Leave the `e2e_*` tables; scenario 30 reads them.
