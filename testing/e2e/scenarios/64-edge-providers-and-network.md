# 64-edge-providers-and-network

**Area:** AI provider failures and switching; network loss mid-run
**Uses:** `employees`, `stores` (CSV); Postgres, mysql, snowflake
**Cost:** about 4 AI builds
**Requires:** 10, 11, 13

## Ground truth
- `employees` ⋈ `stores` on store_id = **20** (18 Phoenix / 2 Los Angeles).
- Seen before: an OpenAI 120 s timeout gives "OpenAI didn't respond within 120s… try again,
  or pick another provider" (clear) but no Retry on that message.

## Steps
1. **Which providers are configured.** Settings → AI Provider: list the configured
   providers and the default model. Don't change keys yourself.
2. **Switch provider.** If a second provider is configured: 👤 ask to switch the default
   to it (or switch it yourself if it's just a dropdown choice the person approves).
   Build *"Build a workflow named E2E Provider Switch that inner joins the employees CSV
   with the stores CSV on store_id into a local table e2e_provider_switch."* → 20 rows.
   Check `dev-logs/ai-prompts.json` names the selected model (not the previous one). Switch
   back afterwards.
3. **Invalid key.** 👤 Only with the person's go-ahead: they set an obviously wrong key
   for the active provider (or a provider the app falls back to). Send one chat message.
   Expected: a clear "invalid API key" message naming the provider, no retry loop, the
   chat usable afterwards. 👤 Restore the key.
4. **No provider.** Skip unless the person offers a throwaway profile — never remove keys
   from the real profile.
5. **Network loss mid-build.** Start a build (*"Build a workflow named E2E Net Build that
   inner joins e2e_employees from Postgres with e2e_stores from mysql on store_id into a
   new mysql table e2e_net_build."*), accept the plan, and 👤 turn Wi-Fi off while it is
   building. Expected: the build stops with a network error; nothing half-saved; after Wi-Fi
   is back, Retry / a new message works.
6. **Network loss mid-run.** Run `E2E X3` (mssql + snowflake → snowflake, staging) and
   👤 turn Wi-Fi off during staging. Expected: the run fails with a network error naming
   the connection; after Wi-Fi returns, the next run succeeds (**20**) and Snowflake has no
   leftover `temp_…` table (`SHOW TABLES LIKE 'temp%'`).

## Checks
- [ ] Provider switch takes effect immediately and is what the prompts log shows
- [ ] Invalid key / timeout errors are clear, name the provider, don't loop
- [ ] Network loss during a build leaves nothing half-saved; recovery works
- [ ] Network loss during a run: clear error, no orphan staging tables after the next good run
- [ ] No renderer console errors or main-process errors beyond the expected network failures

## Cleanup
Restore the original provider and key. Leave E2E workflows/tables; list them.
