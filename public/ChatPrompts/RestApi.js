/**
 * Chat Prompts for REST API DataSource Configuration
 *
 * The user has already picked a REST API connection (which owns baseUrl +
 * auth). This prompt turns their natural-language request into:
 *   - `code`: a single async JavaScript function expression that performs the
 *     fetch (including any pagination / looping logic) and returns rows.
 *   - `explanation`: one-line summary of what the function does.
 *
 * Secrets MUST be referenced only via the placeholder vocabulary below, and
 * only inside string literals / template literals. The main-process runner
 * substitutes placeholders using credentials decrypted from the OS keychain
 * before evaluating the function.
 *
 * A connection carries an open-ended key/value list (`apiParams`); each key
 * becomes one placeholder. The key NAMES are public — they live on the saved
 * connection — while the values stay encrypted, so the prompt can name every
 * token the user configured without ever revealing a secret.
 *
 * Legacy connections (saved before the key/value editor) still carry the old
 * authType fields; their placeholder vocabulary is scoped to that authType so
 * a Bearer connection won't see `{{BASIC_USERNAME}}`, etc.
 */

const { buildParamTokens } = require('../lib/apiPlaceholders');

// Placeholders common to every REST API request.
const BASE_PLACEHOLDERS = ['{{BASE_URL}}'];

// Auth-scoped placeholders. Keep in sync with ApiFetch.js `buildPlaceholderMap`.
const AUTH_PLACEHOLDERS = {
  none: [],
  bearer: ['{{AUTH_HEADER_NAME}}', '{{AUTH_HEADER_VALUE}}', '{{BEARER_TOKEN}}'],
  apiKey: ['{{AUTH_HEADER_NAME}}', '{{AUTH_HEADER_VALUE}}', '{{API_KEY_VALUE}}'],
  basic: ['{{AUTH_HEADER_NAME}}', '{{AUTH_HEADER_VALUE}}', '{{BASIC_USERNAME}}', '{{BASIC_PASSWORD}}'],
};

function placeholdersFor(authType, paramKeys = []) {
  const auth = AUTH_PLACEHOLDERS[authType] || AUTH_PLACEHOLDERS.none;
  const custom = buildParamTokens(paramKeys).map(p => `{{${p.token}}}`);
  return [...BASE_PLACEHOLDERS, ...auth, ...custom];
}

// Describes the user's own key/value entries: what each token is called and
// which key it came from, so the model can pick the right one by name.
function paramGuidance(paramKeys) {
  const tokens = buildParamTokens(paramKeys);
  if (tokens.length === 0) return '';

  const lines = tokens
    .map(({ key, token }) => `- \`{{${token}}}\` — the value the user saved under "${key}"`)
    .join('\n');

  return `**Connection parameters**
The user saved ${tokens.length} key/value entr${tokens.length === 1 ? 'y' : 'ies'} on this
connection. You can read the key names but never the values — reference a value
only through its placeholder:
${lines}

Decide from the key name and the user's request where each one belongs — a
request header, a query-string parameter, or a field in the request body. A key
that looks like a header name (\`Authorization\`, \`X-API-Key\`, anything with a
dash) is almost always a header; a key like \`tenant_id\` or \`page_size\` is
almost always a query parameter. Include only the entries the request actually
needs. If you cannot tell where one belongs and it matters, ask.`;
}

// Auth-specific guidance the model needs in order to write correct headers.
// Each branch only describes its own scheme — we do not mention other schemes
// so the model has a single, unambiguous path.
function authGuidance({ authType, apiKeyName, basicUser }) {
  switch (authType) {
    case 'bearer':
      return `**Authentication — Bearer Token**
This connection authenticates with a Bearer token. Attach the auth header on
every request using the resolved header placeholders:
\`\`\`javascript
headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' }
\`\`\`
At runtime \`{{AUTH_HEADER_NAME}}\` becomes \`Authorization\` and
\`{{AUTH_HEADER_VALUE}}\` becomes \`Bearer <token>\`. If you need the raw token
inside a query string or request body, use \`{{BEARER_TOKEN}}\` instead.`;

    case 'apiKey': {
      const nameHint = apiKeyName && String(apiKeyName).trim()
        ? `\`${String(apiKeyName).trim()}\``
        : '`X-API-Key` (default when the user didn\'t set a header name)';
      return `**Authentication — API Key header**
This connection authenticates with an API key sent as a request header. The
header name is ${nameHint}. Attach it on every request using the resolved
header placeholders:
\`\`\`javascript
headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' }
\`\`\`
If the API expects the key in a query string or body instead of a header, use
\`{{API_KEY_VALUE}}\` in that location and OMIT the auth header.`;
    }

    case 'basic': {
      const userHint = basicUser && String(basicUser).trim()
        ? ` (username: \`${String(basicUser).trim()}\`)`
        : '';
      return `**Authentication — HTTP Basic**
This connection authenticates with HTTP Basic auth${userHint}. Attach the
pre-encoded auth header on every request using the resolved header
placeholders:
\`\`\`javascript
headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' }
\`\`\`
At runtime \`{{AUTH_HEADER_NAME}}\` becomes \`Authorization\` and
\`{{AUTH_HEADER_VALUE}}\` becomes \`Basic <base64(user:pass)>\` — the encoding is
done for you. Do NOT build the Base64 yourself. If the API requires the raw
credentials elsewhere, use \`{{BASIC_USERNAME}}\` and \`{{BASIC_PASSWORD}}\`.`;
    }

    case 'none':
    default:
      return `**Authentication — None**
This connection has no stored credentials at all. Do NOT add an
\`Authorization\` header, an API key header, or any credential query-string
parameters. Call the endpoint anonymously.`;
  }
}

