// Theme and data shaping for the presentation dashboard (build_presentation).
//
// Colors are the dataviz reference palette, light mode (the app is light-only).
// The categorical order is the colour-blind-safety mechanism, so series are
// always assigned in this order and never cycled: past SERIES_MAX the tail folds
// into "Other".

export const P = {
  page: '#f3f5f8',
  surface: '#ffffff',
  border: '#e3e6eb',
  borderStrong: '#d3d8df',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#eceef1',
  axis: '#c9ccd2',
  accent: '#2a78d6',
  accentWash: '#eef4fc',
  up: '#006300',
  down: '#d03b3b',
  other: '#b9b8b1',
};

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const SERIES_MAX = 6;
// Scatter puts every pair of series on screen together; only the first three
// slots stay distinguishable that way.
export const SCATTER_SERIES_MAX = 3;

export const FONT = "'Inter', -apple-system, 'Segoe UI', sans-serif";

export const hexA = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// ── Number & date formatting ──────────────────────────────────────────────

const nf = (opts) => {
  try { return new Intl.NumberFormat('en-US', opts); } catch (_) { return new Intl.NumberFormat('en-US'); }
};

/** Full value, for tooltips and tables. */
export function formatValue(v, format = 'number', currency = null) {
  if (v == null || v === '') return '—';
  if (typeof v !== 'number') return String(v);
  if (format === 'percent') return `${nf({ maximumFractionDigits: 1 }).format(v)}%`;
  if (format === 'currency') {
    const digits = Number.isInteger(v) || Math.abs(v) >= 100 ? 0 : 2;
    return nf({ style: 'currency', currency: currency || 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  }
  if (format === 'integer') return nf({ maximumFractionDigits: 0 }).format(v);
  return nf({ maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
}

/** Compact value, for axis ticks and KPI tiles: 12.9K, $4.2M. */
export function formatCompact(v, format = 'number', currency = null) {
  if (typeof v !== 'number') return formatValue(v, format, currency);
  if (Math.abs(v) < 10000) return formatValue(v, format, currency);
  if (format === 'percent') return `${nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v)}%`;
  if (format === 'currency') {
    return nf({ style: 'currency', currency: currency || 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v);
  }
  return nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-03" → "Mar 2025", "2025-03-14…" → "Mar 14, 2025"; anything else as-is. */
export function formatLabel(v) {
  if (typeof v !== 'string') return v == null ? '—' : String(v);
  let m = v.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) {
    const day = `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}, ${m[1]}`;
    // Midnight timestamps are dates; anything else keeps its time.
    return m[4] && !(m[4] === '00' && m[5] === '00') ? `${day} ${m[4]}:${m[5]}` : day;
  }
  return v;
}

// ── Data shaping ──────────────────────────────────────────────────────────

export function aggregate(rows, column, agg) {
  const vals = rows.map((r) => r[column]);
  if (agg === 'count') return vals.filter((v) => v != null && v !== '').length;
  if (agg === 'first') return vals.find((v) => v != null) ?? null;
  if (agg === 'last') return [...vals].reverse().find((v) => v != null) ?? null;
  const nums = vals.filter((v) => typeof v === 'number');
  if (!nums.length) return null;
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === 'min') return Math.min(...nums);
  if (agg === 'max') return Math.max(...nums);
  return nums[0];
}

function sortAndLimit(rows, visual) {
  let out = rows;
  const key = visual.y[0];
  if (visual.sort !== 'none' && key) {
    const dir = visual.sort === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => ((Number(a[key]) || 0) - (Number(b[key]) || 0)) * dir);
  }
  if (visual.limit) out = out.slice(0, visual.limit);
  return out;
}

/**
 * A visual as { labels, series: [{ name, values }] }, ready for Chart.js.
 *
 * Wide data (several y columns) gives one series per column. Long data (one y
 * plus a `series` column) is pivoted: one series per distinct value, ranked by
 * total, with anything past `maxSeries` summed into "Other".
 */
export function chartSeries(visual, dataset, maxSeries = SERIES_MAX) {
  const rows = dataset?.rows || [];
  const { x } = visual;

  if (visual.series && visual.y.length > 0) {
    const yKey = visual.y[0];
    const labels = [];
    const seen = new Set();
    const totals = new Map();
    const cells = new Map();
    for (const r of rows) {
      const xv = r[x];
      const sv = r[visual.series] == null ? '(blank)' : String(r[visual.series]);
      if (!seen.has(xv)) { seen.add(xv); labels.push(xv); }
      const n = Number(r[yKey]) || 0;
      totals.set(sv, (totals.get(sv) || 0) + n);
      cells.set(`${sv}\u0000${xv}`, (cells.get(`${sv}\u0000${xv}`) || 0) + n);
    }
    // The largest series are kept, but drawn in the order the data lists them,
    // so ordered categories (price bands, stages) stack in their own order.
    const order = [...totals.keys()];
    const top = new Set([...order].sort((a, b) => totals.get(b) - totals.get(a)).slice(0, maxSeries));
    const kept = order.filter((n) => top.has(n));
    const rest = order.filter((n) => !top.has(n));
    const series = kept.map((name) => ({
      name,
      values: labels.map((xv) => cells.get(`${name}\u0000${xv}`) ?? null),
    }));
    if (rest.length) {
      series.push({
        name: 'Other',
        other: true,
        values: labels.map((xv) => rest.reduce((sum, name) => sum + (cells.get(`${name}\u0000${xv}`) || 0), 0)),
      });
    }
    return { labels, series };
  }

  const shaped = sortAndLimit(rows, visual);
  const ys = visual.y.slice(0, maxSeries);
  return {
    labels: shaped.map((r) => r[x]),
    series: ys.map((col) => ({ name: col, values: shaped.map((r) => (typeof r[col] === 'number' ? r[col] : null)) })),
  };
}

/** Pie / doughnut slices: top slices by value, the rest as one "Other" slice. */
export function sliceSeries(visual, dataset, maxSlices = SERIES_MAX) {
  const rows = (dataset?.rows || []).filter((r) => typeof r[visual.y[0]] === 'number');
  const key = visual.y[0];
  const sorted = [...rows].sort((a, b) => b[key] - a[key]);
  const kept = sorted.slice(0, maxSlices);
  const rest = sorted.slice(maxSlices);
  const slices = kept.map((r) => ({ label: r[visual.x], value: r[key] }));
  if (rest.length) slices.push({ label: 'Other', value: rest.reduce((s, r) => s + r[key], 0), other: true });
  return slices;
}

/**
 * One colour slot per series value across the whole presentation, so "EMEA" or
 * "over 100" is the same colour in every chart it appears in. Slots are handed
 * out in order of first appearance and never cycled; values past the palette
 * fall back to the chart's own order.
 */
export function seriesColorMap(presentation) {
  const map = new Map();
  for (const s of presentation?.sections || []) {
    for (const v of s.visuals || []) {
      if (!v.series) continue;
      for (const r of presentation.datasets?.[v.dataset]?.rows || []) {
        const name = r[v.series] == null ? '(blank)' : String(r[v.series]);
        if (!map.has(name) && map.size < SERIES.length) map.set(name, map.size);
      }
    }
  }
  return map;
}

/** Turn a column name into a readable label: "total_revenue" → "Total revenue". */
export function humanize(name) {
  const s = String(name || '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}

export const visualCount = (presentation) => (presentation?.sections || [])
  .reduce((n, s) => n + (s.visuals || []).length, 0);
