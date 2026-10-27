/**
 * Data Explorer — left object panel.
 *
 * Three sections: pinned favourites, the schema tree, and the open worksheets,
 * with query history above them as a place to jump to. Expanding a table loads
 * its columns, which also warms the cache the editor's autocomplete reads from.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { C, MONO, SANS, Icon, OBJECT_KINDS, metaFor } from './theme';

const Row = ({
  depth = 0, icon, label, meta, active, bold, title,
  onClick, onDoubleClick, right,
}) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, minHeight: 26,
        padding: `4px 8px 4px ${8 + depth * 13}px`,
        borderRadius: 4, cursor: 'pointer',
        background: active ? C.aD : hover ? C.s2 : 'transparent',
        border: `1px solid ${active ? C.aB : 'transparent'}`,
      }}
    >
      {icon}
      <span style={{
        flex: 1, fontSize: 12, letterSpacing: '-0.01em',
        color: active ? C.accent : C.text,
        fontWeight: bold || active ? 600 : 450,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {label}
      </span>
      {meta && (
        <span style={{ fontSize: 9.5, fontFamily: MONO, color: C.dim, flexShrink: 0 }}>{meta}</span>
      )}
      {right}
    </div>
  );
};

const SectionHead = ({ label, count, open, onToggle, action }) => (
  <div
    onClick={onToggle}
    style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '7px 10px 6px', cursor: 'pointer', userSelect: 'none',
    }}
  >
    <div style={{ display: 'flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
      {Icon('caret', C.dim, 11)}
    </div>
    <span style={{
      fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.12em',
      color: C.muted, textTransform: 'uppercase',
    }}>
      {label}
    </span>
    {count != null && <span style={{ fontSize: 9, fontFamily: MONO, color: C.dim }}>{count}</span>}
    <div style={{ flex: 1, height: 1, background: C.border }} />
    {action}
  </div>
);

/**
 * The tree's names come from the engine, so on a remote connection this is a
 * real wait. It gets a spinner and the noun the connector uses — "loading"
 * on its own doesn't say what the panel is still missing.
 */
const Spinner = ({ size = 12, color = C.accent }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{
      animation: 'dbx-spin 0.7s linear infinite',
      transformOrigin: 'center',
      flexShrink: 0,
    }}
  >
    <circle cx="12" cy="12" r="9" fill="none" stroke={C.s3} strokeWidth="3" />
    <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Placeholder rows shaped like the tree they stand in for, so the panel keeps
// its height and the list doesn't jump when the real names land.
const SKELETON_ROWS = [
  { depth: 0, width: 126 },
  { depth: 2, width: 96 },
  { depth: 2, width: 112 },
  { depth: 2, width: 78 },
  { depth: 2, width: 104 },
];

const TreeSkeleton = () => (
  <div aria-hidden="true">
    {SKELETON_ROWS.map((row, i) => {
      const bar = {
        background: C.s3, borderRadius: 4,
        animation: `dbx-pulse 1.3s ease-in-out ${i * 0.11}s infinite`,
      };
      return (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, minHeight: 26,
            padding: `4px 8px 4px ${8 + row.depth * 13}px`,
          }}
        >
          <div style={{ ...bar, width: 12, height: 12, borderRadius: 3, flexShrink: 0 }} />
          <div style={{ ...bar, width: row.width, height: 8, maxWidth: '100%' }} />
        </div>
      );
    })}
  </div>
);

