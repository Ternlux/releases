import React, { useState } from 'react';
import PresentationViewer from './PresentationViewer';
import { P, FONT, SERIES, aggregate, formatCompact, visualCount } from './presentationData';

// The presentation as it sits in a chat bubble: title, a few headline numbers,
// and the button that opens the full-screen dashboard.
export default function PresentationCard({ presentation }) {
  const [open, setOpen] = useState(false);
  if (!presentation || !Array.isArray(presentation.sections)) return null;
  const datasets = presentation.datasets || {};
  const kpis = (presentation.kpis || []).slice(0, 3);
  const sections = presentation.sections.length;
  const visuals = visualCount(presentation);

  return (
    <div style={{
      marginTop: 10, background: P.surface, border: `1px solid ${P.border}`, borderRadius: 10,
      overflow: 'hidden', fontFamily: FONT, boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
    }}>
      {/* A small stand-in for the dashboard: one bar per section, in series order. */}
      <div style={{
        height: 54, background: 'linear-gradient(180deg, #f5f8fd 0%, #eef3fb 100%)',
        display: 'flex', alignItems: 'flex-end', gap: 5, padding: '0 14px 10px',
        borderBottom: `1px solid ${P.border}`,
      }}>
        {Array.from({ length: Math.min(Math.max(sections, 3), 12) }, (_, i) => (
          <span key={i} style={{
            width: 10, borderRadius: '3px 3px 0 0',
            height: 12 + ((i * 37) % 26), background: SERIES[i % 3], opacity: 0.85,
          }} />
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: P.accent, textTransform: 'uppercase', paddingBottom: 2 }}>
          Presentation
        </span>
      </div>

      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: P.ink, lineHeight: 1.35 }}>{presentation.title}</div>
        {presentation.subtitle && (
          <div style={{ fontSize: 12, color: P.muted, marginTop: 2 }}>{presentation.subtitle}</div>
        )}

        {kpis.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kpis.length}, minmax(0, 1fr))`, gap: 8, marginTop: 12 }}>
            {kpis.map((k, i) => {
              const ds = datasets[k.dataset];
              const v = ds ? aggregate(ds.rows || [], k.column, k.agg) : null;
              return (
                <div key={i} style={{ background: '#f7f8fa', borderRadius: 8, padding: '8px 10px', minWidth: 0 }}>
                  <div style={{ fontSize: 10.5, color: P.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: P.ink, marginTop: 2 }}>
                    {v == null ? '—' : formatCompact(v, k.format, k.currency)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <span style={{ fontSize: 11.5, color: P.muted, flex: 1 }}>
            {sections} section{sections === 1 ? '' : 's'} · {visuals} visual{visuals === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={() => setOpen(true)} style={{
            height: 30, padding: '0 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
            background: P.accent, color: '#fff', fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
          }}>
            Open presentation
          </button>
        </div>
      </div>

      {open && <PresentationViewer presentation={presentation} onClose={() => setOpen(false)} />}
    </div>
  );
}
