/**
 * executedNodes.js — which of a workflow's nodes have actually run.
 *
 * A transformer, join or output names its output table the moment it is BUILT,
 * so nothing in its config separates "this table exists" from "this table is
 * planned". Readers — the Data Preview above all — need that distinction, or
 * they query a table no run has created yet.
 *
 * It lives on the WORKFLOW, as one map keyed by node id:
 *
 *   workflow.executedNodes = { 'transformer-1789769098456-2': true }
 *
 * Not on the node, deliberately. A flag inside a node's config is
 * indistinguishable from the node's configuration: running a workflow rewrote
 * every node it touched, so the canvas went dirty, an auto-save fired, and the
 * version history recorded a "node changed" entry whose entire content was a
 * flag no user had touched. The editor's dirty check and the version snapshot
 * both read nodes, edges, name, description and executionSteps — nothing else —
 * so a run now changes nothing either of them looks at. Writing beside the
 * nodes also means a run never touches the `nodes` array, so it cannot race a
 * concurrent save into clobbering a node's config.
 *
 * Tri-state:
 *   true    — the node has run; whatever it writes exists.
 *   false   — the node was built or reconfigured and has not run since.
 *   absent  — no answer either way. Only an explicit `false` blocks a read: the
 *             form panels configure a node without going through a build, so an
 *             absent entry must fall through to the query (and, if the table
 *             really is missing, to the pending-execution state the preview
 *             renders from the failure).
 *
 * The main process keeps its own copies of these few lines (it is CommonJS and
 * cannot import this module): see NodeExecution/workflowExecutionHelpers.js
 * markNodeExecuted and chat/workflowBuilder.js.
 */

/** Node types that materialise something when they run — a table, a collection, a file. */
export const MATERIALIZING_NODE_TYPES = new Set(['transformer', 'join', 'output']);

/**
 * The map as it should be persisted alongside a node list: entries for nodes
 * that still exist, nothing else. Without this a workflow accumulates a key per
 * node it has ever held, and a deleted-then-recreated node id (they carry a
 * timestamp, so this is unlikely rather than impossible) would inherit an
 * answer about output that is long gone.
 */
export const prunedExecutedNodes = (executedNodes = {}, nodes = []) => {
  const out = {};
  for (const node of nodes) {
    if (node?.id && node.id in (executedNodes || {})) out[node.id] = executedNodes[node.id];
  }
  return out;
};

/**
 * Would reading this node's output query something that isn't there yet?
 *
 * Only an explicit `false` counts — see the tri-state note above.
 */
export const awaitsExecution = (node, executedNodes = {}) => (
  !!node
  && MATERIALIZING_NODE_TYPES.has(node.type)
  && (executedNodes || {})[node.id] === false
);

/**
 * Record that these nodes were just (re)built and have not run since.
 *
 * Only materializing types are tracked; a data source reads something that
 * already exists, so it has nothing to flag. Returns the same map when there is
 * nothing to change, so a caller can skip a redundant setState.
 */
export const markPending = (executedNodes = {}, nodes = []) => {
  let next = executedNodes;
  for (const node of nodes) {
    if (!node?.id || !MATERIALIZING_NODE_TYPES.has(node.type)) continue;
    if (next[node.id] === false) continue;
    if (next === executedNodes) next = { ...executedNodes };
    next[node.id] = false;
  }
  return next;
};
