/**
 * Column types for an Output's CREATE TABLE, taken from the SOURCE's schema.
 *
 * The Output used to guess every column from the values on the first page.
 * A guess cannot tell a ZIP code from a number: `zip` was VARCHAR in the source
 * ("02947"), was guessed INTEGER, and was stored as 2947 with the run reported
 * as a success. The same guess made a 64-bit id a 32-bit INTEGER (out of range
 * on row 1), a column whose long values start on row 130 a VARCHAR(255), and a
 * text column of "true"/"false"/"yes" a BOOLEAN that turned "yes" into TRUE.
 * The source already KNOWS every one of these types, so they are read from it.
 *
 * Three steps, each owned by the side that knows it:
 *
 *   source native type ──► canonical type ──► destination type name
 *     (the source's         (this file)        (the destination
 *      connector:                               connector's `types`)
 *      toCanonicalType;
 *      DuckDB for local)
 *
 * A canonical type is `{ kind, length, precision, scale }`. The kinds are the
 * keys of a connector's `types` block — the original eight the value guesser
 * uses, plus the ones only a schema can tell apart:
 *
 *   BIGINT       64-bit integer           falls back to INTEGER
 *   DOUBLE       8-byte float             falls back to FLOAT
 *   DECIMAL      exact, with (p, s)       falls back to DOUBLE when the
 *                                         destination has no exact type that
 *                                         holds it, or the precision is unknown
 *   TIMESTAMPTZ  an instant               falls back to TIMESTAMP, values
 *                                         converted to UTC first
 *   TIME         time of day              falls back to STRING
 *
 * The fallbacks are how "a double is a FLOAT over there" works: a destination
 * names only what differs, and DOUBLE resolves to its FLOAT entry when it has
 * no DOUBLE of its own (every SQL connector here maps FLOAT to an 8-byte type).
 *
 * A column whose source type is unknown — a schemaless source, a connector
 * without toCanonicalType — is still guessed from its values, as before.
 */

const FALLBACK = {
  BIGINT: 'INTEGER',
  DOUBLE: 'FLOAT',
  DECIMAL: 'DOUBLE',
  TIMESTAMPTZ: 'TIMESTAMP',
  TIME: 'STRING',
};

/**
 * DuckDB's type for a column → canonical. Used for every LOCAL source (files,
 * .duckdb, .sqlite through the sqlite extension), all of which DuckDB reads.
 *
 * Matches the type name DuckDB reports (`String(columnType)`), which is a fixed
 * vocabulary — `DECIMAL(10,2)`, `TIMESTAMP WITH TIME ZONE`, `INTEGER[]`.
 */
function canonicalFromDuckType(typeName) {
  const t = String(typeName || '').toUpperCase().trim();
  if (!t) return null;
  // Nested values first: `INTEGER[]` must not read as INTEGER.
  if (t.endsWith(']') || /^(STRUCT|MAP|UNION|JSON)\b/.test(t)) return { kind: 'OBJECT' };
  if (t === 'BOOLEAN') return { kind: 'BOOLEAN' };
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT)$/.test(t)) return { kind: 'INTEGER' };
  if (/^(BIGINT|UINTEGER)$/.test(t)) return { kind: 'BIGINT' };
  // Wider than 64 bits: exact, as a DECIMAL with no fraction.
  if (/^(HUGEINT|UBIGINT|UHUGEINT)$/.test(t)) return { kind: 'DECIMAL', precision: 38, scale: 0 };
  if (t === 'FLOAT' || t === 'DOUBLE') return { kind: 'DOUBLE' };
  const dec = t.match(/^DECIMAL\((\d+),\s*(\d+)\)$/);
  if (dec) return { kind: 'DECIMAL', precision: Number(dec[1]), scale: Number(dec[2]) };
  if (t === 'DATE') return { kind: 'DATE_ONLY' };
  if (t === 'TIMESTAMP WITH TIME ZONE') return { kind: 'TIMESTAMPTZ' };
  if (/^TIMESTAMP/.test(t)) return { kind: 'TIMESTAMP' };
  if (/^TIME/.test(t)) return { kind: 'TIME' };
  if (t === '"NULL"' || t === 'NULL') return { kind: 'NULL' };
  // VARCHAR, UUID, ENUM, BLOB, INTERVAL, BIT…: text, with no declared length.
  return { kind: 'STRING', length: null };
}

/** The destination's entry for one kind, or undefined when it has none. */
function entryFor(dialect, kind) {
  return dialect && Object.prototype.hasOwnProperty.call(dialect, kind) ? dialect[kind] : undefined;
}

/**
 * The destination type name for a canonical type.
 *
 * @param {object} dialect - The destination connector's `types` block.
 * @param {{kind, length?, precision?, scale?}} canonical
 * @param {number} sampleMaxLen - Longest value seen, for a STRING whose source
 *   declared no length. Ignored when the source did declare one.
 * @returns {string|null} null when not even the fallbacks name it.
 */
