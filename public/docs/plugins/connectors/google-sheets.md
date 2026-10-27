# Google Sheets connector

Reads and writes Google Sheets. It is registered as a **cloud-storage**
connector — the spreadsheet is the container and its tabs are the
objects — while also speaking enough of the database surface (tables,
columns, queries) for a tab to be read like a table.

## What it lets you do

- Test that Ternlux can reach Google Sheets with your authorised
  account.
- Browse your spreadsheets and the tabs inside them, through the same
  picker the other cloud-storage connectors use.
- List the sheets inside a spreadsheet, and infer a sheet's columns from
  its first rows (the first row is treated as the header).
- Fetch a sheet's rows, streamed in batches for a large sheet.
- Download a tab as CSV, and write rows back into a tab.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, refresh token, and expiry date are filled in
automatically when you authorise.

## Setting up credentials

You need to register an OAuth client in your own Google Cloud
project so Ternlux can authorise on your behalf.

### Step 1 — Open Google Cloud Console

Go to the [Google Cloud Console](https://console.cloud.google.com)
and either pick an existing project or create a new one.

### Step 2 — Enable the required APIs

Go to **APIs & Services → Enabled APIs & services** and click
**+ Enable APIs and services**. Enable both:

- **Google Sheets API**
- **Google Drive API** (Ternlux needs this to discover spreadsheets
  you have access to)

### Step 3 — Configure the OAuth consent screen

If you haven't yet, configure the consent screen:

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose the **User type** — **Internal** or **External**. This is
   the decision that determines whether the people you hand these
   credentials to hit a warning screen. Read **Internal vs
   External** below before picking.
3. Fill in the app name, support email, and developer contact email.
4. Add the scopes:
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/drive.file`
5. If you picked External and are leaving the app in **Testing**,
   add everyone who will authorise under **Test users**.

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `Ternlux` (or whatever you like).
5. Under **Authorized redirect URIs**, add
   `http://localhost:3000/oauth/callback`.
6. Click **Create**. Google shows the **Client ID** and **Client
   Secret** — copy both.

### Step 5 — Enter the credentials in Ternlux

Paste the **Client ID** and **Client Secret** into the form. Leave
the redirect URI as the default unless you changed it in step 4.

### Step 6 — Authorise

Click **Authorize** in the form. Ternlux opens your browser at
Google's authorisation page, you sign in with the account that owns
the sheets, and consent. The browser hands back a code, Ternlux
exchanges it for tokens, and the connection is saved encrypted.

Tokens auto-refresh in the background within a five-minute buffer of
expiry, so a workflow run never lands on a stale token.

## Internal vs External

The **User type** you picked on the consent screen decides what the
people using these credentials see when they click **Authorize**.

### Internal — no warning

Available only when the Cloud project belongs to a Google Workspace
organisation, and only for users inside that same organisation.
Nothing to verify, no warning screen, no test-user list to maintain,
and refresh tokens don't expire on a timer.

**If everyone using this connection is in your Workspace org, pick
Internal.** It is the simplest setup by a wide margin.

### External — expect the "unverified app" screen

Anyone with a Google account can authorise, but until Google has
reviewed the app its users see:

> Google hasn't verified this app

They can continue anyway: click **Advanced**, then **Go to \[your app
name\] (unsafe)**. That is safe here — "unverified" means Google
hasn't audited the OAuth client, not that anything is wrong with it.
You created the client, in your own project, reaching your own data.

From there you have two choices:

- **Leave it in Testing.** Add each person under **Test users** (max
  100). Fine for a small group or for trying things out. **Caveat:**
  Google expires refresh tokens after **7 days** in this mode, so the
  connection stops working about a week after it's authorised and
  everyone has to click Authorize again. This overrides the
  auto-refresh described above — the refresh token itself is dead, so
  there is nothing left for Ternlux to refresh with.
- **Publish the app and submit for OAuth verification.** The warning
  disappears for everyone and the 7-day expiry goes away. This is
  what you want if you're distributing these credentials to people
  outside your organisation.

Verification is required because
`https://www.googleapis.com/auth/spreadsheets` is in Google's
**sensitive** scope tier — a published External app requesting it is
reviewed before the warning is dropped. (`drive.file` on its own is
not sensitive; it only ever reaches files the user picks or Ternlux
creates.)

Verification is per Cloud project. If each of your users brings their
own client id and secret, each of them is the developer of their own
unverified app and will see this screen on their own machine;
verifying your project does not cover theirs.

## Behaviour notes

- A spreadsheet is identified by its spreadsheet ID; a sheet by its
  sheet name.
- Schema is inferred from the first few rows of the sheet (the first
  row is treated as the header).
- A Sheets connection is browsed like cloud storage: the spreadsheet is
  the container and its tabs are the files. Picking a tab needs that
  picker, so a Sheets source or destination cannot be configured from
  chat.
- When you point a Data Source node at a tab, the tab is downloaded as
  CSV to the path you chose and read in place by DuckDB, and it is
  re-downloaded on every run — so the data is never a frozen snapshot.
- As an Output destination a tab keeps its rows between runs, so it is
  one of the destinations that offers a write mode: append, or clear the
  tab first.
