# Shared reference for the connection scenarios (10–41)

<!-- Starts with "_" so it is never run on its own. Every scenario from 10 up
     points here. Read it once before running any of them. -->

## The test dataset

Every connection test uses the same four **small** CSV files from
`~/Desktop/Sample_data`. They already exist as local-file connections of the
same name. Scenario 1x copies them into each database as `e2e_*` tables, so
every connection ends up holding the same known data.

| Local connection | Rows | Columns |
|---|---|---|
| `stores` | 5 | `store_id, location` |
| `employees` | 20 | `employee_id, name, store_id` |
| `products` | 30 | `product_id, name, price` |
| `products_store` | 108 | `store_id, product_id` |

## Expected answers

| Question | Answer |
|---|---|
| Stores by location | ST-001, ST-003, ST-004, ST-005 = Phoenix (4 stores); ST-002 = Los Angeles (1 store) |
| Products priced **over 100** ("premium") | **12** |
| Products under 50 / 50–100 / over 100 | **7 / 11 / 12** |
| Products whose name contains "Socks" | **3** (PR-007, PR-013, PR-017; PR-013 and PR-017 are premium) |
| `employees` ⋈ `stores` on `store_id` (inner) | **20** rows: **18** in Phoenix, **2** in Los Angeles |
| Employees per store | ST-001 4, ST-002 2, ST-003 3, ST-004 6, ST-005 5 |
| Sample row | EMP-001 "Dakota Davis" works at ST-004 (Phoenix) |
| `products_store` ⋈ `products` on `product_id` | **108** rows (every product exists) |
| Products stocked per store | ST-001 15, ST-002 20, ST-003 29, ST-004 14, ST-005 30 |
| Catalog value per location (sum of price over `products_store` ⋈ `products`) | Phoenix **7439.05**, Los Angeles **1640.20** |
| `products_store` **INNER** join premium products | **40** rows |
| `products_store` **LEFT** join premium products | **108** rows (68 with no premium match) |
| `products_store` rows whose product is **not** premium (anti-join) | **68** |
| `products_store` rows once the 3 Socks products are removed | **95** |
| Duplicate product names | Red Jacket, Grey Sweater, Green Sweater, White T-Shirt (2 each) |

REST API (`JSON_API`, public jsonplaceholder data):

| Question | Answer |
|---|---|
| `https://jsonplaceholder.typicode.com/users` | **10** users (ids 1–10) |
| `https://jsonplaceholder.typicode.com/todos` | **200** todos, **90** completed |
| Completed todos per user | 1:11, 2:8, 3:7, 4:6, **5:12**, 6:6, 7:9, 8:11, 9:8, **10:12** |

