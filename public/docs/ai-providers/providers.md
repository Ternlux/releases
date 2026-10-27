# Providers and models

Ternlux talks to large language models through one in-process dispatcher.
It knows each supported provider, each provider's models, and each
model's real limits.

## Supported providers

### Built-in

- **OpenAI** — generation and embeddings.
- **Anthropic Claude** — generation.
- **Google Gemini** — generation.

### OpenAI-compatible

Any provider exposing an OpenAI-style `/chat/completions` endpoint routes
through the same SDK with the base URL overridden, so it behaves like a
built-in provider once configured:

- **OpenRouter**, **Groq**, **Together AI**, **Mistral AI**,
  **NVIDIA AI** — hosted, each with an API key.
- **Ollama**, **LM Studio** — local model servers, no key required.
- **Custom (OpenAI-compatible)** — any other endpoint. You supply the
  base URL and model name yourself, stored alongside the key.

You can have any combination configured at once.

## How a provider is chosen

Every AI call has a preferred provider — set explicitly by the caller, or
read from your saved settings. Ternlux uses it when its key is
configured. If it isn't, it falls back through a fixed order: OpenAI,
then Claude, then Gemini, then any configured OpenAI-compatible provider.

If no provider has a key, the call returns an error and the assistant
tells you to set one up.

## Default models

When the caller doesn't pin a model, Ternlux uses a sensible default per
provider, tracking each provider's current flagship at the time of
release. You can override the model from the settings screen; your choice
is remembered and used for every subsequent call.

## Context windows and output budgets

A model's real limits are read from the provider's own models endpoint
and cached for a few hours — and briefly, rather than not at all, when
the lookup fails, so being offline or between keys doesn't add a doomed
round trip to every turn. A static
catalog of the major models is the fallback for providers that publish
nothing, with prefix matching so a date-stamped variant resolves to its
family, and a conservative default for anything unrecognised.

Those limits are reconciled against your Max Tokens setting before every
call, for two reasons:

- A request over the model's published output cap is rejected outright by
  the provider, and the Max Tokens setting is global — it outlives the
  model it was chosen for.
- A response budget that swallows the whole context window leaves nothing
  for input, and the trimmers respond by deleting the entire
  conversation. The input keeps at least half the window.

Anthropic requires an output ceiling on every request, so it always gets
one; OpenAI and Gemini are left to their own defaults when none is set.

## History trimming

Before each request Ternlux measures the prompt, the system prompt and
the reserved response tokens against the model's budget, and shrinks in a
fixed order:

1. The oldest conversation turns.
2. Tool **results**, replaced with a note saying they were too large to
   keep — while the calls that produced them stay visible, so the model
   can see what ran and run it again.
3. Whole call-and-result pairs.

The current question is never trimmed. Callers are told which steps lost
their results, which is what makes those calls repeatable instead of
being refused as duplicates.

## Timeouts and retries

Every call is given a single deadline, applied both as the SDK's own
timeout and as a race around the whole call, so a provider that ignores
its timeout still cannot hang the app. It is generous — a "this will
never finish" limit, not a speed limit — and can be raised with an
environment variable for a slow local model server. One retry, not the
SDKs' default two, because each attempt can now cost the full deadline.

## Output handling

- Markdown code fences are stripped, so a parsed result is clean JSON or
  clean code regardless of provider.
- Provider errors are turned into plain guidance — a rate limit, a bad
  key, a model that no longer exists — rather than a raw SDK string.
- A reply cut off by the output limit carries what was written so far, so
  the UI can offer to continue it rather than starting over.

## Prompt logging (development only)

Outside production builds, Ternlux writes every request and response to a
single JSON file under `dev-logs/`. For prompts built through the central
registry it records the prompt's *kind and parameters* rather than its
text — the text is the same thousands of tokens on every call, and the
parameters are what actually differ.
