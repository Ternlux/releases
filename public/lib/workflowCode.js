/**
 * workflowCode.js — Externalize node code out of the workflows collection.
 *
 * Node configs carry source code as strings. Storing it inline bloats the NeDB
 * document and makes the code impossible to edit from an IDE or external AI tool.
 * Instead we write each code field to a file on disk and replace the value in the
 * stored document with a sentinel `{ __codeFile: "<relative/path>" }`. On read we
 * read the file back and re-inline the real string, so the editor and executors
 * see workflows exactly as before.
 *
 * On-disk layout (under a caller-supplied base dir):
 *   {baseDir}/{workflowId}/{nodeId}/{fieldName}.{ext}
 *
 * The fields below are the canonical, code-only variables produced by the node
 * builders (DataSourceNodeChat / TransformerNodeChat / JoinNodeChat buildConfig)
 * and the skills (javascript-executor → transformFunction, python-executor →
 * pythonCode). These top-level config fields are externalized, and so are the
 * per-source code steps the join node builds inside `sourcesConfig` (each entry's
 * `ddl` / `sql` / `nosqlOperation`), written under a `sourcesConfig/<source>/`
 * subfolder. The rest of each `sourcesConfig` entry (and `chat` history) stays
 * inline.
 *
 * No migration / no backwards-compatibility: only the sentinel form is inlined.
 */

const fs = require('fs');
const path = require('path');

// Write `val` to `abs` only when it differs from what's already on disk.
// Rewriting an unchanged file still bumps its mtime and makes fs watchers
// (workflowCodeWatcher / fileWatchTriggers) fire a spurious "change" event, so
// every save of a workflow would otherwise emit one event per externalized code
// file even when nothing changed. Skipping no-op writes keeps the watchers quiet
// and avoids the reload/autosave feedback loop in the editor.
function writeIfChanged(abs, val) {
  try {
    if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === val) return false;
  } catch (_) {
    // Unreadable/racy — fall through and (over)write.
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, val, 'utf8');
  return true;
}

// Canonical code-only config fields → file extension.
const CODE_FIELDS = {
  // DataSource node
  sourceSql: 'sql',
  sourcePreviewSql: 'sql',
  apiFetchCode: 'js',
  // Transformer / Join node — SQL targets
  targetSql: 'sql',
  targetDdl: 'sql',
  targetInsertSql: 'sql',
  targetPreviewSql: 'sql',
  joinSql: 'sql',
  // NoSQL / JS / Python transforms
  nosqlOperation: 'js',
  transformFunction: 'js',
  javascriptFunction: 'js',
  pythonCode: 'py',
};

// Per-source code fields inside a join config's `sourcesConfig[]`. Each entry is
// a "load this source" step the join builder emits; these are the only string
// code values on it (vectorFetchOperation is an object and stays inline).
const SOURCE_CONFIG_CODE_FIELDS = {
  ddl: 'sql',
  sql: 'sql',
  insertSql: 'sql',
  nosqlOperation: 'js',
};

// Generic/default node labels (lower-cased) that are NOT distinctive enough to
// name a directory after — see labelFor() in workflowBuilder.js and NodeTypePanel.
const DEFAULT_NODE_LABELS = new Set([
  'start', 'data source', 'datasource', 'transformer', 'join',
  'output', 'branch', 'node', 'unnamed',
]);

// Turn an arbitrary name into a safe directory name: keep alphanumerics, dash,
// underscore and dot; turn everything else into spaces, collapse runs to single
// underscores, trim edge separators, and cap the length. Returns '' when nothing
// usable remains (caller should fall back to an id).
function safeDirectoryName(name) {
  if (name == null) return '';
  let s = String(name).trim();
  s = s.replace(/[^A-Za-z0-9._ -]+/g, ' '); // drop unsafe chars (path seps, →, (), …)
  s = s.replace(/\s+/g, '_');               // whitespace → underscore
  s = s.replace(/_+/g, '_');                // collapse repeats
  s = s.replace(/^[._-]+|[._-]+$/g, '');    // trim leading/trailing separators
  if (s.length > 120) s = s.slice(0, 120).replace(/[._-]+$/, '');
  return s;
}

// Directory name for a workflow: its (safe) name, falling back to its id.
function workflowDirName(name, id) {
  return safeDirectoryName(name) || String(id || '');
}

// Map each node id → directory name. A node uses its label only when the label
// is distinctive (not a default like "Transformer"/"Join") AND its safe form is
// unique across the workflow; otherwise it falls back to the node id.
function computeNodeDirNames(nodes) {
  const result = new Map();
  if (!Array.isArray(nodes)) return result;
  const candidate = new Map(); // nodeId → safe label
  const counts = new Map();     // safe label → occurrences
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const rawLabel = node.data && node.data.label;
    const norm = String(rawLabel || '').trim().toLowerCase();
    const safe = safeDirectoryName(rawLabel);
    if (safe && !DEFAULT_NODE_LABELS.has(norm)) {
      candidate.set(node.id, safe);
      counts.set(safe, (counts.get(safe) || 0) + 1);
    }
  }
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const safe = candidate.get(node.id);
    result.set(node.id, safe && counts.get(safe) === 1 ? safe : String(node.id));
  }
  return result;
}

