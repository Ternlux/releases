# Skill capabilities at run time

When the AI generates a piece of code — a JavaScript join function, a
skill's transform, an output-validation function — that code runs inside
Ternlux's background engine. Wherever it runs, it sees the same
predictable set of capabilities, so the model's mental model of "what's
available to me" is the same across every node and every skill.

## What generated code can do

- **Look up your saved connections** by name or id, including their type,
  category, and whether they're a vector store.
- **Read and write data** through one unified call. It handles both saved
  connections (by name or id) and local stores (addressed by type plus an
  absolute path). Whether the underlying system is SQL, document, or
  vector, the call shape is the same.
- **List tables, collections and indexes**, and the columns of any of
  them.
- **Call the AI** for a sub-task, with the same provider routing and
  history trimming the rest of the app uses.
- **Embed text into vectors** using the configured embedding provider.
- **Make HTTP requests** through a shared client.
- **Resolve a REST connection's saved credentials** — available to the
  one-off functions the assistant generates, so an authenticated call can
  be made without the credential ever being visible to the model.
- **Log to the run output** with a tagged prefix.

## Why this matters

One consistent surface means the model can generate the same code
regardless of which path will run it. A join function that performs
per-row similarity search uses the same calls whether the destination is
a relational database, a document store, or a vector store; Ternlux
routes it.

The same surface is documented to the model in every prompt that might
generate code, so it is prompted with the exact set of helpers it is
allowed to use. Code that drifts off that surface fails fast.

## Where the surface is narrowed

- **In the chat assistant**, data access is wrapped read-only: every
  query a generated function issues is classified before it runs, and
  anything that could modify data is refused. Writes happen when a built
  workflow executes, never through the chat.
- **In output validation**, the AI and HTTP helpers are additionally
  metered — a fixed budget per run, visible to the function so it can
  pace itself, and exceeding it throws rather than running away.

## Security boundary

The surface is a deliberately small, controlled set. Generated code does
not get raw file-system, operating-system, or network access beyond what
these helpers expose. Credentials are resolved inside the background
engine and never handed to generated code as raw values. And in the chat,
a generated function is shown to you and does not run until you approve
it.
