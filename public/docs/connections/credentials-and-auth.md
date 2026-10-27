# Credentials and authentication

Ternlux treats every credential as a first-class secret. They are
encrypted at rest using the operating system's secure storage (Keychain
on macOS, Credential Store on Windows, the desktop keyring on Linux) and
decrypted only at the moment a connection or AI call is made.

## What's encrypted

Two kinds of secrets are kept separately, in two files in your user data
directory, each written owner-readable only:

- **AI provider keys** — your OpenAI, Anthropic, Google Gemini, and
  OpenAI-compatible provider keys, stored as a single encrypted bag. You
  can set, replace, or remove keys at any time from the settings screen.
- **Per-connection credentials** — for every saved connection, the fields
  the connector marks *sensitive* (passwords, API keys, OAuth tokens, the
  values of a key/value list) live in a separate encrypted store keyed by
  connection id. Everything else — a bucket, a region, an endpoint, a
  site id, a redirect URI — stays in the connection's public record,
  because it is not a secret and the connector needs it either way.

## When the OS has no keyring

A Linux session with no desktop keyring — a server, a minimal window
manager, anything Chromium cannot identify the desktop of — has nowhere
to put a real key. Rather than failing every save, Ternlux falls back to
an in-memory key. The files are still encrypted, but with a key that is
not yours, so anyone who can read the file can recover what is in it.

That difference is stated, not hidden: the app reports which backend is
live, and a warning appears wherever a secret is about to be typed in.
On macOS, Windows, and any ordinary Linux desktop nothing changes and the
warning never appears.

## How a query gets its credentials

When you run a query, run a workflow, or open a preview:

1. The interactive layer asks the background engine to do the work.
2. The engine lays the connection's stored public configuration down as
   the base, fills in a file connection's path and tables, then merges
   the decrypted secret part on top.
3. The merged configuration is handed to the connector for that one call.
4. Nothing about the secret crosses back into the interactive layer.

## OAuth-based connections

Some integrations (Google Drive, Google Sheets, Google Cloud Storage,
OneDrive, SharePoint, Dropbox) use OAuth instead of static credentials.
For those, the connection form shows an **Authorize** button. When you
click it:

1. Ternlux opens your default browser at the provider's authorisation
   page. A one-time random state value guards against cross-site forgery.
2. While you're authorising, Ternlux runs a small local listener for the
   provider to redirect back to.
3. After you approve, the provider redirects to that listener with a
   one-time code, which Ternlux exchanges for access and refresh tokens.
4. The tokens are saved into the encrypted credential store for the
   connection.
5. Closing the dialog before authorising shuts the listener down and
   frees the port.

The authorisation window is five minutes. After that the listener times
out and you start over.
