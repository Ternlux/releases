# Plugins

Ternlux is built around plugins. Every database integration, every cloud
storage integration, and every AI-routable capability is a plugin. New
ones can be added without modifying the rest of the application.

There are two kinds:

- **Connectors** — bridges to one external system: a database, a vector
  store, a cloud bucket, a spreadsheet service, a REST API, or local
  files.
- **Skills** — AI-routable executors the assistant can choose instead of
  plain SQL or document operations when the job calls for it.

## Contents

- [Plugin manager](plugin-manager.md) — discovery, validation, install /
  uninstall
- [Connectors](connectors/README.md) — what every connector can do, plus
  a page per shipped connector
- [Skills](skills/README.md) — what skills are and how the AI uses them

## Where plugins come from

Ternlux ships with a curated set. You can install more from the catalog
at any time and uninstall ones you don't use. Every plugin is
self-contained — its own folder, its own dependencies, and an icon and
configuration form that Ternlux renders automatically.

## Roles you'll see in the product

- A connector marked as a **vector store** unlocks the vector-aware paths
  in joins (similarity search), in transformers and outputs (embedding
  and upsert), and in the assistant.
- A connector marked as **cloud storage** activates the file picker and
  bucket / object listing screens.
- A connector that declares its own **transform prompts** is the only way
  a transformation can be generated for that engine — the dialect lives
  with the connector.
- A skill marked for **transformer**, **join**, or **both** is offered to
  the analyser whenever an operation of that kind is being generated.
