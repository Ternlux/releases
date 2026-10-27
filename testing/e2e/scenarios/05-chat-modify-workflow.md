# 05-chat-modify-workflow

**Area:** chat assistant (builder), workflow editor
**Uses:** the `E2E Employee Stores …` workflow from scenario 04 (run 04 first;
if it doesn't exist, mark this scenario BLOCKED)
**Cost:** a few builder calls

## Ground truth
- Phoenix-only employees: 18 rows. Los Angeles-only: 2 rows.

## Steps
1. Open the `E2E Employee Stores …` workflow in the editor.
2. With the workflow open, ask the assistant: *"Add a step after the join that
   keeps only employees whose store is in Phoenix."*
3. Accept the plan, run, and check the row count.
4. Select the new Transformer node on the canvas and refine it from chat:
   *"Actually, keep only Los Angeles instead."*
5. Run again and check the row count.
6. Re-run the finished workflow a second time without changes.
7. Ask for something impossible: *"Change the join to append mode."* (joins
   don't support append). Judge the answer.
8. Open the workflow's version history and revert to the version before step 4.

## Checks
- [ ] Step 2 adds a transformer after the join (it does not rebuild the whole workflow or touch the sources).
- [ ] Phoenix filter → 18 rows.
- [ ] Refinement edits the selected node (does not add a second one) → 2 rows.
- [ ] Re-running gives the same 2 rows — nothing duplicated.
- [ ] The impossible request gets an honest, useful explanation — no fake success.
- [ ] Reverting restores the Phoenix version.
- [ ] No renderer console errors or main-process errors.

## Cleanup
Leave it; list it under "Left behind".
