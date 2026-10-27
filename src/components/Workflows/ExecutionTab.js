import React, { useState, useEffect, useMemo } from 'react';
import { Spin, message } from 'antd';
import moment from 'moment';
import axios from 'axios';
import { executionsDb } from '../../utils/localDb';
import {
  C, MONO, SANS, I, Btn, PageHeader, StatCard, StatusBadge, STATUS_CFG,
} from './_designShared';

// ── Helpers ─────────────────────────────────────────────────────────
const formatDuration = (ms) => {
  if (!ms && ms !== 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `0m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

const formatStarted = (t) => t ? moment(t).format('MMM DD HH:mm') : '—';

// Triggers we recognize for filtering — stored on execution.trigger.type
const ALL_TRIGGERS = ['manual', 'schedule'];
const ALL_STATUSES = ['completed', 'running', 'failed', 'cancelled'];

// ── Filter Bar ──────────────────────────────────────────────────────
const FilterBar = ({ filters, setFilters, workflows, users }) => {
  const activeCount = (filters.status ? 1 : 0) + (filters.workflow ? 1 : 0) +
    (filters.trigger ? 1 : 0) + (filters.user ? 1 : 0) + (filters.search ? 1 : 0);

  const pill = (label, active, onClick) => (
    <button type="button" onClick={onClick}
      style={{
        padding: '4px 10px', borderRadius: 3,
        border: `1px solid ${active ? C.accent : C.border}`,
        background: active ? C.aD : '#fff',
        color: active ? C.accent : C.muted,
        fontSize: 11, fontWeight: active ? 600 : 500, fontFamily: SANS,
        cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}>
      {label}
    </button>
  );

  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            {I('eye', C.dim, 12)}
          </span>
          <input
            placeholder="Search workflow name…"
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            style={{
              width: '100%', padding: '6px 10px 6px 28px', fontSize: 12, fontFamily: SANS,
              border: `1px solid ${C.border}`, borderRadius: 4, outline: 'none',
              color: C.text, background: '#fff',
            }}
            onFocus={e => { e.target.style.borderColor = C.accent; e.target.style.boxShadow = `0 0 0 2px ${C.aD}`; }}
            onBlur={e => { e.target.style.borderColor = C.border; e.target.style.boxShadow = 'none'; }}
          />
        </div>
        {activeCount > 0 && (
          <button type="button"
            onClick={() => setFilters({ status: '', workflow: '', trigger: '', user: '', search: '' })}
            style={{
              fontSize: 11, color: C.muted, background: 'none', border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontFamily: SANS,
              display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
            }}>
            {I('x', C.muted, 10)} Clear filters
            <span style={{
              background: C.accent, color: '#fff', borderRadius: 3,
              fontSize: 9, fontWeight: 700, padding: '1px 5px', fontFamily: MONO,
            }}>{activeCount}</span>
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, color: C.dim, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em', fontFamily: MONO, minWidth: 44,
        }}>Status</span>
        {ALL_STATUSES.map(s => {
          const cfg = STATUS_CFG[s];
          const active = filters.status === s;
          return (
            <button key={s} type="button"
              onClick={() => setFilters(f => ({ ...f, status: f.status === s ? '' : s }))}
              style={{
                padding: '4px 10px', borderRadius: 3,
                border: `1px solid ${active ? cfg.border : C.border}`,
                background: active ? cfg.bg : '#fff',
                color: active ? cfg.color : C.muted,
                fontSize: 11, fontWeight: active ? 600 : 500, fontFamily: SANS,
                cursor: 'pointer', transition: 'all 0.15s',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
              {I(cfg.icon, active ? cfg.color : C.dim, 9)}
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          );
        })}

        <div style={{ width: 1, height: 16, background: C.border, margin: '0 2px' }} />

        <span style={{
          fontSize: 10, color: C.dim, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em', fontFamily: MONO,
        }}>Trigger</span>
        {ALL_TRIGGERS.map(t => pill(
          t.charAt(0).toUpperCase() + t.slice(1),
          filters.trigger === t,
          () => setFilters(f => ({ ...f, trigger: f.trigger === t ? '' : t })),
        ))}

        <div style={{ width: 1, height: 16, background: C.border, margin: '0 2px' }} />

        <span style={{
          fontSize: 10, color: C.dim, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em', fontFamily: MONO,
        }}>User</span>
        <select value={filters.user} onChange={e => setFilters(f => ({ ...f, user: e.target.value }))}
          style={{
            fontSize: 11, padding: '4px 8px', border: `1px solid ${filters.user ? C.accent : C.border}`,
            borderRadius: 4, background: filters.user ? C.aD : '#fff',
            color: filters.user ? C.accent : C.muted, fontFamily: SANS, outline: 'none', cursor: 'pointer',
          }}>
          <option value="">All users</option>
          {users.map(u => <option key={u} value={u}>{u}</option>)}
        </select>

        <select value={filters.workflow} onChange={e => setFilters(f => ({ ...f, workflow: e.target.value }))}
          style={{
            fontSize: 11, padding: '4px 8px', border: `1px solid ${filters.workflow ? C.accent : C.border}`,
            borderRadius: 4, background: filters.workflow ? C.aD : '#fff',
            color: filters.workflow ? C.accent : C.muted, fontFamily: SANS, outline: 'none', cursor: 'pointer',
          }}>
          <option value="">All workflows</option>
          {workflows.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
    </div>
  );
};

// ── Execution Row ───────────────────────────────────────────────────
const ExecutionRow = ({ ex, onSelect, selectedId }) => {
  const [hov, setHov] = useState(false);
  const active = selectedId === (ex.executionId || ex.id);
  const errorMsg = ex.error?.message || ex.error;
  const records = ex.results?.totalRecordsProcessed || 0;

  return (
    <div onMouseOver={() => setHov(true)} onMouseOut={() => setHov(false)}
      onClick={() => onSelect(ex)}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 120px 130px 90px 100px 110px 90px',
        alignItems: 'center', gap: 12, padding: '11px 16px',
        background: active ? C.aD : hov ? C.surface : 'transparent',
        borderBottom: `1px solid ${C.border}`,
        borderLeft: active ? `2px solid ${C.accent}` : '2px solid transparent',
        transition: 'background 0.1s', cursor: 'pointer',
      }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, letterSpacing: '-0.01em' }}>
          {ex.workflowName || ex.workflowId}
        </div>
        {errorMsg && (
          <div style={{
            fontSize: 11, color: C.red, marginTop: 2, fontFamily: MONO,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {errorMsg}
          </div>
        )}
      </div>
      <StatusBadge status={ex.status} />
      <span style={{ fontSize: 11, color: C.muted, fontFamily: MONO }}>{formatStarted(ex.startTime)}</span>
      <span style={{ fontSize: 11, color: C.muted, fontFamily: MONO }}>{formatDuration(ex.duration)}</span>
      <span style={{ fontSize: 11, color: C.muted, fontFamily: MONO }}>
        {records > 0 ? records.toLocaleString() : '—'}
      </span>
      <span style={{
        fontSize: 11, color: C.muted, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{ex.username || ex.user || 'Unknown'}</span>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn icon="eye" onClick={(e) => { e.stopPropagation(); onSelect(ex); }}>Details</Btn>
      </div>
    </div>
  );
};

// ── One log line ────────────────────────────────────────────────────
//
// A line is the message, plus whatever structured `detail` the execution
// tracer attached to it (see NodeExecution/executionLog.js). `sql` gets its own
// block because it is the thing you came here to read — a statement folded into
// the message line is unreadable the moment it wraps — and the rest is rendered
// as a compact meta row so a slow connector call shows its duration without
// anyone having to expand anything further.
//
// Everything is optional: entries written before this existed, and the plain
// orchestrator lines, carry no `detail` at all and render exactly as they did.
const LOG_COLORS = {
  error: { level: '#f87171', text: '#fca5a5' },
  warn:  { level: '#fbbf24', text: '#fde68a' },
  // Output validation writes 'warning' where the executor writes 'warn'. The
  // monitor already treats them alike (logColor there); this view did not, so a
  // failed validation rendered in the same grey as an ordinary info line.
  warning: { level: '#fbbf24', text: '#fde68a' },
  info:  { level: '#64748b', text: '#e2e8f0' },
};

// Rendered in this order, and only these — `detail` also carries routing fields
// that would be noise on every line. The third entry is the label to print when
// the key itself would not read as one: `rowRange` is a span of RECORDS, and
// "rowRange=50,001–100,000" next to "rows=50000 rows" reads like two counts.
const META_FIELDS = [
  ['connector', ''], ['skillId', ''], ['phase', ''], ['table', ''],
  ['rowCount', ' rows'], ['rows', ' rows'], ['rowRange', '', 'records'],
  ['durationMs', 'ms'],
];

// Values that are their own label — a connector name, a phase — print bare.
const UNLABELLED_META = new Set(['connector', 'skillId', 'phase']);

const LogLine = ({ l }) => {
  const c = LOG_COLORS[l.level] || LOG_COLORS.info;
  const d = l.detail || null;
  const meta = d
    ? META_FIELDS
        .filter(([k]) => d[k] != null && d[k] !== '')
        .map(([k, suffix, label]) => `${UNLABELLED_META.has(k) ? '' : `${label || k}=`}${d[k]}${suffix}`)
    : [];

  return (
    <div style={{ marginBottom: d ? 6 : 0 }}>
      <div style={{ display: 'flex', gap: 10, whiteSpace: 'nowrap' }}>
        <span style={{ color: '#475569', flexShrink: 0 }}>
          [{l.timestamp ? moment(l.timestamp).format('HH:mm:ss') : (l.t || '')}]
        </span>
        <span style={{ color: c.level, flexShrink: 0, minWidth: 32 }}>
          {(l.level || 'info').toUpperCase()}
        </span>
        <span style={{ color: c.text, whiteSpace: 'pre-wrap' }}>{l.message || l.msg}</span>
      </div>
      {meta.length > 0 && (
        <div style={{ marginLeft: 92, color: '#64748b', fontSize: 10.5 }}>
          {meta.join('  ·  ')}
        </div>
      )}
      {d?.sql && (
        <pre style={{
          margin: '4px 0 0 92px', padding: '6px 8px', background: '#1e293b',
          border: '1px solid #334155', borderRadius: 4, color: '#cbd5e1',
          fontFamily: MONO, fontSize: 10.5, lineHeight: 1.5,
          whiteSpace: 'pre', overflowX: 'auto', maxHeight: 220,
        }}>{d.sql}</pre>
      )}
      {d?.error && !d.sql && (
        <div style={{ marginLeft: 92, color: '#fca5a5', fontSize: 10.5, whiteSpace: 'pre-wrap' }}>
          {d.error}
        </div>
      )}
    </div>
  );
};

// ── Node Row (collapsible logs per node) ────────────────────────────
const NodeRow = ({ n, index, logs }) => {
  const [expanded, setExpanded] = useState(false);
  const sc = STATUS_CFG[n.status] || STATUS_CFG.cancelled;
  const hasLogs = logs && logs.length > 0;
  const records = n.metrics?.recordsProcessed ?? n.records;

  return (
    <div style={{
      borderRadius: 5, border: `1px solid ${expanded ? C.border2 : C.border}`,
      overflow: 'hidden', transition: 'border-color 0.15s',
    }}>
      <div onClick={() => hasLogs && setExpanded(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          background: expanded ? C.s2 : C.surface,
          cursor: hasLogs ? 'pointer' : 'default',
          transition: 'background 0.1s', userSelect: 'none',
        }}
        onMouseOver={e => { if (hasLogs) e.currentTarget.style.background = C.s2; }}
        onMouseOut={e => { if (!expanded) e.currentTarget.style.background = C.surface; }}>
        <div style={{
          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
          background: C.aD, border: '1px solid rgba(37,99,235,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 700, fontFamily: MONO, color: C.accent,
        }}>{index + 1}</div>
        <div style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
          background: sc.bg, border: `1px solid ${sc.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{I(sc.icon, sc.color, 8)}</div>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: C.text }}>
          {n.nodeName || n.name || n.nodeId}
        </span>
        {records != null && (
          <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>
            {Number(records).toLocaleString()} rows
          </span>
        )}
        <span style={{
          fontSize: 11, color: C.dim, fontFamily: MONO, minWidth: 56, textAlign: 'right',
        }}>{formatDuration(n.duration)}</span>
        {hasLogs && (
          <span style={{
            marginLeft: 6, color: C.dim, transition: 'transform 0.2s', display: 'flex',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}>{I('chevron', C.dim, 12)}</span>
        )}
      </div>
      {expanded && hasLogs && (
        <div style={{
          background: '#0f172a', padding: '10px 14px', fontFamily: MONO, fontSize: 11,
          lineHeight: 1.7, overflowX: 'auto', borderTop: `1px solid ${C.border}`,
        }}>
          {logs.map((l, i) => <LogLine key={i} l={l} />)}
        </div>
      )}
    </div>
  );
};

