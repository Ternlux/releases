/**
 * Backend analytics module.
 *
 * Sends anonymous, aggregated usage events to a configurable ingestion URL
 * (typically the Python sidecar in analytics-server/).
 *
 *  - Respects the user's opt-in. Default is OFF; the renderer pushes the
 *    current setting via the `analytics:set-opt-in` IPC after the user
 *    answers the Terms screen, and again whenever they toggle in Settings.
 *  - Anonymous by construction: NO persistent device identifier is generated
 *    or sent, and the server never records the client IP. Only a per-launch
 *    random sessionId (resets every app start) is attached, so events cannot
 *    be linked to an individual or to one device over time.
 *  - Fire-and-forget POST. Failures are swallowed so analytics can never
 *    break a user-facing IPC call.
 *  - Never sends prompt contents, workflow rows, queries, credentials, or
 *    handler payloads — only channel name, duration, success/failure, and a
 *    short whitelisted set of properties (e.g. AI provider/model).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');

const STATE_FILE = 'analytics-state.json';

// Production ingest URL. Override at runtime with TERNLUX_ANALYTICS_URL.
// Replace this default with your deployed API Gateway invoke URL after
// running `sam deploy` in analytics-server/ (the IngestUrl output).
const DEFAULT_ENDPOINT = 'https://tlkoabdy60.execute-api.us-east-1.amazonaws.com/';

let endpoint = process.env.TERNLUX_ANALYTICS_URL || DEFAULT_ENDPOINT;
let optIn = false;          // Default to OFF until renderer confirms.
let appVersion = null;
let initialized = false;
let sessionId = null;       // Per-launch only — NOT persisted across runs.

// Allowlist of IPC channels that emit an analytics event. Anything not
// listed here is passed through untouched. Keep this list small — only
// real user actions, never hot-path queries / list refreshes / polling.
const TRACK_CHANNELS = new Set([
  'ai:call',
  'workflow:execute',
  'dbconn:test',
  'plugins:install',
  'plugins:uninstall',
  'skills:buildPrompt',
  'oauth:exchange-code',
  'oauth:start-callback-server',
  'google-sheets:import-to-duckdb',
]);

// Hard-coded set of safe error labels we ever emit. Anything that isn't on
// this list collapses to 'Error'. This guarantees we never accidentally
// surface a file path, SQL fragment, or similar through a thrown message.
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'FetchError',
  'MongoError',
  'MongoServerSelectionError',
  'MongoNetworkError',
]);

// Codes we trust on err.code: short, alphanumeric, well-known constants from
// node/network/db drivers. Strict regex — anything else is dropped.
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Reduce any error to a tiny, bounded label that contains zero user content.
 * Output is like "TypeError", "Error:ENOTFOUND", or "handler_failure".
 */
function safeErrorCode(err) {
  if (!err) return null;
  const rawName = (err && err.constructor && err.constructor.name) || 'Error';
  const name = SAFE_ERROR_NAMES.has(rawName) ? rawName : 'Error';
  const rawCode = typeof err.code === 'string' ? err.code : null;
  if (rawCode && SAFE_CODE_RE.test(rawCode)) return `${name}:${rawCode}`;
  return name;
}

// For each tracked channel, optionally extract a few well-known non-sensitive
// scalar fields (counts, type strings, ids). Anything not listed in a given
// extractor is dropped — we never forward request payloads.
const PROP_EXTRACTORS = {
  'ai:call': (args) => {
    const opts = (args && args[0] && args[0].options) || {};
    return {
      provider: typeof opts.provider === 'string' ? opts.provider : null,
      model: typeof opts.model === 'string' ? opts.model : null,
      maxTokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : null,
      promptLength:
        args && args[0] && typeof args[0].prompt === 'string'
          ? args[0].prompt.length
          : null,
      historyLength:
        Array.isArray(opts.chatHistory) ? opts.chatHistory.length : 0,
    };
  },
  'workflow:execute': (args) => {
    const payload = (args && args[0]) || {};
    return {
      nodeCount: Array.isArray(payload.nodes) ? payload.nodes.length : null,
      edgeCount: Array.isArray(payload.edges) ? payload.edges.length : null,
      stepCount: Array.isArray(payload.executionSteps) ? payload.executionSteps.length : null,
    };
  },
  'plugins:install': (args) => ({ pluginId: args?.[0]?.pluginId || null }),
  'plugins:uninstall': (args) => ({ pluginId: args?.[0]?.pluginId || null }),
  'skills:buildPrompt': (args) => ({ pluginId: args?.[0]?.skillId || null }),
  'dbconn:test': (args) => ({ dbType: args?.[0]?.dbType || null }),
  'oauth:exchange-code': (args) => ({ dbType: args?.[0]?.dbType || null }),
};

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[analytics] could not persist state:', e.message);
  }
}

