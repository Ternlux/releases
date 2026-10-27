# 61-edge-sqlite-duckdb-sheets

**Area:** existing SQLite and DuckDB database-file connections, and Google Sheets,
as **source, transformer, join and output**, without relying on the workflow's own DuckDB
**Uses:** `e2e duckdb`, `e2e sqlite`, `transactions_duckdb`, `transcripts_sqlite`,
`Google Sheets`, local `stores` / `products` / `products_store` / `employees` CSVs, `Postgres`
**Cost:** about 8 AI builds
**Requires:** 20 (it created `e2e duckdb` / `e2e sqlite`)

## Ground rules for this file
- **Never change the existing tables** in the real data files:
  `earliest_transactions` (in `transactions_duckdb`, 1,000,000 rows) and
  `data` / `transactions` (in `transcripts_sqlite`, 10,000,000 rows each). Only
  `e2e_*` tables may be written, in any file.
- How the app works today (from the code), so these are **not** bugs:
  - An **in-place** transformer on a database-file table changes the file directly.
  - A **new-table** transformer always writes into the workflow's own DuckDB.
  - A **join** can't use a file connection as its destination; the destination
    here is Postgres.
  - An **Output** can write a table into an existing `.duckdb` / `.sqlite` file
    (local file → DuckDB/SQLite format, path typed into "Save to"), replacing
    only that table.

| Connection | File | Existing tables |
|---|---|---|
| `e2e duckdb` | `~/Desktop/Sample_data/e2e/e2e.duckdb` | `products`, `stores` (test copies) |
| `e2e sqlite` | `~/Desktop/Sample_data/e2e/e2e.sqlite` | `products`, `stores` (test copies) |
| `transactions_duckdb` | `~/Desktop/Sample_data/output_output-1.duckdb` | `earliest_transactions` 1,000,000 |
| `transcripts_sqlite` | `~/Desktop/Sample_data/transcripts.sqlite` (1.7 GB) | `data`, `transactions` 10,000,000 each |

---

## Part A — SQLite and DuckDB files

### A1 Output: write `e2e_*` tables into all four files
Workflow `E2E DB Files`: Start → Data Sources `stores`, `products`,
`products_store` → Outputs, local file, typed path, **same file per connection**:

| Format | Path | Tables to write |
|---|---|---|
| DuckDB | `…/e2e/e2e.duckdb` | `e2e_stores`, `e2e_products` |
| SQLite | `…/e2e/e2e.sqlite` | `e2e_stores`, `e2e_products`, `e2e_products_store` |
| DuckDB | `…/output_output-1.duckdb` | `e2e_stores` |
| SQLite | `…/transcripts.sqlite` | `e2e_stores` |

1. Run. Then run again.
2. Check in the Data Explorer on each connection:
   - `e2e_stores` = **5**, `e2e_products` = **30**, `e2e_products_store` = **108**, still the same after the second run (replaced, not doubled)
   - the existing tables are untouched: `products`/`stores` in the e2e files still there; `earliest_transactions` **1,000,000**; `data` and `transactions` **10,000,000** each
   - the new tables appear in each connection's table list **without re-adding the connection**

### A2 Source: read each file
Add a Data Source on every table above (all four connections) and preview it.
- The preview of the 10M-row tables returns in seconds; it must not scan the whole file.
- Types look right: `price` is a number; `transaction_date` is text in SQLite (as stored).

### A3 Transformer in place: writes go into the file
For **each** of the four connections:
1. Data Source `<conn>` / `e2e_stores` → Transformer: *"In place: change location to upper case."*
   Run. Data Explorer on `<conn>`: `PHOENIX` ×4, `LOS ANGELES` ×1.
2. Only on `e2e duckdb` and `e2e sqlite`: Data Source `<conn>` / `e2e_products` →
   Transformer: *"In place: add a column band that is 'premium' when price is
   over 100, else 'standard'."* → **12 / 18**. (This is an ALTER and an UPDATE;
   on SQLite it goes through DuckDB's sqlite extension.)
