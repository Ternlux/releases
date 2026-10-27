/**
 * Utility functions for workflow processing
 */

import { nodeDisplayName } from '../components/Workflows/nodes/nodeCardShared';

/**
 * Generate execution order using DFS logic, including disconnected nodes
 * @param {Array} workflowNodes - Array of workflow nodes
 * @param {Array} workflowEdges - Array of workflow edges
 * @param {string} startNodeId - ID of the start node
 * @returns {Array} - Array of node IDs in execution order
 */
/**
 * How many inputs a node needs before it can be configured, and what to tell
 * the user when it has fewer. One definition for the canvas (opening a node)
 * and the assistant (being asked to build one), so both say the same thing.
 */
const REQUIRED_INPUTS = { transformer: 1, join: 2, branch: 1, output: 1 };
const REQUIREMENT_MESSAGES = {
  transformer: 'Transformer node requires a source connection to configure',
  join: 'Join node requires two input connections to configure',
  branch: 'Branch node requires at least one input connection to configure',
  output: 'Output node requires an input connection to configure',
};

/** Does a node of `type` with `inputCount` incoming edges have what it needs? */
export const hasRequiredInputs = (type, inputCount) => inputCount >= (REQUIRED_INPUTS[type] || 0);

/** The message for a node of `type` that is missing inputs. */
export const nodeRequirementMessage = (type) => REQUIREMENT_MESSAGES[type] || 'Node cannot be configured';

export const getNodeExecutionOrder = (workflowNodes, workflowEdges, startNodeId) => {
  const executionOrder = [];
  const processed = new Set();

  const dfs = (nodeId) => {
    if (processed.has(nodeId)) {
      return;
    }

    processed.add(nodeId);
    executionOrder.push(nodeId);

    // Find all edges that start from this node
    const outgoingEdges = workflowEdges.filter(edge => edge.source === nodeId);

    for (const edge of outgoingEdges) {
      const targetNodeId = edge.target;

      // Check if all input nodes for the target have been processed
      const incomingEdges = workflowEdges.filter(e => e.target === targetNodeId);
      const allInputsReady = incomingEdges.every(e => processed.has(e.source));

      if (allInputsReady) {
        dfs(targetNodeId);
      }
    }
  };

  // Start DFS from the start node
  dfs(startNodeId);

  // Add any disconnected nodes that weren't reached by DFS
  const allNodeIds = new Set(workflowNodes.map(node => node.id));
  const unprocessedNodes = [...allNodeIds].filter(nodeId => !processed.has(nodeId));
  
  // Add disconnected nodes at the end (except output nodes which should stay last)
  const disconnectedOutputs = [];
  const disconnectedOthers = [];
  
  unprocessedNodes.forEach(nodeId => {
    const node = workflowNodes.find(n => n.id === nodeId);
    if (node && node.type === 'output') {
      disconnectedOutputs.push(nodeId);
    } else {
      disconnectedOthers.push(nodeId);
    }
  });
  
  // Add other disconnected nodes before output nodes
  executionOrder.push(...disconnectedOthers);
  executionOrder.push(...disconnectedOutputs);
  
  console.log('DFS execution order:', executionOrder, 'processed:', processed.size, 'total nodes:', allNodeIds.size);
  
  return executionOrder;
};

// ── What an execution step is ───────────────────────────────────────────────
//
// `{ nodeId, order }` and nothing else.
//
// A step is an ORDER, not a definition. The executor takes `nodeId`, looks the
// node up in the workflow's nodes[] and runs `node.data.config` from there (see
// `workflow:execute` and the trigger runner in public/electron.js); `order` is
// the sequence it walks them in. Everything a step used to carry besides those
// two — a node type, a label, a description, a whole copy of the node's config
// with its chat transcript and sampled rows — was a SNAPSHOT of the node taken
// when the step was written, and every one of them could only go stale: rename
// a node and its step kept the old name, rebuild a transformer and its step
// kept the old SQL. Duplicated into every save, every history version and every
// exported JSON, that snapshot was most of the file.
//
// Anything that needs to draw or name a step reads the live node instead —
// `hydrateSteps` below pairs them up, and nodeDisplayName gives the same name
// the canvas card shows.

/** The two fields that survive. Keeps old fat steps readable on the way in. */
const minimalStep = (step, order) => ({ nodeId: step.nodeId, order });

/**
 * Drop steps whose node is gone, renumber what is left, and reduce each one to
 * `{ nodeId, order }`. Use this wherever executionSteps are loaded, persisted
 * or run.
 *
 * The pruning matters on its own: a deleted node used to leave its step behind,
 * because every path that keeps saved steps only checks that the CURRENT nodes
 * are all covered — which a leftover step never breaks. That is how a saved
 * workflow came to list sixteen steps for four nodes, naming sources and
 * outputs the user had removed.
 */
