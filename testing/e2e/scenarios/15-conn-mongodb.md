# 15-conn-mongodb

**Area:** connection: MongoDB, a document store (source, transform, join, output)
**Uses:** `mongo`, local `stores` / `employees` / `products` / `products_store`
**Cost:** 5 assistant builds
**Requires:** nothing

Follow **Recipe D** in `_DATASET.md` with:

| | |
|---|---|
| CONN | `mongo` |
| T(x) | collection `x` |
| COUNT | Data Explorer: `db.x.countDocuments({})` |

Mongo differences to expect (not bugs):
- Transformers produce an aggregation pipeline, a filter or a JavaScript function instead of SQL.
- Joins into Mongo run a generated **JavaScript** join function, and the target collection is dropped and rebuilt on each run.
- "Upper case in place" becomes an update applied in batches.

## Mongo-specific checks
- [ ] Output documents get fresh `_id`s. On a re-run with Append, source `_id`s
      must not collide ("duplicate key" is a bug).
- [ ] Part 3 join documents have no `_id` carried over from either source.
- [ ] Part 2, Transformer B stored locally: the preview is a normal table (band, count), not raw documents.
- [ ] `price` stays a number (not a string) after the round trip:
      `db.e2e_products.find({price: {$gt: 100}}).count()` = **12**.
- [ ] All Recipe D checks.

## Cleanup
Leave the `e2e_*` collections; scenario 30 reads them.
