import React, { useState } from 'react';
import {
    Box,
    Typography,
    IconButton,
    Button,
    TextField,
    InputAdornment,
    Chip,
    alpha,
    useTheme,
    Collapse
} from '@mui/material';
import {
    Chat as ChatIcon,
    Send as SendIcon,
    Close as CloseIcon,
    Fullscreen as FullscreenIcon,
    FullscreenExit as FullscreenExitIcon,
    History as HistoryIcon,
    TrendingUp as TrendingUpIcon,
    SmartToy as BotIcon,
    Assignment as ReportIcon,
    PlayArrow as PlayArrowIcon,
    ExpandMore as ExpandMoreIcon
} from '@mui/icons-material';
import { Select } from 'antd';
import ChatMessage from './ChatMessage';
import TypingIndicator from './TypingIndicator';
import MultiStepReport from './MultiStepReport';

const { Option } = Select;

// Collapsible group of choices — header acts as a dropdown toggle so users can
// expand/collapse each category (Databases, APIs, Vector, …) on demand.
const ChoiceGroup = ({ name, items, defaultExpanded = false }) => {
    const MONO = "'JetBrains Mono', monospace";
    const BORDER = '#e2e6eb';
    const MUTED = '#5a6678';
    const color = items[0]?.groupColor || MUTED;
    const [expanded, setExpanded] = React.useState(defaultExpanded);

    return (
        <Box sx={{ mt: 1 }}>
            <Box
                onClick={() => setExpanded(prev => !prev)}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    mb: 0.75,
                    pl: 0.25,
                    cursor: 'pointer',
                    userSelect: 'none',
                    '&:hover .choice-group-label': { color: color },
                }}
            >
                <Box sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    bgcolor: color,
                }} />
                <Typography
                    className="choice-group-label"
                    sx={{
                        fontSize: 9,
                        fontFamily: MONO,
                        fontWeight: 700,
                        letterSpacing: '0.1em',
                        color,
                        textTransform: 'uppercase',
                        transition: 'color 0.15s',
                    }}
                >
                    {name}
                </Typography>
                <Box sx={{ flex: 1, height: 1, bgcolor: BORDER }} />
                <Typography sx={{
                    fontSize: 9,
                    fontFamily: MONO,
                    color: '#9ca3af',
                }}>
                    {items.length}
                </Typography>
                <ExpandMoreIcon
                    sx={{
                        fontSize: 14,
                        color: MUTED,
                        transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                    }}
                />
            </Box>
            <Collapse in={expanded} timeout={180} unmountOnExit>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                    {items}
                </Box>
            </Collapse>
        </Box>
    );
};

// Redesign-style choice card used for bot choice prompts
const ChoiceCard = ({ choice, onSelect }) => {
    const MONO = "'JetBrains Mono', monospace";
    const SANS = "'Inter',-apple-system,sans-serif";
    const BORDER = '#e2e6eb';
    const ACCENT = '#2563eb';
    const TEXT = '#111827';
    const MUTED = '#5a6678';
    const [hov, setHov] = React.useState(false);

    const stripeColor = choice.groupColor || (choice._isNewConnection ? ACCENT : null);
    const isContained = choice.variant === 'contained';

    if (isContained) {
        return (
            <Button
                variant="contained"
                size="small"
                onClick={() => onSelect(choice)}
                sx={{
                    borderRadius: 1,
                    textTransform: 'none',
                    fontWeight: 600,
                    ...(choice.fullWidth ? { width: '100%' } : {}),
                    fontFamily: SANS,
                    fontSize: 12,
                    py: 0.75,
                    bgcolor: ACCENT,
                    '&:hover': { bgcolor: '#1d4ed8' },
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 0.75,
                }}
            >
                {choice.icon}
                {choice.label}
            </Button>
        );
    }

    return (
        <Box
            onClick={() => onSelect(choice)}
            onMouseEnter={() => setHov(true)}
            onMouseLeave={() => setHov(false)}
            sx={{
                display: 'flex',
                alignItems: 'stretch',
                border: `1px solid ${hov ? (stripeColor ? stripeColor + '66' : '#cdd2db') : BORDER}`,
                borderRadius: 1,
                background: hov ? (stripeColor ? stripeColor + '08' : '#f7f9fc') : '#fff',
                cursor: 'pointer',
                transition: 'all 0.15s',
                userSelect: 'none',
                fontFamily: SANS,
                overflow: 'hidden',
                width: choice.fullWidth ? '100%' : 'auto',
                boxShadow: hov ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
            }}
        >
            {stripeColor && (
                <Box sx={{ width: 3, bgcolor: stripeColor, flexShrink: 0 }} />
            )}
            <Box sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                py: choice.description ? 0.875 : 0.625,
                flex: 1,
                minWidth: 0,
            }}>
                {choice.icon && (
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        flexShrink: 0,
                        color: stripeColor || MUTED,
                        '& svg': {
                            fill: stripeColor || '#5a6678',
                            color: stripeColor || '#5a6678',
                            width: 18,
                            height: 18,
                        }
                    }}>
                        {choice.icon}
                    </Box>
                )}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: TEXT,
                        lineHeight: 1.35,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {choice.label}
                    </Typography>
                    {choice.description && (
                        <Typography sx={{
                            fontSize: 10,
                            color: MUTED,
                            fontFamily: MONO,
                            mt: 0.25,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}>
                            {choice.description}
                        </Typography>
                    )}
                </Box>
            </Box>
        </Box>
    );
};

