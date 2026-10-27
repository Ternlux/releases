const { app, BrowserWindow, shell, ipcMain, safeStorage, Notification, dialog, Menu } = require('electron');
// First, before any module can log a config object carrying a key.
require('./lib/logRedaction').installConsoleRedaction();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Datastore = require('@seald-io/nedb');
const pluginManager = require('./pluginManager');
const aiProviders = require('./aiProviders');
const analytics = require('./analytics');
const {
  externalizeWorkflowCode,
  externalizeUpdateCode,
  extractWorkflowId,
  inlineWorkflowCode,
  deleteWorkflowCode,
  workflowDirName,
} = require('./lib/workflowCode');
const {
  watchWorkflowCode,
  unwatchWorkflowCode,
  unwatchAllForWebContents,
  stopAllCodeWatchers,
  suppressWorkflowCodeEvents,
} = require('./lib/workflowCodeWatcher');

// Ternlux API. Packaged builds never have BACKEND_URL set, so the fallback is
// what ships; override it to run against a local backend:
//   BACKEND_URL=http://localhost:8000 npm run electron-dev
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.ternlux.com';

// Linux keeps secrets in the desktop's keyring (libsecret, kwallet). A server,
// a minimal window manager, or any session Chromium can't identify the desktop
// of has none, and safeStorage.isEncryptionAvailable() is then false — which
// made saving an API key or a DB credential fail outright with "safeStorage is
// not available on this system", with no way forward.
//
// This falls back to an in-memory key in exactly that case. Where a real
// keyring IS found — GNOME, KDE — Electron keeps using it and this call changes
// nothing. It has to run before the `ready` event: that is when the backend is
// chosen, and afterwards getSelectedStorageBackend() has already settled. No-op
// on Windows and macOS.
//
// The trade-off is real. Under the fallback the key is not the user's, so
// llm-config.dat and db-credentials.dat are readable by anything that can open
// them — hence writeSecretFile() keeping them 0600, and 'secret-storage:status'
// telling the renderer which backend is live so the UI can say so out loud
// rather than quietly pretending the keys are protected.
if (process.platform === 'linux') {
  safeStorage.setUsePlainTextEncryption(true);
}

// Patch ipcMain.handle FIRST so every IPC handler registered below is
// automatically wrapped with anonymous analytics tracking (channel name,
// duration, success). Opt-in is OFF until the renderer pushes the user's
// choice via `analytics:set-opt-in`.
analytics.patchIpcMain(ipcMain);

// Vector libs live at host level (public/lib) so they're available even when
// the vector-db-executor plugin isn't installed. They're imported once here
// and shared with every skill via the helpers bundle, so no skill ever has
// to require across plugin directories.
const vectorEmbeddings = require('./lib/embeddings');
const vectorLanceDB    = require('./lib/lancedb');
const localSQLite      = require('./lib/sqlite');
const localDuckDB      = require('./lib/duckdb');
const { executeOutput } = require('./NodeExecution/outputExecutionHelpers');
const { addExecutionLog, executeNode } = require('./NodeExecution/workflowExecutionHelpers');
const { createExecutionSink, runWithExecutionLog } = require('./NodeExecution/executionLog');
const {
  runWithCancellation, isCancelledError, ExecutionCancelledError,
  throwIfCancelled, isCancellationRequested,
} = require('./NodeExecution/executionCancel');
const nodeExecution = require('./NodeExecution/NodeExecution');
const apiFetch = require('./NodeExecution/ApiFetch');
const { runOutputValidation } = require('./NodeExecution/outputValidation');
const { registerCronJob, unregisterCronJob, getActiveCronJobs, stopAllCronJobs } = require('./triggers/cronTriggers');
const { registerFileWatcher, unregisterFileWatcher, getActiveFileWatchers, stopAllFileWatchers } = require('./triggers/fileWatchTriggers');
const { registerAllWorkflowTriggers } = require('./triggers/registerAllTriggers');
const { registerLocalFile, listFileTables } = require('./imports/registerFile');

const chatAssistant = require('./chat/chatAssistant');
const workflowBuilder = require('./chat/workflowBuilder');

// Data Explorer IPC. Every `explorer:*` channel lives in public/database/,
// which owns schema browsing, statement validation, execution and the
// persistent query notepad. Registered below, once userData is resolvable.
const { registerDatabaseIpc } = require('./database');

// Chat prompt builders. These live in public/ChatPrompts/ and were previously
// imported directly into the renderer. They're loaded here and exposed via
// the chatPrompts:build IPC channel so NodeChat components don't reach into
// the public/ tree themselves.
// sanitizePromptModule wraps each builder so embedding vectors are stripped
// from its arguments before a prompt is assembled — a vector source's sample
// rows are otherwise serialised in full, and one 1536-dim embedding is ~8k
// tokens of digits the model has no use for. See public/lib/promptSanitize.js.
const { stripVectors, sanitizePromptModule } = require('./lib/promptSanitize');
const CHAT_PROMPT_MODULES = {
  join: sanitizePromptModule(require('./ChatPrompts/Join').join),
  transfomer: sanitizePromptModule(require('./ChatPrompts/Transfomer').transfomer),
  restApi: sanitizePromptModule(require('./ChatPrompts/RestApi')),
};

ipcMain.handle('chatPrompts:build', async (_event, key, args = []) => {
  const [moduleName, method] = String(key || '').split('.');
  const fn = CHAT_PROMPT_MODULES[moduleName]?.[method];
  if (typeof fn !== 'function') {
    return { success: false, message: `Unknown chat prompt: ${key}` };
  }
  try {
    return { success: true, prompt: fn(...(Array.isArray(args) ? args : [args])) };
  } catch (err) {
    return { success: false, message: err?.message || String(err) };
  }
});

// Ensure the same userData directory is used in both dev and production,
// so a key saved during development persists when the packaged app is launched.
app.setName('Ternlux');

// Where file imports made before the DuckDB switch put their tables. NOTHING
// WRITES HERE ANY MORE — local results are DuckDB, and the transform, join and
// import paths that used this database have all been retired. The path is kept
// so a connection recorded against it can still be READ: the readers open the
// file by path (lib/sqlite, or DuckDB's sqlite attach), which is why there is no
// longer a pool holding it open.
let appSqliteDbPath = null;

/** Resolve the legacy app database path. Opens nothing. */
async function initializeAppDatabase() {
  appSqliteDbPath = path.join(app.getPath('userData'), 'app-data.db');
  return appSqliteDbPath;
}

// Path to the encrypted config file stored in the app's user-data directory.
// Written only after the app is ready so app.getPath() is safe to call.
function getConfigPath() {
  return path.join(app.getPath('userData'), 'llm-config.dat');
}

/**
 * Which store safeStorage settled on, on Linux: 'gnome_libsecret', a 'kwallet'
 * variant, or 'basic_text' — the in-memory-key fallback enabled at the top of
 * this file. 'unknown' if asked before the app is ready, since the backend is
 * not chosen until then. Null off Linux, where the OS store is never in doubt.
 */
function secretStorageBackend() {
  if (process.platform !== 'linux') return null;
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch (err) {
    console.error('[secretStorageBackend]', err);
    return 'unknown';
  }
}

/** Secrets are encrypted, but with a key that is not the user's keyring's. */
const isSecretStorageWeak = () => secretStorageBackend() === 'basic_text';

/**
 * Write a file holding secrets, readable only by its owner.
 *
 * This matters most under the basic_text fallback: the encryption key is no
 * longer private to the user, so file permissions are the only thing left
 * between the ciphertext and anyone else with an account on the machine.
 * writeFileSync's mode is ignored when the file already exists — the usual
 * case, since these are rewritten on every save — so chmod has to follow it.
 */
function writeSecretFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn('[writeSecretFile] could not tighten permissions:', err.message);
  }
}

/**
 * Load all API keys from encrypted storage
 * @returns {Object|null} - Object with provider keys { claude, gemini, chatgpt, openai } or null
 */
function loadApiKeys() {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;

    const b64 = fs.readFileSync(configPath, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const payload = safeStorage.decryptString(buf);
    return JSON.parse(payload);
  } catch (err) {
    console.error('[loadApiKeys]', err);
    return null;
  }
}

// AI preferences (non-secret) — currently just the user's default provider.
// Kept in a plain JSON file so the main process can honor the renderer's
// "Default AI Provider" choice for backend-internal calls (chat, titles,
// workflow builds) that never pass an explicit provider.
function getAiPrefsPath() {
  return path.join(app.getPath('userData'), 'ai-prefs.json');
}

function loadAiPrefs() {
  try {
    const p = getAiPrefsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (err) {
    console.error('[loadAiPrefs]', err);
    return {};
  }
}

// Native providers (openai/claude/gemini) store only the API key in
// llm-config.dat, so the chosen model lives in ai-prefs.json as `defaultModel` —
// backend-internal calls read it to avoid falling back to a hardcoded
// DEFAULT_MODELS entry (which may be a retired model).

// Fill provider + model from the persisted defaults when the caller didn't
// specify them, so backend-internal AI calls (assistant, workflow builder,
// titles, transforms) honor the user's saved choice instead of falling back
// to provider priority order / a hardcoded default model. The persisted model
// is only applied to NATIVE providers (openai/claude/gemini) and only when it
// belongs to the default provider — compat ("Others") providers carry their
// own model in the encrypted key entry, resolved downstream.
function withPersistedAiDefaults(options = {}) {
  const prefs = loadAiPrefs();
  const provider = options.provider || prefs.defaultProvider || undefined;
  let { model } = options;
  if (!model && prefs.defaultModel) {
    const p = String(provider || '').toLowerCase();
    const isNative = ['openai', 'chatgpt', 'claude', 'gemini'].includes(p);
    // The model is only usable with the provider it was chosen for.
    // `defaultModelProvider` records that explicitly; prefs written before it
    // existed fall back to comparing against the default provider.
    const owner = prefs.defaultModelProvider || prefs.defaultProvider || null;
    const isDefaultProvider = !owner || p === String(owner).toLowerCase();
    if (isNative && isDefaultProvider) model = prefs.defaultModel;
  }
  // The user's Max Tokens is the primary value for every AI call. A caller that
  // passes its own (a 30-token title, say) still wins; when nobody specifies,
  // aiProviders applies its own static fallback — or omits the field entirely
  // for providers that don't require it.
  const maxTokens = options.maxTokens || prefs.defaultMaxTokens || undefined;
  return {
    ...options,
    provider,
    ...(model ? { model } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

// Encrypt and persist the full provider-key map to llm-config.dat.
function writeApiKeys(allKeys) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available on this system');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(allKeys));
  writeSecretFile(getConfigPath(), encrypted.toString('base64'));
}

/**
 * Check if an API key exists for a specific provider
 * @param {string} provider - Provider name (openai, claude, gemini, chatgpt)
 * @returns {boolean}
 */
function hasApiKeyForProvider(provider) {
  const allKeys = loadApiKeys();
  if (!allKeys) return false;

  // Normalize provider name
  const providerMap = {
    'chatgpt': 'chatgpt',
    'gemini': 'gemini',
    'claude': 'claude',
    'openai': 'chatgpt', // OpenAI uses chatgpt key
  };

  const normalizedProvider = providerMap[provider.toLowerCase()] || provider.toLowerCase();
  return !!(allKeys[normalizedProvider]);
}

// ---------------------------------------------------------------------------
// IPC handlers — registered before createWindow so they are ready immediately
// ---------------------------------------------------------------------------

/**
 * Encrypts and saves an API key for a specific provider.
 * Supports multiple providers - stores as: { claude: "key1", gemini: "key2", chatgpt: "key3" }
 */
ipcMain.handle('api-key:save', (_event, { provider, key }) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'safeStorage is not available on this system' };
    }

    const configPath = getConfigPath();
    // Load existing keys (if any)
    let allKeys = {};
    if (fs.existsSync(configPath)) {
      try {
        const b64 = fs.readFileSync(configPath, 'utf8');
        const buf = Buffer.from(b64, 'base64');
        const payload = safeStorage.decryptString(buf);
        allKeys = JSON.parse(payload);
      } catch (err) {
        console.warn('[api-key:save] Could not load existing keys, starting fresh:', err);
      }
    }

    // Add or update the key for this provider
    allKeys[provider] = key;

    // Encrypt and save all keys
    const payload = JSON.stringify(allKeys);
    const encrypted = safeStorage.encryptString(payload);
    writeSecretFile(configPath, encrypted.toString('base64'));

    return { success: true };
  } catch (err) {
    console.error('[api-key:save]', err);
    return { success: false, error: err.message };
  }
});

/**
 * Reads llm-config.dat, decrypts it, and returns all provider keys as an object
 * Returns: { claude: "key1", gemini: "key2", chatgpt: "key3" } or null
 */
ipcMain.handle('api-key:load', () => {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;

    if (!safeStorage.isEncryptionAvailable()) return null;

    const b64 = fs.readFileSync(configPath, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const payload = safeStorage.decryptString(buf);
    return JSON.parse(payload);
  } catch (err) {
    console.error('[api-key:load]', err);
    return null;
  }
});

/**
 * How well this system can protect stored secrets.
 *
 * For a UI that should tell the user rather than let them assume. `weak` is the
 * one that matters: on a Linux box with no keyring the keys are still saved,
 * but recoverable by anything that can read the file, and a user trusting it
 * with a production API key deserves to know that before they paste one in.
 */
ipcMain.handle('secret-storage:status', () => ({
  platform: process.platform,
  available: safeStorage.isEncryptionAvailable(),
  backend: secretStorageBackend(),
  weak: isSecretStorageWeak(),
}));

/**
 * Deletes llm-config.dat so the setup screen is shown again on next launch.
 */
ipcMain.handle('api-key:clear', () => {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    return { success: true };
  } catch (err) {
    console.error('[api-key:clear]', err);
    return { success: false, error: err.message };
  }
});

// Terms & Conditions acceptance is persisted to a file in userData so it
// survives across launches reliably — renderer localStorage was unreliable
// here because the productName/package name mismatch can shift the storage
// origin between dev and packaged runs.
function getTermsConfigPath() {
  return path.join(app.getPath('userData'), 'terms-acceptance.json');
}

ipcMain.handle('terms:get', () => {
  try {
    const p = getTermsConfigPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('[terms:get]', err);
    return null;
  }
});

