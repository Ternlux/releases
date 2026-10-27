# 50-edge-setup-and-load

**Area:** loading messy files: CSV quirks, odd file names, Excel layouts, nested and large JSON, wide tables
**Uses:** the fixtures in `_EDGE.md`
**Cost:** none
**Requires:** nothing. Every 5x scenario needs this one first.

## Steps
1. From the repo: `python3 testing/e2e/fixtures/make_edge_fixtures.py`, which
   (re)builds the files and `EXPECTED.json`.
2. 👤 Add the 7 fixture files as local-file connections with the names in the
   `_EDGE.md` table. Keep any that already exist.
3. Open each in a Data Source picker and its preview, in a scratch workflow
   `E2E Edge Load`, and record:

| Connection | Check |
|---|---|
| `E2E edge values` | 200 rows · `zip` of id 13 shows `02947` · São Paulo / 東京 / القاهرة / 👨‍👩‍👧‍👦 render correctly (no `?` or `Ã©`) · a note with a newline is one cell, not a broken row · the first column is `id`, not `﻿id` (BOM handled) |
| `E2E edge names` | 15 columns, all names shown exactly (`Amount ($)`, `名前`, `🚀 launch`, the 70-char one); the duplicate shows as `dup` + `dup_1`, the empty header as `column14` (or another clear name) |
| `E2E edge nested` | 500 rows; `customer` and `items` display usefully (expandable, or readable JSON, not `[object Object]`); `promo` is empty for the first rows |
| `E2E edge nested big` | Adding and previewing completes; **note the time**. The UI stays responsive (switch tabs while it loads). Row count **120,000** |
| `E2E edge sqlite` | All **11** tables listed; `wide_150` preview scrolls horizontally and shows `r7c123` in column `c0123`, row 7; `very_wide_1100` opens without freezing; `empty_table` previews as 0 rows with its column headers |
| `E2E edge book` | 4 tables (one per sheet). `Sales 2024`: is the header `region, amount, sold_on`, or the merged title "Q1 Sales Report"? Report what happens. `数据` has 10 rows; `Empty` gives 0 rows or a clear message; `Dates & %` shows real dates/times and 0.125-style fractions, not Excel serial numbers |
| `E2E edge quirky` | Registers despite the `'`, spaces, `( )` and ✓ in the path; 5 rows |

4. Data Explorer on `E2E edge values`: `SELECT city, count(*) FROM <table> GROUP BY city` →
   six cities with 33/34 each, as in `EXPECTED.json`.
5. Data Explorer on `E2E edge nested`: `SELECT customer.address.geo.meta.accuracy.level.depth7.depth8 FROM <table> LIMIT 1` → `leaf`.

## Checks
- [ ] All 7 connections added; table lists correct
- [ ] Values, unicode and emoji preserved; BOM and CRLF handled; embedded newlines are not row breaks
- [ ] Column names exact; duplicate and empty headers handled visibly
- [ ] Nested JSON readable at depth 8; big JSON loads with a responsive UI (time recorded)
- [ ] Wide tables usable; 1,100 columns doesn't freeze the app
- [ ] Excel: the title-row behaviour is reported; dates are real dates
- [ ] Quirky file name works
- [ ] No renderer console errors or main-process errors
