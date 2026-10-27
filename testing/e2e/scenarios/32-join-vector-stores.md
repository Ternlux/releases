# 32-join-vector-stores

**Area:** joins with LanceDB and Pinecone on either side, into database, document and vector
destinations, and chains through a vector read (what 40/41 don't cover: those join only into
local tables or into a vector store)
**Uses:** LanceDB `product_name_vectors` (read-only, 30 records), Pinecone `products-index`
namespace `e2e` (as left by 41: **27** records, no Socks, **10** with `tier = premium`), the
`e2e_*` tables from 10–15, local CSVs
**Cost:** about 8 assistant builds, small OpenAI embedding use (V4–V6)
**Requires:** 10, 11, 13, 14, 15 (Part 1), 40 Part 4, 41 Parts 1–3. If namespace `e2e` doesn't hold
27 records, re-run 41 Parts 1–3 first or mark the Pinecone rows BLOCKED.
Pinecone writes go **only** to namespace `e2e-join2`; LanceDB writes only to `e2e_*` tables.

Ground truth:

| Question | Answer |
|---|---|
| `products_store` rows whose product is in Pinecone `e2e` (Socks removed) | **95**, Σprice **7691.77** |
| `products_store` rows whose product is premium **and** not Socks | **32** (10 products) |
| LanceDB products ∩ Pinecone `e2e` on product_id | **27** |
| `products_store` ⋈ premium products | **40** |

## Part 1 — A vector store read as a table, into a SQL database
For every join here the vector column must **not** be staged: the destination table has no
`vector`/`values` column, and nothing in the log says a 1536-wide value was inserted.

1. **V1, LanceDB → Postgres.** *"Build a workflow named E2E V1 that inner joins the
   product_name_vectors LanceDB table with e2e_products_store from Postgres on product_id, keeping
   store_id, product_id, name and price, into a new Postgres table e2e_v1."* → **108**. The Postgres
   source is on the destination and read in place; the LanceDB source is staged.
2. **V2, Pinecone → mysql.** *"Build a workflow named E2E V2 that inner joins the Pinecone
   products-index namespace e2e with e2e_products_store from mysql on product_id, keeping store_id,
   product_id, name and price, into a new mysql table e2e_v2."* → **95**, Σprice **7691.77**.
   Pinecone metadata arrives as flat columns; price is numeric in mysql (`SUM(price)` works).
3. **V3, metadata filter on the vector side.** Refine V2 in the Join's chat: *"Only keep products
   whose tier is premium."* → **32** rows, 10 distinct products. The filter should be pushed into
   the Pinecone read (metadata filter) or applied in SQL. Either is fine if the count is right.

## Part 2 — Two vector stores in one join
4. **V4, LanceDB + Pinecone → local.** *"Build a workflow named E2E V4 that inner joins the
   product_name_vectors LanceDB table with the Pinecone products-index namespace e2e on product_id,
   keeping product_id, name and the Pinecone tier, as a local table e2e_v4."* → **27** rows, no
   vector columns, `tier = premium` on **10**.

