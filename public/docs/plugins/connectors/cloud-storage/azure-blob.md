# Azure Blob Storage connector

Object storage on Microsoft Azure.

## What it lets you do

- List your containers.
- List blobs in a container.
- Download a blob as a file.
- Upload a file as a blob.
- Delete a blob.
- Inspect blob metadata.

## Connection form

You authenticate with EITHER a connection string OR an account name
plus account key (not both).

| Field | Required | Sensitive | When to use |
| --- | --- | --- | --- |
| Connection String | One of | Yes | Easiest — pasteable from the Azure portal |
| Account Name | One of | Yes | Used with Account Key auth |
| Account Key | One of | Yes | Used with Account Name auth |

Both methods are stored encrypted. Pick whichever your team standard
prefers — the connector behaves identically.

## Setting up credentials

### Option A — Connection string (easiest)

1. Open the [Azure portal](https://portal.azure.com) and navigate to
   your **Storage Account**.
2. In the left nav, open **Security + networking → Access keys**.
3. Click **Show keys**.
4. Copy either of the **Connection string** values.
5. In Ternlux, paste it into the **Connection String** field. Leave
   account name and key empty.

### Option B — Account name and key

1. Same starting point — **Storage Account → Access keys**.
2. Note the **Storage account name** at the top.
3. Copy one of the **Key** values.
4. In Ternlux, fill **Account Name** and **Account Key**. Leave
   connection string empty.

### Option C — Use a least-privilege approach (recommended for
production)

The two options above grant full control over the storage account.
For least-privilege access, use Azure AD role assignments or a
shared access signature (SAS):

1. In the storage account, open **Access Control (IAM)**.
2. Click **Add → Add role assignment**.
3. Assign one of:
   - **Storage Blob Data Contributor** — read + write objects.
   - **Storage Blob Data Reader** — read-only.
4. Assign the role to a service principal you've created (or to a
   user account you can sign in with).
5. Use the service principal's connection string format
   (`DefaultEndpointsProtocol=https;AccountName=…;AuthType=AAD;…`)
   in Ternlux.

Alternatively, you can constrain access using a SAS token attached
to a connection string — the Azure portal can generate this under
**Shared access signature** with read / write / list permissions
limited to the containers you choose and an expiry time of your
choosing.

## Behaviour notes

- Listings use a forward-slash delimiter, so virtual folders inside
  a container appear as their own entries.
- The connector chooses between connection string and account
  name/key automatically based on which fields you filled in.
