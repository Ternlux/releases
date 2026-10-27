# 20-files-local

**Area:** local file types (CSV, JSON, Excel, Parquet, Avro, DuckDB, SQLite) as source, transform, join and output
**Uses:** local `products`, `stores`, `employees`, `products_store`; the existing file connections (read-only)
**Cost:** about 10 assistant builds
**Requires:** nothing. Part 2 needs 👤 file-picker steps.
**LanceDB** is covered in 40-vector-lancedb.

All files go in `~/Desktop/Sample_data/e2e/` (create it if missing).

## Part 1 — Output: write every format
Create workflow `E2E Files Output` with a Start node, then Data Source → Output pairs.
Every Output is a **local file**; type the path in the "Save to" box (don't use Browse):

| Source | Format | Path | Table / sheet |
|---|---|---|---|
| `products` | CSV | `…/e2e/products.csv` | – |
| `products` | JSON | `…/e2e/products.json` | – |
| `products` | Parquet | `…/e2e/products.parquet` | – |
| `products` | Avro | `…/e2e/products.avro` | – |
| `products` | Excel | `…/e2e/e2e.xlsx` | sheet `products` |
| `stores` | Excel | `…/e2e/e2e.xlsx` | sheet `stores` |
| `products` | DuckDB | `…/e2e/e2e.duckdb` | table `products` |
| `stores` | DuckDB | `…/e2e/e2e.duckdb` | table `stores` |
| `products` | SQLite | `…/e2e/e2e.sqlite` | table `products` |
| `stores` | SQLite | `…/e2e/e2e.sqlite` | table `stores` |

1. Run the workflow. With python3: `products.csv` has **30** rows,
   `products.json` is an array of **30**, and `e2e.sqlite` has `products` **30**
   and `stores` **5**. All 10 files exist.
2. Run it again. The files are rewritten, not appended: still **30** rows, and
   `e2e.xlsx` still has **both** sheets.

## Part 2 — Source: read every format back
1. 👤 Add each file as a local-file connection (Connections → add local file):
   `E2E csv` (products.csv), `E2E json` (products.json), `E2E parquet`,
   `E2E avro`, `E2E xlsx` (e2e.xlsx), `E2E duckdb` (e2e.duckdb),
   `E2E sqlite` (e2e.sqlite). If they already exist from an earlier run, keep them.
2. Check: `E2E xlsx`, `E2E duckdb` and `E2E sqlite` each offer **two** tables
   (products, stores); the others offer one.
3. Create workflow `E2E Files Transform`. For each of the 7 connections, add
   Data Source (its products table) → Transformer, and send the Transformer:
   *"Keep only the products priced over 100, as a new table."* Run each node.
4. Check: every source previews **30** rows with `price` as a number, and every
   Transformer returns **12** rows.

## Part 3 — Transform in place (only on the E2E copies)
In `E2E Files Transform`, add:
1. `E2E csv` → Transformer: *"Update this file in place: increase every price by 10%."*
   Run it. python3: the file still has **30** rows and the same columns, and
   the sum of prices goes from **2535.00** to about **2788.50**.
2. `E2E sqlite` / `products` → Transformer: *"In place: delete the products
   priced under 50."* Run it. The table has **23** rows, and the `stores` table
   in the same file is untouched (**5**).
3. `E2E xlsx` / `stores` → Transformer: *"In place: change location to upper case."*
   Run it. The `stores` sheet reads `PHOENIX`, and the `products` sheet is still in the workbook with **30** rows.
4. `E2E duckdb` / `products` → Transformer: *"In place: add a column band that
   is 'premium' when price is over 100, else 'standard'."* Run it:
   **12** premium, **18** standard.

## Part 4 — Join across file types (local destination)
Create workflow `E2E Files Join`:
1. `E2E parquet` + `products_store` (CSV) → Join, local destination:
   *"Inner join products_store to products on product_id, keep all
   products_store columns plus name and price. Target table e2e_ps_products."* → **108**.
2. `employees` (CSV) + `E2E xlsx` / `stores` → Join, local:
   *"Inner join employees to stores on store_id, keep all employee columns plus location."* → **20** (18 PHOENIX).
3. `products_store` (CSV) + `E2E avro` + `stores` (CSV) → one Join, local:
   *"Join products_store to products on product_id and to stores on store_id,
   then total the price per location."* → **2** rows: Phoenix **7439.05**, Los Angeles **1640.20**.
4. Add an Output after join 1: a local **Parquet** file `…/e2e/ps_products.parquet`. Run it and confirm it succeeds.

## Part 5 — Existing file connections (read-only)
For each of these existing connections, add a Data Source in a scratch workflow
`E2E Files Existing`, open the table picker and the preview. **Don't transform
them.**
`transactions_excel` (xlsx), `nested_orders` (nested JSON), `dynamic_events`
(JSON), `transcripts_sqlite`, `transactions_duckdb`,
`product_category_name_translation`.
- Report any connection whose table list is empty or whose file is missing. It
  must show a clear message (missing file, extension failed to load), never a
  bare "none found".
- `nested_orders`: are nested fields usable (struct/JSON column), and does the preview render?

## Checks
- [ ] Part 1: all 10 outputs written · re-run rewrites (30, not 60) · both Excel sheets kept
- [ ] Part 2: 7 formats read back · multi-table files list both tables · 30 rows each · 12 premium each
- [ ] Part 3: CSV rewritten (30 rows, sum ≈ 2788.50) · SQLite 23 and `stores` intact · Excel other sheet kept · DuckDB 12/18
- [ ] Part 4: 108 · 20 · 7439.05 / 1640.20 · Parquet output succeeds
- [ ] Part 5: each existing connection previews or gives a clear message
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the files and `E2E …` connections; 40-vector-lancedb uses the `e2e/` folder too.