## Part 3 — Similarity joins into non-vector destinations
These are JavaScript joins (embedding / search can't be SQL); check that on the node.

5. **V5, similarity into Postgres.** *"Build a workflow named E2E V5: for each product in the local
   products CSV find the 3 most similar products by name in the product_name_vectors LanceDB table,
   excluding the product itself, and write product_id, name, similar_product_id, similar_name and
   score to a new Postgres table e2e_v5."* → **90** rows, no self-matches, every `score` filled
   (a LanceDB search returns `_distance`, so lower = closer; a similarity in [0,1] is fine too if
   the reply says which); the Postgres table has a numeric `score` column and NO `vector`,
   `_content_hash` or `_embedded_*` columns. The plan writes the join straight to Postgres — no
   local-lancedb step and no Output node. This is the function-join-into-SQL path (`targetDdl` +
   rows inserted by column name).
6. **V6, similarity into Mongo.** *"Build a workflow named E2E V6: for each product in the local
   products CSV find the single most similar product by name in Pinecone products-index namespace
   e2e (not itself), and write product_id, similar_product_id and score to a new mongo collection
   e2e_v6."* → **30** documents, no Socks product among `similar_product_id`, and no `_id` taken
   from either source.

## Part 4 — Database sources into a vector destination
7. **V7, SQL join → local LanceDB.** *"Build a workflow named E2E V7 that inner joins e2e_products
   from Postgres with e2e_products_store from mysql on product_id, keeps store_id, product_id, name
   and price, embeds name, and writes it to a local LanceDB table e2e_v7."* → **108** records with
   1536-dim vectors. Note how many embedding requests the log shows (108 rows, 30 distinct names).
8. **V8, SQL join → Pinecone.** Same join, destination `pinecone` `products-index`, namespace
   `e2e-join2`, embed name → **108** vectors, or fewer if the assistant asks for an id column and
   you answer `product_id` (then 30 upserted ids). Record which, and whether it asked.
   The `products` namespace is untouched.

## Part 4b — Replace vs append on a vector destination
A join in new-table (replace) mode leaves the store holding exactly this run's records; append
upserts by id. (Until 2026-10-06 a vector destination upserted in every mode, so a replace whose
ids changed between runs — a row hash over a float score — grew the store each run.)

9b. **V7 / old V5 (local LanceDB, replace).** Execute twice → the LanceDB table holds the same
    count both times (old V5: Postgres `e2e_v5` **90**, 90 distinct pairs); the main log shows
    "Replaced LanceDB table … (overwrite)" per run.
9c. **V8 (Pinecone, replace).** Execute → the log shows "Replace mode: emptied
    products-index/e2e-join2 before writing 108 rows"; namespace `e2e-join2` **108**; namespaces
    `e2e` (27) and `products` (30) unchanged.

9e. **Append.** In V8's Join chat: *"Switch to append mode."* → run twice: no namespace clear in the
    log, "108 unchanged record(s) skipped … 0 to embed", count stays 108. In old V5's Join chat:
    *"Switch to append mode."* → run: rows whose ids changed are ADDED and the rest kept ("… other
    records kept, N total", N > 90); *"Back to replace mode."* → run → 90.

## Part 4c — Similarity lookup against Pinecone (fresh build)
9d. **V6b.** *"Build a workflow named E2E V6b: for each product in the products CSV connection named
    products, find the 2 most similar products by name in the Pinecone products-index namespace
    e2e (excluding the product itself), and write product_id, name, similar_product_id,
    similar_name and score to a new Postgres table e2e_v6b."* → **60** rows (30 × 2) after two
    runs, every score filled (Pinecone `score`, higher = closer), 0 self-matches, no Socks among
    `similar_product_id`; the function asks Pinecone for topK 3 (2 + the excluded self), not the
    whole namespace.

## Part 5 — Chains through a vector read
9. **V9, LanceDB → transformer → join → Snowflake.** *"Build a workflow named E2E V9: from the
   product_name_vectors LanceDB table make a local table of the products priced over 100, then
   inner join it with e2e_products_store from snowflake on product_id into a new snowflake table
   e2e_v9 with store_id, product_id, name and price."* → transformer **12**, `e2e_v9` **40**.
10. **V10, Pinecone → join → join.** *"Build a workflow named E2E V10: inner join the Pinecone
    products-index namespace e2e with e2e_products_store from BigQuery on product_id into a local
    table, then join that with e2e_stores from mongo on store_id and write the total price per
    location to a new BigQuery table ternlux.e2e_v10."* → 2 rows. Compute the expected totals
    yourself from the CSVs (Socks removed) before running, and compare.

## Checks
- [ ] V1 108 · V2 95 / 7691.77 · V3 32 (10 products)
- [ ] No vector column staged into any SQL destination
- [ ] V4 27, 10 premium
- [ ] V5 90 rows, no self-matches, JavaScript join, numeric score column
- [ ] V6 30 docs, no Socks matches, no source `_id`
- [ ] V7 108 vectors (embedding calls noted) · V8 count and id behaviour recorded
- [ ] V9 12 → 40 · V10 totals match your own calculation
- [ ] Pinecone `products` namespace and LanceDB `product_name_vectors` unchanged
- [ ] No `temp_…` tables left in Postgres, mysql, snowflake or BigQuery
- [ ] The builder produced a correct workflow from one message (note which needed the fallback)
- [ ] No API key in chat, logs or `workflow-code/`
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the `E2E V*` workflows, `e2e_v*` tables, LanceDB table `e2e_v7` and Pinecone namespace
`e2e-join2`; list them. 👤 The person can delete `e2e-join2` in the Pinecone console.
