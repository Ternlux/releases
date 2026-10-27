// ─────────────────────────────────────────────────────────────────────────────
// Naming for artifacts a workflow writes into shared local storage.
//
// Local SQLite output all lands in ONE file (userData/app-data.db) — the
// sqlite pool is a singleton and local joins copy their sources into temp
// tables there, so a table cannot simply be moved to a per-workflow file.
// That makes the table NAME the only isolation available: two workflows whose
// transformer both targets "orders_enriched" would otherwise drop and recreate
// each other's table.
//
// Node-id defaults are already unique, so this only matters for names a user or
// the AI chose. Applied where the base name is decided, BEFORE it reaches the
// AI that writes the DDL — the executor runs that DDL verbatim, so renaming
// later would leave the DDL and the config disagreeing.
// ─────────────────────────────────────────────────────────────────────────────

/** Short, stable, filesystem/SQL-safe token for a workflow id. */
export const workflowToken = (workflowId) => {
  const cleaned = String(workflowId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-12);
  return cleaned || null;
};

/**
 * Prefix a table name with the workflow it belongs to, but only when the target
 * really is the shared local store. Remote databases are the user's own
 * namespace — never rewrite a name there.
 *
 * Idempotent: re-saving a node must not stack prefixes.
 */
export const qualifyLocalTableName = (name, { workflowId, isLocal } = {}) => {
  if (!name || !isLocal) return name;
  const token = workflowToken(workflowId);
  if (!token) return name;
  const prefix = `w${token}_`;
  return String(name).startsWith(prefix) ? String(name) : `${prefix}${name}`;
};