export const sanitizeExecutionSteps = (steps, workflowNodes) => {
  const saved = Array.isArray(steps) ? steps : [];
  const liveIds = new Set((workflowNodes || []).map((n) => n.id));
  return saved
    .filter((step) => step && liveIds.has(step.nodeId))
    .map(minimalStep);
};

/**
 * Pair each step with the node it names, for the screens that draw a step list.
 * A step carries nothing to draw itself with — the node is the single source of
 * its name, type and description.
 */
export const hydrateSteps = (steps = [], workflowNodes = []) => {
  const byId = new Map((workflowNodes || []).map((n) => [n.id, n]));
  return (steps || [])
    .map((step, index) => ({ nodeId: step.nodeId, order: step.order ?? index, node: byId.get(step.nodeId) }))
    .filter((step) => step.node);
};

/** The description line a step shows — the node's own, by node type. */
export const stepDescriptionOf = (node) => {
  const config = node?.data?.config || {};
  if (node?.type === 'transformer') return config.transformationRequest || '';
  if (node?.type === 'join') return config.joinDescription || '';
  return config.description || '';
};

/**
 * Generate execution steps from workflow nodes
 * @param {Array} workflowNodes - Array of workflow nodes
 * @param {Array} workflowEdges - Array of workflow edges
 * @returns {Array} - Array of { nodeId, order }
 */
export const generateStepsFromNodes = (workflowNodes, workflowEdges) => {
  // Find start node
  const startNode = workflowNodes.find(node => node.type === 'start');
  if (!startNode) return [];

  // Get execution order using DFS logic
  const nodeIds = getNodeExecutionOrder(workflowNodes, workflowEdges, startNode.id)
    .filter((nodeId) => workflowNodes.some((n) => n.id === nodeId));

  // Ensure start node is first. Output nodes stay where the graph order put
  // them: a workflow can have several, and an output may legitimately sit
  // mid-pipeline, so nothing is forced to the end.
  const startIndex = nodeIds.indexOf(startNode.id);
  if (startIndex > 0) {
    nodeIds.splice(startIndex, 1);
    nodeIds.unshift(startNode.id);
  }

  return nodeIds.map((nodeId, index) => ({ nodeId, order: index }));
};
/**
 * The step list a screen should show for the current graph.
 *
 * Steps for nodes that no longer exist are dropped first — they are not part of
 * this workflow any more, whatever the saved list says. What remains is kept —
 * and its order respected — only while it still covers every node; a node added
 * since means the list is stale, so it is rebuilt from the graph. Mirrors what
 * WorkflowStepsEditor does on open, so the unsaved-changes prompt and the
 * editor never disagree on how many steps there are.
 */
