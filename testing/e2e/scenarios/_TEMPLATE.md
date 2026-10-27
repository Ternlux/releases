# <NN>-<short-name>

<!-- Files starting with "_" are not run. Copy this file to add a scenario.
     Describe GOALS, not click paths — the agent explores the UI like a user,
     and anything hard to find is itself a finding. -->

**Area:** workflow editor | chat assistant (builder) | chat assistant (analyst) | data explorer | executions
**Uses:** <connection names from the app, e.g. `employees`, `stores`>
**Cost:** none | a few chat messages | a workflow build (several LLM calls)

## Ground truth
<!-- Facts the agent checks against, computed from the source files, not the app. -->
- `employees` has 20 rows.

## Steps
1. …
2. …

## Checks
- [ ] …
- [ ] No renderer console errors or main-process errors during the scenario.

## Cleanup
<!-- What to delete afterwards, if anything. Default: leave it and list it. -->