ipcMain.handle('terms:save', (_event, record = {}) => {
  try {
    const p = getTermsConfigPath();
    fs.writeFileSync(p, JSON.stringify(record), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[terms:save]', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Renderer store — localStorage that actually survives a restart
//
// A packaged window is loaded with loadFile(), so the renderer's origin is
// file://, and Chromium treats that as opaque for storage: whatever the UI
// writes to localStorage lives exactly as long as the window does. In dev the
// renderer is served from http://localhost:3000 — a real origin — which is why
// this only ever shows up once packaged, and why terms acceptance was moved to
// a file above. Anything else the UI remembered (the signed-in session, the
// chosen model) came back to defaults on every launch.
//
// Roughly twenty modules read localStorage synchronously, so rather than
// convert them all to async IPC, the renderer mirrors the whole store here
// after each change and reloads it at startup — see
// src/utils/persistentLocalStorage.js. Call sites keep using localStorage and
// stop losing it.
//
// The mirror holds the auth token, so it is written 0600 like the other secret
// files. It is NOT encrypted: localStorage was plaintext on disk too, so this
// changes nothing about how exposed the token is, and encrypting it would tie
// the user's session to a keyring that half these Linux boxes do not have.
// ---------------------------------------------------------------------------

function getRendererStorePath() {
  return path.join(app.getPath('userData'), 'renderer-store.json');
}

// A whole-store rewrite on every change is only cheap while the store is small.
// localStorage's own budget is ~5MB; past this something is being cached there
// that has no business surviving a restart, and silently writing it every few
// hundred ms would be worse than not persisting it.
const MAX_RENDERER_STORE_BYTES = 4 * 1024 * 1024;

ipcMain.handle('store:load', () => {
  try {
    const p = getRendererStorePath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('[store:load]', err);
    return {};
  }
});

ipcMain.handle('store:save', (_event, entries) => {
  try {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      return { success: false, error: 'entries must be an object' };
    }
    const payload = JSON.stringify(entries);
    if (payload.length > MAX_RENDERER_STORE_BYTES) {
      console.warn(
        `[store:save] ${payload.length} bytes exceeds the ${MAX_RENDERER_STORE_BYTES} byte cap — not persisted`
      );
      return { success: false, error: 'renderer store too large' };
    }
    writeSecretFile(getRendererStorePath(), payload);
    return { success: true };
  } catch (err) {
    console.error('[store:save]', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Secure database credential storage
// Stores sensitive database credentials (passwords, hosts, etc.) encrypted
// using OS-level safeStorage (Keychain on macOS, Credential Store on Windows)
// ---------------------------------------------------------------------------

function getCredentialsPath() {
  return path.join(app.getPath('userData'), 'db-credentials.dat');
}

/**
 * Load all stored credentials from disk
 * Returns an object mapping connectionId -> { password, host, username, ... }
 */
function loadAllCredentials() {
  try {
    const credsPath = getCredentialsPath();
    if (!fs.existsSync(credsPath)) return {};

    if (!safeStorage.isEncryptionAvailable()) return {};

    const b64 = fs.readFileSync(credsPath, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    const payload = safeStorage.decryptString(buf);
    return JSON.parse(payload);
  } catch (err) {
    console.error('[loadAllCredentials]', err);
    return {};
  }
}

/**
 * Save all credentials to disk (encrypted)
 */
function saveAllCredentials(credentials) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage is not available on this system');
    }

    const payload = JSON.stringify(credentials);
    const encrypted = safeStorage.encryptString(payload);
    writeSecretFile(getCredentialsPath(), encrypted.toString('base64'));
    return { success: true };
  } catch (err) {
    console.error('[saveAllCredentials]', err);
    return { success: false, error: err.message };
  }
}

/**
 * Save database credentials for a connection
 * IPC: 'db-credentials:save'
 */
ipcMain.handle('db-credentials:save', (_event, { connectionId, credentials }) => {
  try {
    // console.log('connectionId, credentials: ', connectionId, credentials)
    const allCreds = loadAllCredentials();
    allCreds[connectionId] = credentials;
    return saveAllCredentials(allCreds);
  } catch (err) {
    console.error('[db-credentials:save]', err);
    return { success: false, error: err.message };
  }
});

/**
 * Load database credentials for a connection
 * IPC: 'db-credentials:load'
 * Returns the credentials object or null
 */
ipcMain.handle('db-credentials:load', (_event, { connectionId }) => {
  try {
    const allCreds = loadAllCredentials();
    return allCreds[connectionId] || null;
  } catch (err) {
    console.error('[db-credentials:load]', err);
    return null;
  }
});

/**
 * Update database credentials for a connection
 * IPC: 'db-credentials:update'
 * Completely replaces credentials (does not merge with existing)
 * Also closes any cached connections so they reconnect with new credentials
 */
ipcMain.handle('db-credentials:update', async (_event, { connectionId, credentials, dbType }) => {
  try {
    const allCreds = loadAllCredentials();

    // Replace credentials completely (no merging)
    allCreds[connectionId] = credentials;

    const saveResult = saveAllCredentials(allCreds);

    // Close the cached connection so it reconnects with new credentials
    if (dbType && pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      if (typeof connector.closeConnection === 'function') {
        try {
          await connector.closeConnection(connectionId);
          console.log(`[db-credentials:update] Closed cached connection for ${connectionId}`);
        } catch (closeErr) {
          console.warn('[db-credentials:update] Error closing connection:', closeErr.message);
        }
      }
    }

    return saveResult;
  } catch (err) {
    console.error('[db-credentials:update]', err);
    return { success: false, error: err.message };
  }
});

/**
 * Delete database credentials for a connection
 * IPC: 'db-credentials:delete'
 */
ipcMain.handle('db-credentials:delete', (_event, { connectionId }) => {
  try {
    const allCreds = loadAllCredentials();
    delete allCreds[connectionId];
    return saveAllCredentials(allCreds);
  } catch (err) {
    console.error('[db-credentials:delete]', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// The app's own metadata store — workflows, connections, executions and chat
// sessions, kept in NeDB files under userData. This is internal bookkeeping and
// is unrelated to the stores a user's DATA lives in (those are DuckDB).
// Lazily initialized after app is ready so app.getPath('userData') is available.
// ---------------------------------------------------------------------------

const _dbs = {};
const VALID_COLLECTIONS = ['workflows', 'connections', 'executions', 'chatSessions', 'workflowHistory'];

// NeDB forbids object KEYS that contain a "." (it reserves the dot for
// dot-notation queries) and throws "Field names cannot contain a .". Workflow
// configs legitimately use dotted keys — a join's `joinColumns` is keyed by the
// qualified table it joins on, "[dbo].[transactions]" — so we transparently
// encode "." → "||" in keys on write and decode "||" → "." on read, for every
// collection (see getDb). Values are never touched, only object keys, so what a
// caller stores is what it reads back.
// NeDB also forbids keys that START with "$" ("Field names cannot begin with
// the $ character"), and configs carry them too: a Pinecone metadata filter is
// `{ tier: { $eq: 'premium' } }`. A leading "$" is stored as DOLLAR_TOKEN.
const DOT_TOKEN = '||';
const DOLLAR_TOKEN = '__dollar__';
const _dbWrappers = {};

function encodeDotKeys(value) {
  if (Array.isArray(value)) return value.map(encodeDotKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value)) {
      let nk = k.indexOf('.') !== -1 ? k.split('.').join(DOT_TOKEN) : k;
      if (nk.startsWith('$')) nk = DOLLAR_TOKEN + nk.slice(1);
      out[nk] = encodeDotKeys(value[k]);
    }
    return out;
  }
  return value;
}

function decodeDotKeys(value) {
  if (Array.isArray(value)) return value.map(decodeDotKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value)) {
      let nk = k.indexOf(DOT_TOKEN) !== -1 ? k.split(DOT_TOKEN).join('.') : k;
      if (nk.startsWith(DOLLAR_TOKEN)) nk = '$' + nk.slice(DOLLAR_TOKEN.length);
      out[nk] = decodeDotKeys(value[k]);
    }
    return out;
  }
  return value;
}

// Encode a document update so stored keys never contain a ".".
//  • Full-document replacement → encode the whole document's keys.
//  • Modifier update ($set/$push/…) → encode the VALUES under each operator
//    (that's where deep dotted keys live, e.g. $set.nodes[…].config.…), but
//    leave the operator names and their field-path keys (e.g. "nodes",
//    "data.config") untouched — NeDB intentionally allows dots in those.
function encodeUpdate(update) {
  if (!update || typeof update !== 'object') return update;
  const hasOperators = Object.keys(update).some((k) => k.startsWith('$'));
  if (!hasOperators) return encodeDotKeys(update);

  const out = {};
  for (const [op, fields] of Object.entries(update)) {
    if (op.startsWith('$') && fields && typeof fields === 'object' && !Array.isArray(fields)) {
      const encodedFields = {};
      for (const [fieldPath, val] of Object.entries(fields)) {
        encodedFields[fieldPath] = encodeDotKeys(val);   // encode the value, keep the field path
      }
      out[op] = encodedFields;
    } else {
      out[op] = fields;
    }
  }
  // console.log('encodeUpdate: ', out)
  return out;
}

// A cursor wrapper that mirrors NeDB's chainable+awaitable cursor but decodes
// keys in the resolved documents. An optional postProcess runs on the decoded
// docs (used to re-inline externalized workflow code).
function wrapDecodingCursor(cursor, postProcess) {
  const wrapper = {
    sort(...a) { cursor.sort(...a); return wrapper; },
    skip(...a) { cursor.skip(...a); return wrapper; },
    limit(...a) { cursor.limit(...a); return wrapper; },
    projection(...a) { cursor.projection(...a); return wrapper; },
    then(onFulfilled, onRejected) {
      return Promise.resolve(cursor)
        .then((docs) => decodeDotKeys(docs))
        .then((docs) => (postProcess ? postProcess(docs) : docs))
        .then(onFulfilled, onRejected);
    },
    catch(onRejected) { return wrapper.then(undefined, onRejected); },
  };
  return wrapper;
}

// Proxy that encodes keys on write and decodes on read. Queries are passed
// through untouched (workflows are queried by dot-free id/_id/name), so only
// stored documents carry the encoding. Any method we don't override forwards
// straight to the raw datastore.
function wrapKeySafeDb(raw) {
  // Code in node configs is externalized to files under this dir on write and
  // re-inlined on read. Computed here (after app-ready, since the wrapper is
  // created lazily on first getDb('workflows')).
  const codeBaseDir = path.join(app.getPath('userData'), 'workflow-code');
  const inline = (docs) => inlineWorkflowCode(docs, codeBaseDir);
  const overrides = {
    insertAsync: (doc) => {
      const wfId = doc && (doc.id || doc._id);
      // Tell the code watcher these files are ours before we touch them, so the
      // editor doesn't treat our own write as an external edit and reload.
      suppressWorkflowCodeEvents(wfId);
      const externalized = wfId ? externalizeWorkflowCode(doc, wfId, codeBaseDir) : doc;
      return raw.insertAsync(encodeDotKeys(externalized)).then(decodeDotKeys).then(inline);
    },
    findOneAsync: (...args) => raw.findOneAsync(...args).then(decodeDotKeys).then(inline),
    findAsync: (...args) => wrapDecodingCursor(raw.findAsync(...args), inline),
    updateAsync: async (query, update, options = {}) => {
      let externalized = update;
      const set = update && update.$set;
      if (set && Array.isArray(set.nodes)) {
        // Directory naming needs the workflow name; modify updates may omit it,
        // so fall back to the stored doc's name.
        let wfName = set.name;
        if (wfName === undefined) {
          const existing = await raw.findOneAsync(query);
          wfName = existing && existing.name;
          // A watcher is registered under whichever id the renderer opened the
          // workflow with, and a caller may update by the other one — so
          // suppress both while we have the document in hand.
          if (existing) {
            suppressWorkflowCodeEvents(existing.id);
            suppressWorkflowCodeEvents(existing._id);
          }
        }
        // Same as insertAsync: this rewrite is the app's, not an outside edit.
        suppressWorkflowCodeEvents(extractWorkflowId(query));
        externalized = externalizeUpdateCode(query, update, codeBaseDir, wfName);
      }
      const res = await raw.updateAsync(query, encodeUpdate(externalized), options);
      if (res && res.affectedDocuments) res.affectedDocuments = inline(decodeDotKeys(res.affectedDocuments));
      return res;
    },
  };
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// Dotted-key encoding WITHOUT code externalization, for the workflow history
// collection. Its documents are snapshots of workflow nodes, so they carry the
// same dotted config keys the workflows collection has to encode — but a
// version snapshot has to stay self-contained: externalizing its code would
// point every version at the same file on disk, and reverting would then
// restore the CURRENT code under an old graph.
function wrapDotSafeDb(raw) {
  const overrides = {
    insertAsync: (doc) => raw.insertAsync(encodeDotKeys(doc)).then(decodeDotKeys),
    findOneAsync: (...args) => raw.findOneAsync(...args).then(decodeDotKeys),
    findAsync: (...args) => wrapDecodingCursor(raw.findAsync(...args), null),
    updateAsync: async (query, update, options = {}) => {
      const res = await raw.updateAsync(query, encodeUpdate(update), options);
      if (res && res.affectedDocuments) res.affectedDocuments = decodeDotKeys(res.affectedDocuments);
      return res;
    },
  };
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function getDb(collection) {
  if (!VALID_COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown collection: ${collection}`);
  }
  if (!_dbs[collection]) {
    _dbs[collection] = new Datastore({
      filename: path.join(app.getPath('userData'), `ternlux-${collection}.db`),
      autoload: true,
    });
    if (collection === 'executions') {
      // The execution monitor polls "what is running" every second or so, and
      // each open canvas asks for its workflow's newest run. Without these the
      // collection is scanned end to end each time, and it only ever grows.
      _dbs[collection].ensureIndex({ fieldName: 'status' }, () => {});
      _dbs[collection].ensureIndex({ fieldName: 'workflowId' }, () => {});
    }
    if (collection === 'workflowHistory') {
      // One document per workflow, always fetched by workflowId — which is the
      // collection's primary key, so the index is unique.
      _dbs[collection].ensureIndex({ fieldName: 'workflowId', unique: true }, () => {});
    }
  }
  // EVERY collection gets the dotted-key encoding. A dotted key is not a
  // workflow-shaped problem — it is a NeDB one, and workflow-shaped data ends
  // up in most of these stores:
  //
  //   chatSessions — a message records the config of a node the assistant
  //                  built (`nodeRun`) and the results of tools like
  //                  get_workflow, so a join keyed by "[dbo].[transactions]"
  //                  (joinColumns) reaches this collection intact
  //   connections  — a file connection's `fileInfo.tables` is keyed by table
  //                  name, and a sheet or CSV can have a dot in its name
  //   executions   — an output-validation function returns whatever it likes
  //
  // Each of those used to throw "Field names cannot contain a ." out of the
  // db:update handler, and the renderer only warns, so the write was lost
  // silently — a chat that discussed a schema-qualified join simply stopped
  // persisting. Only `workflows` needs the extra code-externalization pass on
  // top (wrapKeySafeDb encodes as well).
  if (!_dbWrappers[collection]) {
    _dbWrappers[collection] = collection === 'workflows'
      ? wrapKeySafeDb(_dbs[collection])
      : wrapDotSafeDb(_dbs[collection]);
  }
  return _dbWrappers[collection];
}

// db:insert — insert a document into a collection
ipcMain.handle('db:insert', async (_event, { collection, doc }) => {
  const db = getDb(collection);
  return db.insertAsync(doc);
});

// db:find — find documents with optional sort/limit/skip
ipcMain.handle('db:find', async (_event, { collection, query = {}, sort = null, limit = 0, skip = 0 }) => {
  const db = getDb(collection);
  let cursor = db.findAsync(query);
  if (sort)  cursor = cursor.sort(sort);
  if (skip)  cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  return cursor;
});

// db:findOne — return the first matching document or null
ipcMain.handle('db:findOne', async (_event, { collection, query = {} }) => {
  const db = getDb(collection);
  return db.findOneAsync(query);
});

// db:update — update matching documents; options: { multi, upsert, returnUpdatedDocs }
ipcMain.handle('db:update', async (_event, { collection, query = {}, update = {}, options = {} }) => {
  const db = getDb(collection);
  return db.updateAsync(query, update, options);
});

/** A connection that reads a file on disk rather than a remote server. */
const isLocalFileConnection = (conn) =>
  !!conn && conn.connectionType === 'file' && !!conn.fileInfo?.filePath;

/**
 * Let go of whatever a deleted file connection registered on the shared DuckDB
 * instance — its schema of views, or its ATTACH for a database file.
 *
 * The config is built the same way the Data Explorer builds it (see
 * public/database/index.js configForConnection + withSiblings), because the
 * connector resolves its schema name from exactly those fields; handing it a
 * different shape would compute a different name and drop nothing.
 *
 * Best-effort: a connection the user asked to delete gets deleted either way.
 */
async function releaseFileConnection(conn, remainingConnections = []) {
  try {
    const connector = pluginManager.hasConnector(conn.dbType)
      ? pluginManager.getConnector(conn.dbType)
      : null;
    if (!connector || typeof connector.releaseConnection !== 'function') return;

    const configFor = (c) => ({
      ...(c.dbConfig || {}),
      dbPath: c.fileInfo?.filePath,
      tables: c.fileInfo?.tables || null,
      tablePaths: c.fileInfo?.tablePaths || null,
      tableSheets: c.fileInfo?.tableSheets || null,
      format: c.fileInfo?.format || null,
    });

    const siblings = remainingConnections
      .filter((c) => c.dbType === conn.dbType && isLocalFileConnection(c))
      .map((c) => ({ connectionId: c.id || c._id, name: c.name, config: configFor(c) }))
      .filter((s) => s.config.dbPath);

    const config = { ...configFor(conn), connectionName: conn.name, ...(siblings.length ? { siblings } : {}) };
    const result = await connector.releaseConnection(config, conn.id || conn._id);
    if (result && result.success === false) {
      console.warn(`[db:remove] could not release connection ${conn.name}:`, result.message);
    }
  } catch (err) {
    console.warn('[db:remove] could not release connection:', err.message);
  }
}

// db:remove — remove matching documents; options: { multi }
ipcMain.handle('db:remove', async (_event, { collection, query = {}, options = {} }) => {
  const db = getDb(collection);
  // Clean up externalized code files for deleted workflows. The code folder is
  // named after the workflow name (falling back to its id), so resolve the
  // matching docs to compute the same directory name externalize used.
  if (collection === 'workflows') {
    const codeBaseDir = path.join(app.getPath('userData'), 'workflow-code');
    const matches = await db.findAsync(query);
    for (const m of (Array.isArray(matches) ? matches : [])) {
      deleteWorkflowCode(workflowDirName(m.name, m.id || m._id), codeBaseDir);
      // The workflow's database goes with it — every node output it holds
      // belonged to this workflow and nothing else can reach them.
      try {
        await require('./duckdb').dropWorkflowDb(m.id || m._id);
      } catch (err) {
        console.warn('[db:remove] could not drop workflow database:', err.message);
      }
      // So does its version history — there is nothing left to revert into,
      // and versions left behind would be handed to whatever workflow next
      // reused the id. Matched on both ids because the history is keyed by
      // whichever one the renderer recorded under.
      try {
        await getDb('workflowHistory').removeAsync(
          { $or: [{ workflowId: m.id }, { workflowId: m._id }] },
          { multi: true },
        );
      } catch (err) {
        console.warn('[db:remove] could not drop workflow history:', err.message);
      }
    }
  }

  // A local file connection leaves a schema of views on the shared DuckDB
  // instance the first time it is browsed (see the duckdb connector's
  // registerSchema). Those views outlive the connection record, so without
  // this a deleted CSV keeps answering to `sales_csv.orders` in a worksheet
  // and keeps appearing among other connections' siblings until restart.
  if (collection === 'connections') {
    const matches = await db.findAsync(query);
    const doomed = (Array.isArray(matches) ? matches : []).filter(isLocalFileConnection);
    if (doomed.length) {
      // The siblings a name collision is resolved against are the connections
      // that REMAIN — which is what the explorer will pass next time it
      // registers, and therefore the name this one was registered under.
      const removedIds = new Set(doomed.map((c) => String(c.id || c._id)));
      const remaining = (await getDb('connections').findAsync({}))
        .filter((c) => !removedIds.has(String(c.id || c._id)));
      for (const conn of doomed) {
        await releaseFileConnection(conn, remaining);
      }
    }
  }

  return db.removeAsync(query, options);
});

// db:count — count documents matching query
ipcMain.handle('db:count', async (_event, { collection, query = {} }) => {
  const db = getDb(collection);
  return db.countAsync(query);
});

// db:read-local-collection — read from a local DuckDB or SQLite file
ipcMain.handle('db:read-local-collection', async (_event, { filePath, limit = 100, storageType = 'duckdb', sqlPreview = null, tableName = null }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        message: 'Local collection file not found'
      };
    }
    console.log('storageType: ', storageType, filePath, sqlPreview, tableName)

    // Read by DuckDB. Two shapes arrive here:
    //
    //   • a workflow database (.duckdb) — a node's output is a TABLE in it, so
    //     `tableName` says which one.
    //   • a data file (csv/json/parquet) — read in place, no import, and the
    //     "collection" is the file itself.
    //
    // Either way this returns the same shape as the SQLite branch so the
    // preview grid needs no special case.
    //
    // The stored preview statement is deliberately ignored: reading the output
    // is what it was standing in for, and the rows it names have already been
    // transformed by the time they land here.
    if (storageType === 'duckdb') {
      const duck = require('./duckdb');
      try {
        // A database — a workflow's .duckdb, or a SQLite file the user opened.
        // Both hold several tables, so one has to be named; a connection scoped
        // to its own tables passes one, and anything else previews the first.
        if (/\.(duckdb|sqlite|sqlite3|db)$/i.test(filePath)) {
          const tables = await duck.tablesAt(filePath);
          const table = tableName || tables[0];
          if (!table) {
            return { success: false, message: `${path.basename(filePath)} holds no tables.` };
          }
          const result = await duck.readTableHeadAt(filePath, table, limit);
          return {
            success: true,
            rows: result.rows,
            rowCount: result.rowCount,
            json: false,
            tables,
            currentTable: table,
            columns: result.columns,
          };
        }

        // A workbook holds a table per sheet, and the caller's table name is
        // the sheet — without it every sheet would preview as the first one.
        const result = await duck.readHead(filePath, limit, null, {
          sheet: duck.sheetFor(filePath, tableName),
        });
        const name = tableName || path.basename(filePath, path.extname(filePath));
        return {
          success: true,
          rows: result.rows,
          rowCount: result.rowCount,
          json: false,
          tables: [name],
          currentTable: name,
          // DuckDB knows the real column types, so callers don't have to infer
          // them from the first row.
          columns: result.columns,
        };
      } catch (error) {
        return { success: false, message: `Failed to read ${path.basename(filePath)}: ${error.message}` };
      }
    }

    // Use passed storageType parameter instead of file extension
    const isSqlite = storageType === 'sqlite';

    if (isSqlite) {
      // Read SQLite database — through DuckDB's sqlite extension (lib/sqlite).
      try {
        if (sqlPreview) {
          const rows = await localSQLite.runQuery({ dbPath: filePath, query: sqlPreview });
          return {
            success: true, rows, rowCount: rows.length, json: false, tables: [], currentTable: tableName || null,
          };
        }
        const tables = tableName ? [tableName] : await localSQLite.getTables({ dbPath: filePath });
        const table = tableName || tables[0];
        if (!table) return { success: true, rows: [], rowCount: 0, json: false, tables: [] };
        const rows = await localSQLite.runQuery({
          dbPath: filePath,
          query: `SELECT * FROM "${String(table).replace(/"/g, '""')}" LIMIT ${Number(limit) || 100}`,
        });
        return { success: true, rows, rowCount: rows.length, json: false, tables, currentTable: table };
      } catch (error) {
        return {
          success: false,
          message: sqlPreview
            ? `Failed to execute preview query: ${error.message}`
            : `Failed to read ${path.basename(filePath)}: ${error.message}`,
          tables: [],
        };
      }
    }

    // Every local store is read by DuckDB or SQLite above. A storageType that
    // reaches here is one this app no longer has a reader for — a stale config
    // naming the removed local document store — and saying so is better than
    // the empty result an unhandled branch used to return.
    return {
      success: false,
      message: `Unsupported local storage type "${storageType}". Local files are read as DuckDB or SQLite.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error reading local collection: ${error.message}`
    };
  }
});

// ---------------------------------------------------------------------------
// Native file open dialog
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:open-file', async (_event, options = {}) => {
  const { dialog } = require('electron');
  const defaultOptions = {
    title: 'Select File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  };

  // Merge provided options with defaults
  const dialogOptions = {
    ...defaultOptions,
    ...options,
    properties: options.properties || defaultOptions.properties
  };

  const result = await dialog.showOpenDialog(dialogOptions);
  return result; // { canceled: bool, filePaths: string[] }
});

// ---------------------------------------------------------------------------
// Native file save dialog
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:save-file', async (_event, defaultFileName = 'output.json', fileExtension = 'json') => {
  const { dialog } = require('electron');

  const filters = [];
  switch (fileExtension) {
    case 'json':
      filters.push({ name: 'JSON Files', extensions: ['json'] });
      break;
    case 'csv':
      filters.push({ name: 'CSV Files', extensions: ['csv'] });
      break;
    case 'xlsx':
    case 'excel':
      filters.push({ name: 'Excel Files', extensions: ['xlsx'] });
      break;
    case 'duckdb':
      filters.push({ name: 'DuckDB Files', extensions: ['duckdb'] });
      break;
    case 'sqlite':
      filters.push({ name: 'SQLite Files', extensions: ['sqlite', 'sqlite3', 'db'] });
      break;
    case 'parquet':
      filters.push({ name: 'Parquet Files', extensions: ['parquet'] });
      break;
    case 'avro':
      filters.push({ name: 'Avro Files', extensions: ['avro'] });
      break;
    default:
      filters.push({ name: 'All Files', extensions: ['*'] });
  }
  filters.push({ name: 'All Files', extensions: ['*'] });

  const result = await dialog.showSaveDialog({
    title: 'Save File',
    defaultPath: defaultFileName,
    filters: filters,
  });

  return result; // { canceled: bool, filePath: string }
});

// ---------------------------------------------------------------------------
// Local file reading — xlsx/csv via the xlsx package (no upload required)
// ---------------------------------------------------------------------------

/**
 * file:read-rows — read up to `limit` data rows from a local spreadsheet file.
 * Returns { success, sheets, data: { [sheetName]: { columns, rows } } }
 */
ipcMain.handle('file:read-rows', async (_event, { filePath, limit = 1000 }) => {
  try {
    const XLSX = require('xlsx');
    const duck = require('./duckdb');

    // Anything DuckDB reads natively is read straight off disk — it touches
    // only as much of the file as `limit` needs, so a 5 GB CSV previews as
    // fast as a small one. This also covers parquet and json, which used to
    // fall through to XLSX.readFile and simply fail.
    if (duck.isReadable(filePath)) {
      // A workbook is many sheets in one file, and each is previewed on its own
      // terms. An empty sheet has nothing for DuckDB to describe, and comes back
      // empty rather than taking the whole preview down with it.
      if (duck.isWorkbook(filePath)) {
        const data = {};
        const sheets = [];
        for (const sheet of duck.listSheets(filePath)) {
          try {
            const { rows, columns } = await duck.readHead(filePath, limit, null, { sheet });
            data[sheet] = { columns: columns.map((c) => c.name), rows };
          } catch (_err) {
            data[sheet] = { columns: [], rows: [] };
          }
          sheets.push(sheet);
        }
        return { success: true, sheets, data };
      }

      const { rows, columns } = await duck.readHead(filePath, limit);
      const sheetName = path.basename(filePath, path.extname(filePath)) || 'Sheet1';
      return {
        success: true,
        sheets: [sheetName],
        data: { [sheetName]: { columns: columns.map((c) => c.name), rows } },
      };
    }

    // Only the formats DuckDB will not open reach here — .xls and .xlsb. They
    // are refused when a connection is added, but a preview can still be asked
    // for a raw path, and showing one is better than an error.
    const workbook = XLSX.readFile(filePath, { sheetRows: limit + 1, cellDates: true, raw: false });
    const data = {};
    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
      if (rawRows.length === 0) {
        data[sheetName] = { columns: [], rows: [] };
        return;
      }
      const headers = (rawRows[0] || []).map((h, i) =>
        h !== null && h !== undefined && String(h).trim() !== '' ? String(h) : `Column ${i + 1}`
      );
      const dataRows = rawRows.slice(1, limit + 1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row ? row[i] : null; });
        return obj;
      });
      data[sheetName] = { columns: headers, rows: dataRows };
    });
    return { success: true, sheets: workbook.SheetNames, data };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * Build the onProgress callback handed to the streaming importers. Each batch
 * they commit sends one event back to the window that asked for the import, so
 * the form can show real progress instead of a guessed timer. `importId` lets
 * a renderer with several imports in flight tell them apart.
 */
/**
 * file:register-local — record a local file as a data source.
 *
 * This replaces importing. Every supported format — csv / json / parquet /
 * xlsx / avro — is registered by path and never copied, so adding a 5 GB file
 * is instant. A workbook comes back as one table per sheet.
 *
 * Returns { success, format, tables: [{ name, path, sheet, schema }] }
 */
ipcMain.handle('file:register-local', async (_event, {
  filePath, importId = null, headerRow = 1, headerRows = null,
}) => {
  try {
    // Saved BEFORE the file is described, so its columns come from the header
    // row the user named (see duckdb/readOptions.js). A workbook's rows are
    // per sheet (`headerRows`): a title above one sheet's header says nothing
    // about the others. Replaces whatever was recorded for the file before.
    require('./duckdb/readOptions').replaceHeaderRows(filePath, headerRow, headerRows);
    return await registerLocalFile(filePath, app.getPath('userData'), {
      onProgress: makeImportProgressReporter(_event, importId),
    });
  } catch (error) {
    console.error('Register local file error:', error);
    return { success: false, message: error.message || 'Failed to register file' };
  }
});

function makeImportProgressReporter(event, importId) {
  if (!importId || !event?.sender || event.sender.isDestroyed()) return null;
  return (info) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send('import:progress', { importId, ...info });
  };
}




/**
 * list-lancedb-tables — List all tables in a LanceDB database directory
 * Returns { success, tables: string[], message }
 */
ipcMain.handle('list-lancedb-tables', async (_event, dbPath) => {
  try {
    if (!dbPath || !fs.existsSync(dbPath)) {
      return {
        success: false,
        message: 'LanceDB directory not found',
        tables: []
      };
    }

    // Get vector-db-executor skill via pluginManager
    const vectorSkill = pluginManager.getSkill('vector-db-executor');
    if (!vectorSkill) {
      return {
        success: false,
        message: 'Vector database executor skill not found. Please install the vector-db-executor skill.',
        tables: []
      };
    }

    // Call the skill's method to list tables
    const helpers = await buildSkillHelpers();
    const result = await vectorSkill.listLanceDBTables({ dbPath, helpers });

    return result;
  } catch (err) {
    console.error('List LanceDB tables error:', err);
    return {
      success: false,
      message: err.message,
      tables: []
    };
  }
});

