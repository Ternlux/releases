# REST API Connector

A generic HTTP connector for Ternlux. One connection carries the base URL and
auth credentials; the request itself (method, endpoint path, headers, body,
response shape) is authored per-usage on the DataSource node via natural
language.

## Why split auth from usage?

A single API host usually exposes many endpoints. Storing one connection per
endpoint would ask the user to re-enter tokens for every endpoint. Instead:

- **Connection** = base URL + auth (one-time setup, secrets go to the OS
  keychain).
- **DataSource node** = the actual request. An AI-assisted chat helps the user
  describe what to pull and produces a fetch plan that's persisted on the node.

The DataSource materialises each run into a local DuckDB table, so Preview,
Joins, Transformers, and Branches see it as an ordinary NoSQL source.

## Config fields

| Field | Sensitive | Notes |
|---|---|---|
| `baseUrl` | no | Optional. Example: `https://api.example.com/v1`. |
| `authType` | no | `none` / `bearer` / `apiKey` / `basic`. |
| `bearerToken` | **yes** | Used when `authType=bearer`. |
| `apiKeyName` | no | Custom header name, e.g. `X-API-Key`. |
| `apiKeyValue` | **yes** | Used when `authType=apiKey`. |
| `basicUser` | no | Used when `authType=basic`. |
| `basicPassword` | **yes** | Used when `authType=basic`. |

Sensitive values are encrypted via Electron `safeStorage` and only decrypted in
the main process when a fetch runs — they never cross the IPC boundary to the
renderer after save.

## Placeholders used by the fetch plan

The DataSource chat generates a fetch plan whose string values reference these
placeholders. The main process substitutes them at execution time.

- `{{BASE_URL}}`
- `{{AUTH_HEADER_NAME}}` — `Authorization` for bearer/basic; the custom header
  for apiKey.
- `{{AUTH_HEADER_VALUE}}` — `Bearer <token>`, `Basic <b64>`, or the raw api
  key. Empty for `authType=none`.
- `{{BEARER_TOKEN}}`, `{{API_KEY_VALUE}}`, `{{BASIC_USERNAME}}`,
  `{{BASIC_PASSWORD}}` — escape hatches for query-string or body placement.

## Not in V1

Pagination, retries / backoff, OAuth2, streaming or XML responses, incremental
refresh, and re-execution of arbitrary axios code are deferred.
