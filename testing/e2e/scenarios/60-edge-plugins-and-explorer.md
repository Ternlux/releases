# 60-edge-plugins-and-explorer

**Area:** plugin catalog (install and uninstall) and Data Explorer edge cases (R8)
**Uses:** the Connections tab connector picker; `customers`, `E2E edge values`, `E2E edge sqlite`; Postgres, mongo
**Cost:** none
**Requires:** 50

## Part 1 — Plugin catalog (observe, don't uninstall)
**Never call `electronAPI.plugins.uninstall` / `install` through
`browser_evaluate`.** In the dev build they write to the repo's `plugins/connectors/` folder (R8).

1. Connections → add a connection → the connector picker. Record which connectors
   show as installed and which as installable, and use the search box and the installed/all filter.
2. Is any connector offered for **install**? If yes, install **one that you don't
   already have connections for**. The message says it's installed and it
   becomes selectable right away. If none is offered, record "catalog has nothing
   to install in this build".
3. Look for an **uninstall** option anywhere: picker, settings, plugin list.
   The tester guide asks to "uninstall one"; if there's no UI for it, report it as
   a missing feature (minor). Don't use internal APIs.
4. Check that **Redshift** (disabled) and **SharePoint** (not offered) don't
   appear as choosable connectors, and that every installed one opens its form.
5. 👤 Optional, only if the person agrees: sign out. Plugin connectors show as
   locked with a sign-in prompt; local-file connectors stay available. Sign back in.

## Part 2 — Data Explorer edge cases
| # | Do | A pass looks like |
|---|---|---|
| D1 | `customers` (100k rows): `SELECT * FROM customers` | Returns quickly with a row cap or paging, clearly labelled; no freeze; scrolling works |
| D2 | Postgres: a long query, `SELECT pg_sleep(30)`, then cancel it | A cancel control exists and works, or the limit is stated |
| D3 | Postgres: `SELECT 1/0` | The engine's error, shown clearly |
| D4 | `E2E edge values`: `SELECT city, emoji, note FROM … WHERE id <= 6` | Unicode, emoji and multi-line notes render in the grid; copying a cell keeps them |
| D5 | Export that result as CSV and as JSON | 👤 if a save dialog appears. python3: the file has the same 6 rows, and unicode is intact (UTF-8) |
| D6 | `E2E edge sqlite`: `SELECT * FROM very_wide_1100` | Renders 1,100 columns without freezing; horizontal scroll works |
| D7 | Postgres: `CREATE TABLE e2e_explorer_t (id int); INSERT INTO e2e_explorer_t VALUES (1); DROP TABLE e2e_explorer_t;` | Behaviour recorded: multiple statements, and **whether a confirmation is asked** before the DROP (the tester guide calls out "no confirmation step") |
| D8 | mongo: `db.e2e_nested.find({"customer.address.city": "Zürich"}).limit(5)` (from 54) | 5 documents; nested results display usefully |
| D9 | Syntax check: type `SELEC * FROM stores` and `SELECT "名前" FROM t` | The first is flagged; the second (valid) is **not** |
| D10 | Open 5 worksheets on different connections, close the app, reopen | All 5 come back with their text |

## Checks
- [ ] Catalog reflects the installed state; install works if offered; uninstall gap reported if there's no UI
- [ ] Disabled connectors hidden
- [ ] D1–D10 as described; any freeze is a major issue
- [ ] No renderer console errors or main-process errors