const ChatArea = ({
    isFullscreen,
    currentChatTitle,
    multiStepData,
    handleFullscreen,
    handleToggleChat,
    chatContainerRef,
    messages = [],
    isLoading,
    progressInfo,
    messagesEndRef,
    inputRef,
    inputValue,
    setInputValue,
    handleKeyPress,
    handleSendMessage,
    formatTimestamp,
    onSaveToMain,
    // ── node-chat extensions ──
    choices = [],          // array of { label, value, description?, variant?, fullWidth? }
    secondaryChoices = [],
    onChoiceSelect = () => {},
    hideHeader = false,
    inputPlaceholder = 'Message...',
    disableInput = false,
    hideInput = false,     // when true, omit the text input area entirely (choice-only flows)
    // ── workflow execution ──
    showRunButton = false,
    onRun = null,
    runButtonLoading = false,
    // ── code-popup wiring ──
    onCodeSave,
}) => {
    const theme = useTheme();
    const [isReportOpen, setIsReportOpen] = useState(false);

    // Check if there's completed multi-step data to show report button
    const hasCompletedMultiStep = multiStepData?.completedSteps && multiStepData?.completedSteps === multiStepData?.totalSteps;
    // console.log('hasCompletedMultiStep: ', hasCompletedMultiStep, multiStepData)

    // Handle opening report with URL update
    const handleOpenReport = () => {
        setIsReportOpen(true);

        // Add reportId to URL if available
        if (multiStepData?.reportId) {
            const url = new URL(window.location);
            url.searchParams.set('reportid', multiStepData.reportId);
            window.history.replaceState({}, '', url);
        }
    };

    // Handle closing report with URL cleanup
    const handleCloseReport = () => {
        setIsReportOpen(false);

        // Remove reportId from URL
        const url = new URL(window.location);
        url.searchParams.delete('reportid');
        window.history.replaceState({}, '', url);
    };

    const MONO = "'JetBrains Mono', monospace";
    const SANS = "'Inter',-apple-system,sans-serif";
    const BORDER = '#e2e6eb';
    const MUTED = '#5a6678';
    const SURFACE = '#f7f9fc';
    const ACCENT = '#2563eb';
    const GREEN = '#059669';

    return (
        <Box sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
            fontFamily: SANS,
        }}>
            {/* Chat header */}
            {!hideHeader && <Box
                sx={{
                    px: 2,
                    py: 1.25,
                    borderBottom: `1px solid ${BORDER}`,
                    bgcolor: '#fff',
                    color: 'rgba(0, 0, 0, 0.87)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    flexShrink: 0,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
                    {!isFullscreen && (
                        <ChatIcon sx={{ color: MUTED, fontSize: 16 }} />
                    )}
                    <Typography
                        sx={{
                            fontWeight: 600,
                            color: '#111827',
                            fontSize: isFullscreen ? 14 : 13,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            letterSpacing: '-0.01em',
                            flex: isFullscreen ? '0 1 auto' : '0 0 auto',
                            maxWidth: isFullscreen ? 'none' : 180,
                        }}
                    >
                        {currentChatTitle}
                    </Typography>
                    {showRunButton && onRun && (
                        <Button
                            size="small"
                            startIcon={<PlayArrowIcon sx={{ fontSize: '14px !important' }} />}
                            onClick={onRun}
                            disabled={runButtonLoading}
                            sx={{
                                ml: 1,
                                color: 'white',
                                bgcolor: GREEN,
                                '&:hover': { bgcolor: '#047857' },
                                '&:disabled': {
                                    bgcolor: '#e5e7eb',
                                    color: 'rgba(0, 0, 0, 0.25)'
                                },
                                transition: 'all 0.15s',
                                fontWeight: 600,
                                borderRadius: 1,
                                fontSize: 11,
                                px: 1.25,
                                py: 0.4,
                                textTransform: 'none',
                                minHeight: 0,
                            }}
                        >
                            {runButtonLoading ? 'Running…' : 'Run Step'}
                        </Button>
                    )}
                    {hasCompletedMultiStep && (
                        <Button
                            size="small"
                            startIcon={<ReportIcon sx={{ fontSize: '14px !important' }} />}
                            onClick={handleOpenReport}
                            sx={{
                                ml: 1,
                                color: 'white',
                                bgcolor: ACCENT,
                                '&:hover': { bgcolor: '#1d4ed8' },
                                transition: 'all 0.15s',
                                fontWeight: 600,
                                borderRadius: 1,
                                fontSize: 11,
                                px: 1.25,
                                py: 0.4,
                                textTransform: 'none',
                                minHeight: 0,
                            }}
                        >
                            Report
                        </Button>
                    )}
                    {multiStepData && !hasCompletedMultiStep && (
                        <Chip
                            label={`${multiStepData.completedSteps || 0}/${multiStepData.totalSteps || 0} steps`}
                            size="small"
                            sx={{
                                ml: 1,
                                height: 20,
                                fontSize: 10,
                                fontFamily: MONO,
                                bgcolor: '#eff4ff',
                                color: ACCENT,
                                border: '1px solid #bfdbfe',
                                '& .MuiChip-icon': { fontSize: 12, color: ACCENT },
                            }}
                            icon={<TrendingUpIcon />}
                        />
                    )}
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {!isFullscreen && (
                        <Button
                            size="small"
                            startIcon={<HistoryIcon sx={{ fontSize: '14px !important' }} />}
                            onClick={handleFullscreen}
                            sx={{
                                color: MUTED,
                                bgcolor: SURFACE,
                                border: `1px solid ${BORDER}`,
                                '&:hover': { bgcolor: '#eef1f6', color: '#111827' },
                                transition: 'all 0.15s',
                                fontWeight: 500,
                                borderRadius: 1,
                                fontSize: 11,
                                px: 1.25,
                                py: 0.4,
                                textTransform: 'none',
                                minHeight: 0,
                            }}
                        >
                            History
                        </Button>
                    )}

                    <IconButton
                        size="small"
                        onClick={handleFullscreen}
                        sx={{ color: MUTED, p: 0.5 }}
                    >
                        {isFullscreen ? <FullscreenExitIcon sx={{ fontSize: 16 }} /> : <FullscreenIcon sx={{ fontSize: 16 }} />}
                    </IconButton>
                    <IconButton
                        size="small"
                        onClick={handleToggleChat}
                        sx={{ color: MUTED, p: 0.5 }}
                    >
                        <CloseIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                </Box>
            </Box>}

            {/* Messages area */}
            <Box
                ref={chatContainerRef}
                sx={{
                    flex: 1,
                    overflow: 'auto',
                    bgcolor: SURFACE,
                    py: 2,
                }}
            >
                {messages.length === 0 ? (
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%',
                        flexDirection: 'column',
                        gap: 1.5,
                        color: MUTED,
                    }}>
                        <Box sx={{
                            width: 48, height: 48, borderRadius: 3,
                            bgcolor: '#eef1f6',
                            border: `1px solid ${BORDER}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                            <BotIcon sx={{ fontSize: 24, color: '#9ca3af' }} />
                        </Box>
                        <Typography sx={{ fontSize: 14, fontWeight: 500, color: MUTED }}>
                            How can I help you today?
                        </Typography>
                        <Typography sx={{ fontSize: 12, color: '#9ca3af', fontFamily: MONO }}>
                            Ask me anything about your pipeline data
                        </Typography>
                    </Box>
                ) : (
                    <>
                        {messages.map((message, index) => (
                            <ChatMessage
                                key={message.id}
                                message={message}
                                index={index}
                                messages={messages}
                                isFullscreen={isFullscreen}
                                multiStepData={multiStepData}
                                formatTimestamp={formatTimestamp}
                                onSaveToMain={onSaveToMain}
                                onCodeSave={onCodeSave}
                            />
                        ))}
                        {isLoading && (
                            <TypingIndicator
                                isLoading={isLoading}
                                progressInfo={progressInfo}
                                isFullscreen={isFullscreen}
                            />
                        )}

                        {/* Bot-side choice buttons or dropdown */}
                        {!isLoading && choices.length > 0 && (
                            <Box
                                sx={{
                                    display: 'flex',
                                    justifyContent: 'flex-start',
                                    px: isFullscreen ? 3 : 2,
                                    mb: 2,
                                    pl: isFullscreen ? 9 : 6,  // align with bot message text
                                }}
                            >
                                {choices[0]?.displayType === 'dropdown' ? (
                                    // Render dropdown (single or multi-select)
                                    <Box sx={{ maxWidth: isFullscreen ? '70%' : '85%', width: '100%' }}>
                                        <Select
                                            mode={choices[0]?.multiSelect ? 'multiple' : undefined}
                                            showSearch={!choices[0]?.multiSelect}
                                            placeholder={choices[0]?.multiSelect ? 'Select one or more options...' : 'Search and select a table...'}
                                            style={{ width: '100%' }}
                                            size="large"
                                            filterOption={(input, option) =>
                                                option.children.toLowerCase().indexOf(input.toLowerCase()) >= 0
                                            }
                                            onChange={(value) => {
                                                if (choices[0]?.multiSelect) {
                                                    // For multiselect, value is an array
                                                    onChoiceSelect({ value, multiSelect: true });
                                                } else {
                                                    // For single select, find the choice
                                                    const selectedChoice = choices.find(c => c.value === value);
                                                    if (selectedChoice) {
                                                        onChoiceSelect(selectedChoice);
                                                    }
                                                }
                                            }}
                                        >
                                            {choices.map((choice) => (
                                                <Option key={String(choice.value)} value={choice.value}>
                                                    {choice.label}
                                                </Option>
                                            ))}
                                        </Select>
                                    </Box>
                                ) : (
                                    // Render redesign-style choice cards (grouped if `group` field present)
                                    (() => {
                                        const hasGroups = choices.some(c => c.group);
                                        const containerWidth = {
                                            maxWidth: isFullscreen ? '70%' : '85%',
                                            width: '100%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: 1,
                                        };

                                        if (!hasGroups) {
                                            return (
                                                <Box sx={containerWidth}>
                                                    {choices.map((choice) => (
                                                        <ChoiceCard
                                                            key={String(choice.value ?? choice.label)}
                                                            choice={choice}
                                                            onSelect={onChoiceSelect}
                                                        />
                                                    ))}
                                                </Box>
                                            );
                                        }

                                        // Grouped layout: group header + stacked cards per group
                                        const ungrouped = choices.filter(c => !c.group);
                                        const grouped = choices.filter(c => c.group);
                                        const groupOrder = [];
                                        const groupMap = new Map();
                                        grouped.forEach(c => {
                                            if (!groupMap.has(c.group)) {
                                                groupOrder.push(c.group);
                                                groupMap.set(c.group, []);
                                            }
                                            groupMap.get(c.group).push(c);
                                        });

                                        return (
                                            <Box sx={containerWidth}>
                                                {ungrouped.map((choice) => (
                                                    <ChoiceCard
                                                        key={String(choice.value ?? choice.label)}
                                                        choice={choice}
                                                        onSelect={onChoiceSelect}
                                                    />
                                                ))}
                                                {groupOrder.map((g, idx) => {
                                                    const items = groupMap.get(g);
                                                    const cards = items.map((choice) => (
                                                        <ChoiceCard
                                                            key={String(choice.value ?? choice.label)}
                                                            choice={choice}
                                                            onSelect={onChoiceSelect}
                                                        />
                                                    ));
                                                    return (
                                                        <ChoiceGroup
                                                            key={g}
                                                            name={g}
                                                            items={cards}
                                                            defaultExpanded={idx === 0}
                                                        />
                                                    );
                                                })}
                                            </Box>
                                        );
                                    })()
                                )}
                            </Box>
                        )}

{!isLoading && choices.length > 0 && secondaryChoices.length > 0 && (
                            <Box
                                sx={{
                                    display: 'flex',
                                    justifyContent: 'flex-start',
                                    px: isFullscreen ? 3 : 2,
                                    mb: 2,
                                    pl: isFullscreen ? 9 : 6,
                                }}
                            >
                                <Box sx={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 0.75,
                                    maxWidth: isFullscreen ? '70%' : '85%',
                                    width: '100%',
                                }}>
                                    {secondaryChoices.map((choice) => (
                                        <ChoiceCard
                                            key={String(choice.value ?? choice.label)}
                                            choice={choice}
                                            onSelect={onChoiceSelect}
                                        />
                                    ))}
                                </Box>
                            </Box>
                        )}

                        <div ref={messagesEndRef} />
                    </>
                )}
            </Box>

            {/* Input area — omitted entirely in choice-only flows (hideInput) */}
            {!hideInput && (
            <Box
                sx={{
                    px: isFullscreen ? 6 : 2,
                    py: isFullscreen ? 2 : 1.5,
                    borderTop: `1px solid ${BORDER}`,
                    bgcolor: '#fff',
                    flexShrink: 0,
                }}
            >
                <Box sx={{
                    maxWidth: isFullscreen ? 720 : '100%',
                    mx: 'auto',
                    display: 'flex',
                    gap: 1,
                    alignItems: 'flex-end'
                }}>
                    <TextField
                        ref={inputRef}
                        fullWidth
                        multiline
                        minRows={2}
                        maxRows={10}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder={choices.length > 0 ? 'Select an option above…' : inputPlaceholder}
                        disabled={isLoading || disableInput}
                        variant="outlined"
                        sx={{
                            '& .MuiOutlinedInput-root': {
                                borderRadius: 1.5,
                                bgcolor: '#fff',
                                fontSize: 12,
                                lineHeight: 1.6,
                                '& fieldset': { borderColor: BORDER },
                                '&:hover fieldset': { borderColor: '#cdd2db' },
                                '&.Mui-focused fieldset': { borderColor: ACCENT, borderWidth: 1 },
                                '& textarea': { resize: 'none' },
                            },
                        }}
                        InputProps={{
                            endAdornment: inputValue.trim() && (
                                <InputAdornment position="end">
                                    <IconButton
                                        onClick={handleSendMessage}
                                        disabled={!inputValue.trim() || isLoading || choices.length > 0 || disableInput}
                                        sx={{
                                            p: 0.8,
                                            bgcolor: inputValue.trim() ? ACCENT : 'transparent',
                                            color: inputValue.trim() ? '#fff' : '#9ca3af',
                                            borderRadius: 1,
                                            '&:hover': {
                                                bgcolor: inputValue.trim() ? '#1d4ed8' : 'transparent'
                                            },
                                            '&.Mui-disabled': {
                                                bgcolor: 'transparent',
                                                color: '#d1d5db'
                                            }
                                        }}
                                    >
                                        <SendIcon sx={{ fontSize: 14 }} />
                                    </IconButton>
                                </InputAdornment>
                            )
                        }}
                    />
                </Box>
            </Box>
            )}

            {/* Multi-step Clean Report Dialog */}
            {hasCompletedMultiStep && (
                <MultiStepReport
                    open={isReportOpen}
                    onClose={handleCloseReport}
                    reportData={multiStepData}
                />
            )}
        </Box>
    );
};

export default ChatArea;