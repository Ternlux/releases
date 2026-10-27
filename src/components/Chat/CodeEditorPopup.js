import React, { useState, useRef, useEffect } from 'react';
import {
    Box,
    Dialog,
    IconButton,
    Typography,
    Button,
    Tooltip,
} from '@mui/material';
import {
    Close as CloseIcon,
    Save as SaveIcon,
    RestartAlt as ResetIcon,
} from '@mui/icons-material';
import Editor from '@monaco-editor/react';

// Palette aligned with WorkflowEditor / NodeChatPanel
const MONO = "'JetBrains Mono', monospace";
const SANS = "'Inter',-apple-system,sans-serif";
const BORDER = '#e2e6eb';
const SURFACE = '#f7f9fc';
const SURFACE_2 = '#eef1f6';
const TEXT = '#111827';
const MUTED = '#5a6678';
const ACCENT = '#2563eb';
const ACCENT_HOVER = '#1d4ed8';

const CodeEditorPopup = ({
    open,
    onClose,
    title = 'Code',
    code: initialCode = '',
    language = 'sql',
    onSave,
}) => {
    const [code, setCode] = useState(initialCode);
    const editorRef = useRef(null);

    // Reset the editor whenever the popup re-opens for a different code section.
    useEffect(() => {
        if (open) {
            setCode(initialCode);
        }
    }, [open, initialCode]);

    const isDirty = code !== initialCode;

    const handleEditorMount = (editor) => {
        editorRef.current = editor;
    };

    const handleSave = () => {
        if (!isDirty) {
            onClose?.();
            return;
        }
        onSave?.(code);
        onClose?.();
    };

    const handleReset = () => {
        setCode(initialCode);
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullScreen
            // MUI traps focus inside a Dialog: FocusTrap listens for `focusin`
            // on the document and, whenever the focused element is outside the
            // dialog, calls rootElement.focus() to pull it back. The pinned
            // assistant rail sits outside — the dialog is portalled to <body>
            // and App.css keeps it clear of the rail — so clicking the chat
            // input focused it and had focus yanked away again before a single
            // keystroke landed.
            //
            // The rail is deliberately still visible and usable next to this
            // editor (asking the assistant about the code you are editing is
            // the obvious thing to want), so the trap has to be off rather than
            // the rail covered. Focus still moves INTO the editor on open —
            // that is disableAutoFocus, left alone.
            disableEnforceFocus
            PaperProps={{
                sx: {
                    bgcolor: '#fff',
                    color: TEXT,
                    fontFamily: SANS,
                },
            }}
        >
            {/* Title bar — matches NodeChatPanel header treatment */}
            <Box
                sx={{
                    px: 2,
                    pl: 10,
                    py: 1.25,
                    bgcolor: '#fff',
                    borderBottom: `1px solid ${BORDER}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    flexShrink: 0,
                }}
            >
                <Box
                    sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        bgcolor: isDirty ? '#f59e0b' : '#10b981',
                        flexShrink: 0,
                    }}
                />
                <Typography sx={{ fontSize: 13, fontWeight: 600, color: TEXT, fontFamily: SANS }}>
                    {title}
                </Typography>
                <Typography
                    sx={{
                        fontSize: 9,
                        fontFamily: MONO,
                        color: MUTED,
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        fontWeight: 700,
                        bgcolor: SURFACE,
                        border: `1px solid ${BORDER}`,
                        px: 0.75,
                        py: 0.25,
                        borderRadius: 0.75,
                    }}
                >
                    {language}
                </Typography>
                {isDirty && (
                    <Typography sx={{ fontSize: 10, color: '#b45309', fontFamily: MONO, fontWeight: 600 }}>
                        ● modified
                    </Typography>
                )}

                <Box sx={{ flex: 1 }} />

                <Tooltip title="Reset to original">
                    <span>
                        <IconButton
                            size="small"
                            onClick={handleReset}
                            disabled={!isDirty}
                            sx={{
                                color: MUTED,
                                '&:hover': { color: TEXT, bgcolor: SURFACE_2 },
                                '&.Mui-disabled': { color: '#cbd0d8' },
                            }}
                        >
                            <ResetIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                    </span>
                </Tooltip>
                <Button
                    size="small"
                    startIcon={<SaveIcon sx={{ fontSize: '14px !important' }} />}
                    onClick={handleSave}
                    disabled={!isDirty}
                    sx={{
                        color: '#fff',
                        bgcolor: isDirty ? ACCENT : SURFACE,
                        boxShadow: 'none',
                        '&:hover': { bgcolor: isDirty ? ACCENT_HOVER : SURFACE, boxShadow: 'none' },
                        '&.Mui-disabled': { bgcolor: SURFACE, color: '#cbd0d8', border: `1px solid ${BORDER}` },
                        textTransform: 'none',
                        fontWeight: 600,
                        fontSize: 12,
                        px: 1.5,
                        py: 0.4,
                        minHeight: 0,
                        borderRadius: 1,
                    }}
                >
                    Save
                </Button>
                <IconButton
                    size="small"
                    onClick={onClose}
                    sx={{
                        color: MUTED,
                        '&:hover': { color: TEXT, bgcolor: SURFACE_2 },
                    }}
                >
                    <CloseIcon sx={{ fontSize: 18 }} />
                </IconButton>
            </Box>

            {/* Editor */}
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, bgcolor: '#fff' }}>
                <Editor
                    height="100%"
                    language={language}
                    value={code}
                    onChange={(value) => setCode(value ?? '')}
                    onMount={handleEditorMount}
                    beforeMount={(monaco) => {
                        monaco.editor.defineTheme('ternlux-light', {
                            base: 'vs',
                            inherit: true,
                            rules: [],
                            colors: {
                                'editor.background': '#ffffff',
                                'editor.foreground': '#111827',
                                'editorLineNumber.foreground': '#9ca3af',
                                'editorLineNumber.activeForeground': '#5a6678',
                                'editor.selectionBackground': '#dbeafe',
                                'editor.inactiveSelectionBackground': '#eef1f6',
                                'editor.lineHighlightBackground': '#f7f9fc',
                                'editorCursor.foreground': '#2563eb',
                                'editorIndentGuide.background': '#eef1f6',
                                'editorIndentGuide.activeBackground': '#cdd2db',
                                'editorWhitespace.foreground': '#e2e6eb',
                                'editorWidget.background': '#ffffff',
                                'editorWidget.border': '#e2e6eb',
                                'editorGutter.background': '#ffffff',
                                'scrollbarSlider.background': '#e2e6eb88',
                                'scrollbarSlider.hoverBackground': '#cdd2dbcc',
                                'scrollbarSlider.activeBackground': '#5a667888',
                                'minimap.background': '#f7f9fc',
                            },
                        });
                    }}
                    theme="ternlux-light"
                    options={{
                        minimap: { enabled: true },
                        fontSize: 13,
                        fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        wordWrap: 'on',
                        tabSize: 2,
                        renderWhitespace: 'selection',
                        padding: { top: 12, bottom: 12 },
                    }}
                />
            </Box>
        </Dialog>
    );
};

export default CodeEditorPopup;