function destinationType(dialect, canonical, sampleMaxLen = 0) {
  let kind = canonical.kind;
  for (let hops = 0; kind && hops < 5; hops += 1) {
    const entry = entryFor(dialect, kind);
    if (entry != null) {
      if (typeof entry !== 'function') return entry;
      let name;
      if (kind === 'DECIMAL') {
        name = entry(canonical.precision ?? null, canonical.scale ?? null);
      } else if (kind === 'STRING') {
        // A length the source declared is the contract; with none, the
        // column is unbounded at the source and must be here too — sizing it
        // from the first page is what failed on row 130's 400-char value.
        const declared = Number(canonical.length);
        const len = canonical.fromSchema
          ? (Number.isFinite(declared) && declared > 0 ? declared : Infinity)
          : sampleMaxLen;
        name = entry(len);
      } else {
        name = entry(sampleMaxLen);
      }
      // A connector answers null for a value it cannot hold exactly (a DECIMAL
      // past its precision): use the fallback instead.
      if (name) return name;
    }
    kind = FALLBACK[kind];
  }
  return null;
}

/**
 * The source's columns as canonical types, or null when the source cannot say.
 *
 * @param {{name, type}[]} columns - From the source's getColumns / describe.
 * @param {(col) => object|null} toCanonical - Native → canonical for this source.
 * @returns {Record<string, object>|null}
 */
function canonicalSchema(columns, toCanonical) {
  if (!Array.isArray(columns) || columns.length === 0 || typeof toCanonical !== 'function') return null;
  const out = {};
  for (const col of columns) {
    if (!col || !col.name) continue;
    let canonical = null;
    try { canonical = toCanonical(col); } catch (_) { canonical = null; }
    if (canonical && canonical.kind) out[col.name] = { ...canonical, fromSchema: true };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── values ──────────────────────────────────────────────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * An instant as UTC, in the `YYYY-MM-DD HH:MM:SS[.ffffff]` form every SQL
 * engine here parses. Fractional digits are carried as text so microseconds
 * survive (a JS Date holds milliseconds only).
 *
 * Accepts a Date, or a string with an offset: DuckDB writes a TIMESTAMPTZ as
 * `2024-06-01 18:15:00-07`, a CSV may hold `2024-06-02T01:15:00Z`. Returns null
 * for anything it cannot read, so the caller keeps the original value.
 */
function toUtcParts(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();               // 2024-06-02T01:15:00.000Z
    return { base: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`, frac: iso.slice(19, 23) };
  }
  const m = String(value).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', frac = '', zone] = m;
  let offsetMin = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMin * 60000;
  const t = new Date(ms);
  return {
    base: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} `
      + `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`,
    frac,
  };
}

/**
 * Per-column value converters the load needs for the types chosen, or null
 * when no column needs one.
 *
 * Only an instant needs converting. Sent as DuckDB writes it ("…-07"), MySQL
 * refused the value outright and Postgres, into a TIMESTAMP column, kept the
 * wall time and dropped the offset — a different instant. It is sent as UTC:
 * with the offset spelled `+00:00` when the destination column keeps one, and
 * bare when it fell back to a plain TIMESTAMP (whose value is then UTC).
 */
function valueConverters(schema, dialect) {
  if (!schema) return null;
  const converters = {};
  const keepsZone = entryFor(dialect, 'TIMESTAMPTZ') != null;
  for (const [name, canonical] of Object.entries(schema)) {
    if (canonical.kind !== 'TIMESTAMPTZ') continue;
    converters[name] = (v) => {
      if (v === null || v === undefined || v === '') return v;
      const parts = toUtcParts(v);
      if (!parts) return v;
      return `${parts.base}${parts.frac}${keepsZone ? '+00:00' : ''}`;
    };
  }
  return Object.keys(converters).length > 0 ? converters : null;
}

/** Apply converters to one row (a new object; the source row is left alone). */
function convertRow(row, converters) {
  if (!converters) return row;
  const out = { ...row };
  for (const [name, fn] of Object.entries(converters)) {
    if (name in out) out[name] = fn(out[name]);
  }
  return out;
}

/**
 * Columns, among `columns`, whose every non-null value is an INSTANT — a Date,
 * or a timestamp string carrying a zone ("…Z", "…-07", "…+05:30") — as
 * canonical TIMESTAMPTZ entries. For sources with no schema (a document
 * store), where the value is the only evidence: typed a plain TIMESTAMP, an
 * offset string was stored as its wall time, a different instant.
 */
function zonedInstantColumns(rows, columns) {
  const out = {};
  const zoned = /(Z|[+-]\d{2}(:?\d{2})?)$/i;
  for (const col of columns) {
    let seen = 0;
    let ok = true;
    for (const row of rows) {
      const v = row ? row[col] : null;
      if (v === null || v === undefined || v === '') continue;
      seen += 1;
      const isInstant = v instanceof Date
        || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)
          && zoned.test(v.trim()) && toUtcParts(v) !== null);
      if (!isInstant) { ok = false; break; }
    }
    if (ok && seen > 0) out[col] = { kind: 'TIMESTAMPTZ' };
  }
  return out;
}

module.exports = {
  canonicalFromDuckType,
  zonedInstantColumns,
  canonicalSchema,
  destinationType,
  valueConverters,
  convertRow,
  toUtcParts,
};
