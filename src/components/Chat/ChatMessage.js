import React, { useState, useMemo } from 'react';
import {
    Box,
    Paper,
    Typography,
    Avatar,
    Fade,
    IconButton,
    Collapse,
    Tooltip
} from '@mui/material';
import {
    SmartToy as BotIcon,
    Code as CodeIcon,
    OpenInFull as OpenInFullIcon,
    ContentCopy as ContentCopyIcon,
    Check as CheckIcon
} from '@mui/icons-material';
import Editor from '@monaco-editor/react';
import DataVisualization from './DataVisualization';
import MultiStepProgress from './MultiStepProgress';
import StepResultHeader from './StepResultHeader';
import CodeEditorPopup from './CodeEditorPopup';

const MONO_FONT = "'JetBrains Mono', monospace";

// ── Lightweight markdown rendering for AI chat responses ──
// Handles fenced code blocks (```lang ... ```), #/##/### headers (rendered as
// bold), **bold**, and inline `code`. Anything else is rendered as plain text
// with line breaks preserved.

// Parse inline markup within a single line: **bold** and `inline code`.
const parseInline = (text, keyPrefix) => {
    if (!text) return [text];
    const nodes = [];
    const regex = /\*\*(.+?)\*\*|`([^`]+?)`/g;
    let lastIndex = 0;
    let match;
    let i = 0;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(text.slice(lastIndex, match.index));
        }
        if (match[1] !== undefined) {
            nodes.push(
                <strong key={`${keyPrefix}-b-${i}`} style={{ fontWeight: 700 }}>
                    {match[1]}
                </strong>
            );
        } else if (match[2] !== undefined) {
            nodes.push(
                <Box
                    component="code"
                    key={`${keyPrefix}-c-${i}`}
                    sx={{
                        fontFamily: MONO_FONT,
                        fontSize: '0.92em',
                        bgcolor: 'rgba(0,0,0,0.06)',
                        px: 0.5,
                        py: '1px',
                        borderRadius: 0.5,
                        wordBreak: 'break-word',
                    }}
                >
                    {match[2]}
                </Box>
            );
        }
        lastIndex = regex.lastIndex;
        i++;
    }
    if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
    }
    return nodes.length > 0 ? nodes : [text];
};

// Styled, copy-able code block for fenced sections.
const CodeBlock = ({ code, language }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (e) {
            // Clipboard unavailable — silently ignore
        }
    };

    return (
        <Box
            sx={{
                my: 1,
                borderRadius: 1,
                overflow: 'hidden',
                border: '1px solid #e2e6eb',
                bgcolor: '#f7f9fc',
            }}
        >
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    px: 1,
                    py: 0.25,
                    bgcolor: '#eef1f6',
                    borderBottom: '1px solid #e2e6eb',
                }}
            >
                <Typography
                    component="span"
                    sx={{
                        fontFamily: MONO_FONT,
                        fontSize: 9.5,
                        color: '#5a6678',
                        textTransform: 'uppercase',
                        letterSpacing: 0.6,
                    }}
                >
                    {language || 'code'}
                </Typography>
                <Tooltip title={copied ? 'Copied' : 'Copy'}>
                    <IconButton
                        size="small"
                        onClick={handleCopy}
                        sx={{ p: 0.25, color: '#5a6678', '&:hover': { color: '#111827' } }}
                    >
                        {copied
                            ? <CheckIcon sx={{ fontSize: 13, color: '#2e7d32' }} />
                            : <ContentCopyIcon sx={{ fontSize: 13 }} />}
                    </IconButton>
                </Tooltip>
            </Box>
            <Box
                component="pre"
                sx={{
                    m: 0,
                    p: 1.25,
                    overflowX: 'auto',
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    color: '#111827',
                    whiteSpace: 'pre',
                }}
            >
                <code>{code}</code>
            </Box>
        </Box>
    );
};

// Render a run of non-code text: headers (# ## ###) become bold lines,
// everything else keeps its line breaks and inline markup.
const renderTextBlock = (text, keyPrefix) => {
    const lines = text.split('\n');
    const out = [];

    lines.forEach((line, idx) => {
        const headerMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            out.push(
                <Box
                    component="div"
                    key={`${keyPrefix}-h-${idx}`}
                    sx={{
                        fontWeight: 700,
                        fontSize: level <= 2 ? '1.08em' : '1em',
                        mt: idx === 0 ? 0 : 1,
                        mb: 0.25,
                    }}
                >
                    {parseInline(headerMatch[2], `${keyPrefix}-h-${idx}`)}
                </Box>
            );
            return;
        }
        out.push(
            <React.Fragment key={`${keyPrefix}-l-${idx}`}>
                {parseInline(line, `${keyPrefix}-l-${idx}`)}
                {idx < lines.length - 1 && <br />}
            </React.Fragment>
        );
    });

    return <React.Fragment key={keyPrefix}>{out}</React.Fragment>;
};

// Top-level renderer: splits the message into fenced code blocks and text runs.
const renderMarkdown = (text) => {
    if (!text) return text;

    const blocks = [];
    const fenceRegex = /```(\w*)[ \t]*\r?\n?([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    let key = 0;

    while ((match = fenceRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const chunk = text.slice(lastIndex, match.index);
            if (chunk.trim() !== '') blocks.push(renderTextBlock(chunk, `t-${key}`));
        }
        const lang = (match[1] || '').trim();
        const code = match[2].replace(/\s+$/, '');
        blocks.push(<CodeBlock key={`code-${key}`} code={code} language={lang} />);
        lastIndex = fenceRegex.lastIndex;
        key++;
    }

    if (lastIndex < text.length) {
        const chunk = text.slice(lastIndex);
        if (chunk.trim() !== '') blocks.push(renderTextBlock(chunk, `t-${key}`));
    }

    return blocks.length > 0 ? blocks : text;
};

// Helper function to get segmentation image link
const getImageLink = (age, income) => {
    let incomeValue = 1;
    if (age !== 'under_18') {
        const incomeMapping = {
            'low_income': 1,
            'lower_middle_income': 2,
            'middle_income': 3,
            'upper_middle_income': 4,
            'high_income': 5,
            'very_high_income': 6
        };
        incomeValue = incomeMapping[income] || 1;
    }
    return `/segmentation/${age}_${incomeValue}.jpeg`;
};

// Inline read-only code preview
const CodeEditor = ({ code, language = 'sql', height = 300 }) => {
    return (
        <Box
            sx={{
                border: '1px solid #e2e6eb',
                borderRadius: 1,
                overflow: 'hidden',
                bgcolor: '#fff',
            }}
        >
            <Editor
                height={height}
                defaultLanguage={language}
                value={code}
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
                            'editorGutter.background': '#ffffff',
                            'scrollbarSlider.background': '#e2e6eb88',
                            'scrollbarSlider.hoverBackground': '#cdd2dbcc',
                            'scrollbarSlider.activeBackground': '#5a667888',
                        },
                    });
                }}
                theme="ternlux-light"
                options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: 'off',
                    renderLineHighlight: 'none',
                    scrollbar: {
                        vertical: 'auto',
                        horizontal: 'auto',
                        verticalScrollbarSize: 10,
                        horizontalScrollbarSize: 10
                    },
                    padding: { top: 10, bottom: 10 }
                }}
            />
        </Box>
    );
};