// ── Build node-execution order from a fetched execution detail ──────
const buildNodeOrder = (detail) => {
  if (!detail) return [];
  const nodes = detail.nodeExecutions || [];
  const order = detail.executionOrder;

  if (!order || order.length === 0) return nodes;

  // Map ordering by id when possible, fall back to original list otherwise
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const ordered = order.map(id => byId.get(id)).filter(Boolean);
  // Append any nodes not present in executionOrder, preserving original order
  nodes.forEach(n => { if (!order.includes(n.nodeId)) ordered.push(n); });
  return ordered;
};

const groupLogsByNode = (logs) => {
  const map = new Map();
  (logs || []).forEach(log => {
    const key = log.nodeId || log.nodeName || '__global__';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(log);
  });
  return map;
};

// ── Detail Modal ────────────────────────────────────────────────────
const DetailPanel = ({ ex, onClose }) => {
  const orderedNodes = buildNodeOrder(ex);
  const logsByNode = useMemo(() => groupLogsByNode(ex?.logs), [ex]);
  const errorMsg = ex.error?.message || ex.error;
  const records = ex.results?.totalRecordsProcessed || 0;

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.35)', zIndex: 1300,
        backdropFilter: 'blur(2px)',
      }} />
      <div style={{
        // Fills its containing block — the app column when the assistant is
        // pinned, the window otherwise — leaving a 5% gap all round.
        position: 'fixed', inset: '1%', zIndex: 1400,
        background: '#fff', borderRadius: 8,
        border: `1px solid ${C.border}`,
        boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: SANS,
      }}>
        <div style={{
          padding: '18px 20px', borderBottom: `1px solid ${C.border}`, flexShrink: 0,
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 14, fontWeight: 700, color: C.text,
              letterSpacing: '-0.02em', marginBottom: 6,
            }}>{ex.workflowName || ex.workflowId}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <StatusBadge status={ex.status} />
              <span style={{
                fontSize: 11, color: C.dim, fontFamily: MONO,
                display: 'flex', alignItems: 'center', gap: 3,
              }}>
                {I('clock', C.dim, 10)}{' '}
                {ex.startTime ? moment(ex.startTime).format('MMM DD, YYYY HH:mm') : '—'}
              </span>
              {ex.trigger?.type && (
                <span style={{
                  fontSize: 11, color: C.dim, fontFamily: MONO,
                  display: 'flex', alignItems: 'center', gap: 3,
                }}>
                  {I('zap', C.dim, 10)} {ex.trigger.type}
                </span>
              )}
              {(ex.username || ex.user) && (
                <span style={{
                  fontSize: 11, color: C.dim, fontFamily: MONO,
                  display: 'flex', alignItems: 'center', gap: 3,
                }}>
                  {I('user', C.dim, 10)} {ex.username || ex.user}
                </span>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose}
            style={{
              border: 'none', background: 'none', cursor: 'pointer', padding: 5,
              color: C.dim, borderRadius: 4, flexShrink: 0, display: 'flex',
            }}
            onMouseOver={e => e.currentTarget.style.background = C.s2}
            onMouseOut={e => e.currentTarget.style.background = 'none'}>
            {I('x', C.dim, 16)}
          </button>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3,1fr)',
          borderBottom: `1px solid ${C.border}`, flexShrink: 0,
        }}>
          {[
            { label: 'Duration',     value: formatDuration(ex.duration) },
            { label: 'Records',      value: records > 0 ? records.toLocaleString() : '—' },
            { label: 'Execution ID', value: ex.executionId || ex.id || '—' },
          ].map(({ label, value }, i) => (
            <div key={label} style={{
              padding: '11px 18px',
              borderRight: i < 2 ? `1px solid ${C.border}` : 'none',
            }}>
              <div style={{
                fontSize: 10, color: C.dim, textTransform: 'uppercase',
                letterSpacing: '0.06em', fontFamily: MONO, marginBottom: 3,
              }}>{label}</div>
              <div style={{
                fontSize: 12, fontWeight: 600, color: C.text, fontFamily: MONO,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{value}</div>
            </div>
          ))}
        </div>

        {ex.outputTableName && (
          <div style={{
            padding: '9px 20px', background: C.gD, borderBottom: `1px solid ${C.gB}`,
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          }}>
            {I('table', C.green, 12)}
            <span style={{ fontSize: 11, color: C.green, fontWeight: 500 }}>Output:</span>
            <code style={{ fontSize: 11, fontFamily: MONO, color: C.green }}>{ex.outputTableName}</code>
          </div>
        )}
        {ex.validation && (
          <div style={{
            padding: '9px 20px',
            background: ex.validation.valid ? C.gD : C.amD,
            borderBottom: `1px solid ${ex.validation.valid ? C.gB : 'rgba(217,119,6,0.18)'}`,
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          }}>
            {I(ex.validation.valid ? 'check' : 'x', ex.validation.valid ? C.green : C.amber, 12)}
            <span style={{
              fontSize: 11, fontWeight: 500,
              color: ex.validation.valid ? C.green : C.amber,
            }}>
              {ex.validation.valid ? 'Output validated' : 'Validation failed:'}
            </span>
            {!ex.validation.valid && ex.validation.reason && (
              <span style={{ fontSize: 11, color: C.amber }}>{ex.validation.reason}</span>
            )}
          </div>
        )}
        {errorMsg && (
          <div style={{
            padding: '9px 20px', background: C.rD,
            borderBottom: '1px solid rgba(220,38,38,0.18)',
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          }}>
            {I('x', C.red, 12)}
            <code style={{ fontSize: 11, fontFamily: MONO, color: C.red }}>{errorMsg}</code>
          </div>
        )}

        <div style={{
          flex: 1, overflow: 'auto', padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 20,
        }}>
          <div>
            <div style={{
              fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase',
              letterSpacing: '0.07em', fontFamily: MONO, marginBottom: 8,
            }}>
              Node Executions
              <span style={{ marginLeft: 6, fontWeight: 400, color: C.dim }}>
                — click a row to see its logs
              </span>
            </div>
            {orderedNodes.length === 0 ? (
              <div style={{ fontSize: 12, color: C.dim, padding: '16px 0' }}>
                No node data available
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {orderedNodes.map((n, i) => {
                  const nodeLogs = logsByNode.get(n.nodeId) || logsByNode.get(n.nodeName) || [];
                  return <NodeRow key={n.nodeId || i} n={n} index={i} logs={nodeLogs} />;
                })}
              </div>
            )}
          </div>

          {logsByNode.has('__global__') && (
            <div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase',
                letterSpacing: '0.07em', fontFamily: MONO, marginBottom: 8,
              }}>Workflow Logs</div>
              <div style={{
                background: '#0f172a', padding: '10px 14px', fontFamily: MONO, fontSize: 11,
                lineHeight: 1.7, overflowX: 'auto', borderRadius: 5,
              }}>
                {logsByNode.get('__global__').map((l, i) => <LogLine key={i} l={l} />)}
              </div>
            </div>
          )}

          {orderedNodes.length > 0 && (
            <div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase',
                letterSpacing: '0.07em', fontFamily: MONO, marginBottom: 10,
              }}>Execution Order</div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0 }}>
                {orderedNodes.map((n, i) => (
                  <React.Fragment key={n.nodeId || i}>
                    <span style={{
                      fontSize: 11, fontFamily: MONO, color: C.text, padding: '4px 10px',
                      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4,
                    }}>
                      {i + 1}. {n.nodeName || n.name || n.nodeId}
                    </span>
                    {i < orderedNodes.length - 1 && (
                      <span style={{ color: C.dim, padding: '0 4px', fontSize: 12 }}>→</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

// ── Main ────────────────────────────────────────────────────────────
const ExecutionTab = ({ onContextChange = () => {} }) => {
  const [executions, setExecutions] = useState([]);
  const [selectedExecution, setSelectedExecution] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [filters, setFilters] = useState({
    status: '', workflow: '', trigger: '', user: '', search: '',
  });
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, hasMore: false });

  const fetchExecutions = async (page = 1, showLoading = true) => {
    if (showLoading) setLoading(true);
    const token = localStorage.getItem('auth-token');
    try {
      // Remote executions fetch disabled — backend returns 403 for logged-in
      // tokens, so we always read from the local executions store.
      // if (token) {
      //   const offset = (page - 1) * pagination.limit;
      //   const response = await axios.get(
      //     `/workflow/executions?limit=${pagination.limit}&offset=${offset}`,
      //     { headers: { 'auth-token': token } });
      //   if (response.data.success) {
      //     setExecutions(response.data.data || []);
      //     setPagination(prev => ({ ...prev, ...(response.data.pagination || {}) }));
      //   } else {
      //     message.error('Failed to load executions');
      //     setExecutions([]);
      //   }
      // } else {
      const result = await executionsDb.getAll({ page, limit: pagination.limit });
      setExecutions(result.docs || []);
      setPagination(prev => ({
        ...prev, page, total: result.total, hasMore: result.hasMore,
      }));
      // }
    } catch (error) {
      console.error('Error fetching executions:', error);
      if (token && error.response?.status === 404) {
        try {
          const result = await executionsDb.getAll({ page, limit: pagination.limit });
          setExecutions(result.docs || []);
          setPagination(prev => ({
            ...prev, page, total: result.total, hasMore: result.hasMore,
          }));
        } catch (localError) {
          console.error('Error fetching from the local store:', localError);
          message.error('Failed to load executions');
          setExecutions([]);
        }
      } else {
        message.error('Failed to load executions');
        setExecutions([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    const token = localStorage.getItem('auth-token');
    try {
      // Remote stats fetch disabled — backend returns 403 for logged-in
      // tokens, so we always read stats from the local executions store.
      // if (token) {
      //   const response = await axios.get('/workflow/executions/stats', {
      //     headers: { 'auth-token': token },
      //   });
      //   if (response.data.success) setStats(response.data.data);
      // } else {
      setStats(await executionsDb.getStats());
      // }
    } catch (error) {
      console.error('Error fetching stats:', error);
      if (token && error.response?.status === 404) {
        try { setStats(await executionsDb.getStats()); } catch (e) { /* ignore */ }
      }
    }
  };

  useEffect(() => {
    fetchExecutions();
    fetchStats();
    const interval = setInterval(() => { fetchExecutions(pagination.page, false); }, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the chat assistant on the open execution; passing null (on close)
  // takes it back out of focus.
  const reportSelected = (execution) => {
    if (!execution) { onContextChange(null); return; }
    onContextChange({
      kind: 'execution',
      id: execution.executionId || execution.id || execution._id,
      name: execution.workflowName || `execution ${execution.executionId || execution.id}`,
      summary: `status: ${execution.status || 'unknown'} · trigger: ${execution.trigger?.type || 'manual'}`,
    });
  };

  const fetchExecutionDetails = async (executionId) => {
    const token = localStorage.getItem('auth-token');
    try {
      // if (token) {
      //   const response = await axios.get(`/workflow/executions/${executionId}`, {
      //     headers: { 'auth-token': token },
      //   });
      //   if (response.data.success) {
      //     setSelectedExecution(response.data.data);
      //     reportSelected(response.data.data);
      //   } else {
      //     message.error('Failed to load execution details');
      //   }
      // } else {
        const execution = await executionsDb.getById(executionId);
        if (execution) { setSelectedExecution(execution); reportSelected(execution); }
        else message.error('Execution not found');
      // }
    } catch (error) {
      console.error('Error fetching execution details:', error);
      if (token && error.response?.status === 404) {
        try {
          const execution = await executionsDb.getById(executionId);
          if (execution) { setSelectedExecution(execution); reportSelected(execution); }
          else message.error('Execution not found');
        } catch (localError) {
          console.error('Error fetching execution from the local store:', localError);
          message.error('Failed to load execution details');
        }
      } else {
        message.error('Failed to load execution details');
      }
    }
  };

  // While a running execution is open, keep pulling its record so its logs and
  // node statuses stream in live. Stops once it is no longer running or closed.
  useEffect(() => {
    const ex = selectedExecution;
    if (!ex || ex.status !== 'running') return;
    const executionId = ex.executionId || ex.id;
    if (!executionId) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const fresh = await executionsDb.getById(executionId);
        if (cancelled || !fresh) return;
        setSelectedExecution(fresh);
        // Keep the list row in sync (status/duration/records) as it finishes.
        setExecutions(prev => prev.map(e =>
          (e.executionId || e.id) === executionId ? { ...e, ...fresh } : e));
        if (fresh.status !== 'running') fetchStats();
      } catch (err) {
        console.error('Error polling execution:', err);
      }
    }, 2000);

    return () => { cancelled = true; clearInterval(interval); };
    // Re-run only when a different execution is opened or its running state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExecution?.executionId || selectedExecution?.id, selectedExecution?.status]);

  // Distinct workflows / users for filter dropdowns
  const workflowOptions = useMemo(
    () => Array.from(new Set(executions.map(e => e.workflowName).filter(Boolean))).sort(),
    [executions]);
  const userOptions = useMemo(
    () => Array.from(new Set(executions.map(e => e.username || e.user).filter(Boolean))).sort(),
    [executions]);

  const filtered = useMemo(() => executions.filter(ex => {
    const trig = ex.trigger?.type || ex.trigger;
    const usr = ex.username || ex.user;
    if (filters.status && ex.status !== filters.status) return false;
    if (filters.workflow && ex.workflowName !== filters.workflow) return false;
    if (filters.trigger && trig !== filters.trigger) return false;
    if (filters.user && usr !== filters.user) return false;
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      if (!(ex.workflowName || '').toLowerCase().includes(needle)) return false;
    }
    return true;
  }), [executions, filters]);

  // Stat card numbers — prefer API stats when present, otherwise compute locally.
  const computedStats = useMemo(() => {
    if (stats) {
      return {
        total: stats.totalExecutions ?? executions.length,
        completed: stats.completedExecutions ?? 0,
        failed: stats.failedExecutions ?? 0,
        avgDuration: stats.avgDurationMs ? formatDuration(stats.avgDurationMs) : '—',
        successRate: stats.successRate,
      };
    }
    const completed = executions.filter(e => e.status === 'completed').length;
    const failed = executions.filter(e => e.status === 'failed').length;
    const durations = executions.map(e => e.duration).filter(d => typeof d === 'number');
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    return {
      total: executions.length,
      completed,
      failed,
      avgDuration: avg != null ? formatDuration(avg) : '—',
      successRate: executions.length ? (completed / executions.length) * 100 : null,
    };
  }, [stats, executions]);

  const handleRefresh = () => { fetchExecutions(pagination.page); fetchStats(); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: C.surface }}>
      <PageHeader
        title="Workflow Executions"
        sub="Monitor execution history and logs"
        actions={[
          <Btn key="r" icon="reload" onClick={handleRefresh} disabled={loading}>Refresh</Btn>,
        ]}
      />
      {/* Column flex scroller: children need flexShrink: 0 or they compress to
          fit instead of overflowing, and nothing scrolls. */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, flexShrink: 0 }}>
          <StatCard label="Total Executions" value={String(computedStats.total)} sub="all time" />
          <StatCard label="Completed" value={String(computedStats.completed)}
            sub={computedStats.successRate != null ? `${computedStats.successRate.toFixed(1)}% success` : undefined}
            color={C.green} />
          <StatCard label="Failed" value={String(computedStats.failed)}
            sub={computedStats.total > 0 ? `${((computedStats.failed / computedStats.total) * 100).toFixed(1)}% failure` : undefined}
            color={C.red} />
          <StatCard label="Avg Duration" value={computedStats.avgDuration} sub="per run" />
        </div>

        <FilterBar filters={filters} setFilters={setFilters}
          workflows={workflowOptions} users={userOptions} />

        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 120px 130px 90px 100px 110px 90px',
            gap: 12, padding: '9px 16px', background: C.surface, borderBottom: `1px solid ${C.border}`,
          }}>
            {['Workflow', 'Status', 'Started', 'Duration', 'Records', 'User', ''].map((h, i) => (
              <span key={h + i} style={{
                fontSize: 10, fontWeight: 700, color: C.muted,
                textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: MONO,
                textAlign: i === 6 ? 'right' : 'left',
              }}>{h}</span>
            ))}
          </div>
          {loading ? (
            <div style={{ padding: 50, textAlign: 'center' }}>
              <Spin size="large" />
              <div style={{ marginTop: 12, fontSize: 12, color: C.muted }}>Loading executions…</div>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '40px 16px', textAlign: 'center', color: C.dim, fontSize: 12 }}>
              {executions.length === 0
                ? 'No executions yet — workflow executions will appear here once you run your workflows.'
                : 'No executions match the current filters'}
            </div>
          ) : filtered.map(ex => (
            <ExecutionRow key={ex.executionId || ex.id}
              ex={ex}
              onSelect={(e) => fetchExecutionDetails(e.executionId || e.id)}
              selectedId={selectedExecution?.executionId || selectedExecution?.id} />
          ))}
        </div>

        {filtered.length > 0 && (
          <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, textAlign: 'right', flexShrink: 0 }}>
            {filtered.length} of {executions.length} executions
          </div>
        )}
      </div>

      {selectedExecution && (
        <DetailPanel ex={selectedExecution} onClose={() => { setSelectedExecution(null); reportSelected(null); }} />
      )}
    </div>
  );
};

export default ExecutionTab;
