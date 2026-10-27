/**
 * workflowHistory.js — what changed between two saves of a workflow.
 *
 * Pure functions only: taking a snapshot of a workflow, diffing two snapshots,
 * and describing the result. Persistence lives in localDb.js (workflowHistoryDb)
 * and the UI in components/Workflows/WorkflowHistory.js.
 *
 * A history entry stores the FULL snapshot of the version plus the diff against
 * the version before it. The snapshot is what a revert restores; the diff is
 * only what the list renders. Keeping both means a revert never has to replay a
 * chain of diffs, and a truncated history (see MAX_VERSIONS) still reverts
 * correctly to any version it still holds.
 */

// ReactFlow writes these onto nodes as you click and drag. They are not user
// content, so they are stripped from the snapshot entirely — otherwise every
// save would record a change and the history would be noise.
const NODE_TRANSIENT_KEYS = ['selected', 'dragging', 'resizing', 'width', 'height', 'positionAbsolute'];
const EDGE_TRANSIENT_KEYS = ['selected'];

// Moving a node around the canvas IS persisted (a revert should put the layout
// back), but it is not what "this node changed" means — the editor's own dirty
// check draws the same line. Position differences are recorded in the snapshot
// and ignored when classifying a node as modified.
const IGNORED_NODE_PATHS = new Set(['position']);

/** How many versions are kept per workflow. Oldest are dropped first. */
export const MAX_VERSIONS = 50;

const stripKeys = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

/**
 * Drop the bookkeeping the app writes into a node's config for its own use.
 *
 * None of it is authored — it is derived from the config beside it, or from
 * what a run did — so a save whose only difference is bookkeeping is not a
 * version, and listing these as changed fields says nothing the node's real
 * diff doesn't already say.
 *
 * That is `node_name` / `node_nameAuto`: the display name, cached into the
 * config so the main process (which cannot derive one) can read it, and
 * re-derived on every save by nodeCardShared.withPersistedNodeNames. Because
 * the builder hands back a config without it, the stamp lands at the END of the
 * object on the save after a build — which is why it read as "node_name moved"
 * in the side-by-side view, that being a line comparison.
 *
 * A name the USER typed carries no `node_nameAuto` flag: that one is content, a
 * revert has to restore it, and it stays.
 *
 * Keys are deleted from a copy rather than rebuilt, so what survives keeps its
 * original order — sideBySideLines renders the snapshot line by line, and a
 * reordered key would show up as a change.
 *
 * Exported because the editor's own dirty check has to draw the same line: a
 * name the editor treats as an edit would trigger the save that records the
 * version this strip is here to prevent.
 */
export const stripNodeBookkeeping = (node) => {
  const config = node?.data?.config;
  if (!config || typeof config !== 'object' || !config.node_nameAuto) return node;
  const next = { ...config };
  delete next.node_name;
  delete next.node_nameAuto;
  return { ...node, data: { ...node.data, config: next } };
};

/** Deep structural equality, by value. Snapshots are already plain JSON. */
const deepEqual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The persisted shape of a workflow, normalized so two snapshots of an
 * unchanged workflow compare equal.
 *
 * Accepts either the payload the editor saves or a stored workflow document —
 * they carry the same field names.
 *
 * `executedNodes` is deliberately NOT part of this: which nodes have run is
 * what a run did, not what the workflow IS, so a run must not produce a version
 * and a revert must not claim output exists that no longer does. See
 * utils/executedNodes.js.
 */
export const snapshotOf = (workflow = {}) => ({
  name: workflow.name || '',
  description: workflow.description || '',
  nodes: (workflow.nodes || []).map((n) => stripNodeBookkeeping(stripKeys(n, NODE_TRANSIENT_KEYS))),
  edges: (workflow.edges || []).map((e) => stripKeys(e, EDGE_TRANSIENT_KEYS)),
  executionSteps: workflow.executionSteps || [],
});

