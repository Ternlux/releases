# SharePoint connector

Document libraries on Microsoft SharePoint, accessed via Microsoft
Graph. OAuth-based; tokens auto-refresh within a five-minute buffer
of expiry.

## What it lets you do

- List the document libraries (drives) on a SharePoint site.
- List files in a library.
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
| Site ID | No | No | (empty — root site) |
| Redirect URI | No | No | `http://localhost:3000/oauth/callback` |

If you don't specify a site id, Ternlux uses the root site of the
tenant. For non-root sites, supply the site id (Microsoft Graph
provides helpers to look it up from a site URL).

## Setting up credentials

You register an Azure AD application in the Azure portal so Ternlux
can authorise on your behalf.

### Step 1 — Register the app in Azure

Follow steps 1–5 of the [OneDrive setup](onedrive.md#setting-up-credentials)
to register an app, copy its client ID and tenant ID, and create a
client secret.

### Step 2 — Add SharePoint API permissions

In the app's **API permissions** page, click
**+ Add a permission → Microsoft Graph → Delegated permissions**
and add:

- `Sites.ReadWrite.All` — read + write any SharePoint site.
- `Files.ReadWrite.All` — read + write files in those sites.
- `offline_access` — required for refresh tokens.

For read-only, replace `Sites.ReadWrite.All` with `Sites.Read.All`
and `Files.ReadWrite.All` with `Files.Read.All`.

If your organisation requires admin consent, click **Grant admin
consent for [tenant]**.

### Step 3 — Find the site ID (optional)

If you want to scope the connection to a specific site rather than
the root site:

1. Go to the SharePoint site in your browser. Note the URL — it
   looks like `https://contoso.sharepoint.com/sites/Marketing`.
2. Build the site id reference: `contoso.sharepoint.com,<webId>,<siteId>`.
   You can look up the GUIDs by visiting
   `https://contoso.sharepoint.com/sites/Marketing/_api/site/id` and
   `https://contoso.sharepoint.com/sites/Marketing/_api/web/id` in
   your browser while signed in.
3. Or call Microsoft Graph at `/sites/contoso.sharepoint.com:/sites/Marketing`
   and copy the `id` from the response.

### Step 4 — Enter the credentials in Ternlux

- **Application (client) ID** — from app registration.
- **Client Secret** — from Certificates & secrets.
- **Tenant ID** — your directory id, or `common` for multi-tenant
  apps.
- **Site ID** — from step 3, or leave empty for the root site.
- **Redirect URI** — leave as default.

### Step 5 — Authorise

Click **Authorize**, sign in with a Microsoft account that has
access to the SharePoint site, and consent. Ternlux saves the
tokens encrypted.

## Behaviour notes

- A SharePoint site has multiple drives (each library is a drive).
  Ternlux exposes them as separate containers in the picker.
- Authorised scopes cover sites and files read/write, plus offline
  access (so the refresh token works).
- Files are addressed by path inside the chosen drive.