// Resolve the workflow id from a NeDB query: { id }, { _id }, or
// { $or: [{ id }, { _id }] }.
function extractWorkflowId(query) {
  if (!query || typeof query !== 'object') return null;
  if (typeof query.id === 'string') return query.id;
  if (typeof query._id === 'string') return query._id;
  if (Array.isArray(query.$or)) {
    for (const sub of query.$or) {
      const id = extractWorkflowId(sub);
      if (id) return id;
    }
  }
  return null;
}

// ── Externalize (write) ─────────────────────────────────────────────────────

// Sub-directory name for one sourcesConfig entry. Prefer the source node id (it
// is unique per join and stable), then its label, then the array index. Mirrors
// the safe-naming used for workflow/node directories.
function sourceConfigDirKey(entry, index) {
  return safeDirectoryName(entry && entry.sourceNodeId)
    || safeDirectoryName(entry && entry.sourceNodeLabel)
    || `source_${index}`;
}

// Externalize the per-source code steps in a join config's sourcesConfig[]. Each
// entry's code fields are written to {nodeDir}/sourcesConfig/<source>/{field}.{ext}
// and replaced with a sentinel. Returns a new array when anything changed, else
// the original reference (so callers can detect "no change").
function externalizeSourcesConfig(sourcesConfig, nodeDir, workflowDir, baseDir) {
  if (!Array.isArray(sourcesConfig)) return sourcesConfig;
  let changed = false;
  const out = sourcesConfig.map((entry, index) => {
    if (!entry || typeof entry !== 'object') return entry;
    let entryOut = null;
    const key = sourceConfigDirKey(entry, index);
    for (const [field, ext] of Object.entries(SOURCE_CONFIG_CODE_FIELDS)) {
      const val = entry[field];
      if (typeof val !== 'string' || val.length === 0) continue;
      const fileName = `${field}.${ext}`;
      const rel = `${workflowDir}/${nodeDir}/sourcesConfig/${key}/${fileName}`;
      const abs = path.join(baseDir, workflowDir, nodeDir, 'sourcesConfig', key, fileName);
      writeIfChanged(abs, val);
      if (!entryOut) entryOut = { ...entry };
      entryOut[field] = { __codeFile: rel };
    }
    if (entryOut) { changed = true; return entryOut; }
    return entry;
  });
  return changed ? out : sourcesConfig;
}

// Replace every known code string in `config` with a sentinel, writing the code
// to disk at {baseDir}/{workflowDir}/{nodeDir}/{field}.{ext}. Returns a shallow
// copy when anything changed, else the original.
function externalizeConfig(config, nodeDir, workflowDir, baseDir) {
  if (!config || typeof config !== 'object') return config;
  let out = null;
  for (const [field, ext] of Object.entries(CODE_FIELDS)) {
    const val = config[field];
    if (typeof val !== 'string' || val.length === 0) continue;
    const fileName = `${field}.${ext}`;
    const rel = `${workflowDir}/${nodeDir}/${fileName}`;
    const abs = path.join(baseDir, workflowDir, nodeDir, fileName);
    writeIfChanged(abs, val);
    if (!out) out = { ...config };
    out[field] = { __codeFile: rel };
  }
  const newSources = externalizeSourcesConfig(config.sourcesConfig, nodeDir, workflowDir, baseDir);
  if (newSources !== config.sourcesConfig) {
    if (!out) out = { ...config };
    out.sourcesConfig = newSources;
  }
  return out || config;
}

// Externalize code across a workflow doc's nodes[]. The directory is named
// after the workflow name (falling back to its id) and each node after a
// unique, non-default label (falling back to its id). Never mutates the input;
// returns a copy with sentinels in place. `workflowName` overrides doc.name
// (needed on the update path where the name lives outside the doc).
//
// executionSteps hold no code: a step is `{ nodeId, order }`. They used to carry
// a snapshot of their node's config, with the same field names as the live node,
// and externalizing both against one node directory made them fight over a
// single file — `<wfDir>/<nodeDir>/sourcePreviewSql.sql` written by the node and
// then OVERWRITTEN by the step, whose older code the next load inlined back onto
// the node. (That is how a data source repointed from DuckDB to BigQuery kept
// answering with `SELECT * FROM "wf_output_output_1"."earliest_transactions"`.)
// With no config on a step there is nothing to externalize; inlining still reads
// whatever path a sentinel names, so old documents keep resolving.
function externalizeWorkflowCode(doc, workflowId, baseDir, workflowName) {
  if (!doc || typeof doc !== 'object' || !workflowId) return doc;
  const out = { ...doc };
  const wfDir = workflowDirName(workflowName !== undefined ? workflowName : doc.name, workflowId);
  const nodeDirs = computeNodeDirNames(out.nodes);
  if (Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((node) => {
      const nodeId = node && node.id;
      const cfg = node && node.data && node.data.config;
      if (!nodeId || !cfg) return node;
      const nodeDir = nodeDirs.get(nodeId) || String(nodeId);
      const newCfg = externalizeConfig(cfg, nodeDir, wfDir, baseDir);
      if (newCfg === cfg) return node;
      return { ...node, data: { ...node.data, config: newCfg } };
    });
  }
  return out;
}

