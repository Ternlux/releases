# AI providers

Ternlux uses large language models to translate plain-language requests
into the operations that workflows execute, to plan builds, and to review
what it built. You bring your own key for your preferred provider.

## Contents

- [Providers](providers.md) — which providers and models Ternlux
  supports, and how it picks one
- [Skill capabilities](helpers-bundle.md) — what generated code can use
  at run time
- [Embeddings](embeddings.md) — how text is turned into vectors

## At a glance

- Ternlux supports OpenAI, Anthropic Claude, and Google Gemini for
  generation, plus any OpenAI-compatible provider (OpenRouter, Groq,
  Together AI, Mistral AI, NVIDIA AI, Ollama, LM Studio, or a custom
  endpoint), and OpenAI for embeddings.
- You configure one or more keys; Ternlux uses your preferred provider
  when it has a key and falls back through a fixed order otherwise.
- Decrypted keys never leave the background engine — the interactive
  layer always asks the engine to make the call on its behalf.
- Providers with a real tool-calling API get structured tool calls; the
  rest use a JSON reply contract. Both paths are driven by the same
  prompts and produce the same behaviour.
- When a request would not fit the model's context window, Ternlux trims
  it in a fixed order and tells the caller what it dropped, so a tool
  call whose result was removed can be made again.
- Every call is bounded by a timeout, so a provider that opens a
  connection and never answers cannot hang the app.
