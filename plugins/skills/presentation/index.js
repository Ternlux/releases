/**
 * Presentation Skill Plugin for Ternlux
 *
 * Builds a dashboard-style presentation from the user's data, in the main chat
 * only (category 'chat' — the transformer / join builders never see it). The
 * chat assistant's build_presentation tool drives three stages:
 *
 *   1. clarify  — one AI call turns the brief + connection catalogue into a few
 *                 questions for the user. Always asked before any code is written.
 *   2. analyse  — with the user's answers, the javascript-executor skill writes
 *                 ONE transform(records, ctx) function that returns named
 *                 datasets. Same prompt, same ctx, same approval gate as
 *                 run_javascript — this skill only supplies the brief and the
 *                 return shape.
 *   3. write    — after the user approves and the function runs, one AI call
 *                 turns the datasets into the presentation: title, summary, KPIs
 *                 and sections of narrative + visuals. Visuals point at datasets
 *                 by name, so every number on a chart comes from the data, never
 *                 from the model.
 *
 * The javascript-executor skill is reached at run time through
 * helpers.pluginManager — a plugin imports nothing from outside its own folder.
 */

const JS_SKILL_ID = 'javascript-executor';

// Guidance, not limits. Nothing here truncates a presentation — the writer is
// told what a typical one looks like and may go past it when the brief needs to.
const TYPICAL_SECTIONS = '4–8';
const TYPICAL_VISUALS_PER_SECTION = '1–3';
// How many rows of each dataset the WRITER sees. Prompt size only: the full rows
// are kept and charted.
const WRITER_SAMPLE_ROWS = 50;