// Example that matches how this connection carries its credentials. Mirrors
// the same style every example ships with — GET + axios + pagination guard —
// so the model has one concrete pattern to follow.
function authExample(authType, paramKeys = []) {
  const tokens = buildParamTokens(paramKeys);
  let headerLine = '';

  if (tokens.length > 0) {
    // Show the user's own entries in header position — the most common case,
    // and paramGuidance already tells the model when to move one elsewhere.
    const pairs = tokens
      .map(({ key, token }) => `        ['${key.replace(/'/g, "\\'")}']: '{{${token}}}'`)
      .join(',\n');
    headerLine = '      // Illustrative only — keep the entries this endpoint expects as headers,\n'
      + '      // and move the ones it expects in the query string or body to those places.\n'
      + `      headers: {\n${pairs},\n      },\n`;
  } else if (authType !== 'none') {
    headerLine = `      headers: { ['{{AUTH_HEADER_NAME}}']: '{{AUTH_HEADER_VALUE}}' },\n`;
  }

  return `\`\`\`javascript
async function fetchData({ axios }) {
  const rows = [];
  let page = 1;
  const MAX_PAGES = 500;
  while (page <= MAX_PAGES) {
    const res = await axios({
      method: 'GET',
      url: \`{{BASE_URL}}/items?page=\${page}&limit=100\`,
${headerLine}      timeout: 30000,
    });
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    if (items.length === 0) break;
    rows.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return rows;
}
\`\`\``;
}

