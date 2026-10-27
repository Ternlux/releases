/**
 * Connection names have to be unique, compared without regard to case or
 * surrounding whitespace — "Sales Data", "sales data" and " Sales Data " are
 * the same name as far as the user is concerned, and downstream code looks
 * connections up by name.
 */

/** The value two names are compared on. */
export const nameKey = (name) => String(name ?? '').trim().toLowerCase();

const idOf = (connection) => connection?.id || connection?._id;

/**
 * True when `name` is already taken by a connection other than the one being
 * edited. Renaming a connection to its own current name stays valid.
 */
export function isDuplicateConnectionName(name, connections = [], editingConnection = null) {
  const key = nameKey(name);
  if (!key) return false;

  const editingId = idOf(editingConnection);
  return connections.some(c => {
    if (editingId && idOf(c) === editingId) return false;
    return nameKey(c?.name) === key;
  });
}

/**
 * antd Form.Item rule rejecting a name another connection already uses.
 * Rebuild it on render so the validator sees the current connection list.
 */
export function uniqueNameRule(connections = [], editingConnection = null) {
  return {
    validator: (_, value) => (
      isDuplicateConnectionName(value, connections, editingConnection)
        ? Promise.reject(new Error('A connection with this name already exists'))
        : Promise.resolve()
    ),
  };
}
