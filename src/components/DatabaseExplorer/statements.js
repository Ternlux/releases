/**
 * Splitting worksheet text into runnable statements.
 *
 * Run executes exactly one block:
 *   1. if the user has selected text, that selection — nothing else;
 *   2. otherwise the statement the caret sits in, bounded by `;`.
 *
 * Splitting is quote- and comment-aware, so a `;` inside a string literal, a
 * line comment or a `$$ … $$` body never ends a statement.
 */

/**
 * Split text into statements.
 *
 * @param {string} text
 * @returns {Array<{text,start,end,startLine,startColumn}>} statements in
 *   document order. `start`/`end` are character offsets into `text`;
 *   `startLine`/`startColumn` are 1-based positions of the first non-blank
 *   character, which is where a validation issue on statement-line 1 anchors.
 */
export function splitStatements(text) {
  const src = String(text || '');
  const out = [];
  let start = 0;
  let i = 0;

  const push = (from, to) => {
    const raw = src.slice(from, to);
    if (!raw.trim()) return;

    // Anchor at the first non-whitespace character so positions ignore the
    // blank lines between statements.
    const lead = raw.length - raw.replace(/^\s+/, '').length;
    const before = src.slice(0, from + lead).split('\n');

    out.push({
      text: raw.trim(),
      start: from + lead,
      end: to,
      startLine: before.length,
      startColumn: before[before.length - 1].length + 1,
    });
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === '-' && next === '-') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    // Dollar-quoted body ($$ … $$ or $tag$ … $tag$) — a function definition
    // is full of semicolons that must not split it.
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
      if (tag) {
        const close = src.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? src.length : close + tag[0].length;
        continue;
      }
    }

    // String literal or quoted identifier
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\' && ch === "'") { i += 2; continue; }
        if (src[i] === ch) {
          if (src[i + 1] === ch) { i += 2; continue; } // doubled = escaped
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ';') {
      push(start, i);
      start = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  push(start, src.length);
  return out;
}

/** The statement containing `offset`, or the nearest preceding one. */
export function statementAt(statements, offset) {
  if (!statements.length) return null;

  for (const st of statements) {
    // `end` is inclusive of the caret sitting just past the last character, so
    // a caret resting right after `;` still belongs to that statement.
    if (offset >= st.start && offset <= st.end) return st;
  }

  // Caret is in trailing whitespace or between statements — take the last one
  // that starts before it.
  const before = statements.filter((s) => s.start <= offset);
  return before.length ? before[before.length - 1] : statements[0];
}

/**
 * Work out what Run should execute.
 *
 * @param {object} args
 * @param {string} args.text          full worksheet text
 * @param {string} [args.selection]   selected text, if any
 * @param {number} [args.cursorOffset] caret position when nothing is selected
 * @returns {{text,start,end,source}|null} `source` is 'selection' or
 *   'statement', which the UI reports back to the user.
 */
export function resolveRunTarget({ text, selection, cursorOffset = 0 }) {
  // A selection wins outright — running exactly what's highlighted is the
  // whole point of highlighting it.
  if (selection && selection.trim()) {
    return { text: selection.trim(), start: null, end: null, source: 'selection' };
  }

  const statements = splitStatements(text);
  if (!statements.length) return null;

  const st = statementAt(statements, cursorOffset);
  return st ? { ...st, source: 'statement' } : null;
}

/**
 * Strip comments and blank space to a compact one-line label — used for
 * history rows and the "ran statement N" toast.
 */
export function summarize(sql, max = 90) {
  const flat = String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
