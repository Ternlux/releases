/**
 * Data Explorer — result panel.
 *
 * Shows the result of the last run — or, once pinned, the result that was on
 * screen when the pin went in, held there while later runs happen behind it.
 * Query history opens here too, from the sidebar, as a second tab.
 *
 * Tabular results render as a grid; document results (or rows holding nested
 * objects) render as JSON. Statements that return no rows get a message pane.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { C, MONO, SANS, Icon } from './theme';
// The grid, the JSON cards and the Table/JSON switch are shared with the
// workflow Data Preview — see ResultsView.js for the shape they read.
import {
  Grid, JsonView, RowDetail, ViewToggle, autoViewFor, formatCell, useCopySelection,
} from './ResultsView';

const toCsv = (columns, rows) => {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.map((c) => esc(c.name)).join(','),
    ...rows.map((r) => columns.map((c) => esc(r[c.name])).join(',')),
  ].join('\n');
};

const download = (filename, text, mime) => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Give the click a tick to start before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ── history ────────────────────────────────────────────────────────────────

const HistoryTab = ({ history, onLoad, onClear }) => (
  <div style={{ flex: 1, overflow: 'auto', background: C.bg, minHeight: 0 }}>
    {history.length === 0 ? (
      <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12, color: C.muted }}>
        Nothing has been run against this connection yet.
      </div>
    ) : (
      <>
        <div style={{
          display: 'flex', alignItems: 'center', padding: '6px 14px',
          borderBottom: `1px solid ${C.border}`, background: C.surface,
        }}>
          <span style={{ flex: 1, fontSize: 9.5, fontFamily: MONO, color: C.dim, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {history.length} run{history.length === 1 ? '' : 's'} · click to load into the worksheet
          </span>
          <button
            type="button"
            onClick={onClear}
            style={{
              border: `1px solid ${C.border}`, background: C.bg, borderRadius: 4,
              padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontFamily: MONO, color: C.muted,
            }}
          >
            Clear
          </button>
        </div>
        {history.map((h) => (
          <div
            key={h.id}
            onClick={() => onLoad(h.sql)}
            style={{
              display: 'flex', gap: 10, padding: '9px 14px', alignItems: 'flex-start',
              borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.surface; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ marginTop: 3, flexShrink: 0, display: 'flex' }}>
              {h.ok ? Icon('check', C.green, 11) : Icon('alert', C.red, 11)}
            </span>
            <span style={{ fontSize: 10.5, fontFamily: MONO, color: C.dim, flexShrink: 0, width: 46, paddingTop: 1 }}>
              {h.ranAt ? new Date(h.ranAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }) : ''}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 11.5, fontFamily: MONO, color: C.text,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {h.summary || h.sql}
              </div>
              {h.error && (
                <div style={{ fontSize: 10.5, fontFamily: MONO, color: C.red, marginTop: 3 }}>{h.error}</div>
              )}
            </div>
            <span style={{
              fontSize: 10, fontFamily: MONO, flexShrink: 0, paddingTop: 1,
              color: h.ms > 1000 ? C.amber : C.muted,
            }}>
              {h.ms} ms
            </span>
          </div>
        ))}
      </>
    )}
  </div>
);

// ── shell ──────────────────────────────────────────────────────────────────

const ResultsPanel = ({
  result,
  error,
  running,
  history = [],
  tab,
  onTab,
  onLoadHistory,
  onClearHistory,
  isDocumentStore,
  minimized,
  onMinimize,
  dock = 'bottom',
  onDock,
}) => {
  const [openRow, setOpenRow] = useState(null);
  // What the grid has selected: either a rectangle of cells or whole rows.
  // { mode: 'cells' | 'rows', rows: Set<sourceIndex>, columns: string[] | null,
  //   cell: { row, column, value } | null }  — `columns` null means every one.
  const [selection, setSelection] = useState(null);
  const [viewOverride, setViewOverride] = useState(null);
  const panelRef = useRef(null);

  // Result tabs. Runs land in the one unpinned tab — the live one — so the
  // strip stays a single "Results" until something is pinned. A pinned tab is
  // out of that rotation: with no live tab left, the next run opens a new tab
  // beside it and the pinned rows stay where they are. They hold whole row
  // sets, so pins live in memory for the session rather than being persisted.
  const [sheets, setSheets] = useState([]);
  const [activeSheetId, setActiveSheetId] = useState(null);

  // A fresh outcome from the parent replaces the live tab, or opens one, and is
  // brought to the front — you ran it, so you get to see it. A failure is an
  // outcome like any other and lands the same way: it has to, because with
  // everything pinned there is no live tab, and a message with nowhere to go
  // leaves the pinned rows on screen and the error unseen.
  //
  // This adjusts state during render off `prevRun`, rather than off a ref:
  // StrictMode renders twice, and everything here has to come out the same
  // both times or the second pass drops the tab the first one opened. So no
  // ref bumping, and the new tab's number is derived from the tabs on hand.
  const [prevRun, setPrevRun] = useState({ result: null, error: null });
  if (result !== prevRun.result || error !== prevRun.error) {
    setPrevRun({ result, error });
    // Starting a run clears the error before anything replaces it; only an
    // outcome claims a tab, so nothing moves in between.
    if (result || error) {
      if (openRow !== null) setOpenRow(null);
      if (selection !== null) setSelection(null);
      if (viewOverride !== null) setViewOverride(null);

      // One or the other: rows the statement returned, or why it returned none.
      const landed = { result: result || null, error: result ? null : error };
      const live = sheets.find((s) => !s.pinned);
      if (live) {
        setSheets(sheets.map((s) => (s === live ? { ...s, ...landed, rev: s.rev + 1 } : s)));
        setActiveSheetId(live.id);
      } else {
        const n = sheets.reduce((max, s) => Math.max(max, s.n), 0) + 1;
        setSheets([...sheets, { id: `r${n}`, n, rev: 0, pinned: false, ...landed }]);
        setActiveSheetId(`r${n}`);
      }
    }
  }

  // History opens from the sidebar and borrows this panel; it shows as a tab
  // only while it is open, so closing it returns to the results.
  const showHistory = tab === 'history';

  // Before the first run there is nothing to tab between, but the strip still
  // needs its Results tab to hang the empty state off.
  const sheetTabs = sheets.length
    ? sheets
    : [{ id: 'r0', n: 1, rev: 0, pinned: false, result: null, placeholder: true }];

  const activeSheet = sheets.find((s) => s.id === activeSheetId)
    || sheets[sheets.length - 1]
    || sheetTabs[0];

  const shown = activeSheet.result;
  const hasRows = Boolean(shown && shown.rows && shown.rows.length);
  const onPinnedTab = Boolean(activeSheet.pinned);

  // What is on screen belongs to the tab, not to the last run: a pinned tab
  // keeps its own rows or its own error while later runs go on elsewhere, and
  // the stats bar says what became of them.
  const shownError = activeSheet.error || null;
  const busy = running && !onPinnedTab;
  const failed = Boolean(shownError);

  const togglePin = (sheet) => {
    if (!sheet.pinned) {
      setSheets((prev) => prev.map((s) => (s.id === sheet.id ? { ...s, pinned: true } : s)));
      return;
    }
    // Unpinning releases the snapshot. With no live tab it goes back to taking
    // new results; otherwise it closes, since only one tab can be live.
    const live = sheets.find((s) => !s.pinned);
    if (!live) {
      setSheets((prev) => prev.map((s) => (s.id === sheet.id ? { ...s, pinned: false } : s)));
      return;
    }
    setSheets((prev) => prev.filter((s) => s.id !== sheet.id));
    if (activeSheet.id === sheet.id) setActiveSheetId(live.id);
  };

  // Nested values read far better as JSON than truncated in a cell.
  const autoView = useMemo(
    () => (hasRows ? autoViewFor(shown, { isDocumentStore }) : 'grid'),
    [shown, hasRows, isDocumentStore],
  );

  const view = viewOverride || autoView;

  const exportAs = (format) => {
    if (!hasRows) return;
    if (format === 'CSV') {
      download('query-result.csv', toCsv(shown.columns, shown.rows), 'text/csv');
    } else {
      download('query-result.json', JSON.stringify(shown.rows, null, 2), 'application/json');
    }
  };

  // A selection belongs to the rows it was made in, so switching tabs — or a
  // pinned tab taking new rows — drops it rather than carrying the highlight,
  // and the row detail, onto a different result.
  useEffect(() => {
    setSelection(null);
    setOpenRow(null);
  }, [activeSheet.id, activeSheet.rev]);

  // ⌘C copies the selection as TSV, scoped to this panel — see ResultsView.
  useCopySelection(panelRef, shown, selection);

  // The focused cell drives the inspector in the stats bar; the Copy button
  // beside it only makes sense while that cell is the whole selection.
  const focusCell = selection && selection.cell ? selection.cell : null;
  const selectedCells = selection && selection.columns
    ? selection.rows.size * selection.columns.length
    : 0;

  return (
    <div ref={panelRef} tabIndex={-1} style={{
      flex: minimized ? '0 0 auto' : '1 1 0', minHeight: 0, minWidth: 0,
      display: 'flex', flexDirection: 'column', outline: 'none',
      // The panel docks below the editor or beside it. The divider that resizes
      // it belongs to the parent, so only the closing border moves with it.
      ...(dock === 'right'
        ? { borderLeft: `1px solid ${C.border}` }
        : { borderTop: `1px solid ${C.border}` }),
      background: C.bg,
    }}>
      {/* tab strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, flexShrink: 0,
        padding: '0 7px 0 4px', background: C.surface, borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {sheetTabs.map((s) => {
            const on = !showHistory && activeSheet.id === s.id && !minimized;
            const label = s.n === 1 ? 'Results' : `Result ${s.n}`;
            const count = s.result && s.result.rows ? s.result.rows.length : null;
            return (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', flexShrink: 0, marginBottom: -1,
                borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
                background: on ? C.bg : 'transparent',
              }}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveSheetId(s.id);
                    if (showHistory) onTab('results');
                    if (minimized) onMinimize(false);
                  }}
                  title={s.error || (s.result && s.result.statement) || label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, height: 32,
                    padding: s.placeholder ? '0 11px' : '0 5px 0 11px',
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    fontFamily: SANS, fontSize: 11.5, fontWeight: on ? 600 : 500,
                    color: on ? C.accent : C.muted, whiteSpace: 'nowrap',
                  }}
                >
                  {Icon('grid', s.error ? C.red : on ? C.accent : C.dim, 12)}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                  {/* A failed tab wears its outcome, so a run that went wrong
                      behind a pinned one reads as such from the strip. */}
                  {s.error ? (
                    <span style={{
                      fontSize: 9, fontFamily: MONO, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                      letterSpacing: '0.04em', textTransform: 'uppercase',
                      color: C.red, background: C.redD, border: `1px solid ${C.redB}`,
                    }}>
                      error
                    </span>
                  ) : count != null && (
                    <span style={{
                      fontSize: 9, fontFamily: MONO, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                      color: on ? C.accent : C.dim,
                      background: on ? C.aD : C.s2,
                      border: `1px solid ${on ? C.aB : C.border}`,
                    }}>
                      {count}
                    </span>
                  )}
                </button>

                {/* Pin, on the tab it belongs to. Pinning keeps this tab's rows
                    and pushes the next run into a tab of its own. */}
                {!s.placeholder && (
                  <button
                    type="button"
                    title={s.pinned
                      ? (sheets.some((o) => !o.pinned)
                        ? 'Unpin — lets go of this result and closes the tab'
                        : 'Unpin — this tab takes the next run again')
                      : 'Pin this result — the next run opens a new tab'}
                    onClick={() => togglePin(s)}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      padding: '0 8px 0 2px', height: 32, display: 'flex', alignItems: 'center',
                      opacity: s.pinned ? 1 : 0.45,
                    }}
                  >
                    {Icon('pin', s.pinned ? C.accent : C.dim, 11, s.pinned)}
                  </button>
                )}
              </div>
            );
          })}

          {showHistory && (
            <div style={{
              display: 'flex', alignItems: 'center', flexShrink: 0, marginBottom: -1,
              borderBottom: `2px solid ${minimized ? 'transparent' : C.accent}`,
              background: minimized ? 'transparent' : C.bg,
            }}>
              <button
                type="button"
                onClick={() => { if (minimized) onMinimize(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 4px 0 11px',
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontFamily: SANS, fontSize: 11.5, fontWeight: minimized ? 500 : 600,
                  color: minimized ? C.muted : C.accent, whiteSpace: 'nowrap',
                }}
              >
                {Icon('history', minimized ? C.dim : C.accent, 12)}
                History
              </button>
              <button
                type="button"
                title="Close"
                onClick={() => onTab('results')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: '0 7px 0 2px', height: 32, display: 'flex', alignItems: 'center',
                }}
              >
                {Icon('close', C.dim, 10)}
              </button>
            </div>
          )}
        </div>

        {hasRows && !minimized && (
          <ViewToggle view={view} onChange={setViewOverride} />
        )}

        {typeof onDock === 'function' && (
          <button
            type="button"
            title={dock === 'right' ? 'Dock results to the bottom' : 'Dock results to the right'}
            onClick={() => onDock(dock === 'right' ? 'bottom' : 'right')}
            style={{
              width: 24, height: 24, borderRadius: 5, flexShrink: 0,
              border: `1px solid ${C.border}`, background: C.bg, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {/* Two panes, filled on the side the results currently occupy. */}
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke={C.muted} />
              {dock === 'right'
                ? <rect x="7" y="1" width="4" height="10" fill={C.muted} />
                : <rect x="1" y="7" width="10" height="4" fill={C.muted} />}
            </svg>
          </button>
        )}

        <button
          type="button"
          title={minimized ? 'Expand results' : 'Minimize results'}
          onClick={() => onMinimize(!minimized)}
          style={{
            width: 24, height: 24, borderRadius: 5, flexShrink: 0,
            border: `1px solid ${C.border}`, background: C.bg, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {Icon(minimized ? 'up' : 'minus', C.muted, 12)}
        </button>
      </div>

      {!minimized && (
        <>
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {showHistory && (
              <HistoryTab history={history} onLoad={onLoadHistory} onClear={onClearHistory} />
            )}

            {!showHistory && (
              <>
                {busy && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: C.muted }}>
                    Running…
                  </div>
                )}

                {!busy && failed && (
                  <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                    <div style={{
                      padding: '12px 14px', borderRadius: 6,
                      background: C.redD, border: `1px solid ${C.redB}`,
                      fontFamily: MONO, fontSize: 12, color: C.red, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    }}>
                      {shownError}
                    </div>
                  </div>
                )}

                {!busy && !failed && !shown && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: C.muted }}>No results yet.</span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: C.dim }}>
                      ⌘↵ runs the selection, or the statement at the caret
                    </span>
                  </div>
                )}

                {!busy && !failed && shown && !hasRows && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: C.text }}>
                      {shown.message || 'Statement completed.'}
                    </span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: C.dim }}>
                      {shown.rowCount != null ? `${shown.rowCount} row(s) affected · ` : ''}{shown.ms} ms
                    </span>
                  </div>
                )}

                {!busy && !failed && hasRows && view === 'grid' && (
                  <Grid
                    key={`${activeSheet.id}-${activeSheet.rev}`}
                    result={shown}
                    openRow={openRow}
                    onOpenRow={setOpenRow}
                    selection={selection}
                    onSelect={setSelection}
                  />
                )}
                {!busy && !failed && hasRows && view === 'json' && <JsonView key={`${activeSheet.id}-${activeSheet.rev}`} result={shown} />}
                {!busy && !failed && hasRows && view === 'grid' && openRow !== null && (
                  <RowDetail result={shown} index={openRow} onClose={() => setOpenRow(null)} />
                )}
              </>
            )}
          </div>

          {/* stats bar */}
          {!showHistory && shown && !failed && !busy && (
            <div style={{
              display: 'flex', alignItems: 'center', height: 30, padding: '0 10px', flexShrink: 0,
              borderTop: `1px solid ${C.border}`, background: C.surface, overflowX: 'auto',
            }}>
              {/* A capped read stops the engine early, so there is no true
                  total to report — say "first N" rather than implying N is all
                  there was. */}
              {[
                shown.truncated
                  ? `first ${(shown.rows || []).length} ${isDocumentStore ? 'docs' : 'rows'}`
                  : `${shown.rowCount != null ? shown.rowCount : (shown.rows || []).length} ${isDocumentStore ? 'docs' : 'rows'}`,
                `${shown.ms} ms`,
                shown.truncated
                  ? `capped at ${shown.rowCap || (shown.rows || []).length} — narrow the query for more`
                  : null,
                // A pinned tab shows none of what happens after it — say so
                // here, so a run failing behind it is never silent.
                onPinnedTab
                  ? (running ? 'pinned — a run is in progress'
                    : error ? 'pinned — the last run failed'
                      : 'pinned — later runs open a new tab')
                  : null,
                selection && selection.rows.size
                  ? (selection.mode === 'rows'
                    ? `${selection.rows.size} row${selection.rows.size === 1 ? '' : 's'} selected — ⌘C to copy`
                    : selectedCells > 1
                      ? `${selectedCells} cells selected — ⌘C to copy`
                      : null)
                  : null,
              ].filter(Boolean).map((text, i) => (
                <span key={i} style={{
                  fontSize: 10.5, fontFamily: MONO, whiteSpace: 'nowrap',
                  color: text.startsWith('capped') ? C.amber
                    : text.includes('failed') ? C.red
                      : text.startsWith('pinned') ? C.accent
                        : text.includes('selected') ? C.accent
                          : i < 2 ? C.text : C.muted,
                  paddingRight: 10, marginRight: 10, borderRight: `1px solid ${C.border}`,
                }}>
                  {text}
                </span>
              ))}

              <span style={{
                flex: 1, minWidth: 12, fontSize: 10.5, fontFamily: MONO, color: C.dim,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {focusCell
                  ? `${focusCell.column} = ${formatCell(focusCell.value, null) ?? 'NULL'}`
                  : 'drag across cells to select them · click a row number for the whole row, double-click for detail'}
              </span>

              {focusCell && selectedCells === 1 && (
                <button
                  type="button"
                  title="Copy cell"
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(String(formatCell(focusCell.value, null) ?? ''));
                    } catch (_) { /* clipboard denied */ }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, marginRight: 6, flexShrink: 0,
                    padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}`,
                    background: C.bg, cursor: 'pointer', fontSize: 10, fontFamily: MONO, color: C.muted,
                  }}
                >
                  {Icon('copy', C.muted, 10)} Copy
                </button>
              )}

              {hasRows && ['CSV', 'JSON'].map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => exportAs(format)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4, flexShrink: 0,
                    padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}`,
                    background: C.bg, cursor: 'pointer',
                    fontSize: 10, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.05em', color: C.muted,
                  }}
                >
                  {Icon('download', C.muted, 10)} {format}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ResultsPanel;