3. Then: *"In place: delete the products whose name contains Socks."* → **27**.
4. Check that the node's details or execution log show the **database file** as
   the target, not `workflow-data/<id>.duckdb`.

### A4 New-table transformer (documented to use the workflow DB)
Data Source `e2e duckdb` / `e2e_products` → Transformer: *"Create a new table
e2e_premium inside the e2e duckdb file with products over 100."*
A pass: it writes into the file (12 rows there), **or** it clearly says the new
table goes into the workflow's database. Fail: it claims to write into the file but doesn't.

### A5 Join reading from database files, destination Postgres
1. `e2e sqlite` / `e2e_products_store` + `e2e duckdb` / `e2e_products` → Join,
   destination **Postgres**: *"Inner join on product_id, keep store_id,
   product_id, name, price. Target e2e_dbfile_join."* → **108** in Postgres.
2. `transactions_duckdb` / `earliest_transactions` + `transcripts_sqlite` /
   `e2e_stores` → Join, destination **Postgres**: *"Count transactions per
   location (join on store_id). Target e2e_dbfile_big."* → **2** rows:
   PHOENIX **899590**, LOS ANGELES **100410** (upper case after A3). Note the
   time, since 1M rows are staged.
3. Ask in a Join's chat: *"Write the result into the e2e duckdb file."* A pass:
   it explains that a file connection can't be a join destination and lists the
   real options. Fail: it says yes and then writes somewhere else.

### A6 Output from database-file sources
1. `e2e sqlite` / `e2e_products` → Output → Postgres `e2e_from_sqlite`, Truncate → **27**.
2. `transactions_duckdb` / `earliest_transactions` → Output → local Parquet
   `…/e2e/earliest.parquet` → **1,000,000**. It streams; note the time and that the UI stays responsive.

### A7 Locks and self-overwrite (edge cases)
1. **DuckDB file locked by another process.** In a terminal, from `frontend/`:
   `node -e 'require("@duckdb/node-api").DuckDBInstance.create(process.env.HOME+"/Desktop/Sample_data/e2e/e2e.duckdb").then(i=>{global.db=i;setTimeout(()=>{},90000)})'`
   (it holds the file for 90 s). Within that time, run the `e2e.duckdb` Outputs from A1.
   A pass is a clear "file is locked / in use" message, then a clean success when re-run after the 90 s.
2. **SQLite file locked.** `python3 -c "import sqlite3,time,os;c=sqlite3.connect(os.path.expanduser('~/Desktop/Sample_data/e2e/e2e.sqlite'),isolation_level=None);c.execute('BEGIN EXCLUSIVE');time.sleep(90)"`,
   then run an `e2e.sqlite` Output. Expect "database is locked" (or a retry), not a hang or a corrupt file.
   Afterwards, `e2e_stores` is still readable.
3. **Read and write the same file in one run.** Data Source `e2e duckdb` /
   `e2e_stores` → Output DuckDB `…/e2e/e2e.duckdb` table `e2e_stores_copy` → **5**.
   (The source and destination are the same file, so watch for a lock conflict.)
4. **Overwrite its own source.** Data Source `e2e duckdb` / `e2e_stores` →
   Output DuckDB `…/e2e/e2e.duckdb` table **`e2e_stores`**. A pass is refused, or
   still **5** rows. **0 rows = data loss (blocker)**, the file version of R1.

---

## Part B — Google Sheets

Spreadsheet: `https://docs.google.com/spreadsheets/d/1GzIkvu9tPmgbk1-1V5aFHAqmJzNex0JMP2xnsh8rxmw/edit?gid=520339955`
(id `1GzIkvu9tPmgbk1-1V5aFHAqmJzNex0JMP2xnsh8rxmw`). The tab at `gid=520339955`
holds `store_id, location`: 5 rows, 4 Phoenix. **That source tab must never be
written to.** All writes go to new `e2e_*` tabs in the same spreadsheet.