// ---------------------------------------------------------------------------
// Direct database connection IPC handlers
// Drivers are require()'d lazily so they don't slow app startup.
// ---------------------------------------------------------------------------

/**
 * Helper function to retrieve and merge connection config with secure credentials
 * @param {string} connectionId - The connection ID
 * @param {Object} baseConfig - The base config with non-sensitive data
 * @returns {Object} - Merged config with credentials
 */
async function getFullConfig(connectionId, baseConfig = {}) {
  if (!connectionId) {
    // If no connectionId, assume baseConfig already has everything (e.g., test connection before saving)
    console.log('[getFullConfig] No connectionId, returning baseConfig:');
    return baseConfig;
  }

  try {
    const conn = (await loadConnectionsFromDb()).find(
      (c) => (c.id || c._id) === connectionId,
    );

    // Only the fields a plugin marks `sensitive` go to the keychain; everything
    // else (a GCS bucket, an S3 region/endpoint, a SharePoint siteId, the OAuth
    // redirectUri and token expiry) stays in the connection's dbConfig. Callers
    // that pass `{}` used to lose all of it, so lay the stored dbConfig down as
    // the base layer — anything the caller supplied still wins over it.
    if (conn?.dbConfig) {
      baseConfig = { ...conn.dbConfig, ...baseConfig };
    }

    // A local file connection keeps its location in fileInfo, not dbConfig, and
    // most callers hand us dbConfig (which is empty for a file). Fill in the
    // path here so any connector call for a file connection is addressable,
    // rather than making every call site remember to reshape the config.
    if (!baseConfig?.dbPath && conn?.connectionType === 'file' && conn.fileInfo?.filePath) {
      baseConfig = {
        ...baseConfig,
        dbPath: conn.fileInfo.filePath,
        tables: conn.fileInfo.tables || null,
        tablePaths: conn.fileInfo.tablePaths || null,
        tableSheets: conn.fileInfo.tableSheets || null,
        format: conn.fileInfo.format || null,
      };
    }
  } catch (err) {
    console.warn('[getFullConfig] Could not load stored connection config:', err.message);
  }

  try {
    // Load secure credentials
    const allCredentials = loadAllCredentials();
    const credentials = allCredentials[connectionId];
    // console.log('[getFullConfig] connectionId:', connectionId);
    // console.log('[getFullConfig] available credential IDs:', Object.keys(allCredentials));
    // console.log('[getFullConfig] baseConfig:', baseConfig);
    // console.log('[getFullConfig] loaded credentials:', credentials);

    if (!credentials) {
      // No credentials found - return baseConfig as-is
      console.warn('[getFullConfig] No credentials found for connectionId:', connectionId);
      return baseConfig;
    }

    // Merge baseConfig with credentials
    const fullConfig = {
      ...baseConfig,
      ...credentials
    };
    // console.log('[getFullConfig] merged fullConfig:', fullConfig);
    return fullConfig;
  } catch (err) {
    console.error('[getFullConfig]', err);
    return baseConfig;
  }
}

/**
 * dbconn:test — verify that a connection can be established.
 * Returns { success, message }
 * Accepts either full config (for testing before save) or connectionId + partial config
 */
ipcMain.handle('dbconn:test', async (_event, { dbType, config, connectionId }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.testConnection(fullConfig, connectionId);
    }

    return { success: false, message: `Unsupported dbType: ${dbType}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:get-tables — list schemas + tables (or MongoDB collections).
 * Returns { success, tables: [{ schema, name, type }] }
 */
ipcMain.handle('dbconn:get-tables', async (_event, { dbType, config, connectionId }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.getTables(fullConfig, connectionId);
    }

    return { success: false, tables: [] };
  } catch (err) {
    return { success: false, message: err.message, tables: [] };
  }
});

/**
 * dbconn:get-columns — list columns for a specific table.
 * Returns { success, columns: [{ name, type, nullable, isPrimary }] }
 */
ipcMain.handle('dbconn:get-columns', async (_event, { dbType, config, connectionId, schema, table }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.getColumns(fullConfig, connectionId, schema, table);
    }

    return { success: false, columns: [] };
  } catch (err) {
    return { success: false, message: err.message, columns: [] };
  }
});

/**
 * dbconn:quote-identifier — quote table/column identifier for specific database type.
 * Returns { success, quotedIdentifier }
 */
ipcMain.handle('dbconn:quote-identifier', async (_event, { dbType, identifier, schema = null, config = null, connectionId = null }) => {
  try {
    // Get full config if connectionId is provided
    let fullConfig = config;
    if (connectionId && !config) {
      fullConfig = await getFullConfig(connectionId, {});
    }

    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      if (typeof connector.quoteIdentifier === 'function') {
        const quotedIdentifier = connector.quoteIdentifier(identifier, schema, fullConfig);
        return { success: true, quotedIdentifier };
      }
    }

    // Fallback: return unquoted identifier
    const result = schema ? `${schema}.${identifier}` : identifier;
    return { success: true, quotedIdentifier: result };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:get-preview-query — generate database-specific preview SQL query.
 * Returns { success, previewQuery }
 */
ipcMain.handle('dbconn:get-preview-query', async (_event, { dbType, tableName, limit = 100 }) => {
  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      if (typeof connector.getPreviewQuery === 'function') {
        const previewQuery = connector.getPreviewQuery(tableName, limit);
        return { success: true, previewQuery };
      }
    }

    // Fallback: use standard LIMIT syntax
    return { success: true, previewQuery: `SELECT * FROM ${tableName} LIMIT ${limit}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * google-sheets:import-to-duckdb — Import a Google Sheet to a local DuckDB file.
 *
 * One file holds every imported sheet, a table each: DuckDB replaces only the
 * table being written, so re-importing a sheet refreshes it and leaves the
 * others alone. That is the same "one file, many tables" arrangement the shared
 * app SQLite database used to provide, minus the second storage engine.
 *
 * Column names are sanitized (and de-duplicated) so downstream SQL can address
 * them unquoted, and a column whose values are all numeric is CONVERTED to
 * numbers before the write rather than declared numeric and filled with
 * strings — Sheets hands back everything as text, and DuckDB, unlike SQLite,
 * does not silently coerce on insert.
 *
 * Returns { success, localPath, tableName, rowCount, message }
 */
ipcMain.handle('google-sheets:import-to-duckdb', async (_event, { config, connectionId, spreadsheetId, sheetName }) => {
  try {
    const fullConfig = await getFullConfig(connectionId, config);

    if (!pluginManager.hasConnector('google-sheets')) {
      return { success: false, message: 'Google Sheets connector not found' };
    }

    const connector = pluginManager.getConnector('google-sheets');

    // Step 1: Fetch data from Google Sheets
    const queryResult = await connector.runQuery(fullConfig, connectionId, {
      spreadsheetId,
      sheetName,
      range: `${sheetName}!A1:ZZ`
    });

    if (!queryResult.success || !queryResult.rows || queryResult.rows.length === 0) {
      return { success: false, message: 'Failed to fetch data from Google Sheet or sheet is empty' };
    }

    const rows = queryResult.rows;
    const columns = queryResult.columns;

    // Step 2: Generate sanitized table name
    const sanitizedTableName = `gs_${spreadsheetId.substring(0, 20)}_${sheetName}`
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .substring(0, 64);

    // Step 3: Sanitize column names and handle duplicates
    const sanitizedColumnNames = [];
    const columnIndexMap = new Map(); // Maps index to sanitized name

    columns.forEach((column, index) => {
      let baseName = (column || `Column_${index + 1}`).replace(/[^a-zA-Z0-9_]/g, '_');

      // Ensure name doesn't start with a number
      if (/^\d/.test(baseName)) {
        baseName = '_' + baseName;
      }

      // Handle duplicates by adding suffix
      let finalName = baseName;
      let suffix = 1;
      while (sanitizedColumnNames.includes(finalName)) {
        finalName = `${baseName}_${suffix}`;
        suffix++;
      }

      sanitizedColumnNames.push(finalName);
      columnIndexMap.set(index, finalName);
    });

    // Step 4: Infer column types from data
    const inferType = (values) => {
      const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
      if (nonNullValues.length === 0) return 'TEXT';

      // Check if all are numbers
      const allNumbers = nonNullValues.every(v => !isNaN(Number(v)));
      if (allNumbers) {
        const allIntegers = nonNullValues.every(v => Number.isInteger(Number(v)));
        return allIntegers ? 'INTEGER' : 'REAL';
      }

      return 'TEXT';
    };

    const columnTypes = columns.map((column, index) => ({
      original: column,
      name: columnIndexMap.get(index),
      type: inferType(rows.map(row => row[column])),
    }));

    // Step 5: Re-key each row under the sanitized names, converting the columns
    // that are wholly numeric. An empty cell stays null rather than becoming 0.
    const shaped = rows.map((row) => {
      const out = {};
      for (const { original, name, type } of columnTypes) {
        const value = row[original];
        if (value === null || value === undefined || value === '') {
          out[name] = null;
        } else if (type === 'INTEGER' || type === 'REAL') {
          const asNumber = Number(value);
          out[name] = Number.isNaN(asNumber) ? value : asNumber;
        } else {
          out[name] = value;
        }
      }
      return out;
    });

    // Step 6: Write the table into the shared Google Sheets database
    const duck = require('./duckdb');
    const localPath = path.join(app.getPath('userData'), 'google-sheets.duckdb');
    const { rowCount, tableName } = await duck.ingestRowsToTableAt(
      shaped, localPath, sanitizedTableName, { mode: 'replace' },
    );

    return {
      success: true,
      localPath,
      tableName,
      rowCount,
      message: `Imported ${rowCount} rows from Google Sheet`
    };
  } catch (err) {
    console.error('[Google Sheets Import] Error:', err);
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:get-table-schema — get table schema with inferred types and sample data.
 * Returns { success, tableName, columns: [{ name, type, nullable, isPrimary }], sampleData }
 */
ipcMain.handle('dbconn:get-table-schema', async (_event, { dbType, config, connectionId, tableName, sheetName = null, limit = 5 }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type and has getTableSchema method
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);

      // If connector has getTableSchema method, use it
      if (typeof connector.getTableSchema === 'function') {
        return await connector.getTableSchema(fullConfig, connectionId, tableName, sheetName, limit);
      }
    }

    return { success: false, message: 'getTableSchema method not implemented for this connector' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * dbconn:run-query — execute a read-only SQL/MQL query.
 * Returns { success, rows, columns, rowCount }
 */
ipcMain.handle('dbconn:run-query', async (_event, { dbType, config, connectionId, query }) => {
  const fullConfig = await getFullConfig(connectionId, config);

  try {
    // Check if a plugin exists for this database type
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      return await connector.runQuery(fullConfig, connectionId, query);
    }

    return { success: false, rows: [], columns: [] };
  } catch (err) {
    return { success: false, message: err.message, rows: [], columns: [] };
  }
});

/**
 * dbconn:generate-transform-prompt — generate transformation prompt from a plugin
 * Executes the prompt function in main process and returns the generated string
 */
ipcMain.handle('dbconn:generate-transform-prompt', async (_event, {
  dbType,
  operationMode,
  settings,
  sourceTableInfo,
  settingsContext,
  sourceTableSchema,
  targetTableName,
  sourceConnection,
  targetSchema,
  fullTableName,
  sourceSchema,
  sourceFullTableName
}) => {
  try {
    if (pluginManager.hasConnector(dbType)) {
      const connector = pluginManager.getConnector(dbType);
      if (typeof connector.getTransformPrompts === 'function') {
        const prompts = connector.getTransformPrompts();

        const promptFn = operationMode === 'in_place' ? prompts.inPlace : prompts.newTable;

        if (typeof promptFn === 'function') {
          console.log('sourceSchema || targetSchema: ', sourceSchema, targetSchema)
          let sourceSchemaClean = operationMode === 'in_place' ? (sourceSchema || targetSchema) : (targetSchema)
          sourceSchemaClean = sourceSchemaClean ? sourceSchemaClean : targetTableName.split('.').length > 1 ? targetTableName.split('.')[0] : null;
          // console.log('sourceSchemaClean: ', sourceSchemaClean)
          // Ask the connector for its server version so the prompt can gate
          // version-sensitive operators. Best-effort: getServerVersion never
          // throws, and a missing version just means the prompt assumes a
          // conservative baseline. Passed as a trailing arg — plugins that
          // don't declare it simply ignore it.
          let serverVersion = null;
          if (typeof connector.getServerVersion === 'function') {
            const versionConnId = sourceConnection?.id || null;
            const versionBaseConfig = sourceConnection?.dbConfig || sourceConnection || {};
            const fullConfig = await getFullConfig(versionConnId, versionBaseConfig);
            const versionResult = await connector.getServerVersion(fullConfig, versionConnId);
            serverVersion = versionResult?.version || null;
          }

          // Execute prompt function in main process with provided parameters
          // For in-place mode, use source table/schema; for new-table mode, use target table/schema
          //
          // Every argument that can carry sample rows goes through the vector
          // stripper first. Doing it here rather than inside each connector
          // covers all of them at once — every connector's getTransformPrompts
          // serialises the schema it is handed, and a transformer reading a
          // vector table would otherwise put whole embeddings in the prompt.
          const prompt = promptFn(
            settings,
            stripVectors(sourceTableInfo),
            settingsContext,
            stripVectors(sourceConnection || sourceTableSchema),
            sourceSchemaClean,
            operationMode === 'in_place' ? (sourceFullTableName || sourceTableSchema?.tableName) : (fullTableName || targetTableName),
            serverVersion
          );

          return {
            success: true,
            prompt: prompt
          };
        }

        return {
          success: false,
          message: `Prompt function not found for operation mode: ${operationMode}`
        };
      }
    }

    return {
      success: false,
      message: `Plugin ${dbType} does not support transformation prompts`
    };
  } catch (err) {
    console.error('[dbconn:generate-transform-prompt]', err);
    return {
      success: false,
      message: err.message
    };
  }
});

/**
 * OAuth2.0 Handlers
 */

// Store pending OAuth states
const pendingOAuthStates = new Map();

/**
 * oauth:get-authorization-url - Generate OAuth authorization URL
 */
ipcMain.handle('oauth:get-authorization-url', async (_event, { dbType, config }) => {
  try {
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Connector not found' };
    }

    if (!plugin.getAuthorizationUrl) {
      return { success: false, message: 'Connector does not support OAuth' };
    }

    // Generate random state for CSRF protection
    const state = require('crypto').randomBytes(16).toString('hex');

    const result = plugin.getAuthorizationUrl({ ...config, state });

    if (result.success) {
      // Store state for verification
      pendingOAuthStates.set(state, {
        dbType,
        config,
        timestamp: Date.now()
      });

      // Clean up old states (older than 10 minutes)
      for (const [key, value] of pendingOAuthStates.entries()) {
        if (Date.now() - value.timestamp > 10 * 60 * 1000) {
          pendingOAuthStates.delete(key);
        }
      }
    }

    return result;
  } catch (error) {
    console.error('[oauth:get-authorization-url]', error);
    return { success: false, message: error.message };
  }
});

/**
 * oauth:exchange-code - Exchange authorization code for tokens
 */
ipcMain.handle('oauth:exchange-code', async (_event, { dbType, config, code, state }) => {
  try {
    // Verify state
    const pendingState = pendingOAuthStates.get(state);
    if (!pendingState) {
      return { success: false, message: 'Invalid or expired OAuth state' };
    }

    pendingOAuthStates.delete(state);

    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Connector not found' };
    }

    if (!plugin.exchangeCodeForTokens) {
      return { success: false, message: 'Connector does not support OAuth' };
    }
    
    const result = await plugin.exchangeCodeForTokens(config, code);
    return result;
  } catch (error) {
    console.error('[oauth:exchange-code]', error);
    return { success: false, message: error.message };
  }
});

/**
 * oauth:open-browser - Open browser to OAuth URL
 */
ipcMain.handle('oauth:open-browser', async (_event, { url }) => {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('[oauth:open-browser]', error);
    return { success: false, message: error.message };
  }
});

// Track active OAuth servers by port
const activeOAuthServers = new Map();

/**
 * oauth:start-callback-server - Start local server to handle OAuth callback
 */
ipcMain.handle('oauth:start-callback-server', async (_event, { port = 3000 }) => {
  try {
    const http = require('http');
    const url = require('url');

    // Close any existing server on this port
    if (activeOAuthServers.has(port)) {
      const existingServer = activeOAuthServers.get(port);
      existingServer.server.close();
      if (existingServer.timeoutId) clearTimeout(existingServer.timeoutId);
      activeOAuthServers.delete(port);
    }

    return new Promise((resolve) => {
      let timeoutId = null;
      let resolved = false;

      const cleanupAndResolve = (result) => {
        if (resolved) return;
        resolved = true;

        if (timeoutId) clearTimeout(timeoutId);
        activeOAuthServers.delete(port);
        resolve(result);
      };

      const server = http.createServer((req, res) => {
        const query = url.parse(req.url, true).query;

        if (query.code) {
          // Success - got authorization code
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authorization Successful</title></head>
              <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Authorization Successful!</h1>
                <p>You can close this window and return to Ternlux.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);

          server.close();
          cleanupAndResolve({
            success: true,
            code: query.code,
            state: query.state
          });
        } else if (query.error) {
          // Error from OAuth provider
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authorization Failed</title></head>
              <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>✗ Authorization Failed</h1>
                <p>Error: ${query.error}</p>
                <p>${query.error_description || ''}</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);

          server.close();
          cleanupAndResolve({
            success: false,
            error: query.error,
            errorDescription: query.error_description
          });
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      server.listen(port, () => {
        console.log(`[OAuth] Callback server listening on port ${port}`);
      });

      // Store server reference for cancellation
      timeoutId = setTimeout(() => {
        server.close();
        cleanupAndResolve({
          success: false,
          message: 'OAuth timeout - no response received'
        });
      }, 5 * 60 * 1000);

      activeOAuthServers.set(port, { server, timeoutId, cleanup: cleanupAndResolve });
    });
  } catch (error) {
    console.error('[oauth:start-callback-server]', error);
    return { success: false, message: error.message };
  }
});

/**
 * oauth:cancel-server - Cancel an active OAuth callback server
 */
ipcMain.handle('oauth:cancel-server', async (_event, { port = 3000 }) => {
  try {
    const serverInfo = activeOAuthServers.get(port);

    if (serverInfo) {
      console.log(`[OAuth] Canceling server on port ${port}`);
      serverInfo.server.close();
      if (serverInfo.timeoutId) clearTimeout(serverInfo.timeoutId);
      serverInfo.cleanup({
        success: false,
        message: 'OAuth authorization canceled by user'
      });
      return { success: true };
    }

    return { success: false, message: 'Server not found' };
  } catch (error) {
    console.error('[oauth:cancel-server]', error);
    return { success: false, message: error.message };
  }
});

/**
 * auth:google-login — run Google's OAuth loopback flow for desktop apps.
 * Opens the system browser, captures the authorization code on a temporary
 * 127.0.0.1 server, and returns { success, code, redirectUri, codeVerifier }
 * for the renderer to exchange via the backend (/api/auth/google).
 */
ipcMain.handle('auth:google-login', async () => {
  const http = require('http');
  const crypto = require('crypto');

  try {
    // The backend owns the OAuth client configuration.
    const backendUrl = BACKEND_URL;
    let config;
    try {
      ({ data: config } = await axios.get(`${backendUrl}/api/auth/google/config`));
    } catch (err) {
      const serverMessage = err.response?.data?.error;
      console.error('Google login config error:', serverMessage || err.message);
      return { success: false, message: serverMessage || 'Could not reach the Ternlux server for Google sign-in.' };
    }
    if (!config?.clientId) {
      return { success: false, message: 'Google sign-in is not configured on the server.' };
    }

    // PKCE pair — the verifier goes to the backend for the token exchange.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    return await new Promise((resolve) => {
      const server = http.createServer();
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        server.close();
        resolve(result);
      };

      // Give up if the user abandons the browser flow.
      const timeout = setTimeout(() => {
        finish({ success: false, message: 'Google sign-in timed out. Please try again.' });
      }, 5 * 60 * 1000);

      server.on('request', (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const respond = (title, body) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family: sans-serif; text-align: center; padding-top: 80px;">
            <h2>${title}</h2><p>${body}</p></body></html>`);
        };

        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (error || !code) {
          respond('Sign-in cancelled', 'You can close this window and return to Ternlux.');
          finish({ success: false, message: error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${error || 'no code returned'}` });
          return;
        }
        if (returnedState !== state) {
          respond('Sign-in failed', 'Security check failed. Close this window and try again.');
          finish({ success: false, message: 'OAuth state mismatch.' });
          return;
        }

        respond('Signed in with Google', 'You can close this window and return to Ternlux.');
        finish({
          success: true,
          code,
          redirectUri: `http://127.0.0.1:${server.address().port}/callback`,
          codeVerifier
        });
      });

      server.on('error', (err) => finish({ success: false, message: `Could not start sign-in listener: ${err.message}` }));

      server.listen(0, '127.0.0.1', () => {
        const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid email profile',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
          prompt: 'select_account'
        }).toString();
        shell.openExternal(authUrl);
      });
    });
  } catch (err) {
    console.error('Google login error:', err);
    return { success: false, message: err.message || 'Google sign-in failed.' };
  }
});

/**
 * auth:apple-login — run Apple's Sign In flow for desktop apps.
 * Apple forbids loopback redirect URIs, so the backend brokers the OAuth
 * exchange: we open the browser at the backend's /apple/start, Apple posts
 * back to the backend's HTTPS callback, and the backend redirects the
 * browser to our temporary 127.0.0.1 server with a ready-to-use JWT.
 * Returns { success, token, user } or { success: false, message }.
 */
