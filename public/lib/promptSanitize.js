/**
 * Keeping embedding vectors out of prompts.
 *
 * A vector column is the single most expensive thing that can end up in a
 * prompt and the least useful. One OpenAI embedding is 1536 float64 literals —
 * around 30,000 characters, roughly 8,000 tokens — and five sample rows of a
 * vector table is most of a 40k-token request spent on digits the model cannot
 * do anything with. It cannot compare them, cannot reproduce them, and does not
 * need them to write a join or a transformer: what it needs to know is that the
 * column exists, what it is called, and that it holds a vector.
 *
 * So the payload goes and a placeholder stays. `"[1536-dim vector omitted]"`
 * still tells the model the column is there and what it holds, which a deleted
 * field would not — a model that cannot see a `vector` column will happily
 * write SQL that selects it by a guessed name, or decide the table has no
 * embeddings at all.
 *
 * This is applied where structured data is serialised INTO a prompt, never to
 * the data itself. Execution reads real rows from the store; nothing here
 * touches those.
 */

// Below this length a numeric array is far more likely to be real data the
// model should see — a coordinate pair, an RGB triple, a handful of ids, a
// small test vector — than an embedding. Every embedding model in practical use
// is well above it (OpenAI 1536/3072, Cohere 1024, MiniLM 384), so the
// threshold separates the two cases without needing to know which model wrote
// the column.
const VECTOR_MIN_DIMS = 16;

// How deep to walk before giving up. Schemas and sample rows are shallow; this
// only exists so a pathological structure cannot spin.
const MAX_DEPTH = 12;

const placeholder = (length) => `[${length}-dim vector omitted]`;

/**
 * A long run of numbers — an embedding, by shape rather than by name.
 *
 * Typed arrays count at any length: nothing in this app puts a Float32Array in
 * a sample row except a vector store (LanceDB hands back Float32Array for its
 * vector column), so the type alone is the answer.
 */
function isVectorLike(value) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return true;
  if (!Array.isArray(value) || value.length < VECTOR_MIN_DIMS) return false;
  return value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * A deep copy with every vector replaced by a short placeholder.
 *
 * Returns non-objects untouched, so it is safe to call on anything. Cycles are
 * tracked and rendered as `"[circular]"` rather than throwing — a prompt
 * builder should not be the thing that crashes a build.
 */
function stripVectors(value, _depth = 0, _seen = new WeakSet()) {
  if (isVectorLike(value)) return placeholder(value.length);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (_depth >= MAX_DEPTH) return value;
  if (_seen.has(value)) return '[circular]';
  _seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => stripVectors(v, _depth + 1, _seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = stripVectors(v, _depth + 1, _seen);
  }
  return out;
}

// Column types and names that mean "this holds an embedding", for the case the
// length heuristic cannot catch: a short test vector (3 or 8 dims) that a demo
// dataset carries. When a schema declares the column, its declaration is used
// in preference to guessing from the value.
const VECTOR_COLUMN_TYPES = new Set(['vector', 'embedding', 'float_vector', 'fixed_size_list']);

function declaredVectorColumns(schema) {
  const cols = Array.isArray(schema?.columns) ? schema.columns : [];
  const names = new Set();
  for (const c of cols) {
    const name = typeof c === 'string' ? c : c?.name;
    const type = String((typeof c === 'object' && c?.type) || '').toLowerCase();
    if (name && VECTOR_COLUMN_TYPES.has(type)) names.add(name);
  }
  return names;
}

/**
 * `stripVectors` for a `{ tableName, columns, sampleData }` schema, using the
 * schema's own column types as well as the value shape.
 *
 * The declared-column pass is what catches a 3-dim vector in a demo dataset,
 * which is too short for the length heuristic to call.
 */
function stripVectorsFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const declared = declaredVectorColumns(schema);
  const cleaned = stripVectors(schema);
  if (!declared.size || !Array.isArray(cleaned.sampleData)) return cleaned;

  cleaned.sampleData = cleaned.sampleData.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const out = { ...row };
    for (const name of declared) {
      const v = out[name];
      if (Array.isArray(v)) out[name] = placeholder(v.length);
      else if (typeof v === 'number') out[name] = placeholder(1);
    }
    return out;
  });
  return cleaned;
}

/**
 * Wrap every function on a prompt-builder module so its arguments are stripped
 * before it runs.
 *
 * Prompt modules are reached from two places — the chatPrompts:build IPC for the
 * renderer's NodeChat panels, and a direct require in the headless workflow
 * builder — so sanitising at either call site alone would leave the other one
 * leaking. Wrapping the module covers both, and any third caller added later.
 */
function sanitizePromptModule(mod) {
  if (!mod || typeof mod !== 'object') return mod;
  const out = {};
  for (const [name, fn] of Object.entries(mod)) {
    out[name] = typeof fn === 'function'
      ? (...args) => fn(...args.map((a) => stripVectors(a)))
      : fn;
  }
  return out;
}

module.exports = {
  VECTOR_MIN_DIMS,
  isVectorLike,
  stripVectors,
  stripVectorsFromSchema,
  sanitizePromptModule,
};
