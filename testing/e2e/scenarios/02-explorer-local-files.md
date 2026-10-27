# 02-explorer-local-files

**Area:** data explorer
**Uses:** `employees`, `stores`, `products`
**Cost:** none

## Ground truth
- `employees`: 20 rows, columns `employee_id, name, store_id`.
- `stores`: 5 rows — ST-001 Phoenix, ST-002 Los Angeles, ST-003/004/005 Phoenix.
- `employees` joined to `stores` on `store_id`: 20 rows; 18 in Phoenix, 2 in Los Angeles.
- `products`: 30 rows, average price 84.50, max price 149.77, min 24.87.
  Both extremes are named "White T-Shirt" (the name is not unique).

## Steps
1. Open the `employees` connection in the Data Explorer and browse its tree.
2. Double-click the table for a preview; single-click it to see its columns.
3. In a worksheet, write a query counting employees per store location by
   joining `employees` with `stores` (both local files — join them in one
   statement if the explorer allows it; if it doesn't, report how a user is
   told that). Run it with `Cmd+Enter`.
4. Write two statements in the worksheet, select only one, and run just the
   selection.
5. Type a deliberately messy one-line query and use Format.
6. Write a query with a typo (`SELEC * FROM products`) and run it.
7. Open a second worksheet on `products`, get the average/min/max price.
8. Find the first query again in query history and re-run it.

## Checks
- [ ] Preview shows 20 employee rows; columns are listed correctly.
- [ ] Location counts are Phoenix 18, Los Angeles 2.
- [ ] Only the selected statement ran.
- [ ] Format produced readable SQL without changing its meaning.
- [ ] The typo gives a clear error (flagged before or on running), and valid SQL is not flagged.
- [ ] Price stats are 84.50 / 149.77 / 24.87.
- [ ] Both worksheets survive closing and reopening the connection.
- [ ] History contains the earlier query and re-running it gives the same result.
- [ ] No renderer console errors or main-process errors.

## Cleanup
Close the worksheets you opened; nothing else created.
