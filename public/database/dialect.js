/**
 * Shared dialect defaults for the Data Explorer.
 *
 * Everything in here is generic — it applies to any connector that hasn't
 * said otherwise. Database-specific behaviour (keyword lists, validation,
 * query parsing, preview syntax) belongs in that connector's index.js under
 * an `explorer` block; `resolveDialect` merges the two.
 *
 * Connector `explorer` block (all fields optional):
 *   language        'sql' | 'json'         editor mode
 *   sqlDialect      string                 node-sql-parser grammar name
 *   formatter       string                 sql-formatter language name; a
 *                                          connector that omits it simply has
 *                                          no Format action
 *   container       'Schema' | 'Database'  what the tree's top level is called
 *   objectLabel     'Table' | 'Collection'
 *   keywords        string[]               extra statement keywords
 *   functions       string[]               extra function names
 *   quote           string                 identifier quote character
 *   fold            'lower' | 'upper'      how the engine case-folds unquoted
 *                                          identifiers; decides when completion
 *                                          inserts must be quoted
 *   validate(text)  -> { ok, issues }      engine-specific syntax check
 *   parseQuery(txt) -> object              text → whatever runQuery expects
 *   previewQuery(schema, table, limit) -> string
 */

// ANSI-ish baseline shared by every SQL engine we ship.
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
  'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'DISTINCT',
  'WITH', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'ALL', 'ANY',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BETWEEN', 'LIKE', 'EXISTS',
  'ASC', 'DESC', 'OVER', 'PARTITION BY', 'CAST',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX', 'ALTER TABLE', 'DROP TABLE',
  'TRUNCATE', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT',
];

const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'ABS', 'CEIL', 'FLOOR',
  'COALESCE', 'NULLIF', 'LENGTH', 'LOWER', 'UPPER', 'TRIM', 'SUBSTRING',
  'CONCAT', 'REPLACE', 'CURRENT_DATE', 'CURRENT_TIMESTAMP',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'NTILE',
];

const DEFAULTS = {
  language: 'sql',
  // node-sql-parser grammar. Connectors override with their own; anything
  // that doesn't name one is parsed against the most permissive grammar we
  // have rather than not being checked at all.
  sqlDialect: 'PostgreSQL',
  container: 'Schema',
  objectLabel: 'Table',
  keywords: SQL_KEYWORDS,
  functions: SQL_FUNCTIONS,
  quote: '"',
  fold: 'lower',
};

/**
 * Merge a connector's `explorer` block over the shared defaults.
 * Keyword/function lists are unioned rather than replaced, so a connector
 * only has to list what's special about it.
 *
 * @param {object|null} connector - plugin module, or null when unknown
 * @returns {object} plain, IPC-serialisable dialect descriptor
 */
function resolveDialect(connector) {
  const ext = (connector && connector.explorer) || {};
  const union = (base, extra) =>
    Array.from(new Set([...(base || []), ...(extra || [])])).sort();

  return {
    language: ext.language || DEFAULTS.language,
    sqlDialect: ext.sqlDialect || DEFAULTS.sqlDialect,
    // Declared by the connector or not at all — there is no sensible default,
    // and guessing one would format a statement in the wrong dialect.
    formatter: ext.formatter || null,
    container: ext.container || DEFAULTS.container,
    objectLabel: ext.objectLabel || DEFAULTS.objectLabel,
    quote: ext.quote || DEFAULTS.quote,
    fold: ext.fold || DEFAULTS.fold,
    // A doc store starts from an empty keyword baseline — SQL words would
    // only pollute its completions.
    keywords: ext.language === 'json'
      ? (ext.keywords || [])
      : union(DEFAULTS.keywords, ext.keywords),
    functions: ext.language === 'json'
      ? (ext.functions || [])
      : union(DEFAULTS.functions, ext.functions),
  };
}

/**
 * Quote an identifier for a connector, falling back to the dialect's quote
 * character when the connector has no `quoteIdentifier`.
 */
function quoteIdentifier(connector, identifier, schema = null, config = null) {
  if (!identifier) return identifier;

  if (connector && typeof connector.quoteIdentifier === 'function') {
    try {
      return connector.quoteIdentifier(identifier, schema, config);
    } catch (_) {
      /* fall through to the generic form */
    }
  }

  const q = resolveDialect(connector).quote;
  const wrap = (s) => `${q}${s}${q}`;
  return schema ? `${wrap(schema)}.${wrap(identifier)}` : wrap(identifier);
}

module.exports = { resolveDialect, quoteIdentifier, SQL_KEYWORDS, SQL_FUNCTIONS };
