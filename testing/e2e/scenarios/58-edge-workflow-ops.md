# 58-edge-workflow-ops

**Area:** workflow and app lifecycle edge cases: odd names, deleting things in use, concurrency, large workflows, persistence
**Uses:** `stores`, `employees`, `products` (CSV); the `E2E …` file connections from 20; Postgres
**Cost:** 2 AI builds
**Requires:** 20 (for `E2E json`)

## Steps
1. **Odd names:** create a workflow named `E2E Ödd / name "quoted" 🚀 ../x`.
   Add Data Source `stores` and rename it `a/b ../c "q" 🚀`; Transformer: *"Only
   Phoenix stores"* (→ 4); save, close, reopen. Everything is intact, and the
   files under the app's `workflow-code/` folder don't escape their folder (no
   `..` path, nothing written outside). List the folder contents.
2. **Delete a connection in use:** `E2E Files Transform` (from 20) uses `E2E json`.
   Delete the `E2E json` connection. Does the app warn that a workflow uses it?
   Then run `E2E Files Transform`: the run fails at that node with a clear
   message naming the missing connection, not a crash. 👤 Re-add `E2E json` afterwards.
3. **Delete a node in the middle of a chain:** in `E2E Edge Load` (or any E2E
   workflow) with Source → Transformer → Output, delete the Transformer. The
   Output is now unconnected: running reports it clearly; reconnecting
   Source → Output works.
4. **Invalid wiring:** try to connect a node to itself, create a cycle (A → B → A),
   wire a Source into a Source, and wire two inputs into a Transformer. Each is refused visibly.
5. **Two workflows at once:** run `E2E Postgres Seed` and `E2E MySQL Seed` (from
   10/11) simultaneously. Both succeed, the execution monitor shows both, and
   the counts are correct (5/20/30/108).
6. **Same workflow twice:** start `E2E Postgres Seed` and, while it runs, start
   it again. The second start is refused or queued with a message, never run in parallel.
7. **Big workflow:** ask the builder for a 12-node workflow: *"Build a workflow E2E
   Twelve: read stores, employees and products; filter each to Phoenix or
   premium; join employees with stores; join that with products_store; then
   write both joins and the filtered products to three local CSV files in
   ~/Desktop/Sample_data/e2e/edge/out/."* Run it. The canvas stays readable
   (auto-layout, no overlaps), the execution steps order is valid, and the runs succeed.
8. **Version history:** make 3 edits to `E2E Twelve` (rename nodes), revert to the
   first version, and check the canvas matches it.
9. **Persistence:** reload the window (`Cmd+R`, or `bash testing/e2e/app.sh stop && … start`).
   All E2E workflows, connections and chat sessions are back; a reopened
   transformer still has its chat history.

## Checks
- [ ] Odd names saved and reopened intact; `workflow-code/` stays inside its folder
- [ ] Deleting a connection in use: a warning, and a clear failure at run time
- [ ] Deleting a mid-chain node and invalid wiring are handled clearly
- [ ] Two different workflows run concurrently with correct results
- [ ] Re-starting a running workflow is refused or queued
- [ ] 12-node build runs; canvas readable
- [ ] Version revert restores the earlier state
- [ ] Everything persists across a reload
- [ ] No renderer console errors or main-process errors
