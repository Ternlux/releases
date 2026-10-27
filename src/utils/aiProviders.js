/**
 * Renderer-side AI provider helpers.
 *
 * The actual SDK calls, decrypted API keys AND the user's default AI settings
 * (provider, model, Max Tokens) all live in the main process. The settings are
 * stored in one place only — ai-prefs.json, read by every AI call — and the
 * renderer reads and writes them through loadDefaultAiSettings /
 * saveDefaultAiSettings below. Nothing here keeps a copy in localStorage: a
 * second copy is what once let Settings show one model while every call sent
 * another.
 */

// OpenAI-compatible providers reachable via the OpenAI SDK + a custom baseURL.
// Mirrors OPENAI_COMPAT_PROVIDERS in public/aiProviders.js. The base URL and
// model for these live in the encrypted key entry (set in provider settings),
// so the renderer only needs to forward the provider id — the main process
// resolves the rest. `null` baseURL means the user supplies it (custom).
export const OPENAI_COMPAT_PROVIDERS = {
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', requiresKey: true, color: '#6566F1', placeholderModel: 'openai/gpt-4o-mini', docsUrl: 'https://openrouter.ai/keys' },
  groq:       { name: 'Groq',       baseURL: 'https://api.groq.com/openai/v1', requiresKey: true, color: '#F55036', placeholderModel: 'llama-3.3-70b-versatile', docsUrl: 'https://console.groq.com/keys' },
  together:   { name: 'Together AI', baseURL: 'https://api.together.xyz/v1', requiresKey: true, color: '#0F6FFF', placeholderModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', docsUrl: 'https://api.together.xyz/settings/api-keys' },
  mistral:    { name: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', requiresKey: true, color: '#FA520F', placeholderModel: 'mistral-large-latest', docsUrl: 'https://console.mistral.ai/api-keys' },
  nvidia:     { name: 'NVIDIA AI', baseURL: 'https://integrate.api.nvidia.com/v1', requiresKey: true, color: '#76B900', placeholderModel: 'meta/llama-3.1-70b-instruct', docsUrl: 'https://build.nvidia.com/' },
  ollama:     { name: 'Ollama',     baseURL: 'http://localhost:11434/v1', requiresKey: false, color: '#000000', placeholderModel: 'llama3.1', docsUrl: 'https://ollama.com/download' },
  lmstudio:   { name: 'LM Studio',  baseURL: 'http://localhost:1234/v1', requiresKey: false, color: '#4B5563', placeholderModel: 'local-model', docsUrl: 'https://lmstudio.ai/docs/local-server' },
  custom:     { name: 'Custom (OpenAI-compatible)', baseURL: '', requiresKey: false, color: '#8C8C8C', placeholderModel: '', docsUrl: '' }
};

export function isOpenAICompatProvider(provider) {
  return !!provider && Object.prototype.hasOwnProperty.call(OPENAI_COMPAT_PROVIDERS, String(provider).toLowerCase());
}

// ── Max Tokens ─────────────────────────────────────────────────────────────
// The user's choice is the primary value everywhere; this static ladder only
// supplies the options and the fallback when nothing is saved yet.
export const DEFAULT_MAX_TOKENS = 16000;
const TOKEN_LADDER = [2048, 4096, 8192, 16000, 32000, 64000, 128000];

/**
 * Max Tokens choices for a model, filtered to what it actually accepts.
 * `cap` is the model's published output limit (from ai.listModels); without
 * one the full ladder is offered and the provider rejects what it can't serve.
 */
export function buildTokenOptions(cap) {
  const options = (cap ? TOKEN_LADDER.filter((n) => n < cap) : TOKEN_LADDER).map((n) => ({
    value: n,
    label: `${n.toLocaleString()}${n === DEFAULT_MAX_TOKENS ? ' - Recommended' : ''}`,
  }));
  if (cap) options.push({ value: cap, label: `${cap.toLocaleString()} - Model maximum` });
  return options;
}

// ── Default AI settings (stored in the main process only) ──────────────────

/**
 * The saved defaults: `{ provider, model, modelProvider, maxTokens }`, each
 * null when unset. `model` belongs to `modelProvider` — use it only when that
 * matches the provider you are showing it for.
 */
export async function loadDefaultAiSettings() {
  const res = await window.electronAPI?.ai?.getDefaultProvider?.();
  return {
    provider: res?.provider || null,
    model: res?.model || null,
    modelProvider: res?.modelProvider || null,
    maxTokens: res?.maxTokens || null,
  };
}

/**
 * Persist Max Tokens, clamped to the model's published output limit (`cap`).
 * Throws when the main process refuses it — a save that silently didn't happen
 * is how the backend and the screen drift apart.
 */
export async function saveMaxTokens(maxTokens, cap = null) {
  const value = cap ? Math.min(maxTokens, cap) : maxTokens;
  const res = await window.electronAPI?.ai?.setMaxTokens?.(value);
  if (res && res.success === false) {
    throw new Error(res.error || 'Failed to save Max Tokens');
  }
  return value;
}

/**
 * Save the default provider, its model and Max Tokens — the one write path
 * shared by onboarding and Settings, straight to the main process.
 *
 * Pass no `model` for an OpenAI-compatible provider: its model lives in the
 * encrypted key entry (saved with ai:saveCompatProvider), not in ai-prefs.
 */
export async function saveDefaultAiSettings({ provider, model, maxTokens, cap = null }) {
  const res = await window.electronAPI?.ai?.setDefaultProvider?.(provider, model);
  if (res && res.success === false) {
    throw new Error(res.error || 'Failed to save the default provider');
  }
  if (maxTokens) await saveMaxTokens(maxTokens, cap);
}
