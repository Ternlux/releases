# Dropbox connector

Cloud file storage. OAuth-based; tokens auto-refresh within a
five-minute buffer of expiry.

## What it lets you do

- List the folders you have access to.
- List files in a folder.
- Download a file.
- Upload a file.
- Delete a file.
- Inspect file metadata.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| App Key (Client ID) | Yes | Yes | — |
| App Secret (Client Secret) | Yes | Yes | — |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, refresh token, and expiry are filled in
automatically when you authorise.

## Setting up credentials

### Step 1 — Open the Dropbox App Console

Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
and click **Create app**.

### Step 2 — Configure the app

1. Pick **Scoped access**.
2. Pick the access type:
   - **App folder** — only the app's own folder. Safer for testing.
   - **Full Dropbox** — access to all of the user's files.
3. Name the app (e.g. `Ternlux`).
4. Click **Create app**.

### Step 3 — Set permissions

In the **Permissions** tab, enable the scopes you need:

- `files.metadata.read` — list files and folders.
- `files.content.read` — download files.
- `files.content.write` — upload files.

After changing permissions, click **Submit** at the bottom.

### Step 4 — Add the redirect URI

In the **Settings** tab, scroll to **OAuth 2 → Redirect URIs**,
add `http://localhost:3000/oauth/callback`, and click **Add**.

### Step 5 — Copy the credentials

Still in **Settings**, copy:

- **App key** — this is the client id.
- **App secret** — click **Show** to reveal it.

### Step 6 — Enter the credentials in Ternlux

Paste the **App Key** and **App Secret** into the form. Leave the
redirect URI as the default unless you changed it in step 4.

### Step 7 — Authorise

Click **Authorize** in the form, sign in to Dropbox, and consent.
Ternlux saves the tokens encrypted.

## Behaviour notes

- The connector detects whether your account is a regular personal
  account or a team-space account, and adjusts the path resolution
  automatically — team-space accounts have a different path root
  than personal accounts.
- Dropbox API errors are surfaced with the rich error context
  Dropbox provides (e.g. `path/not_found`, `insufficient_space`) so
  debugging is straightforward.
