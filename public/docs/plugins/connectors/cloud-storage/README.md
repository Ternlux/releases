# Cloud storage connectors

Cloud storage connectors give Ternlux access to bucket-style storage
systems: object stores like S3, file-sharing services like Drive and
OneDrive, and document libraries like SharePoint.

They share a common surface:

- **Containers** — buckets (S3, GCS, Azure), top-level folders
  (Drive, OneDrive), document libraries (SharePoint), or "all files"
  (Dropbox).
- **Objects** — files inside a container. Listed with pagination
  and optional prefix filtering.
- **Download** — fetch an object's contents.
- **Upload** — write an object's contents.
- **Delete** — remove an object.
- **Get metadata** — size, modified time, content type.

> **Note:** Cloud storage cannot be configured through the chat
> assistant. Picking a container and an object needs the editor's native
> picker, so you add and configure these nodes in the workflow editor.
> Once such a node exists and has run, chat can build everything
> downstream of it.

## How they're used by nodes

- **Data Source nodes.** Point at a single object, and choose where the
  downloaded copy is kept on disk. At execution time the object is
  downloaded and written over that path, then read in place by DuckDB —
  nothing is imported into another store and nothing is converted. A node
  recorded before files were kept on disk has no path to refresh and says
  so.
- **Output nodes.** Point at a container plus an object path. The rows
  are serialised to JSON or CSV (chosen by the file extension you give)
  and uploaded as one object, which replaces whatever was there. There is
  no append to an object, so the write-mode setting does not apply.
- **Vector files.** Cloud storage cannot bring a LanceDB dataset in.

## Available connectors

| Connector | Auth | Notes |
| --- | --- | --- |
| [Amazon S3](s3.md) | AWS access key + secret | S3-compatible endpoints (MinIO, etc.) supported |
| [Google Cloud Storage](gcs.md) | OAuth | Project id required; optional single-bucket scoping |
| [Azure Blob Storage](azure-blob.md) | Connection string or account key | Two auth methods supported |
| [Google Drive](google-drive.md) | OAuth | File IDs, format export |
| [OneDrive](onedrive.md) | OAuth | Microsoft Graph, multi-tenant aware |
| [SharePoint](sharepoint.md) | OAuth | Microsoft Graph, site / drive model. Ships, but is not currently offered in the connection picker |
| [Dropbox](dropbox.md) | OAuth | Team-space detection |

## OAuth auto-refresh

For OAuth-based connectors (Drive, OneDrive, SharePoint, Dropbox),
Ternlux refreshes the access token automatically within a five-minute
buffer of expiry, so a workflow run never lands on a stale token.

Google Cloud Storage authorises the same way but refreshes on demand:
the Google client swaps an expired access token for a fresh one on the
next request using the stored refresh token.
