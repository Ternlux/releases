import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChartCard, KpiTile, SeriesColors } from './PresentationChart';
import { P, FONT, visualCount, seriesColorMap } from './presentationData';
import { ReactComponent as TernluxLogoSvg } from './ternlux-logo.svg';

// Above the chat panel (CHAT_Z 1500) and every modal under it.
const VIEWER_Z = 2400;
// The width the dashboard is laid out at while it prints: A4 landscape less the
// 0.4in margins presentation:export-pdf asks for, at 96 dpi. Charts are re-laid
// out at this width before printing so their canvases fit the page.
const PRINT_WIDTH = 1040;

const STYLES = `
.tl-pres-root, .tl-pres-root * { box-sizing: border-box; }
.tl-pres-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
.tl-span-full { grid-column: span 12; }
.tl-span-half { grid-column: span 6; }
.tl-span-third { grid-column: span 4; }
.tl-pres-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.tl-pres-story { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 28px; }
.tl-pres-slide-body { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(0, 2.4fr); gap: 28px; }
.tl-pres-btn { transition: background 120ms ease, border-color 120ms ease; }
.tl-pres-btn:hover:not(:disabled) { background: #f1f3f6; }
.tl-pres-btn-primary:hover:not(:disabled) { background: #1f6bc6 !important; }
.tl-pres-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 36px; align-items: start; }
.tl-pres-toc { position: sticky; top: 28px; }
.tl-pres-toc-item { transition: background 120ms ease, color 120ms ease; }
.tl-pres-toc-item:hover { background: #eaeef4; }
.tl-pres-chart { transition: box-shadow 160ms ease, border-color 160ms ease; }
.tl-pres-chart:hover { box-shadow: 0 6px 20px rgba(16, 24, 40, 0.07) !important; border-color: ${P.borderStrong} !important; }
.tl-print-only { display: none; }
@media (max-width: 1180px) {
  .tl-pres-layout { grid-template-columns: minmax(0, 1fr); }
  .tl-pres-toc { display: none; }
}
@media (max-width: 980px) {
  .tl-span-half, .tl-span-third { grid-column: span 12; }
  .tl-pres-story, .tl-pres-slide-body { grid-template-columns: minmax(0, 1fr); }
}
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(.tl-pres-root) { display: none !important; }
  .tl-pres-root { position: static !important; inset: auto !important; height: auto !important;
    overflow: visible !important; background: #fff !important; display: block !important; }
  .tl-pres-scroll { overflow: visible !important; height: auto !important; }
  .tl-no-print, .tl-pres-toc { display: none !important; }
  .tl-print-only { display: block !important; }
  .tl-pres-layout { grid-template-columns: minmax(0, 1fr) !important; }
  .tl-pres-card { break-inside: avoid; box-shadow: none !important; }
  .tl-pres-section { break-before: page; }
  .tl-span-half { grid-column: span 6 !important; }
  .tl-span-third { grid-column: span 4 !important; }
  .tl-pres-story { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr) !important; }
}
`;

const pad2 = (n) => String(n).padStart(2, '0');

// ── Text: paragraphs split on blank lines, **bold** inline ─────────────────

const Inline = ({ text }) => (
  <>
    {String(text).split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={i} style={{ color: P.ink, fontWeight: 600 }}>{part.slice(2, -2)}</strong>
        : <React.Fragment key={i}>{part}</React.Fragment>
    ))}
  </>
);

const Narrative = ({ text, size = 14 }) => (
  <div style={{ fontSize: size, lineHeight: 1.7, color: P.ink2 }}>
    {String(text || '').split(/\n\s*\n/).filter((p) => p.trim()).map((p, i) => (
      <p key={i} style={{ margin: i ? '10px 0 0' : 0 }}><Inline text={p.trim()} /></p>
    ))}
  </div>
);

const Insights = ({ items, size = 13 }) => (
  <div>
    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: P.accent, marginBottom: 12 }}>
      Key insights
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {items.map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 11, fontSize: size, lineHeight: 1.55, color: P.ink }}>
          <span style={{
            width: 20, height: 20, borderRadius: 10, background: P.surface, color: P.accent,
            border: '1px solid #cfe0f6', fontSize: 11, fontWeight: 650, flexShrink: 0, marginTop: 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontVariantNumeric: 'tabular-nums',
          }}>{i + 1}</span>
          <span><Inline text={t} /></span>
        </div>
      ))}
    </div>
  </div>
);