export const resolveExecutionSteps = (savedSteps, workflowNodes, workflowEdges) => {
  const nodes = workflowNodes || [];
  const saved = sanitizeExecutionSteps(savedSteps, nodes);

  if (saved.length > 0) {
    const covered = new Set(saved.map((s) => s.nodeId));
    const complete = nodes.every((n) => covered.has(n.id));
    if (complete) return [...saved].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  if (nodes.length === 0) return [];
  return generateStepsFromNodes(nodes, workflowEdges) || [];
};

/**
 * A node's INPUT fields, as read from the node feeding it.
 *
 * Every downstream node describes its input with `source*` fields copied from
 * its parent when the node was configured. A parent that writes a result
 * (transformer / join) describes that result with `target*`, so those come
 * first; a data source only has a `source*` side.
 *
 * Mirrors copySourceFromUpstream in public/chat/workflowBuilder.js — the
 * headless builder does the same copy when it builds a node — so a node wired
 * on the canvas and one built from chat record their input identically.
 */
export const sourceFieldsFromUpstream = (upstreamNode) => {
  const u = upstreamNode?.data?.config || {};
  return {
    sourceNodeId: upstreamNode?.id,
    // The name the canvas shows, not `data.label` — that is the creation-time
    // type name ("Data Source") which the node chats record and which is
    // useless for telling two sources apart.
    sourceNodeLabel: upstreamNode ? nodeDisplayName(upstreamNode.type, upstreamNode.data, upstreamNode.id) : undefined,
    sourceConnectionId: u.targetConnectionId || u.sourceConnectionId,
    sourceConnectionName: u.targetConnectionName || u.sourceConnectionName,
    sourceConnectionType: u.targetConnectionType || u.sourceConnectionType,
    sourceDbType: u.targetDbType || u.sourceDbType,
    sourceDbConfig: u.targetDbConfig || u.sourceDbConfig,
    sourceDbCategory: u.targetDbCategory || u.sourceDbCategory,
    sourceType: u.targetDbType || u.sourceDbType,
    sourceLocalPath: u.targetLocalPath || u.sourceLocalPath,
    sourceTableName: u.targetTableName || u.sourceTableName,
    sourceCollection: u.targetCollection || u.sourceCollection,
    sourceSchema: u.targetSchema || u.sourceSchema,
    sourceIndexName: u.targetIndexName || u.sourceIndexName,
    sourceNamespace: u.targetNamespace || u.sourceNamespace,
    sourceTableSchema: u.targetTableSchema || u.sourceTableSchema,
    sourceDataset: u.targetDataset || u.sourceDataset,
    sourcePreviewSql: u.targetPreviewSql || u.sourcePreviewSql,
  };
};

/** The fields sourceFieldsFromUpstream owns, so a re-point can replace them wholesale. */
const SOURCE_FIELD_KEYS = Object.keys(sourceFieldsFromUpstream(null));

/**
 * Re-point ONE entry of a join's `sourcesConfig` at what its parent now reads.
 *
 * Only the identity — the connection to open, the table to read, the shape it
 * has. NOT the entry's `sql` / `ddl` / `tempTableName`: those were generated
 * against the old source in the old engine's quoting, and rewriting them is the
 * node's own chat's job. So a source retargeted to another TABLE now fails
 * loudly at the read instead of quietly returning the old table's rows, while
 * one moved to another connection holding the same table keeps working.
 *
 * Mirrors repointJoinSourceConfig in public/chat/workflowBuilder.js, which does
 * this for a chat rebuild. Two copies because one runs in the renderer and the
 * other in the main process; keep them in step.
 */
const repointSourceConfigEntry = (entry, fresh) => {
  if (!entry) return entry;
  const table = fresh.sourceTableName
    || fresh.sourceCollection
    || fresh.sourceTableSchema?.tableName
    || entry.tableName
    || null;
  const connId = fresh.sourceConnectionId || entry.connection?.id || null;
  const connMoved = !!entry.connection?.id && !!connId && entry.connection.id !== connId;
  // A parent with no schema says nothing about the shape — a REST API source has
  // none until its fetch is built, and older data sources were saved before
  // theirs loaded — so it cannot mean the entry's schema changed. Counting it as
  // a change rebuilt an identical entry on every pass (the rebuild keeps the
  // entry's schema), the canvas re-synced forever, and each pass overwrote any
  // other edit to the join.
  const schemaUnchanged = !fresh.sourceTableSchema
    || fresh.sourceTableSchema === (entry.sourceTableSchema || null);
  if (!connMoved && table === entry.tableName && schemaUnchanged) return entry;
  const tableMoved = !!entry.tableName && table !== entry.tableName;
  const moved = connMoved || tableMoved;
  // Where this step's `sql` and `ddl` still point: the FIRST divergence, kept
  // through however many moves follow.
  const from = entry.sourceMoved?.from
    || { connectionId: entry.connection?.id || null, tableName: entry.tableName || null };
  const to = { connectionId: connId, tableName: table };
  const next = {
    ...entry,
    ...(table ? { tableName: table } : {}),
    // The recorded schema describes the table this entry USED to read. Once it
    // reads a different one, carrying those columns over is worse than carrying
    // none — everything downstream would believe the new table has the old
    // one's columns. The parent supplies the real shape as soon as it has read
    // it (a table picked in the node's own form has none until then).
    sourceTableSchema: fresh.sourceTableSchema || (tableMoved ? null : entry.sourceTableSchema),
    connection: {
      ...(entry.connection || {}),
      // fileInfo describes the file behind the OLD connection, and the join's
      // loaders read `fileInfo.filePath` before `localPath` — so it cannot
      // survive a move to another connection.
      ...(connMoved ? { fileInfo: null } : {}),
      id: connId,
      dbType: fresh.sourceDbType || entry.connection?.dbType || null,
      localPath: fresh.sourceLocalPath ?? entry.connection?.localPath ?? null,
      dbConfig: {
        // A different connection's dbConfig describes a different server, so it
        // is replaced rather than merged.
        ...(connMoved ? (fresh.sourceDbConfig || {}) : (entry.connection?.dbConfig || {})),
        ...(table ? { tableName: table } : {}),
      },
    },
  };

  // Marked only while the step reads something other than what its `sql` and
  // `ddl` were written for. Back on that original — the user pointed the source
  // at the old table again, or reconnected the old connection — and there is
  // nothing stale left to warn about, so the mark goes. A rebuild is the other
  // way it clears, by regenerating the statements instead.
  if (moved && !sameIdentity(from, to)) next.sourceMoved = { from, to };
  else delete next.sourceMoved;
  return next;
};

/**
 * Every join step re-pointed at its parent. The SAME array back when nothing
 * moved, so callers can use it as the "did anything change" test.
 */
const repointSourcesConfig = (sourcesConfig, parents, isJoin) => {
  if (!isJoin || !Array.isArray(sourcesConfig)) return sourcesConfig;
  let changed = false;
  const next = sourcesConfig.map((entry) => {
    const parent = parents.find((p) => p.id === entry?.sourceNodeId);
    if (!parent) return entry;
    const repointed = repointSourceConfigEntry(entry, sourceFieldsFromUpstream(parent));
    if (repointed !== entry) changed = true;
    return repointed;
  });
  return changed ? next : sourcesConfig;
};

/**
 * A single-source node's source, if it now points somewhere other than what
 * the node's logic was written against — otherwise null.
 *
 * A TRANSFORMER's own SQL names its source table, and an in-place one writes
 * back to it (`targetTableName` IS that table), so a move leaves the node
 * unrunnable. An OUTPUT owns no SQL naming its input and simply forwards the
 * rows it is handed, which is why only the logic-owning types are asked.
 *
 * `from` is the FIRST divergence — where the SQL still points, however many
 * moves follow.
 *
 * Three answers, because "nothing to mark" and "unmark it" are not the same:
 *   an object  — mark the node with this
 *   null       — clear any mark: the source is back on what the SQL names
 *   undefined  — leave whatever is there alone. The node is not one that
 *                carries a mark, or its parent has nothing to read yet, and a
 *                mark raised earlier is still telling the truth.
 */
const flatSourceMoved = (nodeType, config, parents) => {
  if (!LOGIC_OWNING_TYPES.has(nodeType) || parents.length !== 1) return undefined;
  const fresh = sourceFieldsFromUpstream(parents[0]);
  if (!identifiesASource(fresh)) return undefined;
  const from = config.sourceMoved?.from || {
    connectionId: config.sourceConnectionId || null,
    tableName: config.sourceTableName || config.sourceCollection || null,
  };
  const to = {
    connectionId: fresh.sourceConnectionId || null,
    tableName: fresh.sourceTableName || fresh.sourceCollection || null,
  };
  // Back on what the SQL names — whether it never left, or the user has just
  // pointed the source at it again.
  if (sameIdentity(from, to)) return null;
  // Already marked, and still away from it: the mark stands, updated to say
  // where the source has got to now.
  if (config.sourceMoved || inputIdentityDiffers(config, fresh)) return { from, to };
  return null;
};

/**
 * Why this node cannot run, in one word — or '' when it can.
 *
 * The node's own statements were generated for ONE set of sources, each read a
 * specific way, and three things leave that set behind:
 *
 *   moved        — a source now reads another table or connection
 *   disconnected — a source the statements name is no longer wired in
 *   unread       — a source is wired in that the statements never mention
 *
 * A transformer has one source, so only `moved` can apply: losing its parent
 * is caught by the executor, and it cannot have a second one. The executor
 * asks these same questions of the live graph; this is the answer written
 * where the canvas can read it.
 */
const sourceStaleReason = (nodeType, config, movedSource, sourcesConfig, parentIds) => {
  if (nodeType === 'transformer') {
    // `null` means the source is back on what the SQL names — the mark is
    // about to be cleared, so the node is runnable again.
    if (movedSource === null) return '';
    return (movedSource || config.sourceMoved) ? 'moved' : '';
  }
  if (nodeType !== 'join') return '';
  const steps = (Array.isArray(sourcesConfig) ? sourcesConfig : []).filter(Boolean);
  if (steps.length === 0) return '';
  if (steps.some((s) => s.sourceMoved)) return 'moved';
  // Mirrors staleJoinSource: a similarity join's vector source is read by the
  // join's own function, so it has no step but is not "unread".
  const direct = Array.isArray(config.directReadSources) ? config.directReadSources.filter(Boolean) : [];
  const named = [...steps.map((s) => s.sourceNodeId).filter(Boolean), ...direct];
  if (named.some((id) => !parentIds.includes(id))) return 'disconnected';
  if (parentIds.some((id) => !named.includes(id))) return 'unread';
  return '';
};

/** Node types that record a single upstream input. A join records an array. */
const SINGLE_INPUT_TYPES = new Set(['transformer', 'output']);

/** Node types whose own logic names their input, so a rewire invalidates them. */
const LOGIC_OWNING_TYPES = new Set(['transformer', 'join']);

/** What to call a node on screen — the same name its card and step show. */
const labelOf = (node, fallback = null) =>
  (node ? nodeDisplayName(node.type, node.data, fallback || node.id) : fallback);

/** Whether a copied-in source block actually identifies something to read. */
const identifiesASource = (fields) => !!(
  fields.sourceTableName || fields.sourceCollection
  || fields.sourceIndexName || fields.sourceLocalPath || fields.sourceTableSchema
);

/** Two id lists naming the same set, order ignored. */
const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/** The fields of a recorded input block that say WHICH dataset it points at. */
const SOURCE_IDENTITY_KEYS = [
  'sourceConnectionId', 'sourceTableName', 'sourceCollection',
  'sourceIndexName', 'sourceNamespace', 'sourceLocalPath', 'sourceSchema',
];

/**
 * Whether a recorded input block points somewhere other than where its parent
 * now writes.
 *
 * Keeping the right PARENT is not enough. A parent can be rebuilt IN PLACE onto
 * a different connection or table — which is exactly what an assistant "modify"
 * does, keeping the node id — and the child's copy goes on naming the old one.
 * A workflow whose Mongo source and transformer were moved to a new connection
 * failed at its output with "MongoDB URI is required": the output was still
 * asking a connection that had been replaced.
 *
 * Only fields both sides state are compared, so a parent that has simply not
 * been configured yet never counts as a disagreement.
 */
const inputIdentityDiffers = (recorded, fresh) => SOURCE_IDENTITY_KEYS.some((key) => {
  const mine = recorded?.[key];
  const theirs = fresh?.[key];
  return !!mine && !!theirs && mine !== theirs;
});

/** Two {connectionId, tableName} pairs naming the same object. */
const sameIdentity = (a, b) => (a?.connectionId || null) === (b?.connectionId || null)
  && (a?.tableName || null) === (b?.tableName || null);

/** Just the identity fields of a recorded input block, for the baseline. */
const identityOf = (block) => {
  const out = {};
  for (const key of SOURCE_IDENTITY_KEYS) if (block?.[key]) out[key] = block[key];
  return out;
};

/** What a recorded input block reads, in words — "mongo · flat_transactions". */
const datasetLabel = (block) => {
  const file = block?.sourceLocalPath ? String(block.sourceLocalPath).split(/[\\/]/).pop() : null;
  const what = block?.sourceTableName || block?.sourceCollection || block?.sourceIndexName || file;
  return [block?.sourceConnectionName, what].filter(Boolean).join(' · ');
};

/** The column names a recorded (or freshly read) input block offers. */
const columnNamesOf = (block) => {
  const columns = block?.sourceTableSchema?.columns;
  return Array.isArray(columns) ? columns.map((c) => c?.name).filter(Boolean) : [];
};

/**
 * Whether two column lists describe different data.
 *
 * Compared as sets: which columns EXIST is what a transformation's SQL depends
 * on, and a reordered `SELECT *` is not a change worth interrupting anyone
 * over. An empty list on either side means "not known", never "changed".
 */
const columnsDiffer = (mine, theirs) => {
  if (!mine.length || !theirs.length) return false;
  const a = [...mine].sort();
  const b = [...theirs].sort();
  return a.length !== b.length || a.some((name, i) => name !== b[i]);
};

/** What changed about a node's input, for the card to explain. */
export const SOURCE_CHANGE_KINDS = { REWIRED: 'rewired', RETARGETED: 'retargeted', SCHEMA: 'schema' };

/**
 * The request the Rebuild button sends to a fresh chat.
 *
 * Says which node, in which workflow, what its input used to be and what it is
 * now — the three things the assistant would otherwise have to ask for. The
 * node's own config travels separately as the focused `targetNode`, so this
 * states the CHANGE rather than restating the node.
 */
export const sourceChangeRequestText = (node, workflowName) => {
  const config = node?.data?.config || {};
  const nodeName = nodeDisplayName(node?.type, node?.data, node?.id);
  const typeLabel = node?.type === 'join' ? 'join' : 'transformer';
  const was = config.sourceBuiltAgainst || [];
  const now = config.sourceChangedTo || [];

  const side = (entries) => entries.map((entry) => {
    const columns = (entry?.columns || []).join(', ');
    const where = entry?.dataset || entry?.nodeLabel || entry?.nodeId || 'unknown';
    return `  - ${entry?.nodeLabel || entry?.nodeId}: ${where}${columns ? ` (columns: ${columns})` : ''}`;
  }).join('\n');

  const KIND_LINE = {
    rewired: 'it is now wired to a different node',
    retargeted: 'the node feeding it was rebuilt onto a different connection or table',
    schema: 'the node feeding it now returns different columns',
  };

  const original = config.transformationRequest || config.joinDescription || config.builderPrompt || '';

  return [
    `Request to change the node for the workflow "${workflowName || 'Untitled Workflow'}".`,
    '',
    `The ${typeLabel} "${nodeName}" needs rebuilding: `
      + `${KIND_LINE[config.sourceChangeKind] || 'its input changed'}, `
      + 'so the logic it holds was written against something it no longer reads.',
    '',
    'Built against:',
    side(was) || '  - (not recorded)',
    '',
    'Now reads:',
    side(now) || '  - (not recorded)',
    ...(original ? ['', `What it was originally asked to do: ${original}`] : []),
    '',
    `Please rebuild this ${typeLabel} against its current input, keeping what it produces the same `
      + 'where that still makes sense, and tell me anything you had to change.',
  ].join('\n');
};

/**
 * Re-point every node's recorded input at the node that actually feeds it now.
 *
 * A node's `source*` fields are a SNAPSHOT of its parent taken when the node was
 * configured. Rewiring the canvas — dropping a transformer between a data source
 * and an output, say — changes the edge but not that snapshot, so the output
 * goes on reading the data source it is no longer connected to. The executor
 * prefers those recorded fields (workflowExecutionHelpers.executeOutputNode),
 * so the stale copy wins at run time and the new node is silently skipped.
 *
 * What this refreshes is only what a node says about its INPUT. A transformer's
 * or join's own SQL was written against the old input and may now be wrong, but
 * rewriting it is a decision for the user (or the node's chat), not something to
 * guess at here. Those nodes carry two fields instead:
 *
 *   sourceChanged      — true while the node is fed by something other than
 *                        what its logic was written against. The card reads it.
 *   sourceBuiltAgainst — [{ nodeId, nodeLabel }] for that original parent (or
 *                        parents), captured the first time the input diverges.
 *
 * The flag is DERIVED from that baseline rather than latched, which is what
 * makes re-attaching the original parent clear it: the node is back on its
 * baseline, so there is nothing stale left to warn about. Both fields are
 * dropped when the node's config is next saved (WorkflowEditor's
 * mergeConfigWithName) — a regenerated node's new parent becomes its baseline.
 *
 * @returns {{nodes: Array, repointed: Array<{nodeId, nodeLabel, nodeType, from, to, restored}>}}
 *          `nodes` is the same array reference when nothing moved.
 */
export const syncNodeSourcesToEdges = (workflowNodes, workflowEdges) => {
  const nodes = Array.isArray(workflowNodes) ? workflowNodes : [];
  const edges = Array.isArray(workflowEdges) ? workflowEdges : [];
  if (nodes.length === 0) return { nodes, repointed: [] };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentsOf = (nodeId) => edges
    .filter((e) => e && e.target === nodeId)
    .map((e) => byId.get(e.source))
    .filter(Boolean);

  // The parent(s) this node's logic was written against. Recorded the first
  // time the input diverges and kept verbatim after that — rewiring A→B→C
  // still reports A, because A is what the SQL names.
  //
  // Each entry also records WHAT that parent was producing — its dataset
  // (`identity`, plus `dataset` for display) and column names. A parent rebuilt
  // in place onto another connection or table is still the same node, and a
  // parent whose columns changed is still reading the same table, so node ids
  // alone cannot tell that a node's logic has been left behind. These can.
  const baselineOf = (config, recordedIds) => {
    if (Array.isArray(config.sourceBuiltAgainst) && config.sourceBuiltAgainst.length) {
      return config.sourceBuiltAgainst;
    }
    return recordedIds.map((id) => {
      // The LIVE node's display name first: what a node chat recorded as
      // `sourceNodeLabel` is its `data.label` — the generic "Data Source" /
      // "Transformer" type name — so preferring that would show the type
      // instead of the source. The recorded value only stands in when the
      // original node is gone from the canvas.
      const block = Array.isArray(config.sources)
        ? (config.sources.find((s) => s?.sourceNodeId === id) || {})
        : config;
      // The recorded block follows the parent — this pass refreshes it — so
      // deriving the baseline from it AFTER a move records where the source
      // went, not where the node's logic points. Pointing the source back at
      // the original then looked like a fresh move and the card asked again,
      // forever. `sourceMoved.from` is the one thing that still names the
      // original, so it wins wherever it exists.
      const origin = Array.isArray(config.sourcesConfig)
        ? config.sourcesConfig.find((s) => s?.sourceNodeId === id)?.sourceMoved?.from
        : config.sourceMoved?.from;
      return {
        nodeId: id,
        nodeLabel: labelOf(byId.get(id), null) || block.sourceNodeLabel || id,
        identity: origin
          ? { sourceConnectionId: origin.connectionId, sourceTableName: origin.tableName }
          : identityOf(block),
        dataset: origin ? [block.sourceConnectionName, origin.tableName].filter(Boolean).join(' · ') : datasetLabel(block),
        columns: columnNamesOf(block),
      };
    });
  };

  const repointed = [];
  const nextNodes = nodes.map((node) => {
    const config = node?.data?.config;
    if (!config) return node;
    const isJoin = node.type === 'join';
    if (!isJoin && !SINGLE_INPUT_TYPES.has(node.type)) return node;

    const parents = parentsOf(node.id);
    const parentIds = parents.map((p) => p.id);

    // What the config currently says it reads. Empty means the node has never
    // been configured — leave it to its own chat, which resolves the parent
    // from the edges when it opens.
    const recordedIds = isJoin
      ? (Array.isArray(config.sources) ? config.sources : []).map((s) => s?.sourceNodeId).filter(Boolean)
      : [config.sourceNodeId].filter(Boolean);
    if (recordedIds.length === 0) return node;

    // A disconnected node keeps what it had: the user may be mid-rewire, and
    // wiping the config would lose a configured destination for no gain.
    if (parents.length === 0) return node;

    // The block this node records for one parent — the join keeps one per
    // source, everything else describes its single input on the config itself.
    const recordedFor = (parentId) => (isJoin
      ? (Array.isArray(config.sources) ? config.sources : []).find((s) => s?.sourceNodeId === parentId)
      : config);

    const baseline = baselineOf(config, recordedIds);

    // ── What moved, measured against the BASELINE ────────────────────────────
    //
    // Always the baseline, never the recorded copy: the copy is refreshed below
    // and would then agree with the parent again, which would drop the flag one
    // tick after raising it — and relabel a rewire as a retarget on the way
    // past. The baseline is what the node's logic was written for, so it is the
    // only thing that can say whether the logic has been left behind.
    //
    //   rewired    — a different node feeds it now
    //   retargeted — the same node, rebuilt onto another connection or table
    //                (an assistant "modify" does exactly that, keeping the id)
    //   schema     — the same node and table, returning different columns
    const movedAgainstBaseline = (test) => parents.some((parent) => {
      const base = baseline.find((b) => b.nodeId === parent.id);
      if (!base) return false;
      return test(base, sourceFieldsFromUpstream(parent));
    });
    const rewired = !sameSet(parentIds, baseline.map((b) => b.nodeId));
    const retargeted = !rewired
      && movedAgainstBaseline((base, fresh) => inputIdentityDiffers(base.identity || {}, fresh));
    // COLUMN CHECK DISABLED — identity is the only test for now.
    //
    // Comparing column sets cannot work for a node that writes back into the
    // table it reads: an in-place transformer's whole job is to change that
    // column list, so from its first run onward the source will always differ
    // from what the node was built against. That is a false alarm by
    // construction, and it fired on every rebuild — the node re-read the table
    // live, its parent data source still held a snapshot taken before the node
    // ever ran, and the disagreement between the two was reported as "your
    // input moved".
    //
    // What actually decides whether a node's logic still applies is WHERE it
    // reads: connection, table, schema (collection / index / namespace / path
    // for the stores that use them). `inputIdentityDiffers` compares exactly
    // those, and for a transformer or join upstream `sourceFieldsFromUpstream`
    // already resolves the parent's TARGET first, so a chained parent is
    // matched on the table it writes.
    //
    // Restore by uncommenting and folding `schemaChanged` back into
    // `onBaseline` below.
    // const schemaChanged = !rewired && !retargeted
    //   && movedAgainstBaseline((base, fresh) => columnsDiffer(base.columns || [], columnNamesOf(fresh)));
    const schemaChanged = false;
    const onBaseline = !rewired && !retargeted && !schemaChanged;

    // "Keep as is" is the user answering the card's question for the input the
    // node has NOW. It used to answer by deleting the baseline, which made the
    // node look like it had never moved — and that is what lost the original,
    // so pointing the source back at it read as a fresh move and the card asked
    // again, with no way out. The answer is recorded instead, against the exact
    // input it was given for: still that input, still answered; anything else
    // and the question is a new one, worth asking.
    const acked = Array.isArray(config.sourceChangeAcked) ? config.sourceChangeAcked : null;
    const onAcked = !!acked
      && sameSet(parentIds, acked.map((a) => a.nodeId))
      && !parents.some((parent) => {
        const a = acked.find((x) => x.nodeId === parent.id);
        return !a || inputIdentityDiffers(a.identity || {}, sourceFieldsFromUpstream(parent))
          || columnsDiffer(a.columns || [], columnNamesOf(sourceFieldsFromUpstream(parent)));
      });

    // Whether the recorded copy needs refreshing is a SEPARATE question: it
    // names the node's live input, which must follow the wire and the parent
    // whatever the baseline says. A copy an earlier pass already refreshed
    // needs no second one, while the node stays flagged.
    const copyStale = !sameSet(parentIds, recordedIds) || parents.some((parent) => {
      const recorded = recordedFor(parent.id);
      if (!recorded) return false;
      const fresh = sourceFieldsFromUpstream(parent);
      return inputIdentityDiffers(recorded, fresh)
        || columnsDiffer(columnNamesOf(recorded), columnNamesOf(fresh));
    });

    const needsRepoint = copyStale;

    // A join's EXECUTING copy follows its parents on its own schedule — an
    // earlier pass refreshed `sources` without knowing `sourcesConfig` existed,
    // so the two can disagree with nothing above noticing. Asked as its own
    // question, which also heals every workflow already saved in that state.
    // Same reference back when nothing moved, so it doubles as the test.
    const nextSourcesConfig = repointSourcesConfig(config.sourcesConfig, parents, isJoin);

    // A single-source node whose one source now points elsewhere. Computed
    // here rather than in the write path, so the answer below is right on the
    // FIRST pass — the card has to go red as soon as the parent moves.
    const movedSource = isJoin ? null : flatSourceMoved(node.type, config, parents);

    // And whether the node can run at all, in one word for the card to read.
    const staleNow = sourceStaleReason(
      node.type, config, movedSource, nextSourcesConfig, parentIds,
    );
    const staleWas = config.sourceStale || '';
    const flagged = !!config.sourceChanged;
    // Desired state: flagged exactly while the node is off its baseline, and
    // only for the types whose own logic names the source. An output only
    // forwards what it reads, so its copy is refreshed silently.
    const wantFlag = LOGIC_OWNING_TYPES.has(node.type) && !onBaseline && !onAcked;
    const kind = rewired
      ? SOURCE_CHANGE_KINDS.REWIRED
      : (retargeted ? SOURCE_CHANGE_KINDS.RETARGETED : SOURCE_CHANGE_KINDS.SCHEMA);
    // Nothing to do only when all four questions already have the right answer.
    if (!needsRepoint && flagged === wantFlag
      && (!wantFlag || config.sourceChangeKind === kind)
      && nextSourcesConfig === config.sourcesConfig
      && staleNow === staleWas) return node;

    const nextConfig = { ...config };
    if (needsRepoint) {
      if (isJoin) {
        // Carry each surviving source's own entry across, so a join that keeps
        // one side does not lose that side's recorded read operation.
        const recorded = Array.isArray(config.sources) ? config.sources : [];
        nextConfig.sources = parents.map((parent) => ({
          ...(recorded.find((s) => s?.sourceNodeId === parent.id) || {}),
          ...sourceFieldsFromUpstream(parent),
          sourceNodeType: parent.type,
        }));
      } else {
        const fresh = sourceFieldsFromUpstream(parents[0]);
        if (identifiesASource(fresh)) {
          // A configured parent replaces the block wholesale, so no field from
          // the previous source can linger and be read at run time.
          for (const key of SOURCE_FIELD_KEYS) delete nextConfig[key];
          Object.assign(nextConfig, fresh);
        } else {
          // The new parent is not configured yet and has no table, file or
          // schema to offer. Overwriting with its emptiness would strip this
          // node of the identity its own name is derived from — it would go
          // back to reading "Transformer" on the canvas — so record only WHO
          // feeds it now and leave the rest until that parent is built.
          nextConfig.sourceNodeId = fresh.sourceNodeId;
          nextConfig.sourceNodeLabel = fresh.sourceNodeLabel;
        }
      }
    }

    if (nextSourcesConfig !== config.sourcesConfig) nextConfig.sourcesConfig = nextSourcesConfig;
    if (movedSource) nextConfig.sourceMoved = movedSource;
    else if (movedSource === null) delete nextConfig.sourceMoved;
    // One word the card reads to stay red. The executor decides for itself from
    // the live graph — this is the same answer, kept where the canvas can see
    // it. Unlike `sourceChanged` it is NOT cleared by "Keep as is": no answer
    // about the node's logic makes statements written for another source run
    // correctly.
    if (staleNow) nextConfig.sourceStale = staleNow;
    else delete nextConfig.sourceStale;

    if (wantFlag) {
      nextConfig.sourceChanged = true;
      nextConfig.sourceChangeKind = kind;
      nextConfig.sourceBuiltAgainst = baseline;
      // What the parent offers NOW, so the card can put the two side by side
      // without re-deriving anything at render time.
      nextConfig.sourceChangedTo = parents.map((parent) => {
        const fresh = sourceFieldsFromUpstream(parent);
        return {
          nodeId: parent.id,
          nodeLabel: labelOf(parent),
          // Carried so "Keep as is" can record WHAT was accepted — the card
          // itself only shows the dataset and columns.
          identity: identityOf(fresh),
          dataset: datasetLabel(fresh),
          columns: columnNamesOf(fresh),
        };
      });
    } else {
      // The question is not being asked: either nothing moved, or the user has
      // already answered it.
      delete nextConfig.sourceChanged;
      delete nextConfig.sourceChangeKind;
      delete nextConfig.sourceChangedTo;
      // Back where the node's logic was written for — by re-attaching the
      // original parent, or by pointing this one back at the original table.
      // Nothing to remember any more, so the node returns to its ordinary
      // state. While it is still AWAY and merely answered for, both the origin
      // and the answer have to survive: the first is how a later revert is
      // recognised, the second is what keeps the card quiet until then.
      if (onBaseline) {
        delete nextConfig.sourceBuiltAgainst;
        delete nextConfig.sourceChangeAcked;
      }
    }

    repointed.push({
      nodeId: node.id,
      nodeLabel: labelOf(node),
      nodeType: node.type,
      from: baseline.map((b) => b.nodeLabel),
      to: parents.map((p) => labelOf(p)),
      // A re-attach is worth reporting differently from a break.
      restored: flagged && !wantFlag,
      // What moved, for callers that word the three cases differently.
      kind: wantFlag ? kind : null,
    });
    return { ...node, data: { ...node.data, config: nextConfig } };
  });

  return repointed.length ? { nodes: nextNodes, repointed } : { nodes, repointed: [] };
};
