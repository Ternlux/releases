/**
 * Backend AI provider module (CommonJS).
 *
 * Single source of truth for SDK calls to OpenAI, Anthropic, and Gemini. The
 * renderer reaches these through the `ai:*` IPC handlers in electron.js so
 * that decrypted API keys never leave the main process.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// Dev-only prompt log. Single JSON file at frontend/dev-logs/ai-prompts.json
// — reset on the first callAI invocation of each process, then re-written
// (whole array) after every log entry so the file stays valid JSON at rest.
// Disabled when NODE_ENV=production. Failures are swallowed.
const PROMPT_LOG_PATH = path.join(__dirname, '..', 'dev-logs', 'ai-prompts.json');
const promptLogEntries = [];
let promptLogInitialized = false;

// Registry prompt kinds whose rendered SYSTEM PROMPT is logged verbatim next to
// their promptMeta. The params alone cannot answer "what did the model actually
// read" — e.g. whether a rule in the main agent's prompt was present when it
// picked a tool — so for these the text is kept too.
const PROMPT_KINDS_LOGGED_VERBATIM = new Set(['main']);
// kind → { text, entryIndex } of the last verbatim system prompt written. An
// agent loop resends the same text on every step of a turn; repeats point back
// at the entry that holds it instead of re-recording it.
const lastLoggedSystemPrompt = new Map();

function ensurePromptLogInitialized() {
  if (promptLogInitialized) return;
  fs.mkdirSync(path.dirname(PROMPT_LOG_PATH), { recursive: true });
  promptLogEntries.length = 0;
  lastLoggedSystemPrompt.clear();
  promptLogInitialized = true;
}

/**
 * Drop keys that carry no information, recursively.
 *
 * A logged turn is read by a person looking for what differed between two
 * calls, and `"text": ""` / `"chatHistory": []` / `"thinkingTokens": null` are
 * noise they have to read past every time. `false` and `0` are KEPT — "not
 * truncated" and "no cache hit" are findings, not absences.
 */
function compactLogValue(value) {
  if (Array.isArray(value)) {
    const out = value.map(compactLogValue).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactLogValue(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === null || value === undefined || value === '') return undefined;
  return value;
}

function logPromptToFile(entry) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    ensurePromptLogInitialized();
    promptLogEntries.push(compactLogValue(entry) || {});
    fs.writeFileSync(PROMPT_LOG_PATH, JSON.stringify(promptLogEntries, null, 2));
  } catch (_err) {
    // intentional: never propagate logging errors
  }
}

/**
 * What a log entry records about the prompt itself.
 *
 * With a `promptMeta` (built by chat/prompts.js) the entry carries the prompt's
 * KIND and the PARAMETERS it was built from — `{ kind: 'main', params: { toolMode:
 * true, isNewChat: false, focusedNodeType: 'join', ... } }` — and drops the
 * rendered text. That text is the same thousands of tokens on every call; what
 * actually differs between two calls, and what you need when reading the log, is
 * the parameters.
 *
 * Kinds in PROMPT_KINDS_LOGGED_VERBATIM also carry the system prompt text: in
 * full the first time it appears, then `systemPromptSameAsEntry: <index>` (an
 * index into the log array) while it is unchanged.
 *
 * Without one (skills, generated code, anything not routed through the registry)
 * the old verbatim behaviour is kept so nothing silently stops being logged.
 */
function promptDescriptor({ promptMeta, systemPrompt = null, prompt = null }) {
  if (promptMeta) {
    if (!systemPrompt || !PROMPT_KINDS_LOGGED_VERBATIM.has(promptMeta.kind)
        || process.env.NODE_ENV === 'production') {
      return { promptMeta };
    }
    try {
      ensurePromptLogInitialized();
      // The entry this descriptor belongs to is pushed next.
      const entryIndex = promptLogEntries.length;
      const last = lastLoggedSystemPrompt.get(promptMeta.kind);
      if (last && last.text === systemPrompt) {
        return { promptMeta, systemPromptSameAsEntry: last.entryIndex };
      }
      lastLoggedSystemPrompt.set(promptMeta.kind, { text: systemPrompt, entryIndex });
    } catch (_err) {
      // intentional: logging must never affect the call
    }
    return { promptMeta, systemPrompt };
  }
  return {
    ...(systemPrompt !== null ? { systemPrompt } : {}),
    ...(prompt !== null ? { prompt } : {}),
  };
}

