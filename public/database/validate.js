/**
 * Syntax checking for the Data Explorer.
 *
 * SQL goes through node-sql-parser against the connector's own grammar, so a
 * PostgreSQL sheet is checked as PostgreSQL and a T-SQL sheet as T-SQL.
 * Document stores go through mongodb-query-parser, which understands the shell
 * syntax users actually type (ObjectId(...), ISODate(...), unquoted keys) —
 * JSON.parse would reject all of it.
 *
 * IMPORTANT: findings are advisory. Neither parser models 100% of any vendor's
 * grammar, so valid-but-exotic statements can be flagged. The UI shows a
 * warning and always lets the user run anyway. `severity` says which is which:
 *
 *   'error'   — the parser is confident this is malformed
 *   'warning' — we could not parse it, but it may just be unmodelled syntax
 *
 * Every issue is { line, column, message, severity }, 1-based, relative to the
 * statement text handed in.
 */

const { Parser } = require('node-sql-parser');
const { resolveDialect } = require('./dialect');

const sqlParser = new Parser();

// Grammar names node-sql-parser accepts, so a connector typo degrades to a
// warning instead of throwing "X is not supported currently" at the user.
const SUPPORTED_SQL_DIALECTS = new Set([
  'Athena', 'BigQuery', 'DB2', 'FlinkSQL', 'Hive', 'MariaDB', 'MySQL', 'Noql',
  'PostgreSQL', 'Redshift', 'Snowflake', 'SQLite', 'TransactSQL', 'Trino',
]);

/** Convert a character offset into { line, column }, both 1-based. */
function positionOf(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Both parsers report a position past the end of the text when they hit EOF
 * mid-statement. Pull it back onto a real line so the marker is visible.
 */
function clampToText(text, line, column) {
  const lines = text.split('\n');
  const l = Math.min(Math.max(1, line), lines.length);
  const maxCol = (lines[l - 1] || '').length + 1;
  return { line: l, column: Math.min(Math.max(1, column), maxCol) };
}

/**
 * Parser messages are written for parser authors: a full list of expected
 * tokens, character classes and all. Reduce to the part a user can act on.
 */
function tidyParserMessage(raw) {
  const first = String(raw || '').split('\n')[0].trim();
  // PEG: 'Expected "(", "--", ... but "W" found.' → the found token is the point.
  const found = /but\s+(".*?"|end of input)\s+found/i.exec(first);
  if (found) {
    return found[1] === 'end of input'
      ? 'Statement ends unexpectedly'
      : `Unexpected ${found[1]}`;
  }
  // mongodb-query-parser writes "Unexpected token (3:0) in (" and then echoes
  // the source. Drop the echo and the position — both are reported separately,
  // and its position disagrees with the corrected one we show.
  return first
    .replace(/\s*in\s*\($/, '')
    .replace(/\s*\(\d+:\d+\)/, '')
    .trim() || 'Could not parse statement';
}

/**
 * Structural sanity check — unbalanced quotes and brackets.
 *
 * Runs only when the grammar parse fails, to tell "you forgot a quote" (a real
 * error, worth reporting confidently) apart from "the parser doesn't know this
 * vendor extension" (only a warning).
 */
function structuralIssues(text) {
  const issues = [];
  const stack = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        issues.push({ ...positionOf(text, i), message: 'Unterminated block comment', severity: 'error' });
        break;
      }
      i = end + 2;
      continue;
    }

    // String literal or quoted identifier. A doubled quote escapes itself.
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\' && ch === "'") { i += 2; continue; }
        if (text[i] === ch) {
          if (text[i + 1] === ch) { i += 2; continue; }
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) {
        issues.push({
          ...positionOf(text, start),
          message: ch === "'" ? 'Unterminated string literal' : 'Unterminated quoted identifier',
          severity: 'error',
        });
      }
      continue;
    }

    if (ch === '(' || ch === '[') { stack.push({ ch, at: i }); i += 1; continue; }

    if (ch === ')' || ch === ']') {
      const want = ch === ')' ? '(' : '[';
      const top = stack.pop();
      if (!top) {
        issues.push({ ...positionOf(text, i), message: `Unmatched "${ch}"`, severity: 'error' });
      } else if (top.ch !== want) {
        issues.push({ ...positionOf(text, i), message: `Expected a closing bracket for "${top.ch}"`, severity: 'error' });
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  stack.forEach((open) => {
    issues.push({ ...positionOf(text, open.at), message: `Unclosed "${open.ch}"`, severity: 'error' });
  });

  return issues;
}

/** Check one SQL statement against a specific grammar. */
function checkSql(text, sqlDialect) {
  const database = SUPPORTED_SQL_DIALECTS.has(sqlDialect) ? sqlDialect : 'PostgreSQL';

  try {
    sqlParser.astify(text, { database });
    return [];
  } catch (err) {
    // A structural problem is unambiguous — report it as the error, since it
    // also explains why the grammar parse failed.
    const structural = structuralIssues(text);
    if (structural.length) return structural;

    const loc = (err.location && err.location.start) || { line: 1, column: 1 };
    return [{
      ...clampToText(text, loc.line, loc.column),
      message: tidyParserMessage(err.message),
      // Only a warning: the grammar may simply not model this vendor syntax.
      severity: 'warning',
    }];
  }
}

/**
 * Check one document-store query.
 *
 * mongodb-query-parser reports positions against a source it wraps in a
 * leading newline, and its columns are 0-based — both are corrected here so
 * the marker lands on the right character.
 */
function checkDocument(text) {
  let parseFilter;
  try {
    ({ parseFilter } = require('mongodb-query-parser'));
  } catch (_) {
    return []; // parser unavailable — don't block the user on our own tooling
  }

  try {
    parseFilter(text);
    return [];
  } catch (err) {
    const msg = String(err.message || 'Invalid query');
    // Positions are reported against a source wrapped in a leading newline,
    // and columns are 0-based — undo both, then clamp onto a real line.
    const at = /\((\d+):(\d+)\)/.exec(msg);
    const pos = at
      ? clampToText(text, Number(at[1]) - 1, Number(at[2]) + 1)
      : { line: 1, column: 1 };
    return [{ ...pos, message: tidyParserMessage(msg), severity: 'error' }];
  }
}

/**
 * Validate a single statement.
 *
 * @param {object|null} connector - plugin module for this dbType
 * @param {string} text - one statement, already split out of the worksheet
 * @returns {{ ok: boolean, issues: Array<{line,column,message,severity}> }}
 */
function validateStatement(connector, text) {
  const body = String(text || '').trim();
  if (!body) return { ok: true, issues: [] };

  const dialect = resolveDialect(connector);

  // The connector gets first say — it knows its own syntax best. Returning
  // `handled: true` means it fully checked the statement and the generic pass
  // is skipped.
  const custom = connector && connector.explorer && connector.explorer.validate;
  if (typeof custom === 'function') {
    try {
      const res = custom(body) || {};
      const issues = Array.isArray(res.issues) ? res.issues : [];
      if (res.handled === true) {
        return { ok: !issues.some((i) => i.severity === 'error'), issues };
      }
      if (issues.length) {
        return { ok: !issues.some((i) => i.severity === 'error'), issues };
      }
    } catch (err) {
      return {
        ok: false,
        issues: [{ line: 1, column: 1, message: err.message || String(err), severity: 'error' }],
      };
    }
  }

  const issues = dialect.language === 'json'
    ? checkDocument(body)
    : checkSql(body, dialect.sqlDialect);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

module.exports = { validateStatement, positionOf, SUPPORTED_SQL_DIALECTS };
