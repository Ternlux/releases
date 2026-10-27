# 03-editor-build-manually

**Area:** workflow editor
**Uses:** `employees`
**Cost:** none

## Ground truth
- `employees`: 20 rows, columns `employee_id, name, store_id`.

## Steps
1. Create a new workflow named `E2E Manual <run timestamp>`.
2. Drag in a Start node, a Data Source node and an Output node, and wire them
   Start → Data Source → Output.
3. Configure the Data Source to read `employees`.
4. Configure the Output to write to a destination that does **not** need an OS
   file dialog (a local table/DuckDB, or a database table named
   `e2e_employees_<timestamp>`). If every output option needs a file dialog,
   mark the run steps BLOCKED and report that.
5. Try invalid wiring: connect a Data Source into another Data Source; connect
   two inputs into a Transformer (add one temporarily). Note how the app
   refuses, then remove anything extra.
6. Rename the Data Source node; move nodes around.
7. Open Data Preview / Details on the Data Source node.
8. Save. Leave the editor, reopen the workflow.
9. Run the workflow from the canvas and watch the execution monitor.
10. Open the run in the Executions tab.

## Checks
- [ ] Nodes can be added, wired, renamed and moved.
- [ ] Invalid wiring is refused with a clear message (or visibly impossible).
- [ ] Data Preview shows 20 employee rows.
- [ ] After reopening, nodes, wiring, names, positions and config are exactly as saved.
- [ ] Execution monitor shows live progress and ends in success.
- [ ] Executions tab shows the run with per-node timings and 20 rows written.
- [ ] No renderer console errors or main-process errors.

## Cleanup
Leave the `E2E Manual …` workflow; list it under "Left behind".
