import React, { useState, useEffect, useRef } from 'react';
import './NodeForm.css';

// ─────────────────────────────────────────────────────────────────────────────
// Node config form primitives — the React port of design/"Node Form Spec.html".
// Every component renders the .tlx- markup from the spec so the CSS can stay a
// verbatim lift. Shared by StartNodeChat / DataSourceNodeChat / OutputNodeChat.
// ─────────────────────────────────────────────────────────────────────────────

// Category accent colours, matching the spec's --tlx-* node tokens.
export const FORM_ACCENT = {
  start: '#1e88e5',
  source: '#26a69a',
  transform: '#2196f3',
  join: '#f57c00',
  branch: '#43a047',
  output: '#7c4dff',
};

// Colour dots for the grouped destination list (categorizeConnection()).
export const GROUP_COLOR = {
  'Cloud Storage': '#0891b2',
  APIs: '#2563eb',
  Vector: '#16a34a',
  Databases: '#7c3aed',
  'Local Files': '#d97706',
  Other: '#5a6678',
};

// ── Icons ────────────────────────────────────────────────────────────────────

export const IconCheck = ({ size = 14, color = 'currentColor', width = 2.6 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth={width} strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
);

export const IconFolder = ({ size = 13, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export const IconInfo = ({ size = 13, color = '#9ca3af' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
  </svg>
);

export const IconSearch = ({ size = 12, color = '#9ca3af' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);

export const IconPlus = ({ size = 13, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);

export const IconChat = ({ size = 14, color = '#2196f3' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M12 8V4M8 14h.01M16 14h.01M9 20v2M15 20v2" />
  </svg>
);

export const IconApi = ({ size = 15, color = '#2196f3' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth="2" strokeLinecap="round">
    <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
  </svg>
);

// ── Panel body / footer ──────────────────────────────────────────────────────

/** Scrollable card stack. Wrap the whole form in <FormScope>. */
export const FormScope = ({ children }) => <div className="tlx-scope">{children}</div>;

export const FormBody = ({ children }) => <div className="tlx-panel__body">{children}</div>;

/**
 * Sticky footer. `error` is the gate message shown on the left (e.g. "Pick a
 * file to enable Save"); `saveLabel` differs per node (Output runs on save).
 *
 * `saveDisabledReason` becomes the hover tooltip explaining why Save is greyed
 * out. It sits on a wrapper span because a disabled <button> swallows the
 * pointer events a title= would need.
 */
export const FormFooter = ({
  error,
  onCancel,
  onSave,
  saveLabel = 'Save configuration',
  saveDisabled = false,
  saveDisabledReason,
  cancelLabel = 'Cancel',
  cancelDisabled = false,
}) => (
  <div className="tlx-panel__foot">
    {error ? <span className="tlx-error">{error}</span> : null}
    <span className="tlx-spacer" />
    <button type="button" className="tlx-btn" onClick={onCancel} disabled={cancelDisabled}>
      {cancelLabel}
    </button>
    <span
      className="tlx-savewrap"
      title={saveDisabled ? (saveDisabledReason || undefined) : undefined}
    >
      <button type="button" className="tlx-btn tlx-btn--primary" onClick={onSave} disabled={saveDisabled}>
        {saveLabel}
      </button>
    </span>
  </div>
);

// ── Card / field ─────────────────────────────────────────────────────────────

export const Card = ({ label, children }) => (
  <div className="tlx-card">
    {label ? <div className="tlx-card__label">{label}</div> : null}
    {children}
  </div>
);

export const Fields = ({ children }) => <div className="tlx-fields">{children}</div>;

export const Field = ({ label, required = false, hint, invalid = false, children }) => (
  <div className={`tlx-field${invalid ? ' is-invalid' : ''}`}>
    {label ? (
      <label className="tlx-label">
        {label}
        {required ? <span className="tlx-req">required</span> : null}
      </label>
    ) : null}
    {children}
    {hint ? <div className="tlx-hint">{hint}</div> : null}
  </div>
);

// ── Controls ─────────────────────────────────────────────────────────────────

/** Segmented control. `options` is [{ label, value }]. */
export const Segmented = ({ value, options, onChange }) => (
  <div className="tlx-seg">
    {options.map((o) => (
      <button
        key={String(o.value)}
        type="button"
        className={o.value === value ? 'is-on' : undefined}
        onClick={() => onChange(o.value)}
      >
        {o.label}
      </button>
    ))}
  </div>
);

/** Native select in the spec's chevron wrapper. `options` is [{ label, value }]. */
export const SelectInput = ({ value, options, onChange, placeholder, disabled = false }) => (
  <div className="tlx-selectwrap">
    <select
      className="tlx-select"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={String(o.value)} value={o.value}>{o.label}</option>
      ))}
    </select>
  </div>
);

/**
 * Read-only display for a value the user had no choice about — a lone table in
 * a single-table file, for instance. Rendering a one-option dropdown just asks
 * a question with one answer.
 */
export const StaticValue = ({ children, mono = true }) => (
  <div className={`tlx-static${mono ? ' is-mono' : ''}`}>{children}</div>
);

/**
 * Select with a filter box. A schema can hold hundreds of tables, which a bare
 * <select> makes unusable. Expands INLINE rather than overlaying: the panel
 * body is a scroll container, so an absolutely-positioned menu would be clipped
 * at its edge with no way to scroll to it.
 */
export const SearchSelect = ({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  searchPlaceholder = 'Filter…',
  emptyText = 'No matches',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus();
  }, [open]);

  const selected = options.find((o) => String(o.value) === String(value));
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => String(o.label).toLowerCase().includes(q))
    : options;

  const pick = (v) => {
    setOpen(false);
    setQuery('');
    onChange(v);
  };

  return (
    <div className="tlx-combo">
      <button
        type="button"
        className={`tlx-combo__btn${open ? ' is-open' : ''}${selected ? '' : ' is-empty'}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="tlx-combo__value">{selected ? selected.label : placeholder}</span>
        <svg className={`tlx-combo__caret${open ? ' is-open' : ''}`} width="10" height="10"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="tlx-combo__panel">
          <div className="tlx-combo__search">
            <IconSearch />
            <input
              ref={searchRef}
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setOpen(false); setQuery(''); }
                if (e.key === 'Enter' && shown.length === 1) pick(shown[0].value);
              }}
            />
          </div>
          <div className="tlx-combo__list">
            {shown.length === 0 ? (
              <div className="tlx-combo__empty">{emptyText}</div>
            ) : shown.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                className={`tlx-combo__opt${String(o.value) === String(value) ? ' is-on' : ''}`}
                onClick={() => pick(o.value)}
              >
                <span className="tlx-combo__optlabel">{o.label}</span>
                {String(o.value) === String(value) ? <IconCheck size={12} /> : null}
              </button>
            ))}
          </div>
          {options.length > shown.length && (
            <div className="tlx-combo__count">{shown.length} of {options.length}</div>
          )}
        </div>
      )}
    </div>
  );
};

export const TextInput = ({ value, onChange, placeholder, mono = false }) => (
  <input
    className={`tlx-input${mono ? ' is-mono' : ''}`}
    value={value ?? ''}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
  />
);

export const NumberInput = ({ value, onChange, min, max, step }) => (
  <input
    className="tlx-num"
    type="number"
    min={min}
    max={max}
    step={step}
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
  />
);

/** HH:MM time input. Value/onChange use a "HH:MM" string. */
export const TimeInput = ({ value, onChange }) => (
  <input className="tlx-time" type="time" value={value || ''} onChange={(e) => onChange(e.target.value)} />
);

/** Read-only-ish path field with a Browse button that opens a native dialog. */
export const PathPicker = ({ value, onChange, onBrowse, placeholder, browseTitle = 'Browse' }) => (
  <div className="tlx-path">
    <input
      className="tlx-input"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
    <button type="button" className="tlx-browse" aria-label={browseTitle} title={browseTitle} onClick={onBrowse}>
      <IconFolder />
    </button>
  </div>
);

/** Two-column multi-select. `options` is [{ label, value }]; `value` an array. */
export const CheckGrid = ({ value = [], options, onChange }) => {
  const toggle = (v) => {
    const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
    onChange(next);
  };
  return (
    <div className="tlx-checks">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            className={`tlx-check${on ? ' is-on' : ''}`}
            onClick={() => toggle(o.value)}
          >
            <span className="tlx-check__box"><IconCheck size={10} color="#fff" width={3.5} /></span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
};

export const Note = ({ children }) => (
  <div className="tlx-note"><IconInfo />{' '}<span>{children}</span></div>
);

/** Tinted callout used for the API chat handoff and cloud-storage pickers. */
export const Handoff = ({ color, icon, title, children }) => (
  <div className="tlx-handoff" style={color ? { '--hc': color } : undefined}>
    <div className="tlx-handoff__title">{icon}{title}</div>
    {children}
  </div>
);

export const HandoffBody = ({ children }) => <p className="tlx-handoff__body">{children}</p>;

export const Picked = ({ children }) => (
  <div className="tlx-picked"><IconCheck size={13} color="#059669" />{' '}<span>{children}</span></div>
);

export const CloudButton = ({ onClick, children, disabled = false }) => (
  <button type="button" className="tlx-btn tlx-btn--cloud" onClick={onClick} disabled={disabled}>
    <IconFolder color="#fff" />{children}
  </button>
);

export const EmptyState = ({ children }) => <div className="tlx-empty">{children}</div>;

// ── Connection list ──────────────────────────────────────────────────────────

export const SearchBox = ({ value, onChange, placeholder = 'Search connections…' }) => (
  <div className="tlx-search">
    <IconSearch />
    <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </div>
);

export const ConnList = ({ children, grouped = false }) => (
  <div className={`tlx-connlist${grouped ? ' tlx-connlist--grouped' : ''}`}>{children}</div>
);

export const ConnGroup = ({ label, color }) => (
  <div className="tlx-conngroup" style={{ '--gc': color || GROUP_COLOR.Other }}>
    <span className="tlx-conngroup__dot" />{label}
    <span className="tlx-conngroup__rule" />
  </div>
);

/**
 * Collapsible category header for the connection list. Groups keep a long
 * connection list navigable — only the group you are working in is expanded.
 */
export const ConnGroupToggle = ({ label, color, count, open, onToggle }) => (
  <button
    type="button"
    className="tlx-conngroup tlx-conngroup--btn"
    style={{ '--gc': color || GROUP_COLOR.Other }}
    onClick={onToggle}
    aria-expanded={open}
  >
    <span className="tlx-conngroup__dot" />
    {label}
    <span className="tlx-conngroup__count">{count}</span>
    <span className="tlx-conngroup__rule" />
    <svg
      className={`tlx-conngroup__caret${open ? ' is-open' : ''}`}
      width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </button>
);

/** One selectable connection row: icon, name, uppercase meta line, tick. */
export const ConnRow = ({ icon, name, meta, selected = false, onClick }) => (
  <button type="button" className={`tlx-conn${selected ? ' is-on' : ''}`} onClick={onClick}>
    <span className="tlx-conn__ico">{icon}</span>
    <span className="tlx-conn__body">
      <span className="tlx-conn__name">{name}</span>
      {meta ? <span className="tlx-conn__meta">{meta}</span> : null}
    </span>
    <span className="tlx-conn__tick"><IconCheck /></span>
  </button>
);

export const NewConnButton = ({ onClick, label = 'New connection' }) => (
  <button type="button" className="tlx-newconn" onClick={onClick}>
    <IconPlus />{label}
  </button>
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "09:05" ⇄ { hour, minute } — the shape StartNodeChat's cronConfig uses. */
export const toTimeString = (hour, minute) =>
  `${String(hour ?? 0).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}`;

export const fromTimeString = (str) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
};