/* Apple sign-in disabled
ipcMain.handle('auth:apple-login', async () => {
  const http = require('http');
  const crypto = require('crypto');

  try {
    const backendUrl = BACKEND_URL;
    try {
      await axios.get(`${backendUrl}/api/auth/apple/config`);
    } catch (err) {
      const serverMessage = err.response?.data?.error;
      console.error('Apple login config error:', serverMessage || err.message);
      return { success: false, message: serverMessage || 'Could not reach the Ternlux server for Apple sign-in.' };
    }

    const state = crypto.randomBytes(16).toString('hex');

    return await new Promise((resolve) => {
      const server = http.createServer();
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        server.close();
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finish({ success: false, message: 'Apple sign-in timed out. Please try again.' });
      }, 5 * 60 * 1000);

      server.on('request', (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const respond = (title, body) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family: sans-serif; text-align: center; padding-top: 80px;">
            <h2>${title}</h2><p>${body}</p></body></html>`);
        };

        const error = url.searchParams.get('error');
        const payload = url.searchParams.get('payload');
        const returnedState = url.searchParams.get('state');

        if (returnedState !== state) {
          respond('Sign-in failed', 'Security check failed. Close this window and try again.');
          finish({ success: false, message: 'OAuth state mismatch.' });
          return;
        }
        if (error || !payload) {
          respond('Sign-in cancelled', 'You can close this window and return to Ternlux.');
          finish({ success: false, message: error || 'Apple sign-in failed.' });
          return;
        }

        try {
          const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
          if (!session.token) throw new Error('missing token');
          respond('Signed in with Apple', 'You can close this window and return to Ternlux.');
          finish({ success: true, token: session.token, user: session.user });
        } catch (err) {
          respond('Sign-in failed', 'Invalid response from the server. Close this window and try again.');
          finish({ success: false, message: 'Invalid sign-in payload from server.' });
        }
      });

      server.on('error', (err) => finish({ success: false, message: `Could not start sign-in listener: ${err.message}` }));

      server.listen(0, '127.0.0.1', () => {
        const startUrl = `${backendUrl}/api/auth/apple/start?` + new URLSearchParams({
          port: String(server.address().port),
          state
        }).toString();
        shell.openExternal(startUrl);
      });
    });
  } catch (err) {
    console.error('Apple login error:', err.message);
    return { success: false, message: err.message || 'Apple sign-in failed.' };
  }
});
*/

/**
 * dbconn:list-plugins — list all available connector plugins
 * Returns { success, connectors: [{ id, name, type, icon, version, description, configSchema }] }
 */
ipcMain.handle('dbconn:list-plugins', async () => {
  try {
    const connectors = pluginManager.listConnectors();
    return { success: true, connectors };
  } catch (err) {
    return { success: false, message: err.message, connectors: [] };
  }
});

// Data Explorer — registers every `explorer:*` channel. Placed here because it
// needs getFullConfig (defined above) to resolve stored credentials the same
// way the dbconn handlers do.
registerDatabaseIpc({
  ipcMain,
  pluginManager,
  getFullConfig,
  getUserDataDir: () => app.getPath('userData'),
  // Lets the explorer show a local-file connection alongside its siblings, so
  // files can be joined to each other rather than browsed one at a time.
  listConnections: loadConnectionsFromDb,
});

/**
 * plugins:install — download and install a plugin from the backend server
 * Returns { success, message }
 */
ipcMain.handle('plugins:install', async (_event, { pluginId }) => {
  try {
    const https = require('https');
    const http = require('http');
    const AdmZip = require('adm-zip');

    // Plugin download URL
    const backendUrl = BACKEND_URL;
    const downloadUrl = `${backendUrl}/api/plugins/download/${pluginId}`;

    console.log(`Downloading plugin ${pluginId} from ${downloadUrl}`);

    // Download plugin zip file
    const protocol = downloadUrl.startsWith('https') ? https : http;

    return new Promise((resolve) => {
      protocol.get(downloadUrl, (response) => {
        if (response.statusCode !== 200) {
          resolve({
            success: false,
            message: `Failed to download plugin: HTTP ${response.statusCode}`
          });
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);

            // Extract zip to plugins directory
            const zip = new AdmZip(buffer);
            const pluginDir = path.join(__dirname, '../plugins/connectors', pluginId);

            // Remove existing plugin directory if it exists
            if (fs.existsSync(pluginDir)) {
              fs.rmSync(pluginDir, { recursive: true, force: true });
            }

            // Create plugin directory
            fs.mkdirSync(pluginDir, { recursive: true });

            // Extract all files (including node_modules)
            zip.extractAllTo(pluginDir, true);

            console.log(`Plugin ${pluginId} installed to ${pluginDir}`);

            // Reload plugins
            pluginManager.loadPlugins();

            resolve({
              success: true,
              message: `Plugin ${pluginId} installed successfully`
            });
          } catch (extractError) {
            console.error('Extract error:', extractError);
            resolve({
              success: false,
              message: `Failed to extract plugin: ${extractError.message}`
            });
          }
        });

        response.on('error', (err) => {
          console.error('Download error:', err);
          resolve({
            success: false,
            message: `Download failed: ${err.message}`
          });
        });
      }).on('error', (err) => {
        console.error('HTTP error:', err);
        resolve({
          success: false,
          message: `Connection failed: ${err.message}`
        });
      });
    });
  } catch (error) {
    console.error('Plugin installation error:', error);
    return {
      success: false,
      message: `Installation failed: ${error.message}`
    };
  }
});

/**
 * plugins:uninstall — remove an installed plugin
 * Returns { success, message }
 */
ipcMain.handle('plugins:uninstall', async (_event, { pluginId }) => {
  try {
    const pluginDir = path.join(__dirname, '../plugins/connectors', pluginId);

    if (!fs.existsSync(pluginDir)) {
      return {
        success: false,
        message: 'Plugin not found'
      };
    }

    // Unload plugin first
    pluginManager.unloadConnector(pluginId);

    // Remove plugin directory
    fs.rmSync(pluginDir, { recursive: true, force: true });

    console.log(`Plugin ${pluginId} uninstalled`);

    return {
      success: true,
      message: `Plugin ${pluginId} uninstalled successfully`
    };
  } catch (error) {
    console.error('Plugin uninstallation error:', error);
    return {
      success: false,
      message: `Uninstallation failed: ${error.message}`
    };
  }
});


/**
 * Skills Plugin Handlers
 */

/**
 * skills:listInstalled — list all installed skill plugins
 * Returns { success, skills: [...] }
 */
ipcMain.handle('skills:listInstalled', async () => {
  try {
    const skills = pluginManager.listSkills();
    return { success: true, skills };
  } catch (err) {
    return { success: false, message: err.message, skills: [] };
  }
});

/**
 * skills:getByCategory — get skills filtered by category
 * Returns { success, skills: [...] }
 */
ipcMain.handle('skills:getByCategory', async (_event, category) => {
  try {
    const skills = pluginManager.getSkillsByCategory(category);
    return { success: true, skills };
  } catch (err) {
    return { success: false, message: err.message, skills: [] };
  }
});

// ---------------------------------------------------------------------------
// AI provider IPC — the renderer never sees decrypted keys; everything goes
// through these handlers, which delegate to public/aiProviders.js.
// ---------------------------------------------------------------------------

/**
 * ai:call — invoke the configured/requested AI provider with the prompt.
 * Returns { success, text } or { success: false, message }.
 */
ipcMain.handle('ai:call', async (_event, { prompt, options = {} } = {}) => {
  try {
    const apiKeys = loadApiKeys();
    if (!apiKeys) {
      return { success: false, message: 'No API keys configured. Set one up in settings.' };
    }
    // Fall back to the persisted default provider + model when the renderer
    // didn't send them, so the saved choice is honored everywhere.
    const merged = withPersistedAiDefaults(options);
    const text = await aiProviders.callAIWithKeys(prompt, { ...merged, apiKeys });
    return { success: true, text };
  } catch (err) {
    console.error('[ai:call]', err);
    return { success: false, message: err.message };
  }
});

/**
 * ai:listProviders — providers that have a usable key configured.
 * Returns { success, providers: ['openai', ...] }.
 */
ipcMain.handle('ai:listProviders', async () => {
  const apiKeys = loadApiKeys() || {};
  return { success: true, providers: aiProviders.listAvailableProviders(apiKeys) };
});

/**
 * ai:listModels — models a provider currently offers, fetched live via its SDK
 * using the decrypted key (which never leaves main). Returns
 * { success, models: [{ value, label }] } or { success: false, error }.
 */
ipcMain.handle('ai:listModels', async (_event, { provider } = {}) => {
  // Logged end to end because an empty model dropdown has several possible
  // causes that look identical in the UI: the wrong provider id, no key on
  // file, a key the provider rejects, or a list that arrives without the
  // token limits the Max Tokens ladder is built from. Key NAMES only —
  // never the values.
  try {
    if (!provider) {
      console.warn('[ai:listModels] called with no provider');
      return { success: false, error: 'provider is required' };
    }
    const apiKeys = loadApiKeys() || {};
    const entry = aiProviders.resolveProviderEntry(provider, apiKeys);
    console.log(
      `[ai:listModels] provider="${provider}" | providers with a key on file: `
      + `[${Object.keys(apiKeys).join(', ') || 'none'}] | resolved a key: ${!!entry}`
      + `${entry?.baseURL ? ` | baseURL=${entry.baseURL}` : ''}`
    );
    if (!entry) {
      console.warn(`[ai:listModels] no key for "${provider}" — the dropdown will be empty`);
      return { success: false, error: 'No API key configured for this provider' };
    }

    const models = await aiProviders.listModels(provider, { apiKey: entry.apiKey, baseURL: entry.baseURL });
    const list = Array.isArray(models) ? models : [];
    console.log(`[ai:listModels] "${provider}" returned ${list.length} model(s)`);
    list.slice(0, 10).forEach((m, i) => {
      console.log(
        `[ai:listModels]   ${i + 1}. ${m.value}`
        + ` | label="${m.label}"`
        + ` | maxOutputTokens=${m.maxOutputTokens ?? 'null'}`
        + ` | maxInputTokens=${m.maxInputTokens ?? 'null'}`
      );
    });
    if (list.length > 10) console.log(`[ai:listModels]   … ${list.length - 10} more`);
    if (list.length === 0) console.warn('[ai:listModels] empty list — the provider returned no models');

    return { success: true, models: list };
  } catch (err) {
    console.error(`[ai:listModels] FAILED for "${provider}":`, err?.message || err);
    console.error(err);
    return { success: false, error: err.message };
  }
});

/**
 * ai:getDefaultProvider — the persisted "Default AI Provider" choice: provider,
 * its model and Max Tokens (each null when unset).
 *
 * ai-prefs.json is the ONLY store for these. Settings and onboarding read them
 * here and write them through ai:setDefaultProvider / ai:setMaxTokens; the
 * renderer keeps no copy, because a second copy is what let Settings show one
 * model while every call sent another.
 */
ipcMain.handle('ai:getDefaultProvider', async () => {
  const prefs = loadAiPrefs();
  return {
    success: true,
    provider: prefs.defaultProvider || null,
    model: prefs.defaultModel || null,
    // Which provider `model` was chosen for — the same owner rule
    // withPersistedAiDefaults applies, so the renderer can tell whether this is
    // the model backend calls will actually send.
    modelProvider: prefs.defaultModelProvider || prefs.defaultProvider || null,
    maxTokens: prefs.defaultMaxTokens || null,
  };
});

/**
 * ai:getCompatProvider — non-secret config for an OpenAI-compatible provider.
 * Returns { hasKey, baseURL, model } WITHOUT the API key, so the settings UI can
 * prefill the URL/model and show that a key exists without ever exposing it.
 */
ipcMain.handle('ai:getCompatProvider', async (_event, { provider } = {}) => {
  try {
    if (!provider) return { success: false, error: 'provider is required' };
    const allKeys = loadApiKeys() || {};
    const stored = allKeys[provider];
    let meta = { hasKey: false, baseURL: '', model: '' };
    if (stored) {
      const entry = typeof stored === 'object' ? stored : { apiKey: stored };
      meta = {
        hasKey: !!(entry.apiKey || entry.key),
        baseURL: entry.baseURL || '',
        model: entry.model || '',
      };
    }
    return { success: true, meta };
  } catch (err) {
    console.error('[ai:getCompatProvider]', err);
    return { success: false, error: err.message };
  }
});

/**
 * ai:saveCompatProvider — store config for an OpenAI-compatible provider as
 * { apiKey, baseURL, model }. A blank/omitted apiKey preserves the existing key
 * (so the user can edit URL/model without re-entering, and the key never needs
 * to be sent back to the renderer).
 */
ipcMain.handle('ai:saveCompatProvider', async (_event, { provider, config = {} } = {}) => {
  try {
    if (!provider) return { success: false, error: 'provider is required' };
    const allKeys = loadApiKeys() || {};
    const stored = allKeys[provider];
    const existing = stored && typeof stored === 'object'
      ? stored
      : (typeof stored === 'string' ? { apiKey: stored } : {});
    const newKey = (config.apiKey && String(config.apiKey).length > 0)
      ? config.apiKey
      : (existing.apiKey || existing.key || '');
    allKeys[provider] = {
      apiKey: newKey,
      baseURL: config.baseURL || existing.baseURL || '',
      model: config.model || existing.model || '',
    };
    writeApiKeys(allKeys);
    return { success: true };
  } catch (err) {
    console.error('[ai:saveCompatProvider]', err);
    return { success: false, error: err.message };
  }
});

/**
 * ai:setMaxTokens — persist the user's Max Tokens choice, which every AI call
 * (chat, planner, node builders) uses. Stored alongside the default
 * provider/model in the same prefs file — the only copy there is.
 */
ipcMain.handle('ai:setMaxTokens', async (_event, { maxTokens } = {}) => {
  try {
    const value = Number(maxTokens);
    if (!Number.isFinite(value) || value <= 0) {
      return { success: false, error: 'maxTokens must be a positive number' };
    }
    const prefs = loadAiPrefs();
    prefs.defaultMaxTokens = value;
    fs.writeFileSync(getAiPrefsPath(), JSON.stringify(prefs), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[ai:setMaxTokens]', err);
    return { success: false, error: err.message };
  }
});

/**
 * ai:setDefaultProvider — persist the user's default provider so backend-internal
 * AI calls (chat, titles, workflow builds) use it when no provider is specified.
 */
ipcMain.handle('ai:setDefaultProvider', async (_event, { provider, model } = {}) => {
  try {
    const prefs = loadAiPrefs();
    const previous = prefs.defaultProvider || null;
    prefs.defaultProvider = provider || null;
    // A stored model belongs to ONE provider, so remember which. Sending
    // "claude-opus-5" to OpenAI is what produced "the selected OpenAI model
    // isn't available" after switching the default provider.
    if (typeof model === 'string' && model) {
      prefs.defaultModel = model;
      prefs.defaultModelProvider = provider || null;
    } else if (!provider) {
      prefs.defaultModel = null;
      prefs.defaultModelProvider = null;
    } else if (String(provider).toLowerCase() !== String(previous || '').toLowerCase()) {
      // Switching providers without naming a model: drop the old provider's
      // model so downstream falls back to this provider's own default rather
      // than reusing a model id the new provider has never heard of.
      prefs.defaultModel = null;
      prefs.defaultModelProvider = null;
    }
    fs.writeFileSync(getAiPrefsPath(), JSON.stringify(prefs), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[ai:setDefaultProvider]', err);
    return { success: false, error: err.message };
  }
});

/**
 * chat:step — one turn of the agentic chat assistant. The renderer drives
 * the loop: each call performs ONE AI turn, executes whatever tools the
 * model asked for (possibly several in a single turn), and returns the
 * step result. The renderer issues another `chat:step` (with the previous
 * step appended to `scratchpad`) until `done: true`. Cancel = stop calling.
 * See public/chat/chatAssistant.js for the tool catalogue.
 */
ipcMain.handle('chat:step', async (_event, {
  message,
  history = [],
  scratchpad = [],
  activeContext = null,
  provider = null,
  agentMode = 'main',
  workflowSession = null,
  triggerPlanWorkflowBuild = null,
  targetNode = null,
  isNewChat = false,
} = {}) => {
  try {
    const helpers = await buildSkillHelpers();
    return await chatAssistant.runStep({
      message,
      history,
      scratchpad,
      activeContext,
      provider,
      agentMode,
      workflowSession,
      triggerPlanWorkflowBuild,
      targetNode,
      // Makes the main prompt ask for a chat title with this turn's answer; it
      // comes back as `chatTitle`. See chatTitleSection in chat/prompts.js.
      isNewChat,
      getDb,
      helpers,
    });
  } catch (err) {
    console.error('[chat:step]', err);
    // A turn cut off by the output limit is resumable — pass the system prompt,
    // chat history and partial output back so the UI can offer "Continue" and
    // finish it through ai:continue.
    if (err && err.code === 'MAX_TOKENS') {
      return { success: false, message: err.message, code: 'MAX_TOKENS', resume: err.resume || null };
    }
    return { success: false, message: err.message };
  }
});

/**
 * chat:run-approved-javascript — execute AI-generated code the USER approved.
 *
 * run_javascript only ever generates and parks a function; this is the one
 * path that runs it, and it exists solely to be called from the renderer's
 * Approve button. The model cannot reach it — it is not a tool.
 */
ipcMain.handle('chat:run-approved-javascript', async (_event, { runToken, provider = null } = {}) => {
  try {
    if (!runToken) return { success: false, message: 'runToken is required' };
    const helpers = await buildSkillHelpers();
    const result = await chatAssistant.runApprovedJavascript({ runToken, helpers, provider });
    return { success: true, result };
  } catch (err) {
    console.error('[chat:run-approved-javascript]', err);
    return { success: false, message: err.message };
  }
});

/**
 * presentation:export-pdf — print the open presentation to a PDF the user
 * chooses. The renderer's print stylesheet hides everything but the
 * presentation, so printing the whole window yields just the dashboard.
 */
ipcMain.handle('presentation:export-pdf', async (event, { title = 'Presentation' } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safeName = String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'Presentation';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export presentation as PDF',
      defaultPath: `${safeName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    const pdf = await event.sender.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    await fs.promises.writeFile(filePath, pdf);
    return { success: true, filePath };
  } catch (err) {
    console.error('[presentation:export-pdf]', err);
    return { success: false, message: err.message };
  }
});

/**
 * chat:discard-javascript — drop a parked function the user declined, so the
 * code and the source rows it captured don't sit in memory until they age out.
 */
ipcMain.handle('chat:discard-javascript', async (_event, { runToken } = {}) => {
  try {
    return { success: true, discarded: chatAssistant.discardPendingJavascript(runToken) };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * ai:continue — the one place a cut-off answer gets finished.
 *
 * Every truncation hands back a `resume` payload (system prompt, chat history,
 * original prompt, partial output). `resume.kind` says what the finished text
 * has to become before it's useful to the caller:
 *
 *   undefined  plain text  → the chat shows the joined answer
 *   'plan'     a workflow plan envelope → re-validated into a plan card
 *   'build'    one AI call inside a build → parsed and returned as
 *              `resumedCall`, which the renderer parks on
 *              plan.resumedCalls[stepIndex] so the re-run skips straight to it
 *
 * If the continuation is itself cut off, a fresh `resume` comes back carrying
 * everything produced so far — plus this payload's own kind/context — so
 * Continue can be pressed again.
 */
ipcMain.handle('ai:continue', async (_event, { resume = null } = {}) => {
  try {
    if (!resume || !resume.partialText) {
      return { success: false, message: 'Nothing to continue — no partial output was captured.' };
    }
    const apiKeys = loadApiKeys();
    if (!apiKeys) {
      return { success: false, message: 'No API keys configured. Set one up in settings.' };
    }

    const text = await aiProviders.continueAI(resume, { apiKeys });

    if (resume.kind === 'plan') {
      const helpers = await buildSkillHelpers();
      let workflow = null;
      if (resume.workflowId) {
        const wfDb = getDb('workflows');
        workflow = await wfDb.findOneAsync({ $or: [{ id: resume.workflowId }, { _id: resume.workflowId }] });
      }
      const plan = workflowBuilder.finalizePlanText({
        text, mode: resume.mode, workflow, helpers, userRequest: resume.userRequest || '',
      });
      if (plan.action === 'plan') {
        return {
          success: true,
          workflowPlan: plan,
          message: `Here's the plan I'd build (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}). Accept to apply it, or Cancel.`,
        };
      }
      if (plan.action === 'ask_questions') {
        return { success: true, message: plan.followUpQuestion, clarification: true };
      }
      return { success: false, message: `I couldn't produce a valid workflow plan: ${plan.message}` };
    }

    if (resume.kind === 'validation') {
      const wfDb = getDb('workflows');
      const workflow = await wfDb.findOneAsync({ $or: [{ id: resume.workflowId }, { _id: resume.workflowId }] });
      if (!workflow) return { success: false, message: `Workflow not found: ${resume.workflowId}` };
      const helpers = await buildSkillHelpers();
      // Re-enter the author loop with the finished turn: the scratchpad replays
      // what was already investigated, and `resumedTurn` stands in for the call
      // that ran out of room, so nothing before it is paid for twice.
      const gen = await chatAssistant.generateValidationFunction({
        workflow,
        helpers,
        getDb,
        scratchpad: pendingValidationScratchpads.get(String(resume.workflowId)) || [],
        resumedTurn: text,
      });
      pendingValidationScratchpads.delete(String(resume.workflowId));
      return {
        success: true,
        outputValidation: await persistOutputValidation(workflow, gen),
        message: 'Validation function generated.',
      };
    }

    if (resume.kind === 'build') {
      let value = text;
      if (resume.format !== 'text') {
        // JSON calls feed a parsed object straight into the builder, so the
        // build can only resume once the joined text actually parses —
        // otherwise the same call would just fail again on re-entry.
        value = workflowBuilder.parseBuilderJson(text);
        if (!value) {
          return { success: false, message: 'The continued response still is not valid JSON. Raise Max Tokens in Settings → AI Provider and rebuild.' };
        }
      }
      return {
        success: true,
        stepIndex: resume.stepIndex ?? null,
        resumedCall: { stage: resume.stage || null, value },
      };
    }

    return { success: true, text };
  } catch (err) {
    console.error('[ai:continue]', err);
    if (err && err.code === 'MAX_TOKENS') {
      // Cut off again. Keep any investigation the re-entered run added, then
      // carry this payload's kind/context onto the extended partial so another
      // Continue lands in the same branch above.
      if (resume.kind === 'validation' && err.scratchpad) {
        pendingValidationScratchpads.set(String(resume.workflowId), err.scratchpad);
      }
      const next = err.resume ? { ...resume, ...err.resume } : null;
      return { success: false, message: err.message, code: 'MAX_TOKENS', resume: next };
    }
    return { success: false, message: err.message };
  }
});

// NOTE: there is no chat:generateTitle handler any more. A conversation is
// named by the main agent on its first turn, as a field of that turn's answer
// (chatTitleSection in chat/prompts.js) — one call instead of two, and one
// place the naming rules live. chat:step returns it as `chatTitle`.

