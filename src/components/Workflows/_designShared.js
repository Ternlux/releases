import React, { useState, useRef, useEffect } from 'react';

// Design tokens — mirrors design/Ternlux Tabs.html
export const C = {
  bg: '#fff', surface: '#f7f9fc', s2: '#eef1f6',
  border: '#e2e6eb', border2: '#cdd2db',
  text: '#111827', muted: '#5a6678', dim: '#9ca3af',
  accent: '#2563eb', aD: '#eff4ff',
  green: '#059669', gD: 'rgba(5,150,105,0.08)', gB: 'rgba(5,150,105,0.18)',
  amber: '#d97706', amD: 'rgba(217,119,6,0.08)',
  red: '#dc2626', rD: 'rgba(220,38,38,0.08)',
  cyan: '#0891b2', cD: 'rgba(8,145,178,0.08)',
  violet: '#7c3aed', vD: 'rgba(124,58,237,0.08)',
};
export const MONO = "'JetBrains Mono', monospace";
export const SANS = "'Inter', -apple-system, sans-serif";

// SVG icons keyed by name
const icons = {
  plus:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  import:  (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  more:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>,
  edit:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  trash:   (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  play:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" fill={c}/></svg>,
  reload:  (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>,
  check:   (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
  x:       (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  clock:   (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  eye:     (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  db:      (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>,
  file:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>,
  cal:     (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  user:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  node:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/></svg>,
  table:   (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>,
  compass: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>,
  zap:     (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill={c} stroke={c} strokeWidth="1"/></svg>,
  spin:    (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>,
  chevron: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
};
export const I = (name, color = C.muted, size = 14) => icons[name]?.(color, size) ?? null;

// Status configuration shared by ExecutionTab and any details panel.
export const STATUS_CFG = {
  completed: { label: 'COMPLETED', color: C.green,  bg: C.gD,  border: C.gB,                        icon: 'check' },
  running:   { label: 'RUNNING',   color: '#1d4ed8', bg: 'rgba(37,99,235,0.16)', border: 'rgba(37,99,235,0.4)', icon: 'spin'  },
  failed:    { label: 'FAILED',    color: C.red,    bg: C.rD,  border: 'rgba(220,38,38,0.2)',       icon: 'x'     },
  cancelled: { label: 'CANCELLED', color: C.amber,  bg: C.amD, border: 'rgba(217,119,6,0.2)',       icon: 'clock' },
  pending:   { label: 'PENDING',   color: C.muted,  bg: C.s2,  border: C.border,                    icon: 'clock' },
  timeout:   { label: 'TIMEOUT',   color: '#ff7a45',bg: 'rgba(255,122,69,0.08)', border: 'rgba(255,122,69,0.2)', icon: 'x' },
};

export const StatusBadge = ({ status }) => {
  const cfg = STATUS_CFG[status] || STATUS_CFG.cancelled;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px',
      borderRadius: 3, fontSize: 10, fontWeight: 600, fontFamily: MONO, letterSpacing: '0.05em',
      color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
    }}>
      {I(cfg.icon, cfg.color, 9)} {cfg.label}
    </span>
  );
};

export const Btn = ({ children, variant = 'ghost', size = 'sm', icon, onClick, style = {}, disabled = false }) => {
  const [hov, setHov] = useState(false);
  const pad = size === 'sm' ? '5px 10px' : '7px 14px';
  const fs = size === 'sm' ? 12 : 13;
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: pad, borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: fs, fontWeight: 500, fontFamily: SANS,
    border: 'none', transition: 'all 0.15s', whiteSpace: 'nowrap',
    opacity: disabled ? 0.55 : 1,
  };
  const styles = {
    ghost:   { background: hov && !disabled ? C.surface : '#fff', border: `1px solid ${C.border}`,  color: hov && !disabled ? C.text : C.muted },
    primary: { background: hov && !disabled ? '#1d4ed8' : C.accent, border: '1px solid transparent', color: '#fff', fontWeight: 600 },
    danger:  { background: hov && !disabled ? C.rD : 'transparent',  border: '1px solid transparent', color: C.red },
  };
  const iconColor = variant === 'primary' ? '#fff'
    : variant === 'danger' ? C.red
    : (hov && !disabled) ? C.text : C.muted;
  return (
    <button type="button" disabled={disabled}
      style={{ ...base, ...styles[variant], ...style }}
      onMouseOver={() => setHov(true)} onMouseOut={() => setHov(false)} onClick={onClick}>
      {icon && I(icon, iconColor, 12)}
      {children}
    </button>
  );
};

export const Tag = ({ children, color, bg, border }) => (
  <span style={{
    display: 'inline-block', padding: '2px 7px', borderRadius: 3,
    fontSize: 10, fontWeight: 600, fontFamily: MONO, letterSpacing: '0.04em',
    color, background: bg, border: `1px solid ${border}`,
  }}>
    {children}
  </span>
);

export const MetaItem = ({ icon, children }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.muted }}>
    {I(icon, C.dim, 11)}{children}
  </span>
);

const Menu = ({ items }) => (
  <div style={{
    position: 'absolute', top: '100%', right: 0, zIndex: 1200, marginTop: 4,
    background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)', minWidth: 160, overflow: 'hidden',
  }}>
    {items.map((item, i) => item === '---' ? (
      <div key={i} style={{ height: 1, background: C.border, margin: '2px 0' }} />
    ) : (
      <button key={i} type="button" onClick={item.onClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px',
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: SANS,
          color: item.danger ? C.red : C.text, textAlign: 'left',
        }}
        onMouseOver={e => e.currentTarget.style.background = item.danger ? C.rD : C.surface}
        onMouseOut={e => e.currentTarget.style.background = 'none'}>
        {item.icon && I(item.icon, item.danger ? C.red : C.muted, 12)}
        {item.label}
      </button>
    ))}
  </div>
);

export const MoreMenu = ({ items }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
      <button type="button" onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 4, border: 'none', background: 'none',
          cursor: 'pointer', color: C.dim, transition: 'background 0.15s',
        }}
        onMouseOver={e => e.currentTarget.style.background = C.s2}
        onMouseOut={e => e.currentTarget.style.background = 'none'}>
        {I('more', C.dim, 14)}
      </button>
      {open && <Menu items={items.map(it => ({ ...it, onClick: () => { setOpen(false); it.onClick?.(); } }))} />}
    </div>
  );
};

export const PageHeader = ({ title, sub, actions }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '20px 24px', background: '#fff', borderBottom: `1px solid ${C.border}`, flexShrink: 0,
  }}>
    <div>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: '-0.02em' }}>{title}</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>
    </div>
    <div style={{ display: 'flex', gap: 8 }}>{actions}</div>
  </div>
);

