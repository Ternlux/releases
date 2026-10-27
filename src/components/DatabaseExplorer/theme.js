/**
 * Data Explorer — design tokens and icons.
 *
 * Mirrors the Ternlux Data Explorer design. Kept separate from the components
 * so the panel, editor and result grid all read from one palette.
 */

import React from 'react';

export const C = {
  bg: '#fff',
  surface: '#f7f9fc',
  s2: '#eef1f6',
  s3: '#e7ebf2',
  border: '#e2e6eb',
  border2: '#cdd2db',
  text: '#111827',
  muted: '#5a6678',
  dim: '#9ca3af',
  accent: '#2563eb',
  accentDark: '#1d4ed8',
  aD: '#eff4ff',
  aB: '#bfdbfe',
  aS: 'rgba(37,99,235,0.10)',
  green: '#059669',
  greenD: '#ecfdf5',
  amber: '#d97706',
  amberD: '#fffbeb',
  amberB: '#fde68a',
  red: '#dc2626',
  redD: '#fef2f2',
  redB: '#fecaca',
  cyan: '#0891b2',
  violet: '#7c3aed',
};

export const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const SANS = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

/** Per-engine accent colour and label, used for the tree and title bar. */
export const DB_META = {
  postgres:  { label: 'PostgreSQL', color: '#336791' },
  mysql:     { label: 'MySQL',      color: '#e48b00' },
  mssql:     { label: 'SQL Server', color: '#a4373a' },
  mongodb:   { label: 'MongoDB',    color: '#00a550' },
  snowflake: { label: 'Snowflake',  color: '#29b5e8' },
  // Redshift disabled for now — see connections/connectorCatalog.js.
  // redshift:  { label: 'Redshift',   color: '#8c4fff' },
  bigquery:  { label: 'BigQuery',   color: '#4285f4' },
  sqlite:    { label: 'SQLite',     color: '#0f80cc' },
  // DuckDB's brand yellow (#fff000) is unreadable as a label on white, so this
  // is the darkened gold that still reads as DuckDB.
  duckdb:    { label: 'DuckDB',     color: '#b58900' },
};

export const metaFor = (dbType) =>
  DB_META[dbType] || { label: dbType || 'Database', color: C.muted };

/**
 * How each object kind is drawn in the tree. `key` matches the buckets
 * explorer:schema-tree returns.
 */
export const OBJECT_KINDS = [
  { key: 'tables',      label: 'Tables',      icon: 'table', color: '#2563eb' },
  { key: 'views',       label: 'Views',       icon: 'view',  color: '#0891b2' },
  { key: 'collections', label: 'Collections', icon: 'coll',  color: '#00a550' },
];

// ── icons ──────────────────────────────────────────────────────────────────
// Each entry takes (color, size) and returns an inline SVG, so no icon font
// or extra dependency is involved.

const SVG = {
  search: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
      <circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.65" y2="16.65" />
    </svg>
  ),
  caret: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.2">
      <polyline points="9,6 15,12 9,18" />
    </svg>
  ),
  down: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.4">
      <polyline points="7,10 12,15 17,10" />
    </svg>
  ),
  up: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.4">
      <polyline points="7,14 12,9 17,14" />
    </svg>
  ),
  table: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9.5" x2="21" y2="9.5" /><line x1="9.5" y1="9.5" x2="9.5" y2="20" />
    </svg>
  ),
  coll: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M7 4h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <polyline points="13,4 13,9 18,9" /><path d="M9.5 13.5h5M9.5 16.5h3" />
    </svg>
  ),
  view: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  key: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
      <circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3M17 6l2.5 2.5M14.5 8.5 17 11" />
    </svg>
  ),
  star: (c, s, filled) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill={filled ? c : 'none'} stroke={c} strokeWidth="1.8">
      <polygon points="12,3 14.9,9.2 21.5,10 16.7,14.6 17.9,21.2 12,18 6.1,21.2 7.3,14.6 2.5,10 9.1,9.2" />
    </svg>
  ),
  plus: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.4">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  play: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24"><polygon points="6,3.5 20,12 6,20.5" fill={c} /></svg>
  ),
  stop: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill={c} /></svg>
  ),
  download: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  close: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  minus: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  panelOpen: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9.5" y1="4" x2="9.5" y2="20" />
      <polyline points="14,10 16.5,12 14,14" />
    </svg>
  ),
  panelShut: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9.5" y1="4" x2="9.5" y2="20" />
      <polyline points="6.5,10 4,12 6.5,14" />
    </svg>
  ),
  refresh: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
      <polyline points="21,4 21,10 15,10" /><polyline points="3,20 3,14 9,14" />
      <path d="M19.4 9A8 8 0 0 0 6 6.3L3 9m18 6-3 2.7A8 8 0 0 1 4.6 15" />
    </svg>
  ),
  copy: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  grid: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="9" x2="9" y2="21" />
    </svg>
  ),
  json: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <path d="M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
      <path d="M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
    </svg>
  ),
  history: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <polyline points="2.5,5 2.5,10.5 8,10.5" /><path d="M4.2 15.4a8.5 8.5 0 1 0 .5-6.4" />
      <polyline points="12,7.5 12,12.2 15.4,14" />
    </svg>
  ),
  pin: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
    </svg>
  ),
  check: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.6">
      <polyline points="20,6 9,17 4,12" />
    </svg>
  ),
  alert: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
      <circle cx="12" cy="12" r="9" /><line x1="12" y1="7.5" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.9" fill={c} />
    </svg>
  ),
  db: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <ellipse cx="12" cy="5.5" rx="8" ry="2.8" />
      <path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13" />
      <path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8" />
    </svg>
  ),
  folder: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  doc: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14,3 14,8 19,8" />
      <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="16.5" x2="13" y2="16.5" />
    </svg>
  ),
  wand: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9">
      <path d="M4 20 16 8" /><path d="M14 6l4 4" />
      <path d="M18.5 3.2 19 5l1.8.5L19 6l-.5 1.8L18 6l-1.8-.5L18 5z" fill={c} />
    </svg>
  ),
  spark: (c, s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill={c}>
      <path d="M12 2.5 13.9 9 20.5 11 13.9 13 12 19.5 10.1 13 3.5 11 10.1 9z" />
    </svg>
  ),
};

/**
 * Render an icon by name.
 * @param {string} name  key in the icon table
 * @param {string} color stroke/fill colour
 * @param {number} size  px
 * @param {boolean} [filled] only meaningful for `star`
 */
export const Icon = (name, color = C.muted, size = 14, filled = false) =>
  (SVG[name] ? SVG[name](color, size, filled) : null);
