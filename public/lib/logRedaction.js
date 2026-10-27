/**
 * Keeps credentials out of the main-process log.
 *
 * Debug output across the app and its plugins prints whole config / params
 * objects, and those carry API keys (`embeddingApiKey`, a connection's full
 * config with its Pinecone key, …). The log is a file users attach to bug
 * reports, so every console call in the main process is formatted here and
 * scrubbed before it is written. Removing the individual dumps is still worth
 * doing; this is the net under the ones nobody has found yet.
 */
const util = require('util');

const REDACTED = '[redacted]';

// Values that are secrets by their shape, wherever they appear.
const TOKEN_PATTERNS = [
  /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / OpenRouter
  /\bpcsk_[A-Za-z0-9_]{16,}/g,                   // Pinecone
  /\bAIza[0-9A-Za-z_-]{30,}/g,                   // Google API keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,             // Slack
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,               // GitHub
  /\bya29\.[A-Za-z0-9._-]{20,}/g,                // Google OAuth access tokens
];

// `apiKey: 'value'`, `"password": "value"`, `client_secret='value'` — the value
// of any key whose NAME says it is a secret, as util.inspect / JSON print it.
const SECRET_FIELD = /((?:["']?)[\w-]*(?:api[_-]?key|secret|password|passwd|token|authorization|private[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*)(["'])((?:\\.|(?!\2).)+)\2/gi;

const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g;

function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text.replace(SECRET_FIELD, (_m, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

let installed = false;

/** Route console.log/info/warn/error/debug through redactSecrets. Idempotent. */
function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      let line;
      try {
        // Same formatting console itself applies, so the log reads as before.
        line = util.format(...args);
      } catch (_err) {
        return original(...args);
      }
      original(redactSecrets(line));
    };
  }
}

module.exports = { installConsoleRedaction, redactSecrets };
