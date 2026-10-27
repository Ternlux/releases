import { useCallback, useState } from 'react';
import AI_CONFIG from '../config/aiProviders.json';
import { OPENAI_COMPAT_PROVIDERS, buildTokenOptions } from './aiProviders';

/**
 * The one place that knows how to turn a provider id into a model list and the
 * Max Tokens choices that go with it.
 *
 * Two screens pick a model — onboarding (ApiKeySetup) and Settings → AI
 * Provider — and they had each grown their own copy of this. The copies drifted:
 * Settings normalized the provider id before asking for models while onboarding
 * passed its own tile id straight through, so choosing ChatGPT during setup
 * queried a provider called "chatgpt" that the main process does not know,
 * while Settings asked for "openai" and got a real list. Settings also
 * reconciled the selected model against the new list and onboarding did not.
 *
 * They can't share a rendered component — onboarding is MUI, Settings is antd —
 * so what is shared is everything behind the dropdowns: id normalization,
 * fetching, the curated overlay, and the token ladder. Each screen keeps its
 * own markup and its own idea of "selected" (local state vs. an antd Form),
 * which is what `onModelsLoaded` is for.
 */

// Live lists come from each provider's own endpoint. This is only an optional
// overlay for nicer labels/descriptions, and ships empty by default.
const PROVIDER_MODELS = AI_CONFIG.PROVIDER_MODELS || {};

/** OpenAI-compatible provider ids (the "Others" group). */
export const COMPAT_IDS = Object.keys(OPENAI_COMPAT_PROVIDERS);

/**
 * Onboarding labels OpenAI's tile 'chatgpt'; everything else in the app — the
 * stored key, the IPC handlers, the main process — says 'openai'. Asking for
 * models under the tile id returns nothing, so normalize before every lookup.
 */
export const normalizeProviderId = (id) => (id === 'chatgpt' ? 'openai' : id);

/**
 * Merge a live list with the curated overlay. Model ids are the join key; an id
 * with no curated entry keeps the provider's own label. `description` is always
 * a string so a caller's `.includes('Recommended')` check stays safe.
 */
export function enrichModels(provider, liveModels) {
  const curated = PROVIDER_MODELS[provider] || [];
  const byValue = new Map(curated.map((m) => [m.value, m]));
  return (liveModels || []).map((m) => {
    const match = byValue.get(m.value);
    return {
      value: m.value,
      label: match?.label || m.label || m.value,
      description: match?.description || '',
      // Published by Anthropic and Google; null for providers that don't expose
      // limits (OpenAI) and for curated entries with nothing live behind them.
      maxOutputTokens: m.maxOutputTokens || null,
      maxInputTokens: m.maxInputTokens || null,
    };
  });
}

export function useProviderModels() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState(null);

  /**
   * Fetch the models a provider currently offers.
   *
   * @param {string} provider          provider id, normalized here
   * @param {object} [opts]
   * @param {Function} [opts.onModelsLoaded] (list, { isCompat }) — lets the
   *        caller reconcile whatever it treats as the selected model.
   */
  const load = useCallback(async (provider, { onModelsLoaded } = {}) => {
    // 'others' is the picker for the compat group, not a provider itself.
    if (!provider || provider === 'others') {
      setModels([]);
      setLastError(null);
      onModelsLoaded?.([], { isCompat: false });
      return [];
    }

    const id = normalizeProviderId(provider);
    const isCompat = COMPAT_IDS.includes(id);
    const bundled = enrichModels(id, PROVIDER_MODELS[id] || []);

    const apply = (list, error = null) => {
      // The dropdown renders exactly this. Logged so an empty or one-item list
      // can be told apart from a list that arrived fine and failed to render —
      // and so the caps behind the Max Tokens ladder are visible.
      console.log(
        `[useProviderModels] applying ${list.length} model(s) for "${id}"`
        + `${isCompat ? ' (OpenAI-compatible)' : ''}${error ? ` | error: ${error}` : ''}`
      );
      if (list.length) console.table(list.map(({ value, label, maxOutputTokens, maxInputTokens }) =>
        ({ value, label, maxOutputTokens, maxInputTokens })));
      setModels(list);
      setLastError(error);
      onModelsLoaded?.(list, { isCompat });
      return list;
    };

    if (!window.electronAPI?.ai?.listModels) {
      console.warn('[useProviderModels] no electronAPI.ai.listModels — using bundled list');
      return apply(bundled);            // browser/dev — no IPC to ask
    }

    setLoading(true);
    try {
      console.log(`[useProviderModels] requesting models: provider="${provider}" → normalized "${id}"`);
      const res = await window.electronAPI.ai.listModels(id);
      console.log('[useProviderModels] raw IPC response:', res);
      if (res?.success && Array.isArray(res.models) && res.models.length > 0) {
        return apply(enrichModels(id, res.models));
      }
      console.warn(
        `[useProviderModels] no usable list for "${id}" — success=${res?.success}`
        + ` count=${Array.isArray(res?.models) ? res.models.length : 'n/a'}`
        + ` error=${res?.error || 'none'}; falling back to bundled (${bundled.length} entries)`
      );
      return apply(bundled, res?.error || 'No models returned');
    } catch (err) {
      console.warn('[useProviderModels] listModels failed; using bundled list:', err);
      return apply(bundled, err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setModels([]);
    setLastError(null);
  }, []);

  const findModel = useCallback((modelId) => models.find((m) => m.value === modelId), [models]);

  /** The chosen model's published output ceiling, or null when it has none. */
  const capFor = useCallback((modelId) => findModel(modelId)?.maxOutputTokens || null, [findModel]);

  /** The chosen model's context window, or null. */
  const contextFor = useCallback((modelId) => findModel(modelId)?.maxInputTokens || null, [findModel]);

  /**
   * Max Tokens choices for a model. Without a published cap the full ladder is
   * offered and the provider rejects anything it can't serve.
   */
  const tokenOptions = useCallback((modelId) => buildTokenOptions(capFor(modelId)), [capFor]);

  return { models, loading, lastError, load, reset, findModel, capFor, contextFor, tokenOptions };
}

export default useProviderModels;