const VISUAL_TYPES = ['bar', 'hbar', 'stacked_bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'table'];
const FORMATS = ['number', 'integer', 'currency', 'percent'];
const AGGS = ['sum', 'avg', 'min', 'max', 'count', 'first', 'last'];

module.exports = {
  type: 'skill',
  id: 'presentation',
  name: 'Presentation',
  category: 'chat',
  icon: './icon.svg',

  getDescription: () => ({
    name: 'Presentation',
    description: 'Analyse saved data and present it as a full-screen dashboard of KPIs, charts and written findings.',
    capabilities: [
      'Asks clarifying questions before writing any code',
      'One AI-written analysis function over any saved connection (javascript-executor ctx)',
      'Dashboard of KPIs, bar / line / area / pie / doughnut / scatter / table visuals',
      'Written executive summary and per-section findings',
      'Present mode and PDF export',
    ],
    inputFormat: 'A plain-English brief from the main chat',
    outputFormat: 'Presentation JSON rendered by the chat as a dashboard',
    executionEnvironment: 'local (Electron main process)',
  }),

  // A chat skill has no node to execute. Present so the plugin interface is met.
  execute: async () => ({
    success: false,
    message: 'The presentation skill runs from the chat assistant (build_presentation), not from a workflow node.',
  }),

  getJsSkill,
  askClarifyingQuestions,
  buildAnalysisRequest,
  normalizeDatasets,
  writePresentation,
  summarizeForModel,

  metadata: {
    displayName: 'Presentation',
    description: 'Builds dashboard presentations from your data in the main chat',
    version: '1.0.0',
    author: 'Ternlux',
    requires: [JS_SKILL_ID],
  },
};

function getJsSkill(helpers) {
  const skill = helpers?.pluginManager?.getSkill?.(JS_SKILL_ID);
  if (!skill || typeof skill.buildChatFunctionPrompt !== 'function'
      || typeof skill.runTransformFunction !== 'function') {
    throw new Error('The presentation skill needs the javascript-executor skill, which is not available.');
  }
  return skill;
}

// ── Stage 1: clarify ───────────────────────────────────────────────────────

/**
 * Ask the AI what it needs to know before writing the analysis. Returns
 * { questions: string[] } — always at least one, so the user always has a say
 * before code is written.
 */
async function askClarifyingQuestions({ request, conversation = '', connections, helpers }) {
  const js = getJsSkill(helpers);
  const prompt = `You are planning a data presentation (an analytical dashboard report) in Ternlux.
Before any analysis code is written, ask the user what you need to know to make it right.

The user's brief: "${request}"

# The conversation so far

${conversation || '(this is the first message)'}

# Saved connections the analysis can read

${js.connectionCatalogText(connections)}

Ask 1–5 short, concrete questions. Never ask what the conversation already
answers — earlier answers (data sources, metrics, audience, time range) still
hold. When this changes a presentation made earlier in the conversation, it
replaces that one: ask only about the change, and if nothing is open, ask one
question confirming what you will build. Otherwise cover what the brief and
the list above leave open, for example:
- which connection / table(s) hold the data, when more than one could
- the audience and the decision the presentation supports
- the headline metrics, and how they are defined
- the time range and granularity (day / week / month)
- the breakdowns that matter (region, product, segment...)
Where a sensible default exists, propose it in the question so the user can just
confirm ("Monthly for the last 12 months?").

Return JSON only, no markdown:
{ "questions": ["...", "..."] }`;

  const raw = await helpers.callAI(prompt, { maxTokens: 1024 });
  let questions = [];
  try {
    const parsed = js.parseJson(raw);
    questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
      .map((q) => String(q || '').trim())
      .filter(Boolean);
  } catch (_) { /* fall through to the default question */ }
  if (questions.length === 0) {
    questions = ['What should this presentation focus on — which data, which metrics, and over what time range?'];
  }
  return { questions };
}

// ── Stage 2: analyse ───────────────────────────────────────────────────────

/**
 * The `userRequest` handed to javascript-executor's buildChatFunctionPrompt. The
 * rest of that prompt (connections, ctx helpers, credentials, read-only rules,
 * response format) is the JS skill's own; this only says what to compute and
 * what shape to return.
 */
function buildAnalysisRequest({ request, answers, conversation = '' }) {
  return `Compute the data behind an analytical presentation (a dashboard report).

Presentation brief: ${request}

The user's answers to the clarifying questions:
${answers}

The conversation before this request (earlier answers still hold; when the brief
changes an earlier presentation, compute everything the new version shows, not
only the change):
${conversation || '(none)'}

RETURN SHAPE — this replaces the "rows" wording further down. Return an ARRAY OF
DATASETS, one per thing the presentation will show:

  return [
    { name: 'kpi_totals', description: 'Headline totals for 2025', rows: [{ revenue: 1250000, orders: 8421, customers: 1903 }] },
    { name: 'revenue_by_month', description: 'Revenue per month, 2025', rows: [{ month: '2025-01', revenue: 98000 }, ...] },
    { name: 'revenue_by_region', description: 'Revenue by region', rows: [{ region: 'EMEA', revenue: 410000 }, ...] },
  ];

- name: unique snake_case. description: one line saying exactly what the rows are.
- rows: flat objects with the same keys; values are numbers, strings or ISO dates.
  Numbers must be numbers, not strings.
- Aggregate in the query. Each dataset is chart-sized — a total, a trend, a
  breakdown, a top-N — not a raw table. Tens of rows is typical; a few hundred at most.
- A one-row dataset of totals is what headline KPIs are read from.
- Time series: one row per period, sorted by period.
- Comparing several series (e.g. revenue per region per month) can be long format
  (month, region, revenue) — the chart pivots it.
- Typically 4–10 datasets. Compute what the brief and answers ask for, plus what
  a reader would need to understand it (totals, trend, main breakdowns).
- Do not catch errors to return empty datasets — let a failing query throw.
- In the JSON response, "targetColumns" is [{"name":"name"},{"name":"description"},{"name":"rows"}].`;
}

// Plain JSON values only: the presentation is saved with the chat and crosses IPC.
function cleanValue(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (ArrayBuffer.isView(v)) return null; // vectors and buffers are not chartable
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function columnType(rows, key) {
  let seen = false;
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === '') continue;
    seen = true;
    if (typeof v !== 'number') {
      return (typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ].*)?$/.test(v)) ? 'date' : 'string';
    }
  }
  return seen ? 'number' : 'string';
}

/**
 * The analysis function's output as [{ name, description, columns, rows }].
 * A function that returned plain rows instead of datasets becomes one dataset
 * named "result", so a near-miss on the shape still produces a presentation.
 */
function normalizeDatasets(output) {
  const list = Array.isArray(output) ? output : [output];
  const looksLikeDatasets = list.length > 0
    && list.every((d) => d && typeof d === 'object' && Array.isArray(d.rows));
  const raw = looksLikeDatasets ? list : [{ name: 'result', description: 'Analysis result', rows: list }];

  const used = new Set();
  return raw.map((d, i) => {
    let name = String(d.name || `dataset_${i + 1}`).trim().replace(/\s+/g, '_');
    while (used.has(name)) name = `${name}_${i + 1}`;
    used.add(name);
    const rows = (d.rows || [])
      .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
      .map((r) => {
        const out = {};
        for (const [k, v] of Object.entries(r)) out[k] = cleanValue(v);
        return out;
      });
    const keys = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    return {
      name,
      description: String(d.description || '').trim(),
      columns: keys.map((k) => ({ name: k, type: columnType(rows, k) })),
      rows,
    };
  });
}