/**
 * Every leaf path that differs between two objects, as dotted strings
 * ("data.config.query"). Arrays are compared as whole values — a reordered
 * array of columns is one change, not twenty.
 *
 * `limit` caps the walk: a node whose entire config was replaced would
 * otherwise list hundreds of paths that say nothing the "modified" label
 * doesn't already say.
 */
export const changedPaths = (before, after, { prefix = '', limit = 40, ignore = null } = {}) => {
  const out = [];

  const walk = (a, b, path) => {
    if (out.length >= limit) return;
    if (ignore && ignore.has(path)) return;
    if (deepEqual(a, b)) return;

    const bothPlainObjects = (
      a && b
      && typeof a === 'object' && typeof b === 'object'
      && !Array.isArray(a) && !Array.isArray(b)
    );
    if (!bothPlainObjects) {
      out.push(path);
      return;
    }

    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(a[key], b[key], path ? `${path}.${key}` : key);
    }
  };

  walk(before, after, prefix);
  return out;
};

/**
 * Per-node changes between two snapshots, keyed by node id.
 *
 * Each entry carries the WHOLE node object before and after, not just the
 * changed fields — that is what the detail pane renders side by side, and what
 * makes an entry readable without the version before it.
 */
export const diffNodes = (prevNodes = [], nextNodes = []) => {
  const byId = (list) => new Map((list || []).filter(Boolean).map((n) => [n.id, n]));
  const before = byId(prevNodes);
  const after = byId(nextNodes);
  const changes = [];

  for (const [id, node] of after) {
    const prior = before.get(id);
    if (!prior) {
      changes.push({ nodeId: id, type: node.type, change: 'added', before: null, after: node, fields: [] });
      continue;
    }
    const fields = changedPaths(prior, node, { ignore: IGNORED_NODE_PATHS });
    if (fields.length) {
      changes.push({ nodeId: id, type: node.type, change: 'modified', before: prior, after: node, fields });
    }
  }

  for (const [id, node] of before) {
    if (!after.has(id)) {
      changes.push({ nodeId: id, type: node.type, change: 'removed', before: node, after: null, fields: [] });
    }
  }

  // Added first, then modified, then removed — the order the list reads in.
  const rank = { added: 0, modified: 1, removed: 2 };
  return changes.sort((a, b) => rank[a.change] - rank[b.change]);
};

/** Edge-level changes. Edges have no interesting body, so it's add/remove only. */
export const diffEdges = (prevEdges = [], nextEdges = []) => {
  const key = (e) => `${e.source}->${e.target}`;
  const before = new Map((prevEdges || []).filter(Boolean).map((e) => [e.id || key(e), e]));
  const after = new Map((nextEdges || []).filter(Boolean).map((e) => [e.id || key(e), e]));
  const changes = [];
  for (const [id, edge] of after) if (!before.has(id)) changes.push({ edgeId: id, change: 'added', edge });
  for (const [id, edge] of before) if (!after.has(id)) changes.push({ edgeId: id, change: 'removed', edge });
  return changes;
};

/**
 * The full diff between two snapshots. `null` for `prev` means the first
 * version — everything in it reads as added.
 */
export const diffSnapshots = (prev, next) => {
  const before = prev ? snapshotOf(prev) : { name: '', description: '', nodes: [], edges: [], executionSteps: [] };
  const after = snapshotOf(next);

  const nodes = diffNodes(before.nodes, after.nodes);
  const edges = diffEdges(before.edges, after.edges);
  const renamed = before.name !== after.name;
  const describedDifferently = before.description !== after.description;
  const stepsReordered = !deepEqual(before.executionSteps, after.executionSteps);

  const counts = {
    nodesAdded: nodes.filter((n) => n.change === 'added').length,
    nodesModified: nodes.filter((n) => n.change === 'modified').length,
    nodesRemoved: nodes.filter((n) => n.change === 'removed').length,
    edgesAdded: edges.filter((e) => e.change === 'added').length,
    edgesRemoved: edges.filter((e) => e.change === 'removed').length,
  };

  return {
    nodes,
    edges,
    counts,
    name: renamed ? { before: before.name, after: after.name } : null,
    description: describedDifferently ? { before: before.description, after: after.description } : null,
    executionStepsChanged: stepsReordered,
    // Layout-only saves still produce a version (the positions are worth
    // keeping), but they have nothing to list — this is what the UI says so.
    isEmpty: (
      !nodes.length && !edges.length && !renamed && !describedDifferently && !stepsReordered
    ),
  };
};