// Externalize code inside a NeDB update modifier. Only handles a whole-array
// replacement of nodes under $set (the only shape the app uses that carries
// code). `workflowName` is the workflow's current name (the caller resolves it,
// since modify updates may not carry it). Returns a copy of `update` with code
// externalized, or `update` as-is.
function externalizeUpdateCode(query, update, baseDir, workflowName) {
  if (!update || typeof update !== 'object') return update;
  const set = update.$set;
  if (!set || !Array.isArray(set.nodes)) return update;
  const workflowId = extractWorkflowId(query);
  if (!workflowId) {
    console.warn('[workflowCode] update with no resolvable workflowId; code left inline');
    return update;
  }
  const name = set.name !== undefined ? set.name : workflowName;
  const pseudo = externalizeWorkflowCode({ nodes: set.nodes }, workflowId, baseDir, name);
  return { ...update, $set: { ...set, nodes: pseudo.nodes } };
}

// ── Inline (read) ───────────────────────────────────────────────────────────

// Read one __codeFile sentinel back to its string. Returns '' (with a warning)
// when the file is missing, matching inlineConfig's behaviour.
function readCodeFile(val, baseDir) {
  const abs = path.join(baseDir, val.__codeFile);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    console.warn(`[workflowCode] missing code file ${abs}: ${e.message}`);
    return '';
  }
}

// Reverse of externalizeSourcesConfig: re-inline each entry's per-source code
// sentinels. Returns a new array only when something changed.
function inlineSourcesConfig(sourcesConfig, baseDir) {
  if (!Array.isArray(sourcesConfig)) return sourcesConfig;
  let changed = false;
  const out = sourcesConfig.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    let entryOut = null;
    for (const field of Object.keys(SOURCE_CONFIG_CODE_FIELDS)) {
      const val = entry[field];
      if (!val || typeof val !== 'object' || typeof val.__codeFile !== 'string') continue;
      if (!entryOut) entryOut = { ...entry };
      entryOut[field] = readCodeFile(val, baseDir);
    }
    if (entryOut) { changed = true; return entryOut; }
    return entry;
  });
  return changed ? out : sourcesConfig;
}

function inlineConfig(config, baseDir) {
  if (!config || typeof config !== 'object') return config;
  let out = null;
  for (const field of Object.keys(CODE_FIELDS)) {
    const val = config[field];
    if (!val || typeof val !== 'object' || typeof val.__codeFile !== 'string') continue;
    if (!out) out = { ...config };
    out[field] = readCodeFile(val, baseDir);
  }
  const newSources = inlineSourcesConfig(config.sourcesConfig, baseDir);
  if (newSources !== config.sourcesConfig) {
    if (!out) out = { ...config };
    out.sourcesConfig = newSources;
  }
  return out || config;
}

// Re-inline code for one workflow doc (or an array of docs). Safe on null.
function inlineWorkflowCode(doc, baseDir) {
  if (Array.isArray(doc)) return doc.map((d) => inlineWorkflowCode(d, baseDir));
  if (!doc || typeof doc !== 'object') return doc;
  const out = { ...doc };
  if (Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((node) => {
      const cfg = node && node.data && node.data.config;
      if (!cfg) return node;
      const newCfg = inlineConfig(cfg, baseDir);
      if (newCfg === cfg) return node;
      return { ...node, data: { ...node.data, config: newCfg } };
    });
  }
  // Steps written before they became `{ nodeId, order }` still carry a config
  // snapshot full of sentinels. Nothing reads that snapshot any more and the
  // next save drops it, but a sentinel must never reach a caller as an object
  // where a string belongs.
  if (Array.isArray(out.executionSteps)) {
    out.executionSteps = out.executionSteps.map((step) => {
      if (!step || !step.config) return step;
      const newCfg = inlineConfig(step.config, baseDir);
      if (newCfg === step.config) return step;
      return { ...step, config: newCfg };
    });
  }
  return out;
}

// ── Delete ──────────────────────────────────────────────────────────────────

// Remove a workflow's code folder. `workflowDir` is the directory name (use
// workflowDirName(name, id) to compute it the same way externalize did).
function deleteWorkflowCode(workflowDir, baseDir) {
  if (!workflowDir) return;
  const dir = path.join(baseDir, String(workflowDir));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[workflowCode] failed to remove ${dir}: ${e.message}`);
  }
}

module.exports = {
  CODE_FIELDS,
  SOURCE_CONFIG_CODE_FIELDS,
  safeDirectoryName,
  workflowDirName,
  computeNodeDirNames,
  extractWorkflowId,
  externalizeWorkflowCode,
  externalizeUpdateCode,
  inlineWorkflowCode,
  deleteWorkflowCode,
};
