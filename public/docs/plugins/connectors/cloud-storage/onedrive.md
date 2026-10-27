# OneDrive connector

Microsoft personal and business cloud storage, accessed via
Microsoft Graph. OAuth-based; tokens auto-refresh within a
five-minute buffer of expiry.

## What it lets you do

- List your folders.
- List files in a folder.
- Download a file.
- Upload a file.
- Delete a file.
- Inspect file metadata.

## Connection form

| Field | Required | Sensitive | Default |
| --- | --- | --- | --- |
| Application (client) ID | Yes | Yes | — |
| Client Secret | Yes | Yes | — |
| Tenant ID | No | No | `common` |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

The access token, refresh token, and expiry are filled in
automatically when you authorise.

## Setting up credentials

You register an Azure AD application in the Azure portal so Ternlux
can authorise on your behalf.

### Step 1 — Open the Azure portal

Go to [portal.azure.com](https://portal.azure.com) and sign in.

### Step 2 — Open Azure Active Directory

In the left nav (or search), open **Microsoft Entra ID** (formerly
Azure Active Directory).

### Step 3 — Register an application

1. Go to **App registrations → + New registration**.
2. Name: `Ternlux`.
3. Supported account types: pick **Accounts in any organizational
   directory and personal Microsoft accounts** for personal
   OneDrive support, or restrict to your tenant for work-only.
4. Redirect URI: pick **Web** and enter
   `http://localhost:3000/oauth/callback`.
5. Click **Register**.

### Step 4 — Copy the client ID and tenant ID

On the app overview page, copy:

- **Application (client) ID**
- **Directory (tenant) ID** — only needed if you scoped the app to
  one tenant; for multi-tenant or personal accounts use the default
  `common`.

### Step 5 — Create a client secret

1. In the left nav of the app, open **Certificates & secrets**.
2. Click **+ New client secret**.
3. Set a description and an expiry.
4. Click **Add**.
5. Copy the **Value** of the secret immediately — it's shown only
   once.

### Step 6 — Add API permissions

1. Open **API permissions → + Add a permission**.
2. Pick **Microsoft Graph → Delegated permissions**.
3. Add:
   - `Files.ReadWrite.All` — read + write all OneDrive files.
   - `offline_access` — required for refresh tokens.
4. Click **Add permissions**.

For read-only, use `Files.Read.All` instead of `Files.ReadWrite.All`.

If your organisation requires admin consent, click **Grant admin
consent for [tenant]**.

### Step 7 — Enter the credentials in Ternlux

- **Application (client) ID** — from step 4.
- **Client Secret** — from step 5.
- **Tenant ID** — leave as `common` for personal Microsoft
  accounts; set to your directory ID for tenant-scoped apps.
- **Redirect URI** — leave as default unless you changed it.

### Step 8 — Authorise

Click **Authorize** in the form, sign in with the Microsoft account
that owns the OneDrive, and consent. Ternlux saves the tokens
encrypted.

## Behaviour notes

- Authorised scopes cover read/write of all files plus offline
  access (so the refresh token works).
- Files are addressed by path under the user's drive root.
- Uses delegated permissions — the connector acts as the user who
  authorised, not as a stand-alone application.
