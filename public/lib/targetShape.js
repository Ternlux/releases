/**
 * The shape of a table a node writes into and KEEPS between runs — and whether
 * what the node is about to write still fits it.
 *
 * A node in replace mode drops and recreates its target, so the target always
 * has the shape the node last generated. A node that keeps its target (a join
 * in append / merge mode, an output node) writes into whatever is already
 * there, and nothing guarantees that still matches: the node may have been
 * rebuilt with another column, or switched from merge (whose table carries a
 * PRIMARY KEY on the merge key) to append (whose rows repeat that key, so every
 * re-append is rejected).
 *
 * Two questions, one place:
 *   probeTargetTable / probeLocalTable — what does the live table look like?
 *   compareTargetShape                 — does the node's output still fit it?
 *
 * Structured column lists only. Nothing here reads or parses SQL: the live
 * shape comes from the connector's catalog lookup (getColumns), the wanted
 * shape from the columns and key the generator declared.
 */
const crypto = require('crypto');
const { resolveTableRef } = require('./tableRef');

const lc = (s) => String(s ?? '').toLowerCase();

/** isPrimary as a boolean, or null when the engine does not say. */
function primaryFlag(col) {
  const v = col?.isPrimary;
  if (v === undefined || v === null) return null;
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/** A catalog column list → [{ name, type, isPrimary }] plus its primary key. */
function shapeFromColumns(columns) {
  const cols = (Array.isArray(columns) ? columns : [])
    .filter((c) => c && c.name != null)
    .map((c) => ({ name: String(c.name), type: c.type != null ? String(c.type) : null, isPrimary: primaryFlag(c) }));
  return {
    columns: cols,
    primaryKey: cols.filter((c) => c.isPrimary === true).map((c) => c.name),
  };
}

/**
 * Does a destination table exist, and with which columns?
 *
 * `resolved` (from lib/tableRef.resolveTableRef) may be passed in by a caller
 * that already resolved the name; otherwise it is resolved here with
 * `defaultSchema` as the connection's default.
 *
 * Three outcomes, because "I could not tell" is not the same as "no": a
 * connector without getColumns, or a lookup that errors, leaves the answer
 * UNKNOWN, and callers fall back to whatever they did before they could ask.
 *
 * @returns {Promise<{ state: 'exists'|'missing'|'unknown', resolved: object|null,
 *   columns: Array|null, primaryKey: string[] }>}
 */
async function probeTargetTable({
  plugin, config, connectionId, tableName, defaultSchema = null, resolved = null,
}) {
  const none = (state) => ({ state, resolved, columns: null, primaryKey: [] });
  if (!plugin || !tableName || typeof plugin.getColumns !== 'function') return none('unknown');

  if (!resolved) {
    try {
      resolved = await resolveTableRef(plugin, config, connectionId, tableName, defaultSchema);
    } catch (err) {
      console.log(`[targetShape] Could not resolve ${tableName}:`, err.message || err);
      resolved = null;
    }
  }
  const writeTableName = resolved?.table || tableName;
  // Pass NO schema when the name carries its own qualifier — see lib/tableRef.
  const lookupSchema = String(tableName).includes('.') ? null : (defaultSchema || null);

  const readColumns = async (schema) => {
    try {
      const res = await plugin.getColumns(config, connectionId, schema, writeTableName);
      if (res && res.success !== false && Array.isArray(res.columns)) return res.columns;
    } catch (err) {
      console.log(`[targetShape] Could not read columns of ${writeTableName}:`, err.message || err);
    }
    return null; // couldn't tell
  };
  const exists = (columns) => ({ state: 'exists', resolved, ...shapeFromColumns(columns) });

  // A resolver that already read the columns: ask again only for the key flag,
  // which some resolvers leave out.
  if (resolved?.found && Array.isArray(resolved.columns) && resolved.columns.length) {
    if (resolved.columns.some((c) => c && c.isPrimary !== undefined)) return exists(resolved.columns);
    const withKeys = await readColumns(resolved.schema ?? lookupSchema);
    return exists(withKeys && withKeys.length ? withKeys : resolved.columns);
  }

  const scoped = await readColumns(resolved?.found ? resolved.schema : lookupSchema);
  if (scoped && scoped.length > 0) return exists(scoped);

  // An empty result from a SCOPED lookup is not proof of absence — the schema
  // guessed may not be one the engine uses (on SQL Server the connection's
  // database name is never a schema; tables live in `dbo`). Ask unscoped and
  // let the connector apply its own default before believing it is not there.
  if (lookupSchema) {
    const bare = await readColumns(null);
    if (bare && bare.length > 0) return exists(bare);
    if (bare && scoped) return none('missing');
    return none('unknown');
  }
  // Every table has at least one column, so a lookup that succeeded and
  // returned none means there is no such table.
  return scoped ? none('missing') : none('unknown');
}

/** The same answer for a table in a workflow's own DuckDB database. */
async function probeLocalTable(workflowId, tableName) {
  try {
    const duck = require('../duckdb');
    const columns = await duck.describeTable(workflowId, tableName);
    if (!columns) return { state: 'missing', resolved: null, columns: null, primaryKey: [] };
    return { state: 'exists', resolved: null, ...shapeFromColumns(columns) };
  } catch (err) {
    console.log(`[targetShape] Could not describe local ${tableName}:`, err.message || err);
    return { state: 'unknown', resolved: null, columns: null, primaryKey: [] };
  }
}

/**
 * Does the output a node is about to write still fit the live table?
 *
 * `wanted` is { columns: [names], primaryKey: [names] } — what the node's
 * generator declared. Two differences break a write into a kept table, and
 * those are what this reports:
 *   - a column the output has and the table does not (the INSERT fails);
 *   - a primary key on the table that differs from the one the output wants
 *     (a re-append of the same keys is rejected; a key the output no longer
 *     names was usually left by an earlier merge).
 * Anything finer — a type the INSERT can still cast, an extra nullable column —
 * is left to the generator, which sees both shapes and says so itself.
 */
function compareTargetShape(live, wanted) {
  const result = { changed: false, missingColumns: [], keyChanged: false, liveKey: [], wantedKey: [] };
  if (!live || live.state !== 'exists' || !Array.isArray(live.columns)) return result;

  const have = new Set(live.columns.map((c) => lc(c.name)));
  const wantedCols = (wanted?.columns || []).map(String).filter(Boolean);
  result.missingColumns = wantedCols.filter((c) => !have.has(lc(c)));

  result.liveKey = live.primaryKey || [];
  result.wantedKey = (wanted?.primaryKey || []).map(String).filter(Boolean);
  // Only a key the table actually HAS can reject rows. A key the output wants
  // and the table lacks matters for a merge that needs one — the generator is
  // told the live key and says so through its own flag.
  if (result.liveKey.length) {
    const a = [...result.liveKey].map(lc).sort().join(',');
    const b = [...result.wantedKey].map(lc).sort().join(',');
    result.keyChanged = a !== b;
  }
  result.changed = result.missingColumns.length > 0 || result.keyChanged;
  return result;
}

/** One sentence for a comparison — the reason shown when the generator gave none. */
function describeDifference(cmp, tableName) {
  const parts = [];
  if (cmp.missingColumns.length) {
    parts.push(`${tableName} has no column${cmp.missingColumns.length === 1 ? '' : 's'} ${cmp.missingColumns.join(', ')}`);
  }
  if (cmp.keyChanged) {
    parts.push(`${tableName} has PRIMARY KEY (${cmp.liveKey.join(', ')})`
      + (cmp.wantedKey.length ? `, the new output's key is (${cmp.wantedKey.join(', ')})` : ', which the new output does not keep unique'));
  }
  return parts.join('; ');
}

/** The live shape as prompt text. */
function formatShapeForPrompt(live) {
  if (!live || live.state !== 'exists') return '';
  const cols = live.columns.map((c) => `${c.name}${c.type ? ` ${c.type}` : ''}${c.isPrimary ? ' (PRIMARY KEY)' : ''}`);
  return `columns: ${cols.join(', ')}\nprimary key: ${live.primaryKey.length ? live.primaryKey.join(', ') : 'none'}`;
}

/** A short fingerprint of a statement — what an approval is bound to. */
function statementFingerprint(text) {
  return crypto.createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 16);
}

module.exports = {
  probeTargetTable,
  probeLocalTable,
  compareTargetShape,
  describeDifference,
  formatShapeForPrompt,
  statementFingerprint,
  shapeFromColumns,
};
