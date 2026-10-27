# 14-conn-bigquery

**Area:** connection: BigQuery (source, transform, join, output)
**Uses:** `Google Bigquery` (dataset `ternlux`, location US), local `stores` / `employees` / `products` / `products_store`
**Cost:** 5 assistant builds, plus BigQuery load jobs and queries (small)
**Requires:** a valid OAuth token. If anything says the token expired, 👤 re-authorize the connection.

Follow **Recipe D** in `_DATASET.md` with:

| | |
|---|---|
| CONN | `Google Bigquery` |
| T(x) | `ternlux.x` (BigQuery needs `dataset.table`) |
| COUNT | Data Explorer: ``SELECT COUNT(*) FROM `ternlux.x`;`` |

## BigQuery-specific checks
- [ ] Output with a bare table name (no dataset) is either qualified with
      `ternlux` automatically or refused with a clear message. Try it once on `e2e_stores`.
- [ ] Part 2, Transformer C: BigQuery `UPDATE` needs a `WHERE` clause; check the
      generated statement has one (e.g. `WHERE TRUE`) and runs.
- [ ] Part 1, step 4: truncate works (BigQuery uses `TRUNCATE TABLE` or `DELETE … WHERE TRUE`).
- [ ] All Recipe D checks.

## Cleanup
Leave the `e2e_*` tables; scenario 30 reads them.
