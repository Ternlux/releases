# 10-conn-postgres

**Area:** connection: PostgreSQL (source, transform, join, output)
**Uses:** `Postgres`, local `stores` / `employees` / `products` / `products_store`
**Cost:** 5 assistant builds (transformers and joins)
**Requires:** nothing

Follow **Recipe D** in `_DATASET.md` with:

| | |
|---|---|
| CONN | `Postgres` |
| T(x) | `x` (schema `public`) |
| COUNT | Data Explorer: `SELECT COUNT(*) FROM public.x;` |

## Postgres-specific checks
- [ ] Part 1, step 4: the log/SQL shows `TRUNCATE` (Postgres supports it), not a row-by-row delete.
- [ ] Part 3: both join sources are on the destination connection, so the
      execution log reads them **in place**, with no staging temp tables.
- [ ] All Recipe D checks.

## Cleanup
Leave the `e2e_*` tables; scenario 30 reads them.