// ── Stage 3: write ─────────────────────────────────────────────────────────

function numericStats(ds) {
  const out = {};
  for (const c of ds.columns) {
    if (c.type !== 'number') continue;
    const vals = ds.rows.map((r) => r[c.name]).filter((v) => typeof v === 'number');
    if (!vals.length) continue;
    const sum = vals.reduce((a, b) => a + b, 0);
    out[c.name] = { min: Math.min(...vals), max: Math.max(...vals), sum, avg: sum / vals.length };
  }
  return out;
}

function datasetBlock(ds) {
  const shown = ds.rows.slice(0, WRITER_SAMPLE_ROWS);
  return [
    `## ${ds.name} — ${ds.description || '(no description)'}`,
    `rows: ${ds.rows.length}${ds.rows.length > shown.length ? ` (first ${shown.length} shown)` : ''}`,
    `columns: ${ds.columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(none)'}`,
    `numeric stats over ALL rows: ${JSON.stringify(numericStats(ds))}`,
    `rows: ${JSON.stringify(shown)}`,
  ].join('\n');
}

function buildWriterPrompt({ request, answers, conversation = '', datasets }) {
  return `You are a senior data analyst writing a dashboard presentation in Ternlux, like a
Tableau story or a business report. The analysis has already run; its datasets are below.

Brief: "${request}"
The user's answers to clarifying questions:
${answers}
The conversation before this request:
${conversation || '(none)'}

# Datasets

${datasets.map(datasetBlock).join('\n\n')}

# How to write it

- Every claim and number in the text must come from the datasets above. If the
  data cannot answer part of the brief (an empty dataset, a missing breakdown),
  say so plainly in that section — never invent figures.
- Lead with the finding, not the method: "EMEA grew 18% and now leads revenue",
  not "This chart shows revenue by region".
- Typically ${TYPICAL_SECTIONS} sections with ${TYPICAL_VISUALS_PER_SECTION} visuals each. Use more when
  the brief and the data genuinely call for it, fewer when they do not.
- Charts draw their numbers from the dataset you name — you choose the columns,
  never the values.

# Visual rules

- type: ${VISUAL_TYPES.join(' | ')}
    bar / hbar   — compare categories (hbar for long labels or ranked lists)
    stacked_bar  — part-to-whole across categories (needs "series" or 2+ y)
    line / area  — change over time (x is the period column)
    pie / doughnut — share of a whole, at most 6 slices; otherwise use bar
    scatter      — relationship between two numeric columns
    table        — exact values, detail lists
- x: the category / period column. y: an array of 1+ numeric columns.
- series (optional): a column whose values become separate series, for long-format
  data (e.g. x "month", y ["revenue"], series "region"). At most 6 series.
- Never mix two measures of different scale on one chart — use two visuals.
- width: "full" | "half" | "third" — a 12-column grid row. Trends usually full or
  half; small breakdowns third.
- format: ${FORMATS.join(' | ')} (percent means the value is already 0–100). Add
  "currency": "USD" (ISO code) for money. When columns differ (a table of units
  and revenue), give each its own: "formats": { "units": "integer", "revenue": "currency" }.
- sort: "desc" | "asc" | "none" (by the first y column); limit: top N rows to show.

# KPIs

The headline numbers across the top — usually 3–6. Each is computed from a dataset:
{ "label": "Total revenue", "dataset": "kpi_totals", "column": "revenue",
  "agg": ${AGGS.map((a) => `"${a}"`).join(' | ')}, "format": "currency", "currency": "USD",
  "note": "Jan–Dec 2025" }

# Response — JSON only, no markdown fences

{
  "title": "Short, specific title",
  "subtitle": "Scope: data source and period",
  "summary": "Executive summary, 2–4 sentences with the key numbers.",
  "kpis": [ ... ],
  "sections": [
    {
      "heading": "The finding, as a headline",
      "narrative": "1–3 short paragraphs separated by blank lines.",
      "insights": ["Short bullet with a number", "..."],
      "visuals": [
        { "type": "line", "title": "Monthly revenue", "subtitle": "2025, USD",
          "dataset": "revenue_by_month", "x": "month", "y": ["revenue"],
          "width": "full", "format": "currency", "currency": "USD" }
      ]
    }
  ]
}`;
}

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Make one visual safe to render against the datasets. A visual naming a dataset
 * that does not exist is dropped; columns that do not exist are removed, and a
 * chart left without a numeric column falls back to a table of its dataset.
 * This checks correctness only — it never trims the presentation's size.
 */
