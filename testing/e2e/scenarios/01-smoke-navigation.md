# 01-smoke-navigation

**Area:** whole app
**Uses:** existing connections and workflows (read-only)
**Cost:** none

## Ground truth
- The profile has ~38 saved connections, including `employees`, `stores`,
  `products`, `products_store`, `customers` (local files) and `Postgres`,
  `mysql`, `mongo`, `snowflake` (databases).
- The profile has 100+ saved workflows, including `Top 10 Customers by Spend`.

## Steps
1. Visit every top-level area of the app (workflows list, connections, Data
   Explorer, chat assistant, executions, settings — whatever the navigation offers).
2. In the connections list, find `employees` and open its details / preview
   without editing it.
3. In the workflows list, open `Top 10 Customers by Spend` in the editor **without
   running or changing it**. Click a couple of nodes to open their side panels,
   then leave the editor. If it asks about unsaved changes, choose not to save.
4. Open the Executions tab and open the most recent execution's details.

## Checks
- [ ] Every area loads without a blank screen, spinner that never ends, or error toast.
- [ ] Connection and workflow lists show the ground-truth items.
- [ ] Node side panels open and show the node's configuration.
- [ ] Leaving the editor without edits does not mark the workflow modified.
- [ ] Execution details show per-node status/timings.
- [ ] No renderer console errors or main-process errors.

## Cleanup
Nothing created.
