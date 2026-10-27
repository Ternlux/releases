/**
 * The saved connections a workflow's nodes name, and re-linking them to a
 * connection that was deleted and added back.
 *
 * A re-added connection is a NEW record with a new id, so every node that
 * named the old one stayed red ("CONNECTION DELETED") and the run refused it,
 * even though the user had put the same connection back. The user had to open
 * each node and pick the connection again.
 *
 * Re-linking happens only when exactly ONE saved connection is plainly the
 * same one: same type (where the node records it) and the same name, or, for
 * a file, the same file path. Two candidates, or none, leave the node red for
 * the user to choose.
 *
 * The field list mirrors connectionRefsOf in
 * public/NodeExecution/workflowExecutionHelpers.js (the run-time check) —
 * keep the two in step.
 */

const isPlaceholder = (id) => typeof id !== 'string' || !id || id.startsWith('local-');

/** Every saved-connection reference a node holds, with what identifies it. */
export function connectionRefsOf(node) {
  const c = node?.data?.config || {};
  const refs = [];
  const add = (id, name, dbType, path = null) => {
    if (isPlaceholder(id)) return;
    refs.push({ id, name: name || null, dbType: dbType || null, path: path || null });
  };
  const sourcePath = c.sourceFilePath || c.sourceLocalPath || null;
  switch (node?.type) {
    case 'dataSource':
      add(c.sourceConnectionId, c.sourceConnectionName, c.sourceDbType, sourcePath);
      add(c.sourceApiConnectionId, c.sourceApiConnectionName, null);
      break;
    case 'transformer':
      add(c.sourceConnectionId, c.sourceConnectionName, c.sourceDbType, sourcePath);
      add(c.targetConnectionId, c.targetConnectionName, c.targetDbType);
      break;
    case 'join':
      (Array.isArray(c.sources) ? c.sources : []).forEach((s) => add(
        s?.sourceConnectionId, s?.sourceConnectionName, s?.sourceDbType, s?.sourceFilePath || s?.sourceLocalPath,
      ));
      add(c.targetConnectionId, c.targetConnectionName, c.targetDbType);
      break;
    case 'output':
      add(c.sourceConnectionId, c.sourceConnectionName, c.sourceDbType, sourcePath);
      if (c.outputSettings?.outputType === 'connection') add(c.outputSettings.connectionId, null, null);
      break;
    default:
      break;
  }
  return refs;
}

const filePathsOf = (conn) => [conn?.fileInfo?.sourceFilePath, conn?.fileInfo?.filePath].filter(Boolean);

/** The one saved connection that is plainly `ref` added back, or null. */
function matchFor(ref, saved) {
  const name = ref.name ? String(ref.name).trim().toLowerCase() : null;
  const candidates = saved.filter((conn) => {
    if (ref.dbType && conn.dbType && ref.dbType !== conn.dbType) return false;
    const sameName = !!name && String(conn.name || '').trim().toLowerCase() === name;
    const samePath = !!ref.path && filePathsOf(conn).includes(ref.path);
    return sameName || samePath;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/** Replace every string equal to `from` with `to`, at any depth. */
function replaceExact(value, from, to) {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => replaceExact(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceExact(v, from, to);
    return out;
  }
  return value;
}

/**
 * Point nodes whose connection was deleted at the same connection added back.
 *
 * @param {object[]} nodes
 * @param {object[]} savedConnections - every saved connection record
 * @returns {{ nodes: object[], relinked: Array<{from, to, name}> }} the same
 *   `nodes` array when nothing changed.
 */
export function relinkReaddedConnections(nodes, savedConnections) {
  const saved = Array.isArray(savedConnections) ? savedConnections : [];
  const savedIds = new Set(saved.map((c) => c.id).filter(Boolean));
  const remap = new Map();
  for (const node of nodes || []) {
    for (const ref of connectionRefsOf(node)) {
      if (savedIds.has(ref.id) || remap.has(ref.id)) continue;
      const match = matchFor(ref, saved);
      if (match) remap.set(ref.id, match);
    }
  }
  if (remap.size === 0) return { nodes, relinked: [] };

  const next = nodes.map((node) => {
    const config = node?.data?.config;
    if (!config) return node;
    const text = JSON.stringify(config);
    const hits = [...remap.keys()].filter((from) => text.includes(JSON.stringify(from)));
    if (hits.length === 0) return node;
    let updated = config;
    for (const from of hits) updated = replaceExact(updated, from, remap.get(from).id);
    return { ...node, data: { ...node.data, config: updated } };
  });
  return {
    nodes: next,
    relinked: [...remap.entries()].map(([from, conn]) => ({ from, to: conn.id, name: conn.name })),
  };
}
