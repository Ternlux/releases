import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { C, SANS, MONO, I, MoreMenu } from '../Workflows/_designShared';
import DataVisualization from './DataVisualization';
import PresentationCard from './Presentation/PresentationCard';
import { loadJoinDestinations, hasJoinDestination } from '../Workflows/joinDestinations';
// One hue per node type, decided by the canvas cards — see NODE_COLORS.
import { NODE_COLORS, targetIsSourceWarning } from '../Workflows/nodes/nodeCardShared';
import { hasRequiredInputs, nodeRequirementMessage } from '../../utils/workflowUtils';

const MAX_STEPS_PER_QUESTION = 8;
// Consecutive "Fix it" clicks on a review verdict before the button stops being
// offered. Each click re-sends the reviewer's remediation to the builder as its
// next brief, so a wrong verdict becomes the next round's specification; without
// a cap one bad call can rewrite a working node until it no longer runs. Two
// rounds is enough for a genuine miss and short enough to stop a loop. Only
// button clicks count — a message the user typed resets it (see fixRoundsRef).
const MAX_REVIEW_FIX_ROUNDS = 2;
// Shown whenever a model breaks the JSON contract, wherever it happens (main
// agent, workflow sub-agent, planner, node builder). The raw text always rides
// along as `invalidJson` and renders in the collapsible panel under the message.
const INVALID_RESPONSE_MESSAGE = 'The AI responded with an invalid response. Click retry to ask the AI again.';

/**
 * Ask the open workflow editor to commit its canvas before a build reads the
 * workflow from disk.
 *
 * A build plans against the SAVED workflow, so unsaved canvas edits are both
 * invisible to it and about to be overwritten by whatever it writes back. The
 * editor answers at once: ok when there is nothing uncommitted, otherwise not
 * ok. The chat never waits on a save; it says why it stopped, and the user
 * presses Retry once the workflow is saved (Save is one click).
 *
 * The editor lives in a different subtree, so this goes over a window event
 * rather than props — the same bridge the Settings request uses. Nothing
 * listening means no editor is open, and therefore nothing unsaved to lose.
 */
async function requestWorkflowSaveGate() {
  let answer = null;
  try {
    window.dispatchEvent(new CustomEvent('ternlux:workflow-save-gate', {
      detail: { respond: (p) => { answer = p; } },
    }));
    if (!answer) return { ok: true, reason: 'no-editor' };
    return (await answer) || { ok: true, reason: 'no-answer' };
  } catch (_err) {
    // Never let the gate itself be the reason a build cannot run.
    return { ok: true, reason: 'gate-error' };
  }
}

// What the chat says when the save gate stops a build. `again` names the
// button that picks the request back up once the workflow is saved.
function saveGateRefusal(gate, again) {
  const name = gate.workflowName ? `"${gate.workflowName}"` : 'The open workflow';
  if (gate.reason === 'unnamed-workflow') {
    return 'This workflow has never been saved, so there is nothing for me to build on yet. '
      + `Give it a name and save it, then press ${again} — I'll extend what you have instead of starting a separate workflow.`;
  }
  if (gate.reason === 'invalid-workflow') {
    return `${name} has unsaved changes that can't be saved yet: ${
      String(gate.detail || 'the editor reported a problem with it').replace(/\.\s*$/, '')}. Fix that, save, then press ${again}.`;
  }
  return `${name} has unsaved changes, so I haven't started — the workflow builder works from the saved version. `
    + `Save it (Save, above the canvas), then press ${again}.`;
}

// NeDB refuses any field whose key starts with `$` (it reserves them for
// update operators). Tool results occasionally include such keys — Mongo
// Extended JSON markers like `$oid` / `$date` are the usual offenders, but
// it can be anything a connector hands back. Rewrite `$foo` to `_$foo`
// recursively before persisting so the chat history can always be saved.
// We keep the original key inside the new name so it's recoverable on
// inspection.
function sanitizeForNedb(value) {
  if (Array.isArray(value)) return value.map(sanitizeForNedb);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const safeKey = (typeof k === 'string' && k.startsWith('$')) ? `_${k}` : k;
      out[safeKey] = sanitizeForNedb(v);
    }
    return out;
  }
  return value;
}

// Concrete default suggestions — phrased so the agent has enough to act on
// without the user having to think. Each one names a real surface in the app.
const SUGGESTIONS_EMPTY = [
  { title: 'List my workflows',          sub: 'Names, types, and node counts' },
  { title: 'List my saved connections',  sub: 'Grouped by database / file / API' },
  { title: 'Show my last 5 executions',  sub: 'Status, trigger, and duration' },
  { title: 'Why did my last run fail?',  sub: 'Inspect the latest failed execution' },
];

const KIND_LABEL = { workflow: 'Workflow', connection: 'Connection', execution: 'Execution' };

// The assistant floats above every other surface so it stays reachable while
// something is open — antd modals sit at 1000, and ExecutionTab's execution
// detail panel at 1300 (mask) / 1400 (card).
const CHAT_Z = 1500;

// ── Floating window geometry ───────────────────────────────────────────────
// The popup is draggable by its header. Holding it against the right edge for
// DOCK_HOLD_MS arms the dock — the drop zone lights up and releasing snaps the
// panel to a full-height rail pinned on the right.
const PANEL_W = 440;
const PANEL_H = 620;
const EDGE_GAP = 8;        // closest the floating panel may sit to a viewport edge
const DOCK_ZONE = 56;      // right-edge band that starts the dock countdown
const DOCK_HOLD_MS = 550;  // how long it must be held there before the dock arms
const RAIL_PCT = 0.30;     // pinned, the rail starts at 30% of the window
const RAIL_MIN = 320;      // …and the resize handle runs from here…
const RAIL_MAX_PCT = 0.60; // …up to 60% of the window

// The rail's bounds always follow the current window, so a width the user
// dragged out on a wide screen quietly narrows again on a small one.
const railBounds = (vw) => {
  const min = Math.min(RAIL_MIN, vw);
  return { min, max: Math.max(min, Math.round(vw * RAIL_MAX_PCT)) };
};
const railWidthFor = (vw, wanted) => {
  const { min, max } = railBounds(vw);
  return Math.max(min, Math.min(wanted ?? Math.round(vw * RAIL_PCT), max));
};

// Overlay a config an earlier step of this turn already applied onto the
// focused-node payload. The canvas is the source of truth between turns, but
// within a turn its React state lags the step loop by two renders, so a note or
// committed chat written moments ago would otherwise not be in `targetNode`.
// Skipped when the user has since selected a different node.
const withAppliedConfig = (targetNode, applied) => {
  if (!targetNode || !applied || applied.nodeId !== targetNode.nodeId) return targetNode;
  return { ...targetNode, config: { ...(targetNode.config || {}), ...applied.config } };
};

// ── Reviewer transcripts ───────────────────────────────────────────────────
// What the post-build reviewer is judged against. Deliberately NOT the chat
// panel: a build is answerable only for the brief its builder was given, and
// the panel carries other nodes' conversations plus, after an edit/resubmit of
// an earlier message, the whole failed attempt that preceded it.

// A node's own chat (config.chat) — the exact transcript the builder read.
// Bot messages keep the labels chatToHistory uses on the builder side, so the
// reviewer can tell the AI's own questions and injected context apart from
// what the user actually asked for.
const nodeChatToReviewHistory = (chat, fallbackConfig = null) => {
  const rows = (Array.isArray(chat) ? chat : [])
    .filter((m) => m && m.text)
    .map((m) => {
      if (m.sender === 'user') return { role: 'user', text: String(m.text) };
      const meta = m.metadata || {};
      // Stripped before it is re-applied, for the same reason planToReviewHistory
      // does it: the label belongs to the rendering, not to the stored text.
      const body = meta.clarification ? stripClarificationPrefix(m.text) : String(m.text).trim();
      const prefix = meta.clarification ? CLARIFICATION_PREFIX
        : meta.context ? 'Context from the chat: '
          : '';
      return { role: 'assistant', text: `${prefix}${body}`, clarification: !!meta.clarification };
    });
  if (rows.length) {
    // The transcript outlives conversations: it holds every build this node has
    // had. Only the newest request — and the clarification answers that follow
    // it — is the brief for THIS change; older turns describe what the node did
    // before. Judging a refine ("make it an inner join") against the original
    // request's loose wording failed correct builds, so each row says which it
    // is. A user turn that answers the AI's question belongs to the request it
    // was asked about, not a new one.
    let start = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role !== 'user') continue;
      const prev = rows[i - 1];
      if (prev && prev.role === 'assistant' && prev.clarification) continue;
      start = i;
      break;
    }
    return rows.map(({ clarification: _c, ...r }, i) => ({
      ...r,
      phase: start >= 0 && i < start ? 'earlier' : 'current',
    }));
  }
  // Legacy / hand-edited nodes carry no chat. Fall back to the request slot the
  // builder would have used, so the reviewer still has a goal to judge against
  // rather than silently reviewing against nothing.
  const c = fallbackConfig || {};
  const seed = String(
    c.transformationRequest || c.builderPrompt || c.joinDescription || c.outputDescription || ''
  ).trim();
  return seed ? [{ role: 'user', text: seed }] : [];
};

// A workflow build's own record: the brief the planner worked to, the
// clarification Q&A that refined it, and the plan that was executed.
// The label a clarification wears in a transcript rendered for a model. Kept
// off the stored question, and stripped before it is re-applied, so a question
// that makes a second trip through here is labelled once, not twice.
const CLARIFICATION_PREFIX = 'Clarification by AI: ';
const stripClarificationPrefix = (text) => {
  let out = String(text || '').trim();
  while (out.startsWith(CLARIFICATION_PREFIX)) out = out.slice(CLARIFICATION_PREFIX.length).trim();
  return out;
};

// Splits `userRequest` back into the two things propose_plan glued together:
// the description the sub-agent wrote, and the user's message verbatim. The
// append exists so the BUILDER keeps literal values (URLs, request bodies,
// keys) the paraphrase would drop — see propose_plan in chat/chatAssistant.js.
const ORIGINAL_MESSAGE_SPLIT = /\n\n--- User's original message[^\n]*---\n/;

const planToReviewHistory = (plan) => {
  const p = plan || {};
  const rows = [];
  const raw = String(p.userRequest || p.request || '').trim();
  const [description, original = ''] = raw.split(ORIGINAL_MESSAGE_SPLIT);
  if (description.trim()) rows.push({ role: 'user', text: description.trim() });
  // As its own row, and labelled. Glued onto the request it read as the spec,
  // and a reviewer would fail a build for following a clarification that
  // replaced this wording — the message says test_transaction_products, the
  // build says transaction_products, and nothing on the row explained why.
  if (original.trim()) {
    rows.push({
      role: 'user',
      text: `The request as FIRST TYPED, superseded by anything clarified below: ${original.trim()}`,
    });
  }
  // Both kinds, in the order they were asked: the conversation's own Q&A from
  // before the plan (propose_plan keeps those apart so the build does not seed
  // them into every node's chat), then the questions builders asked mid-build.
  const clarifications = [
    ...(Array.isArray(p.conversationClarifications) ? p.conversationClarifications : []),
    ...(Array.isArray(p.clarifications) ? p.clarifications : []),
  ];
  for (const c of clarifications) {
    if (!c) continue;
    const question = stripClarificationPrefix(c.question);
    if (question) rows.push({ role: 'assistant', text: `${CLARIFICATION_PREFIX}${question}` });
    if (c.answer) rows.push({ role: 'user', text: String(c.answer).trim() });
  }
  if (Array.isArray(p.steps) && p.steps.length) {
    // Two rows, not one. This was a single "Planned build (JSON)" dump of the
    // whole plan — and formatRequestHistory trims EVERY row to
    // MAX_REVIEW_MSG_CHARS, so on any workflow past a dozen nodes the tail was
    // cut off. The tail is exactly the list of nodes this change did NOT touch:
    // on a 20-step modify the six trailing output ids were dropped, the reviewer
    // could not tell they were untouched, and it failed the build for "not
    // replacing" an output node belonging to an earlier request the user had
    // already moved on from. Ids are cheap; in their own row they survive whole.
    const built = p.steps.filter((s) => s && typeof s === 'object');
    const untouched = p.steps.filter((s) => typeof s === 'string');
    rows.push({
      role: 'assistant',
      text: `Built or rebuilt by THIS change (${built.length}): ${JSON.stringify({ name: p.name, mode: p.mode, steps: built })}`,
    });
    if (untouched.length) {
      rows.push({
        role: 'assistant',
        text: `Left EXACTLY as it was by this change — context only, not part of it (${untouched.length}): ${untouched.join(', ')}`,
      });
    }
  }
  return rows;
};

// Tools that route or propose rather than look something up. They tell the
// reviewer nothing about the state of the world, and their args restate the
// request it is already being given.
const NON_EVIDENCE_TOOLS = new Set([
  'plan_workflow_build', 'propose_plan', 'final_answer', 'exit_workflow_mode',
]);

const MAX_ACTION_RESULT_CHARS = 600;
const MAX_PRIOR_ACTIONS = 12;

/**
 * The lookups the agent ran BEFORE the build — get_tables, get_columns,
 * run_query, list_connections and the like.
 *
 * The reviewer judges the pipeline against the user's request, and that request
 * routinely contains instructions of the form "check X first" / "make sure Y
 * doesn't already exist". Those are preconditions the agent satisfies by
 * CALLING A TOOL while planning, not steps that can exist as nodes in a graph.
 * Without this evidence the reviewer sees the instruction, finds no node doing
 * it, and fails a correct build for omitting something that was in fact done.
 *
 * Results are truncated hard: a get_tables on a busy database runs to hundreds
 * of entries, and the reviewer only needs to see WHAT was checked and roughly
 * what came back.
 */
const collectPriorActions = (msgs) => {
  const out = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (m?.kind !== 'step' || !Array.isArray(m.actions)) continue;
    for (const a of m.actions) {
      if (!a || !a.tool || NON_EVIDENCE_TOOLS.has(a.tool)) continue;
      let result;
      try {
        result = a.ok === false
          ? `(failed) ${String(a.error || '').slice(0, MAX_ACTION_RESULT_CHARS)}`
          : JSON.stringify(a.result);
      } catch (_err) {
        result = '(unserialisable)';
      }
      result = String(result ?? '');
      if (result.length > MAX_ACTION_RESULT_CHARS) {
        result = `${result.slice(0, MAX_ACTION_RESULT_CHARS)}… (truncated)`;
      }
      out.push({ tool: a.tool, args: a.args || {}, result });
    }
  }
  // Keep the most recent — those reflect the state the build was planned against.
  return out.slice(-MAX_PRIOR_ACTIONS);
};

const nowTs = () => new Date().toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
const newConvoId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const newMsgId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const blankConvo = () => {
  const now = Date.now();
  return {
    id: newConvoId(),
    title: 'New chat',
    messages: [],
    agentMode: 'main',
    workflowSession: null,
    pendingBuild: null,
    createdAt: now,
    updatedAt: now,
  };
};

// Pick the first 7-or-so words of the user's first message to title the chat.
const titleFromMessage = (text) => {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'New chat';
  const words = t.split(' ').slice(0, 8).join(' ');
  return words.length < t.length ? `${words}…` : words;
};