// OpenAI-compatible providers. Each exposes a `/chat/completions` endpoint that
// the `openai` SDK can drive by overriding `baseURL`, so they all route through
// callOpenAI. `requiresKey: false` providers are local servers (Ollama, LM
// Studio) that accept any non-empty key. `custom` has no fixed baseURL — the
// user supplies one in the UI, stored alongside the key.
const OPENAI_COMPAT_PROVIDERS = {
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini', requiresKey: true },
  groq:       { label: 'Groq',       baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', requiresKey: true },
  together:   { label: 'Together AI', baseURL: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', requiresKey: true },
  mistral:    { label: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest', requiresKey: true },
  nvidia:     { label: 'NVIDIA AI', baseURL: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.1-70b-instruct', requiresKey: true },
  ollama:     { label: 'Ollama',     baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.1', requiresKey: false },
  lmstudio:   { label: 'LM Studio',  baseURL: 'http://localhost:1234/v1', defaultModel: 'local-model', requiresKey: false },
  custom:     { label: 'Custom (OpenAI-compatible)', baseURL: '', defaultModel: '', requiresKey: false }
};

// Built-in providers first (preferred when several are configured), then any
// configured OpenAI-compatible provider as a fallback.
const PROVIDER_PRIORITY = ['openai', 'claude', 'gemini', ...Object.keys(OPENAI_COMPAT_PROVIDERS)];

const DEFAULT_MODELS = {
  openai: 'gpt-5.2',
  claude: 'claude-sonnet-4-5-20250929',
  gemini: 'gemini-2.0-flash'
};

// Total context window (input + output) per model, in tokens. Used to trim
// chat history before dispatching to a provider. Keys are matched exactly
// first, then by prefix (see windowForModel).
const MODEL_CONTEXT_WINDOWS = {
  // OpenAI
  'gpt-5.2': 400000,
  'gpt-5': 400000,
  'gpt-4.1': 1000000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  // Anthropic
  'claude-sonnet-4-5-20250929': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-opus': 200000,
  // Google
  'gemini-2.0-flash': 1000000,
  'gemini-1.5-pro': 2000000,
  'gemini-1.5-flash': 1000000
};

const FALLBACK_CONTEXT_WINDOW = 128000;

// Output budget used when neither the caller nor the user's saved setting
// supplies one. Reasoning models spend part of this budget thinking before they
// write a single visible token, so a small default silently truncates long
// structured answers (workflow plans, generated transformer code) mid-JSON.
const DEFAULT_MAX_TOKENS = 16000;

// ── Request timeout ────────────────────────────────────────────────────────
//
// All three SDKs ship the same default: a TEN-MINUTE request timeout with
// automatic retries stacked on top of it. A connection that opens and then
// never answers therefore costs ten minutes of complete silence before the SDK
// even begins its first retry — which is what froze one workflow build for 608
// seconds on a join:analysis call the model itself answered in two.
//
// So every call here gets one deadline, applied in two places that back each
// other up: the SDK clients take it as their own timeout (so they abort the
// socket), and callAI races the whole call against it (so a provider that
// ignores its own timeout still can't hang the app). Generous by design — it is
// a "this will never finish" limit, not a speed limit. Override it in ms with
// TERNLUX_AI_TIMEOUT_MS for a slow local model server.
const AI_TIMEOUT_MS = Number(process.env.TERNLUX_AI_TIMEOUT_MS) > 0
  ? Number(process.env.TERNLUX_AI_TIMEOUT_MS)
  : 120000;
// One retry, not the SDKs' two: each attempt can now cost AI_TIMEOUT_MS, and
// three of those is back to the wait this exists to remove.
const AI_MAX_RETRIES = 1;

/** Client options every SDK construction in this file shares. */
function sdkClientOptions(extra = {}) {
  return { timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES, ...extra };
}

/**
 * Reject if `promise` hasn't settled within `ms`. The provider call keeps
 * running in the background — the SDK's own timeout is what actually cancels
 * it; this is the guarantee that the APP stops waiting either way.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} didn't respond within ${Math.round(ms / 1000)}s. It may be overloaded — try again, or pick another provider in Settings → AI Provider.`);
      e.code = 'AI_TIMEOUT';
      e.userFacing = true;
      reject(e);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The ceiling actually sent to a provider. Anthropic REQUIRES max_tokens (a
 * request without it is a 400), so it gets the static fallback; OpenAI and
 * Gemini treat it as optional, so with nothing specified the field is omitted
 * and the model's own default applies.
 */
function effectiveMaxTokens(provider, maxTokens) {
  if (maxTokens) return maxTokens;
  return String(provider || '').toLowerCase() === 'claude' ? DEFAULT_MAX_TOKENS : null;
}

function windowForModel(model) {
  if (!model) return FALLBACK_CONTEXT_WINDOW;
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Prefix match — e.g. 'claude-sonnet-4-5-20250929-preview' matches 'claude-sonnet-4-5-20250929'.
  const keys = Object.keys(MODEL_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return MODEL_CONTEXT_WINDOWS[key];
  }
  return FALLBACK_CONTEXT_WINDOW;
}

// Per-model token limits as the provider itself publishes them, fetched with
// the same listModels call that fills the model picker in Settings. This is the
// authority on how big a model's window is; the static table above is only the
// last resort for providers that publish nothing (OpenAI's /models, local
// servers) or when the lookup can't run at all.
//
// Cached per provider for the process — a models list is one request and these
// numbers only change on a provider release, so refetching it on every agent
// step would be pure latency. A FAILED lookup is cached too (as an empty map,
// for a shorter window) so being offline or between keys doesn't add a doomed
// round trip to every turn.
const MODEL_LIMITS_TTL_MS = 6 * 60 * 60 * 1000;
const MODEL_LIMITS_ERROR_TTL_MS = 5 * 60 * 1000;
const modelLimitsCache = new Map(); // provider → { ts, ttl, models: Map<id, {…}> }

async function loadModelLimits(provider, { apiKey, baseURL } = {}) {
  const key = String(provider || '').toLowerCase();
  const hit = modelLimitsCache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.models;

  const models = new Map();
  let ttl = MODEL_LIMITS_TTL_MS;
  // An OpenAI-compatible provider with no base URL has nowhere to ask; sending
  // its key to api.openai.com (the SDK's default) would just 401. Skip.
  if (OPENAI_COMPAT_PROVIDERS[key] && !baseURL) {
    modelLimitsCache.set(key, { ts: Date.now(), ttl: MODEL_LIMITS_ERROR_TTL_MS, models });
    return models;
  }
  try {
    for (const m of (await listModels(provider, { apiKey, baseURL })) || []) {
      models.set(m.value, {
        maxInputTokens:  Number(m.maxInputTokens) || null,
        maxOutputTokens: Number(m.maxOutputTokens) || null,
      });
    }
  } catch (_err) {
    // Offline, bad key, or a provider with no models endpoint. Callers fall
    // back to the static table; retry sooner than a successful lookup.
    ttl = MODEL_LIMITS_ERROR_TTL_MS;
  }
  modelLimitsCache.set(key, { ts: Date.now(), ttl, models });
  return models;
}

/**
 * The selected model's real limits: `{ contextWindow, maxOutputTokens }`.
 *
 * `contextWindow` always resolves to a number (published value, else the static
 * table). `maxOutputTokens` is null when the provider publishes no cap, which
 * means "don't clamp" — inventing one here would silently truncate answers on
 * models that can write more.
 */
async function resolveModelLimits(provider, model, { apiKey, baseURL } = {}) {
  let entry = null;
  if (model) {
    const models = await loadModelLimits(provider, { apiKey, baseURL });
    entry = models.get(model) || null;
    // Settings may hold an alias ('claude-opus-5') while the models endpoint
    // lists dated ids ('claude-opus-5-20260115'), or vice versa. Match either
    // direction, longest id first so the most specific entry wins.
    if (!entry) {
      const ids = [...models.keys()].sort((a, b) => b.length - a.length);
      const match = ids.find((id) => id.startsWith(model) || model.startsWith(id));
      if (match) entry = models.get(match);
    }
  }
  return {
    contextWindow: entry?.maxInputTokens || windowForModel(model),
    maxOutputTokens: entry?.maxOutputTokens || null,
  };
}

/**
 * Tokens the trimmers set aside for the answer, and the ceiling sent to the
 * provider, reconciled against the model's real limits.
 *
 * Two independent failures this prevents, both of which the user sees as a bad
 * answer rather than an error:
 *
 *   - A request over the model's published output cap is a 400 from the
 *     provider. The Max Tokens setting is global, so it outlives the model it
 *     was chosen for.
 *   - A reserve that swallows the whole context window leaves a zero or
 *     negative input budget, and the trimmers respond by deleting EVERY
 *     cross-turn message. Nothing reports it — plain conversation carries no
 *     stepIndex, so onTrim stays silent — and the model just answers with no
 *     memory of the conversation. Half the window is the floor input keeps.
 */
function reconcileTokenBudget(maxTokens, { contextWindow, maxOutputTokens }) {
  const requested = Number(maxTokens) || 0;
  const capped = maxOutputTokens ? Math.min(requested || maxOutputTokens, maxOutputTokens) : requested;
  return {
    sendMaxTokens: capped || null,
    reserve: Math.min(capped || DEFAULT_MAX_TOKENS, Math.floor(contextWindow / 2)),
  };
}

// Rough heuristic: ~4 chars per token for English-ish text. Good enough to
// keep us safely under provider limits; we never need exact counts here.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateMessageTokens(msg) {
  // Per-message overhead for role/formatting tokens that providers add.
  return estimateTokens(msg?.text || msg?.content || '') + 4;
}

/**
 * Stand-in text for tool results this function had to remove.
 *
 * The calls themselves stay visible — only their output goes. A caller that
 * cannot see a result but also cannot tell that it ever ran will either answer
 * from nothing or re-issue the call and be refused by a dedup guard that still
 * remembers it. Both failures are silent, so the note is explicit on all three
 * points: it ran, the output is gone, running it again is allowed.
 */
function truncatedResultNote(actions) {
  const calls = (Array.isArray(actions) ? actions : []).map((a) => {
    let args = '';
    try { args = JSON.stringify(a.args || {}); } catch { args = ''; }
    if (args.length > 200) args = `${args.slice(0, 200)}…`;
    return `  - ${a.tool}(${args})`;
  }).join('\n');
  return 'These calls ran, but their results were removed from the message history to fit the '
    + `context window:\n${calls}\n`
    + 'Their output is NOT available to you. If you still need this data, call the tool again — '
    + 'repeat calls are allowed for exactly these removed results.';
}

/**
 * Shrink chat history until the full request (system prompt + surviving history
 * + new prompt + reserved response tokens) fits inside the model's context
 * window.
 *
 * Entries marked `pinned` are an agent loop's replayed tool work: an assistant
 * turn listing the calls made that step, followed by the user turn carrying
 * their results. Both carry `stepIndex` and `actions` so this function can
 * degrade them intelligibly rather than deleting them. Three passes, least
 * damaging first:
 *
 *   1. drop ordinary conversation, oldest first
 *   2. replace tool RESULTS with a note, oldest first, keeping the calls
 *      visible — this is where nearly all the bytes are
 *   3. last resort, drop whole loop turns in call+result PAIRS
 *
 * Throws if the new prompt alone cannot fit alongside the response budget —
 * trimming history can't rescue that case.
 *
 * @param {Object} params
 * @param {string} params.prompt              The new user prompt.
 * @param {Array}  [params.chatHistory]       Oldest-first list of {sender,text} entries.
 * @param {string} params.model               Model id used to look up the window.
 * @param {number} params.maxResponseTokens   Tokens reserved for the response.
 * @param {string} [params.systemPrompt]
 * @param {Function} [params.onTrim]          Called as ({ truncatedSteps: Set<number> })
 *                                            when loop turns were degraded or dropped, so
 *                                            the caller can stop refusing those repeat calls.
 * @returns {Array} Trimmed chatHistory (a new array; input is not mutated).
 */
function trimChatHistoryToFit({ prompt, chatHistory = [], model, contextWindow: window_, maxResponseTokens, systemPrompt = null, onTrim = null }) {
  const contextWindow = Number(window_) || windowForModel(model);
  const reserved = Number(maxResponseTokens) || 0;
  const promptTokens = estimateTokens(prompt) + 4;
  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) + 4 : 0;
  const budget = contextWindow - reserved - systemTokens;

  if (promptTokens > budget) {
    const err = new Error(
      `Prompt is too long for model ${model}: needs ~${promptTokens} input tokens but only ${budget} are available ` +
      `(context window ${contextWindow}, reserved ${reserved} for response, ${systemTokens} for system prompt).`
    );
    err.code = 'PROMPT_TOO_LONG';
    throw err;
  }

  const trimmed = Array.isArray(chatHistory) ? [...chatHistory] : [];
  let historyTokens = trimmed.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const over = () => historyTokens + promptTokens > budget;

  // Steps whose results the caller can no longer see. Reported through onTrim.
  const truncatedSteps = new Set();
  const noteStep = (entry) => {
    if (Number.isFinite(entry?.stepIndex)) truncatedSteps.add(entry.stepIndex);
  };

  // Pass 1 — ordinary conversation, oldest first. Loop turns arrive last and
  // are pinned, so they survive this pass untouched.
  while (over() && trimmed.length > 0 && !trimmed[0].pinned) {
    historyTokens -= estimateMessageTokens(trimmed.shift());
  }

  // Pass 2 — swap tool results for a note, oldest first. The assistant turn
  // stating what was called is left alone, so the model keeps a complete record
  // of what it did and only loses the payloads.
  for (let i = 0; i < trimmed.length && over(); i++) {
    const entry = trimmed[i];
    if (!entry.pinned || entry.sender !== 'user' || entry.truncated) continue;
    if (!Array.isArray(entry.actions) || entry.actions.length === 0) continue;

    const note = { ...entry, truncated: true, text: truncatedResultNote(entry.actions) };
    historyTokens += estimateMessageTokens(note) - estimateMessageTokens(entry);
    trimmed[i] = note;
    noteStep(entry);
  }

  // Pass 3 — everything is already a note and it still doesn't fit. Drop loop
  // turns outright, oldest first, in call+result PAIRS: dropping half a pair
  // leaves the model reading results for calls it cannot see. Only entries
  // belonging to a step are eligible — the question being answered is marked
  // `keep` and survives even when every trace of the work does.
  while (over()) {
    const i = trimmed.findIndex((e) => !e.keep && Number.isFinite(e.stepIndex));
    if (i === -1) break;
    const dropped = trimmed.splice(i, 1)[0];
    historyTokens -= estimateMessageTokens(dropped);
    noteStep(dropped);
    const partner = trimmed[i];
    if (dropped.sender === 'assistant' && partner?.pinned && partner.sender === 'user'
        && partner.stepIndex === dropped.stepIndex) {
      historyTokens -= estimateMessageTokens(trimmed.splice(i, 1)[0]);
      noteStep(partner);
    }
  }

  if (typeof onTrim === 'function' && truncatedSteps.size > 0) {
    try { onTrim({ truncatedSteps }); } catch (_err) { /* reporting must never break the call */ }
  }
  return trimmed;
}

function stripMarkdownCodeBlocks(text) {
  if (!text) return text;
  const fenced = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.trim().match(fenced);
  if (match) return match[1].trim();
  const bare = /^```\s*\n?([\s\S]*?)\n?```$/;
  const bareMatch = text.trim().match(bare);
  if (bareMatch) return bareMatch[1].trim();
  return text;
}

async function callGemini(prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = [], onUsage = null, jsonMode = false) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const generationConfig = maxTokens ? { maxOutputTokens: maxTokens } : {};
  // Gemini has no tool API in this app (see TOOL_CAPABLE_PROVIDERS), so every
  // agent turn it serves is a JSON contract parsed out of free text — which is
  // exactly where it wraps the object in prose or markdown fences. JSON mode
  // constrains decoding to a well-formed JSON value, so the reply parses on the
  // first try instead of needing stripMarkdownCodeBlocks + a repair round trip.
  // No responseSchema: our contracts are unions ("answer_directly" OR a plan,
  // Schema A OR Schema B) that a single fixed schema can't express without
  // forcing fields the model shouldn't emit.
  //
  // Gemini 1.0 is the one family that rejects responseMimeType outright, so a
  // user who picked one from the (dynamic) model list keeps the old fenced-text
  // path instead of getting a hard request failure.
  if (jsonMode && !/^gemini-(pro|1\.0)/i.test(String(model || ''))) {
    generationConfig.responseMimeType = 'application/json';
  }
  // Gemini's equivalent of Anthropic's `system` / OpenAI's system message. It
  // MUST be sent: for every agent path in this app the system prompt carries the
  // turn contract (the JSON envelope the reply has to match, the tool catalogue,
  // the planner brief). Dropping it leaves the model answering in free prose and
  // every downstream JSON.parse failing.
  // This SDK takes its request options when the MODEL HANDLE is made, not per
  // call, and applies them to every request that handle issues. It has no
  // retries of its own, so the timeout is the whole story here.
  const geminiModel = genAI.getGenerativeModel({
    model,
    generationConfig,
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
  }, { timeout: AI_TIMEOUT_MS });

  let fullPrompt = prompt;
  if (chatHistory && chatHistory.length > 0) {
    const historyText = chatHistory
      .map((msg) => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`)
      .join('\n');
    fullPrompt = `Previous Conversation:\n${historyText}\n\nCurrent Request:\n${prompt}`;
  }

  const result = await geminiModel.generateContent(fullPrompt);
  const response = await result.response;

  if (typeof onUsage === 'function') {
    const u = response.usageMetadata || {};
    const finishReason = response.candidates?.[0]?.finishReason || null;
    onUsage({
      inputTokens:    u.promptTokenCount ?? null,
      outputTokens:   u.candidatesTokenCount ?? null,
      thinkingTokens: u.thoughtsTokenCount ?? null,
      finishReason,
      truncated:      finishReason === 'MAX_TOKENS',
    });
  }

  return stripMarkdownCodeBlocks(response.text());
}

// The Anthropic SDK refuses a NON-streaming request whose max_tokens implies a
// run past its 10-minute ceiling — `(60min * max_tokens) / 128000 > 10min`, so
// anything above ~21.3k tokens throws locally before a request is ever sent.
// Streaming has no such limit (its timeout only covers time-to-first-byte), so
// big budgets go over the stream helper, which collects the same final Message.
const CLAUDE_NONSTREAMING_MAX_TOKENS = 20000;

/**
 * One Messages call, streamed or not depending on the output budget. Returns
 * the same shape either way, so callers never have to care which path ran.
 */
async function createClaudeMessage(anthropic, params) {
  if ((params.max_tokens || 0) <= CLAUDE_NONSTREAMING_MAX_TOKENS) {
    return anthropic.messages.create(params);
  }
  return anthropic.messages.stream(params).finalMessage();
}

async function callClaude(prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = [], onUsage = null) {
  const AnthropicCtor = Anthropic.default || Anthropic;
  const anthropic = new AnthropicCtor(sdkClientOptions({ apiKey }));

  const messages = [];
  for (const msg of chatHistory || []) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    });
  }
  messages.push({ role: 'user', content: prompt });

  // Anthropic's Messages API REQUIRES max_tokens — omitting it returns a 400.
  // Always send it, defaulting when the caller didn't specify one.
  const budget = maxTokens || DEFAULT_MAX_TOKENS;
  const requestParams = { model, max_tokens: budget, messages };

  // Claude Opus 5 (and later) think by DEFAULT — omitting `thinking` runs
  // adaptive thinking, and max_tokens caps thinking + answer together. On a
  // small budget the whole allowance can go to thinking, leaving no text at
  // all. Short, deterministic calls (titles, tiny JSON blobs) don't benefit
  // from thinking, so turn it off for them; `disabled` is accepted at the
  // default effort level.
  if (budget < 1024) {
    requestParams.thinking = { type: 'disabled' };
  }

  if (systemPrompt) requestParams.system = systemPrompt;

  const message = await createClaudeMessage(anthropic, requestParams);

  // `content` is a list of blocks, and the first one is NOT necessarily the
  // answer — with thinking on it's a `thinking` block (whose text is empty
  // unless display:"summarized" is requested). Collect every text block.
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const thinkingTokens = message?.usage?.output_tokens_details?.thinking_tokens || 0;

  // Reported before any throw below, so a truncated call still logs what it
  // spent — that's the number you need to pick a bigger ceiling.
  if (typeof onUsage === 'function') {
    onUsage({
      inputTokens:    message?.usage?.input_tokens ?? null,
      outputTokens:   message?.usage?.output_tokens ?? null,
      thinkingTokens: thinkingTokens || null,
      cacheReadInputTokens:     message?.usage?.cache_read_input_tokens ?? null,
      cacheCreationInputTokens: message?.usage?.cache_creation_input_tokens ?? null,
      finishReason:   message?.stop_reason || null,
      truncated:      message?.stop_reason === 'max_tokens',
    });
  }
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();

  // Ran out of output budget: whatever came back is cut off mid-sentence (or
  // mid-JSON), so don't hand it downstream as if it were a complete answer —
  // that surfaces as a confusing "invalid JSON" failure. Report it as its own
  // recoverable condition so callers can offer to continue with more room.
  if (message?.stop_reason === 'max_tokens') {
    const e = new Error(
      `Claude ran out of output space (${budget} tokens) before finishing its answer` +
      `${thinkingTokens ? `; ${thinkingTokens} of them went to internal reasoning` : ''}.`
    );
    e.code = 'MAX_TOKENS';
    e.maxTokens = budget;
    e.partialText = text || null;
    throw e;
  }

  if (text) return stripMarkdownCodeBlocks(text);

  // No text came back — say why, so the message is actionable.
  if (message?.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new Error(`Claude declined this request${category ? ` (${category})` : ''}. Rephrase the request or switch to a different AI provider in Settings.`);
  }
  throw new Error(`Claude returned no text content (stop_reason: ${message?.stop_reason || 'unknown'}).`);
}

async function callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = [], baseURL = null, onUsage = null, jsonMode = false) {
  const OpenAICtor = OpenAI.default || OpenAI;
  // Local servers (Ollama, LM Studio) need no real key, but the SDK rejects an
  // empty apiKey — pass a placeholder when none was supplied.
  const clientOptions = sdkClientOptions({ apiKey: apiKey || 'not-needed' });
  if (baseURL) clientOptions.baseURL = baseURL;
  const openai = new OpenAICtor(clientOptions);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of chatHistory || []) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    });
  }
  messages.push({ role: 'user', content: prompt });

  const params = {
    model,
    messages,
  }
  // Optional for OpenAI — only send when the caller specified a cap.
  applyMaxTokens(params, maxTokens, baseURL);
  applyJsonMode(params, jsonMode, baseURL);

  const completion = await openai.chat.completions.create(params);

  if (typeof onUsage === 'function') {
    const u = completion.usage || {};
    const finishReason = completion.choices?.[0]?.finish_reason || null;
    onUsage({
      inputTokens:    u.prompt_tokens ?? null,
      outputTokens:   u.completion_tokens ?? null,
      // o-series / reasoning models bill hidden reasoning against the output cap.
      thinkingTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      finishReason,
      truncated:      finishReason === 'length',
    });
  }

  const text = completion.choices?.[0]?.message?.content || '';
  if (text) return stripMarkdownCodeBlocks(text);
  throw new Error('Invalid response format from OpenAI API');
}

// OpenAI exposes many non-chat models (embeddings, audio, image, moderation)
// through the same /models endpoint. Drop those so the model picker only offers
// models that chat.completions can actually drive.
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|dall-e|moderation|image|realtime|transcribe|search|similarity|davinci|babbage|^ada|curie)/i;

/**
 * Apply the output cap under the name the endpoint actually understands.
 *
 * OpenAI itself renamed `max_tokens` to `max_completion_tokens` and its
 * reasoning models accept ONLY the new name. Most OpenAI-COMPATIBLE servers
 * (Mistral, Together, NVIDIA, Ollama, LM Studio, and anything behind `custom`)
 * only implement the old one, and the strict ones reject an unknown field
 * outright — so a cap meant to protect the request is what fails it. A non-null
 * `baseURL` is exactly "not api.openai.com", which is the distinction that
 * matters here.
 */
function applyMaxTokens(params, maxTokens, baseURL) {
  if (!maxTokens) return params;
  if (baseURL) params.max_tokens = maxTokens;
  else params.max_completion_tokens = maxTokens;
  return params;
}

/**
 * Constrain decoding to a well-formed JSON object for calls whose reply is
 * parsed rather than displayed.
 *
 * Two deliberate narrowings, both of which turn a possible request FAILURE back
 * into the status quo (a fenced or prose-wrapped reply the existing
 * stripMarkdownCodeBlocks + repair path already handles):
 *
 *  - OpenAI proper only. `response_format` is an unknown field to many
 *    OpenAI-COMPATIBLE servers and the strict ones reject the whole request —
 *    the same trap `applyMaxTokens` documents. `baseURL != null` is exactly
 *    "not api.openai.com", so it is the discriminator here too.
 *  - The word "json" must appear in what we send. OpenAI rejects
 *    `json_object` outright when it doesn't ("messages must contain the word
 *    'json'"), and not every builder prompt says it.
 */
function applyJsonMode(params, jsonMode, baseURL) {
  if (!jsonMode || baseURL) return params;
  const mentionsJson = (params.messages || []).some(
    (m) => typeof m.content === 'string' && /json/i.test(m.content)
  );
  if (!mentionsJson) return params;
  params.response_format = { type: 'json_object' };
  return params;
}

/**
 * List the models a provider currently offers, via its own SDK/API — the
 * dynamic replacement for the hardcoded PROVIDER_MODELS list. Returns
 * `[{ value, label, maxOutputTokens, maxInputTokens }]` (value = model id used
 * in requests). The renderer enriches these with curated descriptions and falls
 * back to its bundled list when this throws (offline, bad key, etc.).
 *
 * Anthropic and Google publish per-model token limits on their models
 * endpoints, so the Max Tokens setting can be bounded by what the selected
 * model actually accepts. OpenAI's /models returns no limits — those come back
 * null and the UI falls back to a fixed ladder.
 *
 * @param {string} provider            'claude' | 'gemini' | 'openai' | any OpenAI-compatible id
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseURL]      Required for OpenAI-compatible providers.
 */
async function listModels(provider, { apiKey, baseURL } = {}) {
  const p = (provider || '').toLowerCase();

  if (p === 'claude') {
    const AnthropicCtor = Anthropic.default || Anthropic;
    const anthropic = new AnthropicCtor(sdkClientOptions({ apiKey }));
    const page = await anthropic.models.list({ limit: 1000 });
    // More recent models are returned first; preserve that order.
    // `max_tokens` (output cap) and `max_input_tokens` (context window) are
    // returned by the Models API; older API versions omit them → null.
    return (page.data || []).map((m) => ({
      value: m.id,
      label: m.display_name || m.id,
      maxOutputTokens: Number(m.max_tokens) || null,
      maxInputTokens: Number(m.max_input_tokens) || null,
    }));
  }

  if (p === 'gemini') {
    // @google/generative-ai has no list endpoint, so hit the REST models API.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey || '')}`;
    // Bounded like every other provider request here: this one runs on the way
    // into resolveModelLimits, so a hang costs every call that follows it.
    const res = await fetch(url, { signal: AbortSignal.timeout(AI_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Gemini models request failed: ${res.status} ${res.statusText}`);
    const body = await res.json();
    return (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        value: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || m.name,
        maxOutputTokens: Number(m.outputTokenLimit) || null,
        maxInputTokens: Number(m.inputTokenLimit) || null,
      }));
  }

  // openai + any OpenAI-compatible provider (same /models shape).
  const OpenAICtor = OpenAI.default || OpenAI;
  const clientOptions = sdkClientOptions({ apiKey: apiKey || 'not-needed' });
  if (baseURL) clientOptions.baseURL = baseURL;
  const openai = new OpenAICtor(clientOptions);
  const page = await openai.models.list();
  // OpenAI's /models carries no token limits — the UI falls back to a fixed
  // ladder when maxOutputTokens is null.
  const models = (page.data || [])
    .map((m) => ({ value: m.id, label: m.id, maxOutputTokens: null, maxInputTokens: null }))
    .filter((m) => !OPENAI_NON_CHAT.test(m.value));
  models.sort((a, b) => a.value.localeCompare(b.value));
  return models;
}

// Friendly provider display names for user-facing messages.
const PROVIDER_LABELS = {
  gemini: 'Gemini',
  claude: 'Claude',
  openai: 'OpenAI',
  chatgpt: 'OpenAI',
};

/** What a message calls this provider: built-in name, compat label, or the id. */
function providerLabel(provider) {
  const pk = String(provider || '').toLowerCase();
  return PROVIDER_LABELS[pk]
    || (OPENAI_COMPAT_PROVIDERS[pk] && OPENAI_COMPAT_PROVIDERS[pk].label)
    || (provider ? (String(provider).charAt(0).toUpperCase() + String(provider).slice(1)) : 'the AI provider');
}

/**
 * Translate a raw AI-provider error into a short, plain-language message a
 * non-technical user can act on. Raw provider strings (long stack traces,
 * "[GoogleGenerativeAI Error] 429 ... RESOURCE_EXHAUSTED", SDK JSON, etc.) are
 * hard to read; this maps the common failure classes to clear guidance while
 * preserving the original text on `.originalMessage` for logs/debugging.
 *
 * Returns an Error tagged `userFacing: true` so callers can surface it directly
 * instead of wrapping it in more technical framing.
 */
function humanizeAIError(err, provider, model) {
  const raw = (err && (err.message || String(err))) || 'Unknown error';
  const label = providerLabel(provider);
  const lower = raw.toLowerCase();
  // Pull an HTTP-ish status code if present anywhere in the message.
  const statusMatch = raw.match(/\b(400|401|403|404|408|409|413|429|500|502|503|504)\b/);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  let friendly;
  if (err && err.code === 'AI_TIMEOUT') {
    // withTimeout already wrote this for a person, naming the provider and the
    // limit it passed. Kept as-is so the number stays in the message.
    const e = new Error(err.message);
    e.userFacing = true;
    e.code = 'AI_TIMEOUT';
    e.provider = provider || null;
    e.originalMessage = raw;
    return e;
  }
  if (err && err.code === 'MAX_TOKENS') {
    // Already a precise, user-readable message — and the generic branches below
    // would misread "token"/"too long" as a context-window problem, which this
    // is not. Keep it, and carry the partial output so the caller can resume.
    //
    // A tool-calling turn is the exception: half a tool_use block has no valid
    // arguments, so there is nothing to stitch onto and no Continue button is
    // offered. Pointing the user at one would be a dead end.
    const e = new Error(err.resumable === false
      ? `${label} ran out of room before finishing this step. Raise Max Tokens in Settings → AI Provider, then send the message again.`
      : `${label} ran out of room before finishing its answer. Use Continue to have it pick up where it stopped.`);
    e.userFacing = true;
    e.code = 'MAX_TOKENS';
    e.resumable = err.resumable !== false;
    e.provider = provider || null;
    e.originalMessage = raw;
    e.maxTokens = err.maxTokens || null;
    e.partialText = err.partialText || null;
    return e;
  }
  if (status === 429 || /quota|rate.?limit|too many requests|resource_exhausted|insufficient_quota/i.test(lower)) {
    friendly = `${label} rejected the request because you've hit its rate limit or usage quota. Wait a minute and try again, check your plan/billing with the provider, or switch to a different AI provider in Settings → AI Provider.`;
  } else if (status === 401 || status === 403 || /api key not valid|invalid api key|invalid_api_key|unauthorized|permission_denied|authentication/i.test(lower)) {
    friendly = `${label} rejected your API key. Open Settings → AI Provider and check the key is correct and still active.`;
  } else if (status === 404 || /no longer available|is not found|not found|does not exist|unknown model|model_not_found/i.test(lower)) {
    friendly = `The selected ${label} model${model ? ` (${model})` : ''} isn't available. Pick a different model in Settings → AI Provider.`;
  } else if (/enotfound|econnrefused|etimedout|econnreset|network|fetch failed|failed to fetch|getaddrinfo|socket hang up|dns/i.test(lower)) {
    friendly = `Couldn't reach ${label}. Check your internet connection${provider && OPENAI_COMPAT_PROVIDERS[String(provider).toLowerCase()] ? ' and the provider base URL in Settings' : ''}, then try again.`;
  } else if (status === 500 || status === 502 || status === 503 || status === 504 || /overloaded|unavailable|server error|internal error|try again later/i.test(lower)) {
    friendly = `${label} is temporarily unavailable or overloaded. Please wait a moment and try again.`;
  } else if (/context length|maximum context|context window|too long|token limit|max_tokens|prompt is too long/i.test(lower)) {
    friendly = `The request is too large for this model's context window. Try a smaller input (fewer rows/columns) or a model with a larger context window.`;
  } else if (/timed out|timeout/i.test(lower)) {
    friendly = `${label} took too long to respond. Please try again.`;
  } else {
    // Unknown class — still strip obvious noise (leading "[Provider Error]:",
    // stack "at ..." lines) so the message reads cleanly.
    const cleaned = raw
      .split('\n')[0]
      .replace(/^\s*\[[^\]]*Error[^\]]*\]:?\s*/i, '')
      .trim();
    friendly = `${label} couldn't complete the request: ${cleaned || raw}`;
  }

  const e = new Error(friendly);
  e.userFacing = true;
  e.provider = provider || null;
  e.originalMessage = raw;
  if (status) e.status = status;
  if (err && err.code) e.code = err.code;
  return e;
}

/**
 * Provider-agnostic dispatcher. Caller supplies the apiKey explicitly.
 */
async function callAI(prompt, options = {}) {
  const { provider, model, maxTokens, apiKey, systemPrompt = null, chatHistory = [], baseURL = null, onTrim = null, jsonMode = false, promptMeta = null } = options;
  if (!provider) throw new Error('provider is required');
  const compatConf = OPENAI_COMPAT_PROVIDERS[provider.toLowerCase()];
  // Keyless OpenAI-compatible providers (local servers) may run without a key.
  if (!apiKey && (!compatConf || compatConf.requiresKey)) throw new Error('apiKey is required');

  // What this model actually accepts, straight from the provider's models
  // endpoint — the trimmer budgets against the real window instead of a guess,
  // and the ceiling we send can't exceed the real output cap.
  const limits = await resolveModelLimits(provider, model, { apiKey, baseURL: baseURL || compatConf?.baseURL });
  const { sendMaxTokens, reserve } = reconcileTokenBudget(maxTokens, limits);

  const trimmedHistory = trimChatHistoryToFit({
    prompt,
    chatHistory,
    model,
    contextWindow: limits.contextWindow,
    maxResponseTokens: reserve,
    systemPrompt,
    onTrim,
  });

  const requestEntry = {
    kind:        'request',
    ts:          new Date().toISOString(),
    provider,
    model:       model || null,
    // What the caller asked for (null when it didn't specify) vs. the ceiling
    // actually sent to the provider — the two differ whenever the default
    // applies, which is most internal calls.
    maxTokens:   maxTokens || null,
    maxTokensSent: effectiveMaxTokens(provider, sendMaxTokens),
    contextWindow: limits.contextWindow,
    // A caller that built its prompt through chat/prompts.js supplies the
    // descriptor for it — which prompt, and what was switched on. That replaces
    // the prompt TEXT here: the text is a constant of the build, re-recording it
    // on every call is what made this log unreadable (and enormous). Callers
    // that don't build through the registry still log verbatim.
    ...promptDescriptor({ promptMeta, systemPrompt, prompt }),
    chatHistory: trimmedHistory,
  };
  logPromptToFile(requestEntry);

  // Filled in by the provider call below: what the model actually spent
  // against that ceiling, so a truncated answer can be read straight off the
  // log instead of guessed at.
  let usage = null;
  const onUsage = (u) => { usage = u; };

  let response;
  let callError = null;
  try {
    // ONE place decides how long the app is willing to wait, whichever provider
    // serves the call — see AI_TIMEOUT_MS.
    response = await withTimeout((async () => {
      switch (provider.toLowerCase()) {
        case 'gemini':
          return callGemini(prompt, model, sendMaxTokens, apiKey, systemPrompt, trimmedHistory, onUsage, jsonMode);
        case 'claude':
          return callClaude(prompt, model, sendMaxTokens, apiKey, systemPrompt, trimmedHistory, onUsage);
        case 'openai':
        case 'chatgpt':
          return callOpenAI(prompt, model, sendMaxTokens, apiKey, systemPrompt, trimmedHistory, null, onUsage, jsonMode);
        default: {
          // Any OpenAI-compatible provider (OpenRouter, Groq, Together, Mistral,
          // Ollama, LM Studio, custom) routes through the OpenAI SDK + baseURL.
          if (!compatConf) {
            throw new Error(`Unknown AI provider: ${provider}. Supported: gemini, claude, openai, ${Object.keys(OPENAI_COMPAT_PROVIDERS).join(', ')}`);
          }
          const url = baseURL || compatConf.baseURL;
          if (!url) throw new Error(`Provider "${provider}" requires a base URL. Set one in AI provider settings.`);
          if (!model) throw new Error(`Provider "${provider}" requires a model name.`);
          // jsonMode is forwarded but applyJsonMode drops it for any non-OpenAI
          // base URL — the policy lives there, not in a second place here.
          return callOpenAI(prompt, model, sendMaxTokens, apiKey, systemPrompt, trimmedHistory, url, onUsage, jsonMode);
        }
      }
    })(), AI_TIMEOUT_MS, providerLabel(provider));
  } catch (err) {
    callError = err;
  }

  // Response goes first so it sits ABOVE the matching request in the file
  // (the file is read top→bottom, append-only).
  logPromptToFile({
    kind:     'response',
    ts:       new Date().toISOString(),
    provider,
    model:    model || null,
    // Which prompt this is the answer to, so a response can be matched to its
    // request without counting entries. `maxTokensSent` is deliberately NOT
    // repeated here — it is on the matching request, and `usage.truncated`
    // already says whether that ceiling was hit.
    ...(promptMeta?.kind ? { promptKind: promptMeta.kind } : {}),
    ...(usage ? { usage } : {}),
    ...(callError
      // A truncation throws rather than returning, so the text the model DID
      // produce would otherwise never reach the log — record it under its own
      // key so a cut-off answer can be read here, not just its error message.
      ? { error: callError.message, ...(callError.partialText ? { partialResponse: callError.partialText } : {}) }
      : { response }),
  });

  // Surface a plain-language error to the user; the raw provider message was
  // already written to the prompt log above for debugging.
  if (callError) {
    const e = humanizeAIError(callError, provider, model);
    // A cut-off answer is resumable: hand back everything needed to ask the
    // model for the rest (see continueAI / the chat UI's Continue button).
    if (e.code === 'MAX_TOKENS') {
      e.resume = {
        provider,
        model:        model || null,
        systemPrompt,
        chatHistory:  trimmedHistory,
        prompt,
        maxTokens:    maxTokens || DEFAULT_MAX_TOKENS,
        partialText:  callError.partialText || '',
      };
    }
    throw e;
  }
  return response;
}

/**
 * Ask the model to finish an answer that was cut off by the output limit, and
 * return the two halves stitched together.
 *
 * The partial text is replayed inside the USER turn rather than as a prefilled
 * assistant turn: Claude Opus 5 (and every 4.6+ model) rejects assistant
 * prefills with a 400, so the documented replacement is to quote the interrupted
 * text back and ask the model to carry on from there.
 *
 * @param {Object} resume  The `resume` payload carried by a MAX_TOKENS error.
 * @param {Object} extra   Anything callAI needs that isn't in `resume` (apiKeys).
 * @returns {Promise<string>} partialText + the continuation.
 */
async function continueAI(resume = {}, extra = {}) {
  const { prompt, systemPrompt, chatHistory, partialText, provider, model, maxTokens } = resume;
  if (!partialText) throw new Error('Nothing to continue — no partial output was captured.');

  const continuationPrompt = [
    prompt ? `Original request:\n${prompt}\n` : '',
    'Your previous reply was cut off by the output limit. This is exactly what you produced before it stopped:',
    '<partial_reply>',
    partialText,
    '</partial_reply>',
    '',
    'Resume from the exact character where it stopped and output ONLY the remaining text.',
    'Do not repeat any part of the partial reply, do not start over, and do not add any preamble or explanation —',
    'your output is appended to the partial reply verbatim, so the two halves must join seamlessly.',
  ].filter(Boolean).join('\n');

  try {
    const rest = await callAIWithKeys(continuationPrompt, {
      provider,
      model:       model || undefined,
      systemPrompt,
      chatHistory,
      maxTokens:   maxTokens || DEFAULT_MAX_TOKENS,
      ...extra,
    });
    return `${partialText}${rest}`;
  } catch (err) {
    // Cut off again — fold this round's output into the partial and restore the
    // original request, so another Continue picks up from the new end rather
    // than from a continuation prompt wrapped in a continuation prompt.
    if (err && err.code === 'MAX_TOKENS' && err.resume) {
      err.resume.partialText = `${partialText}${err.resume.partialText || ''}`;
      err.resume.prompt = prompt;
    }
    throw err;
  }
}

/**
 * Resolve a provider's stored configuration into a normalized entry the
 * dispatcher can use: { apiKey, baseURL?, model? }, or null if the provider
 * isn't usable (no key for a key-requiring provider, or a custom provider with
 * no base URL configured).
 *
 * OpenAI-compatible providers may be stored either as a plain key string or as
 * an object { apiKey, baseURL, model } so the UI can carry a per-provider base
 * URL and model. A provider is only considered configured if it has a stored
 * entry — keyless local providers are NOT auto-enabled.
 */
function resolveProviderEntry(provider, apiKeys = {}) {
  if (!provider) return null;
  const p = provider.toLowerCase();

  if (p === 'openai' || p === 'chatgpt') {
    const key = apiKeys.chatgpt || apiKeys.openai;
    return key ? { apiKey: key } : null;
  }
  if (p === 'claude' || p === 'gemini') {
    return apiKeys[p] ? { apiKey: apiKeys[p] } : null;
  }

  const conf = OPENAI_COMPAT_PROVIDERS[p];
  if (conf) {
    const stored = apiKeys[p];
    if (!stored) return null; // never auto-enable a compat provider
    const entry = typeof stored === 'object' ? stored : { apiKey: stored };
    const apiKey = entry.apiKey || entry.key || '';
    const baseURL = entry.baseURL || conf.baseURL || '';
    const model = entry.model || conf.defaultModel || undefined;
    if (conf.requiresKey && !apiKey) return null;
    if (!baseURL) return null; // custom provider needs a URL
    return { apiKey, baseURL, model };
  }
  return null;
}

// Backward-compatible helper: just the API key string (or null).
function resolveApiKey(provider, apiKeys = {}) {
  const entry = resolveProviderEntry(provider, apiKeys);
  return entry ? (entry.apiKey || null) : null;
}

function listAvailableProviders(apiKeys = {}) {
  return PROVIDER_PRIORITY.filter((p) => !!resolveProviderEntry(p, apiKeys));
}

function pickProvider(apiKeys = {}, requested) {
  if (requested) {
    const entry = resolveProviderEntry(requested, apiKeys);
    if (entry) {
      const provider = requested.toLowerCase() === 'chatgpt' ? 'openai' : requested.toLowerCase();
      return { provider, ...entry };
    }
  }
  for (const p of PROVIDER_PRIORITY) {
    const entry = resolveProviderEntry(p, apiKeys);
    if (entry) return { provider: p, ...entry };
  }
  return null;
}

/**
 * Higher-level dispatcher for callers that hold the full apiKeys map.
 *
 * @param {string} prompt
 * @param {Object} options
 * @param {Object} options.apiKeys     Decrypted keys (e.g. from loadApiKeys()).
 * @param {string} [options.provider]  Preferred provider; falls back to first available.
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {string} [options.systemPrompt]
 * @param {Array}  [options.chatHistory]
 * @param {boolean} [options.jsonMode] Set on calls whose reply is PARSED, never
 *   displayed. Constrains decoding to JSON on the providers that support it
 *   (Gemini, OpenAI proper). Must stay false for prose replies — titles, and
 *   skill turns that may answer in text.
 */
async function callAIWithKeys(prompt, options = {}) {
  const {
    apiKeys = {}, provider: requestedProvider, model, maxTokens,
    systemPrompt, chatHistory, onTrim, jsonMode, promptMeta,
  } = options;
  const picked = pickProvider(apiKeys, requestedProvider);
  if (!picked) {
    throw new Error('No AI provider available. Configure an API key for openai, claude, or gemini.');
  }
  return callAI(prompt, {
    provider: picked.provider,
    apiKey: picked.apiKey,
    baseURL: picked.baseURL,
    model: model || picked.model || DEFAULT_MODELS[picked.provider],
    maxTokens,
    systemPrompt,
    chatHistory,
    onTrim,
    jsonMode,
    promptMeta,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Native tool calling
//
// A second dispatcher for agent loops, alongside callAI. Where callAI is
// text-in / text-out and the caller parses a JSON contract out of the reply,
// this one hands the provider real tool schemas and gets back structured calls.
//
// Callers speak ONE neutral turn format and never see provider wire shapes:
//
//   { role: 'user',      text }
//   { role: 'assistant', text, toolCalls: [{ id, tool, args }], raw }
//   { role: 'tool',      stepIndex, results: [{ id, tool, content, isError }] }
//
// `raw` on an assistant turn is that provider's own content payload from when
// the turn was produced. It is replayed verbatim rather than rebuilt: Anthropic
// models that think while using tools return signed thinking blocks which must
// come back unaltered, and reconstructing the turn from text + toolCalls would
// drop them.
// ═══════════════════════════════════════════════════════════════════════════

// Providers whose adapters below are implemented and tested. Everything else —
// Gemini (a different function-calling shape), and every OpenAI-compatible
// endpoint, whose tool support varies by server AND by model — stays on the
// JSON-in-text path. `custom` and local servers are deliberately excluded:
// silently sending `tools` to a server that ignores the field yields a model
// that answers in prose while the caller waits for tool calls.
const TOOL_CAPABLE_PROVIDERS = new Set(['claude', 'openai', 'chatgpt']);

function providerSupportsTools(provider) {
  return TOOL_CAPABLE_PROVIDERS.has(String(provider || '').toLowerCase());
}

function toolTurnText(turn) {
  if (turn.role === 'tool') {
    return (turn.results || []).map((r) => String(r.content ?? '')).join('\n\n');
  }
  return turn.text || '';
}

/**
 * The three-pass shrink from trimChatHistoryToFit, for neutral tool turns.
 *
 * Same policy, different shape: conversation first, then tool RESULTS become a
 * note while the assistant turn that made the calls stays intact, and only then
 * whole call+result pairs. Kept separate rather than converting back and forth
 * because a tool turn's size lives in its results array, not in a text field.
 */
function trimToolTurns({ turns, model, contextWindow: window_, maxResponseTokens, systemPrompt, tools, onTrim }) {
  const contextWindow = Number(window_) || windowForModel(model);
  const reserved = Number(maxResponseTokens) || 0;
  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) + 4 : 0;
  // Tool schemas are part of the request and are resent on every iteration.
  const toolTokens = tools ? estimateTokens(JSON.stringify(tools)) + 4 : 0;
  const budget = contextWindow - reserved - systemTokens - toolTokens;

  const out = [...(turns || [])];
  const sizeOf = (t) => estimateTokens(toolTurnText(t)) + 4;
  let used = out.reduce((sum, t) => sum + sizeOf(t), 0);
  const over = () => used > budget;

  const truncatedSteps = new Set();
  const noteStep = (t) => { if (Number.isFinite(t?.stepIndex)) truncatedSteps.add(t.stepIndex); };

  // Pass 1 — ordinary conversation, oldest first. Loop turns carry a stepIndex
  // and are handled by the later passes; the question being answered is marked
  // `keep` and is never dropped at all.
  for (let i = 0; over() && i < out.length;) {
    if (out[i].keep || Number.isFinite(out[i].stepIndex)) { i++; continue; }
    used -= sizeOf(out[i]);
    out.splice(i, 1);
  }

  // Pass 2 — results become a note; the calls that produced them stay visible.
  for (let i = 0; i < out.length && over(); i++) {
    const turn = out[i];
    if (turn.role !== 'tool' || turn.truncated) continue;
    const actions = (turn.results || []).map((r) => ({ tool: r.tool, args: r.args }));
    const note = truncatedResultNote(actions);
    const replaced = {
      ...turn,
      truncated: true,
      results: (turn.results || []).map((r) => ({ ...r, content: note, isError: false })),
    };
    used += sizeOf(replaced) - sizeOf(turn);
    out[i] = replaced;
    noteStep(turn);
  }

  // Pass 3 — drop whole steps, oldest first, assistant turn together with the
  // tool turn answering it.
  while (over() && out.length > 1) {
    const idx = out.findIndex((t) => !t.keep && Number.isFinite(t.stepIndex));
    if (idx === -1) break;
    const dropped = out.splice(idx, 1)[0];
    used -= sizeOf(dropped);
    noteStep(dropped);
    if (dropped.role === 'assistant' && out[idx]?.role === 'tool' && out[idx].stepIndex === dropped.stepIndex) {
      const partner = out.splice(idx, 1)[0];
      used -= sizeOf(partner);
      noteStep(partner);
    }
  }

  if (typeof onTrim === 'function' && truncatedSteps.size > 0) {
    try { onTrim({ truncatedSteps }); } catch (_err) { /* reporting must never break the call */ }
  }
  return out;
}

function toClaudeMessages(turns) {
  const messages = [];
  for (const turn of turns) {
    if (turn.role === 'tool') {
      messages.push({
        role: 'user',
        content: (turn.results || []).map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          is_error: !!r.isError,
          content: String(r.content ?? ''),
        })),
      });
      continue;
    }
    if (turn.role === 'assistant') {
      // Verbatim replay — see the note at the top of this section.
      if (Array.isArray(turn.raw) && turn.raw.length > 0) {
        messages.push({ role: 'assistant', content: turn.raw });
        continue;
      }
      const content = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      for (const c of turn.toolCalls || []) {
        content.push({ type: 'tool_use', id: c.id, name: c.tool, input: c.args || {} });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    messages.push({ role: 'user', content: turn.text || '' });
  }
  return messages;
}

function toOpenAIMessages(turns, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const turn of turns) {
    if (turn.role === 'tool') {
      // One message PER call — OpenAI pairs them by tool_call_id, unlike
      // Anthropic which carries every result inside a single user turn.
      for (const r of turn.results || []) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: String(r.content ?? '') });
      }
      continue;
    }
    if (turn.role === 'assistant') {
      const msg = { role: 'assistant', content: turn.text || null };
      if (turn.toolCalls?.length) {
        msg.tool_calls = turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.tool, arguments: JSON.stringify(c.args || {}) },
        }));
      }
      messages.push(msg);
      continue;
    }
    messages.push({ role: 'user', content: turn.text || '' });
  }
  return messages;
}

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function callClaudeTools({ model, maxTokens, apiKey, systemPrompt, turns, tools, onUsage }) {
  const AnthropicCtor = Anthropic.default || Anthropic;
  const anthropic = new AnthropicCtor(sdkClientOptions({ apiKey }));

  const budget = maxTokens || DEFAULT_MAX_TOKENS;
  const params = { model, max_tokens: budget, messages: toClaudeMessages(turns) };
  if (tools?.length) params.tools = tools;
  if (systemPrompt) params.system = systemPrompt;
  if (budget < 1024) params.thinking = { type: 'disabled' };

  const res = await createClaudeMessage(anthropic, params);
  const blocks = Array.isArray(res?.content) ? res.content : [];

  if (typeof onUsage === 'function') {
    onUsage({
      inputTokens:    res?.usage?.input_tokens ?? null,
      outputTokens:   res?.usage?.output_tokens ?? null,
      thinkingTokens: res?.usage?.output_tokens_details?.thinking_tokens || null,
      cacheReadInputTokens:     res?.usage?.cache_read_input_tokens ?? null,
      cacheCreationInputTokens: res?.usage?.cache_creation_input_tokens ?? null,
      finishReason:   res?.stop_reason || null,
      truncated:      res?.stop_reason === 'max_tokens',
    });
  }

  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('').trim();

  // The model's reasoning, for display only. `raw` already carries these blocks
  // for verbatim replay; pulling the readable part out here is what keeps the
  // renderer from having to know Anthropic's block shapes. `redacted_thinking`
  // blocks are encrypted — they still count as thinking that happened, but
  // there is nothing to show, so they're reported as a count instead.
  const thinking = blocks
    .filter((b) => b && b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking).join('\n\n').trim();
  const redactedThinking = blocks.filter((b) => b && b.type === 'redacted_thinking').length;

  if (res?.stop_reason === 'max_tokens') {
    // A tool_use block cut in half has no valid arguments, so unlike a prose
    // answer there is nothing to stitch onto. The turn has to be re-run.
    const e = new Error(`Claude ran out of output space (${budget} tokens) before finishing this turn.`);
    e.code = 'MAX_TOKENS';
    e.maxTokens = budget;
    e.partialText = text || null;
    e.resumable = false;
    throw e;
  }
  if (res?.stop_reason === 'refusal') {
    const category = res.stop_details?.category;
    throw new Error(`Claude declined this request${category ? ` (${category})` : ''}. Rephrase the request or switch to a different AI provider in Settings.`);
  }

  return {
    text,
    thinking: thinking || null,
    redactedThinking: redactedThinking || 0,
    toolCalls: blocks
      .filter((b) => b && b.type === 'tool_use')
      .map((b) => ({ id: b.id, tool: b.name, args: b.input || {} })),
    raw: blocks,
    stopReason: res?.stop_reason || null,
  };
}