// Per-section: collapsible inline preview + "Open in full editor" affordance.
const CodeSection = ({
    field,
    label,
    code,
    language = 'sql',
    color = 'primary',
    bgTint,
    message,
    onCodeSave,
}) => {
    const [open, setOpen] = useState(false);
    const [popupOpen, setPopupOpen] = useState(false);

    const lineCount = (code || '').split('\n').length;
    const height = Math.min(language === 'javascript' || language === 'python' ? 400 : 300, (lineCount + 1) * 19 + 20);

    const tint = bgTint ?? 'rgba(25, 118, 210, 0.08)';
    const tintHover = tint.replace('0.08', '0.12');

    const handleSave = (newCode) => {
        if (!onCodeSave) return;
        onCodeSave(field, newCode, message);
    };

    return (
        <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <IconButton
                    size="small"
                    onClick={() => setOpen(prev => !prev)}
                    sx={{
                        color,
                        bgcolor: tint,
                        '&:hover': { bgcolor: tintHover }
                    }}
                >
                    <CodeIcon fontSize="small" />
                </IconButton>
                <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', flex: 1 }}>
                    {open ? `Hide ${label}` : `View ${label}`}
                </Typography>
                <Tooltip title="Open in full editor">
                    <IconButton
                        size="small"
                        onClick={() => setPopupOpen(true)}
                        sx={{
                            color: 'text.secondary',
                            '&:hover': { color: 'text.primary', bgcolor: 'rgba(0,0,0,0.04)' }
                        }}
                    >
                        <OpenInFullIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                </Tooltip>
            </Box>
            <Collapse in={open}>
                <CodeEditor
                    code={code}
                    language={language}
                    height={height}
                />
            </Collapse>
            <CodeEditorPopup
                open={popupOpen}
                onClose={() => setPopupOpen(false)}
                title={label}
                code={code}
                language={language}
                onSave={handleSave}
            />
        </Box>
    );
};

