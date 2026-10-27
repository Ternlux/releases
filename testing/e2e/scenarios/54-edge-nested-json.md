# 54-edge-nested-json

**Area:** deeply nested JSON loaded locally and into connections, flattened, joined; a late-appearing field (R7)
**Uses:** `E2E edge nested`, `E2E edge nested big`; Postgres, mongo, snowflake, Google Bigquery
**Cost:** about 5 AI builds
**Requires:** 50

Expected values: `EXPECTED.json` → `edge_nested.json` (500 records, promo 200,
items 1001, qty 1669, sale-tagged items 250, `mixed` is an object in 250 rows, city of id 7 = Zürich).

## Part 1 — Nested into connections
Workflow `E2E Edge Nested Out`: Data Source `E2E edge nested` → Outputs (Truncate & insert):
| Destination | Target | A pass looks like |
|---|---|---|
| mongo | `e2e_nested` | 500 **real nested documents**: `db.e2e_nested.findOne({id: 7}).customer.address.city` = `Zürich`; `items` is an array, not a string |
| Postgres | `e2e_nested` | 500 rows; nested columns stored as JSON text you can parse (`customer::json->'address'->>'city'` = `Zürich` for id 7) |
| snowflake | `e2e_nested` | 500 rows; nested as VARIANT (`customer:address.city`) or JSON text. Watch for VARIANT insert errors |
| Google Bigquery | `ternlux.e2e_nested` | 500 rows; nested as STRING JSON or STRUCT |
| local JSON | `~/Desktop/Sample_data/e2e/edge/out/nested.json` | python3: equal to the input after reloading (same 500, same nesting) |

## Part 2 — Flatten with a transformer
Data Source `E2E edge nested` → Transformer: *"One row per item: id, customer
city, sku, qty, price, and whether the item is tagged sale."* → **1001** rows;
sum(qty) **1669**; **250** rows tagged sale.
Refine: *"Also add the depth8 value from customer.address.geo.meta.accuracy.level.depth7"* → every row `leaf`.

## Part 3 — Late-appearing field (R7)
1. mongo `e2e_nested` → Transformer (in place): *"Remove the promo field from
   documents where promo is null."* After this, the first 300 documents have **no** `promo` key.
2. mongo `e2e_nested` → Output → Postgres `e2e_nested_from_mongo`, Truncate.
3. Check that Postgres has a `promo` column with **200** non-null values. If the
   column is **missing**, R7 is confirmed: data silently dropped (major).

## Part 4 — Join nested with flat
mongo `e2e_nested` + `stores` (CSV) → Join, destination **mongo** `e2e_nested_join`:
*"Match customer.address.city to stores.location; keep id, customer name and
store_id."* No city matches a store location (Phoenix and Los Angeles aren't in
the data), so the inner join gives **0** rows. Judge whether the assistant
mentions that and whether the run reports "0 rows" with a warning instead of a plain success.

## Part 5 — Big nested JSON
1. Data Source `E2E edge nested big` → Transformer: *"Count records with a promo."*
   → **119700**. Note the run time.
2. Same source → Output → mongo `e2e_nested_big`, Truncate. Note the time and
   whether the app stays responsive. Count **120000**.
3. Same source → Output → Postgres `e2e_nested_big`. Count **120000**.

## Checks
- [ ] Part 1: each destination holds 500 with nesting usable (record the shape per engine)
- [ ] Part 2: 1001 / 1669 / 250 · depth8 = leaf
- [ ] Part 3: `promo` column present with 200 values (R7)
- [ ] Part 4: 0 rows reported as such, not hidden
- [ ] Part 5: 119,700 · 120,000 in mongo and Postgres · times recorded · UI responsive
- [ ] No renderer console errors or main-process errors
