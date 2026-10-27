# BigQuery connector

Google's serverless data warehouse. Different from the standard
relational connectors in three ways: identifiers are dataset-qualified,
authentication is by OAuth rather than a host/username/password, and
the dialect supports nested and repeated fields.

Authentication is the same user-consent flow as Google Drive, Sheets,
and Cloud Storage. Ternlux opens your browser to authorise, captures
the redirect on a local port, exchanges the code for tokens, and
stores them encrypted. Tokens auto-refresh when they expire.

Queries run **as the signed-in user**, so their own BigQuery IAM roles
decide what can be read and written. There is no service-account key
file to mint, hand around, or leak.

## What it lets you do

- Test that Ternlux can reach BigQuery with your credentials.
- List datasets and the tables and views inside each.
- List columns of any table.
- Run any BigQuery SQL query.
- Stream large query results in batches.
- Insert rows in bulk.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Project ID | Yes | Yes | — |
| Dataset | Yes | No | — |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |
| Location | No | No | US |

The access token, refresh token, and expiry are filled in
automatically when you authorise. The project id, dataset, and
location are stored with the connection so the assistant and previews
can use them without prompting.

**Project ID is still required.** A user's OAuth token carries no
project of its own, and it is the project queries are billed to.

## Setting up credentials

### Step 1 — Sign in to Google Cloud

Open the [Google Cloud Console](https://console.cloud.google.com)
and select the project that owns the BigQuery dataset you want to
connect to.

### Step 2 — Enable the BigQuery API

Go to **APIs & Services → Enabled APIs & services** and confirm the
**BigQuery API** is enabled. If not, click **+ Enable APIs and
services**, search for "BigQuery API", and enable it.

### Step 3 — Configure the OAuth consent screen

If you haven't yet:

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose the **User type** — **Internal** or **External**. This is
   the decision that determines whether the people you hand these
   credentials to hit a warning screen. Read **Internal vs
   External** below before picking.
3. Fill in app name, support email, and developer contact.
4. Add the scope `https://www.googleapis.com/auth/bigquery` — it
   covers datasets, tables, jobs, and streaming inserts, which is
   everything this connector calls.
5. If you picked External and are leaving the app in **Testing**,
   add everyone who will authorise under **Test users**.

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Desktop app**. Ternlux is an installed
   desktop application, not a hosted web app.
4. Name: `Ternlux`.
5. Click **Create** and copy the **Client ID** and **Client
   Secret**.

A Desktop app client has no **Authorized redirect URIs** field —
Google accepts loopback redirects (`http://localhost:…`,
`http://127.0.0.1:…`) from these clients automatically, so Ternlux's
default redirect works with nothing to register.

### Step 5 — Grant the signing-in user the right roles

The OAuth scope grants *reach*, not *permission*. The Google account
you authorise with still needs IAM roles. For read + write access to
a dataset:

- **BigQuery Data Editor** — read, insert, update, delete tables in
  any dataset.
- **BigQuery Job User** — run queries.

For read-only access, replace **BigQuery Data Editor** with
**BigQuery Data Viewer**.

You can also scope access to a single dataset (recommended) by
opening the dataset in BigQuery, clicking **Sharing → Permissions**,
and granting the account the appropriate role on that dataset alone.

### Step 6 — Enter the credentials in Ternlux

- **Project ID** — your GCP project id (e.g. `my-gcp-project`).
- **Dataset** — the dataset Ternlux should default to.
- **OAuth Client ID** / **OAuth Client Secret** — from step 4.
- **Redirect URI** — leave it at the default. Ternlux listens on
  **port 3000**, so the port here must stay `3000`; the path is
  ignored by the local callback server.
- **Location** — the BigQuery region of your dataset (e.g. `US`,
  `EU`, `us-central1`). This must match the dataset's location.

### Step 7 — Authorise

Click **Authorize** in the form, sign in with the Google account that
holds the BigQuery roles, and consent. Ternlux saves the resulting
tokens encrypted.

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
  everyone has to click Authorize again. Nothing in Ternlux can
  refresh past this — the refresh token itself is dead.
- **Publish the app and submit for OAuth verification.** The warning
  disappears for everyone and the 7-day expiry goes away. This is
  what you want if you're distributing these credentials to people
  outside your organisation.

Verification is required because
`https://www.googleapis.com/auth/bigquery` is in Google's
**sensitive** scope tier — a published External app requesting it is
reviewed before the warning is dropped.

Verification is per Cloud project. If each of your users brings their
own client id and secret, each of them is the developer of their own
unverified app and will see this screen on their own machine;
verifying your project does not cover theirs.

## Behaviour notes

- Tables are referenced as `dataset.table`. The connector applies the
  correct backtick quoting automatically when the AI generates SQL.
- The location parameter affects which Google region your queries
  execute in.
- Nested and repeated fields (ARRAY, STRUCT) are supported in the
  dialect — they appear in column listings with their full type.
- Primary keys are not enforced in BigQuery; column listings still
  report a primary-key flag for compatibility but it's informational
  only.
- Generated AI prompts for BigQuery suggest partitioning and
  clustering when a new table is being created.
- Writes go in larger batches than other engines. Each batch insert is a
  BigQuery load job, and load jobs are capped per table per day, so the
  connector asks for bigger chunks — small ones would cap a table at a
  fraction of a day's data however much there was to write.
- Permission errors are about the *signed-in user's* IAM roles, not
  about the OAuth client — re-authorising will not fix them.
- Connections saved before the move to OAuth, which stored a service
  account JSON, keep working; the form no longer offers that field,
  so re-saving such a connection switches it to OAuth.