// The Ternlux wordmark (dagflux/images/Ternlux-logo-with-name.svg, 2680×632),
// inlined by the SVG loader so it also prints.
const TernluxLogo = ({ height = 30 }) => (
  <TernluxLogoSvg role="img" aria-label="Ternlux" height={height} width={Math.round((height * 2680) / 632)}
    style={{ display: 'block', flexShrink: 0 }} />
);

// ── Buttons & icons ───────────────────────────────────────────────────────

const Icon = ({ d, size = 16, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);
const ICONS = {
  play: <polygon points="6 4 20 12 6 20 6 4" />,
  pdf: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  left: <polyline points="15 18 9 12 15 6" />,
  right: <polyline points="9 18 15 12 9 6" />,
};

const Btn = ({ children, onClick, primary = false, disabled = false, title }) => (
  <button
    type="button" title={title} onClick={onClick} disabled={disabled}
    className={`tl-pres-btn${primary ? ' tl-pres-btn-primary' : ''}`}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px',
      borderRadius: 8, fontFamily: FONT, fontSize: 13, fontWeight: 500, cursor: disabled ? 'default' : 'pointer',
      border: `1px solid ${primary ? P.accent : P.borderStrong}`,
      background: primary ? P.accent : P.surface, color: primary ? '#fff' : P.ink,
      opacity: disabled ? 0.6 : 1,
    }}
  >
    {children}
  </button>
);

// ── Dashboard ─────────────────────────────────────────────────────────────

const sectionId = (i) => `tl-pres-section-${i}`;
const COVER_ID = 'tl-pres-cover';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
};

const Eyebrow = ({ children, color = P.muted }) => (
  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color }}>{children}</div>
);

const MetaChip = ({ children }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', height: 26, padding: '0 10px', borderRadius: 999,
    background: '#f2f4f7', color: P.ink2, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
  }}>{children}</span>
);

// Which section the reader is in: the last one whose top has scrolled past
// the upper third of the viewport. -1 is the cover.
function useActiveSection(scrollRef, count) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      const line = el.scrollTop + el.clientHeight / 3;
      let current = -1;
      for (let i = 0; i < count; i++) {
        const sec = el.querySelector(`#${sectionId(i)}`);
        if (sec && sec.offsetTop <= line) current = i;
      }
      setActive(current);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, count]);
  return active;
}

function Contents({ sections, active, onJump }) {
  const item = (key, label, num, isActive, target) => (
    <button key={key} type="button" className="tl-pres-toc-item" onClick={() => onJump(target)} style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left',
      padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: FONT,
      background: isActive ? P.accentWash : 'transparent', color: isActive ? P.accent : P.ink2,
      fontSize: 12.5, lineHeight: 1.4, fontWeight: isActive ? 600 : 500,
    }}>
      <span style={{ width: 18, flexShrink: 0, color: isActive ? P.accent : P.muted, fontVariantNumeric: 'tabular-nums' }}>{num}</span>
      <span style={{ minWidth: 0 }}>{label}</span>
    </button>
  );
  return (
    <nav className="tl-pres-toc tl-no-print" aria-label="Contents">
      <div style={{ padding: '0 10px 10px' }}><Eyebrow>Contents</Eyebrow></div>
      {item('cover', 'Overview', '—', active < 0, -1)}
      {sections.map((s, i) => item(i, s.heading || `Section ${i + 1}`, pad2(i + 1), active === i, i))}
    </nav>
  );
}

