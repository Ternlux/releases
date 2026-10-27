# 22-rest-api

**Area:** REST API as source; its rows transformed, joined and output
**Uses:** `JSON_API` (base URL `https://jsonplaceholder.typicode.com/todos/1`, no key), `fixer trading API` (saved key), `Postgres`
**Cost:** about 7 assistant builds
**Requires:** nothing

## Part 1 — Source
Create workflow `E2E REST`: Start, then:
1. Data Source `JSON_API`. In chat: *"Fetch all users from
   https://jsonplaceholder.typicode.com/users"* → **10** rows.
   (The saved base URL ends in `/todos/1`; the request must still go to `/users`.)
2. Data Source `JSON_API`: *"Fetch all todos from https://jsonplaceholder.typicode.com/todos"* → **200** rows.
3. Data Source `JSON_API`: *"Fetch https://jsonplaceholder.typicode.com/this-does-not-exist"*.
   The build must **fail** with a clear reason (404, which endpoint), and must
   not leave a source with no schema. Then delete this node.
4. Data Source `fixer trading API`: *"Fetch the latest exchange rates."* →
   **1** row with a nested `rates` object. Open the node's generated code
   (panel or `workflow-code/`): it must use a `{{…}}` placeholder for the key,
   never the literal key.

## Part 2 — Transform
1. todos → Transformer: *"Keep only completed todos."* → **90**.
2. fixer → Transformer: *"One row per currency with its rate."* → more than
   100 rows, including `USD` and `GBP`.
3. users → note how nested `address` / `company` came out (JSON column,
   flattened columns?). Are they usable in a query? Record this as an observation.

## Part 3 — Join (two API sources)
users + completed-todos Transformer → Join, local:
*"Join users to completed todos on users.id = todos.userId, and count the
completed todos per user. Keep user id, name and the count. Target table e2e_user_completed."*
→ **10** rows; users **5** and **10** have **12**; user **4** has **6**.

## Part 4 — Output
After the join, add an Output → `Postgres` table `e2e_user_completed`, **Append**.
1. Run: **10**. Run again: **20** (append).
2. Switch to **Truncate & insert**, run: **10**.

## Part 5 — Re-run
Run the whole workflow twice. The API tables are refetched and replaced each
time: users stays 10, todos 200, completed 90, nothing doubled.

## Checks
- [ ] Part 1: 10 · 200 · failed build is clear · fixer code uses a placeholder
- [ ] Part 2: 90 · >100 currencies · nested fields: observation recorded
- [ ] Part 3: 10 rows, 12/12/6 spot-checks
- [ ] Part 4: 10 → 20 → 10
- [ ] Part 5: counts stable across re-runs
- [ ] No credential appears in any chat message, node panel or exported code
- [ ] No renderer console errors or main-process errors
