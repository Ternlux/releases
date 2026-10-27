/**
 * Data Explorer — worksheet tab strip and toolbar.
 *
 * Tabs rename on double-click. The toolbar carries Run (and what it will run),
 * Format, Copy, and the validation status for the current worksheet.
 */

import React, { useEffect, useRef, useState } from 'react';
import { C, MONO, SANS, Icon } from './theme';

export const WorksheetTabs = ({
  worksheets,
  activeId,
  onSelect,
  onNew,
  onClose,
  onRename,
  panelHidden,
  onShowPanel,
}) => {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const commit = () => {
    if (!editingId) return;
    onRename(editingId, draft.trim() || 'Untitled');
    setEditingId(null);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', minHeight: 36, flexShrink: 0, overflowX: 'auto',
      background: C.s2, borderBottom: `1px solid ${C.border}`, paddingLeft: panelHidden ? 0 : 6,
    }}>
      {panelHidden && (
        <button
          type="button"
          onClick={onShowPanel}
          title="Show object panel"
          style={{
            border: 'none', borderRight: `1px solid ${C.border}`, background: 'transparent',
            cursor: 'pointer', padding: '0 10px', display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
        >
          {Icon('panelOpen', C.muted, 15)}
        </button>
      )}

      {worksheets.map((sheet) => {
        const on = sheet.id === activeId;
        return (
          <div
            key={sheet.id}
            onClick={() => onSelect(sheet.id)}
            onDoubleClick={() => { setEditingId(sheet.id); setDraft(sheet.name); }}
            title="Double-click to rename"
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', gap: 7,
              padding: '0 9px 0 12px', cursor: 'pointer', minWidth: 132, maxWidth: 230,
              background: on ? C.bg : 'transparent',
              borderRight: `1px solid ${C.border}`,
              borderTop: on ? `2px solid ${C.accent}` : '2px solid transparent',
              borderBottom: on ? `1px solid ${C.bg}` : 'none',
              marginBottom: -1,
            }}
          >
            {Icon('doc', on ? C.accent : C.dim, 12)}
            {editingId === sheet.id ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                style={{
                  width: 110, padding: '2px 5px', borderRadius: 3, outline: 'none',
                  border: `1px solid ${C.accent}`, background: C.bg,
                  fontSize: 12, fontFamily: SANS, fontWeight: 600, color: C.text,
                }}
              />
            ) : (
              <span style={{
                flex: 1, fontSize: 12, letterSpacing: '-0.01em',
                fontWeight: on ? 600 : 500, color: on ? C.text : C.muted,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {sheet.name}
              </span>
            )}

            {sheet.dirty
              ? <span title="Saving…" style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber, flexShrink: 0 }} />
              : <span title="Saved" style={{ display: 'flex', flexShrink: 0, opacity: 0.5 }}>{Icon('check', C.green, 10)}</span>}

            {worksheets.length > 1 && (
              <button
                type="button"
                title="Close worksheet"
                onClick={(e) => { e.stopPropagation(); onClose(sheet.id); }}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: 1, display: 'flex', flexShrink: 0, opacity: on ? 0.7 : 0.35,
                }}
              >
                {Icon('close', C.muted, 11)}
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onNew}
        title="New worksheet"
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer',
          padding: '0 12px', display: 'flex', alignItems: 'center',
        }}
      >
        {Icon('plus', C.muted, 14)}
      </button>
      <div style={{ flex: 1 }} />
    </div>
  );
};

const ToolButton = ({ icon, label, onClick, tone, disabled, title }) => {
  const [hover, setHover] = useState(false);
  const primary = tone === 'primary';
  return (
    <button
      type="button"
      title={title || label}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 28,
        padding: label ? '0 11px' : '0 8px', borderRadius: 5, whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
        fontFamily: SANS, fontSize: 11.5, fontWeight: primary ? 600 : 500,
        border: `1px solid ${primary ? C.accent : C.border}`,
        background: primary
          ? (hover && !disabled ? C.accentDark : C.accent)
          : (hover && !disabled ? C.s2 : C.bg),
        color: primary ? '#fff' : C.text,
      }}
    >
      {icon}
      {label}
    </button>
  );
};

export const Toolbar = ({
  onRun,
  running,
  canRun,
  runScope,
  onFormat,
  canFormat,
  onCopy,
  issues = [],
}) => {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity !== 'error');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', flexShrink: 0,
      background: C.bg, borderBottom: `1px solid ${C.border}`,
    }}>
      <ToolButton
        tone="primary"
        icon={running ? Icon('stop', '#fff', 11) : Icon('play', '#fff', 11)}
        label={running ? 'Running…' : 'Run'}
        onClick={onRun}
        disabled={!canRun || running}
        title="Run the selection, or the statement at the caret · ⌘↵"
      />
      <span style={{ fontSize: 9, fontFamily: MONO, color: C.dim, letterSpacing: '0.04em' }}>⌘↵</span>

      {runScope && (
        <span style={{
          fontSize: 10, fontFamily: MONO, color: C.muted,
          padding: '2px 7px', borderRadius: 3,
          background: C.s2, border: `1px solid ${C.border}`, whiteSpace: 'nowrap',
        }}>
          {runScope}
        </span>
      )}

      <div style={{ width: 1, height: 20, background: C.border, margin: '0 2px' }} />

      {canFormat && (
        <ToolButton icon={Icon('wand', C.muted, 12)} label="Format" onClick={onFormat} title="Format this statement" />
      )}
      <ToolButton icon={Icon('copy', C.muted, 12)} label="Copy" onClick={onCopy} title="Copy the worksheet" />

      <div style={{ flex: 1 }} />

      {/* Validation is advisory — it reports, it never blocks Run. */}
      {errors.length > 0 && (
        <span
          title={errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n')}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20,
            background: C.redD, border: `1px solid ${C.redB}`,
            fontSize: 10.5, fontFamily: MONO, fontWeight: 600, color: C.red, whiteSpace: 'nowrap',
          }}
        >
          {Icon('alert', C.red, 10)}
          {errors.length} error{errors.length === 1 ? '' : 's'}
        </span>
      )}
      {errors.length === 0 && warnings.length > 0 && (
        <span
          title={`${warnings.map((w) => `Line ${w.line}: ${w.message}`).join('\n')}\n\nThe parser does not model every vendor extension — this may still run.`}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20,
            background: C.amberD, border: `1px solid ${C.amberB}`,
            fontSize: 10.5, fontFamily: MONO, fontWeight: 600, color: C.amber, whiteSpace: 'nowrap',
          }}
        >
          {Icon('alert', C.amber, 10)}
          {warnings.length} warning{warnings.length === 1 ? '' : 's'}
        </span>
      )}
      {issues.length === 0 && (
        <span style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20,
          background: C.greenD, border: '1px solid #a7f3d0',
          fontSize: 10.5, fontFamily: MONO, fontWeight: 600, color: C.green, whiteSpace: 'nowrap',
        }}>
          {Icon('check', C.green, 10)} valid
        </span>
      )}
    </div>
  );
};
