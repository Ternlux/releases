# 13-conn-snowflake

**Area:** connection: Snowflake (source, transform, join, output)
**Uses:** `snowflake` (database `TERNLUX`, warehouse `COMPUTE_WH`), local `stores` / `employees` / `products` / `products_store`
**Cost:** 5 assistant builds, plus Snowflake warehouse credits (small)
**Requires:** nothing

Follow **Recipe D** in `_DATASET.md` with:

| | |
|---|---|
| CONN | `snowflake` |
| T(x) | `PUBLIC.x` (bare `x` is also accepted) |
| COUNT | Data Explorer: `SELECT COUNT(*) FROM PUBLIC.x;` |

## Snowflake-specific checks
- [ ] **Letter case:** Snowflake stores unquoted names in upper case. Tables
      typed as `e2e_stores` must be found again by later nodes and by the Data
      Explorer, whichever case they were created in. Report any "table not found".
- [ ] Types are Snowflake's (`VARCHAR`, `NUMBER`/`FLOAT`), not another engine's.
- [ ] All Recipe D checks.

## Cleanup
Leave the `e2e_*` tables; scenario 30 reads them.