/** True when two workflow states are identical in every persisted respect. */
export const isUnchanged = (prev, next) => (
  !!prev && deepEqual(snapshotOf(prev), snapshotOf(next))
);

/** One-line description of a diff, for the version list. */
export const describeDiff = (diff) => {
  if (!diff) return 'No changes recorded';
  const parts = [];
  const { counts } = diff;
  if (counts.nodesAdded) parts.push(`${counts.nodesAdded} node${counts.nodesAdded === 1 ? '' : 's'} added`);
  if (counts.nodesModified) parts.push(`${counts.nodesModified} node${counts.nodesModified === 1 ? '' : 's'} changed`);
  if (counts.nodesRemoved) parts.push(`${counts.nodesRemoved} node${counts.nodesRemoved === 1 ? '' : 's'} removed`);
  if (counts.edgesAdded || counts.edgesRemoved) {
    const n = counts.edgesAdded + counts.edgesRemoved;
    parts.push(`${n} connection${n === 1 ? '' : 's'} changed`);
  }
  if (diff.name) parts.push('renamed');
  if (diff.description) parts.push('description edited');
  if (diff.executionStepsChanged && !parts.length) parts.push('execution steps reordered');
  if (!parts.length) return 'Layout only';
  return parts.join(', ');
};

/**
 * A line-oriented before/after for one changed node, ready to render.
 * Returns two arrays of { text, state } where state is 'same' | 'removed' |
 * 'added' — the two columns of a side-by-side view, padded so the rows line up.
 *
 * This is a plain line comparison, not a Myers diff: node JSON is small and
 * mostly stable in key order (both sides come from the same serializer), so the
 * result reads correctly without the extra machinery.
 */
export const sideBySideLines = (before, after) => {
  const toLines = (obj) => (obj === null || obj === undefined ? [] : JSON.stringify(obj, null, 2).split('\n'));
  const left = toLines(before);
  const right = toLines(after);

  const n = left.length;
  const m = right.length;

  // The LCS table below is n×m cells. A node holding a few thousand lines of
  // generated SQL on both sides would allocate tens of megabytes to align a
  // view the user is scrolling anyway — past this size, compare row by row.
  if (n * m > 4_000_000) {
    const rows = Math.max(n, m);
    const pick = (list, i, state) => (
      i < list.length ? { text: list[i], state } : { text: null, state: 'pad' }
    );
    const leftFallback = [];
    const rightFallback = [];
    for (let i = 0; i < rows; i += 1) {
      const same = left[i] === right[i];
      leftFallback.push(pick(left, i, same ? 'same' : 'removed'));
      rightFallback.push(pick(right, i, same ? 'same' : 'added'));
    }
    return { left: leftFallback, right: rightFallback };
  }

  // Longest common subsequence over lines, so unchanged regions stay aligned.
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const leftOut = [];
  const rightOut = [];
  const pad = (rows, count) => { for (let k = 0; k < count; k += 1) rows.push({ text: null, state: 'pad' }); };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      leftOut.push({ text: left[i], state: 'same' });
      rightOut.push({ text: right[j], state: 'same' });
      i += 1; j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      leftOut.push({ text: left[i], state: 'removed' });
      pad(rightOut, 1);
      i += 1;
    } else {
      pad(leftOut, 1);
      rightOut.push({ text: right[j], state: 'added' });
      j += 1;
    }
  }
  while (i < n) { leftOut.push({ text: left[i], state: 'removed' }); pad(rightOut, 1); i += 1; }
  while (j < m) { pad(leftOut, 1); rightOut.push({ text: right[j], state: 'added' }); j += 1; }

  return { left: leftOut, right: rightOut };
};