function Dashboard({ presentation, animate, printing = false, scrollRef }) {
  const { sections = [], kpis = [], datasets = {} } = presentation;
  const created = formatDate(presentation.createdAt);
  const active = useActiveSection(scrollRef, sections.length);
  const datasetCount = Object.keys(datasets).length;
  const jump = (i) => {
    const el = scrollRef.current?.querySelector(`#${i < 0 ? COVER_ID : sectionId(i)}`);
    if (el) scrollRef.current.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: 'smooth' });
  };

  return (
    // While printing, the contents rail leaves the layout before the charts are
    // re-measured, so they are sized for the full page width they print at.
    <div className="tl-pres-layout" style={printing ? { gridTemplateColumns: 'minmax(0, 1fr)' } : null}>
      {!printing && <Contents sections={sections} active={active} onJump={jump} />}

      <div style={{ minWidth: 0 }}>
        {/* The PDF has no top bar, so its first page carries the logo itself. */}
        <div className="tl-print-only" style={{ marginBottom: 18 }}><TernluxLogo height={32} /></div>

        {/* Cover: title, scope, executive summary */}
        <div id={COVER_ID} className="tl-pres-card" style={{
          position: 'relative', overflow: 'hidden', background: P.surface,
          border: `1px solid ${P.border}`, borderRadius: 16, padding: '30px 34px 28px',
          boxShadow: '0 1px 3px rgba(16, 24, 40, 0.05)',
        }}>
          <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 4, background: `linear-gradient(90deg, ${P.accent}, #86b6ef)` }} />
          <Eyebrow color={P.accent}>Report{created ? ` · ${created}` : ''}</Eyebrow>
          <h1 style={{ margin: '10px 0 0', fontSize: 32, lineHeight: 1.18, fontWeight: 700, color: P.ink, letterSpacing: '-0.025em' }}>
            {presentation.title}
          </h1>
          {presentation.subtitle && (
            <div style={{ marginTop: 8, fontSize: 15, color: P.ink2, lineHeight: 1.5 }}>{presentation.subtitle}</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            <MetaChip>{plural(sections.length, 'section')}</MetaChip>
            <MetaChip>{plural(visualCount(presentation), 'visual')}</MetaChip>
            <MetaChip>{plural(datasetCount, 'dataset')}</MetaChip>
          </div>
          {presentation.summary && (
            <div style={{ marginTop: 24, paddingTop: 22, borderTop: `1px solid ${P.border}` }}>
              <div style={{ marginBottom: 10 }}><Eyebrow>Executive summary</Eyebrow></div>
              <Narrative text={presentation.summary} size={15} />
            </div>
          )}
        </div>

        {kpis.length > 0 && (
          <div className="tl-pres-kpis" style={{ marginTop: 16 }}>
            {kpis.map((k, i) => <KpiTile key={i} kpi={k} datasets={datasets} hero={i === 0} />)}
          </div>
        )}

        {sections.map((s, i) => (
          <section key={i} id={sectionId(i)} className="tl-pres-section" style={{ marginTop: 48 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              <span style={{
                width: 34, height: 34, borderRadius: 9, background: P.accent, color: '#fff', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
              }}>{pad2(i + 1)}</span>
              <h2 style={{ margin: 0, fontSize: 21, fontWeight: 650, color: P.ink, letterSpacing: '-0.015em', lineHeight: 1.3, flex: 1, minWidth: 0 }}>
                {s.heading}
              </h2>
            </div>

            {(s.narrative || s.insights.length > 0) && (
              <div className="tl-pres-card" style={{
                background: P.surface, border: `1px solid ${P.border}`, borderRadius: 14,
                padding: 8, marginBottom: 16, boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
              }}>
                <div className="tl-pres-story" style={{ gap: 8, ...(!s.narrative || !s.insights.length ? { gridTemplateColumns: 'minmax(0, 1fr)' } : null) }}>
                  {s.narrative && <div style={{ padding: '14px 16px' }}><Narrative text={s.narrative} /></div>}
                  {s.insights.length > 0 && (
                    <div style={{ background: '#f5f9fe', borderRadius: 10, padding: '16px 18px' }}>
                      <Insights items={s.insights} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {s.visuals.length > 0 && (
              <div className="tl-pres-grid">
                {s.visuals.map((v, j) => (
                  <div key={j} className={`tl-span-${v.width}`} style={{ minWidth: 0, display: 'flex' }}>
                    <ChartCard visual={v} dataset={datasets[v.dataset]} animate={animate} />
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}

        <div style={{
          marginTop: 56, paddingTop: 18, borderTop: `1px solid ${P.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 11.5, color: P.muted }}>
            Computed from {plural(datasetCount, 'dataset')} by an analysis you approved{created ? ` · ${created}` : ''}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: P.muted }}>
            Made with <TernluxLogo height={18} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Present mode: the cover, then one section per slide ───────────────────

function Slide({ presentation, index }) {
  const { sections = [], kpis = [], datasets = {} } = presentation;
  if (index === 0) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', width: '100%', paddingTop: '6vh' }}>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: P.accent }}>Report</div>
        <h1 style={{ margin: '12px 0 0', fontSize: 44, lineHeight: 1.15, fontWeight: 650, color: P.ink, letterSpacing: '-0.025em' }}>
          {presentation.title}
        </h1>
        {presentation.subtitle && <div style={{ marginTop: 10, fontSize: 18, color: P.ink2 }}>{presentation.subtitle}</div>}
        {presentation.summary && (
          <div style={{ marginTop: 28, maxWidth: 860 }}><Narrative text={presentation.summary} size={17} /></div>
        )}
        {kpis.length > 0 && (
          <div className="tl-pres-kpis" style={{ marginTop: 36 }}>
            {kpis.map((k, i) => <KpiTile key={i} kpi={k} datasets={datasets} large />)}
          </div>
        )}
      </div>
    );
  }

  const s = sections[index - 1];
  const n = s.visuals.length;
  const chartHeight = n <= 1 ? 'calc(100vh - 330px)' : n === 2 ? 'calc(100vh - 360px)' : 'calc(50vh - 200px)';
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 22 }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: P.accent, fontVariantNumeric: 'tabular-nums' }}>{pad2(index)}</span>
        <h2 style={{ margin: 0, fontSize: 30, fontWeight: 650, color: P.ink, letterSpacing: '-0.02em', lineHeight: 1.2 }}>{s.heading}</h2>
      </div>
      <div className="tl-pres-slide-body" style={{ flex: 1, minHeight: 0, ...(n === 0 ? { gridTemplateColumns: 'minmax(0, 1fr)', maxWidth: 900 } : null) }}>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {s.narrative && <Narrative text={s.narrative} size={15.5} />}
          {s.insights.length > 0 && <Insights items={s.insights} size={14.5} />}
        </div>
        {n > 0 && (
          <div style={{
            minWidth: 0, display: 'grid', gap: 16, alignContent: 'start',
            gridTemplateColumns: n === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
          }}>
            {s.visuals.map((v, j) => (
              <div key={j} style={{ minWidth: 0, gridColumn: n === 3 && j === 2 ? 'span 2' : undefined }}>
                <ChartCard visual={v} dataset={datasets[v.dataset]} height={chartHeight} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PresentMode({ presentation, onExit }) {
  const total = 1 + (presentation.sections || []).length;
  const [index, setIndex] = useState(0);
  const go = useCallback((d) => setIndex((i) => Math.max(0, Math.min(total - 1, i + d))), [total]);

  useEffect(() => {
    const onKey = (e) => {
      const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key);
      const prev = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key);
      if (!next && !prev && !['Home', 'End', 'Escape'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (next) go(1);
      else if (prev) go(-1);
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(total - 1);
      else onExit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, total, onExit]);

  // Present full-screen. Leaving full screen from the OS (or Esc, which the
  // browser keeps for itself while full screen) leaves present mode too.
  useEffect(() => {
    const el = document.documentElement;
    try { if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (_) {}
    const onChange = () => { if (!document.fullscreenElement) onExit(); };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (_) {}
    };
  }, [onExit]);

  return (
    // Its own layer above the dashboard: the dashboard's sticky table headers
    // carry a z-index and would otherwise paint through the slides.
    <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: P.page, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '22px 56px 0' }}>
        <TernluxLogo height={30} />
        <span style={{ fontSize: 12, color: P.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {presentation.title}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '22px 56px 16px', overflow: 'auto', display: 'flex' }}>
        <Slide key={index} presentation={presentation} index={index} />
      </div>
      <div style={{ height: 3, background: P.border }}>
        <div style={{ height: '100%', width: `${((index + 1) / total) * 100}%`, background: P.accent, transition: 'width 200ms ease' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: P.surface }}>
        <div style={{ fontSize: 12.5, color: P.ink2, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {presentation.title}
        </div>
        <Btn onClick={() => go(-1)} disabled={index === 0} title="Previous (←)"><Icon d={ICONS.left} /></Btn>
        <span style={{ fontSize: 12.5, color: P.ink2, fontVariantNumeric: 'tabular-nums', minWidth: 52, textAlign: 'center' }}>
          {index + 1} / {total}
        </span>
        <Btn onClick={() => go(1)} disabled={index === total - 1} title="Next (→)"><Icon d={ICONS.right} /></Btn>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
          <Btn onClick={onExit} title="Exit (Esc)"><Icon d={ICONS.x} size={14} /> Exit</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Viewer shell ──────────────────────────────────────────────────────────

export default function PresentationViewer({ presentation, onClose }) {
  const [presenting, setPresenting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [exportNote, setExportNote] = useState(null);
  const scrollRef = useRef(null);
  const exitPresent = useCallback(() => setPresenting(false), []);
  const colors = useMemo(() => seriesColorMap(presentation), [presentation]);

  useEffect(() => {
    if (presenting) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [presenting, onClose]);

  const exportPdf = async () => {
    const api = window.electronAPI?.chat?.exportPresentationPdf;
    if (!api) { setExportNote('PDF export is only available in the desktop app.'); return; }
    setExportNote(null);
    // Re-lay the dashboard out at page width without animation, give Chart.js a
    // moment to resize its canvases, then print.
    setPrinting(true);
    await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await api({ title: presentation.title });
      if (res?.success) setExportNote(`Saved to ${res.filePath}`);
      else if (!res?.canceled) setExportNote(`Export failed: ${res?.message || 'unknown error'}`);
    } catch (err) {
      setExportNote(`Export failed: ${err.message || String(err)}`);
    } finally {
      setPrinting(false);
    }
  };

  return createPortal(
    <SeriesColors.Provider value={colors}>
    <div className="tl-pres-root" style={{
      position: 'fixed', inset: 0, zIndex: VIEWER_Z, background: P.page,
      display: 'flex', flexDirection: 'column', fontFamily: FONT, color: P.ink,
    }}>
      <style>{STYLES}</style>

      <div className="tl-no-print" style={{
        height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 20px', background: P.surface, borderBottom: `1px solid ${P.border}`,
      }}>
        <TernluxLogo height={30} />
        <span style={{ width: 1, height: 26, background: P.border, flexShrink: 0, margin: '0 4px' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {presentation.title}
          </div>
          {exportNote && <div style={{ fontSize: 11.5, color: P.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{exportNote}</div>}
        </div>
        <Btn primary onClick={() => setPresenting(true)} title="Present one section at a time">
          <Icon d={ICONS.play} size={13} /> Present
        </Btn>
        <Btn onClick={exportPdf} disabled={printing}>
          <Icon d={ICONS.pdf} size={15} /> {printing ? 'Exporting…' : 'Export PDF'}
        </Btn>
        <button type="button" onClick={onClose} title="Close (Esc)" className="tl-pres-btn" style={{
          width: 34, height: 34, borderRadius: 8, border: 'none', background: 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: P.ink2,
        }}>
          <Icon d={ICONS.x} size={18} />
        </button>
      </div>

      <div ref={scrollRef} className="tl-pres-scroll" aria-hidden={presenting || undefined} style={{
        flex: 1, minHeight: 0, overflow: 'auto', position: 'relative',
        // Hidden, not unmounted, while presenting: the dashboard keeps its
        // layout and scroll position for when present mode ends.
        visibility: presenting ? 'hidden' : 'visible',
      }}>
        <div className="tl-pres-page" style={{
          margin: '0 auto', padding: printing ? 0 : '28px 36px 48px',
          width: printing ? PRINT_WIDTH : '100%', maxWidth: printing ? PRINT_WIDTH : 1480,
        }}>
          <Dashboard presentation={presentation} animate={!printing} printing={printing} scrollRef={scrollRef} />
        </div>
      </div>

      {presenting && <PresentMode presentation={presentation} onExit={exitPresent} />}
    </div>
    </SeriesColors.Provider>,
    document.body,
  );
}