/**
 * Neutral turns → the Responses API's flat `input` list.
 *
 * Unlike chat.completions, a tool call and its result are not nested inside an
 * assistant/tool MESSAGE — they are items in their own right, paired by
 * `call_id`. An assistant turn therefore expands to (at most) one message item
 * plus one `function_call` item per call it made.
 */
function toResponsesInput(turns) {
  const input = [];
  for (const turn of turns || []) {
    if (turn.role === 'tool') {
      for (const r of turn.results || []) {
        input.push({ type: 'function_call_output', call_id: r.id, output: String(r.content ?? '') });
      }
      continue;
    }
    if (turn.role === 'assistant') {
      // An assistant turn that only made tool calls has no text; emitting an
      // empty message item would be rejected, so skip it.
      if (turn.text) input.push({ role: 'assistant', content: turn.text });
      for (const c of turn.toolCalls || []) {
        input.push({
          type: 'function_call',
          call_id: c.id,
          name: c.tool,
          arguments: JSON.stringify(c.args || {}),
        });
      }
      continue;
    }
    input.push({ role: 'user', content: turn.text || '' });
  }
  return input;
}

/**
 * Tool schemas for /v1/responses — flat, where chat.completions nests them
 * under `function`.
 *
 * `strict: false` is deliberate: strict mode additionally requires every
 * property to be listed in `required` and `additionalProperties: false` on
 * every object, which the tool schemas in this app do not all satisfy. Opting
 * in would turn a working tool definition into a request-time rejection.
 */
function toResponsesTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: false,
  }));
}

async function callOpenAITools({ model, maxTokens, apiKey, systemPrompt, turns, tools, baseURL, onUsage }) {
  const OpenAICtor = OpenAI.default || OpenAI;
  const clientOptions = sdkClientOptions({ apiKey: apiKey || 'not-needed' });
  if (baseURL) clientOptions.baseURL = baseURL;
  const openai = new OpenAICtor(clientOptions);

  // OpenAI proper goes through /v1/responses. Its reasoning models refuse
  // function tools on /v1/chat/completions unless reasoning is switched off
  // ("Function tools with reasoning_effort are not supported for <model> in
  // /v1/chat/completions"), and turning reasoning off is not something we want
  // to do on the user's behalf.
  //
  // The chat.completions branch below is currently UNREACHABLE: only the
  // providers in TOOL_CAPABLE_PROVIDERS get here, and of those `openai` /
  // `chatgpt` never carry a baseURL (resolveProviderEntry returns a bare
  // { apiKey } for them). It is kept because OpenAI-compatible servers
  // implement chat.completions and NOT /v1/responses, so it is the branch they
  // would need the day TOOL_CAPABLE_PROVIDERS is widened to include one.
  if (!baseURL) {
    return callOpenAIToolsViaResponses(openai, { model, maxTokens, systemPrompt, turns, tools, onUsage });
  }

  const params = { model, messages: toOpenAIMessages(turns, systemPrompt) };
  if (tools?.length) params.tools = toOpenAITools(tools);
  applyMaxTokens(params, maxTokens, baseURL);

  const completion = await openai.chat.completions.create(params);
  const choice = completion.choices?.[0];
  const msg = choice?.message || {};

  if (typeof onUsage === 'function') {
    const u = completion.usage || {};
    onUsage({
      inputTokens:    u.prompt_tokens ?? null,
      outputTokens:   u.completion_tokens ?? null,
      thinkingTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      cacheReadInputTokens: u.prompt_tokens_details?.cached_tokens ?? null,
      finishReason:   choice?.finish_reason || null,
      truncated:      choice?.finish_reason === 'length',
    });
  }

  if (choice?.finish_reason === 'length') {
    const e = new Error(`The model ran out of output space (${maxTokens || 'default'} tokens) before finishing this turn.`);
    e.code = 'MAX_TOKENS';
    e.maxTokens = maxTokens || null;
    e.partialText = msg.content || null;
    e.resumable = false;
    throw e;
  }

  const toolCalls = [];
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      // Arguments arrive as a STRING here, and a weaker model can emit one that
      // does not parse. Surface it as a per-call error the loop can report back
      // rather than failing the whole turn.
      args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch (_err) {
      args = { __invalidArguments: tc.function?.arguments || '' };
    }
    toolCalls.push({ id: tc.id, tool: tc.function?.name, args });
  }

  return {
    text: (msg.content || '').trim(),
    thinking: null,      // chat.completions exposes no reasoning text.
    redactedThinking: 0,
    toolCalls,
    raw: null,           // OpenAI turns rebuild losslessly from text + toolCalls.
    stopReason: choice?.finish_reason || null,
  };
}

