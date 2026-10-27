import React, { createContext, useContext } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Tooltip,
} from 'chart.js';
import { Bar, Line, Pie, Doughnut, Scatter } from 'react-chartjs-2';
import {
  P, SERIES, SCATTER_SERIES_MAX, FONT, hexA,
  formatValue, formatCompact, formatLabel, chartSeries, sliceSeries, humanize, aggregate,
} from './presentationData';

// A vertical hairline under the hovered point on line / area charts, so the
// tooltip reads as a crosshair across every series at that x.
const crosshair = {
  id: 'tlCrosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length || !chart.config.options.plugins?.tlCrosshair?.enabled) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = P.axis;
    ctx.stroke();
    ctx.restore();
  },
};

// The doughnut's total, in the hole.
const centerTotal = {
  id: 'tlCenterTotal',
  afterDraw(chart) {
    const opt = chart.config.options.plugins?.tlCenterTotal;
    if (!opt?.text) return;
    const meta = chart.getDatasetMeta(0);
    const arc = meta?.data?.[0];
    if (!arc) return;
    const { ctx } = chart;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = P.ink;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(opt.text, arc.x, arc.y - 7);
    ctx.fillStyle = P.muted;
    ctx.font = `500 11px ${FONT}`;
    ctx.fillText('Total', arc.x, arc.y + 13);
    ctx.restore();
  },
};

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Filler, Tooltip, crosshair, centerTotal);

const tooltipStyle = {
  backgroundColor: P.surface,
  titleColor: P.ink,
  bodyColor: P.ink2,
  borderColor: P.border,
  borderWidth: 1,
  padding: 10,
  cornerRadius: 8,
  boxPadding: 4,
  usePointStyle: true,
  titleFont: { family: FONT, size: 12, weight: '600' },
  bodyFont: { family: FONT, size: 12 },
  caretSize: 0,
};

const tick = { color: P.muted, font: { family: FONT, size: 11 } };

function axes({ horizontal = false, stacked = false, visual, gridOnCategory = false }) {
  // A ranked list names every bar; only a time / category axis along the
  // bottom thins its labels to fit.
  const labelMax = horizontal ? 24 : 18;
  const valueAxis = {
    stacked,
    beginAtZero: true,
    border: { display: false },
    grid: { color: P.grid, drawTicks: false },
    ticks: { ...tick, padding: 8, maxTicksLimit: 6, callback: (v) => formatCompact(v, visual.format, visual.currency) },
  };
  const categoryAxis = {
    stacked,
    border: { color: P.axis },
    grid: { display: gridOnCategory, color: P.grid, drawTicks: false },
    ticks: {
      ...tick,
      padding: 6,
      autoSkip: !horizontal,
      autoSkipPadding: 12,
      maxRotation: 0,
      callback(value) {
        const label = formatLabel(this.getLabelForValue(value));
        return label.length > labelMax ? `${label.slice(0, labelMax - 1)}…` : label;
      },
    },
  };
  return horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis };
}

function baseOptions({ visual, animate, indexMode = true }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: animate ? { duration: 450, easing: 'easeOutQuart' } : false,
    interaction: indexMode ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
    layout: { padding: { top: 4, right: 8 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipStyle,
        callbacks: {
          title: (items) => (items[0] ? formatLabel(items[0].label) : ''),
          label: (item) => ` ${item.dataset.label}: ${formatValue(item.parsed.y ?? item.parsed, visual.format, visual.currency)}`,
        },
      },
    },
  };
}

const seriesLabel = (s, visual) => (visual.series || s.other ? s.name : humanize(s.name));

// Presentation-wide series colours (seriesColorMap), so a value keeps its colour
// from chart to chart. Charts outside a presentation fall back to their order.
export const SeriesColors = createContext(null);
const colorFor = (s, i, colors) => {
  if (s.other) return P.other;
  const slot = colors && colors.has(s.name) ? colors.get(s.name) : i;
  return SERIES[slot % SERIES.length];
};

// ── Legend: HTML, above the plot, only when there is more than one series ──

const Legend = ({ items }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', margin: '2px 0 10px' }}>
    {items.map((it) => (
      <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: P.ink2 }}>
        <span style={{
          width: it.line ? 14 : 9, height: it.line ? 2.5 : 9,
          borderRadius: it.line ? 2 : 3, background: it.color, flexShrink: 0,
        }} />
        {formatLabel(it.label)}
      </span>
    ))}
  </div>
);

