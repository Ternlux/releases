# 63-edge-auth-and-gating

**Area:** account sign-in (email + verification, Google, Apple), plugin-connector gating,
sign-out, an expired token, offline start
**Uses:** the Connections tab connector picker; Settings → Account
**Cost:** none (no AI builds); several 👤 steps
**Requires:** nothing

## Ground truth (from the code, not the app)
- Onboarding is key-first: the app requires an LLM API key; sign-in is a separate,
  skippable step. A sign-in alone does not unlock the app.
- Sign-in exists to gate **plugin connectors**: anything not in `NO_PLUGIN_REQUIRED` in
  `src/components/Workflows/ConnectionTypeSelector.js` is locked when signed out, with a
  "Login to access" path that opens Settings → Account.
- The token lives in localStorage `auth-token` / `auth-user` (`src/utils/authService.js`),
  30-day JWT. Google sign-in is a system-browser loopback (`auth:google-login`); Apple is
  backend-brokered.
- **Never** read or print the token value in the report — only whether it is present.

## Steps
1. **Current state.** Settings → Account: signed in or not? Record which connectors in
   the "add connection" picker are locked and which are free. Existing connections that
   use locked connectors (Postgres, Snowflake, …) must keep working whatever the state
   (check one preview).
2. 👤 **Sign out** (if signed in). The picker now shows locked connectors with a clear
   "Login to access" path; it opens Settings → Account. Existing connections and
   workflows still open and run (run `E2E Postgres Seed`'s first pair or any small E2E
   workflow) — or, if they're blocked, the message says why. Record which.
3. 👤 **Sign in with email.** Use an address the person provides. Wrong password →
   clear error; unverified account → clear "verify your email" state; after verifying,
   connectors unlock without restarting.
4. 👤 **Sign in with Google.** The system browser opens (not an embedded window); after
   consent the app shows the account; cancel the browser flow once and check the app
   recovers (no stuck spinner).
5. **Token expiry (simulated, read-only for the bridge).** 👤 Ask the person whether they
   want to test it: in DevTools → Application → Local Storage, replace `auth-token`
   with a garbage string and reload. Expected: the app treats it as signed out (locked
   connectors), with no crash or loop of errors. Then sign in again (👤).
6. **Offline start.** 👤 Turn off Wi-Fi, restart the app: it starts, existing local
   workflows open and run (a CSV → local table workflow); signed-in state is shown
   sensibly; remote connections fail with clear network errors. Turn Wi-Fi back on.

## Checks
- [ ] Locked vs free connectors match `NO_PLUGIN_REQUIRED`; the lock message leads to sign-in
- [ ] Signing out never breaks existing workflows silently
- [ ] Email sign-in errors are clear; verification unlocks without a restart
- [ ] Google sign-in uses the system browser; cancelling recovers
- [ ] A bad/expired token degrades to signed-out cleanly
- [ ] Offline start works for local work; network errors are clear
- [ ] No token, password or OAuth code in the main log or `dev-logs/`
- [ ] No renderer console errors or main-process errors (beyond expected network failures offline)

## Cleanup
Leave the person signed in as they were at the start.