/**
 * One tool-calling turn over /v1/responses — the OpenAI-proper path.
 *
 * Same neutral contract in and out as the chat.completions branch above; only
 * the wire shape differs. Notable renames: `messages` → `input`, the system
 * prompt → `instructions`, `max_completion_tokens` → `max_output_tokens`,
 * `choices[0]` → the `output` item list, and truncation is reported by
 * `incomplete_details.reason` rather than a `finish_reason` of "length".
 */
async function callOpenAIToolsViaResponses(openai, { model, maxTokens, systemPrompt, turns, tools, onUsage }) {
  const params = { model, input: toResponsesInput(turns) };
  if (systemPrompt) params.instructions = systemPrompt;
  if (tools?.length) params.tools = toResponsesTools(tools);
  if (maxTokens) params.max_output_tokens = maxTokens;

  const res = await openai.responses.create(params);

  const truncated = res?.incomplete_details?.reason === 'max_output_tokens';

  if (typeof onUsage === 'function') {
    const u = res.usage || {};
    onUsage({
      inputTokens:    u.input_tokens ?? null,
      outputTokens:   u.output_tokens ?? null,
      // Reasoning is billed against the output cap here exactly as it is on
      // chat.completions, just under a different key.
      thinkingTokens: u.output_tokens_details?.reasoning_tokens ?? null,
      cacheReadInputTokens: u.input_tokens_details?.cached_tokens ?? null,
      finishReason:   res?.incomplete_details?.reason || res?.status || null,
      truncated,
    });
  }

  // `output_text` is the SDK's concatenation of every output_text part, which
  // is what the neutral contract's `text` means.
  const text = String(res?.output_text || '').trim();

  if (truncated) {
    const e = new Error(`The model ran out of output space (${maxTokens || 'default'} tokens) before finishing this turn.`);
    e.code = 'MAX_TOKENS';
    e.maxTokens = maxTokens || null;
    e.partialText = text || null;
    e.resumable = false;
    throw e;
  }

  const toolCalls = [];
  for (const item of res?.output || []) {
    if (item?.type !== 'function_call') continue;
    let args = {};
    try {
      // Arguments arrive as a STRING here too, and a weaker model can emit one
      // that does not parse. Surface it as a per-call error the loop can report
      // back rather than failing the whole turn.
      args = item.arguments ? JSON.parse(item.arguments) : {};
    } catch (_err) {
      args = { __invalidArguments: item.arguments || '' };
    }
    // `call_id` is the id that pairs with function_call_output — NOT `item.id`,
    // which identifies the output item itself and is rejected when echoed back.
    toolCalls.push({ id: item.call_id, tool: item.name, args });
  }

  return {
    text,
    // No reasoning text to show: /v1/responses only returns reasoning summaries
    // when the request asks for them (`reasoning: { summary: ... }`), which we
    // don't. Null keeps the contract's shape identical across providers.
    thinking: null,
    redactedThinking: 0,
    toolCalls,
    // Rebuilt from text + toolCalls by toResponsesInput, same as the
    // chat.completions branch. Reasoning items are NOT carried across turns —
    // preserving them would mean threading this payload through the agent
    // loop's neutral turn format.
    raw: null,
    stopReason: res?.status || null,
  };
}