const RestApiPrompts = {
  /**
   * Build the analysis prompt. The model decides whether to answer, ask a
   * follow-up, or return a complete fetch function.
   */
  restApiAnalysisRequest: ({
    userRequest,
    connectionAuthType,
    connectionBaseUrl,
    connectionApiKeyName = '',
    connectionBasicUser = '',
    connectionParamKeys = [],
    conversationHistory = '',
    // The table this node already writes, when it is being rebuilt. Downstream
    // nodes read it by name, so the model is told to keep it.
    currentCollectionName = null,
  }) => {
    const authType = connectionAuthType || 'none';
    const paramKeys = Array.isArray(connectionParamKeys) ? connectionParamKeys : [];
    const vocabulary = placeholdersFor(authType, paramKeys);
    const params = paramGuidance(paramKeys);
    // The legacy authType block only applies to connections saved before the
    // key/value editor. When the user has their own entries, those ARE the
    // credentials — don't also tell the model the connection is unauthenticated.
    const legacyAuth = (authType === 'none' && params) ? '' : authGuidance({
      authType,
      apiKeyName: connectionApiKeyName,
      basicUser: connectionBasicUser,
    });
    const guidance = [params, legacyAuth].filter(Boolean).join('\n\n');
    const example = authExample(authType, paramKeys);

    return `
You are a REST API integration expert helping a non-technical user pull data
from an HTTP endpoint. A connection named "REST API" is already selected; it
carries the base URL and auth credentials. You never see the raw credentials —
you only use placeholder tokens in your output.

**Connection context**
- Base URL: ${connectionBaseUrl || '(not set — user must supply full URLs)'}
- Saved parameter keys: ${paramKeys.length ? paramKeys.map(k => `"${k}"`).join(', ') : '(none)'}
- Legacy auth type: ${authType}

**Current user request**
"${userRequest}"

**Your task**
Write a SINGLE JavaScript async function expression that uses the injected
\`axios\` to fetch the requested data and returns the resulting rows as an
array of plain objects. The function may loop over pages, cursor tokens, or
related endpoints — put any looping logic inside the function itself.

**Function contract**
- It is an async function expression. It may be named or anonymous.
- It takes one argument: \`{ axios }\`.
- It returns an array of plain objects (one per row). If the API returns a
  single object, wrap it as \`[obj]\`. If it returns nothing, return \`[]\`.
- No \`require\`, no \`import\`, no module exports, no top-level statements
  outside the function. Only the function expression itself.
- Use standard JS only (\`let\`, \`const\`, \`while\`, \`for\`, \`await\`, etc.).
- Let HTTP errors throw. Never set \`validateStatus\` and never catch a 4xx/5xx
  to return \`[]\` or the error body: a wrong endpoint or a rejected key must
  fail the fetch, not become rows. (The runtime rejects error statuses anyway.)

**Placeholder vocabulary** — the ONLY tokens you may emit for this connection.
They MUST appear only inside JS string literals or template literals, never as
identifiers or bare object keys.
${vocabulary.map(p => `- ${p}`).join('\n')}

- Use \`{{BASE_URL}}\` as the URL prefix when the user's request is relative.
- Do NOT invent placeholders outside this list. Do NOT write raw tokens,
  passwords, or api keys inline.

${guidance}

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. If you need to explain something, answer a question, or say why you cannot proceed, put that text inside the "followUpQuestion" field and set "action" to "ask_questions" — never write prose outside the JSON. Any character outside the JSON object will break parsing and cause the request to fail.

Return JSON with EXACTLY this shape (no extra keys):

\`\`\`json
{
  "action": "ask_questions" | "create_plan",
  "followUpQuestion": "single clear question (only if action is ask_questions)",
  "code": "async function fetchData({ axios }) { /* ... */ return rows; }",
  "explanation": "One sentence describing what the function does, including any looping behavior.",
  "endpoint": "the method and the URL the function requests, nothing else, e.g. GET {{BASE_URL}}latest or GET https://api.example.com/todos?userId=1",
  "collectionName": "snake_case name of the table the fetched rows are stored in"
}
\`\`\`

**collectionName** (required with create_plan): the rows are stored as a local
table, and this is its name. Other nodes in the workflow read the table by this
name, so it is part of the node's identity.
${currentCollectionName
    ? `- This node already writes the table "${currentCollectionName}". Return exactly that
  name unless the user explicitly asks to rename the table.`
    : `- Name it for what the rows ARE, not for what the user typed: "exchange_rates",
  "github_issues", "open_orders". 1-4 lowercase words joined by underscores,
  letters, digits and underscores only.`}

RULES:

1. There are exactly TWO actions, and every request ends in one of them — you
   either write the function, or you ask. You are a builder, not a chat partner:
   you do not answer questions as an end in itself.

2. **ask_questions** — you need one more detail before you can write the
   function, the user asked something informational, or you cannot do what was
   asked. Fill \`followUpQuestion\` — answer what they asked inside it if they
   asked something, then say what you still need. Leave code/explanation/
   endpoint/collectionName as nulls.

3. **create_plan** — you have enough to describe the exact call. Populate
   \`code\`, \`explanation\`, \`endpoint\` and \`collectionName\`. \`endpoint\`
   labels the node on the canvas: the one request it makes, or the first page
   of a paginated one. Write it as a METHOD and the full URL that request goes
   to — the URL after any rewriting the code does, so if the code turns
   \`{{BASE_URL}}\` into a different path, write that path out. No comments, no
   explanation, no parentheses. Never put a credential in it — placeholders only.

4. \`code\` MUST be a single async function expression. It is passed directly
   to \`new Function("return (" + code + ");")\` in the runtime, so a function
   declaration like \`async function fetchData(...) { ... }\` works — it is
   wrapped to become an expression.

5. Prefer sensible defaults for the user (e.g. GET, \`Accept: application/json\`,
   30s timeout via \`timeout: 30000\` in axios config, reasonable page size).

6. For pagination, loop until the API returns no more results, a \`next\`
   cursor is absent, or a page is partial — your choice, but make it correct
   for the API at hand. Guard against infinite loops with an upper bound
   (e.g. 500 pages).

**Example — paginated GET for this connection**

${example}

Return ONLY the JSON object. No markdown fences, no commentary.
`;
  },
};

module.exports = RestApiPrompts;
module.exports.default = RestApiPrompts;
module.exports.placeholdersFor = placeholdersFor;
