# 41-vector-pinecone

**Area:** vector (Pinecone cloud): embed, maintain records, read as a table, similarity join, output, move vectors
**Uses:** `pinecone`, index **`products-index`**. The test writes **only** to the
namespaces `e2e`, `e2e-t`, `e2e-move` and `e2e-join`; never touch the existing
`products` namespace. Also uses local `products`, `products_store`, `employees`,
`stores`, and LanceDB `product_name_vectors` (read-only).
**Cost:** about 8 assistant builds, plus OpenAI embeddings (small) and Pinecone writes
**Requires:** an OpenAI key. `products-index` must exist with dimension **1536**
(text-embedding-3-small). If the dimension differs, the first upsert must fail
with **both** numbers named: record that and mark the rest BLOCKED.

## Part 1 — Output to Pinecone
Create workflow `E2E Pinecone`:
1. Data Source `products` → Output, destination `pinecone`, index `products-index/e2e`,
   embed column `name`, **Truncate & insert**. Run: the Data Source preview on
   `products-index` / namespace `e2e` shows **30** records with metadata
   `product_id`, `name`, `price`.
2. Switch it to **Append** and run again: still **30**. Identical rows upsert
   onto the same ids, so nothing is duplicated.
3. Switch back to **Truncate & insert** and run again: **30**.
4. **Move vectors between stores:** Data Source `product_name_vectors`
   (LanceDB, read-only) → Output `pinecone` `products-index/e2e-move`, Truncate.
   Run it: **30** records, and the log shows **no embedding calls** (the vectors
   are copied as they are).

## Part 2 — Embed with a Transformer (Mode 1)
Data Source `products` → Transformer: *"Embed the name column into Pinecone
index products-index, namespace e2e-t, using text-embedding-3-small."*
Run: **30** records in `e2e-t`. Run again: all **skipped**, no embedding calls, still 30.

## Part 3 — Transform the vector records (Mode 2)
Create workflow `E2E Pinecone Maintain`. Add Data Source `pinecone` /
`products-index` / namespace `e2e`, and three Transformers **chained**, each run
before building the next:
- **T1** (metadata filter → update): *"Set tier = 'premium' on every product priced over 100."*
  → **12** records have `tier = premium`. This needs `price` to be a **number**
  in the metadata; if the filter matches 0, report that price was stored as text.
- **T2** (metadata filter → delete): *"Delete the products whose name contains Socks."*
  → **27** left. (Pinecone metadata filters can't do substring matching, so
  check how the assistant handles it: an exact list of the 3 names, or a scan in
  the transform function. Either is fine if the result is right.)
- **T3** (similarity → tag): *"Tag the 5 products most similar to 'warm winter
  clothing' with season = 'winter'."* → exactly **5**, plausible picks.

## Part 3b — Read the vector records into a plain table
In `E2E Pinecone Maintain`, add a **fourth** Transformer **T4** after T3:
*"Count the products per tier into a new local table called e2e_tier_counts,
with columns tier and product_count."*
1. The assistant builds a read: it writes a **new local** table and does **not**
   offer to update, delete or tag the Pinecone records.
2. Run it: **2** rows — `premium` **10**, untagged **17**.
3. Namespace `e2e` is untouched: still **27**, 10 premium, 5 winter.

## Part 4 — Join, plain (Pinecone read as a table)
Create workflow `E2E Pinecone Join`:
1. `pinecone` `products-index`/`e2e` (27 records after Part 3) + `products_store` (CSV)
   → Join, local: *"Join products_store to the Pinecone products on
   product_id; keep store_id, product_id, name, price."* → **95** rows (the
   Socks rows are gone), no vector column.

## Part 5 — Join, similarity
`products` (CSV) + `pinecone` `products-index`/`e2e` → Join, local:
*"For each product, find the 3 most similar products by name in Pinecone,
excluding the product itself. Keep product_id, name, similar_product_id,
similar_name, score."* → **90** rows, no self-matches, and no Socks product
among the matches (deleted in T2). JavaScript join.

## Part 6 — Join into Pinecone
`employees` + `stores` (CSVs) → Join, destination `pinecone`, target
`products-index/e2e-join`: *"Inner join employees to stores on store_id, keep
all employee columns plus location, embed name."* → **20** vectors with `location` in metadata.

## Part 7 — Ask the chat about the vector data
In the chat (no node selected): *"How many records are in the e2e namespace of
products-index, and in the products namespace?"*
1. Expected: `e2e` **27** (after Part 3), `products` **30**.
2. The assistant reads them with `run_query` `{"operation":"count", ...}` —
   no `run_javascript`, no failed tool call, no made-up operation like
   `describeIndexStats` (check `dev-logs/ai-prompts.json`).

## Part 8 — Pull Pinecone records into local LanceDB
**Requires** Part 3 (namespace `e2e` holds **27** products, no Socks, 10 tagged premium).
Create workflow `E2E Pinecone To Lance` with Data Source `pinecone` / `products-index` /
namespace `e2e`. Ground truth from `products.csv` minus the Socks rows: 27 products;
price bands low (< 50) **7**, mid (50–100) **10**, high (> 100) **10**.
1. **Transformer, transform then store as vectors:** *"Copy these products into a local
   LanceDB table called e2e_pc_products, keeping each record's vector, and add a
   price_band column: low under 50, mid 50 to 100, high over 100."*
   - Built as a read into a new table (JavaScript), not an in-place maintenance plan.
   - Run: **27** records, each with a **1536**-dim vector; price_band 7 / 10 / 10;
     the log shows **no embedding calls** (vectors are copied).
   - Each copied vector equals the Pinecone vector of the same product (spot-check one).
   - Run again: still **27** (the new table is rebuilt, not appended to).
2. **Output, Pinecone → LanceDB file:** another Data Source on the same namespace →
   Output, local file, format **LanceDB**, path `~/Desktop/Sample_data/e2e/e2e_from_pinecone.lance`,
   table `e2e_products`, **Append**, Column to embed **None** (the rows carry vectors),
   ID column **id**.
   - Run: **27** records, ids equal the Pinecone ids, metadata fields (name, price, tier…)
     as flat columns, vectors 1536-dim, **no embedding calls**.
   - Run again: still **27** (upserted onto the same ids).
3. Namespace `e2e` is untouched: still **27**.

## Checks
- [ ] Part 1: 30 · append → still 30 · truncate → 30 · move copies 30 with no embedding calls
- [ ] Part 2: 30 · re-run skips all
- [ ] Part 3: 12 premium · 27 left · 5 winter, plausible
- [ ] Part 3b: T4 writes a new local table: premium 10 · untagged 17 · namespace still 27
- [ ] Part 4: 95 rows, no vector column
- [ ] Part 5: 90 rows, no self-matches, no Socks
- [ ] Part 6: 20 vectors
- [ ] Part 7: chat counts 27 / 30, via run_query count, no failed tool calls
- [ ] Part 8: Transformer → LanceDB 27 with vectors, bands 7/10/10, no embedding, re-run 27 · Output → LanceDB file 27, Pinecone ids kept, re-run 27 · `e2e` still 27
- [ ] The existing `products` namespace is untouched (same record count before and after)
- [ ] No API key appears in chat, logs or `workflow-code/`
- [ ] No renderer console errors or main-process errors

## Cleanup
Namespaces `e2e`, `e2e-t`, `e2e-move` and `e2e-join` stay in `products-index`.
List them; 👤 the person can delete them in the Pinecone console.
