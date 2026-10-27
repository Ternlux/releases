/**
 * Placeholder tokens for REST API connections.
 *
 * A REST API connection stores an open-ended list of key/value pairs
 * (`apiParams`) — tokens, API keys, tenant ids, query parameters, anything the
 * endpoint needs. The values are encrypted via safeStorage and never leave the
 * main process; the AI that authors the fetch function only ever sees the
 * *token* for each pair (e.g. `{{CLIENT_SECRET}}`), which the runner
 * substitutes just before evaluating the code.
 *
 * User keys are free text ("X-API-Key", "client secret", "page size"), so this
 * module owns the single normalisation rule that turns a key into a token.
 * Both sides — public/ChatPrompts/RestApi.js (which advertises the vocabulary)
 * and public/NodeExecution/ApiFetch.js (which resolves it) — must derive
 * tokens through here or they will disagree.
 */

// Tokens produced by the legacy authType fields. User keys never take these,
// so an old connection's `{{BEARER_TOKEN}}` can't be shadowed by a pair the
// user happens to call "bearer token".
const RESERVED_TOKENS = [
  'BASE_URL',
  'AUTH_HEADER_NAME',
  'AUTH_HEADER_VALUE',
  'BEARER_TOKEN',
  'API_KEY_VALUE',
  'BASIC_USERNAME',
  'BASIC_PASSWORD',
];

/**
 * Normalise a user-entered key into a placeholder token.
 * "X-API-Key" -> "X_API_KEY", "client secret" -> "CLIENT_SECRET".
 * Returns '' when the key has no usable characters.
 */
function toPlaceholderToken(key) {
  const token = String(key == null ? '' : key)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) return '';
  // The substitution regex is /\{\{([A-Z0-9_]+)\}\}/ — a leading digit is
  // legal there but reads badly, so prefix it.
  return /^[0-9]/.test(token) ? `P_${token}` : token;
}

/**
 * Drop blank keys and coerce every pair to { key, value } strings.
 * Mirrors what the connection form strips on save, so a config saved by an
 * older build still resolves cleanly.
 */
function normaliseParams(params) {
  if (!Array.isArray(params)) return [];
  return params
    .map(p => ({
      key: String(p && p.key != null ? p.key : '').trim(),
      value: p && p.value != null ? String(p.value) : '',
    }))
    .filter(p => p.key);
}

/**
 * Map each key to its token, resolving collisions deterministically.
 * Two keys that normalise the same way ("api-key" / "api key") get `_2`, `_3`
 * suffixes in list order — which is why the public key list and the encrypted
 * value list must stay in the same order (the connection form writes both in
 * one save).
 *
 * Accepts either bare key strings (the public list) or `{ key, value }` pairs
 * (the decrypted list); when a value is present it is carried through, so the
 * caller never has to re-zip two arrays that this function may have filtered
 * differently.
 *
 * @param {Array<string|{key:string, value?:string}>} keys
 * @returns {Array<{key:string, token:string, value:string}>}
 */
function buildParamTokens(keys) {
  const used = new Set(RESERVED_TOKENS);
  const out = [];
  const list = Array.isArray(keys) ? keys : [];

  for (const entry of list) {
    const isPair = entry && typeof entry === 'object';
    const key = String(
      isPair ? (entry.key != null ? entry.key : '') : (entry == null ? '' : entry)
    ).trim();
    if (!key) continue;

    const base = toPlaceholderToken(key);
    if (!base) continue;

    let token = base;
    let n = 2;
    while (used.has(token)) {
      token = `${base}_${n}`;
      n += 1;
    }
    used.add(token);
    out.push({
      key,
      token,
      value: isPair && entry.value != null ? String(entry.value) : '',
    });
  }

  return out;
}

module.exports = {
  RESERVED_TOKENS,
  toPlaceholderToken,
  normaliseParams,
  buildParamTokens,
};