function cleanVisual(v, byName) {
  if (!v || typeof v !== 'object') return null;
  const ds = byName.get(v.dataset);
  if (!ds) return null;
  const cols = new Set(ds.columns.map((c) => c.name));
  let type = pick(v.type, VISUAL_TYPES, 'bar');
  const x = cols.has(v.x) ? v.x : (ds.columns.find((c) => c.type !== 'number') || ds.columns[0] || {}).name || null;
  const y = (Array.isArray(v.y) ? v.y : [v.y]).filter((c) => cols.has(c) && c !== x);
  const series = cols.has(v.series) && v.series !== x ? v.series : null;
  if (type !== 'table' && y.length === 0) type = 'table';
  return {
    type,
    title: str(v.title) || ds.description || ds.name,
    subtitle: str(v.subtitle),
    dataset: ds.name,
    x,
    y,
    series,
    width: pick(v.width, ['full', 'half', 'third'], 'half'),
    format: pick(v.format, FORMATS, 'number'),
    formats: cleanFormats(v.formats, cols),
    currency: str(v.currency).toUpperCase() || null,
    sort: pick(v.sort, ['asc', 'desc', 'none'], 'none'),
    limit: Number.isFinite(Number(v.limit)) && Number(v.limit) > 0 ? Math.floor(Number(v.limit)) : null,
  };
}

function cleanFormats(formats, cols) {
  if (!formats || typeof formats !== 'object') return null;
  const out = {};
  for (const [col, f] of Object.entries(formats)) if (cols.has(col) && FORMATS.includes(f)) out[col] = f;
  return Object.keys(out).length ? out : null;
}

function cleanKpi(k, byName) {
  if (!k || typeof k !== 'object') return null;
  const ds = byName.get(k.dataset);
  if (!ds || !ds.columns.some((c) => c.name === k.column)) return null;
  return {
    label: str(k.label) || k.column,
    dataset: ds.name,
    column: k.column,
    agg: pick(k.agg, AGGS, 'first'),
    format: pick(k.format, FORMATS, 'number'),
    currency: str(k.currency).toUpperCase() || null,
    note: str(k.note),
  };
}

/**
 * Stage 3. Returns the presentation the chat renders: the writer's layout plus
 * the datasets it points at.
 */
async function writePresentation({ request, answers, conversation = '', datasets, helpers }) {
  const js = getJsSkill(helpers);
  const raw = await helpers.callAI(buildWriterPrompt({ request, answers, conversation, datasets }), { maxTokens: 8192 });
  let parsed;
  try {
    parsed = js.parseJson(raw);
  } catch (err) {
    throw new Error(`The presentation writer returned invalid JSON: ${err.message}`);
  }
  const byName = new Map(datasets.map((d) => [d.name, d]));
  const sections = (Array.isArray(parsed?.sections) ? parsed.sections : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      heading: str(s.heading),
      narrative: str(s.narrative),
      insights: (Array.isArray(s.insights) ? s.insights : []).map(str).filter(Boolean),
      visuals: (Array.isArray(s.visuals) ? s.visuals : []).map((v) => cleanVisual(v, byName)).filter(Boolean),
    }));

  return {
    version: 1,
    title: str(parsed?.title) || 'Presentation',
    subtitle: str(parsed?.subtitle),
    summary: str(parsed?.summary),
    kpis: (Array.isArray(parsed?.kpis) ? parsed.kpis : []).map((k) => cleanKpi(k, byName)).filter(Boolean),
    sections,
    datasets: Object.fromEntries(datasets.map((d) => [d.name, d])),
    createdAt: new Date().toISOString(),
  };
}

/**
 * What the main agent sees once the presentation exists. The full presentation
 * goes to the chat bubble; the model gets the outline and the written findings,
 * enough to answer in a sentence or two without re-reading every row.
 */
function summarizeForModel(presentation) {
  return {
    ran: true,
    presentationAttached: true,
    title: presentation.title,
    summary: presentation.summary,
    sections: presentation.sections.map((s) => ({ heading: s.heading, insights: s.insights })),
    datasets: Object.values(presentation.datasets).map((d) => ({ name: d.name, rowCount: d.rows.length })),
    note: 'The presentation is attached to your answer as a card the user opens full-screen. '
      + 'Answer with a short summary of the headline findings. Do not add "visuals" — the '
      + 'presentation already carries its charts.',
  };
}