/**
 * Tell the renderer a build stopped before it finished — paused on a question
 * the user has to answer, or failed outright. executeBuild only emits progress
 * while it is running, so without this its last word on a paused build is a
 * step that started and never ended: the live canvas would keep a node glowing
 * as though work were still going on. Best-effort, like every progress send.
 *
 * @param {object} event   the IPC event whose sender started the build
 * @param {Error}  err     the error that ended it (carries buildWorkflowId)
 * @param {'paused'|'failed'} phase
 */
function emitBuildStopped(event, err, phase) {
  try {
    if (event.sender.isDestroyed()) return;
    event.sender.send('workflow:buildProgress', {
      phase,
      workflowId: err?.buildWorkflowId || null,
      nodeId: err?.pausedNodeId || null,
      stepIndex: Number.isInteger(err?.stepIndex) ? err.stepIndex : null,
      question: err?.question || '',
      message: err?.message || '',
    });
  } catch (_) { /* best-effort */ }
}

/**
 * workflow:executeBuild — apply a previously-returned workflow plan directly,
 * bypassing the chat agent. Wired from the renderer's "Accept plan" button so
 * the user's click goes straight to workflowBuilder.executeBuild without
 * round-tripping a "Confirm build" text turn through the AI.
 */
ipcMain.handle('workflow:executeBuild', async (event, { plan } = {}) => {
  try {
    if (!plan || !Array.isArray(plan.steps)) {
      return { success: false, message: 'plan with steps[] is required' };
    }
    const helpers = await buildSkillHelpers();
    const wfId = plan.workflowId;
    let workflow = null;
    if (plan.mode === 'modify' && wfId) {
      const wfDb = getDb('workflows');
      workflow = await wfDb.findOneAsync({ $or: [{ id: wfId }, { _id: wfId }] });
    }
    // Stream per-step build progress to the renderer that initiated the build
    // so the chat can show a live build log. Guard the send: the window may be
    // gone mid-build, and progress must never break the build itself.
    const onProgress = (evt) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send('workflow:buildProgress', evt);
      } catch (_) { /* best-effort */ }
    };
    const result = await workflowBuilder.executeBuild({ plan, workflow, helpers, getDb, onProgress });
    return {
      success: true,
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      workflowDescription: result.workflowDescription || '',
      mode: plan.mode || 'new',
      nodeCount: result.nodes.length,
      edgeCount: result.edges.length,
      warnings: result.warnings,
    };
  } catch (err) {
    // A builder asking the user for more info isn't really an error — pass
    // it through as a structured response so the renderer can prompt the
    // user and retry with plan.clarifications appended.
    if (err && err.isClarificationNeeded) {
      // Tell the canvas the build has stopped and why. Without this the node
      // it paused on keeps its "building" glow while nothing is happening,
      // and the preview looks like a live build the user can interact with.
      emitBuildStopped(event, err, 'paused');
      return {
        success: false,
        needsClarification: true,
        question: err.question,
        stepIndex: err.stepIndex,
        stepType: err.stepType || null,
        kind: err.context?.kind || null,
        // The id this attempt built under. The renderer hands it back on the
        // retry so every attempt at one plan shares a workflow id.
        buildWorkflowId: err.buildWorkflowId || null,
        // Set when the question came from a SKILL: { skillId, state, question,
        // rounds }. The renderer parks it on plan.pendingSkills[stepIndex] so the
        // resumed build continues that skill dialog instead of restarting it.
        pendingSkill: err.context?.skill || null,
        // Set when the build paused for the user to APPROVE generated code
        // before it runs (ApprovalNeeded): what to show on the Run / Don't run
        // card, and the calls to replay so the approved code is what runs.
        approval: err.isApprovalNeeded ? (err.context?.approval || null) : null,
        // Nodes already built this pass — the renderer passes them back so the
        // resumed build skips them instead of rebuilding from step 0.
        builtSteps: err.builtSteps || null,
      };
    }
    // A step's AI call ran out of output room. Like a clarification, this is a
    // pause rather than a failure: hand back the steps already built plus the
    // payload needed to finish that one call, so Continue resumes right there.
    if (err && err.code === 'MAX_TOKENS') {
      console.warn('[workflow:executeBuild] truncated at step', err.stepIndex, err.resumeStage);
      emitBuildStopped(event, err, 'paused');
      return {
        success: false,
        code: 'MAX_TOKENS',
        message: err.message,
        stepIndex: err.stepIndex ?? null,
        stepType: err.stepType || null,
        builtSteps: err.builtSteps || null,
        buildWorkflowId: err.buildWorkflowId || null,
        // Everything ai:continue needs, in one payload: kind routes it to the
        // build branch, stage says which call inside the step stalled.
        resume: err.resume
          ? {
              ...err.resume,
              kind: 'build',
              stage: err.resumeStage || null,
              // 'json' calls must parse before the build can resume; 'text'
              // calls (skill turns) are replayed verbatim.
              format: err.resumeFormat || 'json',
              stepIndex: err.stepIndex ?? null,
            }
          : null,
      };
    }
    console.error('[workflow:executeBuild]', err);
    emitBuildStopped(event, err, 'failed');
    return {
      success: false,
      message: err.message,
      // Surface the raw AI reply when it wasn't valid JSON, so the renderer can
      // show it in an expandable "raw response" node.
      ...(err.invalidJson ? { invalidJson: true, rawResponse: err.rawResponse || '' } : {}),
    };
  }
});

/**
 * workflow:generateValidation — author (or re-author) a workflow's output-
 * validation function via chatAssistant.generateValidationFunction, then persist
 * it onto the workflow doc. Wired from the save-screen "Generate validation"
 * button. Streams progress on the shared workflow:buildProgress channel.
 */
// Investigation done by a validation-author run that stopped at the output
// limit, keyed by workflow id. Kept main-side so the (potentially large, and
// tool-result-bearing) scratchpad never has to survive an IPC round trip — the
// renderer only carries the small resume payload. Cleared once the run lands.
const pendingValidationScratchpads = new Map();

// Persist an authored validation onto its workflow. Shared by the initial run
// and the Continue path so both write exactly the same record.
async function persistOutputValidation(workflow, gen) {
  const wfDb = getDb('workflows');
  const outputValidation = {
    enabled: true,
    goal: gen.goal,
    validationFunction: gen.validationFunction,
    explanation: gen.explanation,
    generatedAt: new Date().toISOString(),
    signature: chatAssistant.workflowSignature(workflow),
  };
  await wfDb.updateAsync(
    { $or: [{ id: workflow.id || workflow._id }, { _id: workflow._id || workflow.id }] },
    { $set: { outputValidation, updatedAt: new Date().toISOString() } },
    {},
  );
  return outputValidation;
}

ipcMain.handle('workflow:generateValidation', async (event, { workflowId } = {}) => {
  try {
    if (!workflowId) return { success: false, message: 'workflowId is required' };
    const wfDb = getDb('workflows');
    const workflow = await wfDb.findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
    if (!workflow) return { success: false, message: `Workflow not found: ${workflowId}` };

    const helpers = await buildSkillHelpers();
    const onProgress = (evt) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send('workflow:buildProgress', evt);
      } catch (_) { /* best-effort */ }
    };
    const gen = await chatAssistant.generateValidationFunction({ workflow, helpers, getDb, onProgress });

    pendingValidationScratchpads.delete(String(workflowId));
    return { success: true, outputValidation: await persistOutputValidation(workflow, gen) };
  } catch (err) {
    // Out of output room mid-authoring: park the investigation and hand back a
    // resume payload so the editor can offer Continue.
    if (err && err.code === 'MAX_TOKENS' && err.resume) {
      pendingValidationScratchpads.set(String(workflowId), err.scratchpad || []);
      return {
        success: false,
        code: 'MAX_TOKENS',
        message: err.message,
        resume: { ...err.resume, kind: 'validation', workflowId: String(workflowId) },
      };
    }
    console.error('[workflow:generateValidation]', err);
    return { success: false, message: err.message };
  }
});

/**
 * workflow:validateChange — review a just-applied change before it runs.
 *
 * Called from the chat after a workflow is created, after one is modified, and
 * after a single node is rebuilt. Answers "does this pipeline actually do what
 * the user asked for?" using the slimmed workflow plus the conversation that
 * produced it, and — when the workflow carries an output-validation function —
 * whether that function has drifted from the edited pipeline.
 *
 * `pendingNode` overlays a node config the renderer has applied but not yet
 * persisted, so a node edit is reviewed as the user sees it rather than against
 * a stale document.
 */
ipcMain.handle('workflow:validateChange', async (_event, {
  workflowId, change = {}, chatHistory = [], priorActions = [], pendingNode = null, fixRounds = 0,
} = {}) => {
  try {
    if (!workflowId) return { success: false, message: 'workflowId is required' };
    const wfDb = getDb('workflows');
    const workflow = await wfDb.findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
    if (!workflow) return { success: false, message: `Workflow not found: ${workflowId}` };

    // Overlay the in-flight node config (applied in the editor, not yet saved).
    let reviewed = workflow;
    if (pendingNode && pendingNode.nodeId && pendingNode.config) {
      const nodes = workflow.nodes || [];
      const found = nodes.some((n) => n.id === pendingNode.nodeId);
      reviewed = {
        ...workflow,
        nodes: found
          ? nodes.map((n) => (
            n.id === pendingNode.nodeId
              // REPLACES the saved config, never merges onto it. The renderer
              // only sends pendingNode for a FINISHED build (a partial chat
              // commit is not reviewed), so this is a whole config — and
              // reviewing it spread over the previous run's fields means
              // judging a node that exists nowhere: the reviewer passed a
              // BigQuery transformer whose targetSql was still the local
              // DuckDB SELECT it had inherited. Same rule the canvas applies.
              ? { ...n, data: { ...(n.data || {}), config: { ...pendingNode.config } } }
              : n
          ))
          // A node added on the canvas and configured from chat has never been
          // saved, so there is nothing to overlay onto. Appending it is the
          // whole point of pendingNode: reviewing against a document that does
          // not contain the node under review can only ever report it missing.
          : [...nodes, {
            id: pendingNode.nodeId,
            type: pendingNode.nodeType || pendingNode.config.nodeType || 'transformer',
            data: { label: pendingNode.label || pendingNode.nodeId, config: pendingNode.config },
          }],
      };
    }

    // A single-node rebuild writes one node and stops, so every node reading it
    // still describes the OLD output shape. Refresh that here, before the
    // review, so the reviewer judges the workflow as it now stands — and so a
    // downstream node is never left claiming an input its parent no longer
    // produces. A plan build needs none of this: executeBuild already resolves
    // each step's upstream from the nodes it just built.
    let impactedDownstream = [];
    if (change.kind === 'node' && Array.isArray(change.nodeIds) && change.nodeIds.length === 1) {
      const rebuiltId = change.nodeIds[0];
      const rebuiltCfg = (reviewed.nodes || [])
        .find((n) => n.id === rebuiltId)?.data?.config || null;
      const { nodes, impacted } = workflowBuilder.propagateSourceSchema(reviewed, rebuiltId, rebuiltCfg);
      impactedDownstream = impacted;
      if (nodes !== reviewed.nodes) {
        reviewed = { ...reviewed, nodes };
        // Persist the refreshed inputs. Only the source-shape fields moved; the
        // children's own logic is untouched.
        await wfDb.updateAsync(
          { $or: [{ id: workflow.id || workflowId }, { _id: workflow._id || workflowId }] },
          { $set: { nodes, updatedAt: new Date().toISOString() } },
          {},
        );
      }
    }

    const helpers = await buildSkillHelpers();
    const review = await chatAssistant.validateWorkflowChange({
      workflow: reviewed, helpers, change, chatHistory, priorActions, fixRounds, impactedDownstream,
    });

    // Only meaningful once a validation function exists; checkValidationDrift
    // short-circuits (no AI call) when the structure signature is unchanged.
    let drift = { drifted: false, reason: '' };
    if (reviewed.outputValidation && reviewed.outputValidation.enabled) {
      drift = await chatAssistant.checkValidationDrift({ workflow: reviewed, helpers });
    }

    // The workflow's identity travels with the verdict. A review that finds a
    // problem is offered back to the user as a fix, and that fix has to name
    // the workflow it applies to — both so the user can see which one they are
    // agreeing to change, and so the agent is told the target outright instead
    // of inferring it from whatever the chat happens to be discussing.
    return {
      success: true,
      workflowId: workflow.id || workflow._id || workflowId,
      workflowName: workflow.name || null,
      // Which nodes downstream now read a different shape. The chat lists them
      // so the user can see what the rebuild moved, and the reviewer's
      // remediation covers them.
      impactedDownstream,
      ...review,
      drift,
    };
  } catch (err) {
    console.error('[workflow:validateChange]', err);
    // Never block the user's work on a failed review.
    return {
      success: true,
      valid: true,
      inconclusive: true,
      reason: `Could not review the change: ${err.message}`,
      issues: [],
      remediation: [],
      drift: { drifted: false, reason: '' },
    };
  }
});

/**
 * workflow:checkValidationDrift — lightweight check (one AI call, skipped when
 * structure is unchanged) of whether an edited workflow has drifted from the
 * goal its saved validation function was written for. Called on save from the
 * editor. `workflow` is the in-progress edited doc (may be unsaved).
 */
ipcMain.handle('workflow:checkValidationDrift', async (_event, { workflow } = {}) => {
  try {
    if (!workflow) return { drifted: false, reason: '' };
    const helpers = await buildSkillHelpers();
    return await chatAssistant.checkValidationDrift({ workflow, helpers });
  } catch (err) {
    console.error('[workflow:checkValidationDrift]', err);
    return { drifted: false, reason: '' };
  }
});

// ---------------------------------------------------------------------------
// Analytics opt-in control. The renderer pushes the current value at startup
// (App.js) and whenever the user toggles it (PrivacySettings / Terms).
// ---------------------------------------------------------------------------

