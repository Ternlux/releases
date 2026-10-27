/**
 * Give an imported workflow node ids of its own.
 *
 * An export carries its node ids, and importing it — twice, or into the profile
 * it came from — produced workflows whose nodes shared ids with another
 * workflow. Ids are not just keys on the canvas: a join stages each source into
 * `temp_<node id>` on its destination, and that name is written into the saved
 * DDL and join SQL at build time. Two copies run together therefore staged into
 * the SAME table on the same connection; one dropped the other's staging table
 * mid-run, and the destination was left with rows from both (R9 in the QA plan).
 * A per-workflow run lock cannot catch it — they are different workflows.
 *
 * Every node except the fixed `start-node` gets a fresh id, and the old id is
 * replaced everywhere the workflow mentions it: edges, execution steps, node
 * configs, and the SQL that embeds it. That last part covers the two derived
 * spellings the builder and executor use — non-alphanumerics as underscores
 * (`transformer_<id>`) and that, lowercased (`temp_<id>`) — because those are
 * the staging names that must not be shared. It is an id rename across the
 * document, not a reading of the SQL: nothing decides anything from the text.
 *
 * Table names a node WRITES that happen to end in digits from its id
 * (`phoenix_stores_974333`) are deliberately left alone, so a copy still writes
 * where the original did — only the per-node scratch names move.
 */

/** The two spellings of an id that end up inside generated identifiers. */
function derivedForms(id) {
  const underscored = String(id).replace(/[^A-Za-z0-9_]/g, '_');
  return [underscored, underscored.toLowerCase()];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{nodes: object[], edges: object[], executionSteps?: object[]}} workflow
 * @returns {{nodes, edges, executionSteps, idMap: Record<string,string>}}
 */
export function reassignImportedNodeIds(workflow) {
  const base = Date.now();
  const idMap = {};
  (workflow.nodes || []).forEach((node, i) => {
    const id = node && node.id;
    if (!id || id === 'start-node') return;
    const prefix = String(id).split('-')[0] || 'node';
    idMap[id] = `${prefix}-${base + i}`;
  });

  // Longest first, so an id that is a prefix of another ("x-1" vs "x-12") is
  // never replaced inside the longer one.
  const replacements = [];
  Object.entries(idMap)
    .sort(([a], [b]) => b.length - a.length)
    .forEach(([oldId, newId]) => {
      replacements.push([oldId, newId]);
      const [oldU, oldL] = derivedForms(oldId);
      const [newU, newL] = derivedForms(newId);
      if (oldU !== oldId) replacements.push([oldU, newU]);
      if (oldL !== oldU) replacements.push([oldL, newL]);
    });

  if (replacements.length === 0) {
    return { nodes: workflow.nodes, edges: workflow.edges, executionSteps: workflow.executionSteps || [], idMap };
  }

  // Only a DIGIT right after the old id makes it a different, longer id
  // ("x-1" inside "x-12"). A letter may follow: React Flow edge ids glue the
  // node id straight onto the handle name ("join-17…input1").
  const pattern = new RegExp(
    replacements.map(([from]) => `${escapeRegExp(from)}(?![0-9])`).join('|'),
    'g',
  );
  const lookup = new Map(replacements);
  const rename = (text) => text.replace(pattern, (m) => lookup.get(m) ?? m);

  const walk = (value) => {
    if (typeof value === 'string') return rename(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[rename(k)] = walk(v);
      return out;
    }
    return value;
  };

  return {
    nodes: walk(workflow.nodes || []),
    edges: walk(workflow.edges || []),
    executionSteps: walk(workflow.executionSteps || []),
    idMap,
  };
}