### B1 Source
1. Workflow `E2E Sheets`: Data Source `Google Sheets` → in the picker, open the
   spreadsheet above (search for it, or use its id) → pick the stores tab →
   👤 save location `~/Desktop/Sample_data/e2e/sheets_stores.csv`.
2. Preview: **5** rows, columns `store_id, location`.
3. Transformer: *"Keep only Phoenix stores."* → **4**.
4. `employees` (CSV) + this Sheets source → Join, destination **Postgres**:
   *"Inner join employees to stores on store_id, keep employee columns plus
   location. Target e2e_sheets_join."* → **20**.

### B2 Output: load into a new tab
Data Source `stores` → Output `Google Sheets`, the same spreadsheet, tab
**`e2e_new_tab`** (doesn't exist yet), **Append**. Run:
the tab is **created** and holds a header plus **5** rows.

### B3 Append, then truncate
1. Run again (Append) → **10** data rows, and the header appears **once**.
2. Switch to **Truncate & insert**, run → **5** rows. The tab itself still exists (not deleted and re-made).

### B4 Re-read after writing
Data Source on tab `e2e_new_tab` (👤 save location `…/e2e/sheets_new_tab.csv`),
preview → **5**. Repeat B3 step 1 (Append, giving 10), then re-run this Data
Source → **10**. This proves each run downloads a fresh copy.

### B5 Append with different columns
Data Source `employees` → Output `e2e_new_tab`, **Append**. The tab's header is
`store_id, location`, so only `store_id` can be filled: expect **20** new rows
with `location` empty. A pass needs the run message to say
`employee_id` and `name` were left out. A silent drop is a minor bug; shifted
values in the wrong columns are a major one. Afterwards, truncate the tab back to `stores` (5).

### B6 Edge cases
| # | Do | A pass looks like |
|---|---|---|
| S1 | `products` → tab `e2e_products`, Truncate. Read it back as a Data Source (👤 save) and sum `price` | Sum **2535.00**. Note whether the cells are numbers or text in Google Sheets (values are written RAW) |
| S2 | `stores` → tab **`e2e o'brien 表`** | Tab created with that exact name; 5 rows |
| S3 | An empty source (`E2E edge sqlite` / `empty_table` from scenario 50; skip if missing) → `e2e_new_tab`, **Truncate** | The tab is **left as it was** (5 rows); a warning, not a wipe |
| S4 | An Output whose spreadsheet is a **name** that doesn't exist (type `e2e_typo_sheet` instead of picking) | Note what happens: the code creates a **new spreadsheet** with that name. Report it (an Output that silently creates a spreadsheet on a typo is worth a warning) and check Google Drive |
| S5 | After everything | The original stores tab (`gid=520339955`) still holds exactly the 5 original rows |

---

## Checks
- [ ] A1: `e2e_*` tables written into all 4 files, replaced on re-run; existing tables untouched (1M / 10M / 10M)
- [ ] A2: all tables preview; 10M-row previews fast; new tables listed without re-adding
- [ ] A3: in-place edits land **in the file** on all 4 connections (12/18, 27)
- [ ] A4: honest about where a new table goes
- [ ] A5: 108 · PHOENIX 899590 / LOS ANGELES 100410 · join-into-file request answered honestly
- [ ] A6: 27 in Postgres · 1M Parquet
- [ ] A7: lock errors are clear and recoverable · same-file read and write works · self-overwrite doesn't lose data
- [ ] B1: Sheets source 5 → 4 Phoenix → join 20
- [ ] B2–B4: new tab created · append 10 with one header · truncate 5 · re-read picks up fresh data
- [ ] B5: mismatched columns reported, nothing shifted
- [ ] B6: S1–S5 as described; source tab untouched
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the `e2e_*` tables and tabs; list them. Tables can be dropped from the
Data Explorer later if wanted. Don't drop anything not prefixed `e2e_`.