// ── Windows-style maximize / restore icons ─────────────────────────────────
const IconMaximize = ({ color = C.muted, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.4">
    <rect x="1.5" y="1.5" width="9" height="9" />
  </svg>
);
const IconRestore = ({ color = C.muted, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.4">
    <rect x="3" y="3" width="7" height="7" />
    <path d="M3 5 V2 H10 V9 H7" />
  </svg>
);

// ── Dock-to-right / undock icons ───────────────────────────────────────────
// A panel outline with the right column filled: the shape the window takes
// once it is pinned. The unpinned variant leaves that column empty.
const IconPin = ({ color = C.muted, size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.3">
    <rect x="1.2" y="2.2" width="11.6" height="9.6" rx="1.4" />
    <rect x="8" y="2.2" width="4.8" height="9.6" fill={color} stroke="none" opacity="0.85" />
  </svg>
);
const IconUnpin = ({ color = C.muted, size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.3">
    <rect x="1.2" y="2.2" width="11.6" height="9.6" rx="1.4" />
    <path d="M8 2.4 V11.6" strokeDasharray="2 1.6" />
  </svg>
);

// Six-dot grip that marks the header as the drag handle.
const IconGrip = ({ color = C.dim, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill={color}>
    {[3, 6, 9].map((y) => (
      <React.Fragment key={y}>
        <circle cx="4" cy={y} r="0.95" />
        <circle cx="8" cy={y} r="0.95" />
      </React.Fragment>
    ))}
  </svg>
);

// ── Lightweight markdown (fenced code, ## headers, bold + `code`) ──────────
const MdInline = ({ line }) => (
  <>
    {line.split(/(\*\*.*?\*\*|`[^`]*`)/g).map((p, i) => {
      if (p.startsWith('**') && p.endsWith('**') && p.length >= 4)
        return <strong key={i} style={{ fontWeight: 700 }}>{p.slice(2, -2)}</strong>;
      if (p.startsWith('`') && p.endsWith('`') && p.length >= 2)
        return (
          // `color` is not optional here, however inherited it looks: the chip
          // paints its own pale background, so it has to state its own text
          // colour too. A user's bubble is blue with white text, and a chip
          // that inherited that came out white-on-white — unreadable exactly
          // where code matters most, in the message quoting a column name.
          // The fenced-block <pre> below has always set it; this never did.
          <code key={i} style={{
            fontFamily: MONO, fontSize: 11, background: C.s2, color: C.text,
            padding: '1px 5px', borderRadius: 3, border: `1px solid ${C.border}`,
          }}>{p.slice(1, -1)}</code>
        );
      return <span key={i}>{p}</span>;
    })}
  </>
);

const MdProse = ({ text, first }) => {
  const blocks = String(text).replace(/^\n+|\n+$/g, '').split(/\n\n+/).filter(Boolean);
  return blocks.map((block, bi) => (
    <div key={bi} style={{ marginTop: bi === 0 && first ? 0 : 8 }}>
      {block.split('\n').map((line, li) => {
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
          return (
            <div key={li} style={{
              fontWeight: 700, fontSize: h[1].length <= 2 ? 13 : 12,
              marginTop: li === 0 ? 0 : 6,
            }}>
              <MdInline line={h[2]} />
            </div>
          );
        }
        return <div key={li}><MdInline line={line} /></div>;
      })}
    </div>
  ));
};

const Markdown = ({ text }) => {
  if (!text) return null;
  // Pull fenced ```lang blocks out FIRST so their content is rendered
  // verbatim in a <pre> and never hits the inline bold/backtick rules.
  // split with one capture group alternates [prose, code, prose, code, …].
  const parts = String(text).split(/```[^\n`]*\n?([\s\S]*?)```/g);
  return parts.map((part, pi) => {
    if (pi % 2 === 1) {
      return (
        <pre key={pi} style={{
          margin: '8px 0', padding: '8px 10px',
          background: C.s2, border: `1px solid ${C.border}`, borderRadius: 4,
          fontFamily: MONO, fontSize: 11, color: C.text,
          overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{part.replace(/\n$/, '')}</pre>
      );
    }
    if (!part.trim()) return null;
    return <MdProse key={pi} text={part} first={pi === 0} />;
  });
};

// Workflow plans no longer ride inside finalAnswer as a fenced markdown
// block. The backend's `chat:step` IPC sets `workflowPlan` as a top-level
// field on its response; the renderer attaches it directly to the
// finalAnswer message so PlanCard can render it.

// A plan step is a node that doesn't exist yet, so it wears that node's colour
// — taken from NODE_COLORS, the canvas's own palette, rather than a second set
// of hexes here. These two DID drift: the plan used to badge a data source
// navy and an output green while the canvas drew them cyan and pink, so the
// same step changed colour the moment it became a card.
//
// `bg` is the accent at 10% (the `1a` suffix), the same wash the cards use for
// their selected-state glow.
const STEP_BADGE = {
  start:       { label: 'START',     color: NODE_COLORS.start },
  dataSource:  { label: 'DATA SRC',  color: NODE_COLORS.dataSource },
  transformer: { label: 'TRANSFORM', color: NODE_COLORS.transformer },
  join:        { label: 'JOIN',      color: NODE_COLORS.join },
  output:      { label: 'OUTPUT',    color: NODE_COLORS.output },
};

// The badge and the step's left edge, from one accent — mirroring the card,
// which is an accent left border with the accent's icon and title beside it.
const badgeFor = (stepType) => {
  const known = STEP_BADGE[stepType];
  if (known) return { ...known, bg: `${known.color}1a` };
  return { label: String(stepType).toUpperCase(), color: C.muted, bg: C.s2 };
};

// ── Workflow plan card — shown when an assistant message carries a
// `workflowPlan` field (set by the backend's short-circuited propose_plan
// turn). The Accept button calls the executor IPC directly
// (workflow:executeBuild), bypassing the AI; the Cancel button just locks
// the card. Once the user has either accepted or cancelled, the buttons
// are replaced with a status line so they cannot fire twice.
const PlanCard = ({ plan, status, onAccept, onCancel, stale = false, blockedReason = null }) => {
  // `settled` — acted on. `stale` — never acted on, but the conversation moved
  // past it. Both replace the buttons; only the wording differs, because
  // "you didn't answer this" is not the same as "you did".
  const settled = status && status.kind !== 'idle';
  const shown = settled ? status : (stale ? { kind: 'stale', message: 'Not accepted — you asked for something else.' } : null);
  return (
    <div style={{
      marginTop: 10, padding: 12, borderRadius: 6,
      border: `1px solid ${C.border}`, background: '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
          color: C.dim, textTransform: 'uppercase',
        }}>Build plan</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>
          {plan.mode === 'modify' ? 'Modify workflow' : plan.name || 'New workflow'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>
          {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
        </span>
      </div>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(() => {
          // A step's `sources` are 0-based indices into this plan, or ids of
          // nodes already in the workflow — never what the reader sees, which
          // is the 1-based number in front of each step and the node's name.
          // An id that a kept/modified step stands for shows as that step's
          // number, so "← 2, 3" reads the same whether the input is new or not.
          const stepNoById = new Map();
          plan.steps.forEach((s, idx) => {
            const id = typeof s === 'string' ? s : s?.existingNodeId;
            if (id) stepNoById.set(id, idx + 1);
          });
          const labels = plan.nodeLabels || {};
          const nameOf = (id) => labels[id] || id;
          const sourceRef = (ref) => {
            if (typeof ref === 'number') return String(ref + 1);
            if (stepNoById.has(ref)) return String(stepNoById.get(ref));
            return nameOf(ref);
          };
          return plan.steps.map((raw, i) => {
          // Each step entry is either a string (id of an existing node to
          // keep as-is) or an object (modify when it has existingNodeId,
          // add otherwise). Normalize before rendering.
          const isShorthand = typeof raw === 'string';
          const stepType = isShorthand ? null : raw.stepType;
          // A kept node is not being built, so it stays neutral rather than
          // claiming one of the type colours.
          const badge = stepType
            ? badgeFor(stepType)
            : { label: 'KEEP', color: C.muted, bg: C.s2 };
          const titleSuffix = isShorthand
            ? `Keep ${nameOf(raw)}`
            : (raw.existingNodeId ? `Modify ${nameOf(raw.existingNodeId)}` : (raw.label || stepType));
          const sources = !isShorthand && Array.isArray(raw.sources) ? raw.sources : null;
          const prompt = isShorthand ? null : (raw.prompt || '');
          return (
            <li key={i} style={{
              padding: '8px 10px', borderRadius: 4,
              border: `1px solid ${C.border}`, background: C.bg,
              // The card's signature edge, so a plan reads as the stack of
              // nodes it will produce.
              borderLeft: `3px solid ${badge.color}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: prompt ? 4 : 0 }}>
                <span style={{
                  fontSize: 8, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
                  padding: '2px 6px', borderRadius: 3,
                  color: badge.color, background: badge.bg,
                }}>{badge.label}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>
                  {i + 1}. {titleSuffix}
                </span>
                {sources && sources.length > 0 && (
                  <span style={{ fontSize: 9, fontFamily: MONO, color: C.muted }}>
                    ← {sources.map(sourceRef).join(', ')}
                  </span>
                )}
              </div>
              {prompt && (
                <div style={{ fontSize: 11, lineHeight: 1.5, color: C.muted, whiteSpace: 'pre-wrap' }}>
                  {prompt}
                </div>
              )}
            </li>
          );
          });
        })()}
      </ol>
      {plan.mode === 'modify' && Array.isArray(plan.deletedNodes) && plan.deletedNodes.length > 0 && (
        <div style={{
          marginTop: 8, padding: '6px 10px', borderRadius: 4,
          fontSize: 10, fontFamily: MONO, color: C.red,
          background: C.rD, border: '1px solid #fecaca',
        }}>
          Deletes: {plan.deletedNodes.map((id) => (plan.nodeLabels || {})[id] || id).join(', ')}
        </div>
      )}
      {shown ? (
        <div style={{
          marginTop: 10, padding: '6px 10px', borderRadius: 4,
          fontSize: 11, fontFamily: SANS, fontWeight: 600,
          background: shown.kind === 'error' ? C.rD : (shown.kind === 'success' ? C.gD : C.s2),
          color:      shown.kind === 'error' ? C.red : (shown.kind === 'success' ? C.green : C.muted),
          border: `1px solid ${shown.kind === 'error' ? '#fecaca' : shown.kind === 'success' ? '#bbf7d0' : C.border}`,
        }}>
          {shown.message}
        </div>
      ) : (
        <>
          {/* Why Accept is unavailable, said before the click rather than
              after it. Cancel stays live throughout — discarding a plan never
              touches the canvas, so nothing has to be saved first. */}
          {blockedReason && (
            <div style={{
              marginTop: 10, padding: '6px 10px', borderRadius: 4,
              fontSize: 11, fontFamily: SANS, lineHeight: 1.5,
              background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e',
            }}>
              {blockedReason}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} disabled={status?.kind === 'running'}
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 600,
                borderRadius: 4, border: `1px solid ${C.border}`, background: '#fff',
                color: C.muted, cursor: status?.kind === 'running' ? 'default' : 'pointer',
                fontFamily: SANS, opacity: status?.kind === 'running' ? 0.6 : 1,
              }}>
              Cancel
            </button>
            <button type="button" onClick={onAccept}
              disabled={status?.kind === 'running' || !!blockedReason}
              title={blockedReason || undefined}
              style={{
                padding: '6px 14px', fontSize: 11, fontWeight: 600,
                borderRadius: 4, border: 'none',
                background: blockedReason ? C.dim : C.accent,
                color: '#fff',
                cursor: (status?.kind === 'running' || blockedReason) ? 'default' : 'pointer',
                fontFamily: SANS, opacity: status?.kind === 'running' ? 0.7 : 1,
              }}>
              {status?.kind === 'running' ? 'Building…' : 'Accept plan'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ── Join destination picker ────────────────────────────────────────────────
//
// A Join cannot be built until it knows where it writes — the destination
// decides the SQL dialect, how sources are staged, and where the output lands.
// So focusing a destination-less Join puts this in front of the conversation
// first, the way the node's own form used to. Dismissing the node chip takes it
// away with the focus; the model can settle the same thing via
// set_join_destination if the user would rather type it.
const JoinDestinationPicker = ({ node, destinations, loading, onPick }) => {
  const grouped = useMemo(() => {
    const out = new Map();
    (destinations || []).forEach((d) => {
      if (!out.has(d.group)) out.set(d.group, []);
      out.get(d.group).push(d);
    });
    return [...out.entries()];
  }, [destinations]);

  return (
    <div style={{
      padding: '10px 14px', borderBottom: `1px solid ${C.border}`, background: '#fffbeb',
    }}>
      <div style={{
        fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
        color: '#b45309', textTransform: 'uppercase', marginBottom: 4,
      }}>
        Pick a destination first
      </div>
      <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5, marginBottom: 8 }}>
        <strong>{node.label}</strong> has nowhere to write its result yet. Choose where the joined
        data should go — or just tell me in the chat.
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: C.muted }}>Loading destinations…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div style={{
                fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: items[0]?.groupColor || C.dim, marginBottom: 4,
              }}>
                {group}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {items.map((d) => (
                  <button key={d.value} type="button" onClick={() => onPick(d)}
                    style={{
                      textAlign: 'left', padding: '6px 9px', borderRadius: 4,
                      border: `1px solid ${C.border2}`, background: '#fff',
                      cursor: 'pointer', fontFamily: SANS,
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                    onMouseOut={(e) => { e.currentTarget.style.borderColor = C.border2; }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{d.label}</div>
                    <div style={{ fontSize: 10.5, color: C.muted }}>{d.description}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Focused-node chip ──────────────────────────────────────────────────────
// Sits in the same "Focused on" strip as the workflow/connection chip so the
// user sees one focus area, not two competing headers. Dismissing it drops the
// node from the turn payload; re-opening the panel restores it as long as the
// node is still selected on the canvas (see focusDismissed).
// Matches the canvas cards: transformer purple, join orange, source cyan.
const FocusNodeChip = ({ node, typeLabel, onClear }) => {
  if (!node) return null;
  // Same palette as the card being focused — these hexes used to be repeated
  // here, which is half of how the plan badges drifted out of step.
  const color = NODE_COLORS[node.type] || C.accent;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 8px 4px 9px', borderRadius: 4,
      background: '#fff', border: `1px solid ${color}55`,
      fontSize: 11, fontFamily: SANS, minWidth: 0,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{
        fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color,
      }}>{typeLabel}</span>
      {/* A node nobody has configured or named yet is still called by its type,
          which the badge already says — "Join Join". Say what it is instead. */}
      <span style={{ fontWeight: 600, color: C.text, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={node.label}>
        {String(node.label || '').trim().toLowerCase() === String(typeLabel || '').trim().toLowerCase()
          ? <span style={{ fontWeight: 400, color: C.muted, fontStyle: 'italic' }}>not configured yet</span>
          : node.label}
      </span>
      {onClear && (
        <button type="button" onClick={onClear} aria-label="Remove node from chat context"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', color: C.muted }}>
          {I('x', C.muted, 11)}
        </button>
      )}
    </div>
  );
};

// ── Active-context chip ────────────────────────────────────────────────────
const ContextChip = ({ ctx, onClear }) => {
  if (!ctx || !ctx.kind) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 8px 4px 9px', borderRadius: 4,
      background: C.aD, border: '1px solid #bfdbfe',
      fontSize: 11, color: C.accent, fontFamily: SANS,
    }}>
      <span style={{
        fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: C.accent,
      }}>{KIND_LABEL[ctx.kind] || ctx.kind}</span>
      <span style={{ fontWeight: 600, color: C.text, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ctx.name || ctx.id || 'unknown'}
      </span>
      {onClear && (
        <button type="button" onClick={onClear} aria-label="Clear context"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', color: C.muted }}>
          {I('x', C.muted, 11)}
        </button>
      )}
    </div>
  );
};

// ── Agent chip — the sub-agent currently holding the conversation ─────────
//
// A workflow session is sticky by design: once the main assistant hands off,
// every later message goes to the builder sub-agent until the plan is built or
// the chat is restarted. Cancelling a plan does NOT end it, and the sub-agent
// has a deliberately narrow toolbox — no node builders, no docs, no execution
// history — so a conversation parked there answers with another plan even when
// the user has moved on to something the main agent handles directly (editing
// the node they have selected, say). The mode was previously visible only as a
// dot in the header; this puts it in the same strip as everything else the turn
// is scoped to, and makes it dismissible. The X is the way out.
const AgentChip = ({ label, onClear, disabled }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 8px 4px 9px', borderRadius: 4,
    background: '#f5f3ff', border: '1px solid #ddd6fe',
    fontSize: 11, fontFamily: SANS, minWidth: 0,
  }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#7c3aed', flexShrink: 0 }} />
    <span style={{
      fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
      textTransform: 'uppercase', color: '#7c3aed',
    }}>Agent</span>
    <span style={{ fontWeight: 600, color: C.text, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {label}
    </span>
    {onClear && (
      <button type="button" onClick={onClear} disabled={disabled}
        aria-label="Leave the workflow builder and go back to the main assistant"
        title={disabled
          ? 'Wait for the current turn to finish'
          : 'Back to the main assistant — the next message skips the workflow builder'}
        style={{
          border: 'none', background: 'transparent', padding: 0, display: 'flex',
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
          color: C.muted,
        }}>
        {I('x', C.muted, 11)}
      </button>
    )}
  </div>
);

// ── Code approval — generated JavaScript waiting on the user ──────────────
//
// Rendered inside the step that produced it, not as a bubble of its own: it IS
// that tool call's outcome. The explanation leads (it's the point of the code);
// the source sits under a collapsible, deliberately short pane.
//
// `live` is what makes the buttons real — it's true only while the agent loop
// is actually parked on THIS approval. A bubble that was superseded still
// renders its record, but can never offer a button that does nothing.
const ApprovalPanel = ({ approval, live, onApprove, onDecline, approveLabel = 'Run this code', note = 'Runs locally and read-only. Sending a new message cancels it.' }) => {
  // Collapsed by default. The explanation is what the approval decision turns
  // on; the source is there for whoever wants to read it before allowing the
  // run, and the toggle says how many lines are waiting. Matches the code panel
  // below, which has always started collapsed.
  const [showCode, setShowCode] = useState(false);
  const code = approval.code || '';
  const lines = code ? code.split('\n').length : 0;
  const settled = approval.state === 'approved' ? 'approved'
    : approval.state === 'declined' ? 'declined'
      : (live ? 'pending' : 'declined');

  const label = settled === 'approved' ? 'Approved — code ran'
    : settled === 'declined' ? 'Not run' : 'Approve before this runs';
  const accent = settled === 'pending' ? '#b45309'
    : settled === 'approved' ? C.green : C.dim;

  return (
    <div style={{
      marginTop: 7, padding: '7px 8px', borderRadius: 4,
      background: settled === 'pending' ? '#fffbeb' : C.s2,
      border: `1px solid ${settled === 'pending' ? '#fcd34d' : C.border}`,
    }}>
      <div style={{
        fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
        color: accent, textTransform: 'uppercase', marginBottom: 4,
      }}>
        {label}
      </div>

      {approval.explanation && (
        <div style={{ color: C.text, fontSize: 12, lineHeight: 1.5, fontFamily: SANS }}>
          {approval.explanation}
        </div>
      )}
      {approval.warning && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 4, background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', fontSize: 11.5, lineHeight: 1.45, fontFamily: SANS }}>
          ⚠ {approval.warning}
        </div>
      )}

      {code && (
        <>
          <button type="button" onClick={() => setShowCode((v) => !v)}
            style={{
              marginTop: 5, padding: 0, background: 'none', border: 'none',
              cursor: 'pointer', color: C.muted, fontFamily: MONO, fontSize: 9.5,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
            <span style={{ display: 'inline-block', transform: showCode ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>›</span>
            {showCode ? 'Hide code' : `Show code · ${lines} line${lines === 1 ? '' : 's'}`}
          </button>
          {showCode && (
            <pre style={{
              margin: '5px 0 0', padding: '6px 7px', borderRadius: 3,
              background: '#fff', border: `1px solid ${C.border}`,
              fontFamily: MONO, fontSize: 9.5, lineHeight: 1.5, color: C.text,
              maxHeight: 132, overflow: 'auto', whiteSpace: 'pre', tabSize: 2,
            }}>
              {code}
            </pre>
          )}
        </>
      )}

      {settled === 'pending' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
            <button type="button" onClick={onApprove}
              style={{
                padding: '4px 10px', borderRadius: 4, border: 'none',
                background: C.accent, color: '#fff', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: SANS,
              }}>
              {approveLabel}
            </button>
            <button type="button" onClick={onDecline}
              style={{
                padding: '4px 10px', borderRadius: 4,
                border: `1px solid ${C.border2}`, background: '#fff',
                color: C.text, cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: SANS,
              }}>
              Don't run
            </button>
          </div>
          {note && (
            <div style={{ marginTop: 5, fontSize: 9.5, color: C.dim, fontFamily: SANS }}>
              {note}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── Node run approval — a built node waiting on the user to run it ────────
//
// A build writes the node's configuration; running it writes DATA, and a wrong
// transform can overwrite a table with something the user never wanted. So the
// build lands on the canvas and stops there: what actually executes is always
// this button. Same contract as the generated-JavaScript approval — say plainly
// what it will do, show every piece of code it will run, then ask.
const NODE_TYPE_LABEL = { transformer: 'Transformer', join: 'Join', dataSource: 'Data Source' };

// The code a node will execute, in the order it runs. Empty sections are
// dropped so the panel never shows an empty pane.
const nodeCodeSections = (config = {}) => {
  const out = [];
  const add = (label, lang, code) => {
    const text = typeof code === 'string' ? code : (code ? JSON.stringify(code, null, 2) : '');
    if (text && text.trim()) out.push({ label, lang, code: text.trim() });
  };
  add('Create table (DDL)', 'sql', config.targetDdl);
  add('SQL', 'sql', config.joinSql || config.targetSql);
  add('Insert', 'sql', config.insertSql);
  add('JavaScript', 'js', config.transformFunction || config.apiFetchCode);
  add('Python', 'py', config.pythonCode);
  add('NoSQL operation', 'json', config.nosqlOperation);
  add('Preview query', 'sql', config.targetPreviewSql || config.previewSql);
  return out;
};

/**
 * The reviewer found a mismatch and can say what would fix it. The user decides
 * whether it gets fixed — this is the decision, not a to-do list.
 *
 * "Fix it" does not repair anything here. It composes the edits into an
 * ordinary user turn and sends it, so the fix goes through the same builder,
 * review and approval path as any other request. Nothing is applied behind the
 * user's back, and a fix that is itself wrong gets reviewed like anything else.
 */
const ReviewFixPanel = ({ fix, onFix, onLeave, busy = false, stale = false }) => {
  const state = fix.state || 'pending';
  // Offered, never answered, and the user has since said something else — the
  // offer is spent. Applying it now would correct a workflow that may have been
  // rebuilt in between.
  if (state === 'pending' && stale) {
    return (
      <div style={{ marginTop: 7, fontSize: 11, color: C.dim, fontFamily: SANS }}>
        Not applied — you asked for something else.
      </div>
    );
  }
  if (state === 'dismissed') {
    return (
      <div style={{ marginTop: 7, fontSize: 11, color: C.dim, fontFamily: SANS }}>
        Left as it is.
      </div>
    );
  }
  // Past tense: this label outlives the turn it started, so "applying…" would
  // still be on screen long after the fix finished.
  if (state === 'sent') {
    return (
      <div style={{ marginTop: 7, fontSize: 11, color: C.muted, fontFamily: SANS }}>
        Asked to apply those changes{fix.workflowName ? ` to ${fix.workflowName}` : ''}.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {/* What the buttons act on. Several workflows can be under discussion in
          one conversation, so the target is named next to the decision rather
          than left to be inferred from the message above. */}
      {fix.workflowName && (
        <span style={{ fontSize: 11, color: C.muted, fontFamily: SANS, marginRight: 2 }}>
          Applies to <strong style={{ color: C.text }}>{fix.workflowName}</strong>:
        </span>
      )}
      <button type="button" onClick={onFix} disabled={busy}
        style={{
          padding: '4px 10px', borderRadius: 4, border: 'none',
          background: busy ? C.dim : C.accent, color: '#fff',
          cursor: busy ? 'default' : 'pointer',
          fontSize: 11, fontWeight: 600, fontFamily: SANS,
        }}>
        Fix it
      </button>
      <button type="button" onClick={onLeave} disabled={busy}
        style={{
          padding: '4px 10px', borderRadius: 4,
          border: `1px solid ${C.border}`, background: '#fff', color: C.muted,
          cursor: busy ? 'default' : 'pointer',
          fontSize: 11, fontWeight: 600, fontFamily: SANS,
        }}>
        Leave it
      </button>
    </div>
  );
};

// What the history list shows under a conversation's title. Most turns end on
// a node-run card (build → "Approve before this runs" → "Ran — data written"),
// which carries no `text` of its own, so reading only the last message's text
// labelled every such conversation "No messages yet".
const NODE_RUN_PREVIEW = {
  pending: 'Awaiting approval',
  running: 'Running',
  ran: 'Ran',
  failed: 'Run failed',
  skipped: 'Not run',
};
const conversationPreview = (messages) => {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind === 'nodeRun' && m.run) {
      const what = [NODE_RUN_PREVIEW[m.run.state || 'pending'], m.run.nodeLabel].filter(Boolean).join(' · ');
      const res = m.run.result;
      const outcome = typeof res === 'string' ? res : res?.message;
      return (outcome ? `${what} — ${outcome}` : what).slice(0, 80);
    }
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (text) return text.slice(0, 80);
  }
  return '';
};

const NodeRunPanel = ({ run, onRun, onSkip, stale = false, blockedReason = null }) => {
  const [showCode, setShowCode] = useState(false);
  const sections = useMemo(() => nodeCodeSections(run.config), [run.config]);
  // A join whose kept target must be dropped and recreated first (append /
  // merge into a table that no longer fits). Run is the approval.
  const rebuild = run.config?.joinSettings?.targetRebuild || null;
  // A run offered but never answered, with the conversation moved on, reads as
  // "not run" — the same as Skip. Keeping the button live would let a click
  // execute code against a node the later turns may have rebuilt.
  const state = (run.state || 'pending') === 'pending' && stale ? 'skipped' : (run.state || 'pending');

  const label = {
    pending: 'Approve before this runs',
    running: 'Running…',
    ran: 'Ran — data written',
    failed: 'Run failed',
    skipped: 'Not run',
  }[state];
  const accent = state === 'pending' ? '#b45309'
    : state === 'ran' ? C.green
      : state === 'failed' ? '#dc2626' : C.dim;

  return (
    <div style={{
      marginTop: 7, padding: '8px 9px', borderRadius: 4,
      background: state === 'pending' ? '#fffbeb' : C.s2,
      border: `1px solid ${state === 'pending' ? '#fcd34d' : C.border}`,
    }}>
      <div style={{
        fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
        color: accent, textTransform: 'uppercase', marginBottom: 4,
      }}>
        {label}
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: SANS, marginBottom: 3 }}>
        {NODE_TYPE_LABEL[run.nodeType] || 'Node'} · {run.nodeLabel}
      </div>
      {run.explanation && (
        <div style={{ color: C.text, fontSize: 12, lineHeight: 1.5, fontFamily: SANS }}>
          {run.explanation}
        </div>
      )}
      {run.writesTo && (
        <div style={{ marginTop: 4, fontSize: 11, color: C.muted, fontFamily: SANS }}>
          Writes to <strong style={{ color: C.text }}>{run.writesTo}</strong>
          {run.destination ? ` in ${run.destination}` : ''}.
        </div>
      )}
      {rebuild?.pending && (
        <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.45, color: '#b91c1c', fontFamily: SANS }}>
          Drops <strong>{rebuild.table}</strong>
          {Number.isFinite(rebuild.rowCount) ? ` (${rebuild.rowCount} row${rebuild.rowCount === 1 ? '' : 's'})` : ''}
          {' '}and recreates it — {rebuild.reason}. The rows in it now are deleted.
        </div>
      )}
      {rebuild?.pending && targetIsSourceWarning(rebuild) && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 4, background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', fontSize: 11.5, lineHeight: 1.45, fontFamily: SANS }}>
          ⚠ {targetIsSourceWarning(rebuild)}
        </div>
      )}

      {sections.length > 0 && (
        <>
          <button type="button" onClick={() => setShowCode((v) => !v)}
            style={{
              marginTop: 6, padding: 0, background: 'none', border: 'none',
              cursor: 'pointer', color: C.muted, fontFamily: MONO, fontSize: 9.5,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
            <span style={{ display: 'inline-block', transform: showCode ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>›</span>
            {showCode ? 'Hide code' : `Show code · ${sections.length} block${sections.length === 1 ? '' : 's'}`}
          </button>
          {showCode && sections.map((s) => (
            <div key={s.label} style={{ marginTop: 5 }}>
              <div style={{
                fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.06em',
                color: C.dim, textTransform: 'uppercase', marginBottom: 2,
              }}>{s.label}</div>
              <pre style={{
                margin: 0, padding: '6px 7px', borderRadius: 3,
                background: '#fff', border: `1px solid ${C.border}`,
                fontFamily: MONO, fontSize: 9.5, lineHeight: 1.5, color: C.text,
                maxHeight: 160, overflow: 'auto', whiteSpace: 'pre', tabSize: 2,
              }}>{s.code}</pre>
            </div>
          ))}
        </>
      )}

      {state === 'pending' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" onClick={blockedReason ? undefined : onRun}
              disabled={!!blockedReason}
              title={blockedReason || undefined}
              style={{
                padding: '4px 10px', borderRadius: 4, border: 'none',
                background: blockedReason ? C.s2 : C.accent,
                color: blockedReason ? C.dim : '#fff',
                cursor: blockedReason ? 'not-allowed' : 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: SANS,
              }}>
              Run this node
            </button>
            <button type="button" onClick={onSkip}
              style={{
                padding: '4px 10px', borderRadius: 4,
                border: `1px solid ${C.border2}`, background: '#fff',
                color: C.text, cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: SANS,
              }}>
              Not now
            </button>
          </div>
          <div style={{ marginTop: 5, fontSize: 9.5, color: blockedReason ? '#b45309' : C.dim, fontFamily: SANS }}>
            {blockedReason || 'The configuration is already saved on the canvas. Running it writes data — only this node runs, using whatever its sources last produced.'}
          </div>
        </>
      )}

      {run.result && (state === 'ran' || state === 'failed') && (
        <div style={{
          marginTop: 6, fontSize: 11, fontFamily: SANS,
          color: state === 'failed' ? '#dc2626' : C.muted,
        }}>
          {run.result}
        </div>
      )}
    </div>
  );
};

// ── Step bubble — streamed "thought + tool calls" turn ────────────────────
const StepBubble = ({ m, activeApprovalMsgId, onApproveCode, onDeclineCode }) => (
  <div style={{ display: 'flex', gap: 10 }}>
    <div style={{
      width: 26, height: 26, borderRadius: 4, flexShrink: 0,
      background: C.s2, border: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
    }}>
      {I('compass', C.muted, 12)}
    </div>
    {/* minWidth 0 is what lets this flex item shrink at all — without it a
        flex child refuses to go below its content's intrinsic width, so a long
        tool argument widened the bubble past maxWidth instead of wrapping. */}
    <div style={{ maxWidth: '90%', minWidth: 0, flex: '1 1 auto' }}>
      <div style={{
        padding: '8px 11px', borderRadius: 6, borderTopLeftRadius: 2,
        background: C.surface, border: `1px solid ${C.border}`,
        fontSize: 11, color: C.muted, lineHeight: 1.6,
        // Tool args, ids and paths are long runs with no spaces to break on.
        // `anywhere` (not `break-word`) also shrinks the box's min-content
        // width, which is what stops the content spilling past the border.
        overflowWrap: 'anywhere',
      }}>
        <div style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
          color: C.dim, textTransform: 'uppercase', marginBottom: 4,
        }}>
          Step {m.stepIndex}
        </div>
        {m.thinking && <ThinkingBlock text={m.thinking} />}
        {m.thought && (
          <div style={{ color: C.text, fontSize: 12, marginBottom: m.actions?.length ? 6 : 0 }}>
            {m.thought}
          </div>
        )}
        {Array.isArray(m.actions) && m.actions.map((a, i) => (
          <ActionLine key={i} action={a} />
        ))}
        {m.approval && (
          <ApprovalPanel
            approval={m.approval}
            live={activeApprovalMsgId === m.id}
            onApprove={() => onApproveCode && onApproveCode(m)}
            onDecline={() => onDeclineCode && onDeclineCode(m)}
            {...(m.approval.kind === 'presentation' ? {
              approveLabel: 'Run analysis',
              note: 'Runs locally and read-only, then writes the presentation from what it returns. Sending a new message cancels it.',
            } : {})}
          />
        )}
      </div>
      <div style={{ marginTop: 4, fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
    </div>
  </div>
);

// ── Build log — a live, compact list of build steps (NOT chat bubbles). ───
// Each line flips from a spinner to a ✓ as the main process streams progress.
const BUILD_STEP_LABEL = {
  start: 'Start', dataSource: 'Data source', transformer: 'Transformer',
  join: 'Join', output: 'Output', branch: 'Branch',
};
// What a running step is waiting on, keyed by the stage id the builder reports
// (workflowBuilder's reportStage). An unlisted stage shows its id rather than
// nothing: a new builder stage should read oddly, not vanish.
const BUILD_STAGE_LABEL = {
  'skillDocs:pick': 'choosing which docs to read',
  'join:readSchema': 'reading the source tables',
  'join:analysis': 'working out how to join the sources',
  'join:gen': 'writing the join',
  'join:skill': 'running the join skill',
  'transformer:analysis': 'working out the transformation',
  'transformer:gen': 'writing the transformation',
  'transformer:skill': 'running the transform skill',
  'dataSource:pickTable': 'picking the table',
  'dataSource:gen': 'configuring the source',
  'output:gen': 'configuring the output',
  'branch:gen': 'writing the conditions',
  'connection:pick': 'picking the connection',
};

// Re-render once a second while `active`, so the elapsed time on a running
// build step counts up. Off when nothing is running: a finished build log is a
// static list and has no business holding a timer.
const useSecondTick = (active) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
};
// The step lines themselves, shared by the pinned panel (build in flight) and
// the history bubble (build finished) so both read identically.
const BuildLogLines = ({ logs }) => {
  useSecondTick(logs.some((l) => l.status !== 'done'));
  if (!logs.length) {
    return <div style={{ fontSize: 11, color: C.dim, fontFamily: SANS }}>Preparing…</div>;
  }
  return logs.map((l) => {
    const isDone = l.status === 'done';
    return (
      <div key={l.stepIndex} style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0',
        fontSize: 11, fontFamily: SANS, color: isDone ? C.text : C.muted,
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 13, height: 13, borderRadius: 2, flexShrink: 0,
          background: isDone ? C.gD : C.s2,
          color: isDone ? C.green : C.dim, fontSize: 9, fontWeight: 700,
        }}>{isDone ? '✓' : '·'}</span>
        <span style={{ fontWeight: 600 }}>{BUILD_STEP_LABEL[l.stepType] || l.stepType}</span>
        {l.label && l.label !== (BUILD_STEP_LABEL[l.stepType] || l.stepType) && (
          <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            — {l.label}
          </span>
        )}
        {!isDone && (
          // What it is waiting on, and for how long. A step that reports no
          // stage yet still says "working…", but a step stuck on one model call
          // now names the call and counts — which is the difference between a
          // build that looks frozen and one you can see is still waiting.
          <span style={{ color: C.dim, fontSize: 10, fontStyle: 'italic' }}>
            {l.stage ? BUILD_STAGE_LABEL[l.stage] || l.stage : 'working'}
            {l.stageAt ? ` — ${Math.max(0, Math.round((Date.now() - l.stageAt) / 1000))}s` : '…'}
          </span>
        )}
      </div>
    );
  });
};

// ── Pinned build panel ────────────────────────────────────────────────────
// A build in flight lives HERE, not in the thread. It survives every pause for
// a clarification, so answering three questions leaves one panel that keeps
// filling in — rather than three build-log bubbles stacked in the transcript.
// It moves into the history (as a BuildLogBubble) only once the build reaches a
// terminal state: finished, failed, or cancelled.
const BuildPin = ({ run }) => {
  const [open, setOpen] = useState(true);
  if (!run) return null;
  const logs = Array.isArray(run.logs) ? run.logs : [];
  const doneCount = logs.filter((l) => l.status === 'done').length;
  const waiting = run.status === 'waiting' || run.status === 'paused';
  return (
    <div style={{
      flexShrink: 0, borderTop: `1px solid ${C.border}`,
      background: waiting ? '#fffbeb' : C.bg,
    }}>
      <div onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          userSelect: 'none', padding: '8px 14px',
        }}>
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: waiting ? '#92400e' : C.accent,
        }}>
          {waiting ? 'Build paused' : 'Building…'}
        </span>
        <span style={{ fontSize: 11, color: C.muted, fontFamily: SANS }}>
          {doneCount}/{logs.length || '…'} steps
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.06em',
          color: C.dim, textTransform: 'uppercase',
        }}>
          {open ? 'Hide' : 'Show'}
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 14px 10px 14px', maxHeight: 200, overflowY: 'auto' }}>
          <BuildLogLines logs={logs} />
          {run.note && (
            <div style={{
              marginTop: 6, fontSize: 11, fontFamily: SANS,
              color: waiting ? '#92400e' : C.muted,
            }}>
              {run.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const BuildLogBubble = ({ m }) => {
  const logs = Array.isArray(m.logs) ? m.logs : [];
  const done = !!m.done;
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <div style={{
        width: 26, height: 26, borderRadius: 4, flexShrink: 0,
        background: C.s2, border: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
      }}>
        {I('compass', C.muted, 12)}
      </div>
      <div style={{ maxWidth: '90%', minWidth: 200 }}>
        <div style={{
          padding: '8px 11px', borderRadius: 6, borderTopLeftRadius: 2,
          background: C.surface, border: `1px solid ${C.border}`,
        }}>
          <div style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.08em',
            color: C.dim, textTransform: 'uppercase', marginBottom: 6,
          }}>
            {done ? (m.summary ? 'Build log' : 'Build stopped') : 'Building…'}
          </div>
          <BuildLogLines logs={logs} />
        </div>
        <div style={{ marginTop: 4, fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
      </div>
    </div>
  );
};

// ── Thinking — the model's reasoning for a step, collapsed by default ─────
// Same disclosure idiom as ActionLine: one line you can scan, the whole thing
// on click. Only providers that expose reasoning (Claude) ever fill this.
const ThinkingBlock = ({ text }) => {
  const [open, setOpen] = useState(false);
  // Reasoning runs to many lines; the collapsed row shows the opening of it on
  // a single line so the block is identifiable without expanding.
  const preview = text.replace(/\s+/g, ' ').trim();
  return (
    <div style={{ marginBottom: 6 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 0, width: '100%', minWidth: 0, textAlign: 'left',
        }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 12, height: 12, borderRadius: 2, flexShrink: 0,
          background: C.s2, color: C.dim, fontSize: 8,
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms',
        }}>▶</span>
        <span style={{
          fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: C.dim, flexShrink: 0,
        }}>
          Thinking
        </span>
        {!open && (
          <span style={{
            fontFamily: SANS, fontSize: 11, color: C.dim, fontStyle: 'italic',
            minWidth: 0, flex: '1 1 auto',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {preview}
          </span>
        )}
      </button>
      {open && (
        <pre style={{
          margin: '4px 0 0 18px', padding: '6px 8px',
          background: '#fff', border: `1px solid ${C.border}`, borderRadius: 4,
          fontFamily: SANS, fontSize: 11, lineHeight: 1.6, color: C.muted,
          maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{text}</pre>
      )}
    </div>
  );
};

const ActionLine = ({ action }) => {
  const [open, setOpen] = useState(false);
  const ok = action.ok;
  const argsStr = (() => {
    try {
      const s = JSON.stringify(action.args || {});
      return s.length > 80 ? s.slice(0, 78) + '…' : s;
    } catch { return ''; }
  })();
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{
          // Wraps rather than running off the side: the args are a JSON blob
          // with few break opportunities, and a nowrap flex row pushed it past
          // the bubble's right edge. Aligned to the top so a wrapped second
          // line sits under the tool name rather than beside the tick.
          display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 0, color: ok ? C.accent : C.red,
          fontFamily: MONO, fontSize: 11, fontWeight: 600,
          maxWidth: '100%', minWidth: 0, textAlign: 'left',
        }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 12, height: 12, borderRadius: 2, flexShrink: 0, marginTop: 2,
          background: ok ? C.gD : C.rD,
          color: ok ? C.green : C.red, fontSize: 9,
        }}>{ok ? '✓' : '✗'}</span>
        <span style={{ color: C.text, minWidth: 0, overflowWrap: 'anywhere' }}>{action.tool}</span>
        <span style={{
          color: C.dim, fontWeight: 400,
          minWidth: 0, flex: '1 1 auto', overflowWrap: 'anywhere',
        }}>{argsStr}</span>
      </button>
      {open && (() => {
        // Arguments and result live in separate, labeled sections so the call
        // input is easy to distinguish from its output.
        let fullArgs = '';
        try { fullArgs = JSON.stringify(action.args || {}, null, 2); } catch { fullArgs = ''; }
        const isError = Boolean(action.error);
        const body = isError
          ? action.error
          : (typeof action.result === 'string'
              ? action.result
              : JSON.stringify(action.result, null, 2)).slice(0, 4000);

        const sectionLabel = {
          textTransform: 'uppercase', letterSpacing: '0.06em',
          fontFamily: MONO, fontSize: 9, fontWeight: 700,
          color: C.dim, margin: '0 0 3px 2px',
        };
        const codeBox = (color) => ({
          margin: 0, padding: '6px 8px',
          background: '#fff', border: `1px solid ${C.border}`, borderRadius: 4,
          fontFamily: MONO, fontSize: 10, color,
          maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        });

        return (
          <div style={{ margin: '4px 0 0 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div style={sectionLabel}>Arguments</div>
              <pre style={codeBox(C.muted)}>{fullArgs}</pre>
            </div>
            <div>
              <div style={{ ...sectionLabel, color: isError ? C.red : C.dim }}>
                {isError ? 'Error' : 'Result'}
              </div>
              <pre style={codeBox(isError ? C.red : C.muted)}>{body}</pre>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// Reload arrow used for the Retry action under bot bubbles.
const ReloadIcon = ({ color = C.muted, size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

// Fast-forward arrow used for the Continue action on truncated answers.
const ContinueIcon = ({ color = C.muted, size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 19 22 12 13 5 13 19" />
    <polygon points="2 19 11 12 2 5 2 19" />
  </svg>
);

// ── Inline action button shown below user/bot bubbles (edit / retry) ─────
// `icon` accepts either a string name (looked up in the shared icon set)
// or a React element so callers can pass a custom svg like ReloadIcon.
const InlineAction = ({ icon, label, onClick, color = C.muted, disabled = false }) => {
  const iconEl = typeof icon === 'string' ? I(icon, disabled ? C.dim : color, 11) : icon;
  return (
    <button type="button" onClick={onClick} title={label} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 6px', borderRadius: 4,
        background: 'transparent', border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 10, fontFamily: SANS, color: disabled ? C.dim : color,
      }}
      onMouseOver={(e) => { if (!disabled) e.currentTarget.style.background = C.s2; }}
      onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent'; }}>
      {iconEl} {label}
    </button>
  );
};

// ── Tabbed, collapsible visuals panel ──────────────────────────────────────
// Mirrors design/Chat Visual Sample.html. A bot message's visuals are folded
// into ONE collapsible panel pinned at the bottom of the bubble, with a tab
// per visual, instead of stacked inline boxes. The chart body reuses
// DataVisualization in `bare` mode — the panel supplies the framing, the
// uppercase title, and the footer.
const vizTabLabel = (v, i) => {
  const t = (v && typeof v.title === 'string') ? v.title.trim() : '';
  if (t) return t.length > 22 ? `${t.slice(0, 21)}…` : t;
  const byType = {
    bar: 'Bar', line: 'Line', pie: 'Pie', table: 'Table',
    box: 'Metric', scatter: 'Scatter', kpi: 'Overview',
  };
  return byType[v?.type] || `View ${i + 1}`;
};

const VisualsPanel = ({ visuals }) => {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState(0);
  if (!Array.isArray(visuals) || visuals.length === 0) return null;
  // Guard the active index against a visuals array that shrank between renders.
  const idx = Math.min(tab, visuals.length - 1);
  const active = visuals[idx];

  return (
    <div style={{
      marginTop: 10, background: '#fff', border: `1px solid ${C.border}`,
      borderRadius: 6, overflow: 'hidden',
    }}>
      {/* Header — click to collapse / expand the whole panel */}
      <div onClick={() => setOpen((o) => !o)}
        style={{
          padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', userSelect: 'none',
          background: open ? '#fff' : C.surface,
          borderBottom: open ? `1px solid ${C.border}` : 'none',
        }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Visualizations</span>
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, color: C.accent,
          background: C.aD, border: '1px solid #bfdbfe', padding: '1px 6px', borderRadius: 10,
        }}>{visuals.length}</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.06em',
          color: C.muted, textTransform: 'uppercase',
        }}>
          {open ? 'Collapse' : `Show ${visuals.length} view${visuals.length === 1 ? '' : 's'}`}
        </span>
        <span style={{
          display: 'flex', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s',
        }}>
          {I('chevron', C.muted, 14)}
        </span>
      </div>

      {open && (
        <>
          {/* Tab strip — text labels only, one tab per visual */}
          {visuals.length > 1 && (
            <div style={{
              display: 'flex', borderBottom: `1px solid ${C.border}`,
              overflowX: 'auto', background: C.surface, paddingLeft: 4,
            }}>
              {visuals.map((v, i) => {
                const on = i === idx;
                return (
                  <button key={i} type="button" onClick={() => setTab(i)}
                    style={{
                      padding: '9px 14px', border: 'none',
                      background: on ? '#fff' : 'transparent', cursor: 'pointer',
                      borderBottom: on ? `2px solid ${C.accent}` : '2px solid transparent',
                      marginBottom: -1, color: on ? C.accent : C.muted,
                      fontWeight: on ? 700 : 500, fontSize: 11, fontFamily: SANS, whiteSpace: 'nowrap',
                    }}>
                    {vizTabLabel(v, i)}
                  </button>
                );
              })}
            </div>
          )}

          {/* Active visual — natural height, capped and scrollable when taller */}
          <div style={{ maxHeight: 380, overflowY: 'auto', padding: '12px 14px' }}>
            {active.title && (
              <div style={{
                fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
                color: C.muted, textTransform: 'uppercase', marginBottom: 10,
              }}>{active.title}</div>
            )}
            <DataVisualization visualizationData={active} onSaveToMain={null} hideMenu bare compact />
          </div>

          {/* Footer */}
          <div style={{
            padding: '8px 14px', borderTop: `1px solid ${C.border}`, background: C.surface,
            fontSize: 9, fontFamily: MONO, color: C.dim, letterSpacing: '0.04em',
          }}>
            View {idx + 1} of {visuals.length} · {active.type}
          </div>
        </>
      )}
    </div>
  );
};

// ── Invalid AI response — expandable "raw response" node ──────────────────
// Shown when the workflow builder got a reply that wasn't valid JSON. Mirrors
// the interactive transformer/join treatment: collapsed by default, click to
// reveal the exact raw text the model returned.
const InvalidResponsePanel = ({ raw }) => {
  const [open, setOpen] = useState(false);
  if (!raw) return null;
  return (
    <div style={{
      marginTop: 10, background: '#fff', border: `1px solid #fecaca`,
      borderRadius: 6, overflow: 'hidden',
    }}>
      <div onClick={() => setOpen((o) => !o)}
        style={{
          padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', userSelect: 'none',
          background: open ? '#fff' : C.rD,
          borderBottom: open ? `1px solid ${C.border}` : 'none',
        }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.red }}>raw response</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.06em',
          color: C.muted, textTransform: 'uppercase',
        }}>
          {open ? 'Collapse' : 'View raw response'}
        </span>
        <span style={{ display: 'flex', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
          {I('chevron', C.muted, 14)}
        </span>
      </div>
      {open && (
        <pre style={{
          margin: 0, padding: '10px 12px', maxHeight: 300, overflow: 'auto',
          fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: C.text,
          background: C.surface, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{raw}</pre>
      )}
    </div>
  );
};

// ── Chat bubble — user + final assistant + error ──────────────────────────
// `isEditing` flips the user bubble into an inline editor (ChatGPT-style):
// the message body becomes a textarea with Save/Cancel. Saving truncates
// the conversation from this point and re-sends the edited text via the
// parent's onSaveEdit handler; Cancel just discards the draft.
// Which agent authored a bot message. Shown as a hover note on the bubble so the
// origin of a reply — the assistant itself, the workflow planner, a node builder,
// or a skill — is discoverable without adding clutter to the transcript.
const AGENT_LABELS = {
  main:        'Ternlux Assistant (main agent)',
  workflow:    'Workflow builder agent',
  planner:     'Workflow planner',
  builder:     'Node builder',
  reviewer:    'Change reviewer',
  // NOTE: no 'node-router' entry. The build gate never authors a reply — when a
  // message isn't an answer to the builder's pending question it hands back to
  // the main agent, and the main agent's own label applies.
};
/**
 * Is a node's builder still waiting on the user? True when the newest reply in
 * the conversation (tool steps, build logs and run cards skipped; the user's own
 * messages skipped, so it stays true while their answer is being handled) is a
 * question that builder asked about THAT node.
 */
const awaitingBuilderAnswer = (messages, nodeId) => {
  if (!nodeId || !Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (m.kind === 'step' || m.kind === 'buildLog' || m.kind === 'nodeRun') continue;
    const fromBuilder = m.agentSource === 'builder' || String(m.agentSource || '').startsWith('skill:');
    return !!(m.clarification && fromBuilder && m.context?.nodeId === nodeId);
  }
  return false;
};

const agentLabel = (source) => {
  if (!source) return null;
  const s = String(source);
  if (s.startsWith('skill:')) return `Skill "${s.slice(6)}"`;
  return AGENT_LABELS[s] || s;
};

const Bubble = ({ m, onAction, onEdit, onRetry, onContinue, onApproveCode, onDeclineCode, onRunNode, onSkipNode, onBuildApproval, runBlockedReason = null, activeApprovalMsgId = null, isEditing, onSaveEdit, onCancelEdit, busy = false, stale = false, retryable = true, planBlockedReason = null }) => {
  const isUser = m.role === 'user';
  const plan = !isUser && !m.error && m.workflowPlan && Array.isArray(m.workflowPlan.steps)
    ? m.workflowPlan
    : null;
  const bodyText = m.text;
  const canEdit  = isUser && typeof onEdit === 'function';
  // `retryable` is decided by the parent, which can see the bubble's neighbours:
  // only the last answer of a turn gets the button, since retrying any earlier
  // bubble in the same run re-sends the identical user message (see
  // retryableIdx). The local conditions still apply on top of it.
  const canRetry = retryable && !isUser && !m.error && m.kind === 'final' && typeof onRetry === 'function';
  // Offered on a bubble whose answer stopped at the model's output limit —
  // `resume` carries what the model wrote plus the inputs needed to finish it.
  const canContinue = !isUser && !!(m.resume && m.resume.partialText) && typeof onContinue === 'function';

  // Local draft state — lives in the bubble so cancelling restores the
  // original text without touching parent state. Hooks must run on every
  // render path (rules-of-hooks), so they're declared BEFORE any early
  // return like the step-bubble passthrough below.
  const [draft, setDraft] = useState(bodyText || '');
  useEffect(() => { if (isEditing) setDraft(bodyText || ''); }, [isEditing, bodyText]);

  if (m.kind === 'step') {
    return (
      <StepBubble
        m={m}
        activeApprovalMsgId={activeApprovalMsgId}
        onApproveCode={onApproveCode}
        onDeclineCode={onDeclineCode}
      />
    );
  }
  if (m.kind === 'buildLog') return <BuildLogBubble m={m} />;

  // A node that was just built, parked on the user's go-ahead to run.
  if (m.kind === 'nodeRun') {
    return (
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 4, flexShrink: 0,
          background: C.s2, border: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
        }}>
          {I('compass', C.muted, 12)}
        </div>
        <div style={{ maxWidth: '90%', minWidth: 80 }}>
          <NodeRunPanel
            run={m.run || {}}
            stale={stale}
            blockedReason={runBlockedReason ? runBlockedReason(m.run || {}) : null}
            onRun={() => onRunNode && onRunNode(m)}
            onSkip={() => onSkipNode && onSkipNode(m)}
          />
          <div style={{ marginTop: 4, fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
        </div>
      </div>
    );
  }

  if (isUser && isEditing) {
    const saveDisabled = !draft.trim() || busy;
    return (
      <div style={{ display: 'flex', gap: 10, flexDirection: 'row-reverse' }}>
        <div style={{
          width: 26, height: 26, borderRadius: 4, flexShrink: 0,
          background: C.aD, border: '1px solid #bfdbfe',
          display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
        }}>
          {I('user', C.accent, 12)}
        </div>
        <div style={{ maxWidth: '82%', minWidth: 240, width: '82%' }}>
          <div style={{
            padding: '8px 10px', borderRadius: 6,
            border: `1px solid ${C.border2}`, background: '#fff',
          }}>
            <textarea
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!saveDisabled) onSaveEdit(m.id, draft);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancelEdit?.();
                }
              }}
              rows={Math.max(2, Math.min(8, (draft.match(/\n/g) || []).length + 2))}
              style={{
                width: '100%', border: 'none', outline: 'none', resize: 'vertical',
                fontFamily: SANS, fontSize: 12, lineHeight: 1.6, color: C.text,
                background: 'transparent', padding: 0,
              }}
            />
            <div style={{
              display: 'flex', gap: 6, justifyContent: 'flex-end',
              marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}`,
            }}>
              <button type="button" onClick={onCancelEdit}
                style={{
                  padding: '4px 10px', borderRadius: 4,
                  border: `1px solid ${C.border}`, background: '#fff',
                  cursor: 'pointer', fontSize: 11, fontWeight: 600,
                  color: C.muted, fontFamily: SANS,
                }}>Cancel</button>
              <button type="button" onClick={() => onSaveEdit(m.id, draft)}
                disabled={saveDisabled}
                style={{
                  padding: '4px 12px', borderRadius: 4, border: 'none',
                  background: saveDisabled ? C.s2 : C.accent,
                  cursor: saveDisabled ? 'default' : 'pointer',
                  fontSize: 11, fontWeight: 600,
                  color: saveDisabled ? C.dim : '#fff', fontFamily: SANS,
                }}>Save & submit</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10, flexDirection: isUser ? 'row-reverse' : 'row' }}>
      <div style={{
        width: 26, height: 26, borderRadius: 4, flexShrink: 0, marginBottom: 3,
        background: isUser ? C.aD : C.s2,
        border: `1px solid ${isUser ? '#bfdbfe' : C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
      }}>
        {I(isUser ? 'user' : 'compass', isUser ? C.accent : C.muted, 12)}
      </div>
      <div style={{ maxWidth: '82%', minWidth: 80 }}>
        <div
          title={!isUser && agentLabel(m.agentSource) ? `Answered by ${agentLabel(m.agentSource)}` : undefined}
          style={{
          padding: '10px 13px', borderRadius: 6,
          background: isUser ? C.accent : C.bg,
          border: isUser ? 'none' : `1px solid ${C.border}`,
          color: isUser ? '#fff' : C.text,
          borderTopLeftRadius:  isUser ? 6 : 2,
          borderTopRightRadius: isUser ? 2 : 6,
          fontSize: 12, lineHeight: 1.65, wordBreak: 'break-word',
          boxShadow: isUser ? 'none' : '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          {m.error
            ? <span style={{ color: C.red }}>{m.text}</span>
            : <Markdown text={bodyText} />}
          {/* A plan build parked on generated code it wants to run (a REST API
              fetch whose columns the next steps are built from). Nothing runs
              until Run is clicked; Don't run stops the build. */}
          {m.buildApproval && (m.buildApproval.kind === 'target_rebuild' ? (
            <ApprovalPanel
              approval={m.buildApproval}
              live={m.buildApproval.state === 'pending' && !stale}
              approveLabel="Approve drop and recreate"
              note="Nothing is dropped now: the table is recreated on this join's next run, then appended or merged into as usual. Don't run stops the build."
              onApprove={() => onBuildApproval && onBuildApproval(m, true)}
              onDecline={() => onBuildApproval && onBuildApproval(m, false)}
            />
          ) : (
            <ApprovalPanel
              approval={{
                ...m.buildApproval,
                explanation: [
                  m.buildApproval.endpoint ? `Calls ${m.buildApproval.endpoint}` : null,
                  m.buildApproval.explanation || null,
                ].filter(Boolean).join(' — '),
              }}
              live={m.buildApproval.state === 'pending' && !stale}
              approveLabel="Run this call"
              note="It calls the API once with the connection's saved credentials and stores the rows in this workflow, so the next steps can be built from its columns. Don't run stops the build."
              onApprove={() => onBuildApproval && onBuildApproval(m, true)}
              onDecline={() => onBuildApproval && onBuildApproval(m, false)}
            />
          ))}
          {plan && (
            <PlanCard
              plan={plan}
              status={m.planStatus || { kind: 'idle' }}
              stale={stale}
              blockedReason={planBlockedReason}
              onAccept={() => onAction && onAction('accept-plan', plan, m.id)}
              onCancel={() => onAction && onAction('cancel-plan', plan, m.id)}
            />
          )}
          {!isUser && !m.error && Array.isArray(m.visuals) && m.visuals.length > 0 && (
            <VisualsPanel visuals={m.visuals} />
          )}
          {!isUser && !m.error && m.presentation && (
            <PresentationCard presentation={m.presentation} />
          )}
          {!isUser && m.invalidJson && (
            <InvalidResponsePanel raw={m.invalidJson} />
          )}
          {!isUser && m.reviewFix && (
            <ReviewFixPanel
              fix={m.reviewFix}
              busy={busy}
              stale={stale}
              onFix={() => onAction && onAction('apply-review-fix', m.reviewFix, m.id)}
              onLeave={() => onAction && onAction('dismiss-review-fix', m.reviewFix, m.id)}
            />
          )}
        </div>
        <div style={{
          marginTop: 4, display: 'flex',
          alignItems: 'center', gap: 4,
          flexDirection: isUser ? 'row-reverse' : 'row',
        }}>
          <div style={{ fontSize: 9, color: C.dim, fontFamily: MONO }}>{m.ts}</div>
          {canEdit && (
            <InlineAction icon="edit" label="Edit"
              onClick={() => onEdit(m.id)}
              disabled={busy} />
          )}
          {canRetry && (
            <InlineAction icon={<ReloadIcon color={busy ? C.dim : C.muted} />} label="Retry"
              onClick={() => onRetry(m.id)}
              disabled={busy} />
          )}
          {canContinue && (
            <InlineAction icon={<ContinueIcon color={busy ? C.dim : C.accent} />} label="Continue"
              color={C.accent}
              onClick={() => onContinue(m.id)}
              disabled={busy} />
          )}
        </div>
      </div>
    </div>
  );
};

// ── Typing indicator ───────────────────────────────────────────────────────
const Typing = ({ stage }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
    <div style={{
      width: 26, height: 26, borderRadius: 4, background: C.s2,
      border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{I('compass', C.muted, 12)}</div>
    <div style={{
      padding: '10px 14px', background: C.bg, border: `1px solid ${C.border}`,
      borderRadius: '6px 6px 6px 2px', display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 11, color: C.muted, fontFamily: SANS,
    }}>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        {[0, 1, 2].map((n) => (
          <span key={n} style={{
            width: 5, height: 5, borderRadius: '50%', background: C.dim,
            animation: 'dgblink 1.4s ease infinite',
            animationDelay: `${n * 0.2}s`,
          }} />
        ))}
      </span>
      {stage}
    </div>
    <style>{`@keyframes dgblink { 0%,80%,100% { opacity: 0.3 } 40% { opacity: 1 } }`}</style>
  </div>
);

// ── Suggestion grid (empty state) ──────────────────────────────────────────
const SugGrid = ({ onPick }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, width: '100%', maxWidth: 480 }}>
    {SUGGESTIONS_EMPTY.map((s) => (
      <button key={s.title} type="button" onClick={() => onPick(s.title)}
        style={{
          textAlign: 'left', padding: '10px 12px', borderRadius: 6,
          border: `1px solid ${C.border}`, background: '#fff',
          cursor: 'pointer', fontFamily: SANS,
        }}
        onMouseOver={(e) => { e.currentTarget.style.background = C.aD; e.currentTarget.style.borderColor = '#bfdbfe'; }}
        onMouseOut={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = C.border; }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 2, letterSpacing: '-0.01em' }}>{s.title}</div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>{s.sub}</div>
      </button>
    ))}
  </div>
);

// ── Composer ───────────────────────────────────────────────────────────────
// The textarea grows with what's typed, from its two-row resting height up to
// twice that, then scrolls. Both bounds come from measuring the element rather
// than arithmetic on the font size, so they follow the styling.
const COMPOSER_MAX_GROWTH = 2;

const Composer = ({ value, setValue, onSend, onCancel, busy }) => {
  const sendDisabled = busy || !value.trim();
  const taRef = useRef(null);
  const [restingH, setRestingH] = useState(0);

  // The `rows={2}` height, taken once before any explicit height is set.
  useLayoutEffect(() => {
    if (restingH || !taRef.current) return;
    setRestingH(taRef.current.clientHeight);
  }, [restingH]);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el || !restingH) return;
    const max = restingH * COMPOSER_MAX_GROWTH;
    // 'auto' first: scrollHeight only reports the content's height when the box
    // isn't already holding it open from the previous keystroke.
    el.style.height = 'auto';
    const content = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(content, restingH), max)}px`;
    // Past the ceiling the textarea scrolls; below it there is nothing to
    // scroll and a visible scrollbar would just flicker.
    el.style.overflowY = content > max ? 'auto' : 'hidden';
  }, [value, restingH]);

  return (
    <div style={{ padding: '12px 14px', borderTop: `1px solid ${C.border}`, background: C.bg, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{
          flex: 1, position: 'relative', background: C.bg,
          border: `1px solid ${C.border}`, borderRadius: 6,
        }}>
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendDisabled) onSend(); }
            }}
            placeholder="Ask about workflows, connections, or your data…"
            rows={2}
            disabled={busy}
            style={{
              width: '100%', border: 'none', padding: '10px 12px',
              fontSize: 12, fontFamily: SANS, color: C.text,
              resize: 'none', outline: 'none', lineHeight: 1.6,
              background: 'transparent', display: 'block',
              // Height is driven by the auto-grow effect above; hidden until it
              // measures, so the first paint isn't a scrollbar flash.
              overflowY: 'hidden',
            }}
          />
        </div>
        {busy ? (
          <button type="button" onClick={onCancel} title="Stop the assistant"
            style={{
              width: 38, height: 38, borderRadius: 5, background: C.red,
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
            {/* stop square */}
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="2" y="2" width="8" height="8" rx="1" fill="#fff" />
            </svg>
          </button>
        ) : (
          <button type="button" onClick={onSend} disabled={sendDisabled} title="Send (Enter)"
            style={{
              width: 38, height: 38, borderRadius: 5,
              background: sendDisabled ? C.s2 : C.accent,
              border: 'none', cursor: sendDisabled ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'background 0.15s',
            }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke={sendDisabled ? C.dim : '#fff'} strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};

// ── Conversation history sidebar (expanded mode only) ──────────────────────
// Each row carries a 3-dots menu (Delete / Export). Export downloads the
// conversation as a JSON file; Delete removes it from both in-memory state
// and the chatSessions NeDB collection via the parent's callbacks.
// `onClose` switches it to the popup variant: full width of whatever it is
// dropped into, with a title bar instead of a right border.
const HistorySidebar = ({
  conversations, activeId, onSelect, onNewChat, onDeleteConvo, onExportConvo,
  // Ids of conversations with a turn in flight. Run state is per chat, so a
  // chat left thinking while the user works in another one has to say so here
  // — otherwise the only way to find it again is to open each in turn.
  busyIds = null,
  width = 260, onClose = null,
}) => {
  // Newest first.
  const sorted = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [conversations],
  );
  return (
    <div style={{
      width, borderRight: onClose ? 'none' : `1px solid ${C.border}`, background: C.bg,
      display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: 0,
      ...(onClose ? { height: '100%' } : null),
    }}>
      {onClose && (
        <div style={{
          padding: '10px 10px 10px 14px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          {I('clock', C.muted, 13)}
          <div style={{ flex: 1, fontSize: 12, fontWeight: 600, color: C.text, letterSpacing: '-0.01em' }}>
            Chat history
          </div>
          <button type="button" onClick={onClose} title="Back to chat"
            style={{
              padding: 6, borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
            }}>
            {I('x', C.muted, 14)}
          </button>
        </div>
      )}
      <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${C.border}` }}>
        <button type="button" onClick={onNewChat}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 10px', borderRadius: 5,
            background: C.accent, border: `1px solid ${C.accent}`, cursor: 'pointer',
            fontSize: 12, fontWeight: 600, color: '#fff', fontFamily: SANS,
          }}>
          {I('plus', '#fff', 12)} New chat
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
        <div style={{
          padding: '4px 8px 6px', fontSize: 9, fontFamily: MONO, fontWeight: 700,
          letterSpacing: '0.1em', color: C.dim, textTransform: 'uppercase',
        }}>
          History · {sorted.length}
        </div>
        {sorted.map((c) => {
          const isActive = c.id === activeId;
          const isBusy = !!busyIds?.has(c.id);
          const preview = isBusy
            ? 'Working…'
            : (conversationPreview(c.messages) || 'No messages yet');
          return (
            <div key={c.id} onClick={() => onSelect(c.id)}
              style={{
                padding: '9px 10px', borderRadius: 5, cursor: 'pointer', marginBottom: 1,
                background: isActive ? C.aD : 'transparent',
                border: `1px solid ${isActive ? '#bfdbfe' : 'transparent'}`,
                transition: 'all 0.12s',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              onMouseOver={(e) => { if (!isActive) e.currentTarget.style.background = C.surface; }}
              onMouseOut={(e)  => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: C.text, letterSpacing: '-0.01em',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  {isBusy && (
                    <span title="This chat is waiting on a reply" style={{
                      width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                      background: C.accent, animation: 'dgconvobusy 1.4s ease infinite',
                    }} />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title}
                  </span>
                </div>
                <div style={{
                  fontSize: 10, marginTop: 2,
                  color: isBusy ? C.accent : C.muted,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {preview}
                </div>
              </div>
              <MoreMenu items={[
                { label: 'Export Chat', icon: 'edit', onClick: () => onExportConvo?.(c.id) },
                { label: 'Delete',      icon: 'trash', danger: true, onClick: () => onDeleteConvo?.(c.id) },
              ]} />
            </div>
          );
        })}
      </div>
      <style>{'@keyframes dgconvobusy { 0%,80%,100% { opacity: 0.25 } 40% { opacity: 1 } }'}</style>
    </div>
  );
};

// ── Drag-to-move + hold-against-the-right-edge-to-pin ──────────────────────
// Owns where the popup sits. `pos` is null until the user drags it, so an
// untouched assistant keeps its bottom-right anchor across window resizes.
// While a drag is inside the right-edge band the dock arms after a short hold
// — releasing then pins the panel to a full-height rail on the right.
const useChatWindow = () => {
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));
  // Pinned to the right rail by default — the assistant is part of the app's
  // layout, not a window the user has to place. Unpinning drops it back to a
  // floating panel for the rest of the session.
  const [docked, setDocked] = useState(true);
  const [pos, setPos] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [dockHint, setDockHint] = useState(null); // null | 'hold' | 'ready'
  const [railPx, setRailPx] = useState(null);     // null = the default 30%
  const [resizing, setResizing] = useState(false);

  // The pointer handlers run outside React's render, so the hint they branch
  // on lives in a ref; `dockHint` is only the copy the UI paints from.
  const hintRef = useRef(null);
  const holdRef = useRef(null);

  const clamp = useCallback((left, top) => {
    const w = Math.min(PANEL_W, window.innerWidth - EDGE_GAP * 2);
    const h = Math.min(PANEL_H, window.innerHeight - EDGE_GAP * 2);
    return {
      left: Math.min(Math.max(EDGE_GAP, left), Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP)),
      top: Math.min(Math.max(EDGE_GAP, top), Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP)),
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setPos((p) => (p ? clamp(p.left, p.top) : p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  useEffect(() => () => clearTimeout(holdRef.current), []);

  const clearHint = useCallback(() => {
    clearTimeout(holdRef.current);
    hintRef.current = null;
    setDockHint(null);
  }, []);

  const startDrag = useCallback((e) => {
    if (e.button !== 0) return;
    // Header controls (restart / new chat / maximize / close) stay clickable.
    if (e.target.closest('button, a, input, textarea, select, [data-no-drag]')) return;
    const panel = e.currentTarget.closest('[data-chat-panel]');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const st = {
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };

    const onMove = (ev) => {
      if (!st.moved) {
        // A few pixels of slop so a click on the header isn't a micro-drag.
        if (Math.abs(ev.clientX - st.startX) < 4 && Math.abs(ev.clientY - st.startY) < 4) return;
        st.moved = true;
        setDragging(true);
        setDocked(false); // dragging a pinned panel lifts it back out
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      const next = clamp(ev.clientX - st.offX, ev.clientY - st.offY);
      setPos(next);

      const w = Math.min(PANEL_W, window.innerWidth - EDGE_GAP * 2);
      const inZone = window.innerWidth - (next.left + w) <= DOCK_ZONE
        || ev.clientX >= window.innerWidth - DOCK_ZONE;
      if (inZone && !hintRef.current) {
        hintRef.current = 'hold';
        setDockHint('hold');
        holdRef.current = setTimeout(() => {
          hintRef.current = 'ready';
          setDockHint('ready');
        }, DOCK_HOLD_MS);
      } else if (!inZone && hintRef.current) {
        clearHint();
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Held long enough against the edge → pin. A quick pass through the
      // band just leaves the panel floating where it was dropped.
      if (hintRef.current === 'ready') setDocked(true);
      clearHint();
      setDragging(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [clamp, clearHint]);

  // Left-edge handle on the pinned rail. The width is just the distance from
  // the pointer to the right of the window, clamped to the rail's bounds, so
  // dragging left widens and dragging right narrows.
  const startRailResize = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev) => setRailPx(railWidthFor(window.innerWidth, window.innerWidth - ev.clientX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setResizing(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  // Pin button: dock straight away, or drop the panel back to a floating
  // window sitting where the rail was.
  const togglePinned = useCallback(() => {
    if (!docked) { setDocked(true); return; }
    // Unpinning drops the window back into the corner the rail occupied,
    // unless the user had already parked it somewhere.
    setPos((p) => p || clamp(window.innerWidth, window.innerHeight));
    setDocked(false);
  }, [docked, clamp]);

  const width = Math.min(PANEL_W, viewport.w - EDGE_GAP * 2);
  const height = Math.min(PANEL_H, viewport.h - EDGE_GAP * 2);
  const railWidth = railWidthFor(viewport.w, railPx);

  // Pinned, the panel is not an overlay: it is a real column in the app's
  // top-level flex row, so the rest of the UI reflows beside it and nothing
  // ends up hidden behind it.
  const panelStyle = docked
    ? {
      position: 'relative', alignSelf: 'stretch', flexShrink: 0,
      width: railWidth, height: '100%',
      borderRadius: 0, border: 'none', borderLeft: `1px solid ${C.border}`,
      boxShadow: 'none',
    }
    : {
      position: 'fixed',
      ...(pos ? { left: pos.left, top: pos.top } : { right: 24, bottom: 24 }),
      width, height, borderRadius: 10,
      border: `1px solid ${C.border}`,
      boxShadow: dragging
        ? '0 32px 80px rgba(0,0,0,0.28), 0 4px 16px rgba(0,0,0,0.10)'
        : '0 24px 64px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.06)',
    };

  return {
    docked, dragging, dockHint, startDrag, togglePinned, panelStyle,
    railWidth, resizing, startRailResize,
  };
};

// Grab strip down the pinned rail's inner edge. Invisible until hovered so it
// doesn't read as a second border.
const RailResizer = ({ onPointerDown, active }) => (
  <div
    onPointerDown={onPointerDown}
    title="Drag to resize"
    style={{
      position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, zIndex: 4,
      cursor: 'col-resize', touchAction: 'none',
      background: active ? C.accent : 'transparent',
      opacity: active ? 0.6 : 1,
      transition: 'background 0.12s, opacity 0.12s',
    }}
    onMouseOver={(e) => { if (!active) e.currentTarget.style.background = C.border; }}
    onMouseOut={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
  />
);

// Ghost rail painted under the panel while a drag is inside the right-edge
// band — it fills as the hold completes, then reads "release to pin".
const DockPreview = ({ state, width }) => {
  const ready = state === 'ready';
  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width,
      zIndex: CHAT_Z - 1, pointerEvents: 'none', fontFamily: SANS,
      background: ready ? 'rgba(37,99,235,0.14)' : 'rgba(37,99,235,0.06)',
      borderLeft: `2px ${ready ? 'solid' : 'dashed'} ${C.accent}`,
      transition: 'background 0.15s ease',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 96,
    }}>
      <style>{'@keyframes dgdockfill { from { width: 0% } to { width: 100% } }'}</style>
      <div style={{
        background: '#fff', border: `1px solid ${ready ? C.accent : C.border}`,
        borderRadius: 8, padding: '10px 14px', minWidth: 190,
        boxShadow: '0 8px 24px rgba(15,23,42,0.14)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          fontSize: 11, fontWeight: 600, color: ready ? C.accent : C.muted,
          letterSpacing: '-0.01em',
        }}>
          <IconPin color={ready ? C.accent : C.muted} size={12} />
          {ready ? 'Release to pin right' : 'Hold to pin right…'}
        </div>
        <div style={{ height: 3, borderRadius: 2, background: C.s2, marginTop: 8, overflow: 'hidden' }}>
          <div style={{
            height: '100%', background: C.accent, borderRadius: 2,
            width: ready ? '100%' : undefined,
            animation: ready ? 'none' : `dgdockfill ${DOCK_HOLD_MS}ms linear forwards`,
          }} />
        </div>
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────
const ChatAssistant = ({ activeContext: incomingContext = null, onWorkflowBuilt = null }) => {
  // Open on the right from the start. App.js only mounts the assistant once the
  // terms + analytics choice is recorded and an AI provider is configured, so
  // being mounted at all means the app is ready to answer — there is nothing to
  // gain from making the user click the launcher first. Closing it hides it for
  // the rest of the session.
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // Where the popup sits: free-floating (draggable) or pinned to the right rail.
  const {
    docked, dragging, dockHint, startDrag, togglePinned, panelStyle,
    railWidth, resizing, startRailResize,
  } = useChatWindow();
  // Popup mode has no room for a permanent sidebar, so history opens as a
  // panel over the conversation instead.
  const [historyOpen, setHistoryOpen] = useState(false);

  // The rail only reserves space when it is actually on screen: not while the
  // assistant is closed or maximized. A node-config panel opening no longer
  // takes the rail down — both stay visible, side by side.
  const railActive = docked && open && !expanded;
  // Full-screen overlays (`position: fixed; inset: 0`) are laid out against
  // the viewport, so the rail would otherwise cover them. Publishing its width
  // lets App.css shrink them — both the in-tree ones (via containment on the
  // app column) and antd's, which portal to <body> and escape that.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--chat-rail-w', railActive ? `${railWidth}px` : '0px');
    document.body.classList.toggle('chat-pinned', railActive);
    return () => {
      root.style.setProperty('--chat-rail-w', '0px');
      document.body.classList.remove('chat-pinned');
    };
  }, [railActive, railWidth]);
  const [input, setInput] = useState('');
  const [pinnedContext, setPinnedContext] = useState(null);

  // ── Per-conversation run state ───────────────────────────────────────────
  // A turn belongs to the conversation it was sent from, NOT to whichever chat
  // happens to be on screen while it runs. Starting a new chat (or switching to
  // one) used to inherit the running chat's spinner: "Thinking…" over an empty
  // transcript, a disabled composer, and a Stop button that cancelled someone
  // else's turn — while the chat actually working looked idle the moment you
  // came back to it.
  //
  // So everything a live turn owns is keyed by conversation id: whether it is
  // busy, the stage label, the cancel flag, which loop owns the convo, and any
  // parked code approval. `runRef` is authoritative and `runStates` is its
  // render mirror — `send`'s re-entry guard has to read the CURRENT value
  // synchronously, before React has re-rendered (the same reason agentLoopRef
  // exists below).
  //   runRef.current: { [convoId]: { busy: true, stage: string } }
  const runRef = useRef({});
  const [runStates, setRunStates] = useState({});
  const patchRun = useCallback((convoId, patch) => {
    if (!convoId) return;
    const cur = runRef.current[convoId] || { busy: false, stage: 'Thinking…' };
    const next = { ...cur, ...patch };
    const map = { ...runRef.current };
    // An idle conversation carries no entry at all, so a stage set outside a
    // turn (reviewChange during an Accept-plan build, say) stays invisible
    // rather than lighting the chat up as busy.
    if (next.busy) map[convoId] = next;
    else delete map[convoId];
    runRef.current = map;
    setRunStates(map);
  }, []);
  const setConvoBusy = useCallback((convoId, busy, stageText) => {
    patchRun(convoId, stageText === undefined ? { busy } : { busy, stage: stageText });
  }, [patchRun]);
  const setConvoStage = useCallback((convoId, stageText) => {
    patchRun(convoId, { stage: stageText });
  }, [patchRun]);
  const isConvoBusy = useCallback((convoId) => !!runRef.current[convoId]?.busy, []);

  // Multi-conversation state. New chat starts fresh; switching conversations
  // swaps in their messages. History sidebar (expanded mode) lists them all.
  // The initial in-memory list is replaced by whatever load-on-mount finds
  // in the `chatSessions` NeDB collection (see useEffect below).
  const [conversations, setConversations] = useState(() => [blankConvo()]);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  // Which user message (if any) is currently being edited inline.
  const [editingMsgId, setEditingMsgId] = useState(null);
  // Conversation ids whose view has been "soft restarted" — the messages
  // array on disk is unchanged, but we show an empty chat. Switching away
  // or closing the panel drops the override; sending a new message commits
  // it by wiping the stored conversation. See `restartChat` and `send`.
  const [restartedConvoIds, setRestartedConvoIds] = useState(() => new Set());
  // Track which conversation ids have been seeded from disk so the
  // save-on-change effect doesn't overwrite real history with placeholder
  // state during the initial render.
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const activeConvo = useMemo(
    () => conversations.find((c) => c.id === activeId) || conversations[0],
    [conversations, activeId],
  );
  const isRestarted = restartedConvoIds.has(activeId);
  const messages = (isRestarted ? [] : activeConvo?.messages) || [];

  // Everything below renders the FOCUSED conversation's run state. Another
  // chat's turn keeps running in the background with its own entry in
  // `runStates`; it simply isn't what this panel is showing.
  const loading = !!runStates[activeId]?.busy;
  const stage = runStates[activeId]?.stage || 'Thinking…';
  // Which conversations are mid-turn — the history list badges them so a chat
  // left thinking is still visible after switching away from it.
  const busyConvoIds = useMemo(
    () => new Set(Object.keys(runStates).filter((id) => runStates[id]?.busy)),
    [runStates],
  );

  // Read by reviewChange for the pre-build lookups. A ref rather than a
  // dependency: runBuild and send both close over reviewChange, and making it
  // change identity on every message would churn the whole callback chain.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Index of the last USER message. Anything offering a choice above it — Accept
  // plan, Fix it, Run this node — is an offer the user has already answered by
  // moving on, so its buttons go. Leaving them live means a click acts on
  // something several turns stale: accepting a plan the conversation has since
  // replaced, or applying a fix to a workflow that was rebuilt afterwards.
  //
  // Derived at render rather than patched onto messages when a turn is sent, so
  // it stays right for a conversation reloaded from storage and cannot drift
  // out of step with the transcript.
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') return i;
    }
    return -1;
  }, [messages]);

  // Which bubbles may offer Retry: the LAST retryable answer in each run of
  // back-to-back assistant messages, i.e. the one immediately before the next
  // user turn (or the end of the transcript).
  //
  // One turn routinely appends several bubbles — the answer, a reviewer
  // verdict, a build confirmation, a warnings list — and every one of them used
  // to carry its own Retry. They were not alternatives: handleRetryMessage
  // walks back to the nearest preceding USER message, which is the same message
  // for every bubble in the run, so all those buttons trimmed to the same point
  // and re-sent the same thing. A column of identical buttons that reads as a
  // choice between "retry from here" and "retry from there" when there is none.
  //
  // The run is scanned rather than just taking the last bubble, because the
  // final message of a turn is often one that can't be retried at all (a
  // nodeRun panel, a build log), and the answer above it is what the user means
  // by "try that again".
  const retryableIdx = useMemo(() => {
    const eligible = new Set();
    let candidate = -1;
    messages.forEach((m, i) => {
      if (m?.role === 'user') { candidate = -1; return; }
      // Mirrors Bubble's own test — a bubble that would never draw the button
      // must not claim the run's slot and hide it from the answer above.
      if (m && !m.error && m.kind === 'final') {
        if (candidate >= 0) eligible.delete(candidate);
        candidate = i;
        eligible.add(i);
      }
    });
    return eligible;
  }, [messages]);

  // The open editor has uncommitted work. Broadcast by WorkflowEditor; false
  // whenever no editor is open, so a closed canvas can never leave a plan
  // stuck.
  const [canvasDirty, setCanvasDirty] = useState(false);
  useEffect(() => {
    const handler = (e) => setCanvasDirty(!!e.detail?.dirty);
    window.addEventListener('ternlux:workflow-dirty', handler);
    return () => window.removeEventListener('ternlux:workflow-dirty', handler);
  }, []);

  // Why Accept plan is unavailable, or null when it is fine to click. Building
  // reads the workflow from the database, so unsaved canvas edits would be
  // planned against the older saved copy and then overwritten. The save gate
  // enforces this at click time either way; saying it on the button turns a
  // refusal into an instruction.
  const planBlockedReason = canvasDirty
    ? 'Save the workflow first — this plan builds from the saved version, so unsaved canvas edits would be overwritten.'
    : null;
  // Whether the NEXT message goes to the workflow sub-agent rather than the
  // main assistant — the same condition `send` reads off the convo when it
  // stamps a new user message. A restarted chat always starts on main, so its
  // stored mode doesn't count.
  const inWorkflowAgent = !isRestarted && activeConvo?.agentMode === 'workflow';

  const scrollRef = useRef(null);
  // Cancel flags — the conversation ids whose turn the user has stopped.
  // Checked between steps; cancellation just means "do not issue the next
  // chat:step call" for THAT conversation. The currently in-flight call still
  // completes, but its result is discarded. Keyed by convo so Stop in one chat
  // cannot end a turn running in another.
  const cancelledRef = useRef(new Set());
  // The build currently in flight, pinned above the composer rather than
  // appended to the thread: { logs, status: 'running'|'waiting'|'paused', note }.
  // It spans EVERY pass of one build — each clarification the builder raises
  // pauses and resumes into this same panel — and is committed to the history
  // as a single build-log message once the build finishes, fails, or is
  // cancelled. Null when no build is running.
  //
  // The ref is authoritative and the state is its render mirror: progress
  // events arrive from the main process, outside React's batching, so reading
  // the ref keeps every update against the newest logs — and it lets the commit
  // below read the final logs without doing work inside a state updater.
  const buildRunRef = useRef(null);
  const [buildRun, setBuildRun] = useState(null);
  const setPin = useCallback((next) => {
    buildRunRef.current = typeof next === 'function' ? next(buildRunRef.current) : next;
    setBuildRun(buildRunRef.current);
  }, []);

  // Generated code waiting on the user's Approve/Decline.
  //
  // The agent loop does not unwind while it waits — it awaits the promise
  // parked here, so `scratchpad`, `history`, agent mode and step index all
  // stay alive in the running send() closure and the loop simply resumes on
  // approval. The three exits (Run / Don't run / a new user message) all go
  // through `settleApproval`, which is what guarantees the loop can never be
  // left suspended.
  //   Map<convoId, { msgId, runToken, resolve }>
  // One entry per conversation: two chats can each be parked on their own
  // approval, and neither Approve button may settle the other's promise.
  const approvalRef = useRef(new Map());
  // Per conversation, the id of the step whose approval that chat's loop is
  // parked on. Drives which panel may show working buttons — a superseded step
  // keeps its record but can never offer a control that does nothing.
  //   { [convoId]: msgId }
  const [awaitingApprovalByConvo, setAwaitingApprovalByConvo] = useState({});
  const awaitingApproval = awaitingApprovalByConvo[activeId] || null;
  // The conversation ids a send() turn currently owns. `runStates` can't serve
  // here: it's state, so a send() closure that settles an approval and waits
  // for the old turn to unwind would still read the stale value.
  const agentLoopRef = useRef(new Set());

  // `send` is defined far below these handlers, so Edit and Retry cannot list
  // it as a dependency — naming it in a dep array would read the binding during
  // render, before its `const` is initialized, and throw. Reaching it through a
  // ref instead is what keeps them on the CURRENT send: memoized on
  // [activeConvo, …], they otherwise keep whichever send existed when they were
  // last rebuilt. (send's own busy guard reads `runRef`, so it no longer goes
  // stale with the closure — but the handlers still need the send bound to the
  // conversation the user is actually looking at.)
  const sendRef = useRef(null);

  // How many times IN A ROW the user has clicked "Fix it" on a review verdict.
  //
  // The reviewer's remediation is re-sent to the builder as its next brief, so a
  // wrong verdict becomes the next round's specification and each round drifts
  // further from what the user actually asked for. The reviewer is told the
  // count so it can stop proposing variations of its own earlier correction.
  //
  // Only the button increments it (`fromReviewFix` on the message). A message
  // the user TYPED — even one that repeats the suggested fix in their own words
  // — resets it to 0: that is a fresh instruction from a human, not the loop
  // feeding itself. Counted per conversation — rounds spent in one chat say
  // nothing about the reviewer's record in another.
  //   { [convoId]: number }
  const fixRoundsRef = useRef({});

  // Settle the approval parked on ONE conversation. Returns false when that
  // chat has nothing waiting, so a stale click is distinguishable.
  const settleApproval = useCallback((decision, convoId) => {
    if (!convoId) return false;
    const pending = approvalRef.current.get(convoId);
    if (!pending) return false;
    approvalRef.current.delete(convoId);
    setAwaitingApprovalByConvo((prev) => {
      if (!(convoId in prev)) return prev;
      const next = { ...prev };
      delete next[convoId];
      return next;
    });
    pending.resolve(decision);
    return true;
  }, []);

  // What this conversation is about, resolved to ONE shape that both the chip
  // and the backend read as-is.
  //
  // The workflow editor reports a workflow the user just created the only way
  // it can: by the id it is scoped by, since there is no name until they type
  // one and no database row until the first save. Two things get settled here
  // rather than downstream, so nothing has to re-derive them:
  //   • name — an unnamed workflow is shown (and described to the model) by its
  //     id, and swaps to the real name the moment the user sets one.
  //   • id — dropped while the workflow is unsaved. It addresses nothing yet,
  //     and every workflow tool looks its target up in the database, so sending
  //     it would turn "the workflow you have open" into "Workflow not found".
  //     Without an id a build request is planned as a new workflow, which is
  //     exactly what an unsaved canvas is.
  //   • unsaved — kept on the payload rather than folded into `summary`. The
  //     backend turns it into a RULE (see the unsaved-workflow block in the main
  //     prompt), because knowing there is no stored copy is not the same as
  //     knowing what to do about it: told only that the canvas was unreadable,
  //     the model answered a question about a node it could not see by guessing
  //     between two similarly-named connections instead of asking the user to
  //     save. The fix is to say "ask them to save", where the model reads rules.
  const effectiveContext = useMemo(() => {
    if (pinnedContext === 'cleared') return null;
    const ctx = pinnedContext || incomingContext;
    if (!ctx || ctx.kind !== 'workflow') return ctx;
    if (!ctx.unsaved) return { ...ctx, unsaved: false, name: ctx.name || ctx.id || null };
    return {
      ...ctx,
      name: ctx.name || ctx.id || null,
      id: null,
      unsaved: true,
    };
  }, [pinnedContext, incomingContext]);

  useEffect(() => { setPinnedContext(null); }, [incomingContext?.kind, incomingContext?.id]);

  // The node the canvas currently has in focus (Transformer/Join/API source),
  // broadcast by WorkflowEditor via the 'ternlux:node-focus' window event. It
  // rides along on every chat:step as `targetNode` so the main prompt can route
  // to that node's builder. The ref is read inside the async send loop; the
  // state drives the launcher label ("Edit {type}") and the focus chip.
  const [canvasFocusNode, setCanvasFocusNode] = useState(null);
  // The user X'd the node chip — the node stays selected on the canvas, but it
  // is out of the conversation until the chat is reopened or another node is
  // clicked. Deliberately NOT persisted: reopening the panel is what restores
  // the canvas selection as context.
  const [focusDismissed, setFocusDismissed] = useState(false);
  const focusNodeRef = useRef(null);
  // What the canvas has selected right now, as opposed to `canvasFocusNode`,
  // which can outlive a deselect (below).
  const canvasSelectionRef = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      const detail = e.detail || null;
      // The workflow closed: whatever was focused is gone with the canvas.
      if (detail && detail.closed) {
        canvasSelectionRef.current = null;
        setCanvasFocusNode(null);
        return;
      }
      canvasSelectionRef.current = detail;
      if (detail) { setCanvasFocusNode(detail); return; }
      // Deselected — the node panel closed, or the canvas was clicked. If this
      // node's builder asked a question that is still waiting for its answer,
      // keep the node in the conversation: the question is on screen, and the
      // reply has to reach that builder. Dropping the focus here is what used
      // to hand the answer to the main agent with only the workflow in view,
      // which read it as a request to change the workflow and planned one.
      setCanvasFocusNode((prev) => (
        prev && awaitingBuilderAnswer(messagesRef.current, prev.nodeId) ? prev : null
      ));
    };
    window.addEventListener('ternlux:node-focus', handler);
    return () => window.removeEventListener('ternlux:node-focus', handler);
  }, []);
  // The workflow the editor has open right now (WorkflowEditor broadcasts it,
  // and null when it closes). A node's run card only works on that workflow's
  // canvas: the editor is what runs a node.
  const [openWorkflowId, setOpenWorkflowId] = useState(null);
  useEffect(() => {
    const handler = (e) => setOpenWorkflowId(e.detail?.workflowId || null);
    window.addEventListener('ternlux:workflow-open', handler);
    return () => window.removeEventListener('ternlux:workflow-open', handler);
  }, []);
  // Why a "Run this node" card can't run right now — its workflow is not the
  // one open — or null when it can. A card from before the workflow id was
  // recorded is checked only for "is any workflow open".
  const runBlockedReason = useCallback((run) => {
    if (!run) return null;
    const name = run.workflowName ? `"${run.workflowName}"` : 'its workflow';
    if (run.workflowId) {
      return run.workflowId === openWorkflowId ? null : `Open ${name} to run this node.`;
    }
    return openWorkflowId ? null : 'Open the workflow this node belongs to, to run it.';
  }, [openWorkflowId]);
  // A node kept in focus only because its builder was waiting is released once
  // that question has been answered and nothing on the canvas is selected.
  useEffect(() => {
    if (canvasSelectionRef.current || !canvasFocusNode) return;
    if (!awaitingBuilderAnswer(messages, canvasFocusNode.nodeId)) setCanvasFocusNode(null);
  }, [messages, canvasFocusNode]);
  // Clicking a different node always brings it into the conversation, even if
  // the previous one had been dismissed.
  useEffect(() => { setFocusDismissed(false); }, [canvasFocusNode?.nodeId]);
  // Opening the panel re-syncs both chips with what the app currently has
  // selected — a dismissal only lasts as long as the panel stays open.
  useEffect(() => {
    if (open) {
      setFocusDismissed(false);
      setPinnedContext(null);
    }
  }, [open]);

  const focusNode = focusDismissed ? null : canvasFocusNode;
  // The send loop reads the ref, so keep it in step with the dismissal.
  focusNodeRef.current = focusNode;

  // What a message was ABOUT, recorded on it when it is written: the workflow
  // in view and the node in focus. It travels with the chat history to the
  // model (see the [context] lines in public/chat/chatAssistant.js), so a turn
  // read later still says which node's builder asked a question, or which
  // workflow a reply was about — even after the focus has moved on.
  const effectiveContextRef = useRef(null);
  effectiveContextRef.current = effectiveContext;
  const snapshotContext = useCallback(() => {
    const ctx = effectiveContextRef.current;
    const node = focusNodeRef.current;
    const wf = ctx && ctx.kind === 'workflow' ? ctx : null;
    const out = {
      workflowId: wf?.id || node?.workflowId || null,
      workflowName: wf?.name || null,
      nodeId: node?.nodeId || null,
      nodeType: node?.type || null,
      nodeLabel: node ? (String(node.label || '').trim() || null) : null,
    };
    return (out.workflowId || out.workflowName || out.nodeId) ? out : null;
  }, []);

  // ── Join destination ─────────────────────────────────────────────────────
  // A focused Join with nowhere to write can't be built at all, so the picker
  // takes over the top of the panel until it is settled. The list is loaded
  // lazily — only when such a node is actually in focus.
  const joinNeedsDestination = !!focusNode
    && focusNode.type === 'join'
    && !hasJoinDestination(focusNode.config);
  const [joinDestinations, setJoinDestinations] = useState([]);
  const [loadingDestinations, setLoadingDestinations] = useState(false);

  useEffect(() => {
    if (!joinNeedsDestination) return undefined;
    let cancelled = false;
    setLoadingDestinations(true);
    (async () => {
      const list = await loadJoinDestinations();
      if (cancelled) return;
      setJoinDestinations(list);
      setLoadingDestinations(false);
    })();
    return () => { cancelled = true; };
  }, [joinNeedsDestination, focusNode?.nodeId]);


  // A node form can hand off to the chat — the Data Source form does this after
  // saving a REST API connection, since the request is authored here via
  // build_dataSource.
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('ternlux:open-chat', handler);
    return () => window.removeEventListener('ternlux:open-chat', handler);
  }, []);
  const FOCUS_TYPE_LABEL = { transformer: 'Transformer', join: 'Join', dataSource: 'Data Source' };
  const focusTypeLabel = focusNode ? (FOCUS_TYPE_LABEL[focusNode.type] || 'Node') : null;
  // The launcher names the node the way the canvas does — its own label — and
  // only falls back to the node type when the label is still the generic one.
  const focusNodeLabel = focusNode
    ? (String(focusNode.label || '').trim() || focusTypeLabel)
    : null;

  // Drop edit-mode and any soft-restart override whenever the user switches
  // conversations so the textarea doesn't follow them to a different chat
  // and a previously-restarted view reverts to its stored messages.
  useEffect(() => {
    setEditingMsgId(null);
    setRestartedConvoIds(new Set());
  }, [activeId]);

  // Closing the panel keeps everything as it was — the panel is hidden, not
  // unmounted (see `launcher` below), and nothing is reset on the way out.

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open, expanded, activeId]);

  // ── Persistence: chatSessions NeDB collection ──────────────────────────
  // Conversations live in the same kind of NeDB store as workflows/connections.
  // On mount we load everything (newest first); on subsequent state changes a
  // debounced upsert writes each conversation back so refreshes don't lose
  // history. Each row's _id is the in-memory conversation id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.electronAPI?.db?.find) {
        hydratedRef.current = true;
        return;
      }
      try {
        const rows = await window.electronAPI.db.find(
          'chatSessions', {}, { updatedAt: -1 }, 0, 0,
        );
        if (cancelled) return;
        if (Array.isArray(rows) && rows.length > 0) {
          const restored = rows.map((r) => ({
            id: r.id || r._id,
            title: r.title || 'New chat',
            messages: Array.isArray(r.messages)
              ? r.messages.map((mm) => {
                  const withId = (mm && mm.id) ? mm : { ...mm, id: newMsgId() };
                  // A node run that was in flight when the app closed has no
                  // promise waiting on it any more — offer the button again
                  // rather than leaving a spinner that never resolves.
                  return withId.run?.state === 'running'
                    ? { ...withId, run: { ...withId.run, state: 'pending' } }
                    : withId;
                })
              : [],
            agentMode: r.agentMode || 'main',
            workflowSession: r.workflowSession || null,
            pendingBuild: r.pendingBuild || null,
            updatedAt: r.updatedAt || Date.now(),
            createdAt: r.createdAt || Date.now(),
          }));
          setConversations(restored);
          setActiveId(restored[0].id);
        }
      } catch (err) {
        console.warn('[ChatAssistant] failed to load chat history:', err.message);
      } finally {
        hydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced upsert of the conversations that can actually be changing: the
  // one on screen, plus any with a turn still in flight. Writing the whole list
  // back on every keystroke is wasted I/O, but "active only" is no longer
  // enough — a chat left thinking while the user starts a new one goes on
  // appending its answer in the background, and those messages have to reach
  // disk without waiting for the user to switch back to it.
  //
  // Switching chats changes activeConvo's reference, which fires this for the
  // newly-focused chat (so even a brand-new chat from "+ New chat" is persisted
  // as soon as it is selected).
  const convosToPersist = useMemo(() => {
    const ids = new Set([activeId, ...busyConvoIds]);
    return conversations.filter((c) => ids.has(c.id));
  }, [conversations, activeId, busyConvoIds]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!window.electronAPI?.db?.update) return;
    if (!convosToPersist.length) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      for (const c of convosToPersist) {
        const doc = {
          id: c.id,
          title: c.title || 'New chat',
          messages: c.messages || [],
          agentMode: c.agentMode || 'main',
          workflowSession: c.workflowSession || null,
          pendingBuild: c.pendingBuild || null,
          updatedAt: c.updatedAt || Date.now(),
          createdAt: c.createdAt || Date.now(),
        };
        try {
          // eslint-disable-next-line no-await-in-loop
          await window.electronAPI.db.update(
            'chatSessions',
            { id: c.id },
            { $set: sanitizeForNedb(doc) },
            { upsert: true },
          );
        } catch (err) {
          console.warn('[ChatAssistant] failed to persist chat history:', err.message);
        }
      }
    }, 400);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [convosToPersist]);

  const updateConvo = useCallback((id, patch) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c)));
  }, []);

  // A brand-new conversation starts idle no matter what the chat being left
  // behind is doing. Nothing here touches another convo's run state — a turn in
  // flight keeps its own entry in `runStates`, its own Stop flag and its own
  // parked approval, and goes on writing into the conversation that asked.
  const newChat = useCallback(() => {
    const fresh = blankConvo();
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setInput('');
  }, []);

  // Mark the focused conversation as "soft restarted" — the stored messages
  // are left alone, but the view shows an empty chat. Switching conversations
  // or closing the panel reverts to the persisted messages; sending a new
  // message (see `send`) commits the wipe.
  const restartChat = useCallback(() => {
    if (!activeId) return;
    setRestartedConvoIds((prev) => {
      if (prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
    setEditingMsgId(null);
    setInput('');
  }, [activeId]);

  // Delete a conversation. Removes from in-memory state, the chatSessions
  // NeDB collection, and ensures we always have at least one convo open.
  const deleteConvo = useCallback(async (convoId) => {
    if (!convoId) return;
    // A turn still running for this chat has nowhere left to write. Stop it and
    // release everything keyed by the id so a deleted conversation can't leave
    // a busy entry, a parked approval promise, or a fix-round tally behind.
    cancelledRef.current.add(convoId);
    settleApproval({ approved: false }, convoId);
    setConvoBusy(convoId, false);
    delete fixRoundsRef.current[convoId];
    try {
      if (window.electronAPI?.db?.remove) {
        await window.electronAPI.db.remove('chatSessions', { id: convoId }, {});
      }
    } catch (err) {
      console.warn('[ChatAssistant] failed to remove convo from db:', err.message);
    }
    setConversations((prev) => {
      const remaining = prev.filter((c) => c.id !== convoId);
      if (remaining.length === 0) {
        const fresh = blankConvo();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (convoId === activeId) {
        setActiveId(remaining[0].id);
      }
      return remaining;
    });
  }, [activeId, settleApproval, setConvoBusy]);

  // Export the conversation as a JSON file download. The blob is built and
  // released immediately after the click — no need to keep object URLs.
  const exportConvo = useCallback((convoId) => {
    const target = conversations.find((c) => c.id === convoId);
    if (!target) return;
    try {
      const payload = JSON.stringify({
        id: target.id,
        title: target.title,
        agentMode: target.agentMode || 'main',
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        messages: target.messages,
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const safeTitle = String(target.title || 'chat').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ternlux-chat-${safeTitle}-${target.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.warn('[ChatAssistant] export failed:', err.message);
    }
  }, [conversations]);

  // Stop only ever stops the chat the user is looking at — another
  // conversation's turn keeps running.
  const cancel = useCallback(() => {
    if (!activeId) return;
    cancelledRef.current.add(activeId);
    // Stop while code is waiting on approval means "don't run it".
    settleApproval({ approved: false }, activeId);
  }, [activeId, settleApproval]);

  // The two buttons on a code-approval bubble. Both just settle the promise
  // the parked loop is awaiting; the loop owns everything that happens next.
  // Bubbles only render for the focused chat, so the approval looked up is
  // always that chat's.
  const handleApproveCode = useCallback((m) => {
    if (approvalRef.current.get(activeId)?.msgId !== m.id) return;   // stale bubble
    settleApproval({ approved: true }, activeId);
  }, [activeId, settleApproval]);

  const handleDeclineCode = useCallback((m) => {
    if (approvalRef.current.get(activeId)?.msgId !== m.id) return;
    settleApproval({ approved: false }, activeId);
  }, [activeId, settleApproval]);

  // Append a message to the active conversation. Reads `prev` so it stays
  // safe under concurrent updates from inside the step loop. Every message
  // gets a stable id so per-message UI (e.g. plan-card status) can target it.
  const appendMessage = useCallback((msg) => {
    const stamped = msg.id ? msg : { ...msg, id: newMsgId() };
    setConversations((prev) => prev.map((c) => (
      c.id === activeId
        ? { ...c, messages: [...c.messages, stamped], updatedAt: Date.now() }
        : c
    )));
    return stamped.id;
  }, [activeId]);

  // Write a destination pick onto the focused Join, in the same shape
  // set_join_destination and buildJoinConfig use — whichever route settled it,
  // the builder finds the destination already resolved. `partial` says this
  // settles a setting rather than building the node.
  const pickJoinDestination = useCallback((dest) => {
    const node = focusNodeRef.current;
    if (!node) return;
    const isLocal = String(dest.value || '').startsWith('local-');
    const conn = dest.connection || {};
    const config = {
      joinSettings: { ...(node.config?.joinSettings || {}), destinationSelection: dest.value },
      targetConnectionId: dest.value,
      targetConnectionName: isLocal ? dest.label : conn.name,
      targetConnectionType: isLocal ? 'file' : (conn.connectionType || 'database'),
      targetDbType: isLocal ? String(dest.value).replace(/^local-/, '') : conn.dbType,
      targetDbConfig: isLocal ? {} : (conn.dbConfig || {}),
    };
    window.dispatchEvent(new CustomEvent('ternlux:apply-node-config', {
      detail: { nodeId: node.nodeId, nodeType: 'join', config, partial: true },
    }));
    appendMessage({
      role: 'assistant', kind: 'final', ts: nowTs(),
      text: `Destination set: **${config.targetConnectionName}**${
        isLocal
          ? (config.targetDbType === 'lancedb'
            ? ' — the joined rows are embedded and written to a table in the local LanceDB directory.'
            : ' — the joined rows are written as a table in this workflow\'s own DuckDB database.')
          : ` (${config.targetDbType})`
      }\n\nNow tell me how the sources should be joined.`,
    });
  }, [appendMessage]);

  // Patch fields on a specific message by id (used by the plan card to
  // record accept/cancel status without re-running the agent).
  const patchMessage = useCallback((msgId, patch) => {
    setConversations((prev) => prev.map((c) => (
      c.id === activeId
        ? {
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
            updatedAt: Date.now(),
          }
        : c
    )));
  }, [activeId]);

  // ── Running a built node ─────────────────────────────────────────────────
  //
  // Deliberately NOT part of the agent loop. The build is finished and saved
  // by the time this panel appears, so the turn does not wait on it — the user
  // can read the SQL, go look at the canvas, and come back. The panel stays
  // live for as long as the conversation does.
  const handleRunNode = useCallback(async (m) => {
    const run = m.run || {};
    if (run.state && run.state !== 'pending') return;
    if (runBlockedReason(run)) return;
    patchMessage(m.id, { run: { ...run, state: 'running' } });

    const result = await new Promise((resolve) => {
      // WorkflowEditor owns the graph and answers through this callback. If no
      // editor is mounted nothing responds, so time out rather than hang.
      const timer = setTimeout(
        () => resolve({ success: false, message: 'No open workflow could run that node.' }),
        120000,
      );
      const detail = {
        nodeId: run.nodeId,
        // The card showed the drop-and-recreate warning, so Run approves it.
        approveRebuild: !!run.config?.joinSettings?.targetRebuild?.pending,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
      };
      window.dispatchEvent(new CustomEvent('ternlux:execute-node', { detail }));
      // The editor marks the event as taken synchronously. Nobody took it: no
      // workflow is open, so say so now instead of waiting out the timer.
      if (!detail.handled) {
        clearTimeout(timer);
        resolve({ notOpen: true });
      }
    });

    // Nothing ran — the card goes back to waiting, runnable once the workflow
    // is open again, rather than ending as a failure the user cannot retry.
    if (result?.notOpen) {
      patchMessage(m.id, { run: { ...run, state: 'pending' } });
      return;
    }

    patchMessage(m.id, {
      run: {
        ...run,
        state: result?.success ? 'ran' : 'failed',
        result: result?.success
          ? `${result.recordsProcessed ? `${result.recordsProcessed} records · ` : ''}${result.message || 'Done.'}`
          : (result?.message || 'The node failed to run.'),
      },
    });
  }, [patchMessage, runBlockedReason]);

  const handleSkipNode = useCallback((m) => {
    const run = m.run || {};
    if (run.state && run.state !== 'pending') return;
    patchMessage(m.id, { run: { ...run, state: 'skipped' } });
  }, [patchMessage]);

  // Fold one build-progress event into the pinned build's `logs`. A 'running'
  // Right-click anywhere in the panel → the native Copy/Paste menu. Electron
  // draws no context menu of its own, so without this a right-click does
  // nothing at all. The menu itself is built in the main process (roles need
  // the WebContents); all the renderer contributes is what sits under the
  // pointer — a selection to copy, and whether the target can be pasted into.
  const showTextMenu = useCallback((e) => {
    if (!window.electronAPI?.ui?.showTextContextMenu) return;
    e.preventDefault();
    const el = e.target;
    const editable = !!el && (
      el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !el.readOnly && !el.disabled)
      || el.isContentEditable
    );
    // An input's own selection doesn't show up in window.getSelection(), so ask
    // the field directly when the pointer is over one.
    const fieldSelection = editable && typeof el.selectionStart === 'number'
      && el.selectionEnd > el.selectionStart;
    const hasSelection = fieldSelection
      || String(window.getSelection?.() || '').length > 0;
    window.electronAPI.ui.showTextContextMenu({ hasSelection, isEditable: editable });
  }, []);

  // event appends a new line; the matching 'done' event flips that line's
  // status. Events arriving with no build pinned are dropped — there is nothing
  // in flight for them to belong to.
  const applyBuildProgress = useCallback((evt) => {
    if (!evt) return;
    // A 'stage' event names the call a running step is waiting on right now
    // (workflowBuilder's reportStage). It carries no step fields of its own, so
    // it only ever annotates a line the 'step' events above already created —
    // and a step with no line yet is a build we aren't showing.
    if (evt.phase === 'stage') {
      setPin((prev) => {
        if (!prev) return prev;
        const idx = prev.logs.findIndex((l) => l.stepIndex === evt.stepIndex);
        if (idx < 0) return prev;
        const logs = prev.logs.slice();
        logs[idx] = { ...logs[idx], stage: evt.stage, stageAt: Date.now() };
        return { ...prev, logs };
      });
      return;
    }
    if (evt.phase !== 'step') return;
    setPin((prev) => {
      if (!prev) return prev;
      const logs = prev.logs.slice();
      const idx = logs.findIndex((l) => l.stepIndex === evt.stepIndex);
      const line = {
        stepIndex: evt.stepIndex,
        stepType: evt.stepType,
        label: evt.label,
        action: evt.action,
        status: evt.status,
      };
      if (idx >= 0) logs[idx] = { ...logs[idx], ...line };
      else logs.push(line);
      return { ...prev, logs };
    });
  }, [setPin]);

  // Move the pinned build into the transcript as ONE build-log message and drop
  // the pin. Called on every terminal outcome — finished, failed, cancelled —
  // so the history keeps a record while only a live build stays pinned.
  const commitBuildPin = useCallback((summary = null) => {
    const run = buildRunRef.current;
    setPin(null);
    if (!run || !run.logs.length) return;
    // Append to the conversation the build BELONGS to, not whichever one is
    // active — the user may have switched chats while it was parked.
    const stamped = {
      id: newMsgId(),
      role: 'assistant', kind: 'buildLog', ts: nowTs(),
      logs: run.logs, done: true,
      ...(summary ? { summary } : {}),
    };
    setConversations((prev) => prev.map((c) => (
      c.id === run.convoId
        ? { ...c, messages: [...c.messages, stamped], updatedAt: Date.now() }
        : c
    )));
  }, [setPin]);

  // Subscribe once to the main process's build-progress stream.
  useEffect(() => {
    const api = window.electronAPI?.workflow;
    if (!api?.onBuildProgress) return undefined;
    const unsub = api.onBuildProgress((evt) => applyBuildProgress(evt));
    return () => { try { unsub && unsub(); } catch (_) { /* ignore */ } };
  }, [applyBuildProgress]);

  // Review a change the builder just applied — creation, modification, or a
  // single node rebuilt from chat — against the brief that produced it, which
  // the caller supplies (nodeChatToReviewHistory / planToReviewHistory).
  // Renders the verdict into the chat and returns it so callers can stop on a
  // failure. Never throws: a review that can't run comes back inconclusive and
  // the user's work proceeds.
  const reviewChange = useCallback(async (workflowId, change, pendingNode = null, chatHistory = []) => {
    const passthrough = { valid: true, inconclusive: true };
    if (!workflowId || !window.electronAPI?.workflow?.validateChange) return passthrough;
    // The conversation this review belongs to, fixed at the render that built
    // this callback — the same one `appendMessage` writes into. The user may be
    // looking at a different chat by the time the verdict lands.
    const convoId = activeId;
    const fixRounds = fixRoundsRef.current[convoId] || 0;

    setConvoStage(convoId, 'Checking the result…');
    let res;
    try {
      res = await window.electronAPI.workflow.validateChange({
        workflowId,
        change,
        // Supplied by the caller, never read off the chat panel here. The panel
        // is the wrong brief: it holds other nodes' work, earlier questions, and
        // — when the user edits/resubmits an old message — the transcript of a
        // previous failed attempt, which the reviewer then judged this build
        // against. Each caller passes the record its builder actually used.
        chatHistory,
        // The lookups the agent ran while planning. Unlike chatHistory this IS
        // read off the panel: it is evidence of what was checked, not a
        // statement of intent, so the objection above does not apply — and the
        // panel is the only place the tool calls are recorded. Edit/Retry
        // truncates `messages`, so an abandoned attempt's lookups drop out with
        // the turns that produced them.
        priorActions: collectPriorActions(messagesRef.current),
        pendingNode,
        // Consecutive "Fix it" clicks that led here. Lets the reviewer see that
        // it is grading its own previous instruction rather than a fresh build.
        fixRounds,
      });
    } catch (err) {
      return { ...passthrough, reason: err.message || String(err) };
    }
    if (!res?.success) return { ...passthrough, reason: res?.message || '' };

    const drift = res.drift && res.drift.drifted ? res.drift : null;

    // What the rebuild moved underneath other nodes. Shown whether or not the
    // reviewer found a problem: the user asked for ONE node to change and
    // several ended up reading something different, which they should see
    // either way. Their recorded input is already updated; their own logic is
    // not, which is what the reviewer was asked to check.
    const impacted = Array.isArray(res.impactedDownstream) ? res.impactedDownstream : [];
    const impactLines = impacted.length
      ? `\n**This also changed what these nodes read:**\n${impacted.map((d) => {
        const delta = [
          // A source that moved has no column delta to show — the table is
          // simply a different one now, and the node's own SQL still names the
          // old it was built against.
          d.movedFrom
            ? `now reads ${d.movedTo?.tableName || 'another table'}`
              + `${d.movedFrom.connectionId !== d.movedTo?.connectionId ? ' on another connection' : ''}`
              + `, not ${d.movedFrom.tableName || 'what it was built against'}`
            : '',
          d.removed?.length ? `no longer has ${d.removed.join(', ')}` : '',
          d.added?.length ? `now has ${d.added.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        return `- ${d.nodeLabel || d.nodeId}${delta ? ` — ${delta}` : ''}`;
      }).join('\n')}`
      : '';

    if (res.valid) {
      // Inconclusive reviews stay silent — an "I couldn't check" bubble on every
      // successful build is noise. Drift still gets surfaced.
      if (drift) {
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(), agentSource: 'reviewer',
          text: `✓ The change matches what you asked for.\n\n**Heads up — output validation may no longer fit:** ${drift.reason}\n\nRegenerate it from Execution Steps → Validate workflow output.`,
        });
      } else if (!res.inconclusive || impactLines) {
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(), agentSource: 'reviewer',
          text: `✓ Checked against your request${res.reason ? ` — ${res.reason}` : '.'}${impactLines}`,
        });
      }
      return res;
    }

    // The reviewer proposes the EDITS; the user decides whether they get made.
    // Anything it could actually repair is offered as a "Fix it" button rather
    // than printed as a to-do list — the assistant is what can make the change,
    // so handing the user instructions for repairing the builder's own mistake
    // was backwards. An empty `remediation` means it had no fix to offer, and
    // then the message falls back to saying so.
    // Past the cap, stop offering the button. Each click re-sends the verdict's
    // remediation as the builder's next brief, so an unbounded chain lets one
    // wrong verdict rewrite the node further and further from the user's
    // request — with no human judgement between rounds. The verdict is still
    // shown; the user is asked to say what they want instead.
    const exhausted = fixRounds >= MAX_REVIEW_FIX_ROUNDS;
    const hasEdits = res.remediation.length > 0;
    const canFix = hasEdits && !exhausted;
    // Which workflow this verdict is about. Named in the message because a
    // conversation can have several workflows in play, and "the workflow" names
    // none of them — the user is being asked to approve a change and has to see
    // to what.
    const wfId = res.workflowId || workflowId || null;
    const wfName = res.workflowName || null;
    const subject = wfName ? `**${wfName}**` : 'The workflow';
    const lines = [
      `**This doesn't match what you asked for.** ${res.reason || ''}`.trim(),
      res.issues.length ? `\n**What's wrong:**\n${res.issues.map((i) => `- ${i}`).join('\n')}` : '',
      impactLines,
      // Still worth printing when the button is gone: the user can act on it
      // themselves, or see that the reviewer is circling the same point.
      hasEdits ? `\n**What I'd change:**\n${res.remediation.map((r) => `- ${r}`).join('\n')}` : '',
      drift ? `\n**Output validation may no longer fit:** ${drift.reason}` : '',
      canFix
        ? `\n${subject} was saved as-is. Want me to make those changes?`
        : exhausted
          ? `\n${subject} was saved as-is. I've already applied ${fixRounds} round(s) of my own corrections and it still isn't right, so I'd rather not keep changing it — each round moves further from what you asked for. Tell me what it should do and I'll rebuild it, or open it on the canvas to edit by hand.`
          : `\n${subject} was saved as-is. Tell me what it should do instead and I'll rebuild it, or open it on the canvas to edit by hand.`,
    ].filter(Boolean);
    appendMessage({
      role: 'assistant', kind: 'final', ts: nowTs(), agentSource: 'reviewer',
      text: lines.join('\n'),
      // Drives the Fix it / Leave it buttons. Carries what the fix turn needs
      // to be written without re-deriving it from the rendered markdown.
      ...(canFix ? {
        reviewFix: {
          state: 'pending',
          scope: change.kind === 'node' ? 'node' : 'workflow',
          // The TARGET, carried explicitly. Without it the fix turn said "this
          // workflow" and the agent inferred which one from the chat's context
          // — which pointed at a different, older workflow, and the planner
          // correctly reported that the node did not exist there.
          workflowId: wfId,
          workflowName: wfName,
          nodeIds: Array.isArray(change.nodeIds) ? change.nodeIds : [],
          issues: res.issues,
          remediation: res.remediation,
        },
      } : {}),
    });
    return res;
  }, [appendMessage, activeId, setConvoStage]);

  // Run executeBuild and handle all three terminal cases: success, error,
  // and "the builder needs more info from the user". For the third case we
  // append the question to the chat and park a pendingBuild marker on the
  // conversation; the next user message is routed back here with the
  // answer appended to plan.clarifications and we retry the build.
  const runBuild = useCallback(async (plan, msgId) => {
    if (!window.electronAPI?.workflow?.executeBuild) {
      patchMessage(msgId, { planStatus: { kind: 'error', message: 'Build IPC unavailable — restart the app to pick up the latest preload.' } });
      return;
    }

    // The build reads the workflow from the DATABASE. If the editor is open
    // with unsaved canvas edits, it would plan against the older saved version
    // and then write its result over those edits. Ask first — with unsaved
    // edits nothing is built: the card says to save, then accept again.
    const gate = await requestWorkflowSaveGate();
    if (!gate.ok) {
      patchMessage(msgId, {
        planStatus: {
          kind: 'idle',
          message: saveGateRefusal(gate, 'Accept plan'),
        },
      });
      return;
    }

    patchMessage(msgId, { planStatus: { kind: 'running', message: 'Building workflow…' } });
    // Pin this run. A resume after a clarification keeps the panel it already
    // has (the resumed pass re-reports every prior step as `cached`, so the
    // lines refresh in place) instead of opening a second one.
    setPin((prev) => ({
      convoId: activeId,
      // Only a pin belonging to THIS conversation is a resume of the same run.
      // One left over from another chat's build is a different run's log and
      // must not be carried into this one's panel.
      logs: prev?.convoId === activeId ? (prev.logs || []) : [],
      status: 'running',
      note: null,
    }));
    try {
      const resp = await window.electronAPI.workflow.executeBuild({ plan });
      // Carry already-built nodes forward so the resumed build (after the user
      // answers) skips them instead of rebuilding the whole plan from step 0 —
      // along with the workflow id that attempt built under, so every attempt
      // at this plan writes under one id instead of minting a fresh one and
      // orphaning what the earlier attempts already wrote.
      const carried = {};
      if (resp?.builtSteps) carried.builtSteps = { ...(plan.builtSteps || {}), ...resp.builtSteps };
      if (resp?.buildWorkflowId) carried.buildWorkflowId = resp.buildWorkflowId;
      const planForResume = Object.keys(carried).length ? { ...plan, ...carried } : plan;
      // Parked on APPROVAL rather than a question: a step generated code it has
      // to run before the build can go on (a REST API fetch whose columns the
      // following steps are built from). Same parking as a question — the
      // steps already built are kept — but the user answers with Run / Don't
      // run on the card, not by typing. See handleBuildApproval.
      if (resp?.needsClarification && resp.approval) {
        const stepIndex = Number.isInteger(resp.stepIndex) ? resp.stepIndex : null;
        updateConvo(activeId, { pendingBuild: { msgId, plan: planForResume } });
        setPin((prev) => ({
          ...prev,
          logs: prev?.logs || [],
          status: 'waiting',
          note: 'Waiting for your approval — the build resumes from here.',
        }));
        patchMessage(msgId, {
          planStatus: {
            kind: 'running',
            message: resp.approval?.kind === 'target_rebuild'
              ? `Waiting for your approval to recreate ${resp.approval.table}.`
              : 'Waiting for your approval to run an API call.',
          },
        });
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(),
          text: resp.question,
          agentSource: 'builder',
          buildApproval: { ...resp.approval, stepIndex, state: 'pending' },
        });
        return;
      }
      if (resp?.needsClarification) {
        // Park the build, ask the user, keep the plan card in "running"
        // state with a clarifying-message status. A question raised by a SKILL
        // arrives through this same branch — `resp.pendingSkill` carries that
        // skill's state so the resumed build continues the dialog instead of
        // restarting the skill from scratch.
        const stepIndex = Number.isInteger(resp.stepIndex) ? resp.stepIndex : null;
        const nextPlan = (resp.pendingSkill && stepIndex != null)
          ? { ...planForResume, pendingSkills: { ...(planForResume.pendingSkills || {}), [stepIndex]: resp.pendingSkill } }
          : planForResume;
        updateConvo(activeId, { pendingBuild: { msgId, plan: nextPlan } });
        // The build isn't over — it's parked on the user. Keep it pinned so the
        // panel is still there (and still filling in) when the answer resumes
        // it, instead of stacking another build log into the thread.
        setPin((prev) => ({
          ...prev,
          logs: prev?.logs || [],
          status: 'waiting',
          note: 'Waiting for your answer — the build resumes from here.',
        }));
        patchMessage(msgId, {
          planStatus: {
            kind: 'running',
            message: resp.pendingSkill
              ? `Skill "${resp.pendingSkill.skillId}" is asking: ${resp.question}`
              : `Waiting for your answer: ${resp.question}`,
          },
        });
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(),
          text: resp.question,
          buildClarification: true,
          // Which plan step asked. Without it the answer is stored with a null
          // stepIndex, which executeBuild treats as "applies to every step" and
          // seeds into unrelated steps' chats.
          buildStepIndex: stepIndex,
          // Which agent produced this message (hover note on the bubble).
          agentSource: resp.pendingSkill ? `skill:${resp.pendingSkill.skillId}` : 'builder',
        });
        return;
      }
      // A step's AI call ran out of output room. Pause rather than fail: the
      // plan (with everything built so far) rides on the message, so Continue
      // finishes just that call and resumes from that step.
      if (resp?.code === 'MAX_TOKENS' && resp.resume) {
        const stepIndex = Number.isInteger(resp.stepIndex) ? resp.stepIndex : null;
        patchMessage(msgId, { planStatus: { kind: 'running', message: 'Paused — the AI ran out of room on this step.' } });
        // Same as a clarification: parked, not finished — Continue resumes into
        // this pin.
        setPin((prev) => ({
          ...prev,
          logs: prev?.logs || [],
          status: 'paused',
          note: 'Paused — the AI ran out of room on this step. Continue to resume.',
        }));
        appendMessage({
          role: 'assistant', error: true, ts: nowTs(),
          text: resp.message || 'The AI ran out of room while building this step.',
          resume: resp.resume,
          buildResume: { plan: planForResume, msgId, stepIndex },
        });
        return;
      }
      if (!resp?.success) {
        patchMessage(msgId, { planStatus: { kind: 'error', message: resp?.message || 'Build failed.' } });
        // Terminal — the log becomes history so the user can see how far it got.
        commitBuildPin();
        // When the failure was an AI reply that wasn't valid JSON, surface it
        // like the interactive nodes: a short message + an expandable "raw
        // response" node the user can open to inspect what came back.
        if (resp?.invalidJson) {
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: INVALID_RESPONSE_MESSAGE,
            agentSource: 'builder',
            invalidJson: resp.rawResponse || '(empty response)',
          });
        } else {
          // Say what went wrong IN THE THREAD, the way the pause branches above
          // already do. The status line on the plan card carries the same text,
          // but it is a one-line chip on a card the user has usually scrolled
          // past — and a builder's reason is a sentence worth reading ("the API
          // call for X returned no rows — check the endpoint and credentials").
          // Without this the whole failure reads as "Build failed."
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: resp?.message || 'Build failed.',
            agentSource: 'builder',
          });
        }
        updateConvo(activeId, { pendingBuild: null });
        return;
      }
      const summary = `Built "${resp.workflowName}" — ${resp.nodeCount} node${resp.nodeCount === 1 ? '' : 's'}, ${resp.edgeCount} edge${resp.edgeCount === 1 ? '' : 's'}.`;
      // Terminal — the whole run (every pass, every resume) lands in the
      // transcript as one finished log, and the pin clears.
      commitBuildPin(summary);

      // Check the pipeline against the conversation before calling it done. A
      // failed review stops here: the plan card reports the mismatch and the
      // reviewer's message explains it, instead of a ✓ the user would trust.
      const review = await reviewChange(
        resp.workflowId,
        { kind: resp.mode === 'modify' ? 'update' : 'create', summary },
        null,
        planToReviewHistory(plan),
      );
      if (review && review.valid === false) {
        patchMessage(msgId, {
          planStatus: { kind: 'error', message: `Built, but it doesn't match your request: ${review.reason || 'see details below.'}` },
        });
        updateConvo(activeId, { agentMode: 'main', workflowSession: null, pendingBuild: null });
        return;
      }
      patchMessage(msgId, { planStatus: { kind: 'success', message: summary } });
      // Append a confirmation bubble so there's a visible response anchored
      // below the user's last message (a clarification answer typed at the
      // bottom otherwise only flips the plan-card status far up the thread,
      // which reads as "no response").
      appendMessage({
        role: 'assistant', kind: 'final', ts: nowTs(),
        text: `✓ ${summary}`,
        agentSource: 'builder',
      });
      // The workflow session is done — drop it so the next user message
      // lands on the main agent, not the workflow sub-agent.
      updateConvo(activeId, { agentMode: 'main', workflowSession: null, pendingBuild: null });
      // Tell the parent (Workflows.js) so it can switch to the Workflows
      // tab and hand the id to WorkflowsTab for refresh + auto-open.
      if (typeof onWorkflowBuilt === 'function') {
        try {
          onWorkflowBuilt({
            workflowId: resp.workflowId,
            workflowName: resp.workflowName,
            mode: resp.mode || 'new',
          });
        } catch (_) { /* parent handler shouldn't break the build flow */ }
      }
      const warnings = Array.isArray(resp.warnings) ? resp.warnings.filter(Boolean) : [];
      if (warnings.length) {
        appendMessage({
          role: 'assistant', kind: 'final', ts: nowTs(),
          text: `**Build warnings (${warnings.length}):**\n\n${warnings.map((w) => `- ${w}`).join('\n')}`,
          agentSource: 'builder',
        });
      }
    } catch (err) {
      patchMessage(msgId, { planStatus: { kind: 'error', message: `Build failed: ${err.message || String(err)}` } });
      // Terminal — same as an unsuccessful response.
      commitBuildPin();
      updateConvo(activeId, { pendingBuild: null });
    }
    // No `finally` clearing the pin: the clarification and MAX_TOKENS branches
    // return with the build still parked, and the panel has to survive that —
    // it is what the resumed pass fills back in. Every path that ENDS the build
    // calls commitBuildPin itself.
  }, [appendMessage, patchMessage, updateConvo, activeId, onWorkflowBuilt, reviewChange, setPin, commitBuildPin]);

  // Run / Don't run on a build parked for approval (see runBuild). Run resumes
  // the build with that step's function marked approved and its analysis call
  // replayed, so the code that runs is exactly the code on the card. Don't run
  // ends the build: the next steps cannot be built without the columns, and
  // nothing is saved.
  const handleBuildApproval = useCallback(async (m, approve) => {
    const ba = m?.buildApproval;
    if (!ba || ba.state !== 'pending') return;
    const pending = activeConvo?.pendingBuild || null;
    patchMessage(m.id, { buildApproval: { ...ba, state: approve ? 'approved' : 'declined' } });
    if (!pending) return;
    if (!approve) {
      const isRebuild = ba.kind === 'target_rebuild';
      patchMessage(pending.msgId, {
        planStatus: {
          kind: 'error',
          message: isRebuild
            ? `Stopped — recreating ${ba.table} was not approved, so nothing was built.`
            : 'Stopped — the API call was not approved, so nothing was built.',
        },
      });
      commitBuildPin();
      updateConvo(activeId, { pendingBuild: null });
      appendMessage({
        role: 'assistant', kind: 'final', ts: nowTs(), agentSource: 'builder',
        text: isRebuild
          ? `Not approved. The build stopped, nothing was saved, and ${ba.table} was left as it is. `
            + 'Write to a different table, use replace mode, or accept the plan again to be asked again.'
          : 'Not run. The build stopped before calling the API, and nothing was saved. '
            + 'Change the request, or accept the plan again to be asked again.',
      });
      return;
    }
    const plan = pending.plan || {};
    const i = Number.isInteger(ba.stepIndex) ? ba.stepIndex : null;
    if (i == null) return;
    const prevCalls = plan.resumedCalls || {};
    const nextPlan = {
      ...plan,
      apiFetchApprovals: { ...(plan.apiFetchApprovals || {}), [i]: ba.code },
      resumedCalls: { ...prevCalls, [i]: { ...(prevCalls[i] || {}), ...(ba.resumedCalls || {}) } },
    };
    setConvoBusy(activeId, true, 'Building workflow…');
    try {
      await runBuild(nextPlan, pending.msgId);
    } finally {
      setConvoBusy(activeId, false);
    }
  }, [activeConvo, activeId, patchMessage, updateConvo, appendMessage, commitBuildPin, runBuild, setConvoBusy]);

  // ─────────────────────────────────────────────────────────────────────────
  // DISABLED — the skill subagent no longer exists as a separate channel. A
  // skill that needs input now raises an ordinary build clarification, so the
  // user simply answers it like any other build question. Kept commented for
  // reference in case an explicit "stop using this skill" affordance is wanted;
  // it would re-run the build with plan.skipSkills[stepIndex] set.
  // ─────────────────────────────────────────────────────────────────────────