function init() {
  if (initialized) return;
  initialized = true;

  appVersion = (() => {
    try { return app.getVersion(); } catch { return 'unknown'; }
  })();

  // Per-launch session id only. Regenerated every start and never persisted,
  // so it cannot be used to track a device across runs.
  sessionId = crypto.randomUUID();

  const state = loadState() || {};
  if (typeof state.optIn === 'boolean') {
    optIn = state.optIn;
  }
  saveState({ optIn });
}

function setOptIn(value) {
  init();
  optIn = !!value;
  saveState({ optIn });
}

function getOptIn() {
  init();
  return optIn;
}

function setEndpoint(url) {
  if (typeof url === 'string' && url.trim()) endpoint = url.trim();
}

function commonContext() {
  return {
    sessionId,
    appVersion,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    locale: (Intl.DateTimeFormat().resolvedOptions().locale) || null,
  };
}

/**
 * Fire-and-forget POST. Uses the global fetch (Node 18+ / Electron 28+).
 * Errors are swallowed — analytics MUST NOT affect user-facing flows.
 */
function send(eventName, properties = {}) {
  if (!optIn) return;
  if (!endpoint) return;

  const body = JSON.stringify({
    event: eventName,
    timestamp: new Date().toISOString(),
    ...commonContext(),
    properties,
  });

  // Don't await — let it run in the background.
  Promise.resolve().then(async () => {
    try {
      if (typeof fetch !== 'function') return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Silent — never let analytics break the app.
    }
  });
}

/**
 * Patch ipcMain so handlers for channels in TRACK_CHANNELS are wrapped with
 * timing + success/error tracking. Channels not in the allowlist are passed
 * through untouched, so this stays cheap on hot paths (db:find, schema
 * lookups, polling) and we only emit one event per real user action.
 *
 * Must run BEFORE any handler is registered to take effect on all of them.
 */
function patchIpcMain(ipcMain) {
  init();
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function patchedHandle(channel, listener) {

    // console.log('channel, listener: ', channel, listener)
    if (!TRACK_CHANNELS.has(channel)) {
      return originalHandle(channel, listener);
    }

    const wrapped = async (event, ...args) => {
      const start = Date.now();
      let success = true;
      let errorCode = null;
      try {
        const result = await listener(event, ...args);
        if (result && typeof result === 'object' && result.success === false) {
          success = false;
          errorCode = 'handler_failure';
        }
        return result;
      } catch (err) {
        success = false;
        errorCode = safeErrorCode(err);
        throw err;
      } finally {
        try {
          const extractor = PROP_EXTRACTORS[channel];
          const extra = extractor ? extractor(args) : {};
          send('ipc.invoke', {
            channel,
            durationMs: Date.now() - start,
            success,
            errorCode,
            ...extra,
          });
        } catch {
          // ignore
        }
      }
    };

    return originalHandle(channel, wrapped);
  };
}

/**
 * Direct AI tracking. Use this when you call `aiProviders.callAIWithKeys`
 * outside an IPC handler (e.g. from a skill helper) and still want the
 * call recorded. Does NOT include the prompt or response.
 */
async function trackAICall(callFn, { provider, model, prompt, chatHistory } = {}) {
  init();
  const start = Date.now();
  let success = true;
  let errorCode = null;
  try {
    return await callFn();
  } catch (err) {
    success = false;
    errorCode = safeErrorCode(err);
    throw err;
  } finally {
    send('ai.call', {
      provider: provider || null,
      model: model || null,
      promptLength: typeof prompt === 'string' ? prompt.length : null,
      historyLength: Array.isArray(chatHistory) ? chatHistory.length : 0,
      durationMs: Date.now() - start,
      success,
      errorCode,
    });
  }
}

module.exports = {
  init,
  setOptIn,
  getOptIn,
  setEndpoint,
  send,
  trackAICall,
  patchIpcMain,
};
