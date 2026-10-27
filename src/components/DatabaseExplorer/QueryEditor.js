/**
 * Data Explorer — worksheet editor.
 *
 * Monaco does the editing; this wires in the parts that make it a database
 * editor rather than a text box:
 *
 *   · ⌘↵ / Ctrl+↵ runs the selection, or the statement the caret is in
 *   · the statement about to run is highlighted, so Run is never a surprise
 *   · validation issues appear as markers, advisory only — Run is never blocked
 *   · completions come from the live schema (see ./completions)
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { C } from './theme';
import { resolveRunTarget, splitStatements, statementAt } from './statements';
import { makeCompletionProvider } from './completions';

/** Monaco language id for an engine's editor mode. */
const monacoLanguage = (language) => (language === 'json' ? 'javascript' : 'sql');

const QueryEditor = forwardRef(({
  value,
  onChange,
  language = 'sql',
  issues = [],
  onRun,
  onSelectionChange,
  getCompletionContext,
  onNeedColumns,
}, ref) => {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationsRef = useRef(null);
  const highlightFrame = useRef(null);
  const completionRef = useRef(null);
  // Read inside Monaco callbacks, which capture their first closure.
  const runRef = useRef(onRun);
  const ctxRef = useRef(getCompletionContext);
  const colsRef = useRef(onNeedColumns);

  useEffect(() => { runRef.current = onRun; }, [onRun]);
  useEffect(() => { ctxRef.current = getCompletionContext; }, [getCompletionContext]);
  useEffect(() => { colsRef.current = onNeedColumns; }, [onNeedColumns]);

  /** What Run should execute right now, from the live editor state. */
  const getRunTarget = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return null;
    const model = editor.getModel();
    if (!model) return null;

    const selection = editor.getSelection();
    const selected = selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';

    return resolveRunTarget({
      text: model.getValue(),
      selection: selected,
      cursorOffset: model.getOffsetAt(editor.getPosition()),
    });
  }, []);

  useImperativeHandle(ref, () => ({
    getRunTarget,
    focus: () => editorRef.current && editorRef.current.focus(),
    /** The live buffer — ahead of committed state while typing. */
    getValue: () => (editorRef.current ? editorRef.current.getValue() : ''),
    /** Replace the whole worksheet and put the caret at the end. */
    setValue: (text) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setValue(text);
      const model = editor.getModel();
      if (model) editor.setPosition(model.getPositionAt(text.length));
      editor.focus();
    },
    /** Insert at the caret, replacing the selection if there is one. */
    insert: (text) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.executeEdits('explorer-insert', [{
        range: editor.getSelection(),
        text,
        forceMoveMarkers: true,
      }]);
      editor.focus();
    },
  }), [getRunTarget]);

  /**
   * Tint the statement that ⌘↵ would run.
   *
   * Scheduled on an animation frame rather than run inline: applying
   * decorations from inside a cursor/content change handler re-enters Monaco's
   * decoration path, which it rejects ("Invoking deltaDecorations recursively").
   * Coalescing to one frame also keeps the statement split off the keystroke
   * path while typing.
   */
  const highlightActiveStatement = useCallback(() => {
    if (highlightFrame.current) cancelAnimationFrame(highlightFrame.current);

    highlightFrame.current = requestAnimationFrame(() => {
      highlightFrame.current = null;

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const collection = decorationsRef.current;
      if (!editor || !monaco || !collection) return;
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) return;

      const selection = editor.getSelection();
      // While text is selected, that selection *is* the target — Monaco already
      // shows it, so a second highlight would only add noise.
      if (selection && !selection.isEmpty()) {
        collection.clear();
        return;
      }

      const statements = splitStatements(model.getValue());
      // With a single statement the whole sheet is the target; highlighting it
      // says nothing.
      if (statements.length < 2) {
        collection.clear();
        return;
      }

      const active = statementAt(statements, model.getOffsetAt(position));
      if (!active) {
        collection.clear();
        return;
      }

      const from = model.getPositionAt(active.start);
      const to = model.getPositionAt(active.end);
      collection.set([{
        range: new monaco.Range(from.lineNumber, 1, to.lineNumber, model.getLineMaxColumn(to.lineNumber)),
        options: { isWholeLine: true, className: 'explorer-active-statement' },
      }]);
    });
  }, []);

  useEffect(() => () => {
    if (highlightFrame.current) cancelAnimationFrame(highlightFrame.current);
  }, []);

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // A collection owns its decorations, so there is no previous-id bookkeeping
    // to get wrong and nothing to leak when the editor unmounts.
    decorationsRef.current = editor.createDecorationsCollection([]);

    // Document-store worksheets are tokenised as JavaScript so shell syntax
    // reads well, but Monaco's own TS diagnostics would flag `db` as undefined.
    // Our validator is the only thing that should mark this buffer.
    if (monaco.languages.typescript) {
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });
    }

    // ⌘↵ / Ctrl+↵ — run the selection or the statement at the caret.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const target = getRunTarget();
      if (target && runRef.current) runRef.current(target);
    });

    editor.onDidChangeCursorSelection(() => {
      highlightActiveStatement();
      if (!onSelectionChange) return;
      const model = editor.getModel();
      const sel = editor.getSelection();
      onSelectionChange(sel && !sel.isEmpty() && model ? model.getValueInRange(sel) : '');
    });

    editor.onDidChangeModelContent(highlightActiveStatement);
    highlightActiveStatement();
  }, [getRunTarget, highlightActiveStatement, onSelectionChange]);

  // Register completions per language, and dispose on change/unmount so two
  // explorers open in sequence never stack providers.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return undefined;

    const provider = makeCompletionProvider(
      monaco,
      () => (ctxRef.current ? ctxRef.current() : null),
      (pending) => colsRef.current && colsRef.current(pending),
    );
    completionRef.current = monaco.languages.registerCompletionItemProvider(
      monacoLanguage(language),
      provider,
    );

    return () => {
      if (completionRef.current) {
        completionRef.current.dispose();
        completionRef.current = null;
      }
    };
    // monacoRef is populated on mount; `value` in deps would re-register per
    // keystroke, so this intentionally keys on language alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, editorRef.current]);

  // Push validation issues in as markers.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;

    monaco.editor.setModelMarkers(model, 'explorer', (issues || []).map((issue) => {
      const line = Math.min(Math.max(1, issue.line || 1), model.getLineCount());
      const column = Math.max(1, issue.column || 1);
      return {
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        // Underline to the end of the line — we have a point, not a span.
        endColumn: model.getLineMaxColumn(line),
        message: issue.message,
        severity: issue.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : monaco.MarkerSeverity.Warning,
      };
    }));
  }, [issues]);

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', background: C.bg }}>
      <style>{`
        .explorer-active-statement { background: rgba(37,99,235,0.055); }
      `}</style>
      <Editor
        height="100%"
        theme="vs"
        language={monacoLanguage(language)}
        // Uncontrolled: Monaco owns the buffer. A controlled `value` would make
        // every keystroke a React render of the whole explorer — including the
        // object tree — which is what made typing lag. The parent remounts this
        // component (keyed on worksheet id) when the sheet changes, and uses the
        // imperative setValue for Format and history loads.
        defaultValue={value}
        onChange={(next) => onChange(next || '')}
        onMount={handleMount}
        options={{
          fontSize: 13,
          fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderLineHighlight: 'line',
          automaticLayout: true,
          wordWrap: 'on',
          padding: { top: 10, bottom: 10 },
          tabSize: 2,
          suggestSelection: 'first',
          // Our completions are the useful ones; Monaco's word-scraper would
          // bury them under every token already in the buffer.
          wordBasedSuggestions: false,
          quickSuggestions: { other: true, comments: false, strings: false },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        }}
      />
    </div>
  );
});

QueryEditor.displayName = 'QueryEditor';

export default QueryEditor;