//   // User clicked the skill subagent's "close" button: treat it like the
//   // skill itself returned `unrelateSkill` — re-run executeBuild with
//   // plan.skipSkills set so the next pass takes the standard SQL/NoSQL
//   // route.
//   const closeSkillSubagent = useCallback(async () => {
//     const activeSkill = activeConvo?.activeSkill;
//     if (!activeSkill || !activeSkill.skillId) return;
//     const plan = activeSkill.plan || {};
//     const nextSkipSkills = {
//       ...(plan.skipSkills || {}),
//       [activeSkill.stepIndex]: true,
//     };
//     const nextPlan = { ...plan, skipSkills: nextSkipSkills };
//     updateConvo(activeId, { activeSkill: null });
//     appendMessage({
//       role: 'assistant', kind: 'final', ts: nowTs(),
//       text: `Closed the ${activeSkill.skillId} skill subagent. Continuing with the standard build.`,
//     });
//     await runBuild(nextPlan, activeSkill.msgId);
//   }, [activeConvo, activeId, appendMessage, runBuild, updateConvo]);

  // Plan-card actions. Accept calls runBuild directly so the AI doesn't
  // have to re-interpret a "Confirm build" text turn; Cancel just locks
  // the card in place.
  const handlePlanAction = useCallback(async (action, plan, msgId) => {
    if (!msgId) return;
    if (action === 'cancel-plan') {
      patchMessage(msgId, { planStatus: { kind: 'cancelled', message: 'Plan discarded.' } });
      // Cancelling ends a parked build, so whatever it managed to build moves
      // into the transcript as a record rather than vanishing with the pin.
      commitBuildPin();
      updateConvo(activeId, { pendingBuild: null });
      return;
    }
    if (action !== 'accept-plan') return;
    if (!plan || !Array.isArray(plan.steps)) {
      patchMessage(msgId, { planStatus: { kind: 'error', message: 'Plan is malformed; nothing to build.' } });
      return;
    }
    await runBuild(plan, msgId);
  }, [patchMessage, updateConvo, activeId, runBuild, commitBuildPin]);

  // Hand the conversation back to the main assistant, the same way a finished
  // build does (see runBuild's tail) minus the build. The session is what makes
  // the mode sticky, so both go together: leaving `workflowSession` behind
  // would put the next message back in the sub-agent with a stale request.
  // `pendingBuild` goes too — it exists to route a clarification answer into
  // runBuild, and there is no build in flight to answer for any more.
  //
  // Any plan card already on screen keeps working: Accept calls runBuild
  // directly and never goes through the agent, so leaving the sub-agent
  // doesn't strand a plan the user still wants.
  const exitWorkflowAgent = useCallback(() => {
    if (!activeId) return;
    // Leaving the builder abandons any parked build — commit its log so the
    // pin doesn't outlive the session it belonged to.
    commitBuildPin();
    updateConvo(activeId, { agentMode: 'main', workflowSession: null, pendingBuild: null });
  }, [activeId, updateConvo, commitBuildPin]);

  // Build a fresh user message with the workflow tag stamped in. `mode`
  // controls routing on the next chat:step turn (Edit/Retry pass it from
  // the original message's tag; new sends pass the convo's current mode).
  // `session` lets callers stamp a specific workflowSession on the message
  // (used by Edit/Retry so the re-run resumes from the session that was
  // active when the target message was originally sent — not the convo's
  // current session). Passing `undefined` falls back to the live convo.
  const makeUserMsg = useCallback((text, mode = null, session = undefined) => {
    const m = mode || activeConvo?.agentMode || 'main';
    const ws = session === undefined ? (activeConvo?.workflowSession || null) : session;
    return {
      id: newMsgId(),
      role: 'user',
      text,
      ts: nowTs(),
      agentMode: m,
      workflowSession: ws,
      ...(m === 'workflow' ? { workflowBuilder: true } : {}),
      context: snapshotContext(),
    };
  }, [activeConvo, snapshotContext]);

  /**
   * The user's answer to "want me to make those changes?".
   *
   * Lives here rather than in handlePlanAction because it needs `makeUserMsg`,
   * which is declared just above — a dependency array up there would read it
   * before initialisation.
   *
   * "Fix it" does NOT apply anything directly. It writes the reviewer's edits
   * into an ordinary user turn and sends it, so the correction goes through the
   * same builder, review and approval path as any other request. The fix is
   * then visible in the transcript as something the user asked for, and a fix
   * that is itself wrong gets reviewed like anything else.
   */
  const handleReviewFix = useCallback((action, fix, msgId) => {
    if (!msgId || !fix) return;
    if (action === 'dismiss-review-fix') {
      patchMessage(msgId, { reviewFix: { ...fix, state: 'dismissed' } });
      return;
    }
    if (action !== 'apply-review-fix') return;
    if (loading) return;
    const edits = (fix.remediation || []).map((r) => `- ${r}`).join('\n');
    if (!edits) return;
    patchMessage(msgId, { reviewFix: { ...fix, state: 'sent' } });
    // Name the TARGET outright. This used to say "this workflow", leaving the
    // agent to work out which one from the chat's context — and it picked a
    // different, older workflow, so the planner was asked to edit a node that
    // workflow had never contained and (correctly) refused. The id is what the
    // agent routes on; the name is there so the sentence is readable.
    const wf = fix.workflowName
      ? `the workflow "${fix.workflowName}"${fix.workflowId ? ` (id: ${fix.workflowId})` : ''}`
      : (fix.workflowId ? `workflow id ${fix.workflowId}` : 'this workflow');
    const scope = fix.scope === 'node'
      ? `${fix.nodeIds?.length ? `node ${fix.nodeIds.join(', ')}` : 'the node currently in focus'} in ${wf}`
      : wf;
    // sendRef, not send: send is declared below this point. That is what the
    // ref exists for — see its declaration.
    //
    // `fromReviewFix` is what makes the round counter honest. Only a click on
    // this button sets it, so a user who reads the same verdict and types their
    // own instruction instead is not counted as another remediation round —
    // their message is a fresh brief, and `send` resets the counter on it.
    sendRef.current?.([
      ...messages,
      {
        ...makeUserMsg(
          `Apply these corrections to ${scope}:\n${edits}`
          + '\n\nModify that exact workflow — do not create a new one, and do not '
          + 'retarget to a different workflow.',
        ),
        fromReviewFix: true,
      },
    ]);
  }, [patchMessage, loading, messages, makeUserMsg]);

  // Routing for a re-run (Edit / Retry).
  //
  // A re-sent message resumes with the routing it was originally sent under, so
  // it lands back in the workflow session that produced it rather than the
  // convo's current one. That snapshot is only meaningful while the session is
  // still alive, though: once the conversation has LEFT workflow mode — the
  // user clicked the agent chip's X, a build finished, or the chat was
  // restarted — the session is over, and reviving it from an old message stamp
  // would drop the user back into the sub-agent, undoing the exit they made.
  // So a dead session re-runs on the main agent; a live one still resumes.
  const resumeRouting = useCallback((target) => {
    if (target?.agentMode !== 'workflow' || !inWorkflowAgent) {
      return { tagMode: 'main', targetSession: null };
    }
    // Pre-fix messages may not carry a session — fall back to the live one so
    // we don't strip a session that is still running.
    return {
      tagMode: 'workflow',
      targetSession: 'workflowSession' in target
        ? target.workflowSession
        : (activeConvo?.workflowSession || null),
    };
  }, [inWorkflowAgent, activeConvo]);

  // ChatGPT-style in-place edit. Click Edit on a user message → the bubble
  // flips to a textarea. Save & submit truncates the conversation up to
  // (but not including) the edited message, appends a fresh user message
  // with the edited text in its place, and passes the rebuilt array to
  // send(). Cancel → just exit edit mode.
  const handleEditMessage = useCallback((msgId) => {
    setEditingMsgId(msgId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMsgId(null);
  }, []);

  const handleSaveEdit = useCallback((msgId, newText) => {
    if (!activeConvo || !newText || !newText.trim()) return;
    const msgs = activeConvo.messages;
    const idx = msgs.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const target = msgs[idx];
    if (target?.role !== 'user') return;
    const trimmed = msgs.slice(0, idx);
    const { tagMode, targetSession } = resumeRouting(target);
    const userMsg = makeUserMsg(newText.trim(), tagMode, targetSession);
    // Reset transient session state tied to messages that no longer exist.
    updateConvo(activeConvo.id, {
      agentMode: tagMode,
      workflowSession: targetSession,
      pendingBuild: null,
    });
    setEditingMsgId(null);
    sendRef.current?.([...trimmed, userMsg]);
  }, [activeConvo, makeUserMsg, updateConvo, resumeRouting]);

  // Continue handler — the answer stopped at the model's output limit, so ask
  // it to write the rest and show the two halves joined. This does NOT re-run
  // the agent turn: `resume` already carries the system prompt, chat history
  // and partial output, and ai:continue finishes it in one call.
  //
  // If the continuation is itself cut off, the reply comes back with a fresh
  // `resume` holding everything produced so far — the button stays, and each
  // press extends the answer further.
  const handleContinueMessage = useCallback(async (botMsgId) => {
    if (!activeConvo || loading) return;
    const msg = activeConvo.messages.find((m) => m.id === botMsgId);
    if (!msg?.resume?.partialText) return;
    if (!window.electronAPI?.ai?.continue) {
      patchMessage(botMsgId, {
        text: 'Continue is unavailable — the Electron preload is out of date. Restart the app.',
      });
      return;
    }

    // Whose chat this continuation belongs to — the user can switch away while
    // it runs, and the spinner has to stay with the conversation it is for.
    const convoId = activeConvo.id;
    setConvoBusy(convoId, true, 'Continuing…');
    try {
      // One IPC for every kind of truncation; the response shape says what came
      // back — a re-validated plan, a build call to resume from, or plain text.
      const resp = await window.electronAPI.ai.continue({ resume: msg.resume });

      if (resp?.success && resp.resumedCall && msg.buildResume) {
        // The stalled call is now complete. Re-run the build with it MERGED
        // into that step's finished calls — an earlier stage in the same step
        // may already be cached, and overwriting would throw away work the
        // user already paid to finish.
        const { plan, msgId: planMsgId, stepIndex } = msg.buildResume;
        const { stage, value } = resp.resumedCall;
        patchMessage(botMsgId, { error: false, text: 'Finished that call — resuming the build…', resume: null, ts: nowTs() });
        await runBuild({
          ...plan,
          resumedCalls: {
            ...(plan.resumedCalls || {}),
            [stepIndex]: { ...((plan.resumedCalls || {})[stepIndex] || {}), [stage]: value },
          },
        }, planMsgId);
      } else if (resp?.success && resp.workflowPlan !== undefined) {
        patchMessage(botMsgId, {
          error: false,
          kind: 'final',
          text: resp.message || 'Plan completed.',
          workflowPlan: resp.workflowPlan || null,
          clarification: !!resp.clarification,
          resume: null,
          ts: nowTs(),
        });
      } else if (resp?.success) {
        patchMessage(botMsgId, {
          error: false, kind: 'final', text: resp.text, resume: null, ts: nowTs(),
        });
      } else if (resp?.code === 'MAX_TOKENS' && resp?.resume) {
        // Still not finished — keep the button alive over the longer partial.
        patchMessage(botMsgId, {
          text: `${resp.message} (${resp.resume.partialText.length} characters so far.)`,
          resume: resp.resume,
          ts: nowTs(),
        });
      } else {
        patchMessage(botMsgId, {
          text: resp?.message || 'Could not continue the answer.',
          ts: nowTs(),
        });
      }
    } catch (err) {
      patchMessage(botMsgId, { text: `Could not continue the answer: ${err.message || String(err)}` });
    } finally {
      setConvoBusy(convoId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvo, loading, patchMessage, runBuild, setConvoBusy]);

  // Retry handler — finds the most recent user message at-or-before the
  // clicked bot message, trims the tail, and re-sends with that user
  // message's text. Routing (main vs workflow sub-agent) honours the
  // user message's `agentMode` tag, copied onto the fresh user turn.
  const handleRetryMessage = useCallback((botMsgId) => {
    if (!activeConvo) return;
    const msgs = activeConvo.messages;
    const botIdx = msgs.findIndex((m) => m.id === botMsgId);
    if (botIdx < 0) return;
    let userIdx = -1;
    for (let i = botIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const target = msgs[userIdx];
    const trimmed = msgs.slice(0, userIdx);
    const { tagMode, targetSession } = resumeRouting(target);
    // A retried "Fix it" turn is still a Fix it turn: it keeps the flag that
    // routes it at workflow level (and counts it as a remediation round).
    const userMsg = {
      ...makeUserMsg(target.text || '', tagMode, targetSession),
      ...(target.fromReviewFix ? { fromReviewFix: true } : {}),
    };
    updateConvo(activeConvo.id, {
      agentMode: tagMode,
      workflowSession: targetSession,
      pendingBuild: null,
    });
    sendRef.current?.([...trimmed, userMsg]);
  }, [activeConvo, makeUserMsg, updateConvo, resumeRouting]);

  // send() takes the full conversation as an array; the last element is the
  // new user message (the one being processed). Callers are responsible
  // for any trim + rebuild — see handleRetryMessage / handleSaveEdit. From
  // send()'s point of view every call is identical: write the array as the
  // conversation's messages, then run the chat:step loop using everything
  // before the last element as cross-turn history.
  const send = useCallback(async (historyArray) => {
    // The conversation this turn belongs to, fixed here and used for every
    // piece of run state below. It is NOT re-read as the turn progresses: the
    // user is free to start a new chat or switch to an old one while this runs,
    // and the spinner, stage label, Stop button and approval must all stay with
    // the chat that asked. (appendMessage/patchMessage/updateConvo are already
    // bound to it by this callback's own closure.)
    const turnConvoId = activeId;
    // A new message while code is awaiting approval cancels that run and is
    // treated as an ordinary new turn. This chat is still busy at this point
    // (its loop is parked), so this has to settle the approval BEFORE the
    // guard below — settling lets the old loop unwind and release the convo.
    let supersededApprovalMsgId = null;
    const parkedApproval = approvalRef.current.get(turnConvoId);
    if (parkedApproval) {
      supersededApprovalMsgId = parkedApproval.msgId;
      settleApproval({ approved: false, supersededByNewMessage: true }, turnConvoId);
      // Wait for the parked loop to run its decline branch and release the
      // turn. Bounded so a wedged loop can't hang the composer forever.
      for (let guard = 0; agentLoopRef.current.has(turnConvoId) && guard < 500; guard++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 4));
      }
    } else if (isConvoBusy(turnConvoId)) {
      // Only THIS chat being mid-turn blocks a send. Another conversation
      // thinking in the background is none of this one's business.
      return;
    }
    if (!Array.isArray(historyArray) || historyArray.length === 0) return;
    let userMsg = historyArray[historyArray.length - 1];
    const text = (userMsg?.text || '').trim();
    if (!text || userMsg?.role !== 'user') return;
    // Every way a turn can start funnels through here — typed, suggestion,
    // retry, edit-and-resubmit, and the review "Fix it" button — so this is the
    // one place the remediation-round counter can be kept honest. Only the
    // button flags its message; anything the user wrote themselves resets it.
    fixRoundsRef.current[turnConvoId] = userMsg.fromReviewFix
      ? (fixRoundsRef.current[turnConvoId] || 0) + 1
      : 0;
    if (!window.electronAPI?.chat?.step) {
      appendMessage({
        role: 'assistant', error: true, ts: nowTs(),
        text: 'Chat backend is not available. The Electron preload may be out of date — restart the app.',
      });
      return;
    }

    // Sending commits a pending soft-restart: the stored conversation gets
    // wiped, the user msg's agentMode tag is normalized to 'main' (so the
    // workflow sub-agent doesn't resume on top of a "new" chat), and we
    // drop any in-flight build/session state on the convo.
    const wasRestarted = restartedConvoIds.has(turnConvoId);
    let effHistory = historyArray;
    if (wasRestarted) {
      setRestartedConvoIds((prev) => {
        if (!prev.has(turnConvoId)) return prev;
        const next = new Set(prev);
        next.delete(turnConvoId);
        return next;
      });
      const { workflowBuilder: _wb, ...rest } = userMsg;
      userMsg = { ...rest, agentMode: 'main', workflowSession: null };
      effHistory = [userMsg];
    } else if (supersededApprovalMsgId) {
      // The caller's snapshot was taken before this message cancelled the
      // pending approval, so it still carries that step as 'pending'. Writing
      // it back below would undo the loop's patch and leave a panel offering
      // buttons for an approval that no longer exists. Carry the cancellation
      // into the snapshot instead of rebuilding it — Edit/Retry deliberately
      // truncate history, and rebuilding would resurrect what they dropped.
      effHistory = effHistory.map((m) => (
        m.id === supersededApprovalMsgId && m.approval
          ? { ...m, approval: { ...m.approval, state: 'declined' } }
          : m
      ));
    }

    const isFirstMessage = effHistory.length === 1;
    // Seed an immediate placeholder title from the user's text so the chat
    // sidebar shows something useful right away. The real name arrives with the
    // turn's answer as `chatTitle` — the main agent is asked for it in the same
    // prompt (see chatTitleSection in public/chat/prompts.js), so there is no
    // second call to make here. If the turn never reaches an answer, this
    // placeholder is what the conversation keeps.
    const titleUpdate = isFirstMessage ? { title: titleFromMessage(text) } : {};
    const restartUpdate = wasRestarted
      ? { agentMode: 'main', workflowSession: null, pendingBuild: null }
      : {};
    updateConvo(turnConvoId, { messages: effHistory, ...titleUpdate, ...restartUpdate });
    setInput('');

    // If we're waiting on an answer from the user for an in-flight workflow
    // build (a builder threw ClarificationNeeded), the user's reply isn't
    // a new chat turn — it's the answer. Re-run executeBuild with the
    // accumulated clarifications instead of hitting chat:step. A restart
    // commit drops pendingBuild entirely so we never resume it.
    const pendingBuild = wasRestarted ? null : (activeConvo?.pendingBuild || null);
    const pendingClarMsg = pendingBuild
      ? effHistory.slice(0, -1).find((m) => m.buildClarification && !m.answered)
      : null;
    // NOTE: replies used to be intercepted here and routed to chat:skillStep
    // while a skill subagent was active. Skills now ask through the ordinary
    // build-clarification path below, so there is nothing special to intercept.

    if (pendingBuild && pendingClarMsg) {
      patchMessage(pendingClarMsg.id, { answered: true });
      const plan = pendingBuild.plan || {};
      const prevClar = Array.isArray(plan.clarifications) ? plan.clarifications : [];
      const nextPlan = {
        ...plan,
        clarifications: [
          ...prevClar,
          {
            question: pendingClarMsg.text,
            answer: text,
            // Scope the answer to the step that asked — a null stepIndex is
            // seeded into EVERY step's chat by executeBuild.
            stepIndex: Number.isInteger(pendingClarMsg.buildStepIndex) ? pendingClarMsg.buildStepIndex : null,
          },
        ],
      };
      // Show a conversation-level "thinking" indicator while the build
      // resumes — answering a clarification otherwise looked unresponsive
      // because runBuild only updates the plan card far up the thread.
      setConvoBusy(turnConvoId, true, 'Building workflow…');
      try {
        await runBuild(nextPlan, pendingBuild.msgId);
      } finally {
        setConvoBusy(turnConvoId, false);
      }
      return;
    }

    // A "Fix it" click runs at WORKFLOW level, never through the focused node's
    // builder. The fix names the node and spells out edits to its generated
    // code; a node builder regenerates a node from a description and cannot
    // apply such edits (it refused them — the "can only create a new-table
    // join" answer). The workflow planner rebuilds the named node with the
    // corrections as part of its brief, which is what works. So the canvas
    // focus is left out of this turn's request.
    const dropNodeFocus = !!userMsg.fromReviewFix;
    const turnFocusNode = () => (dropNodeFocus ? null : focusNodeRef.current);

    // A focused Transformer/Join with nothing wired into it has no input to
    // build against. Say so plainly, the same words the canvas uses when it is
    // clicked, rather than letting the model wander off to plan the workflow.
    const focused = turnFocusNode();
    if (focused && (focused.type === 'transformer' || focused.type === 'join')
        && !hasRequiredInputs(focused.type, (focused.upstreamNodes || []).length)) {
      appendMessage({
        role: 'assistant', kind: 'final', ts: nowTs(),
        text: `${nodeRequirementMessage(focused.type)}. Wire ${focused.type === 'join' ? 'its inputs' : 'its source'} into it on the canvas, then ask me again.`,
      });
      return;
    }

    setConvoBusy(turnConvoId, true, 'Thinking…');
    agentLoopRef.current.add(turnConvoId);
    cancelledRef.current.delete(turnConvoId);

    // Cross-turn history sent to the model is the chat BEFORE the new user
    // turn — intermediate steps for this question live in the local
    // scratchpad. The `clarification` flag is what the backend uses to
    // derive the workflow-builder's Q/A trail (paired with the next user
    // message).
    const history = effHistory.slice(0, -1)
      // buildLog and nodeRun are controls, not turns — no text, nothing to replay.
      .filter((m) => m.kind !== 'buildLog' && m.kind !== 'nodeRun')
      .map((m) => (
        // `step` bubbles ARE replayed now. They carry the tool calls that
        // produced the answer below them, and without them a follow-up question
        // arrives with the conclusion but no record of how it was reached — the
        // model then re-runs lookups it already did, or contradicts itself.
        // The backend decides how much of each result survives (see
        // historyStepTurns); the raw results are sent so that decision is made
        // in one place, against real token counts.
        m.kind === 'step'
          ? { role: 'assistant', kind: 'step', stepIndex: m.stepIndex, thought: m.thought, actions: m.actions }
          : {
              role: m.role,
              text: m.text,
              ...(m.clarification ? { clarification: true } : {}),
              // Who wrote it and what it was about — becomes the [context] line
              // the model reads with each turn.
              ...(m.agentSource ? { agentSource: m.agentSource } : {}),
              ...(m.context ? { context: m.context } : {}),
            }
      ));
    const ctx = effectiveContext;
    const scratchpad = [];
    // Seed the agent mode + session from the user message's own stamps —
    // Edit/Retry pass the target message's session so the re-run resumes
    // from where it was originally sent. Falls back to the convo's live
    // session for pre-fix messages that don't carry one.
    // A restart commit forces 'main' and drops any prior workflow session.
    let agentMode       = wasRestarted ? 'main' : (userMsg.agentMode || activeConvo?.agentMode || 'main');
    let workflowSession = wasRestarted
      ? null
      : ('workflowSession' in userMsg
          ? userMsg.workflowSession
          : (activeConvo?.workflowSession || null));

    // When the AI batches plan_workflow_build with other tools, the backend
    // defers it and returns the args here. We stash them so the loop can
    // restart with `triggerPlanWorkflowBuild` once the current finalAnswer
    // lands — the user sees the ordinary tools' result first, then the
    // workflow build kicks off.
    let triggerPlanWorkflowBuild = null;
    let pendingPlanArgs = null;
    // A node this turn built, waiting on the user's "Run this node". Appended
    // once the turn is over so it sits under the answer that describes it.
    let pendingNodeRun = null;
    // A presentation an approved build_presentation run produced this turn. It
    // goes onto the answer bubble; the scratchpad keeps only its outline.
    let turnPresentation = null;
    // Config this turn has already applied to the focused node, kept locally so
    // the NEXT step sees it. Handing it to WorkflowEditor only gets it back into
    // focusNodeRef via apply-node-config → setNodes → node-focus → a second
    // render, which does not settle before the next chat.step fires. Without
    // this, an add_node_context note (or a build's committed chat) written in
    // one step is invisible to the builder in the step right after it.
    let appliedNodeConfig = null;   // { nodeId, config }

    try {
      let i = 0;
      while (i < MAX_STEPS_PER_QUESTION) {
        if (cancelledRef.current.has(turnConvoId)) {
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: '_Stopped by user._',
          });
          break;
        }

        // The planner reads the SAVED workflow, exactly as the build does, so a
        // step that can plan is gated the same way — otherwise the agent
        // proposes against a version the user has already moved past, and the
        // plan is wrong before Accept is even offered.
        //
        // `agentMode === 'workflow'` is the sub-agent that does the planning
        // (carried over from the PREVIOUS response, so it is known before this
        // dispatch goes out), and `triggerPlanWorkflowBuild` is the batched
        // plan_workflow_build the backend defers back to us. A workflow with
        // nothing uncommitted answers immediately and opens nothing, so an
        // ordinary follow-up in workflow mode is unaffected.
        if (agentMode === 'workflow' || triggerPlanWorkflowBuild) {
          const gate = await requestWorkflowSaveGate();
          if (!gate.ok) {
            appendMessage({
              role: 'assistant', kind: 'final', ts: nowTs(),
              text: saveGateRefusal(gate, 'Retry'),
            });
            break;
          }
        }

        let resp;
        try {
          resp = await window.electronAPI.chat.step({
            message: text,
            history,
            scratchpad,
            activeContext: ctx,
            agentMode,
            workflowSession,
            triggerPlanWorkflowBuild,
            // The focused canvas node — lets the main prompt build/refine that
            // node via its workflowBuilder builder (build_transformer/join/
            // dataSource). Follow-ups are handled through the node's chat
            // history, not a side clarifications structure.
            targetNode: withAppliedConfig(turnFocusNode(), appliedNodeConfig),
            // Asks the main prompt to name this conversation with its answer.
            // Stays true for every step of this turn — the model only produces
            // the title when it finally answers, which may be several steps in.
            isNewChat: isFirstMessage,
          });
        } catch (err) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Error: ${err.message || String(err)}`,
          });
          break;
        }
        triggerPlanWorkflowBuild = null; // single-use per turn

        // Discard the result silently if the user cancelled while it was in
        // flight — the final "stopped" message was already appended above.
        if (cancelledRef.current.has(turnConvoId)) break;

        if (!resp?.success) {
          appendMessage({
            role: 'assistant', ts: nowTs(),
            // An invalid response is NOT an `error` bubble: error bubbles don't
            // offer Retry, and retrying is exactly the remedy here.
            ...(resp?.invalidJson
              ? { kind: 'final', invalidJson: resp.invalidJson, agentSource: resp.agentSource || null }
              : { error: true }),
            text: resp?.message || 'The assistant could not answer that. Check that an AI provider key is configured in Settings.',
            // Cut off at the model's output limit — carry the resume payload so
            // the bubble can offer Continue (see handleContinueMessage).
            ...(resp?.code === 'MAX_TOKENS' && resp?.resume ? { resume: resp.resume } : {}),
          });
          break;
        }

        // The main agent names a new conversation as part of its answer, so the
        // title lands on whichever step finally answers. Replaces the
        // placeholder seeded from the user's text when the send started.
        if (resp.chatTitle) updateConvo(turnConvoId, { title: resp.chatTitle });

        // A build_* tool built/refined the focused node OR committed follow-up
        // chat (partial) — hand it to WorkflowEditor to write onto the node.
        // The committed chat history is what carries clarification Q&A forward.
        if (resp.nodeBuild && resp.nodeBuild.nodeId && resp.nodeBuild.config) {
          window.dispatchEvent(new CustomEvent('ternlux:apply-node-config', { detail: resp.nodeBuild }));
          // Same apply the editor just did, kept here so the next step's
          // targetNode already carries it (see appliedNodeConfig) — and so the
          // review below judges exactly what landed on the node.
          //
          // A finished build REPLACES; only a `partial` commit merges. Matches
          // mergeConfigWithName in WorkflowEditor: a completed build hands back
          // a whole config, and letting an earlier step's fields survive into it
          // is how a rebuilt node keeps SQL the new build never wrote.
          appliedNodeConfig = {
            nodeId: resp.nodeBuild.nodeId,
            config: resp.nodeBuild.partial
              ? {
                ...(appliedNodeConfig?.nodeId === resp.nodeBuild.nodeId ? appliedNodeConfig.config : {}),
                ...resp.nodeBuild.config,
              }
              : { ...resp.nodeBuild.config },
          };
          // A finished node (not a partial chat commit) gets the same review a
          // full build does. The config is passed as `pendingNode` because the
          // editor has only just received it — the saved document may still be
          // a moment behind. A failed review ends the turn here.
          if (!resp.nodeBuild.partial) {
            const wfId = focusNodeRef.current?.workflowId || null;
            // Everything this turn has applied to the node, which the merge just
            // above guarantees includes resp.nodeBuild.config. Its `chat` is the
            // brief the builder worked from — the user's requests, the builder's
            // own clarifications, and any add_node_context notes — including a
            // chat committed by an earlier step of this same turn.
            const reviewedCfg = appliedNodeConfig.config;
            const nodeReview = await reviewChange(
              wfId,
              { kind: 'node', nodeIds: [resp.nodeBuild.nodeId], summary: resp.finalAnswer || '' },
              // nodeType/label let the backend APPEND this node when it isn't in
              // the saved document yet — a node just added on the canvas never is.
              {
                nodeId: resp.nodeBuild.nodeId,
                nodeType: resp.nodeBuild.nodeType || focusNodeRef.current?.type || null,
                label: focusNodeRef.current?.label || null,
                config: reviewedCfg,
              },
              nodeChatToReviewHistory(reviewedCfg.chat, reviewedCfg),
            );
            if (nodeReview && nodeReview.valid === false) break;
            // The node is configured, but nothing has run. Executing it writes
            // data — and a transform the user didn't mean can overwrite a table
            // with the wrong thing — so the run is always their click. Held
            // until the turn is over so it reads after the answer explaining it.
            const cfg = resp.nodeBuild.config;
            pendingNodeRun = {
              nodeId: resp.nodeBuild.nodeId,
              nodeType: resp.nodeBuild.nodeType || focusNodeRef.current?.type || 'node',
              nodeLabel: focusNodeRef.current?.label || resp.nodeBuild.nodeId,
              config: cfg,
              explanation: cfg.targetSqlExplanation || cfg.explanation || cfg.joinDescription || '',
              writesTo: cfg.targetTableName || cfg.targetCollection || null,
              destination: cfg.targetConnectionName || null,
              // The workflow the node lives in. Running it needs that canvas
              // open — the card stays disabled until it is (runBlockedReason).
              workflowId: focusNodeRef.current?.workflowId || null,
              workflowName: snapshotContext()?.workflowName || null,
              state: 'pending',
            };
          }
        }

        // Track mode + session moves across the step loop. The sub-agent
        // may flip these mid-question (main → workflow on a
        // plan_workflow_build trigger; workflow → main on
        // exit_workflow_mode).
        if (resp.nextAgentMode)               agentMode       = resp.nextAgentMode;
        if ('workflowSession' in resp)        workflowSession = resp.workflowSession || null;
        if (resp.pendingPlanWorkflowBuild)    pendingPlanArgs = resp.pendingPlanWorkflowBuild.args || {};
        setConvoStage(turnConvoId, agentMode === 'workflow' ? 'Workflow builder…' : 'Thinking…');

        // A short-circuit turn (propose_plan) returns BOTH a tool step
        // AND a finalAnswer in the same response — render the step
        // bubble first so the user sees the planner ran, then the
        // final bubble with the plan card or clarification.
        // Two consumers, deliberately kept apart:
        //
        //   scratchpad — the model's context for this question. It is replayed
        //     to the AI as assistant/user turns on every later step (see
        //     scratchpadToTurns in chatAssistant.js), so it carries ONLY what
        //     replay needs. Normalising here means a field added for the step
        //     bubble can never silently end up in the prompt. `result` stays
        //     because finalAnswer visuals resolve "3.1" against it.
        //
        //   message    — the step bubble. Keeps the full response as returned,
        //     including anything display-only.
        if (resp.step) {
          scratchpad.push({
            index: resp.step.index ?? scratchpad.length + 1,
            thought: resp.step.thought || '',
            // The provider's own payload for this assistant turn, when the
            // provider does native tool calling. Replayed verbatim on the next
            // step: Anthropic models thinking through a tool loop return signed
            // blocks that must come back unaltered, so this is carried rather
            // than rebuilt from thought + actions.
            ...(resp.step.assistantRaw ? { assistantRaw: resp.step.assistantRaw } : {}),
            actions: (resp.step.actions || []).map((a) => ({
              // The id the model issued for this call. Results replayed under
              // any other id break the pairing.
              ...(a.id ? { id: a.id } : {}),
              tool: a.tool,
              args: a.args,
              ok: a.ok,
              ...(a.error ? { error: a.error } : { result: a.result }),
            })),
          });
        }
        // Generated code that needs the user's go-ahead rides on the step
        // that produced it — it is that tool call's outcome, not a separate
        // event in the thread.
        const pa = resp.pendingApproval || null;
        const approval = pa ? {
          state: 'pending',
          kind: pa.kind || 'javascript',
          runToken: pa.runToken,
          code: pa.transformFunction || '',
          explanation: pa.explanation || '',
          inputRecordCount: pa.inputRecordCount || 0,
        } : null;

        const hasActions = Array.isArray(resp.actions) && resp.actions.length > 0;
        // The model's reasoning for this turn, when the provider exposes it
        // (Claude today). It earns a step bubble on its own: the turn that ends
        // with the answer calls no tools, and its thinking is the only record of
        // how the answer was reached.
        const thinking = typeof resp.thinking === 'string' ? resp.thinking.trim() : '';
        let stepMsgId = null;
        if (hasActions || approval || thinking) {
          stepMsgId = appendMessage({
            role: 'assistant', kind: 'step', ts: nowTs(),
            stepIndex: resp.step?.index ?? scratchpad.length,
            thought: resp.thought,
            ...(thinking ? { thinking } : {}),
            actions: resp.actions,
            ...(approval ? { approval } : {}),
          });
        }

        // ── Generated code: stop and ask the user ────────────────────────
        //
        // The tool generated a function but did NOT run it. Hold the loop
        // here rather than unwinding and re-entering, so scratchpad/history/
        // agentMode survive untouched and the turn resumes where it paused.
        if (pa) {
          const approvalMsgId = stepMsgId;
          const settleBubble = (state) => {
            if (approvalMsgId) patchMessage(approvalMsgId, { approval: { ...approval, state } });
          };

          setConvoStage(turnConvoId, 'Waiting for your approval…');
          const decision = await new Promise((resolve) => {
            approvalRef.current.set(turnConvoId, { msgId: approvalMsgId, runToken: pa.runToken, resolve });
            setAwaitingApprovalByConvo((prev) => ({ ...prev, [turnConvoId]: approvalMsgId }));
          });

          if (!decision?.approved) {
            // Declined, or superseded by a new message. Either way this turn
            // is over: the model never sees a result for the call, and the
            // parked function is dropped in the main process.
            settleBubble('declined');
            try { await window.electronAPI?.chat?.discardJavascript?.({ runToken: pa.runToken }); } catch (_) {}
            if (!decision?.supersededByNewMessage) {
              appendMessage({
                role: 'assistant', kind: 'final', ts: nowTs(),
                text: '_Code not run._ Tell me what to change and I\'ll rewrite it.',
              });
            }
            break;
          }

          setConvoStage(turnConvoId, 'Running approved code…');
          let execResp;
          try {
            execResp = await window.electronAPI.chat.runApprovedJavascript({ runToken: pa.runToken });
          } catch (err) {
            execResp = { success: false, message: err.message || String(err) };
          }

          settleBubble('approved');

          // Replay the outcome into the same action slot the model is
          // waiting on — success or failure, it learns what actually
          // happened and carries on from there.
          const slot = scratchpad[scratchpad.length - 1];
          const codeTool = pa.kind === 'presentation' ? 'build_presentation' : 'run_javascript';
          const isSlot = (a, i, list) => (a.id === pa.actionId
            || (!list.some((x) => x.id === pa.actionId) && a.tool === codeTool));
          const action = slot?.actions?.find(isSlot);
          if (execResp?.success && execResp.result && execResp.result.__presentation) {
            const { __presentation, ...forModel } = execResp.result;
            turnPresentation = __presentation;
            execResp = { ...execResp, result: forModel };
          }
          // A failure has to carry the SOURCE back, not just the message.
          //
          // The model writes the function, never sees it again, and is handed
          // one line: `ERROR: Header name must be a valid HTTP token ["api
          // key"]`. Since "api key" is also what the connection calls its saved
          // parameter, that reads as a fact about the CONNECTION — and the model
          // spent four turns insisting the user fix a connection that was fine,
          // because nothing in its context showed that its own code had put that
          // name in a header. Replaying the source turns an unattributable error
          // into an ordinary bug it can find and fix.
          //
          // The source is safe to show: credentials are resolved inside the
          // running function via ctx.apiCredentials, so this text never holds a
          // secret — that is the same reason it is shown to the user for approval.
          // STOP here and report. Do not retry on your own: an endpoint, a
          // credential and an auth scheme are the user's to settle, and guessing
          // at them spends a real request and a real approval click per guess.
          // A model told to "try again with a correction" writes a function that
          // swallows the error and returns a placeholder row instead — which
          // then reads downstream as a successful call.
          const failure = (msg) => [
            msg,
            '',
            'This is the function that failed — you wrote it, so read the error against it before '
            + 'concluding anything about the connection or the endpoint:',
            pa.transformFunction || '(source unavailable)',
            '',
            'Now STOP and tell the user, in your answer: what you called, what came back, and what '
            + `you think is wrong. Do NOT call ${codeTool} again on your own — not with a `
            + 'different endpoint, a different auth scheme, or error handling that hides the '
            + 'failure. Wait for the user. When they tell you what to change (a URL, a parameter, '
            + `where the credential goes), apply exactly that and call ${codeTool} again.`,
          ].join('\n');
          const outcome = execResp?.success
            ? { ok: true, result: execResp.result }
            : { ok: false, error: failure(execResp?.message || 'The approved code failed to run.') };
          if (action) {
            if (outcome.ok) {
              delete action.error;
              action.ok = true;
              action.result = outcome.result;
            } else {
              delete action.result;
              action.ok = false;
              action.error = outcome.error;
            }
          }
          // The same outcome into the MESSAGE, not just the scratchpad. The
          // bubble kept the placeholder the tool returned before approval
          // ("ran": false, "awaitingApproval": true), so the saved transcript
          // said the code never ran no matter what it did — and a later turn,
          // which reads history rather than this turn's scratchpad, was told the
          // same. Both readers now see what actually happened.
          if (stepMsgId && action) {
            patchMessage(stepMsgId, {
              actions: (resp.actions || []).map((a, i, list) => {
                if (!isSlot(a, i, list)) return a;
                const { result, error, ...rest } = a;
                return outcome.ok
                  ? { ...rest, ok: true, result: outcome.result }
                  : { ...rest, ok: false, error: outcome.error };
              }),
            });
          }
          setConvoStage(turnConvoId, 'Thinking…');
          i++;
          continue;
        }

        if (resp.done) {
          // A builder that returned no explanation of its own: the model's
          // answer IS the description of what the node will do, so the run
          // panel borrows it rather than showing bare code.
          if (pendingNodeRun && !pendingNodeRun.explanation && resp.finalAnswer) {
            pendingNodeRun.explanation = resp.finalAnswer;
          }
          appendMessage({
            role: 'assistant', kind: 'final', ts: nowTs(),
            text: resp.finalAnswer || '(no answer)',
            workflowPlan: resp.workflowPlan || null,
            visuals: Array.isArray(resp.visuals) ? resp.visuals : null,
            ...(turnPresentation ? { presentation: turnPresentation } : {}),
            clarification: !!resp.clarification,
            // Who actually produced this reply (hover note on the bubble).
            agentSource: resp.agentSource || null,
            // What it was about — the node in focus and its workflow.
            context: snapshotContext(),
            // Raw text of a reply that broke the JSON contract — rendered as the
            // collapsible "raw response" panel under the message. Retry stays
            // available because this is a normal final message, not an error one.
            invalidJson: resp.invalidJson || null,
            // Planner output cut off mid-JSON — offer Continue on this bubble.
            ...(resp.resume ? { resume: resp.resume } : {}),
          });
          // A plan card (propose_plan) is a HARD STOP: applying the plan is
          // the user's Accept click (handlePlanAction → runBuild), not
          // something the agent can do. Return control to the user and drop
          // any deferred build so we don't re-enter the workflow and re-plan
          // the same thing in a loop.
          if (resp.workflowPlan) {
            pendingPlanArgs = null;
            break;
          }
          // If the AI batched plan_workflow_build with this turn's tools,
          // restart the loop with triggerPlanWorkflowBuild — the workflow
          // build runs after the user sees the finalAnswer.
          if (pendingPlanArgs) {
            triggerPlanWorkflowBuild = pendingPlanArgs;
            pendingPlanArgs = null;
            i = 0;
            continue;
          }
          break;
        }

        if (i === MAX_STEPS_PER_QUESTION - 1) {
          appendMessage({
            role: 'assistant', error: true, ts: nowTs(),
            text: `Reached the ${MAX_STEPS_PER_QUESTION}-step limit without a final answer. Ask a more specific follow-up.`,
          });
        }

        i++;
      }
    } finally {
      // The run panel lands last, whichever way the turn ended — the node was
      // already written to the canvas, so the offer to run it stands even if
      // the loop stopped early.
      if (pendingNodeRun) {
        appendMessage({ role: 'assistant', kind: 'nodeRun', ts: nowTs(), run: pendingNodeRun });
      }
      // Persist whatever mode/session the conversation ended on so the
      // NEXT user message resumes in the right agent.
      updateConvo(turnConvoId, { agentMode, workflowSession });
      // Never leave an approval promise dangling — if the turn ended by any
      // other route (error, step cap, cancel) the bubble must stop waiting.
      settleApproval({ approved: false }, turnConvoId);
      setConvoBusy(turnConvoId, false);
      agentLoopRef.current.delete(turnConvoId);
      cancelledRef.current.delete(turnConvoId);
    }
  }, [input, messages, effectiveContext, snapshotContext, activeId, activeConvo, restartedConvoIds, updateConvo, appendMessage, patchMessage, runBuild, reviewChange, settleApproval, setConvoBusy, setConvoStage, isConvoBusy]);

  // Edit / Retry reach send through this — see sendRef's declaration.
  sendRef.current = send;

  // ── A fresh chat, opened with its first message already written ──────────
  //
  // The canvas asks for this when a node's input has moved under it: the
  // prompt over the node (SourceChangedPopup → WorkflowEditor) offers Rebuild,
  // and the request arrives here as the opening message of a NEW conversation,
  // so a rebuild never lands in the middle of whatever the user was discussing.
  //
  // The send waits a render: `send` binds the conversation it writes into when
  // it is called, so sending in the same tick as `newChat` would put the
  // message in the chat being left behind. Parking it in state lets the new
  // conversation become the active one first.
  const [seededRequest, setSeededRequest] = useState(null);

  useEffect(() => {
    const handler = (e) => {
      const text = String(e.detail?.text || '').trim();
      if (!text) return;
      setOpen(true);
      newChat();
      setSeededRequest({ text, at: Date.now() });
    };
    window.addEventListener('ternlux:chat-new-message', handler);
    return () => window.removeEventListener('ternlux:chat-new-message', handler);
  }, [newChat]);

  useEffect(() => {
    if (!seededRequest) return;
    // Cleared first: one send per request, however this effect is re-run.
    setSeededRequest(null);
    send([makeUserMsg(seededRequest.text)]);
  }, [seededRequest, send, makeUserMsg]);

  // ── Floating launcher button ─────────────────────────────────────────────
  //
  // Closing the assistant HIDES it; it never unmounts. The panel below stays in
  // the tree with display:none, so everything in it — the scroll position, a
  // half-typed message, an expanded code block, an approval card — is exactly
  // as it was when it is opened again.
  const launcher = open ? null : (
      <button type="button" onClick={() => setOpen(true)}
        title={focusNode ? `Edit the focused ${focusTypeLabel} node — ${focusNodeLabel}` : 'Open Ternlux Assistant'}
        style={{
          // Raised clear of the node side panel's footer, whose Save
          // configuration / Cancel buttons sit in the bottom-right corner.
          position: 'fixed', bottom: 80, right: 24, height: 46,
          padding: '0 16px 0 14px', borderRadius: 23,
          background: C.accent, border: 'none',
          boxShadow: '0 12px 32px rgba(37,99,235,0.32), 0 4px 12px rgba(0,0,0,0.08)',
          cursor: 'pointer', zIndex: CHAT_Z,
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: SANS, transition: 'transform 0.15s',
        }}
        onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
        onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}>
        {I('compass', '#fff', 16)}
        <span style={{
          fontSize: 13, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em',
          maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {focusNode ? `Edit ${focusNodeLabel}` : 'Ask Ternlux'}
        </span>
      </button>
  );
  const hiddenWhenClosed = open ? null : { display: 'none' };

  // ── Header ───────────────────────────────────────────────────────────────
  const Header = (
    // In popup mode the header doubles as the window's drag handle; in
    // expanded mode the panel is modal and has nowhere to be dragged to.
    <div
      onPointerDown={expanded ? undefined : startDrag}
      style={{
        padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
        background: C.bg, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        ...(expanded ? {} : {
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none', touchAction: 'none',
        }),
      }}>
      {/* {!expanded && <IconGrip color={C.dim} size={11} />} */}
      {/* History sits on the left, where the expanded layout keeps its
          conversation sidebar — the popup overlay opens from the same corner. */}

      <div style={{
        width: 28, height: 28, borderRadius: 5, background: C.aD,
        border: '1px solid #bfdbfe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {I('compass', C.accent, 14)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, letterSpacing: '-0.01em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isRestarted ? 'New chat' : (activeConvo?.title || 'Ternlux Assistant')}
        </div>
        <div style={{
          fontSize: 9, fontFamily: MONO, color: C.muted, letterSpacing: '0.08em',
          textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5, marginTop: 1,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: inWorkflowAgent ? '#7c3aed' : C.green,
            boxShadow: `0 0 0 2px ${inWorkflowAgent ? '#ede9fe' : C.gB}`,
            display: 'inline-block',
          }} />
          {loading
            ? stage
            : (inWorkflowAgent
                ? 'Workflow builder · gathering details'
                : 'Ternlux Assistant · ready')}
        </div>
      </div>
      {!expanded && (
        <button type="button" onClick={() => setHistoryOpen((v) => !v)}
          title={historyOpen ? 'Back to chat' : 'Chat history'}
          style={{
            padding: 6, borderRadius: 4,
            background: historyOpen ? C.aD : 'transparent',
            border: 'none', cursor: 'pointer',
            color: historyOpen ? C.accent : C.muted, display: 'flex', flexShrink: 0,
          }}>
          {I('clock', historyOpen ? C.accent : C.muted, 14)}
        </button>
      )}
      <button type="button" onClick={restartChat}
        title="Restart current chat"
        disabled={!messages.length}
        style={{
          padding: 6, borderRadius: 4, background: 'transparent',
          border: 'none', cursor: messages.length ? 'pointer' : 'default',
          color: messages.length ? C.muted : C.dim, display: 'flex',
          opacity: messages.length ? 1 : 0.5,
        }}>
        {/* refresh / counter-clockwise rotation icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
      {!expanded && (
        <button type="button" onClick={newChat} title="Start a new chat"
          style={{
            padding: 6, borderRadius: 4, background: 'transparent',
            border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
          }}>
          {I('plus', C.muted, 14)}
        </button>
      )}
      {!expanded && (
        <button type="button" onClick={togglePinned}
          title={docked ? 'Unpin from the right' : 'Pin to the right'}
          style={{
            padding: 6, borderRadius: 4,
            background: docked ? C.aD : 'transparent',
            border: 'none', cursor: 'pointer',
            color: docked ? C.accent : C.muted, display: 'flex',
          }}>
          {docked ? <IconUnpin color={C.accent} size={13} /> : <IconPin color={C.muted} size={13} />}
        </button>
      )}
      <button type="button" onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Restore' : 'Maximize'}
        style={{
          padding: 6, borderRadius: 4, background: 'transparent',
          border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
        }}>
        {expanded ? <IconRestore color={C.muted} size={12} /> : <IconMaximize color={C.muted} size={12} />}
      </button>
      <button type="button" onClick={() => setOpen(false)} title="Close"
        style={{
          padding: 6, borderRadius: 4, background: 'transparent',
          border: 'none', cursor: 'pointer', color: C.muted, display: 'flex',
        }}>
        {I('x', C.muted, 14)}
      </button>
    </div>
  );

  // ── Body ─────────────────────────────────────────────────────────────────
  const Body = (
    <div
      onContextMenu={showTextMenu}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}
    >
      {Header}
      {/* One focus strip for everything the turn is scoped to: the workflow (or
          connection/execution) the user has open, and the node they clicked.
          Each chip is independently dismissible. */}
      {(effectiveContext || focusNode || inWorkflowAgent) && (
        <div style={{
          padding: '8px 14px', borderBottom: `1px solid ${C.border}`, background: '#fff',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em',
            color: C.dim, textTransform: 'uppercase', flexShrink: 0,
          }}>Focused on</span>
          {/* First in the strip: which agent answers decides what the other
              chips can even be used for — a focused node is inert while the
              workflow sub-agent holds the conversation. */}
          {inWorkflowAgent && (
            <AgentChip label="Workflow builder" onClear={exitWorkflowAgent} disabled={loading} />
          )}
          <ContextChip ctx={effectiveContext} onClear={() => setPinnedContext('cleared')} />
          <FocusNodeChip node={focusNode} typeLabel={focusTypeLabel}
            onClear={() => setFocusDismissed(true)} />
        </div>
      )}
      {joinNeedsDestination && (
        <JoinDestinationPicker
          node={focusNode}
          destinations={joinDestinations}
          loading={loadingDestinations}
          onPick={pickJoinDestination}
        />
      )}
      <div ref={scrollRef} style={{
        flex: 1, overflowY: 'auto', padding: 14, background: C.surface,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {messages.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 14, padding: '12px 4px',
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 8, background: C.aD,
              border: '1px solid #bfdbfe', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{I('compass', C.accent, 22)}</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: '-0.02em', marginBottom: 3 }}>
                How can I help?
              </div>
              <div style={{ fontSize: 11, color: C.muted }}>
                Ask about your workflows, connections, executions, or query your data.
              </div>
            </div>
            <SugGrid onPick={(t) => send([...messages, makeUserMsg(t)])} />
          </div>
        ) : (
          messages.map((m, i) => (
            <Bubble
              key={m.id || i}
              m={m}
              // The user has spoken since this offer was made — see lastUserIdx.
              stale={i < lastUserIdx}
              // Only the turn's last answer offers Retry — see retryableIdx.
              retryable={retryableIdx.has(i)}
              planBlockedReason={planBlockedReason}
              onAction={(action, payload, id) => (
                action === 'apply-review-fix' || action === 'dismiss-review-fix'
                  ? handleReviewFix(action, payload, id)
                  : handlePlanAction(action, payload, id)
              )}
              onEdit={handleEditMessage}
              onRetry={handleRetryMessage}
              onContinue={handleContinueMessage}
              onApproveCode={handleApproveCode}
              onDeclineCode={handleDeclineCode}
              onRunNode={handleRunNode}
              onSkipNode={handleSkipNode}
              runBlockedReason={runBlockedReason}
              onBuildApproval={handleBuildApproval}
              activeApprovalMsgId={awaitingApproval}
              isEditing={editingMsgId === m.id}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              busy={loading}
            />
          ))
        )}
        {loading && !awaitingApproval && <Typing stage={stage} />}
      </div>
      {/* DISABLED — skill subagent banner + "Close skill" button. Skills no
          longer hold the conversation: one that needs input raises an ordinary
          build clarification, so there is no separate mode to show or exit.
          Kept for reference; re-enabling also needs closeSkillSubagent above.

      // {activeConvo?.activeSkill?.skillId && (
      // <div style={{
      // display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      // padding: '8px 14px', borderTop: `1px solid ${C.border}`,
      // background: '#fef3c7', color: '#92400e', fontSize: 12, fontFamily: SANS,
      // }}>
      // <span>
      // <strong>Skill subagent active:</strong> {activeConvo.activeSkill.skillId} — your replies route to this skill.
      // </span>
      // <button
      // type="button"
      // onClick={closeSkillSubagent}
      // style={{
      // border: '1px solid #92400e', background: 'transparent', color: '#92400e',
      // padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
      // }}>
      // Close skill
      // </button>
      // </div>
      // )}
      */}
      {/* A build in flight sits here, between the thread and the composer —
          right where the user is typing the answer it is waiting for. It stays
          across every clarification pause and only enters the transcript when
          the build ends. */}
      <BuildPin run={buildRun?.convoId === activeId ? buildRun : null} />
      {/* While code awaits approval the turn is parked, not working — keep the
          composer live so "just type your next message" actually works. */}
      <Composer value={input} setValue={setInput}
        onSend={() => {
          const text = input.trim();
          if (!text) return;
          send([...messages, makeUserMsg(text)]);
        }}
        onCancel={cancel} busy={loading && !awaitingApproval} />
    </div>
  );

  // ── Popup mode ───────────────────────────────────────────────────────────
  if (!expanded) {
    return (
      <>
        {dockHint && <DockPreview state={dockHint} width={railWidth} />}
        <div data-chat-panel style={{
          ...panelStyle,
          background: '#fff',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          ...hiddenWhenClosed,
          // Pinned, the panel is in flow (it reserves its own space) but keeps
          // the same stacking rank, so app modals still open beside it rather
          // than over it.
          zIndex: CHAT_Z, fontFamily: SANS,
          // Animate the snap into / out of the rail, but never fight a drag
          // or a live resize.
          transition: dragging || resizing
            ? 'none'
            : 'width 0.18s ease, height 0.18s ease, border-radius 0.18s ease',
        }}>
          {docked && <RailResizer onPointerDown={startRailResize} active={resizing} />}
          {Body}
          {historyOpen && (
            <div style={{
              position: 'absolute', inset: 0, background: '#fff',
              display: 'flex', flexDirection: 'column', zIndex: 3,
            }}>
              <HistorySidebar
                conversations={conversations}
                activeId={activeId}
                busyIds={busyConvoIds}
                width="100%"
                onClose={() => setHistoryOpen(false)}
                onSelect={(id) => { setActiveId(id); setHistoryOpen(false); }}
                onNewChat={() => { newChat(); setHistoryOpen(false); }}
                onDeleteConvo={deleteConvo}
                onExportConvo={exportConvo}
              />
            </div>
          )}
        </div>
        {launcher}
      </>
    );
  }

  // ── Expanded mode (with history sidebar) ─────────────────────────────────
  return (
    <>
    <div onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)',
        backdropFilter: 'blur(3px)', zIndex: CHAT_Z, padding: 24, display: 'flex',
        fontFamily: SANS,
        ...hiddenWhenClosed,
      }}>
      <div style={{
        margin: 'auto', width: '100%', maxWidth: 1100, height: '100%',
        background: '#fff', borderRadius: 12,
        boxShadow: '0 32px 80px rgba(0,0,0,0.32)',
        display: 'flex', overflow: 'hidden',
        border: `1px solid ${C.border}`,
      }}>
        <HistorySidebar
          conversations={conversations}
          activeId={activeId}
          busyIds={busyConvoIds}
          onSelect={(id) => setActiveId(id)}
          onNewChat={newChat}
          onDeleteConvo={deleteConvo}
          onExportConvo={exportConvo}
        />
        {Body}
      </div>
    </div>
    {launcher}
    </>
  );
};

export default ChatAssistant;
