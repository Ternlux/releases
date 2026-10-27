/**
 * Data Explorer — results view.
 *
 * How a result set LOOKS, independent of who ran it. The Data Explorer's
 * result panel owns a query and its history; the workflow Data Preview owns a
 * node and its config; both show rows, and rows should look the same wherever
 * they come from — same grid, same JSON cards, same Table/JSON switch.
 *
 * Everything here speaks one shape:
 *
 *   result = { columns: [{ name, type?, numeric? }], rows: [{ [column]: value }] }
 *
 * `rows` are OBJECTS keyed by column name, holding real values — numbers as
 * numbers, nested objects unstringified. Both views read the same rows, so a
 * caller that pre-formats its values to strings gets a JSON view full of
 * strings; hand over the raw rows and let the views format.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, MONO, Icon } from './theme';

// ── value formatting ───────────────────────────────────────────────────────

export const formatCell = (value, column) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (column && column.numeric && typeof value === 'number') {
    return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  return String(value);
};

// ── grid ───────────────────────────────────────────────────────────────────
//
// The grid renders only the rows in view. Everything below exists to keep that
// cheap, because the old version paid for the whole result on EVERY render:
// selecting one cell re-rendered every cell in the table, and at a thousand
// rows that is tens of thousands of DOM nodes, inline style objects and event
// closures rebuilt per click.
//
// Four things keep it fast now:
//   * windowing — only the visible slice is in the DOM;
//   * `table-layout: fixed` with measured column widths, so the browser never
//     re-measures cell content (and columns don't jitter as you scroll);
//   * a memoised Row, so changing the selection re-renders the rows that
//     changed rather than all of them;
//   * static styles hoisted out of render.

const ROW_H = 26;          // must match the td height exactly — windowing maths
const HEAD_H = 28;
const OVERSCAN = 8;        // rows rendered off-screen each way, to hide scroll
const GUTTER_W = 46;
const COL_MIN = 90;
const COL_MAX = 420;
const CHAR_W = 6.7;        // ~1ch at 11.5px in this monospace face
const WIDTH_SAMPLE = 150;  // rows sampled to size columns

const gridStyles = {
  scroller: { flex: 1, overflow: 'auto', background: C.bg, minHeight: 0, position: 'relative' },
  gutterHead: {
    position: 'sticky', top: 0, left: 0, zIndex: 4, width: GUTTER_W, height: HEAD_H,
    background: C.s3, borderBottom: `1px solid ${C.border2}`, borderRight: `1px solid ${C.border2}`,
  },
  fillerHead: {
    position: 'sticky', top: 0, zIndex: 2,
    background: C.s2, borderBottom: `1px solid ${C.border2}`,
  },
  headInner: { display: 'flex', alignItems: 'center', gap: 5 },
  colType: { fontSize: 9, color: C.dim },
  nullCell: { fontSize: 10.5, color: C.dim, fontStyle: 'italic' },
  spacerCell: { padding: 0, border: 0 },
};

/** Column pixel widths, measured once per result from a sample of its rows. */
function measureWidths(columns, rows) {
  const sample = Math.min(rows.length, WIDTH_SAMPLE);
  return columns.map((col) => {
    // header text + type label + sort caret
    let widest = String(col.name).length + String(col.type || '').length + 4;
    for (let i = 0; i < sample; i++) {
      const v = rows[i] ? rows[i][col.name] : null;
      if (v === null || v === undefined) { if (widest < 4) widest = 4; continue; }
      const len = typeof v === 'object' ? JSON.stringify(v).length : String(v).length;
      if (len > widest) widest = len;
    }
    return Math.round(Math.min(COL_MAX, Math.max(COL_MIN, widest * CHAR_W + 20)));
  });
}

