# 40-vector-lancedb

**Area:** vector (local LanceDB): embed, maintain records, read as a table, similarity join, output
**Uses:** local `products`, `products_store`, `employees`, `stores`; the existing
LanceDB connection `product_name_vectors` (**read-only**)
**Cost:** about 8 assistant builds, plus OpenAI embeddings (about 30–60 short
texts per run, a fraction of a cent)
**Requires:** an OpenAI key in settings (embeddings). Part 3 needs one 👤 file-picker step.

## Part 1 — Embed product records (Transformer, Mode 1)
Create workflow `E2E LanceDB`:
1. Data Source `products` → Transformer: *"Embed the name column into a local
   LanceDB table called e2e_product_vectors, using OpenAI text-embedding-3-small."*
2. Run the node. The preview shows **30** records, the vector as **[1536 dimensions]**,
   `product_id`, `name` and `price` as flat columns, plus the embedded-column,
   provider, model and timestamp fields.
3. The run log shows a cost estimate before embedding.
4. **Run the node again.** The log says all 30 were **skipped** as unchanged:
   no embedding calls, and still **30** records, not 60.

## Part 2 — Output to a LanceDB file
In the same workflow: Data Source `products` → Output, local file, format **LanceDB**,
path `~/Desktop/Sample_data/e2e/e2e_vectors.lance`, table `e2e_products`.
Run it: success, **30** records.

## Part 3 — Transform the vector records (Mode 2: update, delete, tag)
1. 👤 Add `~/Desktop/Sample_data/e2e/e2e_vectors.lance` as a local LanceDB
   connection named `E2E lance` (keep it if it already exists).
2. Create workflow `E2E LanceDB Maintain`. Add Data Source `E2E lance` /
   `e2e_products`, and three Transformers **chained** in this order, each run
   before building the next:
   - **T1** (metadata filter → update): *"Set tier = 'premium' on every product
     priced over 100."* → **12** records have `tier = premium`; total still **30**;
     the new `tier` field exists on all records (empty for the other 18).
   - **T2** (metadata filter → delete): *"Delete the products whose name contains
     Socks."* → **27** records left.
   - **T3** (similarity search → tag): *"Tag the 5 products most similar to
     'warm winter clothing' with season = 'winter'."* → exactly **5** tagged.
     Judge the picks: sweaters, jackets and the beanie are sensible; sneakers or
     shorts are not.
3. For each: before running, the assistant says what it will do and which
   filter it uses (a SQL `WHERE` for LanceDB). No "empty filter = every record"
   warning appears, because none of these is meant to touch every record.

## Part 3b — Read the vector records into a plain table
In `E2E LanceDB Maintain`, add a **fourth** Transformer **T4** after T3:
*"Count the products per tier into a new local table called e2e_tier_counts,
with columns tier and product_count."*
1. The assistant builds a read: it writes a **new** table and does **not** offer to
   update, delete or tag the vector records (no "Mode 2" maintenance plan).
2. Run it: **2** rows — `premium` **10**, untagged (empty or null tier) **17**.
   Ground truth: of the 12 priced over 100, two are Socks and were deleted in T2.
3. The vector table is untouched: still **27** records, 10 premium, 5 winter.

## Part 4 — Join, plain (vector store read as a table)
Create workflow `E2E LanceDB Join`:
1. `product_name_vectors` (existing, read-only) + `products_store` (CSV) → Join,
   local: *"Join products_store to the product vectors on product_id; keep
   store_id, product_id, name and price."* → **108** rows, and **no** vector column in the result.

## Part 5 — Join, similarity (top-K per row)
1. `products` (CSV) + `product_name_vectors` → Join, local:
   *"For each product, find the 3 most similar products by name from the
   vector table, excluding the product itself. Keep product_id, name,
   similar_product_id, similar_name and the similarity score. Target e2e_similar_products."*
2. Run it: **90** rows (3 per product), none matching itself, and scores in
   descending order within each product.
3. Spot check: a "Grey Sweater" row's matches include another sweater.
4. The join is built as a **JavaScript** join, not SQL (visible on the node or in `workflow-code/`).

## Part 6 — Join into a vector destination
`employees` + `stores` (CSVs) → Join, destination **local vector table (LanceDB)**:
*"Inner join employees to stores on store_id, keep all employee columns plus
location, embed the name column, target table e2e_employee_vectors."*
→ **20** records with `location` as a flat column and a vector.

## Part 7 — Ask the chat about the vector data
In the chat (no node selected): *"How many records are in each table of the
e2e_vectors connection, and in total?"*
1. Before asking, count each table yourself (read the LanceDB folder from a
   script) — the tables and counts depend on what earlier parts and other
   scenarios wrote there.
2. The answer gives every table's count and the total, matching yours.
3. The assistant reads them with `run_query` `{"operation":"count", ...}` —
   one call per table, no `run_javascript`, no failed tool call, no
   `read_doc` for a page that doesn't exist (check `dev-logs/ai-prompts.json`).

## Checks
- [ ] Part 1: 30 records · 1536 dims · cost estimate logged · re-run skips all 30
- [ ] Part 2: LanceDB file written with 30
- [ ] Part 3: T1 12 tagged, 30 total · T2 27 left · T3 exactly 5, plausible · each explained before running
- [ ] Part 3b: T4 writes a new table: premium 10 · untagged 17 · vector table untouched (27)
- [ ] Part 4: 108 rows, no vector column
- [ ] Part 5: 90 rows, no self-matches, scores descending, JavaScript join
- [ ] Part 6: 20 vector records with location
- [ ] Part 7: chat counts match, via run_query count, no failed tool calls
- [ ] `product_name_vectors` still has 30 records afterwards (untouched)
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the `E2E …` workflows, `e2e_*` LanceDB tables and `E2E lance`; list them.