Existing vector data (read-only, don't modify): LanceDB connection
`product_name_vectors` (also `products_lance`, same folder) holds table
`product_name_vectors`: **30** records, one per product, with `product_id`,
`name` and `price` columns and `name` embedded.

## Naming and re-runs

Names are **fixed** (no timestamps), so re-running a scenario replaces what the
previous run made instead of piling up copies.

- Workflows: `E2E <Area> <Part>`, e.g. `E2E Postgres Seed`. If one with that
  name already exists, it belongs to an earlier test run: delete it first.
- Database tables and collections: `e2e_<name>`, e.g. `e2e_stores`.
- Local files: under `~/Desktop/Sample_data/e2e/` (create the folder if it's missing).
- Cloud objects: `e2e/stores.csv` in the bucket or folder the scenario names.
- Pinecone: index `products-index`, namespaces `e2e`, `e2e-t`, `e2e-move`, `e2e-join` only.
- LanceDB tables the tests create: `e2e_*`.

Never touch non-E2E workflows or tables, or the existing vector data (reading is fine).

## How to count and check rows

- **SQL databases:** Data Explorer on that connection: `SELECT COUNT(*) FROM <table>`.
- **MongoDB:** Data Explorer: `db.e2e_stores.countDocuments({})`.
- **Workflow-local tables (transformer/join results stored locally):** the node's Data Preview / Details.
- **Local files:** `python3` from the terminal (csv, json, sqlite3). For Parquet,
  Avro, Excel and DuckDB, check the row count when the file is read back in the app.
- **Vector stores:** the node's Data Preview. It shows records with the vector
  as `[N dimensions]`.

## 👤 Human steps

Steps marked 👤 need a native macOS dialog (file picker, save-location picker)
or an OAuth window, which the automated tester can't operate. The automated
tester must stop and ask the person at the terminal to do that one step, wait
for them to confirm, then carry on. A human tester just does the step.

## Recipe D — one database connection (used by 10–15)

The connection scenario supplies these values: **CONN** (connection name),
**T(x)** (how to write table name *x* on this engine) and **COUNT** (how to
count rows). Do the parts in order.

### Part 1 — Output (seed the database)
1. Create workflow `E2E <CONN> Seed`: a Start node, then four branches, each a
   Data Source → Output pair:
   `stores` → T(e2e_stores), `employees` → T(e2e_employees),
   `products` → T(e2e_products), `products_store` → T(e2e_products_store).
   Every Output: destination **CONN**, write mode **Truncate & insert**.
2. Run the workflow. COUNT each table: **5 / 20 / 30 / 108**.
3. Change the `e2e_stores` Output to **Append** and run again: `e2e_stores` = **10**.
4. Change it back to **Truncate & insert** and run again: `e2e_stores` = **5**, the others unchanged.

### Part 2 — Source + Transform
Create workflow `E2E <CONN> Transform` (Start first):
1. Data Source **CONN** / `e2e_products` → **Transformer A**. Select it and send
   in chat: *"Create a new table called e2e_products_premium in this same
   database with only the products priced over 100."*
   Accept, then run the node. COUNT `e2e_products_premium` = **12**.
2. Off the same Data Source, add **Transformer B**: *"Count the products in
   three price bands: under 50, 50 to 100, and over 100. Store the result
   locally."* Run the node. The preview shows **7 / 11 / 12**.
3. Data Source **CONN** / `e2e_stores` → **Transformer C**: *"Update this table
   in place: change location to upper case."* Run the node. COUNT still **5**;
   Data Explorer shows `PHOENIX` ×4, `LOS ANGELES` ×1.
4. Run the whole workflow a second time: same counts, no duplicates, and no
   error from Transformer C (upper-casing twice is harmless).

### Part 3 — Join (same connection)
Create workflow `E2E <CONN> Join` (Start first):
1. Data Sources **CONN** / `e2e_employees` and **CONN** / `e2e_stores` → **Join 1**.
   Destination: **CONN**. Chat: *"Inner join employees to stores on store_id.
   Keep all employee columns plus location. Target table e2e_employee_stores."*
   Answer its questions with exactly those facts. Run. COUNT = **20**; **18**
   rows Phoenix (any letter case, since Part 2 upper-cased it) and **2** Los Angeles;
   EMP-001 → ST-004.
2. Data Sources **CONN** / `e2e_products_store` and **CONN** / `e2e_products_premium` → **Join 2**.
   Destination **CONN**. Chat: *"Left join products_store to products_premium
   on product_id, keep all products_store columns plus name and price. Target
   table e2e_ps_premium."* Run: **108** rows, **68** with an empty price.
3. Refine Join 2 in chat: *"Make it an inner join instead."* Run: **40** rows.
4. Look at the connection's table list in the Data Explorer. The join's
   temporary staging tables must be gone: only the `e2e_*` tables named here remain.

### Part 4 — Output from a derived node
1. In `E2E <CONN> Join`, add an **Output** after Join 1: a local file,
   **CSV**, path `~/Desktop/Sample_data/e2e/<conn>_employee_stores.csv`. Run the Output node.
2. Check the file with python3: **20** data rows, and the columns include `location`.

### Checks for every Recipe D scenario
- [ ] Part 1: 5/20/30/108 · append → 10 · truncate → 5
- [ ] Part 2: premium 12 · bands 7/11/12 · in-place upper-case applied, count 5 · re-run is clean
- [ ] Part 3: join 20 (18/2) · left 108 (68 empty) · inner 40 · no leftover staging tables
- [ ] Part 4: CSV has 20 rows
- [ ] The assistant's clarifying questions were necessary and never repeated
- [ ] No renderer console errors or main-process errors