const Row = React.memo(function Row({
  row, rowIndex, displayIndex, columns, widths, isOpen, selected, selectedColumns, focusColumn,
  onOpenRow, onGutterDown, onCellDown, onCellEnter, onRowEnter,
}) {
  const zebra = displayIndex % 2 ? C.surface : C.bg;
  // `selectedColumns` of null means the whole row is selected; a cell range
  // names its columns, and only those cells are tinted.
  const wholeRow = selected && !selectedColumns;

  // The selection tint is translucent (C.aS is 10% blue), so it needs
  // something opaque beneath it — laid down here as a gradient layer over a
  // solid base rather than used as the background outright.
  //
  // The gutter is why this matters: it is sticky, so the row scrolls UNDERNEATH
  // it, and a translucent background let the row's own cells slide visibly
  // behind the row number. The cells need the same treatment for a quieter
  // reason — a bare tint composites over the table's white, losing the zebra
  // stripe, so a selected cell looked different on odd and even rows.
  const tinted = (base) => `linear-gradient(${C.aS}, ${C.aS}), ${base}`;

  return (
    <tr onPointerEnter={() => onRowEnter(rowIndex)}>
      <td
        onPointerDown={(e) => onGutterDown(e, rowIndex)}
        onDoubleClick={() => onOpenRow(isOpen ? null : rowIndex)}
        title="Click to select the whole row · double-click for row detail"
        style={{
          position: 'sticky', left: 0, zIndex: 1, width: GUTTER_W, height: ROW_H,
          background: isOpen ? C.aD : selected ? tinted(C.s2) : C.s2,
          borderBottom: `1px solid ${C.border}`, borderRight: `2px solid ${C.border2}`,
          padding: '0 6px', textAlign: 'right', cursor: 'pointer',
          fontSize: 10, color: isOpen ? C.accent : selected ? C.accent : C.dim,
        }}
      >
        {displayIndex + 1}
      </td>

      {columns.map((col, ci) => {
        const value = row[col.name];
        const inSelection = selected && (!selectedColumns || selectedColumns.has(col.name));
        return (
          <td
            key={col.name}
            onPointerDown={(e) => onCellDown(e, rowIndex, ci, col.name, value)}
            onPointerEnter={() => onCellEnter(rowIndex, ci)}
            style={{
              height: ROW_H, padding: '0 9px', width: widths[ci],
              borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`,
              textAlign: col.numeric ? 'right' : 'left',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              background: inSelection ? tinted(zebra) : zebra,
              boxShadow: focusColumn === col.name ? `inset 0 0 0 2px ${C.accent}` : 'none',
              cursor: 'cell',
            }}
          >
            {value === null || value === undefined
              ? <span style={gridStyles.nullCell}>NULL</span>
              : <span style={{ color: typeof value === 'object' ? C.cyan : C.text }}>
                  {formatCell(value, col)}
                </span>}
          </td>
        );
      })}

      <td style={{ borderBottom: `1px solid ${C.border}`, background: wholeRow ? tinted(zebra) : zebra }} />
    </tr>
  );
});

const EMPTY_ROWS = new Set();

export const Grid = ({ result, onOpenRow, openRow, selection, onSelect }) => {
  const [sort, setSort] = useState(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const scrollerRef = useRef(null);
  // Live drag state. A ref, not state: it changes on every pointermove and
  // nothing about it needs to trigger a render on its own.
  const drag = useRef(null);
  // Where the current selection started. Unlike the drag it outlives the
  // button, so a shift-click made later still extends from the same corner.
  const anchor = useRef(null);

  // Memoised so the sort and width computations below keep a stable identity —
  // a bare `result.rows || []` mints a new array whenever rows are absent, and
  // that alone would re-sort and re-measure on every render.
  const allRows = useMemo(() => result.rows || [], [result.rows]);
  const columns = useMemo(() => result.columns || [], [result.columns]);

  // Sorting reorders INDICES. The rows themselves are never copied or spread,
  // so sorting a large result costs one integer array, not a second copy of
  // the data.
  const order = useMemo(() => {
    const idx = allRows.map((_, i) => i);
    if (!sort) return idx;
    const { column, direction } = sort;
    const dir = direction === 'asc' ? 1 : -1;
    return idx.sort((a, b) => {
      const x = allRows[a][column];
      const y = allRows[b][column];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y));
      return cmp * dir;
    });
  }, [allRows, sort]);

  // Reverse lookup: row index -> its position in the display order. Drag
  // selection needs this on every pointer move, and scanning `order` each time
  // would be O(rows) per mouse event.
  const positions = useMemo(() => {
    const m = new Int32Array(allRows.length);
    for (let d = 0; d < order.length; d++) m[order[d]] = d;
    return m;
  }, [order, allRows.length]);

  const widths = useMemo(() => measureWidths(columns, allRows), [columns, allRows]);
  const totalWidth = useMemo(
    () => widths.reduce((n, w) => n + w, GUTTER_W), [widths],
  );

  // Visible slice.
  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewport.height / ROW_H) + OVERSCAN * 2;
  const last = Math.min(order.length, first + visibleCount);
  const padTop = first * ROW_H;
  const padBottom = Math.max(0, (order.length - last) * ROW_H);

  const onScroll = (e) => {
    const el = e.currentTarget;
    setViewport((prev) => (
      // Only re-render when the slice could actually change.
      Math.abs(prev.top - el.scrollTop) >= ROW_H || prev.height !== el.clientHeight
        ? { top: el.scrollTop, height: el.clientHeight }
        : prev
    ));
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const sync = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cycleSort = (name) => {
    // The selection is held by source row, so it follows the data through a
    // re-sort; the anchor is a display position and would not, so it goes.
    anchor.current = null;
    setSort((prev) => {
      if (!prev || prev.column !== name) return { column: name, direction: 'asc' };
      if (prev.direction === 'asc') return { column: name, direction: 'desc' };
      return null;
    });
  };

  // ── selection ────────────────────────────────────────────────────────────
  //
  // Where a press lands decides what it selects. Press a cell and you get that
  // cell; drag and the selection grows into the rectangle the pointer covers,
  // so picking three columns out of a row copies those three and nothing else.
  // Press the row number in the gutter and you get the whole record — every
  // column, however far it scrolls off to the right.
  //
  // The grid sets `user-select: none`, so a drag extends the selection instead
  // of smearing a text highlight across the cells.
  const selectedRows = selection ? selection.rows : EMPTY_ROWS;

  // One Set shared by every row, so a memoised Row sees a stable prop and only
  // the rows whose selectedness changed re-render. The span is compared by
  // value rather than by identity: a drag mints a fresh selection on every
  // pointer move, and dragging a range down a column must not re-render every
  // visible row each time it does.
  const spanRef = useRef(null);
  const selectedColumns = useMemo(() => {
    const names = selection && selection.columns;
    if (!names) return null;
    const prev = spanRef.current;
    if (prev && prev.size === names.length && names.every((n) => prev.has(n))) return prev;
    spanRef.current = new Set(names);
    return spanRef.current;
  }, [selection]);

  // A cell range is always a rectangle: contiguous display rows crossed with
  // contiguous columns. Rows are stored by source index — the selection has to
  // survive a re-sort — while the corners are display positions.
  const emitCells = useCallback((aRow, aCol, fRow, fCol, cell) => {
    const loR = Math.min(aRow, fRow);
    const hiR = Math.max(aRow, fRow);
    const loC = Math.min(aCol, fCol);
    const hiC = Math.max(aCol, fCol);
    const rows = new Set();
    for (let d = loR; d <= hiR; d++) rows.add(order[d]);
    onSelect({
      mode: 'cells',
      rows,
      columns: columns.slice(loC, hiC + 1).map((c) => c.name),
      cell,
    });
  }, [order, columns, onSelect]);

  const emitRows = useCallback((aRow, fRow, base) => {
    const lo = Math.min(aRow, fRow);
    const hi = Math.max(aRow, fRow);
    const rows = new Set(base);
    for (let d = lo; d <= hi; d++) rows.add(order[d]);
    onSelect({ mode: 'rows', rows, columns: null, cell: null });
  }, [order, onSelect]);

  const cellAt = useCallback((rowIndex, ci) => {
    const col = columns[ci];
    return { row: rowIndex, column: col.name, value: allRows[rowIndex][col.name] };
  }, [columns, allRows]);

  const onCellDown = useCallback((e, rowIndex, ci, column, value) => {
    if (e.button !== 0) return;
    const displayIndex = positions[rowIndex];
    const cell = { row: rowIndex, column, value };
    const a = anchor.current;

    // Shift keeps the corner the last press put down and moves the other one.
    if (e.shiftKey && a && a.mode === 'cells') {
      drag.current = { mode: 'cells' };
      emitCells(a.row, a.col, displayIndex, ci, cell);
      return;
    }

    anchor.current = { mode: 'cells', row: displayIndex, col: ci };
    drag.current = { mode: 'cells' };
    emitCells(displayIndex, ci, displayIndex, ci, cell);
  }, [positions, emitCells]);

  const onCellEnter = useCallback((rowIndex, ci) => {
    const d = drag.current;
    if (!d || d.mode !== 'cells') return;
    const a = anchor.current;
    emitCells(a.row, a.col, positions[rowIndex], ci, cellAt(rowIndex, ci));
  }, [positions, emitCells, cellAt]);

  const onGutterDown = useCallback((e, rowIndex) => {
    if (e.button !== 0) return;
    const displayIndex = positions[rowIndex];
    const additive = e.metaKey || e.ctrlKey;
    // Rows accumulate only on top of other rows: a cell range is a different
    // kind of selection, and ⌘-clicking a row number replaces it.
    const current = selection && selection.mode === 'rows' ? selection.rows : null;
    const a = anchor.current;

    if (e.shiftKey && a && a.mode === 'rows') {
      const base = additive && current ? new Set(current) : [];
      drag.current = { mode: 'rows', base };
      emitRows(a.row, displayIndex, base);
      return;
    }

    anchor.current = { mode: 'rows', row: displayIndex, col: 0 };
    drag.current = { mode: 'rows', base: additive && current ? new Set(current) : [] };

    if (additive && current) {
      const next = new Set(current);
      if (next.has(rowIndex)) next.delete(rowIndex); else next.add(rowIndex);
      onSelect({ mode: 'rows', rows: next, columns: null, cell: null });
      return;
    }

    emitRows(displayIndex, displayIndex, []);
  }, [positions, selection, onSelect, emitRows]);

  const onRowEnter = useCallback((rowIndex) => {
    const d = drag.current;
    if (!d || d.mode !== 'rows') return;
    emitRows(anchor.current.row, positions[rowIndex], d.base);
  }, [positions, emitRows]);

  // Only the drag ends with the button. The anchor stays put, so the next
  // shift-click still knows which corner to keep.
  useEffect(() => {
    const onUp = () => { drag.current = null; };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      style={{ ...gridStyles.scroller, userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <table style={{
        borderCollapse: 'separate', borderSpacing: 0,
        fontFamily: MONO, fontSize: 11.5,
        // Fixed layout is what stops the browser measuring every cell — and
        // what keeps column widths steady while rows scroll in and out.
        tableLayout: 'fixed', width: Math.max(totalWidth, 0),
        minWidth: '100%',
      }}>
        <colgroup>
          <col style={{ width: GUTTER_W }} />
          {columns.map((col, i) => <col key={col.name} style={{ width: widths[i] }} />)}
          <col />
        </colgroup>

        <thead>
          <tr>
            <th style={gridStyles.gutterHead} />
            {columns.map((col) => {
              const active = sort && sort.column === col.name;
              return (
                <th
                  key={col.name}
                  onClick={() => cycleSort(col.name)}
                  title={`${col.name} · ${col.type}`}
                  style={{
                    position: 'sticky', top: 0, zIndex: 2, height: HEAD_H,
                    background: C.s2, borderBottom: `2px solid ${active ? C.accent : C.border2}`,
                    borderRight: `1px solid ${C.border}`, padding: '0 8px',
                    textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  <div style={gridStyles.headInner}>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, color: active ? C.accent : C.text,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {col.name}
                    </span>
                    <span style={gridStyles.colType}>{col.type}</span>
                    {active && Icon(sort.direction === 'asc' ? 'up' : 'down', C.accent, 11)}
                  </div>
                </th>
              );
            })}
            <th style={gridStyles.fillerHead} />
          </tr>
        </thead>

        <tbody>
          {/* Spacers stand in for the rows that aren't rendered, so the
              scrollbar reflects the whole result. */}
          {padTop > 0 && (
            <tr aria-hidden="true" style={{ height: padTop }}>
              <td colSpan={columns.length + 2} style={gridStyles.spacerCell} />
            </tr>
          )}

          {order.slice(first, last).map((rowIndex, n) => (
            <Row
              key={rowIndex}
              row={allRows[rowIndex]}
              rowIndex={rowIndex}
              displayIndex={first + n}
              columns={columns}
              widths={widths}
              isOpen={openRow === rowIndex}
              selected={selectedRows.has(rowIndex)}
              selectedColumns={selectedColumns}
              focusColumn={
                selection && selection.cell && selection.cell.row === rowIndex
                  ? selection.cell.column
                  : null
              }
              onOpenRow={onOpenRow}
              onGutterDown={onGutterDown}
              onCellDown={onCellDown}
              onCellEnter={onCellEnter}
              onRowEnter={onRowEnter}
            />
          ))}

          {padBottom > 0 && (
            <tr aria-hidden="true" style={{ height: padBottom }}>
              <td colSpan={columns.length + 2} style={gridStyles.spacerCell} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

// ── JSON view ──────────────────────────────────────────────────────────────

// Cards are expensive enough that toggling one used to re-render all of them.
// Memoised, a toggle now costs exactly the card that changed.
const DocCard = React.memo(function DocCard({ doc, index, isOpen, onToggle }) {
  const id = doc._id || doc.id || `document ${index + 1}`;
  return (
    <div style={{
      margin: '0 12px 7px', borderRadius: 6, overflow: 'hidden',
      border: `1px solid ${isOpen ? C.aB : C.border}`,
      background: isOpen ? C.bg : C.surface,
    }}>
      <div
        onClick={() => onToggle(index)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer',
          background: isOpen ? C.aD : 'transparent',
          borderBottom: isOpen ? `1px solid ${C.border}` : 'none',
        }}
      >
        <span style={{ display: 'flex', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
          {Icon('caret', isOpen ? C.accent : C.dim, 11)}
        </span>
        <span style={{ fontSize: 9.5, fontFamily: MONO, fontWeight: 700, color: C.dim }}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <span style={{
          fontSize: 11, fontFamily: MONO, fontWeight: 600,
          color: isOpen ? C.accent : C.text,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {typeof id === 'object' ? JSON.stringify(id) : String(id)}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 10, fontFamily: MONO, color: C.dim,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {Object.keys(doc).filter((k) => k !== '_id').slice(0, 5).join(' · ')}
        </span>
        <button
          type="button"
          title="Copy document"
          onClick={(e) => {
            e.stopPropagation();
            try { navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); } catch (_) { /* clipboard denied */ }
          }}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'flex' }}
        >
          {Icon('copy', C.muted, 11)}
        </button>
      </div>
      {isOpen && (
        <pre style={{
          margin: 0, padding: '9px 14px 12px', overflowX: 'auto',
          fontFamily: MONO, fontSize: 11, lineHeight: 1.65, color: C.text,
        }}>
          {JSON.stringify(doc, null, 2)}
        </pre>
      )}
    </div>
  );
});

// Cards vary in height once expanded, so this pages rather than windows:
// render a chunk, and let the user ask for the next one. Same effect on the
// symptom — a thousand documents never hit the DOM at once.
const JSON_CHUNK = 150;

export const JsonView = ({ result }) => {
  const [open, setOpen] = useState(() => new Set([0]));
  const [shown, setShown] = useState(JSON_CHUNK);
  const rows = result.rows || [];

  // A new result starts from the top again.
  useEffect(() => { setShown(JSON_CHUNK); setOpen(new Set([0])); }, [result]);

  const toggle = useCallback((i) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  }), []);

  const remaining = rows.length - shown;

  return (
    <div style={{ flex: 1, overflow: 'auto', background: C.bg, minHeight: 0, padding: '8px 0 14px' }}>
      {rows.slice(0, shown).map((doc, i) => (
        <DocCard key={i} doc={doc} index={i} isOpen={open.has(i)} onToggle={toggle} />
      ))}

      {remaining > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 12px 2px' }}>
          <button
            type="button"
            onClick={() => setShown((n) => n + JSON_CHUNK)}
            style={{
              padding: '5px 14px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${C.border2}`, background: C.surface, color: C.text,
              fontFamily: MONO, fontSize: 10.5,
            }}
          >
            Show {Math.min(JSON_CHUNK, remaining)} more · {remaining} left
          </button>
        </div>
      )}
    </div>
  );
};

// ── row detail ─────────────────────────────────────────────────────────────

export const RowDetail = ({ result, index, onClose }) => {
  const row = (result.rows || [])[index];
  if (!row) return null;
  return (
    <div style={{
      width: 300, flexShrink: 0, minHeight: 0,
      borderLeft: `1px solid ${C.border}`, background: C.bg,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
            color: C.muted, textTransform: 'uppercase',
          }}>
            Row detail
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>
            {index + 1} of {result.rows.length}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, display: 'flex' }}
        >
          {Icon('close', C.muted, 13)}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {result.columns.map((col) => {
          const value = row[col.name];
          return (
            <div key={col.name} style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontFamily: MONO, fontWeight: 700, color: C.muted }}>{col.name}</span>
                <span style={{ fontSize: 9, fontFamily: MONO, color: C.dim }}>{col.type}</span>
              </div>
              <div style={{
                fontSize: 12, fontFamily: MONO, color: C.text,
                wordBreak: 'break-word', lineHeight: 1.5,
              }}>
                {value === null || value === undefined
                  ? <em style={{ color: C.dim }}>NULL</em>
                  : formatCell(value, col)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── copying ────────────────────────────────────────────────────────────────

/**
 * ⌘C over a selection, as TSV — the format that pastes into a spreadsheet as
 * cells. A cell range copies exactly the cells that are lit, bare; whole rows
 * copy every column with a header line, because that is a record rather than a
 * patch of values.
 *
 * Scoped to `hostRef` so it never steals ⌘C from an editor elsewhere on the
 * page, and it stands in for the browser's copy-the-text-selection that the
 * grid gives up by disabling text selection. Lives here rather than in either
 * panel: a selection you cannot copy is half a feature, and both panels should
 * mean the same thing by it.
 */
export function useCopySelection(hostRef, result, selection) {
  useEffect(() => {
    if (!selection || !selection.rows.size || !result) return undefined;
    const onCopy = (e) => {
      const host = hostRef.current;
      if (!host || !host.contains(document.activeElement || e.target)) return;
      const all = result.columns || [];
      // Filtering `all` rather than mapping the names keeps the copy in grid
      // order whichever way the range was dragged.
      const cols = selection.columns
        ? all.filter((c) => selection.columns.includes(c.name))
        : all;
      const picked = (result.rows || []).filter((_, i) => selection.rows.has(i));
      if (!picked.length || !cols.length) return;
      const cell = (v) => (v === null || v === undefined ? ''
        : typeof v === 'object' ? JSON.stringify(v) : String(v));
      const lines = picked.map((r) => cols.map((c) => cell(r[c.name])).join('\t'));
      if (selection.mode === 'rows') lines.unshift(cols.map((c) => c.name).join('\t'));
      e.clipboardData.setData('text/plain', lines.join('\n'));
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [hostRef, result, selection]);
}

// ── view selection ─────────────────────────────────────────────────────────

/**
 * Which view a result opens in when the user hasn't chosen.
 *
 * Nested values are the deciding factor: an object or array truncated into a
 * grid cell tells you nothing, while the JSON card shows its shape. Document
 * stores lead with JSON for the same reason — their rows are documents, and
 * pretending otherwise flattens what the user came to read.
 */
export const autoViewFor = (result, { isDocumentStore = false } = {}) => {
  const rows = (result && result.rows) || [];
  if (rows.length === 0) return 'grid';
  if (isDocumentStore) return 'json';
  const sample = rows[0];
  if (!sample || typeof sample !== 'object') return 'json';
  return Object.values(sample).some((v) => v && typeof v === 'object') ? 'json' : 'grid';
};

/**
 * The Table / JSON switch. A segmented pair rather than a single toggle: which
 * view you are in should be readable without having to know which way the
 * switch points.
 */
export const ViewToggle = ({ view, onChange }) => (
  <div style={{
    display: 'flex', gap: 2, padding: 2, borderRadius: 5, flexShrink: 0,
    background: C.s2, border: `1px solid ${C.border}`,
  }}>
    {[['grid', 'Table'], ['json', 'JSON']].map(([key, label]) => (
      <button
        key={key}
        type="button"
        onClick={() => onChange(key)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 3,
          border: 'none', cursor: 'pointer',
          fontSize: 9.5, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
          background: view === key ? C.bg : 'transparent',
          color: view === key ? C.accent : C.muted,
        }}
      >
        {Icon(key === 'grid' ? 'grid' : 'json', view === key ? C.accent : C.muted, 10)}
        {label}
      </button>
    ))}
  </div>
);