export const StatCard = ({ label, value, sub, color }) => (
  <div style={{
    background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, padding: '16px 20px',
  }}>
    <div style={{
      fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 500,
      letterSpacing: '0.03em', textTransform: 'uppercase',
    }}>{label}</div>
    <div style={{
      fontSize: 22, fontWeight: 700, color: color || C.text,
      letterSpacing: '-0.04em', lineHeight: 1,
    }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: C.dim, marginTop: 4, fontFamily: MONO }}>{sub}</div>}
  </div>
);

// ── Workspace-scale popups ─────────────────────────────────────────────────
// The editor, explorer, uploads and previews are workspaces, not dialogs: they
// fill the window with a 5% gap all round rather than sizing to their content.
// Width is a percentage so it tracks the modal wrap — which App.css narrows
// when the chat assistant is pinned — while height is in vh, since the
// assistant's rail is full-height and never eats vertical space.
export const fullscreenModalProps = ({ bodyPadding = 24 } = {}) => ({
  width: '97%',
  centered: true,
  // antd reserves 24px under the modal box, which would push the card off
  // centre by half that and make the two gaps uneven.
  style: { paddingBottom: 0, maxWidth: 'none' },
  styles: {
    content: {
      height: '98vh', padding: 0, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    },
    header: {
      padding: '16px 24px', marginBottom: 0,
      borderBottom: `1px solid ${C.border}`, flexShrink: 0,
    },
    body: { flex: 1, minHeight: 0, overflow: 'auto', padding: bodyPadding },
  },
});
