# 04-chat-build-join-workflow

**Area:** chat assistant (builder), workflow editor
**Uses:** `employees`, `stores`
**Cost:** a workflow build (several LLM calls)

## Ground truth
- `employees` ⋈ `stores` on `store_id` (inner): 20 rows.
- Result columns should include `employee_id`, `name`, `store_id`, `location`.
- 18 employees are in Phoenix, 2 in Los Angeles.

## Steps
1. Start a new chat session with the assistant.
2. Send: *"Build a workflow named E2E Employee Stores <run timestamp> that joins
   the employees connection with the stores connection on store_id and saves
   the result as a new local table called e2e_employee_stores. Keep all
   employee columns and add the store location."*
3. Answer any clarifying questions sensibly. Note whether each question was
   necessary and whether it re-asks anything already stated.
4. Review the plan card before accepting. Accept it.
5. Watch the canvas draw the nodes as it builds.
6. Read the review verdict. If it says something doesn't match, click
   **Fix it** once and judge whether the fix was right.
7. Use the **Run this node** button (or run the workflow) and wait for it to finish.
8. Check the output (node Data Preview, or query `e2e_employee_stores` in the
   Data Explorer if it is reachable there).

## Checks
- [ ] The assistant's plan matches the request (join on store_id, new local table, correct name).
- [ ] No unnecessary or repeated clarifying questions.
- [ ] Canvas shows Start → two sources → Join → (Output) wired correctly.
- [ ] Review verdict is accurate (it doesn't claim a match when the output is wrong, or the reverse).
- [ ] The run succeeds; the output has 20 rows with a `location` column; Phoenix 18 / LA 2.
- [ ] The workflow appears in the workflows list under the requested name.
- [ ] No renderer console errors or main-process errors (watch for "could not be cloned").

## Cleanup
Leave it — scenario 05 modifies this workflow.