ipcMain.handle('analytics:set-opt-in', async (_event, { optIn } = {}) => {
  try {
    analytics.setOptIn(!!optIn);
    return { success: true, optIn: analytics.getOptIn() };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------------------------------------------------------------------------
// Skill helpers — a single bundle of injectables given to skills via params,
// so a skill never has to require anything outside its own directory or
// node_modules.
// ---------------------------------------------------------------------------

/**
 * Look up a saved connection by name or id from a connections array.
 * Accepts either a string (id/name) or a connection-shaped object —
 * callers like helpers.getTables/runQuery often pass the full connection
 * object they already hold, and we want that to round-trip cleanly
 * instead of stringifying to "[object Object]".
 */
function findConnection(connections, ref) {
  if (!ref) return null;
  if (typeof ref === 'object') {
    const id = ref.id || ref._id;
    if (id) {
      const byId = connections.find((c) => (c.id || c._id) === id);
      if (byId) return byId;
    }
    if (ref.name) {
      const byName = connections.find((c) => c.name === ref.name);
      if (byName) return byName;
    }
    return null;
  }
  return (
    connections.find((c) => (c.id || c._id) === ref) ||
    connections.find((c) => c.name === ref) ||
    null
  );
}

async function loadConnectionsFromDb() {
  try {
    const db = getDb('connections');
    return await db.findAsync({});
  } catch (e) {
    console.warn('[skill helpers] Could not load connections:', e.message);
    return [];
  }
}

/**
 * Build the helper bundle injected into every skill IPC call. The skill (and
 * any AI-generated function it runs) only needs these helpers — never an
 * import that reaches across plugin folders or into the renderer source.
 */
/**
 * @param {string|null} [defaultDbPath] - Optional fallback for local file
 *   connections (duckdb / sqlite / lancedb). When a runQuery / getTables /
 *   getColumns call passes its own `dbPath`, that wins. When neither is
 *   provided, the call is treated as a saved-connection lookup.
 */
async function buildSkillHelpers(defaultDbPath = null) {
  const apiKeys = loadApiKeys() || {};
  const connections = await loadConnectionsFromDb();

  const LOCAL_DB_TYPES = new Set(['duckdb', 'sqlite', 'lancedb']);
  const localLib = (dbType) => {
    if (dbType === 'duckdb')  return localDuckDB;
    if (dbType === 'sqlite')  return localSQLite;
    if (dbType === 'lancedb') return vectorLanceDB;
    return null;
  };

  /**
   * Decide whether a call should be served by a local lib (returns
   * { dbType, dbPath, lib }) or by a saved-connection lookup (returns null).
   *
   * Routing rule: local iff a dbPath is available (per-call or default) AND
   * `connection` identifies one of the local dbTypes — either a string name
   * matching duckdb/sqlite/lancedb, or an object that carries a matching
   * `dbType`.
   */
  /**
   * Local stores are addressed by dbType ('sqlite'), but the app itself refers
   * to them two other ways: the config token a node stores as its destination
   * (`local-duckdb`) and the display name it generates (`Local file`). Both
   * appear in node configs, so AI-authored code reaches for them and lands in
   * the saved-connection lookup, which fails with "Connection not found:
   * Local SQLite". Treat them as what they are — the same local store.
   * Anything else still falls through to the saved-connection path.
   */
  const localDbTypeFromAlias = (value) => {
    if (typeof value !== 'string') return null;
    const key = value.trim().toLowerCase().replace(/^local[-\s]+/, '');
    return LOCAL_DB_TYPES.has(key) ? key : null;
  };

  const resolveLocal = (connection, perCallDbPath) => {
    const dbPath = perCallDbPath || defaultDbPath;
    if (!dbPath) return null;
    let dbType = null;
    if (typeof connection === 'string') {
      dbType = localDbTypeFromAlias(connection);
    } else if (connection && typeof connection === 'object' && LOCAL_DB_TYPES.has(connection.dbType)) {
      dbType = connection.dbType;
    }
    if (!dbType) return null;
    return { dbType, dbPath, lib: localLib(dbType) };
  };

  /**
   * Route a RESOLVED saved-connection record (looked up by name/id) to the
   * local lib when its dbType is a local builtin (duckdb / sqlite / lancedb).
   *
   * This is the path the chat assistant and headless workflow builder hit:
   * they pass a connection id/name (not a bare dbType + dbPath), so
   * resolveLocal can't catch them. Without this, an imported-file connection
   * would fall through to pluginManager.getConnector(dbType) — which has no
   * connector registered for the local stores — and throw "No connector
   * registered for dbType: sqlite". Imported CSV/Excel files all live in the
   * shared app SQLite db (fileInfo.filePath === appSqliteDbPath) and own a
   * specific set of tables (fileInfo.tables); direct .sqlite/.db/.lancedb
   * files carry their own path.
   */
  const resolveLocalConnection = (conn) => {
    if (!conn || !LOCAL_DB_TYPES.has(conn.dbType)) return null;
    const dbPath = conn.fileInfo?.filePath
      || conn.localPath
      || conn.dbConfig?.dbPath
      || (conn.dbType === 'sqlite' ? appSqliteDbPath : null);
    if (!dbPath) return null;
    const ownTables = Array.isArray(conn.fileInfo?.tables) && conn.fileInfo.tables.length
      ? conn.fileInfo.tables.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
      : null;
    return { dbType: conn.dbType, dbPath, lib: localLib(conn.dbType), ownTables };
  };

  const requireConnection = (ref) => {
    const conn = findConnection(connections, ref);
    if (!conn) {
      const names = connections.map((c) => c.name).join(', ');
      // Print a readable label whether ref is a string, an object, or null.
      const label = typeof ref === 'object' && ref
        ? (ref.name || ref.id || ref._id || JSON.stringify(ref).slice(0, 80))
        : String(ref);
      throw new Error(`Connection not found: ${label}. Available: ${names || 'none'}`);
    }
    return conn;
  };

  const requireConnector = (conn) => {
    const connector = pluginManager.getConnector(conn.dbType);
    if (!connector) throw new Error(`No connector registered for dbType: ${conn.dbType}`);
    return connector;
  };

  /**
   * runQuery(connection, query, dbPath = null)
   *  - dbPath is non-null → local file (duckdb / sqlite / lancedb), connection
   *    is the dbType string ('duckdb' | 'sqlite' | 'lancedb')
   *  - dbPath is null     → saved connection looked up by name/id
   *
   * Replaces the old separate sqliteQuery / readFile / writeFile /
   * writeLanceDB helpers — every store is reachable through this one entry.
   */
  async function runQuery(connection, query, dbPath = null) {
    // The prompts teach `operation: 'queryVectors'` for a vector search, and
    // lib/lancedb.js accepts it as a synonym for 'query'. The connector-side
    // stores (Pinecone) never got that synonym, so the same generated function
    // worked against LanceDB and threw "Unknown operation" against Pinecone.
    // Normalise here, the one entry point all three branches share, so already
    // saved workflows keep working whichever store they point at.
    if (query && typeof query === 'object' && query.operation === 'queryVectors') {
      query = { ...query, operation: 'query' };
    }
    const local = resolveLocal(connection, dbPath);
    if (local) {
      const queryObj = (query && typeof query === 'object') ? query : { query };
      return local.lib.runQuery({ ...queryObj, dbPath: local.dbPath });
    }
    const conn = requireConnection(connection);
    const localConn = resolveLocalConnection(conn);
    if (localConn) {
      const queryObj = (query && typeof query === 'object') ? query : { query };
      return localConn.lib.runQuery({ ...queryObj, dbPath: localConn.dbPath });
    }
    const connector = requireConnector(conn);
    const id = conn.id || conn._id;
    const fullConfig = await getFullConfig(id, conn.dbConfig || {});
    // No injected limit.
    //
    // A skill is handed its source as ONE array — that is the contract its
    // function signature is written against, and it is not being changed — but
    // "all of it" and "the first million rows of it" are different things. This
    // used to stamp `limit: 1000000` onto every query a skill made, so a
    // JavaScript or Python transform over a larger source silently operated on
    // a truncated copy and reported a clean result. A caller that genuinely
    // wants fewer rows still says so in its own query object.
    const queryObj = typeof query === 'string' ? { query } : { ...query };
    const result = await connector.runQuery(fullConfig, id, queryObj);
    if (result && result.success === false) throw new Error(result.message || 'runQuery failed');
    return result.rows || result.data || [];
  }

  /**
   * The tables a local store holds right now, read from the store itself.
   *
   * Each local dbType needs a different question asked. duckdb is the awkward
   * one: it has no catalog to list because a data-file connection is registered
   * by PATH — the file IS the catalog — so its module exposes no getTables at
   * all. A .duckdb/.sqlite database file reached through the same dbType does
   * have a catalog, and `isReadable` (true for csv/json/parquet/xlsx/avro,
   * false for database files) is what tells the two apart.
   *
   * Returns [] rather than throwing when a store cannot answer, so callers fall
   * back to what the connection recorded instead of failing outright.
   */
  const liveLocalTables = async ({ dbType, dbPath, lib }) => {
    if (!dbPath) return [];
    if (dbType === 'duckdb') {
      const duck = require('./duckdb');
      if (duck.isReadable(dbPath)) return listFileTables(dbPath);
      return await duck.tablesAt(dbPath);
    }
    if (typeof lib?.getTables !== 'function') return [];
    return await lib.getTables({ dbPath });
  };

  async function getTables(connection, dbPath = null) {
    const local = resolveLocal(connection, dbPath);
    // Through liveLocalTables rather than lib.getTables directly: the duckdb
    // module has no getTables, so this branch threw a TypeError for every
    // by-path duckdb call ("local-duckdb", a workflow's own .duckdb).
    if (local) return await liveLocalTables(local);
    const conn = requireConnection(connection);
    const localConn = resolveLocalConnection(conn);
    if (localConn) {
      // `fileInfo.tables` is a SNAPSHOT taken when the connection was created.
      // Read the store FIRST so a file that changed since then — a sheet added
      // to a workbook, a table added to or dropped from a LanceDB directory —
      // reports what it actually holds, and treat the snapshot as the fallback
      // for stores that cannot answer.
      //
      // One store must NOT be read this way: imported CSV/Excel files and Google
      // Sheets share the app-wide SQLite database, so its table list is every
      // connection's tables, not this one's. There the recorded set is not a
      // stale cache but the ownership SCOPE, and going live would hand callers
      // (and the assistant) unrelated connections' data.
      const sharesAppDb = localConn.dbPath === appSqliteDbPath;
      if (!sharesAppDb) {
        try {
          const live = await liveLocalTables(localConn);
          if (live && live.length) return live;
        } catch (err) {
          console.warn(`[getTables] live listing failed for "${conn.name}" (${localConn.dbPath}): ${err.message}`);
        }
      }
      if (localConn.ownTables) return localConn.ownTables;
      // Nothing recorded, so there is no scope to honour: list whatever the
      // store holds, exactly as before. This is the direct-file case (a .sqlite
      // or .duckdb the user picked owns everything in it), and also the only
      // sane answer for an unscoped connection on the app-wide db.
      return await liveLocalTables(localConn);
    }
    const connector = requireConnector(conn);
    const id = conn.id || conn._id;
    const fullConfig = await getFullConfig(id, conn.dbConfig || {});
    const result = await connector.getTables(fullConfig, id);
    // A connector reports failure by RETURNING { success: false } — it does not
    // throw. Returning `result.tables || []` for that made a suspended
    // warehouse, an expired token or a network blip indistinguishable from a
    // database that genuinely holds no tables, and the caller acted on the
    // second reading: a data source node was rewritten with no table at all and
    // reported as saved. Same shape runQuery already uses.
    if (result && result.success === false) {
      throw new Error(`Could not list tables on "${conn.name}": ${result.message || 'unknown error'}`);
    }
    return result.tables || [];
  }

  async function getColumns(connection, table, schema = null, dbPath = null) {
    const local = resolveLocal(connection, dbPath);
    if (local) return local.lib.getColumns({ dbPath: local.dbPath, table });
    const conn = requireConnection(connection);
    const localConn = resolveLocalConnection(conn);
    if (localConn) {
      const t = table || (localConn.ownTables && localConn.ownTables[0]) || null;
      return localConn.lib.getColumns({ dbPath: localConn.dbPath, table: t });
    }
    const connector = requireConnector(conn);
    const id = conn.id || conn._id;
    const fullConfig = await getFullConfig(id, conn.dbConfig || {});
    const result = await connector.getColumns(fullConfig, id, schema, table);
    // Same reasoning as getTables above: a failed lookup must not read as "this
    // table has no columns".
    if (result && result.success === false) {
      throw new Error(`Could not read columns of "${table}" on "${conn.name}": ${result.message || 'unknown error'}`);
    }
    return result.columns || [];
  }

  /** Call AI from inside a skill or from generated code. Routes through aiProviders. */
  async function callAI(prompt, options = {}) {
    // Honor the user's saved "Default AI Provider" (and its model) when the
    // caller didn't specify them.
    const merged = withPersistedAiDefaults(options);
    return aiProviders.callAIWithKeys(prompt, { ...merged, apiKeys });
  }

  /**
   * Native tool-calling variant for agent loops: takes neutral turns + tool
   * schemas, returns structured tool calls. Only for providers with a real tool
   * API — check aiSupportsTools first; this throws for the rest.
   */
  async function callAITools(options = {}) {
    const merged = withPersistedAiDefaults(options);
    return aiProviders.callAIToolsWithKeys({ ...merged, apiKeys });
  }

  /**
   * Whether the provider that WOULD actually serve this call supports tools.
   * Resolves the same way callAITools does — through the user's saved default
   * and the configured keys — so a caller passing no provider gets an answer
   * about the provider it will really reach, not about undefined.
   */
  function aiSupportsTools(provider) {
    const merged = withPersistedAiDefaults(provider ? { provider } : {});
    const picked = aiProviders.pickProvider(apiKeys, merged.provider);
    return !!picked && aiProviders.providerSupportsTools(picked.provider);
  }

  /** Generate embeddings using the shared vector-embeddings library. */
  async function vectorize(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    // OpenAI is the only embedding provider.
    const provider = options.provider || 'openai';
    if (provider !== 'openai') throw new Error(`Unsupported embedding provider "${provider}". Only "openai" is supported.`);
    const apiKey = apiKeys.chatgpt || apiKeys.openai;
    if (!apiKey) throw new Error('No OpenAI API key is configured for embeddings. Add one in Settings.');
    const model = options.model || 'text-embedding-3-small';
    const data = texts.map((t, idx) => ({ __idx: idx, text: typeof t === 'string' ? t : String(t) }));
    const result = await vectorEmbeddings.generateEmbeddings({ data, columnToEmbed: 'text', provider, model, apiKey });
    return result.map((r) => r.vector);
  }

  return {
    apiKeys,                                   // raw map (read-only use; do NOT echo to renderer)
    aiProviders: aiProviders.listAvailableProviders(apiKeys),
    embeddingProviders: (apiKeys.chatgpt || apiKeys.openai) ? ['openai'] : [],
    connections,                               // [{ _id/id, name, dbType, dbCategory, dbConfig, ... }]
    getConnection: requireConnection,
    callAI,
    callAITools,
    aiSupportsTools,
    runQuery,
    getTables,
    getColumns,
    vectorize,
    axios,
    // Full vector-lib modules — exposed so skills like vector-db-executor can
    // use every export (estimateOpenAICost, listTables, ...) without having
    // to require across plugin directories.
    embeddings: vectorEmbeddings,
    lancedb: vectorLanceDB,
    // Cooperative stop, for the loops a skill runs itself. Injected for the
    // same reason the vector libs above are: a plugin has its own
    // node_modules and must not require across directories into public/.
    //
    // It works because skills are plain in-process require()s (see
    // pluginManager) — the AsyncLocalStorage context the runner opened around
    // this node is live when the skill calls it. Outside a run it is inert, so
    // a skill invoked from an ad-hoc IPC handler is unaffected.
    cancel: { throwIfCancelled, isCancelledError, isCancellationRequested },
    appSqliteDbPath,
    pluginManager,
    getFullConfig,
    // Start-node trigger registration, bound to executeWorkflowFromTrigger so
    // the headless workflow builder can register a CRON job / file watcher the
    // same way StartNodeChat.handleSave does in the renderer. Mirrors the
    // start-trigger:* IPC handlers.
    startTriggers: {
      registerCron:        (params) => registerCronJob(params, executeWorkflowFromTrigger),
      unregisterCron:      (params) => unregisterCronJob(params),
      registerFileWatch:   (params) => registerFileWatcher(params, executeWorkflowFromTrigger),
      unregisterFileWatch: (params) => unregisterFileWatcher(params),
    },
  };
}

/**
 * skills:getDescriptions — get skill descriptions for AI context
 * Returns { success, descriptions: [...] }
 */
ipcMain.handle('skills:getDescriptions', async (_event, category = null, context = {}) => {
  try {
    const descriptions = pluginManager.getSkillDescriptions(category, context);
    return { success: true, descriptions };
  } catch (err) {
    return { success: false, message: err.message, descriptions: [] };
  }
});

/**
 * skills:analyze — analyze a skill request and get follow-up questions or confirmation
 * Returns { success, action, followUpQuestion, questionsNeeded, skillParams, ... }
 */
ipcMain.handle('skills:analyze', async (_event, { skillId, params }) => {
  try {
    const result = await pluginManager.analyzeSkillRequest(skillId, params);
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * skills:buildPrompt — build skill prompt for AI
 * Returns { success, prompt, context }
 */
ipcMain.handle('skills:buildPrompt', async (_event, { skillId, params }) => {
  try {
    params.helpers = await buildSkillHelpers();

    // Backward compatibility for vector-db-executor (kept until it migrates to helpers).
    if (skillId === 'vector-db-executor') {
      params.apiKeys = params.helpers.apiKeys;
      params.vectorConnectors = pluginManager.listConnectors()
        .filter((c) => c.dbCategory === 'Vector')
        .map((c) => ({ id: c.id, name: c.name }));
      params.pluginManager = pluginManager;
      params.getFullConfig = getFullConfig;
    }

    const result = await pluginManager.buildSkillPrompt(skillId, params);
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * skills:processResponse — process AI response through skill
 * Returns { success, action, pythonCode, explanation, followUpQuestion, directAnswer, ... }
 */
ipcMain.handle('skills:processResponse', async (_event, { skillId, aiResponse, operationType, currentState = {}, availableConnections = [] }) => {
  try {
    const helpers = await buildSkillHelpers();
    const connections = availableConnections && availableConnections.length > 0
      ? availableConnections
      : helpers.connections;
    const result = await pluginManager.processSkillResponse(
      skillId,
      aiResponse,
      operationType,
      currentState,
      connections,
      helpers
    );
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message,
      action: 'ask_questions',
      followUpQuestion: `Error processing response: ${err.message}`
    };
  }
});

/**
 * skills:execute — execute a skill with given parameters
 * Returns { success, data, recordCount, ... }
 */
ipcMain.handle('skills:execute', async (_event, { skillId, params }) => {
  try {
    const helpers = await buildSkillHelpers();

    // Backward compatibility for vector-db-executor (kept until it migrates to helpers).
    let embeddingApiKey = params.embeddingApiKey;
    if (skillId === 'vector-db-executor' && !embeddingApiKey && params.embeddingProvider) {
      const apiKeys = helpers.apiKeys;
      if (params.embeddingProvider === 'openai') embeddingApiKey = apiKeys.chatgpt || apiKeys.openai;
    }

    const enhancedParams = {
      ...params,
      helpers,
      // Legacy keys still consumed by vector-db-executor; new skills should
      // read everything from `helpers`.
      embeddingApiKey: embeddingApiKey || params.embeddingApiKey,
      pluginManager,
      getFullConfig,
      appSqliteDbPath,
    };

    const result = await pluginManager.executeSkill(skillId, enhancedParams);
    return result;
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * skills:queryVectorPreview — get preview data from vector database
 * Returns { success, data, recordCount, isJson, storageType }
 */
ipcMain.handle('skills:queryVectorPreview', async (_event, params) => {
  try {
    const helpers = await buildSkillHelpers();
    const enhancedParams = {
      ...params,
      helpers,
      pluginManager,
      getFullConfig
    };

    const skill = pluginManager.getSkill('vector-db-executor');
    if (!skill || typeof skill.queryVectorPreview !== 'function') {
      return {
        success: false,
        message: 'Vector preview not available'
      };
    }

    const result = await skill.queryVectorPreview(enhancedParams);
    return result;
  } catch (err) {
    return {
      success: false,
      message: err.message,
      error: err.message
    };
  }
});

/**
 * Cloud Storage Handlers
 */

// Get containers/buckets from cloud storage
ipcMain.handle('cloud-storage:get-containers', async (_event, { connectionId, dbType }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    // Call plugin's getContainers method
    const result = await plugin.getContainers(fullConfig, connectionId);
    return result;
  } catch (error) {
    console.error('Get containers error:', error);
    return { success: false, message: error.message };
  }
});

// List objects in a cloud storage container
ipcMain.handle('cloud-storage:list-objects', async (_event, { connectionId, dbType, containerName, prefix = '', maxKeys = 100, continuationToken = null, searchTerm = '' }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    // Call plugin's listObjects method with pagination and search
    const result = await plugin.listObjects(
      fullConfig,
      connectionId,
      containerName,
      prefix,
      maxKeys,
      continuationToken,
      searchTerm
    );
    return result;
  } catch (error) {
    console.error('List objects error:', error);
    return { success: false, message: error.message };
  }
});

// Download object from cloud storage
ipcMain.handle('cloud-storage:download-object', async (_event, { connectionId, dbType, containerName, objectName }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    // Call plugin's downloadObject method
    const result = await plugin.downloadObject(fullConfig, connectionId, containerName, objectName);
    return result;
  } catch (error) {
    console.error('Download object error:', error);
    return { success: false, message: error.message };
  }
});

// Export Google Workspace file
ipcMain.handle('cloud-storage:export-object', async (_event, { connectionId, dbType, fileId, mimeType }) => {
  try {
    // Get full configuration with credentials
    const fullConfig = await getFullConfig(connectionId, {});

    // Get plugin
    const plugin = pluginManager.getConnector(dbType);
    if (!plugin) {
      return { success: false, message: 'Storage connector not found' };
    }

    if (typeof plugin.exportObject !== 'function') {
      return { success: false, message: 'Export not supported for this connector' };
    }

    // Call plugin's exportObject method
    const result = await plugin.exportObject(fullConfig, connectionId, fileId, mimeType);
    return result;
  } catch (error) {
    console.error('Export object error:', error);
    return { success: false, message: error.message };
  }
});

// Analyze Excel file for sheet names
ipcMain.handle('file-reader:analyze-excel', async (_event, fileData) => {
  try {
    const XLSX = require('xlsx');

    // Convert Buffer to workbook
    const workbook = XLSX.read(fileData, { type: 'buffer' });

    return {
      success: true,
      sheets: workbook.SheetNames
    };
  } catch (error) {
    console.error('Excel analysis error:', error);
    return {
      success: false,
      message: error.message,
      sheets: ['Sheet1'] // Fallback
    };
  }
});

// Get Google Picker credentials for frontend integration
ipcMain.handle('cloud-storage:get-picker-credentials', async (_event, { connectionId, dbType }) => {
  try {
    const connectionsDb = getDb('connections');
    const connections = await connectionsDb.findAsync({});
    const connection = connections.find(c => c.id === connectionId);

    if (!connection) {
      return { success: false, message: 'Connection not found' };
    }

    const fullConfig = await getFullConfig(connectionId, connection.dbConfig);

    if (!pluginManager.hasConnector(dbType)) {
      return { success: false, message: `Connector ${dbType} not found` };
    }

    const plugin = pluginManager.getConnector(dbType);

    if (typeof plugin.getPickerCredentials !== 'function') {
      return { success: false, message: 'Picker not supported for this connector' };
    }

    return await plugin.getPickerCredentials(fullConfig, connectionId);
  } catch (error) {
    console.error('[Picker Credentials] Error:', error);
    return { success: false, message: error.message };
  }
});

/**
 * cloud-storage:save-and-register — keep a cloud file, then treat it as local.
 *
 * The bytes are written to the path the user chose and handed to the same
 * registration a file picked off disk goes through, so from here on there is
 * nothing cloud-specific about it: DuckDB reads it in place, a workbook still
 * becomes a table per sheet, and an edit writes back into the file the user can
 * see in their own filesystem.
 *
 * This replaces importing a cloud file into the shared app SQLite database,
 * where it was a copy the user could neither find nor open.
 */
ipcMain.handle('cloud-storage:save-and-register', async (_event, { data, targetPath }) => {
  try {
    if (!targetPath) return { success: false, message: 'No save location was chosen' };

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, Buffer.from(data));

    const result = await registerLocalFile(targetPath, app.getPath('userData'));

    // A file that cannot be registered is not left lying around pretending to
    // be a data source — but only if we are the ones who just wrote it.
    if (!result.success) {
      try { fs.unlinkSync(targetPath); } catch (_err) { /* already gone */ }
      return result;
    }

    return { ...result, filePath: targetPath };
  } catch (error) {
    console.error('Cloud save-and-register error:', error);
    return { success: false, message: error.message || 'Failed to save the file' };
  }
});


// Unified NoSQL transformation handler (routes to the source's document-store connector)
ipcMain.handle('dbconn:transform-nosql', async (_event, params) => {
  return await nodeExecution.handleTransformNoSQL(params);
});

// SQL transformation handler (for PostgreSQL, MySQL, MSSQL, SQLite, CSV, Excel)
ipcMain.handle('dbconn:transform-sql', async (_event, params) => {
  return await nodeExecution.handleTransformSQL(params);
});

ipcMain.handle('dbconn:execute-join', async (_event, params) => {
  return await nodeExecution.handleExecuteJoin(params);
});

ipcMain.handle('dbconn:execute-branch', async (_event, params) => {
  return await nodeExecution.handleExecuteBranch(params);
});

/**
 * IPC: 'rest-api:execute-fetch'
 * Runs a REST API fetch plan authored on a DataSource node and materialises the
 * response locally. Decrypts credentials in the main process only; never
 * returns resolved URL/headers/body to the renderer.
 */
ipcMain.handle('rest-api:execute-fetch', async (_event, params) => {
  return await apiFetch.handleExecuteApiFetch(params);
});

/**
 * Execute Output Operation
 * Handles exporting data to local files or database connections
 */
ipcMain.handle('dbconn:execute-output', async (_event, sourceConnection, sourceTableSchema, outputSettings) => {
  const skillHelpers = await buildSkillHelpers();
  return await executeOutput(
    sourceConnection,
    sourceTableSchema,
    outputSettings,
    pluginManager,
    getFullConfig,
    getDb,
    skillHelpers
  );
});

// ---------------------------------------------------------------------------
// Workflow Execution
// ---------------------------------------------------------------------------

/**
 * Execute an entire workflow using executionSteps from the workflow
 * Logs each step to the executions collection
 */
/**
 * workflow:executeNode — run ONE node, exactly the way a full workflow run
 * would run it (same executeNode dispatch, same helpers bundle).
 *
 * This is what the chat assistant's "Run this node" button and the output
 * panel's Run button call. Upstream nodes are NOT run — the node reads whatever
 * its sources last produced, which is what makes the approval meaningful (the
 * user is agreeing to this one write, not a cascade).
 *
 * IT IS RECORDED AS AN EXECUTION, and that is a deliberate reversal.
 *
 * It used to run unrecorded, on the reasoning that nothing was scheduled and no
 * other node ran, so an executions row would misreport the workflow's history.
 * True as far as it went, and it cost the user the thing that matters more: an
 * unrecorded run is INVISIBLE and UNSTOPPABLE. The execution monitor lists rows
 * in the `executions` collection and `workflow:cancel` addresses a run by its
 * executionId — both of them, and there is no second channel. So a node run
 * from the chat or the output panel could not be seen while it worked and could
 * not be called off, and an output node writing 400k rows is precisely the run
 * a user most wants to stop.
 *
 * The history objection is answered by labelling rather than by hiding:
 * `singleNode: true` and `trigger.type: 'node'` mark these rows for any reader
 * that wants to tell one node's run apart from a whole workflow's.
 */
ipcMain.handle('workflow:executeNode', async (_event, { workflowId, nodeId, nodes, edges, approvedRebuilds = [] } = {}) => {
  if (!nodeId || !Array.isArray(nodes)) {
    return { success: false, message: 'nodeId and nodes are required.' };
  }

  const nodeMap = new Map();
  nodes.forEach((n) => nodeMap.set(n.id, n));
  const node = nodeMap.get(nodeId);
  if (!node) return { success: false, message: `Node ${nodeId} is not part of this workflow.` };

  const executionsDb = getDb('executions');
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = new Date().toISOString();
  const started = Date.now();

  // Same precedence the full runner uses: the name written on every save wins
  // over the creation-time type label.
  const nodeLabel = node.data?.config?.node_name || node.data?.label || node.id;

  // The monitor titles a run with `workflowName` and subtitles it with the step
  // in flight. For one node that reads best as "<workflow> · <node>", so the
  // workflow's real name is looked up when there is one to look up.
  let workflowName = null;
  if (workflowId) {
    try {
      const wf = await getDb('workflows').findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
      workflowName = wf?.name || null;
    } catch (_err) {
      // A name is presentation only — a run must not fail for want of one.
    }
  }

  const executionRecord = {
    executionId,
    workflowId: workflowId || null,
    workflowName: workflowName || nodeLabel,
    status: 'running',
    startTime,
    endTime: null,
    duration: null,
    currentNodeId: nodeId,
    currentNodeName: nodeLabel,
    totalSteps: 1,
    executionOrder: [nodeId],
    nodeExecutions: [],
    logs: [],
    results: { totalRecordsProcessed: 0, summary: '' },
    // What tells this row apart from a full run in any history view.
    singleNode: true,
    trigger: { type: 'node', user: 'local' },
    username: 'local',
    cancelRequested: false,
  };

  const logSink = createExecutionSink(executionsDb, executionId);

  try {
    await executionsDb.insertAsync(executionRecord);
    await addExecutionLog(executionsDb, executionId, 'info', `Running node: ${nodeLabel} (${node.type})`, nodeId);

    const helpers = {
      pluginManager,
      getFullConfig,
      getDb,
      appSqliteDbPath,
      buildSkillHelpers,
      workflowId,
      // Nodes whose kept target the user approved dropping and recreating for
      // this run (the "Run this node" card). See joinTargetRebuildGate.
      approvedRebuilds: Array.isArray(approvedRebuilds) ? approvedRebuilds : [],
    };

    let result = null;
    let stopped = false;
    let failure = null;

    try {
      // Both contexts, for the same reasons the full runner opens them: the log
      // context files everything the node calls under this node, and the
      // cancellation context is what lets a stop reach the chunk loops INSIDE
      // it rather than waiting for a step boundary that never comes — there is
      // only one step here, so without it a stop could not land at all.
      result = await runWithExecutionLog(logSink, nodeId, () =>
        runWithCancellation(() => isCancelRequested(executionId), () =>
          executeNode(node, nodeMap, edges || [], helpers)));
      await logSink.flush();

      // Same safety net as the full runner: a layer that swallowed the
      // cancellation and returned { success: false } would otherwise be
      // recorded as a failure, which is the worst reading of a stop the user
      // asked for.
      if (!result?.success && isCancelRequested(executionId)) {
        throw new ExecutionCancelledError(`"${nodeLabel}"`, result?.message || null);
      }
    } catch (err) {
      await logSink.flush();
      if (isCancelledError(err)) stopped = true;
      failure = err;
    }

    const duration = Date.now() - started;
    const succeeded = !stopped && !failure && !!result?.success;
    const status = stopped ? 'cancelled' : succeeded ? 'completed' : 'failed';
    const recordsProcessed = result?.recordsProcessed || 0;
    const message = stopped
      ? failure.message
      : failure
        ? (failure.message || 'Node execution failed.')
        : (result?.message || (succeeded ? 'Node executed successfully.' : 'Node execution failed.'));

    executionRecord.nodeExecutions = [{
      nodeId,
      nodeName: nodeLabel,
      nodeType: node.type,
      status,
      startTime,
      duration,
      error: succeeded ? null : { message },
      metrics: {
        recordsProcessed: succeeded ? recordsProcessed : 0,
        recordsSuccess: succeeded ? recordsProcessed : 0,
        recordsFailed: 0,
      },
    }];

    await addExecutionLog(
      executionsDb, executionId,
      stopped ? 'warn' : succeeded ? (result?.warning ? 'warn' : 'info') : 'error',
      `Node ${nodeLabel} ${stopped ? 'stopped' : succeeded ? 'completed' : 'failed'}: ${message}`,
      nodeId,
    );

    executionRecord.results = {
      totalRecordsProcessed: succeeded ? recordsProcessed : 0,
      summary: message,
    };

    await executionsDb.updateAsync(
      { executionId },
      {
        $set: {
          status,
          endTime: new Date().toISOString(),
          duration,
          // Nothing is in flight any more — the canvas stops pulsing this node.
          currentNodeId: null,
          currentNodeName: null,
          cancelRequested: false,
          nodeExecutions: executionRecord.nodeExecutions,
          results: executionRecord.results,
        },
      },
      {},
    );

    return {
      success: succeeded,
      cancelled: stopped,
      executionId,
      message,
      // Succeeded, but with something the caller needs to show differently — an
      // empty source, so the node wrote nothing. Dropping it here would leave a
      // run that wrote nothing looking exactly like one that wrote everything.
      warning: !!result?.warning,
      recordsProcessed: succeeded ? recordsProcessed : 0,
      duration,
      // Config the run learned and the node should now carry — a REST API
      // source's columns after its first approved fetch. The editor merges it
      // onto the node.
      configPatch: succeeded ? (result?.configPatch || null) : null,
    };
  } catch (err) {
    // The record itself could not be kept up to date — the run is over either
    // way, so close the row out rather than leaving it 'running' forever and
    // wedging the monitor open on a run nothing is doing.
    console.error('[workflow:executeNode]', err);
    try {
      await logSink.flush();
      await executionsDb.updateAsync(
        { executionId },
        {
          $set: {
            status: 'failed',
            endTime: new Date().toISOString(),
            duration: Date.now() - started,
            currentNodeId: null,
            currentNodeName: null,
            cancelRequested: false,
            results: { totalRecordsProcessed: 0, summary: err.message || String(err) },
          },
        },
        {},
      );
    } catch (_err) { /* the row may never have been inserted */ }
    return { success: false, executionId, message: err.message || String(err) };
  } finally {
    clearCancelRequest(executionId);
  }
});

// ---------------------------------------------------------------------------
// Stopping a run in flight
// ---------------------------------------------------------------------------

/**
 * Execution ids the user has asked to stop.
 *
 * Cancellation is COOPERATIVE and lands BETWEEN steps. A node in flight is a
 * connector call — a load job, a multi-statement insert, a driver cursor — and
 * there is no abort signal threaded through any of them; killing one mid-write
 * would leave a half-written destination table with nothing recording how far
 * it got. So the runner checks this set before each step: the node currently
 * executing finishes and is recorded, and the run stops before the next one.
 *
 * That is also why the UI says "stopping after the current step" rather than
 * pretending the button is immediate.
 */
const cancelRequests = new Set();

const isCancelRequested = (executionId) => cancelRequests.has(executionId);
const clearCancelRequest = (executionId) => cancelRequests.delete(executionId);

/**
 * workflow:cancel — ask a running execution to stop at its next step boundary.
 *
 * `cancelRequested` is written onto the execution row as well as held in
 * memory: the renderer polls that row (see executionMonitorStore) and it is the
 * only way the monitor can show "stopping…" on the run while the current node
 * is still working.
 */
ipcMain.handle('workflow:cancel', async (_event, { executionId } = {}) => {
  try {
    if (!executionId) return { success: false, message: 'executionId is required.' };

    const executionsDb = getDb('executions');
    const ex = await executionsDb.findOneAsync({ executionId });
    if (!ex) return { success: false, message: 'That execution no longer exists.' };
    if (ex.status !== 'running') {
      return { success: false, message: `This run has already ${ex.status === 'completed' ? 'finished' : ex.status}.` };
    }

    if (cancelRequests.has(executionId)) {
      return { success: true, alreadyRequested: true, message: 'Stop already requested.' };
    }

    cancelRequests.add(executionId);
    await executionsDb.updateAsync(
      { executionId },
      { $set: { cancelRequested: true, cancelRequestedAt: new Date().toISOString() } },
      {},
    );
    await addExecutionLog(
      executionsDb, executionId, 'warn',
      'Stop requested — the run will end once the current step finishes.',
    );

    console.log(`[Workflow Execution] Stop requested for ${executionId}`);
    return { success: true, message: 'Stopping after the current step.' };
  } catch (err) {
    console.error('[workflow:cancel]', err);
    return { success: false, message: err.message || String(err) };
  }
});

ipcMain.handle('workflow:execute', async (_event, { workflowId, workflowName, nodes, edges, executionSteps, approvedRebuilds = [] }) => {
  const executionsDb = getDb('executions');
  const startTime = new Date().toISOString();

  // Generate unique execution ID
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Create initial execution record.
  //
  // `currentNodeId` / `currentNodeName` / `totalSteps` exist for the live UI
  // (the canvas ring and the execution monitor panel): they are written before
  // each node runs and cleared when the run ends, so a renderer polling this
  // row can tell WHICH node is executing right now — nodeExecutions only gains
  // an entry once a node has already finished.
  const executionRecord = {
    executionId,
    workflowId,
    workflowName,
    status: 'running',
    startTime,
    endTime: null,
    duration: null,
    currentNodeId: null,
    currentNodeName: null,
    totalSteps: 0,
    nodeExecutions: [],
    logs: [],
    results: {
      totalRecordsProcessed: 0,
      summary: ''
    },
    trigger: {
      type: 'manual',
      user: 'local'
    },
    username: 'local'
  };

  // Everything the node layers below record — the SQL they run, the DDL that
  // was skipped, the connector and skill calls they make — is written through
  // this sink. See NodeExecution/executionLog.js for why it travels in an async
  // context instead of being threaded through every signature. Declared out
  // here so the failure path can drain it too: a run that threw is the one
  // whose trace is worth reading.
  const logSink = createExecutionSink(executionsDb, executionId);
  const flushExecutionLogs = () => logSink.flush();

  try {
    await executionsDb.insertAsync(executionRecord);

    // Build a map of node IDs to nodes
    const nodeMap = new Map();
    nodes.forEach(node => nodeMap.set(node.id, node));

    // Use executionSteps if provided, otherwise extract node IDs from nodes array
    const stepsToExecute = executionSteps && executionSteps.length > 0
      ? executionSteps.sort((a, b) => a.order - b.order)
      : nodes.map((node, index) => ({ nodeId: node.id, order: index }));

    const executionOrder = stepsToExecute.map(step => step.nodeId);

    executionRecord.totalSteps = stepsToExecute.length;
    await executionsDb.updateAsync(
      { executionId },
      { $set: { totalSteps: stepsToExecute.length, executionOrder } },
      {}
    );

    console.log(`[Workflow Execution] Starting execution ${executionId}`);
    console.log(`[Workflow Execution] Execution order:`, executionOrder);

    // Add log entry
    await addExecutionLog(executionsDb, executionId, 'info', `Starting workflow execution: ${workflowName}`);

    let totalRecordsProcessed = 0;
    const nodeResults = new Map();

    // Prepare helpers object for node execution
    const helpers = {
      pluginManager,
      getFullConfig,
      getDb,
      appSqliteDbPath,
      buildSkillHelpers,         // available for output / vector skill calls
      workflowId,                // scopes local output per workflow/node
      // Approved in the Execute prompt — see joinTargetRebuildGate. A run
      // started by a trigger passes none, so a pending rebuild refuses there.
      approvedRebuilds: Array.isArray(approvedRebuilds) ? approvedRebuilds : [],
    };

    // Set when the user stopped the run — see cancelRequests above. Checked at
    // the top of each step, so the node in flight is always allowed to finish.
    let cancelled = false;

    // Execute each node in order from executionSteps
    for (const step of stepsToExecute) {
      if (isCancelRequested(executionId)) { cancelled = true; break; }

      const nodeId = step.nodeId;
      const node = nodeMap.get(nodeId);

      if (!node) {
        console.warn(`[Workflow Execution] Node ${nodeId} not found in node map`);
        continue;
      }

      const nodeStartTime = Date.now();
      // The name comes from the node, never from the step: a step is
      // `{ nodeId, order }` and carries no name of its own (it used to carry a
      // snapshot, which went stale the moment the node was renamed or rebuilt).
      // `config.node_name` is written on every save (see withPersistedNodeNames)
      // and is what the canvas shows; `data.label` is the creation-time type
      // name ("Transformer") that nothing ever updates, so it is the last resort.
      const nodeLabel = node.data?.config?.node_name
        || node.data?.label
        || node.id;

      // Mark this node as the one in flight BEFORE running it, so the canvas
      // and the execution monitor can light it up while it works.
      executionRecord.currentNodeId = nodeId;
      executionRecord.currentNodeName = nodeLabel;
      await executionsDb.updateAsync(
        { executionId },
        { $set: { currentNodeId: nodeId, currentNodeName: nodeLabel } },
        {}
      );

      await addExecutionLog(executionsDb, executionId, 'info', `Executing node: ${nodeLabel} (${node.type})`, nodeId);

      // A node that returns { success: false } is recorded here and then
      // thrown, landing in the catch below — which used to record it a SECOND
      // time. Harmless while nodeExecutions was only written once at the end;
      // now that the array is flushed as the run goes, the duplicate would show
      // up in the monitor and the execution detail.
      let stepRecorded = false;

      try {
        // Execute the node using the helper function, inside this node's log
        // context so everything it calls files its trace under this node — and
        // inside a cancellation context, so the chunk loops DOWN INSIDE the
        // node can see a stop too. Without that second one a stop pressed
        // during a 400k-row batch insert waited out the whole load, because the
        // only check was the one between steps below.
        const nodeResult = await runWithExecutionLog(logSink, nodeId, () =>
          runWithCancellation(() => isCancelRequested(executionId), () =>
            executeNode(node, nodeMap, edges, helpers)));

        // Drain the node's trace before the verdict line below is written.
        // Trace entries are batched while addExecutionLog writes immediately,
        // so without this a node's SQL could be appended AFTER its own
        // "completed successfully" — the log is read in array order.
        await flushExecutionLogs();

        // Safety net for a swallowed stop.
        //
        // The node layers convert exceptions to { success: false } in a dozen
        // places; the ones on the main paths re-throw a cancellation, but a
        // path that does not would turn a stop into a FAILED run — the worst
        // possible reading, since nothing actually went wrong. A node that came
        // back unsuccessful while a stop was pending is treated as stopped: the
        // request is the more reliable witness than the return value.
        if (!nodeResult?.success && isCancelRequested(executionId)) {
          throw new ExecutionCancelledError(`"${nodeLabel}"`, nodeResult?.message || null);
        }

        const nodeDuration = Date.now() - nodeStartTime;

        // Store node result
        nodeResults.set(nodeId, nodeResult);

        // Update node execution record
        const nodeExecution = {
          nodeId,
          nodeName: nodeLabel,
          nodeType: node.type,
          status: nodeResult?.success ? 'completed' : 'failed',
          startTime: new Date(nodeStartTime).toISOString(),
          duration: nodeDuration,
          error: nodeResult?.success ? null : { message: nodeResult?.message || 'Unknown error' },
          metrics: {
            recordsProcessed: nodeResult?.recordsProcessed || 0,
            recordsSuccess: nodeResult?.recordsProcessed || 0,
            recordsFailed: 0
          }
        };

        executionRecord.nodeExecutions.push(nodeExecution);
        stepRecorded = true;

        // Flush the finished step immediately. The whole record is $set again
        // at the end of the run with this same array, so persisting it here
        // only makes progress visible sooner — it never double-writes.
        await executionsDb.updateAsync(
          { executionId },
          { $set: { nodeExecutions: executionRecord.nodeExecutions } },
          {}
        );

        if (nodeResult?.success) {
          totalRecordsProcessed += nodeResult?.recordsProcessed || 0;
          // Succeeded, but with something the user needs to see — an empty
          // source, so the node had nothing to do. Logged at 'warn' (the level
          // ExecutionTab renders amber) rather than folded into the generic
          // "completed successfully", which is how a run that wrote nothing
          // used to look exactly like one that wrote everything.
          if (nodeResult.warning) {
            await addExecutionLog(executionsDb, executionId, 'warn', `Node ${nodeLabel}: ${nodeResult.message}`, nodeId);
          } else {
            await addExecutionLog(executionsDb, executionId, 'info', `Node ${nodeLabel} completed successfully`, nodeId);
          }
        } else {
          await addExecutionLog(executionsDb, executionId, 'error', `Node ${nodeLabel} failed: ${nodeResult?.message || 'Unknown error'}`, nodeId);
          throw new Error(`Node ${nodeLabel} failed: ${nodeResult?.message || 'Unknown error'}`);
        }

      } catch (nodeError) {
        // A stop the user asked for, raised by a chunk loop inside the node —
        // NOT a failure. It gets its own status so the execution detail and the
        // canvas don't ring this node red for something that never went wrong,
        // and it leaves the loop rather than unwinding to the outer catch,
        // which would mark the whole run 'failed'.
        const stoppedHere = isCancelledError(nodeError);

        console[stoppedHere ? 'log' : 'error'](
          `[Workflow Execution] Node ${nodeId} ${stoppedHere ? 'stopped' : 'failed'}:`,
          stoppedHere ? nodeError.message : nodeError,
        );

        // The trace leading up to the failure is the point of the trace — get
        // it down before the error line, same ordering reason as above.
        await flushExecutionLogs();

        const nodeDuration = Date.now() - nodeStartTime;

        if (!stepRecorded) {
          executionRecord.nodeExecutions.push({
            nodeId,
            nodeName: nodeLabel,
            nodeType: node.type,
            status: stoppedHere ? 'cancelled' : 'failed',
            startTime: new Date(nodeStartTime).toISOString(),
            duration: nodeDuration,
            error: { message: nodeError.message },
            metrics: {
              recordsProcessed: 0,
              recordsSuccess: 0,
              recordsFailed: 0
            }
          });
        }

        // Persist the failed step before unwinding: the catch below marks the
        // run failed, and the canvas reads this array to ring the node that
        // broke on the most recent run.
        await executionsDb.updateAsync(
          { executionId },
          { $set: { nodeExecutions: executionRecord.nodeExecutions } },
          {}
        );

        if (stoppedHere) {
          // The message carries how far the write got ("12000 of 400000 rows
          // already written to sales") — the one thing the user needs, since
          // nothing rolls those rows back.
          await addExecutionLog(executionsDb, executionId, 'warn', `Node ${nodeLabel}: ${nodeError.message}`, nodeId);
          cancelled = true;
          break;
        }

        await addExecutionLog(executionsDb, executionId, 'error', `Node execution failed: ${nodeError.message}`, nodeId);
        throw nodeError;
      }
    }

    // Stopped by the user. Output validation is deliberately skipped: it asks
    // "did this workflow produce what it was supposed to", and a run that was
    // cut short did not get the chance — reporting it as invalid would be
    // noise, not a finding.
    if (cancelled) {
      const stoppedAt = new Date().toISOString();
      executionRecord.status = 'cancelled';
      executionRecord.endTime = stoppedAt;
      executionRecord.duration = Date.now() - new Date(startTime).getTime();
      executionRecord.currentNodeId = null;
      executionRecord.currentNodeName = null;
      executionRecord.results.totalRecordsProcessed = totalRecordsProcessed;

      // "Stopped after 3 of 7 nodes" is only half the story when the stop
      // landed INSIDE a node: that node wrote part of its output and nothing
      // rolled it back, so the summary has to name it.
      const interrupted = executionRecord.nodeExecutions.find((n) => n.status === 'cancelled');
      const finished = executionRecord.nodeExecutions.filter((n) => n.status === 'completed').length;
      executionRecord.results.summary = interrupted
        ? `Stopped by the user during "${interrupted.nodeName}" (${finished} of ${executionOrder.length} nodes finished). `
          + `${interrupted.error?.message || ''}`.trim()
        : `Stopped by the user after ${finished} of ${executionOrder.length} nodes.`;

      await flushExecutionLogs();
      await executionsDb.updateAsync(
        { executionId },
        {
          $set: {
            status: 'cancelled',
            endTime: executionRecord.endTime,
            duration: executionRecord.duration,
            currentNodeId: null,
            currentNodeName: null,
            cancelRequested: false,
            nodeExecutions: executionRecord.nodeExecutions,
            results: executionRecord.results,
            executionOrder,
          },
        },
        {}
      );
      await addExecutionLog(executionsDb, executionId, 'warn', executionRecord.results.summary);

      console.log(`[Workflow Execution] Execution ${executionId} stopped by the user`);

      return {
        success: false,
        cancelled: true,
        executionId,
        message: executionRecord.results.summary,
        results: executionRecord.results,
      };
    }

    // Output validation — every node has produced its output, so run the
    // workflow's validate(ctx) function (if enabled) before marking the run
    // completed. A failed validation never fails the run: we keep status
    // 'completed' and record the result for the UI to surface.
    try {
      const wfDoc = await getDb('workflows').findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
      // Traced with no node id: validation belongs to the run, not to any one
      // node, so its queries group under the execution's own log section.
      const validation = await runWithExecutionLog(logSink, null, () =>
        runOutputValidation({ workflow: wfDoc, helpers }));
      if (validation) {
        executionRecord.validation = validation;
        executionRecord.results.validation = validation;
        await addExecutionLog(
          executionsDb, executionId,
          validation.valid ? 'info' : 'warning',
          validation.valid ? 'Output validation passed' : `Output validation failed: ${validation.reason}`,
        );
      }
    } catch (validationErr) {
      console.error('[Workflow Execution] Output validation error:', validationErr);
    }

    // Workflow completed successfully
    const endTime = new Date().toISOString();
    const duration = Date.now() - new Date(startTime).getTime();

    executionRecord.status = 'completed';
    executionRecord.endTime = endTime;
    executionRecord.duration = duration;
    // Nothing is in flight any more — the canvas stops pulsing this node.
    executionRecord.currentNodeId = null;
    executionRecord.currentNodeName = null;
    executionRecord.results.totalRecordsProcessed = totalRecordsProcessed;
    executionRecord.results.summary = `Successfully executed ${executionOrder.length} nodes`;
    executionRecord.executionOrder = executionOrder;

    // Field by field, NOT `$set: executionRecord`.
    //
    // `executionRecord.logs` is the empty array this record was inserted with
    // and is never appended to in memory — addExecutionLog and the trace sink
    // both `$push` straight to the datastore. Writing the whole object back
    // therefore reset `logs` to [] at the end of every run, erasing every line
    // the run had produced; the only survivor was the "completed successfully"
    // line added just below, after the overwrite. That is why a finished
    // execution appeared to have no per-node logs at all.
    await flushExecutionLogs();
    await executionsDb.updateAsync(
      { executionId },
      {
        $set: {
          status: executionRecord.status,
          endTime: executionRecord.endTime,
          duration: executionRecord.duration,
          currentNodeId: null,
          currentNodeName: null,
          cancelRequested: false,
          nodeExecutions: executionRecord.nodeExecutions,
          results: executionRecord.results,
          executionOrder,
          ...(executionRecord.validation ? { validation: executionRecord.validation } : {}),
        },
      },
      {}
    );

    await addExecutionLog(executionsDb, executionId, 'info', `Workflow execution completed successfully`);

    console.log(`[Workflow Execution] Execution ${executionId} completed successfully`);

    return {
      success: true,
      executionId,
      message: 'Workflow executed successfully',
      results: executionRecord.results,
      // What the run learned about its nodes (a join whose target was
      // recreated, a REST source's first fetch) — written back onto the
      // canvas by the editor, same as a single-node run's configPatch.
      configPatches: Object.fromEntries([...nodeResults.entries()]
        .filter(([, r]) => r && r.success && r.configPatch && typeof r.configPatch === 'object')
        .map(([id, r]) => [id, r.configPatch])),
    };

  } catch (error) {
    console.error(`[Workflow Execution] Execution ${executionId} failed:`, error);

    const endTime = new Date().toISOString();
    const duration = Date.now() - new Date(startTime).getTime();

    executionRecord.status = 'failed';
    executionRecord.endTime = endTime;
    executionRecord.duration = duration;
    executionRecord.currentNodeId = null;
    executionRecord.currentNodeName = null;
    executionRecord.error = {
      message: error.message,
      stack: error.stack
    };

    // Field by field — see the note on the success path. A failed run is the
    // one whose logs matter most, so this is the overwrite that hurt.
    await flushExecutionLogs();
    await executionsDb.updateAsync(
      { executionId },
      {
        $set: {
          status: executionRecord.status,
          endTime: executionRecord.endTime,
          duration: executionRecord.duration,
          currentNodeId: null,
          currentNodeName: null,
          cancelRequested: false,
          nodeExecutions: executionRecord.nodeExecutions,
          results: executionRecord.results,
          error: executionRecord.error,
        },
      },
      {}
    );

    await addExecutionLog(executionsDb, executionId, 'error', `Workflow execution failed: ${error.message}`);

    return {
      success: false,
      executionId,
      message: error.message,
      error: error.message
    };
  } finally {
    // However the run ended — finished, failed, or stopped — the request must
    // not outlive it, or a later execution reusing nothing but the same Set
    // would find a stale id. Idempotent, so the cancelled path above needn't
    // repeat it.
    clearCancelRequest(executionId);
  }
});

// ---------------------------------------------------------------------------
// Start Trigger Management (CRON and File Watchers)
// ---------------------------------------------------------------------------

/**
 * Close out executions left marked 'running' by a previous app session.
 * Called once on startup — see the call site in app.whenReady.
 * @returns {Promise<number>} How many rows were reconciled
 */
async function reconcileOrphanedExecutions() {
  try {
    const executionsDb = getDb('executions');
    const stale = await executionsDb.findAsync({ status: 'running' });
    if (!stale.length) return 0;

    const endTime = new Date().toISOString();
    for (const ex of stale) {
      await executionsDb.updateAsync(
        { executionId: ex.executionId },
        {
          $set: {
            status: 'failed',
            endTime,
            duration: ex.startTime ? Date.now() - new Date(ex.startTime).getTime() : null,
            // currentNodeId is left as it was: it names the step the run died
            // on, which is the only record of where it got to, and the canvas
            // uses it to mark that node.
            cancelRequested: false,
            error: { message: 'Execution was interrupted (the app closed while it was running).' },
            'results.summary': 'Execution was interrupted (the app closed while it was running).'
          }
        }
      );
    }
    console.log(`[Electron] Reconciled ${stale.length} interrupted execution(s) from a previous session`);
    return stale.length;
  } catch (err) {
    console.error('[Electron] Could not reconcile interrupted executions:', err);
    return 0;
  }
}

// Track active workflow executions to prevent concurrent runs
const activeWorkflowExecutions = new Map();

/**
 * Execute a workflow from a trigger (CRON or file watcher)
 * @param {String} workflowId - Workflow ID to execute
 * @param {String} nodeId - Trigger node ID
 * @param {Object} triggerInfo - Information about the trigger
 * @returns {Promise<Object>} Execution result
 */
async function executeWorkflowFromTrigger(workflowId, nodeId, triggerInfo) {
  // Declared out here so the catch — and the finally that releases a pending
  // stop request — can name the run even when it fell over mid-setup.
  let executionId = null;
  try {
    console.log('activeWorkflowExecutions: ', activeWorkflowExecutions)
    // Check if workflow is already executing
    if (activeWorkflowExecutions.has(workflowId)) {
      console.log(`[Trigger] Workflow ${workflowId} is already executing, skipping trigger`);
      return {
        success: false,
        message: 'Workflow is already executing',
        skipped: true
      };
    }

    // Mark workflow as executing
    activeWorkflowExecutions.set(workflowId, {
      startTime: new Date().toISOString(),
      nodeId: nodeId,
      trigger: triggerInfo
    });

    // Load workflow from database
    const workflowsDb = getDb('workflows');
    const workflow = await workflowsDb.findOneAsync({ id: workflowId });

    // console.log('workflow: ', workflow)
    if (!workflow) {
      console.error(`[Trigger] Workflow ${workflowId} not found`);
      activeWorkflowExecutions.delete(workflowId);
      return { success: false, message: 'Workflow not found' };
    }

    console.log(`[Trigger] Executing workflow: ${workflow.name}`);


    const notificationOptions = {
      title: 'Ternlux',
      body: `Workflow "${workflow.name}" is now running...`,
    };

    if (Notification.isSupported()) {
      new Notification(notificationOptions).show();
    }

    // Execute workflow
    const executionsDb = getDb('executions');
    const startTime = new Date().toISOString();
    executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create execution record
    const executionRecord = {
      executionId,
      workflowId,
      workflowName: workflow.name,
      status: 'running',
      startTime,
      endTime: null,
      duration: null,
      // See the manual runner (workflow:execute) — these drive the live canvas
      // ring and the execution monitor panel.
      currentNodeId: null,
      currentNodeName: null,
      totalSteps: 0,
      nodeExecutions: [],
      logs: [],
      results: {
        totalRecordsProcessed: 0,
        summary: ''
      },
      trigger: {
        ...triggerInfo,
        nodeId: nodeId
      },
      username: 'system'
    };

    await executionsDb.insertAsync(executionRecord);

    // Build node map
    const nodeMap = new Map();
    workflow.nodes.forEach(node => nodeMap.set(node.id, node));

    // Get execution steps
    const stepsToExecute = workflow.executionSteps && workflow.executionSteps.length > 0
      ? workflow.executionSteps.sort((a, b) => a.order - b.order)
      : workflow.nodes.map((node, index) => ({ nodeId: node.id, order: index }));

    await executionsDb.updateAsync(
      { executionId },
      { $set: { totalSteps: stepsToExecute.length } }
    );

    await addExecutionLog(
      executionsDb,
      executionId,
      'info',
      `Starting workflow execution: ${workflow.name} (triggered by ${triggerInfo.type}: ${triggerInfo.description})`
    );

    // Same per-node tracing the manual runner gets — a scheduled run is the one
    // nobody was watching, so its trace is the only account of what happened.
    const logSink = createExecutionSink(executionsDb, executionId);

    // Prepare helpers
    const helpers = {
      pluginManager,
      getFullConfig,
      getDb,
      appSqliteDbPath,
      buildSkillHelpers,         // available for output / vector skill calls
      workflowId                 // scopes local output per workflow/node
    };

    let totalRecordsProcessed = 0;
    // A scheduled run is stoppable from the monitor exactly like a manual one —
    // see cancelRequests. `stepsRun` only exists to say how far it got in the
    // summary, since this runner $pushes node rows rather than keeping an array.
    let cancelled = false;
    let stepsRun = 0;
    // Set only when the stop landed inside a node rather than between two —
    // that node wrote part of its output, and the summary has to say so.
    let interruptedNode = null;

    // Execute each node
    for (const step of stepsToExecute) {
      if (isCancelRequested(executionId)) { cancelled = true; break; }

      const node = nodeMap.get(step.nodeId);
      if (!node) continue;

      const nodeStartTime = Date.now();
      // The name comes from the node, never from the step: a step is
      // `{ nodeId, order }` and carries no name of its own (it used to carry a
      // snapshot, which went stale the moment the node was renamed or rebuilt).
      // `config.node_name` is written on every save (see withPersistedNodeNames)
      // and is what the canvas shows; `data.label` is the creation-time type
      // name ("Transformer") that nothing ever updates, so it is the last resort.
      const nodeLabel = node.data?.config?.node_name
        || node.data?.label
        || node.id;

      await executionsDb.updateAsync(
        { executionId },
        { $set: { currentNodeId: node.id, currentNodeName: nodeLabel } }
      );

      await addExecutionLog(
        executionsDb,
        executionId,
        'info',
        `Executing node: ${nodeLabel} (${node.type})`,
        node.id,
      );

      // Whether this node already has a nodeExecutions row, so the catch below
      // records one for a node that threw outright without duplicating one for
      // a node that merely returned { success: false }.
      let stepRecorded = false;

      try {
        // Both contexts, same as the manual runner: the log sink so the node's
        // trace files under it, and the cancellation predicate so the chunk
        // loops inside the node can see a stop.
        const nodeResult = await runWithExecutionLog(logSink, node.id, () =>
          runWithCancellation(() => isCancelRequested(executionId), () =>
            executeNode(node, nodeMap, workflow.edges, helpers)));
        // Batched trace lines down before this node's verdict line.
        await logSink.flush();
        const nodeDuration = Date.now() - nodeStartTime;

        // Safety net for a swallowed stop — see the manual runner for why the
        // pending request is a more reliable witness than the return value.
        // Decided BEFORE the row is written, or a stopped node would be filed
        // as failed and no later branch could correct it.
        const stoppedHere = !nodeResult?.success && isCancelRequested(executionId);

        const nodeExec = {
          nodeId: node.id,
          nodeName: nodeLabel,
          nodeType: node.type,
          status: nodeResult?.success ? 'completed' : (stoppedHere ? 'cancelled' : 'failed'),
          startTime: new Date(nodeStartTime).toISOString(),
          duration: nodeDuration,
          error: nodeResult?.success ? null : { message: nodeResult?.message || 'Unknown error' },
          metrics: {
            recordsProcessed: nodeResult?.recordsProcessed || 0,
            recordsSuccess: nodeResult?.recordsProcessed || 0,
            recordsFailed: 0
          }
        };

        await executionsDb.updateAsync(
          { executionId },
          { $push: { nodeExecutions: nodeExec } }
        );
        stepRecorded = true;
        // Counts nodes that FINISHED. It feeds "N of M nodes finished" in the
        // stop summary, and a node that failed or was cut short did neither.
        if (nodeResult?.success) stepsRun += 1;

        if (!nodeResult?.success) {
          if (stoppedHere) {
            throw new ExecutionCancelledError(`"${nodeLabel}"`, nodeResult?.message || null);
          }
          throw new Error(nodeResult?.message || 'Node execution failed');
        }

        // Same as the interactive runner: a node that ran but had nothing to
        // do says so, at the level the execution log paints amber.
        if (nodeResult.warning) {
          await addExecutionLog(
            executionsDb,
            executionId,
            'warn',
            `Node ${nodeLabel}: ${nodeResult.message}`,
            node.id,
          );
        }

        totalRecordsProcessed += nodeResult?.recordsProcessed || 0;
      } catch (error) {
        // A stop raised by a chunk loop inside the node. Recorded as cancelled
        // rather than failed, and it leaves the loop instead of falling through
        // to the "mark the run failed" block below. See the manual runner.
        const stoppedHere = isCancelledError(error);

        // The trace up to the failure, before the error line below.
        await logSink.flush();
        // A node that threw before producing a result still needs its row, or
        // nothing on the canvas marks which step broke the run.
        if (!stepRecorded) {
          await executionsDb.updateAsync(
            { executionId },
            {
              $push: {
                nodeExecutions: {
                  nodeId: node.id,
                  nodeName: nodeLabel,
                  nodeType: node.type,
                  status: stoppedHere ? 'cancelled' : 'failed',
                  startTime: new Date(nodeStartTime).toISOString(),
                  duration: Date.now() - nodeStartTime,
                  error: { message: error.message },
                  metrics: { recordsProcessed: 0, recordsSuccess: 0, recordsFailed: 0 }
                }
              }
            }
          );
        }

        if (stoppedHere) {
          await addExecutionLog(
            executionsDb, executionId, 'warn',
            `Node ${nodeLabel}: ${error.message}`, node.id,
          );
          cancelled = true;
          interruptedNode = { name: nodeLabel, message: error.message };
          break;
        }

        await addExecutionLog(
          executionsDb,
          executionId,
          'error',
          `Node execution failed: ${error.message}`,
          node.id,
        );

        // Mark as failed
        const endTime = new Date().toISOString();
        const duration = new Date(endTime) - new Date(startTime);

        await executionsDb.updateAsync(
          { executionId },
          {
            $set: {
              status: 'failed',
              endTime,
              duration,
              currentNodeId: null,
              currentNodeName: null,
              'results.totalRecordsProcessed': totalRecordsProcessed,
              'results.summary': `Workflow failed: ${error.message}`
            }
          }
        );


        if (Notification.isSupported()) {
          new Notification({
            title: 'Ternlux - Workflow Failed',
            body: `Workflow "${workflow.name}" failed: ${error.message}`,
          }).show();
        }

        throw error;
      }
    }

    // Stopped by the user. Validation is skipped for the same reason as in the
    // manual runner: a run that was cut short never got the chance to produce
    // what it would be validated against.
    if (cancelled) {
      const stoppedAt = new Date().toISOString();
      const summary = interruptedNode
        ? `Stopped by the user during "${interruptedNode.name}" `
          + `(${stepsRun} of ${stepsToExecute.length} nodes finished). ${interruptedNode.message}`
        : `Stopped by the user after ${stepsRun} of ${stepsToExecute.length} nodes.`;

      await logSink.flush();
      await executionsDb.updateAsync(
        { executionId },
        {
          $set: {
            status: 'cancelled',
            endTime: stoppedAt,
            duration: new Date(stoppedAt) - new Date(startTime),
            currentNodeId: null,
            currentNodeName: null,
            cancelRequested: false,
            'results.totalRecordsProcessed': totalRecordsProcessed,
            'results.summary': summary,
          }
        }
      );
      await addExecutionLog(executionsDb, executionId, 'warn', summary);

      clearCancelRequest(executionId);
      activeWorkflowExecutions.delete(workflowId);

      if (Notification.isSupported()) {
        new Notification({
          title: 'Ternlux - Workflow Stopped',
          body: `Workflow "${workflow.name}" was stopped. ${summary}`,
        }).show();
      }

      return { success: false, cancelled: true, executionId, message: summary };
    }

    // Output validation — run the workflow's validate(ctx) function (if
    // enabled) now that every node has produced its output. Never fails the
    // run; the result is recorded for the UI.
    let validation = null;
    try {
      validation = await runOutputValidation({ workflow, helpers });
      if (validation) {
        await addExecutionLog(
          executionsDb,
          executionId,
          validation.valid ? 'info' : 'warning',
          validation.valid ? 'Output validation passed' : `Output validation failed: ${validation.reason}`,
        );
      }
    } catch (validationErr) {
      console.error('[Trigger] Output validation error:', validationErr);
    }

    // Mark as completed
    const endTime = new Date().toISOString();
    const duration = new Date(endTime) - new Date(startTime);

    await executionsDb.updateAsync(
      { executionId },
      {
        $set: {
          status: 'completed',
          endTime,
          duration,
          currentNodeId: null,
          currentNodeName: null,
          'results.totalRecordsProcessed': totalRecordsProcessed,
          'results.summary': `Workflow completed successfully. Processed ${totalRecordsProcessed} records.`,
          ...(validation ? { validation, 'results.validation': validation } : {})
        }
      }
    );

    await addExecutionLog(
      executionsDb,
      executionId,
      'info',
      `Workflow execution completed: ${workflow.name}`
    );

    console.log(`[Trigger] Workflow ${workflowId} executed successfully`);


    if (Notification.isSupported()) {
      new Notification({
        title: 'Ternlux - Workflow Completed',
        body: `Workflow "${workflow.name}" executed successfully!`,
      }).show();
    }
    console.log('activeWorkflowExecutionsdelete: ', activeWorkflowExecutions)

    // Remove from active executions
    activeWorkflowExecutions.delete(workflowId);

    return {
      success: true,
      executionId,
      message: 'Workflow executed successfully',
      recordsProcessed: totalRecordsProcessed
    };
  } catch (error) {
    console.error(`[Trigger] Failed to execute workflow ${workflowId}:`, error);

    // Remove from active executions
    activeWorkflowExecutions.delete(workflowId);

    // Get workflow name if available
    let workflowName = 'Unknown Workflow';
    try {
      const workflowsDb = getDb('workflows');
      const workflow = await workflowsDb.findOneAsync({ _id: workflowId });

      if (workflow) {
        workflowName = workflow.name;
      }
    } catch (err) {
      // Ignore error, use default name
    }

    if (Notification.isSupported()) {
      new Notification({
        title: 'Ternlux - Workflow Error',
        body: `Workflow "${workflowName}" encountered an error: ${error.message}`,
      }).show();
    }

    return {
      success: false,
      message: error.message
    };
  } finally {
    // Same reason as the manual runner: a stop request must not outlive the run
    // it was aimed at.
    if (executionId) clearCancelRequest(executionId);
  }
}

/**
 * Register a CRON job for time-based workflow triggers
 */
ipcMain.handle('start-trigger:register-cron', async (_event, params) => {
  return await registerCronJob(params, executeWorkflowFromTrigger);
});

/**
 * Unregister a CRON job
 */
ipcMain.handle('start-trigger:unregister-cron', async (_event, params) => {
  return await unregisterCronJob(params);
});

/**
 * Register a file watcher for file/directory change triggers
 */
ipcMain.handle('start-trigger:register-file-watch', async (_event, params) => {
  return await registerFileWatcher(params, executeWorkflowFromTrigger);
});

/**
 * Unregister a file watcher
 */
ipcMain.handle('start-trigger:unregister-file-watch', async (_event, params) => {
  return await unregisterFileWatcher(params);
});

/**
 * Get all active triggers (CRON jobs and file watchers)
 */
ipcMain.handle('start-trigger:get-active', async () => {
  try {
    return {
      success: true,
      triggers: {
        cron: getActiveCronJobs(),
        file: getActiveFileWatchers()
      }
    };
  } catch (error) {
    console.error('[Triggers] Get active error:', error);
    return {
      success: false,
      message: error.message
    };
  }
});

/**
 * Watch the open workflow's externalized-code folder and notify the renderer
 * when a code file changes on disk, so the editor can reload and stay in sync
 * with {userData}/workflow-code/{workflow}. Editor sync only — does not run the
 * workflow (see triggers/fileWatchTriggers.js for the execution trigger).
 */
ipcMain.handle('workflow:watchCode', async (event, { workflowId } = {}) => {
  if (!workflowId) return { success: false, message: 'workflowId required' };
  try {
    const db = getDb('workflows');
    const doc = await db.findOneAsync({ $or: [{ id: workflowId }, { _id: workflowId }] });
    if (!doc) return { success: false, message: 'Workflow not found' };

    const codeBaseDir = path.join(app.getPath('userData'), 'workflow-code');
    const workflowDir = workflowDirName(doc.name, doc.id || doc._id);
    const watchPath = path.join(codeBaseDir, String(workflowDir));

    const sender = event.sender;
    return watchWorkflowCode(
      { webContentsId: sender.id, workflowId, watchPath },
      (payload) => { if (!sender.isDestroyed()) sender.send('workflow:codeChanged', payload); },
    );
  } catch (error) {
    console.error('[CodeWatch] watchCode error:', error);
    return { success: false, message: error.message };
  }
});

/** Stop watching a workflow's code folder for the calling renderer. */
ipcMain.handle('workflow:unwatchCode', async (event, { workflowId } = {}) => {
  return unwatchWorkflowCode({ webContentsId: event.sender.id, workflowId });
});

/**
 * ui:showTextContextMenu — the native Copy/Paste menu, opened at the pointer.
 *
 * Electron windows have NO context menu unless one is built, which is why a
 * right-click in the app did nothing. Built from Electron ROLES rather than
 * click handlers: roles drive the focused WebContents' own clipboard machinery,
 * so they copy exactly what the selection is and paste through the same path as
 * ⌘V — a hand-rolled handler would need clipboard permissions the renderer
 * doesn't have, and would mishandle rich selections.
 *
 * Enablement mirrors what the caller found under the pointer: Copy needs a
 * selection, Paste needs an editable target. Both stay VISIBLE either way, so
 * the menu doesn't change shape as you right-click around.
 */
ipcMain.handle('ui:showTextContextMenu', async (event, { hasSelection = false, isEditable = false } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'no window for this renderer' };
    Menu.buildFromTemplate([
      { role: 'copy', enabled: !!hasSelection },
      { role: 'paste', enabled: !!isEditable },
    ]).popup({ window: win });
    return { success: true };
  } catch (err) {
    console.error('[ui:showTextContextMenu]', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'default',
    title: 'Ternlux',
    show: false,
  });

  if (!app.isPackaged) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../build/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Tear down any editor code watchers this window registered. The id is read
  // now, not inside the handler: by the time 'destroyed' fires the WebContents
  // is gone, and touching it throws "Object has been destroyed" — which, on
  // quit, takes the whole process down with it.
  const webContentsId = win.webContents.id;
  win.webContents.on('destroyed', () => {
    unwatchAllForWebContents(webContentsId).catch((err) =>
      console.error('[CodeWatch] cleanup on window close failed:', err));
  });
}

// ─── Auto-updates ────────────────────────────────────────────────────────────
// Checks the GitHub Releases feed (build.publish in package.json), downloads
// updates in the background, and installs on quit. Dormant in dev and until
// a release actually exists — failed checks are logged, never surfaced.

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setupAutoUpdates() {
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[updater] electron-updater unavailable:', err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.log('[updater] update check failed:', err?.message || err);
  });

  // Let the user know a download has started, so the "Update ready" dialog
  // (which only fires once the full installer has downloaded) isn't a surprise.
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info?.version);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Ternlux - Update available',
        body: `Downloading Ternlux ${info?.version} in the background…`,
        silent: true,
      }).show();
    }
  });

  // download-progress fires many times per second — throttle to 25% milestones
  // and keep the toasts silent so we don't spam the notification center.
  let lastProgressMilestone = 0;
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.floor(progress?.percent || 0);
    if (percent >= lastProgressMilestone + 25 && percent < 100) {
      lastProgressMilestone = percent - (percent % 25);
      if (Notification.isSupported()) {
        new Notification({
          title: 'Ternlux - Downloading update',
          body: `Update download ${lastProgressMilestone}% complete…`,
          silent: true,
        }).show();
      }
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    lastProgressMilestone = 0;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Ternlux ${info.version} has been downloaded.`,
      detail: 'Restart now to apply the update, or keep working — it will install automatically when you quit.'
    });
    if (response === 0) autoUpdater.quitAndInstall(false, true);
  });

  const check = () => autoUpdater.checkForUpdates().catch((err) => {
    console.log('[updater] update check failed:', err?.message || err);
  });
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  // The keyring is only resolved once the app is ready, so this is the first
  // point it can be reported. basic_text means the fallback took over.
  if (process.platform === 'linux') {
    console.log(`[safeStorage] backend: ${secretStorageBackend()}`);
  }

  // Initialize SQLite connection pool
  await initializeAppDatabase();

  // Initialize node execution module with dependencies (skill helpers
  // builder is passed so vector-DB join hooks can access embedding libs).
  nodeExecution.initialize(appSqliteDbPath, getFullConfig, buildSkillHelpers);
  apiFetch.initialize(getFullConfig);

  // Load connector plugins
  pluginManager.loadPlugins();

  // Nothing survives a process exit, so any execution still marked 'running'
  // when we start belongs to a previous session that was quit or crashed
  // mid-run. Left alone it is a permanent ghost: the editor's "a run is in
  // progress" gate never lifts and the execution monitor lists a workflow that
  // is not executing. Close them out as failed.
  await reconcileOrphanedExecutions();

  // Register all workflow triggers (CRON jobs and file watchers)
  await registerAllWorkflowTriggers(getDb, executeWorkflowFromTrigger);

  createWindow();

  setupAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Gracefully close SQLite connection pool and stop all triggers on app quit
app.on('before-quit', async (event) => {
  event.preventDefault();

  // Stop all CRON jobs
  console.log('[Electron] Stopping all CRON jobs...');
  stopAllCronJobs();

  // Stop all file watchers
  console.log('[Electron] Stopping all file watchers...');
  await stopAllFileWatchers();

  // Stop all editor code watchers
  console.log('[Electron] Stopping all code watchers...');
  await stopAllCodeWatchers();

  // Checkpoint every attached workflow database so none is left with a
  // write-ahead log beside it, then release the DuckDB connection.
  try {
    console.log('[Electron] Closing DuckDB...');
    await require('./duckdb').close();
  } catch (err) {
    console.warn('[Electron] DuckDB close failed:', err.message);
  }

  app.exit(0);
});
