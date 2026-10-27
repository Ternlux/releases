/**
 * Addressing a table that may already carry its own qualifier.
 *
 * A table name recorded on a node is routinely schema-qualified — "PUBLIC.orders",
 * a BigQuery "dataset.table", "dbo.orders" — because that is what an upstream
 * node was told to write. Every connector's `quoteIdentifier` accepts BOTH that
 * form and a bare name with the schema passed separately, and lets an explicit
 * schema WIN: given ("PUBLIC.orders", "PUBLIC") it quotes the name whole and
 * asks for `"PUBLIC"."PUBLIC.orders"`, one object whose name contains a dot.
 * That is how reading a join's staging table failed with
 * `Object 'TERNLUX.PUBLIC."PUBLIC.unique_transactions_incremental"' does not exist`.
 *
 * So: hand a connector ONE qualifier, never two. Splitting the name here instead
 * would be a guess — a table really can be called "public.orders", and only the
 * connector's own last-resort rule knows how its dialect resolves that
 * ambiguity (see the note in plugins/connectors/snowflake/index.js:370).
 */

/**
 * The schema to pass ALONGSIDE `tableName`, or null when the name already
 * qualifies itself and the connector should resolve it on its own.
 *
 * @param {string} tableName - Table name, possibly already qualified.
 * @param {string|null} schema - The connection's default schema, if any.
 * @returns {string|null}
 */
function qualifierFor(tableName, schema) {
  return String(tableName || '').includes('.') ? null : (schema || null);
}

/**
 * Resolve a table NAME the app is holding to the object the engine really has.
 *
 * Quoting and resolving are different problems, and only the first was solved.
 * `quoteIdentifier` faithfully quotes whatever it is handed — which is correct,
 * and useless when the name itself is in the wrong case. The app carries names
 * from three places that fold differently: a catalog read (already the stored
 * form), an AI-generated config, and a user's prose. On Snowflake a name from
 * the last of those asked for `"pg_txn_customers"` while PG_TXN_CUSTOMERS sat
 * next to it, so the probe reported the destination missing, a SECOND table was
 * created, and the load went into it — no error, wrong table.
 *
 * Only the connector knows its own folding rule (Snowflake folds an unquoted
 * name UP, PostgreSQL and MySQL fold DOWN), so the resolution belongs there.
 * This is the entry point callers use, so none of them has to branch on whether
 * a given connector has one yet.
 *
 * The returned `quotedRef` is how to WRITE the resolved object, and `table` is
 * its bare stored name — which is what `batchInsert` takes, since it quotes
 * internally. Use both from here rather than re-deriving either from the name
 * that was passed in: that is exactly how the probe and the load came to
 * disagree about which table they meant.
 *
 * @param {Object} plugin - The connector.
 * @param {Object} config - Full connection config (with credentials).
 * @param {string} connectionId
 * @param {string} name - The table name as the app holds it.
 * @param {string|null} schema - The connection's default schema, if any.
 * @returns {Promise<{found: boolean, schema: string|null, table: string|null,
 *   quotedRef: string|null, columns: Array|null, ambiguous: string[]}>}
 */
async function resolveTableRef(plugin, config, connectionId, name, schema = null) {
  // ONE qualifier, never two — applied HERE so every caller obeys it rather
  // than each remembering to. A caller that passed its connection's default
  // schema alongside an already-qualified "PUBLIC.orders" made the resolver
  // search PUBLIC for a table whose NAME contains a dot; it found nothing, and
  // the same-connection copy silently fell back to streaming every row through
  // this process while the streaming path — which happened to compute the rule
  // itself — resolved the very same name correctly.
  const qualifier = qualifierFor(name, schema);

  if (typeof plugin?.resolveTableRef === 'function') {
    const resolved = await plugin.resolveTableRef(config, connectionId, name, qualifier);
    // A connector's resolver need not report columns; normalise the shape so
    // callers can read `.columns` without checking which kind of resolver ran.
    return { columns: null, ambiguous: [], ...resolved };
  }

  // No resolver on this connector: today's behaviour, expressed in the new
  // shape. An exact-name lookup is what every caller did before this existed,
  // so a connector that has not been taught its own folding rule keeps working
  // exactly as it does now rather than getting one guessed on its behalf.
  let columns = null;
  if (typeof plugin?.getColumns === 'function') {
    try {
      const res = await plugin.getColumns(config, connectionId, qualifier, name);
      if (res && res.success !== false && Array.isArray(res.columns) && res.columns.length) {
        columns = res.columns;
      }
    } catch (err) {
      console.log(`[tableRef] Could not resolve ${name}:`, err.message || err);
    }
  }

  const quotedRef = (columns && typeof plugin.quoteIdentifier === 'function')
    ? plugin.quoteIdentifier(name, qualifier, config)
    : null;

  return {
    found: !!columns,
    schema: qualifier,
    table: columns ? name : null,
    quotedRef,
    columns,
    ambiguous: [],
  };
}

module.exports = { qualifierFor, resolveTableRef };
