# Google Drive connector

Cloud file storage. Authenticated by OAuth — Ternlux opens your
browser to authorise, captures the redirect on a local port,
exchanges the code for tokens, and stores them encrypted. Tokens
auto-refresh within a five-minute buffer of expiry.

## What it lets you do

- List the folders you have access to.
- List files in a folder.
- Download a file.
- Upload a file.
- Delete a file.
- Inspect file metadata.
- Export Google-native files (Docs, Sheets, Slides) into other
  formats — PDF, Word, Excel, plain text, etc. — at download time.
- Use the native Google file picker for selecting files in
  DataSource nodes (Ternlux fetches the picker credentials
  automatically).

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| OAuth Client ID | Yes | Yes | — |
| OAuth Client Secret | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, refresh token, and expiry are filled in
automatically when you authorise.

## Setting up credentials

### Step 1 — Open Google Cloud Console

Go to the [Google Cloud Console](https://console.cloud.google.com)
and either pick an existing project or create a new one.

### Step 2 — Enable the Google Drive API

Go to **APIs & Services → Enabled APIs & services**, click
**+ Enable APIs and services**, search for **Google Drive API**,
and enable it.

### Step 3 — Configure the OAuth consent screen

If you haven't yet:

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose the **User type** — **Internal** or **External**. This is
   the decision that determines whether the people you hand these
   credentials to hit a warning screen. Read **Internal vs
   External** below before picking; it matters more for Drive than
   for the other Google connectors.
3. Fill in app name, support email, and developer contact.
4. Add the scopes:
   - `https://www.googleapis.com/auth/drive.file` — the safest
     default; restricts access to files Ternlux opens or creates.
   - Add `https://www.googleapis.com/auth/drive.readonly` if you
     need to read files Ternlux didn't create.
   - Add `https://www.googleapis.com/auth/drive.metadata.readonly`
     for metadata-only listing.
5. If you picked External and are leaving the app in **Testing**,
   add everyone who will authorise under **Test users**.

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `Ternlux`.
5. Under **Authorized redirect URIs**, add
   `http://localhost:3000/oauth/callback`.
6. Click **Create** and copy the **Client ID** and **Client
   Secret**.

### Step 5 — Enter the credentials in Ternlux

Paste the client id and secret. Leave the redirect URI as the
default unless you changed it in step 4.

### Step 6 — Authorise

Click **Authorize** in the form, sign in with the Google account
that owns the files, and consent. Ternlux saves the resulting tokens
encrypted.

## Internal vs External

The **User type** you picked on the consent screen decides what the
people using these credentials see when they click **Authorize**.

### Internal — no warning

Available only when the Cloud project belongs to a Google Workspace
organisation, and only for users inside that same organisation.
Nothing to verify, no warning screen, no test-user list to maintain,
and refresh tokens don't expire on a timer.

**If everyone using this connection is in your Workspace org, pick
Internal.** For Drive it is by far the simplest route — see the
restricted-scope note below for why.

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
  auto-refresh described at the top — the refresh token itself is
  dead, so there is nothing left for Ternlux to refresh with.
- **Publish the app and submit for OAuth verification.** The warning
  disappears for everyone and the 7-day expiry goes away. Read the
  next section first — for Drive this is a bigger commitment than it
  is for the other Google connectors.

### Drive's restricted scopes

`drive.file` is not a sensitive scope: it only ever reaches files the
user explicitly picks or that Ternlux created, so an app requesting
only that has the lightest review path.

`drive.readonly` and `drive.metadata.readonly` are different. They
are in Google's **restricted** tier — the strictest one — because
they expose the user's entire Drive. Publishing an External app that
requests either requires OAuth verification **plus an annual
third-party security assessment (CASA)**, which is a paid, recurring
engagement. Ternlux asks for them because they are what lets the
in-app browser list a whole Drive.

So if you need whole-Drive browsing for users outside your
organisation, budget for that assessment. The ways around it:

- Use **Internal** (Workspace only) — restricted scopes are fine,
  no assessment.
- Stay in **Testing** and accept the weekly re-authorisation.
- Drop to `drive.file` only, and select files through the Google
  Picker instead of browsing. The Sheets connector takes exactly this
  route to stay out of the restricted tier.

Verification is per Cloud project. If each of your users brings their
own client id and secret, each of them is the developer of their own
unverified app and will see this screen on their own machine;
verifying your project does not cover theirs.

## Behaviour notes

- Files are identified by Google's file IDs, not by their human file
  names. The interactive UI handles the translation for you.
- Authorised scopes cover read/write of files Ternlux created, plus
  read access to files you've explicitly granted.
- Multiple Google scopes (drive.file, drive.readonly,
  drive.metadata.readonly) are supported for different permission
  models.
