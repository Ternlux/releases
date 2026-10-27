# 21-cloud-storage

**Area:** cloud storage and Google Sheets as output, source and join input
**Uses:** `amazon_s3`, `Google Cloud Storage`, `Azure blob`, `Dropbox`,
`Google_Drive`, `Onedrive`, `Google Sheets`; local `stores`, `employees`
**Cost:** about 8 assistant builds
**Requires:** valid OAuth tokens (👤 re-authorize any that expired). Part 2 needs 👤 save-location dialogs.

Cloud nodes are configured in the **workflow editor** (the in-app cloud
browser), not through chat.

## Part 1 — Output: upload to each service
Create workflow `E2E Cloud Output`: Start, then Data Source `stores` → one Output per service:

| Output to | Container (pick in the browser) | Object path |
|---|---|---|
| `amazon_s3` | bucket `ternlux` | `e2e/stores.csv` |
| `amazon_s3` | bucket `ternlux` | `e2e/stores.json` |
| `Google Cloud Storage` | any bucket you can write to | `e2e/stores.csv` |
| `Azure blob` | any container | `e2e/stores.csv` |
| `Dropbox` | all files | `e2e/stores.csv` |
| `Google_Drive` | My Drive | `e2e/stores.csv` |
| `Onedrive` | root | `e2e/stores.csv` |

Also add Data Source `employees` → Output `Onedrive` `e2e/employees.csv`.

**Google Sheets:** 👤 ask the person which spreadsheet is safe for testing, and
use a tab named `e2e_stores` (create the tab in Google Sheets if the picker
can't). Output `stores` → that tab, **Append**.

1. Run the workflow. In each service's in-app browser, the object exists.
   `stores.json` is a JSON array of **5**.
2. Run again. Each cloud object is **replaced** (still 5 rows). The Sheets tab
   now has **10** data rows (append).
3. Switch the Sheets output to **Truncate & insert** and run: the tab has **5** rows.

## Part 2 — Source: read each object back
Create workflow `E2E Cloud Source`. For each service: Data Source → cloud
browser → pick `e2e/stores.csv` → 👤 choose where to keep the downloaded copy:
`~/Desktop/Sample_data/e2e/cloud_<service>_stores.csv`. Then add a Transformer:
*"Keep only the stores in Phoenix, as a new table."*
Do the same for the Sheets tab `e2e_stores`.

1. Run each Transformer: **4** rows each.
2. **Refresh test (S3 only):** In `E2E Cloud Output`, add Output `employees` →
   S3 `e2e/refresh.csv` and run it. In `E2E Cloud Source`, add a Data Source on
   S3 `e2e/refresh.csv` (👤 save location) and preview it: **20**. Change that
   Output's source to `stores`, run it, then re-run the Data Source: the preview
   is now **5**. This proves the re-run pulled a fresh copy.

## Part 3 — Joins with cloud inputs
Create workflow `E2E Cloud Join`:
1. S3 `e2e/stores.csv` + OneDrive `e2e/employees.csv` → Join, local:
   *"Inner join employees to stores on store_id, keep all employee columns plus location."* → **20** (18 Phoenix).
2. Google Sheets `e2e_stores` + Postgres `e2e_employees` (from scenario 10) → Join,
   destination `Postgres`, target `e2e_x_sheets_pg` → **20**.

## Part 4 — Honesty check
In a new chat, ask the builder: *"Build a workflow that reads stores.csv from
my S3 bucket and filters it to Phoenix."* The docs say cloud nodes can't be
configured from chat. Judge whether it explains that and offers what it can
(everything downstream), without pretending.

## Checks
- [ ] Part 1: every service receives the object · JSON is a 5-element array · objects replaced on re-run · Sheets append 10 → truncate 5
- [ ] Part 2: every service reads back · Phoenix = 4 each · refresh 20 → 5
- [ ] Part 3: 20 · 20
- [ ] Part 4: honest explanation, no fake success
- [ ] Expired or unauthorised connections give a clear message (record which)
- [ ] No renderer console errors or main-process errors

## Cleanup
Leave the `e2e/` objects; list them under "Left behind".