/**
 * Provider-agnostic dispatcher for tool-calling agent loops.
 *
 * @param {Object} options
 * @param {Array}  options.turns    Neutral turns, oldest first (see format above).
 * @param {Array}  options.tools    Tool schemas: { name, description, input_schema }.
 * @param {Function} [options.onTrim] Reports steps whose results had to be removed.
 * @returns {Promise<{text: string, thinking: string|null, redactedThinking: number,
 *   toolCalls: Array, raw: any, stopReason: string}>} `thinking` is the model's
 *   reasoning as plain text when the provider exposes it (Claude only today),
 *   for display; it is never fed back as input — `raw` handles replay.
 */
async function callAITools(options = {}) {
  const {
    provider, model, maxTokens, apiKey, systemPrompt = null,
    turns = [], tools = [], baseURL = null, onTrim = null, promptMeta = null,
  } = options;
  if (!provider) throw new Error('provider is required');
  if (!providerSupportsTools(provider)) {
    throw new Error(`Provider "${provider}" does not support native tool calling.`);
  }
  if (!apiKey) throw new Error('apiKey is required');

  // Same reconciliation as callAI: real window for the trim budget, real output
  // cap for the ceiling we send. See resolveModelLimits / reconcileTokenBudget.
  const limits = await resolveModelLimits(provider, model, { apiKey, baseURL });
  const { sendMaxTokens, reserve } = reconcileTokenBudget(maxTokens, limits);

  const trimmedTurns = trimToolTurns({
    turns, model, contextWindow: limits.contextWindow,
    maxResponseTokens: reserve, systemPrompt, tools, onTrim,
  });

  logPromptToFile({
    kind: 'request',
    ts: new Date().toISOString(),
    provider,
    model: model || null,
    maxTokens: maxTokens || null,
    maxTokensSent: effectiveMaxTokens(provider, sendMaxTokens),
    contextWindow: limits.contextWindow,
    ...promptDescriptor({ promptMeta, systemPrompt }),
    tools: (tools || []).map((t) => t.name),
    turns: trimmedTurns,
  });

  let usage = null;
  const onUsage = (u) => { usage = u; };

  let result;
  let callError = null;
  try {
    const args = { model, maxTokens: sendMaxTokens, apiKey, systemPrompt, turns: trimmedTurns, tools, onUsage };
    // Bounded exactly like callAI — an agent turn is where the app waits most.
    result = await withTimeout(
      provider.toLowerCase() === 'claude' ? callClaudeTools(args) : callOpenAITools({ ...args, baseURL }),
      AI_TIMEOUT_MS,
      providerLabel(provider),
    );
  } catch (err) {
    callError = err;
  }

  logPromptToFile({
    kind: 'response',
    ts: new Date().toISOString(),
    provider,
    model: model || null,
    ...(promptMeta?.kind ? { promptKind: promptMeta.kind } : {}),
    ...(usage ? { usage } : {}),
    ...(callError
      ? { error: callError.message, ...(callError.partialText ? { partialResponse: callError.partialText } : {}) }
      // `id` is the provider's own call id — needed to pair a result on the
      // wire, meaningless when reading the log. Empty `text` (a turn that only
      // made tool calls) and an empty toolCalls list are dropped by compaction.
      : {
          response: {
            text: result.text,
            toolCalls: (result.toolCalls || []).map((c) => ({ tool: c.tool, args: c.args })),
          },
        }),
  });

  if (callError) throw humanizeAIError(callError, provider, model);
  return result;
}