const iconButton = (title, onClick, glyph) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    style={{
      width: 28, height: 28, borderRadius: 5, flexShrink: 0,
      border: `1px solid ${C.border}`, background: C.bg, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    {glyph}
  </button>
);

const ObjectPanel = ({
  // Owned by DatabaseExplorer — it holds the drag handle beside this panel and
  // persists the width per connection, alongside the results-divider layout.
  width = 274,
  dbType,
  containerLabel = 'Schema',
  // What this engine calls the things in the tree — the connector's
  // `objectLabel`. It is what the loading line names, so a document store says
  // it is loading collection names rather than tables it doesn't have.
  objectLabel = 'Table',
  schemas = [],
  loading = false,
  error = null,
  onRefresh,
  activeSchema,
  onSelectSchema,
  onOpenObject,
  selectedKey,
  favorites = [],
  onToggleFavorite,
  worksheets = [],
  activeWorksheetId,
  onSelectWorksheet,
  onNewWorksheet,
  columnsFor,
  onLoadColumns,
  onCollapse,
  onOpenHistory,
  historyOpen = false,
  historyCount = 0,
}) => {
  const meta = metaFor(dbType);
  const [query, setQuery] = useState('');
  const [openSchemas, setOpenSchemas] = useState({});

  // The schema the opened connection owns starts expanded; siblings (other
  // local files, listed so they can be joined to) start collapsed so the tree
  // still opens on what the user actually clicked.
  useEffect(() => {
    const primary = (schemas || []).find((s) => s.primary);
    if (!primary) return;
    setOpenSchemas((prev) => (
      prev[primary.name] === undefined ? { ...prev, [primary.name]: true } : prev
    ));
  }, [schemas]);
  const [openKinds, setOpenKinds] = useState({});
  const [openObjects, setOpenObjects] = useState({});
  const [sections, setSections] = useState({ favorites: true, objects: true, worksheets: true });

  const needle = query.trim().toLowerCase();

  // A refresh keeps the tree it already has and says so; only a cold load has
  // nothing to show, and that is the one that gets the skeleton.
  const objectNoun = (objectLabel || 'Table').toLowerCase();
  const firstLoad = loading && schemas.length === 0;

  // Flat match list while the filter box has text — the tree is replaced by
  // results so a deep object is one click away.
  const matches = useMemo(() => {
    if (!needle) return null;
    const out = [];
    for (const schema of schemas) {
      for (const kind of OBJECT_KINDS) {
        for (const obj of (schema.objects && schema.objects[kind.key]) || []) {
          if (obj.name.toLowerCase().includes(needle)) {
            out.push({ schema: schema.name, kind, obj });
          }
        }
      }
    }
    return out.slice(0, 60);
  }, [needle, schemas]);

  const toggleObject = (key, schema, table) => {
    setOpenObjects((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Fetch columns the first time it's opened; the parent caches them.
      if (next[key] && !columnsFor(schema, table)) onLoadColumns(schema, table);
      return next;
    });
  };

  const columnRows = (schema, table) => {
    const cols = columnsFor(schema, table);
    if (!cols) {
      return (
        <div style={{ padding: '3px 8px 3px 52px', fontSize: 10.5, color: C.dim, fontStyle: 'italic' }}>
          loading columns…
        </div>
      );
    }
    if (!cols.length) {
      return (
        <div style={{ padding: '3px 8px 3px 52px', fontSize: 10.5, color: C.dim, fontStyle: 'italic' }}>
          no columns reported
        </div>
      );
    }
    return cols.map((col) => (
      <div
        key={col.name}
        style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22, padding: '2px 8px 2px 52px' }}
      >
        {col.isPrimary
          ? Icon('key', C.amber, 10)
          : <span style={{ width: 10, height: 1, background: C.border2, display: 'inline-block' }} />}
        <span style={{
          flex: 1, fontSize: 11, fontFamily: MONO, color: C.text,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {col.name}
        </span>
        <span style={{ fontSize: 9.5, fontFamily: MONO, color: C.dim, flexShrink: 0 }}>{col.type}</span>
      </div>
    ));
  };

  const favoriteButton = (key, schema, name, kind) => {
    const isFav = favorites.some((f) => f.key === key);
    return (
      <button
        type="button"
        title={isFav ? 'Unpin' : 'Pin to favourites'}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite({ key, schema, name, kind }); }}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer',
          padding: 1, display: 'flex', opacity: isFav ? 1 : 0.35,
        }}
      >
        {Icon('star', isFav ? C.amber : C.dim, 11, isFav)}
      </button>
    );
  };

  return (
    <div style={{
      width, flexShrink: 0, minHeight: 0,
      borderRight: `1px solid ${C.border}`, background: C.surface,
      display: 'flex', flexDirection: 'column',
    }}>
      <style>{`
        @keyframes dbx-spin { to { transform: rotate(360deg) } }
        @keyframes dbx-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.42 } }
      `}</style>

      {/* filter + actions */}
      <div style={{
        padding: '9px 10px', borderBottom: `1px solid ${C.border}`,
        display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <div style={{
            position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
            display: 'flex', pointerEvents: 'none',
          }}>
            {Icon('search', C.dim, 12)}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter objects…"
            style={{
              width: '100%', padding: '6px 24px 6px 26px', borderRadius: 5,
              border: `1px solid ${C.border}`, background: C.bg,
              fontSize: 11.5, fontFamily: SANS, color: C.text, outline: 'none',
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              style={{
                position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)',
                border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'flex',
              }}
            >
              {Icon('close', C.dim, 11)}
            </button>
          )}
        </div>
        {iconButton('Refresh schema', onRefresh, Icon('refresh', C.muted, 13))}
        {iconButton('Hide panel', onCollapse, Icon('panelShut', C.muted, 14))}
      </div>

      {/* schema scope — also what autocomplete treats as unqualified */}
      {schemas.length > 0 && (
        <div style={{
          padding: '7px 10px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', gap: 7, background: C.bg,
        }}>
          <span style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
            color: C.dim, textTransform: 'uppercase', flexShrink: 0,
          }}>
            {containerLabel}
          </span>
          <select
            value={activeSchema || ''}
            onChange={(e) => onSelectSchema(e.target.value || null)}
            title={`Objects in this ${containerLabel.toLowerCase()} complete without a prefix`}
            style={{
              flex: 1, minWidth: 0, padding: '3px 6px', borderRadius: 4,
              border: `1px solid ${C.border}`, background: C.bg,
              fontSize: 11, fontFamily: MONO, color: C.text, outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="">All</option>
            {schemas.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
      )}

      {/* Query history lives here rather than in the result tab strip — it is a
          place you go, not a view of the run you just made. Clicking it opens
          history inside the results panel. */}
      <div style={{ padding: '4px 6px', borderBottom: `1px solid ${C.border}` }}>
        <Row
          icon={Icon('history', historyOpen ? C.accent : C.dim, 13)}
          label="Query history"
          meta={historyCount ? String(historyCount) : null}
          active={historyOpen}
          title="Open this connection's query history in the results panel"
          onClick={onOpenHistory}
        />
      </div>

      {/* body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 6px 12px', minHeight: 0 }}>
        {error && (
          <div style={{
            margin: '8px 4px', padding: '8px 10px', borderRadius: 5,
            background: C.redD, border: `1px solid ${C.redB}`,
            fontSize: 11, color: C.red, lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {loading && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              margin: '8px 4px 6px', padding: '7px 9px', borderRadius: 5,
              background: C.aD, border: `1px solid ${C.aB}`,
            }}
          >
            <Spinner />
            <span style={{ fontSize: 11, color: C.accentDark, letterSpacing: '-0.01em' }}>
              {schemas.length
                ? `Refreshing ${objectNoun} names…`
                : `Loading ${objectNoun} names…`}
            </span>
          </div>
        )}

        {!loading && !error && schemas.length === 0 && (
          <div style={{ padding: '18px 10px', textAlign: 'center', fontSize: 11, color: C.muted }}>
            No objects found.
          </div>
        )}

        {matches && !firstLoad && (
          <div style={{ paddingTop: 6 }}>
            <div style={{
              padding: '2px 6px 8px', fontSize: 9, fontFamily: MONO, fontWeight: 700,
              letterSpacing: '0.1em', color: C.dim, textTransform: 'uppercase',
            }}>
              {matches.length} match{matches.length === 1 ? '' : 'es'}
            </div>
            {matches.map(({ schema, kind, obj }) => (
              <Row
                key={`${schema}.${obj.name}`}
                icon={Icon(kind.icon, kind.color, 13)}
                label={obj.name}
                meta={schema}
                active={selectedKey === `${schema}.${obj.name}`}
                title="Click to select · double-click to open a preview worksheet"
                onClick={() => onOpenObject(schema, obj, kind.key, false)}
                onDoubleClick={() => onOpenObject(schema, obj, kind.key, true)}
              />
            ))}
            {matches.length === 0 && (
              <div style={{ padding: '24px 10px', textAlign: 'center', fontSize: 11, color: C.muted }}>
                Nothing matches “{query}”.
              </div>
            )}
          </div>
        )}

        {/* Filtering before the names have arrived: the skeleton stands in for
            the results rather than claiming nothing matches. */}
        {matches && firstLoad && <TreeSkeleton />}

        {!matches && (
          <>
            <SectionHead
              label="Favourites"
              count={favorites.length}
              open={sections.favorites}
              onToggle={() => setSections((p) => ({ ...p, favorites: !p.favorites }))}
            />
            {sections.favorites && (favorites.length ? favorites.map((f) => (
              <Row
                key={f.key}
                icon={Icon('star', C.amber, 12, true)}
                label={f.name}
                meta={f.schema}
                active={selectedKey === f.key}
                onClick={() => onOpenObject(f.schema, { name: f.name }, f.kind, false)}
                onDoubleClick={() => onOpenObject(f.schema, { name: f.name }, f.kind, true)}
                right={(
                  <button
                    type="button"
                    title="Unpin"
                    onClick={(e) => { e.stopPropagation(); onToggleFavorite(f); }}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 1, display: 'flex' }}
                  >
                    {Icon('close', C.dim, 10)}
                  </button>
                )}
              />
            )) : (
              <div style={{ padding: '6px 12px 10px', fontSize: 10.5, color: C.dim, fontStyle: 'italic' }}>
                Star an object to pin it here.
              </div>
            ))}

            <SectionHead
              label={`${containerLabel}s`}
              count={firstLoad ? null : schemas.length}
              open={sections.objects}
              onToggle={() => setSections((p) => ({ ...p, objects: !p.objects }))}
            />
            {sections.objects && firstLoad && <TreeSkeleton />}
            {sections.objects && schemas.map((schema) => {
              const schemaOpen = openSchemas[schema.name];
              const total = OBJECT_KINDS.reduce(
                (n, k) => n + (((schema.objects || {})[k.key]) || []).length, 0,
              );
              return (
                <div key={schema.name}>
                  <Row
                    bold
                    icon={(
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ display: 'flex', transform: schemaOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
                          {Icon('caret', C.dim, 10)}
                        </span>
                        {Icon(containerLabel === 'Schema' ? 'folder' : 'db', meta.color, 13)}
                      </div>
                    )}
                    // Local files get a generated schema id (c_1a2b3c) and a
                    // human label — show the label, but keep the id in the
                    // tooltip since that is what you type to qualify a join.
                    label={schema.label || schema.name}
                    meta={schema.primary ? 'open · ' + total : `${total} obj`}
                    active={activeSchema === schema.name}
                    title={schema.label
                      ? `${schema.label} — qualify as ${schema.name}.<table>. Double-click to scope autocomplete here.`
                      : `Double-click to scope autocomplete to ${schema.name}`}
                    onClick={() => setOpenSchemas((p) => ({ ...p, [schema.name]: !p[schema.name] }))}
                    onDoubleClick={() => onSelectSchema(schema.name)}
                  />
                  {schemaOpen && OBJECT_KINDS.map((kind) => {
                    const list = ((schema.objects || {})[kind.key]) || [];
                    if (!list.length) return null;
                    const kindKey = `${schema.name}/${kind.key}`;
                    const kindOpen = openKinds[kindKey] !== false; // open by default
                    return (
                      <div key={kindKey}>
                        <Row
                          depth={1}
                          icon={(
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <span style={{ display: 'flex', transform: kindOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
                                {Icon('caret', C.dim, 10)}
                              </span>
                              {Icon(kind.icon, kind.color, 12)}
                            </div>
                          )}
                          label={kind.label}
                          meta={String(list.length)}
                          onClick={() => setOpenKinds((p) => ({ ...p, [kindKey]: !kindOpen }))}
                        />
                        {kindOpen && list.map((obj) => {
                          const key = `${schema.name}.${obj.name}`;
                          const expanded = openObjects[key];
                          return (
                            <div key={key}>
                              <Row
                                depth={2}
                                icon={Icon(kind.icon, kind.color, 12)}
                                label={obj.name}
                                active={selectedKey === key}
                                title="Click to expand columns · double-click to open a preview worksheet"
                                onClick={() => {
                                  toggleObject(key, schema.name, obj.name);
                                  onOpenObject(schema.name, obj, kind.key, false);
                                }}
                                onDoubleClick={() => onOpenObject(schema.name, obj, kind.key, true)}
                                right={favoriteButton(key, schema.name, obj.name, kind.key)}
                              />
                              {expanded && columnRows(schema.name, obj.name)}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <SectionHead
              label="Worksheets"
              count={worksheets.length}
              open={sections.worksheets}
              onToggle={() => setSections((p) => ({ ...p, worksheets: !p.worksheets }))}
              action={(
                <button
                  type="button"
                  title="New worksheet"
                  onClick={(e) => { e.stopPropagation(); onNewWorksheet(); }}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'flex' }}
                >
                  {Icon('plus', C.muted, 12)}
                </button>
              )}
            />
            {sections.worksheets && worksheets.map((w) => (
              <Row
                key={w.id}
                icon={Icon('doc', w.id === activeWorksheetId ? C.accent : C.dim, 12)}
                label={w.name}
                active={w.id === activeWorksheetId}
                onClick={() => onSelectWorksheet(w.id)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default ObjectPanel;