const ChatMessage = ({
    message,
    index,
    messages,
    isFullscreen,
    multiStepData,
    formatTimestamp,
    onSaveToMain,
    // ── code-popup wiring ──
    onCodeSave,
}) => {
    const isUser = message.sender === 'user';
    const showAvatar = !isUser && (index === 0 || messages[index - 1]?.sender !== 'bot');
    const TEXT_COLLAPSE_CHAR_THRESHOLD = 240;
    const TEXT_COLLAPSE_LINE_THRESHOLD = 5;
    const messageText = message.text || '';
    const isLongMessage = !isUser && (
        messageText.length > TEXT_COLLAPSE_CHAR_THRESHOLD ||
        messageText.split('\n').length > TEXT_COLLAPSE_LINE_THRESHOLD
    );
    const [isTextExpanded, setIsTextExpanded] = useState(!isLongMessage);
    const collapsedText = useMemo(() => {
        if (!isLongMessage || isTextExpanded) return messageText;
        const lines = messageText.split('\n');
        const truncatedByLines = lines.slice(0, TEXT_COLLAPSE_LINE_THRESHOLD).join('\n');
        const truncated = truncatedByLines.length > TEXT_COLLAPSE_CHAR_THRESHOLD
            ? truncatedByLines.slice(0, TEXT_COLLAPSE_CHAR_THRESHOLD).trimEnd() + '…'
            : truncatedByLines + (lines.length > TEXT_COLLAPSE_LINE_THRESHOLD ? '…' : '');
        return truncated;
    }, [messageText, isLongMessage, isTextExpanded]);

    const nosqlOperationDisplay = useMemo(() => {
        if (!message?.metadata?.nosqlOperation) return null;
        const raw = message.metadata.nosqlOperation;
        if (typeof raw === 'string') {
            try {
                return JSON.stringify(JSON.parse(raw), null, 2);
            } catch (e) {
                return raw;
            }
        }
        return JSON.stringify(raw, null, 2);
    }, [message?.metadata?.nosqlOperation]);

    const MONO = "'JetBrains Mono', monospace";
    const SANS = "'Inter',-apple-system,sans-serif";
    const ACCENT = '#2563eb';
    const BORDER = '#e2e6eb';
    const TEXT = '#111827';
    const MUTED = '#5a6678';

    // Shared props passed to every CodeSection
    const sectionProps = {
        message,
        onCodeSave,
    };

    return (
        <Fade in={true} key={message.id} timeout={200}>
            <Box
                sx={{
                    display: 'flex',
                    mb: 1.75,
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    px: isFullscreen ? 3 : 2,
                    fontFamily: SANS,
                }}
            >
                {/* Bot avatar */}
                {!isUser && showAvatar && (
                    <Avatar
                        sx={{
                            width: 26,
                            height: 26,
                            mr: 1.25,
                            bgcolor: '#eef1f6',
                            border: `1px solid ${BORDER}`,
                            alignSelf: 'flex-end',
                            borderRadius: 1,
                        }}
                        variant="rounded"
                    >
                        <BotIcon sx={{ fontSize: 14, color: MUTED }} />
                    </Avatar>
                )}

                {/* Spacer for non-avatar messages */}
                {!isUser && !showAvatar && <Box sx={{ width: 38 }} />}

                {/* Message content */}
                <Box
                    sx={{
                        maxWidth: isFullscreen ? '65%' : '82%',
                        minWidth: 80,
                        position: 'relative'
                    }}
                >
                    {/* Message bubble */}
                    <Paper
                        elevation={0}
                        sx={{
                            px: 1.75,
                            py: 1.25,
                            bgcolor: isUser ? ACCENT : '#fff',
                            color: isUser ? '#fff' : TEXT,
                            border: isUser ? 'none' : `1px solid ${BORDER}`,
                            borderRadius: 1.5,
                            borderTopLeftRadius: !isUser && showAvatar ? 0.25 : 1.5,
                            borderTopRightRadius: isUser ? 0.25 : 1.5,
                            boxShadow: isUser ? 'none' : '0 1px 3px rgba(0,0,0,0.05)',
                            position: 'relative',
                            wordBreak: 'break-word'
                        }}
                    >
                        {/* Multi-step step result header */}
                        {message.metadata?.type === 'step_result' && (
                            <StepResultHeader metadata={message.metadata} />
                        )}

                        {/* Multi-step Progress Display */}
                        {(message.metadata?.type === 'multi_step_plan' && message.metadata?.plan) ? (
                            <Box sx={{ mt: 2 }}>
                                <MultiStepProgress
                                    data={{
                                        goal: message.metadata.plan.goal,
                                        steps: message.metadata.plan.steps,
                                        stepResults: multiStepData?.stepResults,
                                        status: multiStepData?.status
                                    }}
                                />
                            </Box>
                        ) : (
                            <Box sx={{ display: 'flex', gap: 2 }}>
                                {/* Segmentation Image */}
                                {message.metadata?.segmentation && message.metadata.segmentation.age && message.metadata.segmentation.income && (
                                    <Box sx={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 1,
                                        minWidth: 100,
                                        maxWidth: 100
                                    }}>
                                        <Box
                                            component="img"
                                            src={getImageLink(message.metadata.segmentation.age, message.metadata.segmentation.income)}
                                            alt={`${message.metadata.segmentation.age} ${message.metadata.segmentation.income}`}
                                            sx={{
                                                width: '100%',
                                                height: 'auto',
                                                borderRadius: 1,
                                                border: '1px solid #e0e0e0'
                                            }}
                                            onError={(e) => {
                                                e.target.style.display = 'none';
                                            }}
                                        />
                                    </Box>
                                )}

                                {/* Message text */}
                                <Box sx={{ flex: 1 }}>
                                    <Typography
                                        component="div"
                                        variant="body1"
                                        sx={{
                                            fontSize: 12,
                                            lineHeight: 1.65,
                                            wordWrap: 'break-word',
                                            color: isUser ? '#fff' : 'inherit',
                                            ...(isUser ? { whiteSpace: 'pre-wrap' } : {}),
                                        }}
                                    >
                                        {isUser ? message.text : renderMarkdown(message.text)}
                                    </Typography>
                                    {/* {isLongMessage && (
                                        <Box
                                            component="button"
                                            type="button"
                                            onClick={() => setIsTextExpanded(prev => !prev)}
                                            sx={{
                                                mt: 0.5,
                                                px: 0,
                                                py: 0,
                                                background: 'none',
                                                border: 'none',
                                                cursor: 'pointer',
                                                color: ACCENT,
                                                fontFamily: SANS,
                                                fontSize: 11,
                                                fontWeight: 600,
                                                textAlign: 'left',
                                                '&:hover': { textDecoration: 'underline' },
                                            }}
                                        >
                                            {isTextExpanded ? 'Show less' : 'Show more'}
                                        </Box>
                                    )} */}
                                </Box>
                            </Box>
                        )}

                        {/* Invalid AI response — expandable raw text the model
                            returned when it wasn't valid JSON. Lets the user
                            inspect exactly what came back without cluttering the
                            message with a wall of broken JSON. */}
                        {!isUser && message.metadata?.invalidJson && (
                            <CodeSection
                                {...sectionProps}
                                field="invalidJson"
                                label="raw response"
                                code={message.metadata.invalidJson}
                                language="json"
                                color="error.main"
                                bgTint="rgba(211, 47, 47, 0.08)"
                            />
                        )}

                        {/* Code sections (collapsible inline + popup-expandable) */}
                        {!isUser && message.metadata?.ddl && (
                            <CodeSection
                                {...sectionProps}
                                field="ddl"
                                label="DDL (CREATE TABLE)"
                                code={message.metadata.ddl}
                                language="sql"
                                color="success.main"
                                bgTint="rgba(46, 125, 50, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.sql && (
                            <CodeSection
                                {...sectionProps}
                                field="sql"
                                label="SQL (INSERT)"
                                code={message.metadata.sql}
                                language="sql"
                                color="primary.main"
                                bgTint="rgba(25, 118, 210, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.operationType && message.metadata?.nosqlOperation && (
                            <CodeSection
                                {...sectionProps}
                                field="nosqlOperation"
                                label={`Operation ${message.metadata.operationType === 'javascript' ? 'Filter' : message.metadata.operationType}`}
                                code={nosqlOperationDisplay || ''}
                                language="json"
                                color="success.main"
                                bgTint="rgba(46, 125, 50, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.transformFunction && (
                            <Box sx={{ mt: 2 }}>
                                {/* Search/Filter Info for Vector Transformations */}
                                {(message.metadata?.useEmbeddingSearch !== undefined || message.metadata?.filter !== undefined) && (
                                    <Box sx={{ mb: 2, p: 1.5, bgcolor: 'rgba(25, 118, 210, 0.08)', borderRadius: 1 }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.5 }}>
                                            Filter Method:
                                        </Typography>
                                        {message.metadata.useEmbeddingSearch ? (
                                            <Box>
                                                {message.metadata.searchQuery && (
                                                    <Typography variant="body2" sx={{ mt: 0.5, color: 'text.secondary', fontStyle: 'italic' }}>
                                                        Query: "{message.metadata.searchQuery}"
                                                    </Typography>
                                                )}
                                            </Box>
                                        ) : (
                                            <Box>
                                                {message.metadata.filter && (
                                                    <Typography variant="body2" sx={{ mt: 0.5, fontFamily: 'monospace', color: 'text.secondary' }}>
                                                        {typeof message.metadata.filter === 'string'
                                                            ? message.metadata.filter
                                                            : JSON.stringify(message.metadata.filter)}
                                                    </Typography>
                                                )}
                                            </Box>
                                        )}
                                    </Box>
                                )}

                                {/* Initial State Display */}
                                {message.metadata?.initialState && Object.keys(message.metadata.initialState).length > 0 && (
                                    <Box sx={{ mb: 2, p: 1.5, bgcolor: 'rgba(156, 39, 176, 0.08)', borderRadius: 1 }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.5 }}>
                                            Initial State:
                                        </Typography>
                                        <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                                            {JSON.stringify(message.metadata.initialState, null, 2)}
                                        </Typography>
                                    </Box>
                                )}

                                <CodeSection
                                    {...sectionProps}
                                    field="transformFunction"
                                    label="Transform Function"
                                    code={message.metadata.transformFunction}
                                    language="javascript"
                                    color="warning.main"
                                    bgTint="rgba(237, 108, 2, 0.08)"
                                />
                            </Box>
                        )}

                        {!isUser && message.metadata?.sourcesConfig && (
                            <CodeSection
                                {...sectionProps}
                                field="sourcesConfig"
                                label="Sources Configuration"
                                code={JSON.stringify(message.metadata.sourcesConfig, null, 2)}
                                language="json"
                                color="info.main"
                                bgTint="rgba(2, 136, 209, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.targetDdl && (
                            <CodeSection
                                {...sectionProps}
                                field="targetDdl"
                                label="Target DDL"
                                code={message.metadata.targetDdl}
                                language="sql"
                                color="success.main"
                                bgTint="rgba(46, 125, 50, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.joinSql && (
                            <CodeSection
                                {...sectionProps}
                                field="joinSql"
                                label="Join SQL"
                                code={message.metadata.joinSql}
                                language="sql"
                                color="primary.main"
                                bgTint="rgba(25, 118, 210, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.joinColumns && (
                            <CodeSection
                                {...sectionProps}
                                field="joinColumns"
                                label="Join Columns"
                                code={JSON.stringify(message.metadata.joinColumns, null, 2)}
                                language="json"
                                color="secondary.main"
                                bgTint="rgba(156, 39, 176, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.selectedColumns && (
                            <CodeSection
                                {...sectionProps}
                                field="selectedColumns"
                                label="Selected Columns"
                                code={JSON.stringify(message.metadata.selectedColumns, null, 2)}
                                language="json"
                                color="warning.main"
                                bgTint="rgba(237, 108, 2, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.javascriptFunction && (
                            <CodeSection
                                {...sectionProps}
                                field="javascriptFunction"
                                label="JavaScript Function"
                                code={message.metadata.javascriptFunction}
                                language="javascript"
                                color="error.main"
                                bgTint="rgba(211, 47, 47, 0.08)"
                            />
                        )}

                        {!isUser && message.metadata?.pythonCode && (
                            <CodeSection
                                {...sectionProps}
                                field="pythonCode"
                                label="Python Code"
                                code={message.metadata.pythonCode}
                                language="python"
                                color="#ff9800"
                                bgTint="rgba(255, 152, 0, 0.08)"
                            />
                        )}

                        {/* Visualization */}
                        {message.visualizationData && (
                            <Box sx={{ mt: 2, borderRadius: 2, overflow: 'hidden' }}>
                                <DataVisualization
                                    visualizationData={message.visualizationData}
                                    onSaveToMain={onSaveToMain}
                                />
                            </Box>
                        )}

                    </Paper>
                    {/* Timestamp — outside the bubble to match redesign */}
                    <Typography
                        sx={{
                            display: 'block',
                            mt: 0.5,
                            fontSize: 9,
                            color: '#9ca3af',
                            fontFamily: MONO,
                            textAlign: isUser ? 'right' : 'left',
                        }}
                    >
                        {formatTimestamp(message.timestamp)}
                    </Typography>
                </Box>

                {/* User avatar space (invisible) */}
                {isUser && <Box sx={{ width: 38 }} />}
            </Box>

        </Fade>
    );
};

export default ChatMessage;