/** callAITools for callers holding the full apiKeys map. Mirrors callAIWithKeys. */
async function callAIToolsWithKeys(options = {}) {
  const { apiKeys = {}, provider: requestedProvider, model, ...rest } = options;
  const picked = pickProvider(apiKeys, requestedProvider);
  if (!picked) {
    throw new Error('No AI provider available. Configure an API key for openai, claude, or gemini.');
  }
  return callAITools({
    ...rest,
    provider: picked.provider,
    apiKey: picked.apiKey,
    baseURL: picked.baseURL,
    model: model || picked.model || DEFAULT_MODELS[picked.provider],
  });
}

module.exports = {
  stripMarkdownCodeBlocks,
  humanizeAIError,
  // Exported to be testable on its own, and so a caller can report the same
  // limit it will be held to.
  withTimeout,
  AI_TIMEOUT_MS,
  callGemini,
  callClaude,
  callOpenAI,
  callAI,
  callAIWithKeys,
  callAITools,
  callAIToolsWithKeys,
  providerSupportsTools,
  trimToolTurns,
  continueAI,
  listModels,
  pickProvider,
  resolveProviderEntry,
  resolveApiKey,
  listAvailableProviders,
  trimChatHistoryToFit,
  estimateTokens,
  windowForModel,
  resolveModelLimits,
  reconcileTokenBudget,
  PROVIDER_PRIORITY,
  DEFAULT_MODELS,
  MODEL_CONTEXT_WINDOWS,
  OPENAI_COMPAT_PROVIDERS
};
