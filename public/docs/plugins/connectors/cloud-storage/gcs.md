# Google Cloud Storage connector

Object storage on Google Cloud. Authenticated by OAuth — the same
user-consent flow as Google Drive and Google Sheets. Ternlux opens
your browser to authorise, captures the redirect on a local port,
exchanges the code for tokens, and stores them encrypted. Tokens
auto-refresh when they expire.

Requests are made **as the signed-in user**, so what a connection can
reach is exactly that user's own Cloud Storage IAM grants. There is no
service-account key file to mint, hand around, or leak.

## What it lets you do

- List your buckets.
- List objects in a bucket.
- Download an object as a file.
- Upload a file as an object.
- Delete an object.
- Inspect object metadata.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Project ID | Yes | Yes | — |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |
| Bucket | No | No | — |

The access token, refresh token, and expiry are filled in
automatically when you authorise.

**Project ID is still required.** A user's OAuth token carries no
project of its own, and listing buckets is a project-scoped call, so
Ternlux has to be told which project to bill and browse.

## Setting up credentials

### Step 1 — Open Google Cloud Console

Go to the [Google Cloud Console](https://console.cloud.google.com)
and pick the project that owns the buckets.

### Step 2 — Enable the Cloud Storage API

Go to **APIs & Services → Enabled APIs & services** and confirm the
**Cloud Storage API** is enabled. If not, click **+ Enable APIs and
services**, search for "Cloud Storage API", and enable it.

### Step 3 — Configure the OAuth consent screen

If you haven't yet:

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose the **User type** — **Internal** or **External**. This is
   the decision that determines whether the people you hand these
   credentials to hit a warning screen. Read **Internal vs
   External** below before picking.
3. Fill in app name, support email, and developer contact.
4. Add the scope
   `https://www.googleapis.com/auth/devstorage.read_write` — enough
   to list buckets and to read, write, and delete objects.
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
you authorise with still needs IAM roles on the project or bucket.
Which ones depends on whether Ternlux should *browse* the project's
buckets or work with one bucket you name.

**Object roles cover the data, not the bucket list.**
`storage.buckets.list` is a project-level permission and is **not**
part of Storage Object Admin. Without it, Test Connection and the
bucket picker fail with:

> …does not have storage.buckets.list access to the Google Cloud
> project.

**Option A — one bucket (least privilege).** Grant only object
access, then put the bucket's name in the connection's **Bucket**
field. Test Connection then checks that bucket instead of listing the
project, and the storage browser opens straight into it.

- **Storage Object Admin** — read + write on objects.
- **Storage Object Viewer** — read-only on objects.

Attach either at the project level, or per bucket through
**Cloud Storage → Buckets → \[your bucket\] → Permissions → Grant
Access**.

**Option B — browse every bucket.** Leave the Bucket field blank and
grant a role that includes `storage.buckets.list` on the *project*:

- **Storage Admin** — full control (read + write + bucket admin).
- **Storage Viewer** or **Storage Bucket Viewer** — enough to list
  buckets; pair with an object role for read/write.

### Step 6 — Enter the credentials in Ternlux

- **Project ID** — your GCP project id.
- **OAuth Client ID** / **OAuth Client Secret** — from step 4.
- **Redirect URI** — leave it at the default. Ternlux listens on
  **port 3000**, so the port here must stay `3000`; the path is
  ignored by the local callback server.
- **Bucket** *(optional)* — name one bucket to skip project-wide
  bucket listing entirely. Required if the account only has
  object-level roles (see Option A above).

### Step 7 — Authorise

Click **Authorize** in the form, sign in with the Google account that
holds the storage roles, and consent. Ternlux saves the resulting
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
`https://www.googleapis.com/auth/devstorage.read_write` is in
Google's **sensitive** scope tier — a published External app
requesting it is reviewed before the warning is dropped.

Verification is per Cloud project. If each of your users brings their
own client id and secret, each of them is the developer of their own
unverified app and will see this screen on their own machine;
verifying your project does not cover theirs.

## Behaviour notes

- Listings use a forward-slash delimiter, so subfolders inside a
  bucket appear as their own entries.
- Bucket metadata includes location and storage class.
- Permission errors are about the *signed-in user's* IAM roles, not
  about the OAuth client — re-authorising will not fix them.
- Connections saved before the move to OAuth, which stored a service
  account JSON or key file path, keep working; the form no longer
  offers those fields, so re-saving such a connection switches it to
  OAuth.
