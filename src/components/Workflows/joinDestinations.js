// Where a join can write its result — the destination list behind the
// ChatAssistant's focused-join picker.
//
// The rules (categorize every saved connection, plus one local Parquet option)
// follow the legacy JoinNodeChat picker, which is where a join used to be
// configured. Plain data only; the caller renders it.
import { connectionsDb } from '../../utils/localDb';

export const DESTINATION_GROUP_COLOR = {
  'Cloud Storage': '#0891b2',
  APIs: '#2563eb',
  Vector: '#16a34a',
  Databases: '#7c3aed',
  'Local Files': '#d97706',
  Other: '#5a6678',
};

export const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

export const categorizeConnection = (conn) => {
  if (!conn) return 'Other';
  if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
  if (conn.dbCategory === 'API' || conn.dbType === 'rest-api') return 'APIs';
  if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return 'Vector';
  if (conn.connectionType === 'database') return 'Databases';
  if (conn.connectionType === 'file') return 'Local Files';
  return 'Other';
};

/**
 * Can a join write its result to this saved connection? Mirrors
 * isJoinDestinationConnection in public/chat/workflowBuilder.js — the builder
 * refuses anything this lets through, so the two must agree.
 *
 * A database (SQL or Mongo) or a vector store. Cloud storage and API
 * connections have no table to create, and a local FILE connection is not
 * written to (a DuckDB-type file routes to the workflow's own database, which
 * is what the "Local file" option already means). Local LanceDB is a vector
 * store, so it stays.
 */
export const isJoinDestination = (conn) => {
  if (!conn) return false;
  if (conn.dbCategory === 'CloudStorage' || conn.dbCategory === 'API' || conn.dbType === 'rest-api') return false;
  if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return true;
  return conn.connectionType === 'database';
};

// The one local option in the picker: the join result becomes a table in the
// workflow's own DuckDB database. Tabular and document data alike.
export const LOCAL_FILE_DESTINATION = {
  id: 'local-duckdb',
  label: 'Local file',
  value: 'local-duckdb',
  description: 'Store the result as a table in this workflow\'s DuckDB database',
  connection: { dbType: 'duckdb', connectionType: 'file' },
  group: 'Local Files',
  groupColor: DESTINATION_GROUP_COLOR['Local Files'],
};

/**
 * Every saved connection a join can write to (deduplicated, categorized) plus
 * the local option. Returns plain data; attach icons in the caller.
 */
export const loadJoinDestinations = async () => {
  let allConnections = [];
  try {
    allConnections = (await connectionsDb.getAll()) || [];
  } catch (err) {
    console.warn('[joinDestinations] could not load connections:', err.message);
  }

  const destinations = [];
  const seen = new Set();
  allConnections.forEach((conn) => {
    if (!conn || seen.has(conn.id)) return;
    seen.add(conn.id);
    if (!isJoinDestination(conn)) return;
    const group = categorizeConnection(conn);
    destinations.push({
      id: conn.id,
      label: conn.name,
      value: conn.id,
      description: `Store in ${conn.name} (${conn.dbType})`,
      connection: conn,
      group,
      groupColor: DESTINATION_GROUP_COLOR[group] || DESTINATION_GROUP_COLOR.Other,
    });
  });

  destinations.push({ ...LOCAL_FILE_DESTINATION });
  return destinations;
};

/**
 * Has this join node been told where to write? Mirrors what the join builder
 * treats as "destination already settled" — an explicit selection token, or a
 * resolved target connection on the config.
 */
export const hasJoinDestination = (config) => {
  if (!config) return false;
  return !!(config.joinSettings?.destinationSelection
    || config.targetConnectionId
    || config.targetDbType);
};