// ── Charts ────────────────────────────────────────────────────────────────

function BarChart({ visual, dataset, animate, colors }) {
  const horizontal = visual.type === 'hbar';
  const stacked = visual.type === 'stacked_bar';
  const { labels, series } = chartSeries(visual, dataset);
  const data = {
    labels,
    datasets: series.map((s, i) => ({
      label: seriesLabel(s, visual),
      data: s.values,
      backgroundColor: colorFor(s, i, colors),
      hoverBackgroundColor: hexA(colorFor(s, i, colors), 0.85),
      maxBarThickness: 24,
      // Rounded at the data end only; square on the baseline. A stack rounds
      // just its top segment, and a surface-coloured edge keeps a 2px gap
      // between segments instead of an outline.
      borderRadius: stacked ? (i === series.length - 1 ? 4 : 0) : 4,
      borderSkipped: 'start',
      borderWidth: stacked ? { top: 2 } : 0,
      borderColor: P.surface,
      categoryPercentage: 0.72,
      barPercentage: series.length > 1 && !stacked ? 0.92 : 0.86,
    })),
  };
  const options = {
    ...baseOptions({ visual, animate }),
    indexAxis: horizontal ? 'y' : 'x',
    scales: axes({ horizontal, stacked, visual }),
  };
  if (horizontal) {
    options.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${formatValue(item.parsed.x, visual.format, visual.currency)}`;
  }
  return {
    legend: series.length > 1 ? series.map((s, i) => ({ label: seriesLabel(s, visual), color: colorFor(s, i, colors) })) : null,
    node: <Bar data={data} options={options} />,
  };
}

function LineChart({ visual, dataset, animate, colors }) {
  const area = visual.type === 'area';
  const { labels, series } = chartSeries(visual, dataset);
  const data = {
    labels,
    datasets: series.map((s, i) => {
      const color = colorFor(s, i, colors);
      return {
        label: seriesLabel(s, visual),
        data: s.values,
        borderColor: color,
        backgroundColor: area ? hexA(color, series.length > 1 ? 0.08 : 0.12) : color,
        fill: area ? 'origin' : false,
        borderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        spanGaps: true,
        // No dot on every point — the hovered one gets a ringed marker.
        pointRadius: labels.length <= 12 ? 3 : 0,
        pointBackgroundColor: color,
        pointBorderColor: P.surface,
        pointBorderWidth: 2,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: P.surface,
        pointHitRadius: 12,
      };
    }),
  };
  const options = {
    ...baseOptions({ visual, animate }),
    scales: axes({ visual }),
  };
  options.plugins.tlCrosshair = { enabled: true };
  return {
    legend: series.length > 1 ? series.map((s, i) => ({ label: seriesLabel(s, visual), color: colorFor(s, i, colors), line: true })) : null,
    node: <Line data={data} options={options} />,
  };
}

function ArcChart({ visual, dataset, animate }) {
  const doughnut = visual.type === 'doughnut';
  const slices = sliceSeries(visual, dataset);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const colors = slices.map((s, i) => (s.other ? P.other : SERIES[i % SERIES.length]));
  const data = {
    labels: slices.map((s) => formatLabel(s.label)),
    datasets: [{
      data: slices.map((s) => s.value),
      backgroundColor: colors,
      borderColor: P.surface,
      borderWidth: 2,
      hoverOffset: 6,
    }],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: animate ? { duration: 450, easing: 'easeOutQuart' } : false,
    cutout: doughnut ? '64%' : 0,
    layout: { padding: 8 },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipStyle,
        callbacks: {
          label: (item) => ` ${item.label}: ${formatValue(item.parsed, visual.format, visual.currency)} (${total ? Math.round((item.parsed / total) * 100) : 0}%)`,
        },
      },
      tlCenterTotal: doughnut ? { text: formatCompact(total, visual.format, visual.currency) } : null,
    },
  };
  const Comp = doughnut ? Doughnut : Pie;
  // Pie / doughnut carry their legend beside the plot, with each slice's share.
  return {
    legend: null,
    node: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, height: '100%' }}>
        <div style={{ flex: '1 1 55%', minWidth: 0, height: '100%', position: 'relative' }}>
          <Comp data={data} options={options} />
        </div>
        <div style={{ flex: '1 1 45%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {slices.map((s, i) => (
            <div key={`${s.label}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: colors[i], flexShrink: 0 }} />
              <span style={{ color: P.ink2, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {formatLabel(s.label)}
              </span>
              <span style={{ color: P.ink, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {total ? `${Math.round((s.value / total) * 100)}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
    ),
  };
}

function ScatterChart({ visual, dataset, animate, colors }) {
  const rows = dataset?.rows || [];
  const yKey = visual.y[0];
  const groups = new Map();
  for (const r of rows) {
    if (typeof r[visual.x] !== 'number' || typeof r[yKey] !== 'number') continue;
    const g = visual.series ? String(r[visual.series] ?? '(blank)') : humanize(yKey);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ x: r[visual.x], y: r[yKey] });
  }
  const names = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
  const kept = names.slice(0, SCATTER_SERIES_MAX);
  const series = kept.map((n) => ({ name: n, points: groups.get(n) }));
  const rest = names.slice(SCATTER_SERIES_MAX).flatMap((n) => groups.get(n));
  if (rest.length) series.push({ name: 'Other', points: rest, other: true });

  const data = {
    datasets: series.map((s, i) => ({
      label: s.name,
      data: s.points,
      backgroundColor: hexA(colorFor(s, i, colors), 0.85),
      borderColor: P.surface,
      borderWidth: 1.5,
      pointRadius: 4.5,
      pointHoverRadius: 6,
      pointHitRadius: 8,
    })),
  };
  const options = {
    ...baseOptions({ visual, animate, indexMode: false }),
    scales: {
      x: {
        type: 'linear',
        border: { color: P.axis },
        grid: { color: P.grid, drawTicks: false },
        ticks: { ...tick, padding: 6, maxTicksLimit: 7, callback: (v) => formatCompact(v) },
        title: { display: true, text: humanize(visual.x), color: P.muted, font: { family: FONT, size: 11 } },
      },
      y: {
        border: { display: false },
        grid: { color: P.grid, drawTicks: false },
        ticks: { ...tick, padding: 8, maxTicksLimit: 6, callback: (v) => formatCompact(v, visual.format, visual.currency) },
        title: { display: true, text: humanize(yKey), color: P.muted, font: { family: FONT, size: 11 } },
      },
    },
  };
  options.plugins.tooltip.callbacks = {
    title: (items) => items[0]?.dataset.label || '',
    label: (item) => ` ${humanize(visual.x)} ${formatCompact(item.parsed.x)} · ${humanize(yKey)} ${formatValue(item.parsed.y, visual.format, visual.currency)}`,
  };
  return {
    legend: series.length > 1 ? series.map((s, i) => ({ label: s.name, color: colorFor(s, i, colors) })) : null,
    node: <Scatter data={data} options={options} />,
  };
}

const TABLE_RENDER_ROWS = 500;

// A table's columns are formatted one by one: `formats` names a column's format
// outright; otherwise the visual's format applies only when it has a single
// measure, so units next to revenue are not printed as money.
function columnFormat(visual, name) {
  if (visual.formats && visual.formats[name]) return visual.formats[name];
  return visual.y.length === 1 && visual.y[0] === name ? visual.format : 'number';
}

export function DataTable({ visual, dataset, maxHeight = 320 }) {
  const rows = dataset?.rows || [];
  const cols = visual.type === 'table'
    ? (dataset?.columns || [])
    : [visual.x, visual.series, ...visual.y].filter(Boolean)
      .map((name) => (dataset?.columns || []).find((c) => c.name === name) || { name, type: 'string' });
  const isNum = (c) => c.type === 'number';
  const shown = rows.slice(0, TABLE_RENDER_ROWS);
  return (
    <div style={{ maxHeight, overflow: 'auto', border: `1px solid ${P.border}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: FONT }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.name} style={{
                position: 'sticky', top: 0, background: '#f7f8fa', zIndex: 1,
                textAlign: isNum(c) ? 'right' : 'left', padding: '8px 12px',
                color: P.ink2, fontWeight: 600, borderBottom: `1px solid ${P.border}`, whiteSpace: 'nowrap',
              }}>
                {humanize(c.name)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? '#fafbfc' : P.surface }}>
              {cols.map((c) => (
                <td key={c.name} style={{
                  padding: '7px 12px', borderBottom: `1px solid ${P.grid}`,
                  textAlign: isNum(c) ? 'right' : 'left', color: P.ink,
                  fontVariantNumeric: isNum(c) ? 'tabular-nums' : 'normal', whiteSpace: 'nowrap',
                }}>
                  {isNum(c) ? formatValue(r[c.name], columnFormat(visual, c.name), visual.currency) : formatLabel(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: P.muted }}>
          Showing {shown.length} of {rows.length} rows
        </div>
      )}
    </div>
  );
}

const CHART_HEIGHT = { full: 300, half: 260, third: 240 };

/** One dashboard tile: title, subtitle, legend and the chart (or table). */
export function ChartCard({ visual, dataset, animate = true, height = null }) {
  const shared = useContext(SeriesColors);
  // Only a `series` column names entities; wide y columns keep their own order.
  // A scatter puts every pair of series side by side, and only the first three
  // palette slots stay distinguishable that way, so it keeps its own slots.
  const colors = visual.series && visual.type !== 'scatter' ? shared : null;
  const h = height || CHART_HEIGHT[visual.width] || 260;
  const empty = !dataset || !dataset.rows || dataset.rows.length === 0;
  let body = null;
  let legend = null;
  if (!empty) {
    if (visual.type === 'table') body = <DataTable visual={visual} dataset={dataset} maxHeight={typeof h === 'number' ? h + 24 : h} />;
    else {
      const render = ({
        bar: BarChart, hbar: BarChart, stacked_bar: BarChart,
        line: LineChart, area: LineChart,
        pie: ArcChart, doughnut: ArcChart,
        scatter: ScatterChart,
      })[visual.type] || BarChart;
      const out = render({ visual, dataset, animate, colors });
      legend = out.legend;
      body = <div style={{ height: h, position: 'relative' }}>{out.node}</div>;
    }
  }
  return (
    <div className="tl-pres-card tl-pres-chart" style={{
      background: P.surface, border: `1px solid ${P.border}`, borderRadius: 12,
      padding: '16px 18px 14px', minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column',
      boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: P.ink, lineHeight: 1.35 }}>{visual.title}</div>
      {visual.subtitle && <div style={{ fontSize: 12, color: P.muted, marginTop: 2 }}>{visual.subtitle}</div>}
      <div style={{ height: 12 }} />
      {legend && <Legend items={legend} />}
      {empty ? (
        <div style={{
          height: h, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: P.muted, fontSize: 12, background: '#fafbfc', borderRadius: 8,
        }}>
          No data came back for this view.
        </div>
      ) : body}
    </div>
  );
}

/**
 * A headline number, computed from its dataset. `hero` marks the one lead
 * figure of the view: tinted, larger, with an accent rule.
 */
export function KpiTile({ kpi, datasets, large = false, hero = false }) {
  const ds = datasets?.[kpi.dataset];
  const value = ds ? aggregate(ds.rows || [], kpi.column, kpi.agg) : null;
  return (
    <div className="tl-pres-card" style={{
      position: 'relative', overflow: 'hidden',
      background: hero ? P.accentWash : P.surface,
      border: `1px solid ${hero ? '#cfe0f6' : P.border}`, borderRadius: 12,
      padding: large ? '20px 22px' : '16px 18px 15px', minWidth: 0,
      boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
    }}>
      {hero && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: P.accent }} />}
      <div style={{
        fontSize: 11, color: hero ? P.accent : P.muted, fontWeight: 600, letterSpacing: '0.05em',
        textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {kpi.label}
      </div>
      <div style={{
        fontSize: large ? 34 : (hero ? 32 : 28), fontWeight: 650, color: P.ink,
        letterSpacing: '-0.02em', marginTop: 8, lineHeight: 1.1,
      }}>
        {value == null ? '—' : formatCompact(value, kpi.format, kpi.currency)}
      </div>
      {kpi.note && <div style={{ fontSize: 11.5, color: P.ink2, marginTop: 7 }}>{kpi.note}</div>}
    </div>
  );
}
