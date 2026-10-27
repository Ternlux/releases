import React, { useState, useRef, useEffect, useCallback } from 'react';
import { buildChatChain, workflowAnalysis, parseWorkflowAnalysisResponse } from '../api/chatApi';
import {
    Box,
    Paper,
    Typography,
    TextField,
    IconButton,
    Fab,
    Zoom,
    CircularProgress,
    LinearProgress,
    Button,
    List,
    ListItem,
    ListItemText,
    ListItemButton,
    Divider,
    Menu,
    MenuItem,
    Avatar,
    Chip,
    Tooltip,
    InputAdornment,
    Fade,
    Slide,
    useTheme,
    alpha
} from '@mui/material';
import {
    Chat as ChatIcon,
    Send as SendIcon,
    Close as CloseIcon,
    AccountCircle as UserIcon,
    SmartToy as BotIcon,
    Minimize as MinimizeIcon,
    Fullscreen as FullscreenIcon,
    FullscreenExit as FullscreenExitIcon,
    Add as AddIcon,
    Delete as DeleteIcon,
    MoreVert as MoreVertIcon,
    CheckCircle as CheckCircleIcon,
    Schedule as ScheduleIcon,
    Error as ErrorIcon,
    Edit as EditIcon,
    Refresh as RefreshIcon,
    TrendingUp as TrendingUpIcon,
    Assessment as AssessmentIcon,
    History as HistoryIcon,
    Analytics as AnalyticsIcon,
    AccountTree as DecisionIcon,
    DataUsage as WorkflowIcon
} from '@mui/icons-material';
import axios from 'axios';
import DataVisualization from './DataVisualization';
import MultiStepReport from './MultiStepReport';
import MultiStepProgress from './MultiStepProgress';
import StepResultHeader from './StepResultHeader';
import ChatSidebar from './ChatSidebar';
import ChatArea from './ChatArea';
import { width } from '@mui/system';

const ChatBot = ({ onSaveToMain }) => {
    const theme = useTheme();
    
    // UI state
    const [isOpen, setIsOpen] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(280);
    
    // Current chat state
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [progressInfo, setProgressInfo] = useState({ progress: 0, stage: '' });
    const [currentChatId, setCurrentChatId] = useState(null);
    const [currentChatTitle, setCurrentChatTitle] = useState('New Chat');
    
    // Chat history state
    const [chatHistory, setChatHistory] = useState([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    
    // Multi-step analysis state
    const [multiStepData, setMultiStepData] = useState(null);
    const [isReportOpen, setIsReportOpen] = useState(false);
    const [reportClosedOnce, setReportClosedOnce] = useState(false);
    
    // Menu and editing state
    const [anchorEl, setAnchorEl] = useState(null);
    const [selectedChatId, setSelectedChatId] = useState(null);
    const [editingTitleId, setEditingTitleId] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    
    // Refs
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const chatContainerRef = useRef(null);
    const previousMessageLengthRef = useRef(0);

    // Scroll to bottom of messages
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
        // Only scroll if new messages were added (length increased)
        // Don't scroll if messages were just updated (polling)
        if (messages.length > previousMessageLengthRef.current) {
            scrollToBottom();
        }
        previousMessageLengthRef.current = messages.length;
    }, [messages, scrollToBottom]);

    useEffect(() => {
        if (isOpen && !isMinimized && inputRef.current) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen, isMinimized]);

    // Load chat history when component opens
    useEffect(() => {
        if (isOpen) {
            loadChatHistory();
        }
    }, [isOpen]);

    // Check for reportId URL parameter when component mounts
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const reportId = urlParams.get('reportid');
        if (reportId) {
            // Open the chat and load the report
            setIsOpen(true);
            setIsFullscreen(true);
            loadReportById(reportId);
        }
    }, []);

    // Load chat history from API
    const loadChatHistory = async () => {
        try {
            setIsLoadingHistory(true);
            const response = await axios.get('/chat/chat-history', {
                headers: {
                    'auth-token': localStorage.getItem('auth-token')
                }
            });
            if (response.data.success) {
                setChatHistory(response.data.chats);
                
                // Auto-load the most recent chat if no current chat
                if (!currentChatId && response.data.chats.length > 0) {
                    await loadChat(response.data.chats[0].chatId);
                } else if (!currentChatId && response.data.chats.length === 0) {
                    await createNewChat();
                }
            }
        } catch (error) {
            console.error('Error loading chat history:', error);
            if (!currentChatId) {
                await createNewChat();
            }
        } finally {
            setIsLoadingHistory(false);
        }
    };

    // Create new chat
    const createNewChat = async () => {
        try {
            const response = await axios.post('/chat/chat-history', {
                title: 'New Chat'
            }, {
                headers: {
                    'auth-token': localStorage.getItem('auth-token')
                }
            });
            if (response.data.success) {
                const newChat = response.data.chat;
                setCurrentChatId(newChat.chatId);
                setCurrentChatTitle(newChat.title);
                setMessages([{
                    id: 1,
                    text: "Hello! I'm your business assistant. How can I help you analyze your data today?",
                    sender: 'bot',
                    timestamp: new Date()
                }]);
                setMultiStepData(null);
                await loadChatHistory(); // Refresh history
            }
        } catch (error) {
            console.error('Error creating new chat:', error);
        }
    };

    // Load specific chat from history
    const loadChat = async (chatId) => {
        try {
            const response = await axios.get(`/chat/chat-history/${chatId}`, {
                headers: {
                    'auth-token': localStorage.getItem('auth-token')
                }
            });
            if (response.data.success) {
                const chat = response.data.chat;
                setCurrentChatId(chat.chatId);
                setCurrentChatTitle(chat.title);
                
                // Convert chat messages to component format
                const formattedMessages = chat.messages.map((msg, index) => ({
                    id: index + 1,
                    text: msg.content,
                    sender: msg.role === 'user' ? 'user' : 'bot',
                    timestamp: new Date(msg.timestamp),
                    metadata: msg.metadata,
                    visualizationData: msg.visualization,
                    stepResults: msg.stepResults,
                    multiStep: msg.metadata?.type === 'multi_step_plan' || msg.metadata?.type === 'step_result'
                }));
                
                setMessages(formattedMessages);
                
                // Load multi-step data if available
                if (chat.stepResults) {
                    setMultiStepData({
                        reportId: chat.reportId,
                        title: chat.title,
                        goal: chat.multiStepPlan?.goal,
                        stepResults: Object.values(chat.stepResults),
                        totalSteps: chat.multiStepPlan?.totalSteps,
                        completedSteps: chat.multiStepPlan?.completedSteps
                    });
                } else {
                    setMultiStepData(null);
                }
            }
        } catch (error) {
            console.error('Error loading chat:', error);
        }
    };

    // Delete chat
    const deleteChat = async (chatId) => {
        try {
            await axios.delete(`/chat/chat-history/${chatId}`, {
                headers: {
                    'auth-token': localStorage.getItem('auth-token')
                }
            });
            await loadChatHistory(); // Refresh history
            
            // If current chat was deleted, create new one
            if (chatId === currentChatId) {
                await createNewChat();
            }
        } catch (error) {
            console.error('Error deleting chat:', error);
        }
    };

    // Load report by reportId from URL parameter
    const loadReportById = async (reportId) => {
        try {
            const response = await axios.get(`/chat/report/${reportId}`, {
                headers: {
                    'auth-token': localStorage.getItem('auth-token')
                }
            });
            
            if (response.data.success) {
                const report = response.data.report;
                console.log('report: ', report)
                // Set the current chat context from the report
                setCurrentChatId(report.chatId);
                setCurrentChatTitle(report.title);
                
                // Create welcome message with report info
                const reportMessage = {
                    id: 1,
                    text: `Loaded Report: ${report.title}`,
                    sender: 'bot',
                    timestamp: new Date(report.createdAt),
                    metadata: {
                        type: 'report_loaded',
                        reportId: reportId
                    }
                };
                
                setMessages([reportMessage]);
                
                // Only keep analysis steps and workflow steps with visualizations
                Object.keys(report.stepResults).map((key) => {
                    const step = report.stepResults[key];
                    if (step.stepType !== "analysis" && 
                        !(step.stepType === "workflow" && step.result?.visualization)) {
                        delete report.stepResults[key];
                    }
                })

                // Set multi-step data from the report
                if (report.stepResults) {
                    setMultiStepData({
                        reportId: reportId,
                        title: report.title,
                        goal: report.goal,
                        stepResults: report.stepResults,
                        totalSteps: report.totalSteps,
                        completedSteps: report.completedSteps,
                        status: 'completed'
                    });

                    // Automatically open the report dialog only if not closed before
                    if (!reportClosedOnce) {
                        setIsReportOpen(true);
                        // Ensure reportId is in URL
                        const url = new URL(window.location);
                        if (!url.searchParams.has('reportid')) {
                            url.searchParams.set('reportid', reportId);
                            window.history.replaceState({}, '', url);
                        }
                    }
                }
                
            }
        } catch (error) {
            console.error('Error loading report:', error);
            
            // Redirect to login on authentication errors
            if (error.response?.status === 400 || error.response?.status === 401) {
                const currentUrl = encodeURIComponent(window.location.pathname + window.location.search);
                window.location.href = `/login?redirect=${currentUrl}`;
                return;
            }
            
            const errorMessage = {
                id: 1,
                text: `Failed to load report: ${error.response?.data?.error || error.message}`,
                sender: 'bot',
                timestamp: new Date()
            };
            setMessages([errorMessage]);
        }
    };

    // Update chat title
    const updateChatTitle = async (chatId, newTitle) => {
        try {
            await axios.put(`/chat/chat-history/${chatId}/title`, { title: newTitle }, {
                headers: {
                    'auth-token': localStorage.getItem('auth-token')
                }
            });
            await loadChatHistory(); // Refresh history
            if (chatId === currentChatId) {
                setCurrentChatTitle(newTitle);
            }
        } catch (error) {
            console.error('Error updating chat title:', error);
        }
    };

    // Handle chat menu
    const handleChatMenu = (event, chatId) => {
        event.stopPropagation();
        setAnchorEl(event.currentTarget);
        setSelectedChatId(chatId);
    };

    const handleMenuClose = () => {
        setAnchorEl(null);
        setSelectedChatId(null);
    };

    const startEditingTitle = (chatId, currentTitle) => {
        setEditingTitleId(chatId);
        setEditTitle(currentTitle);
        handleMenuClose();
    };

    const saveEditedTitle = async () => {
        if (editingTitleId && editTitle.trim()) {
            await updateChatTitle(editingTitleId, editTitle.trim());
        }
        setEditingTitleId(null);
        setEditTitle('');
    };

    // UI handlers
    const handleToggleChat = () => {
        if (!isOpen) {
            setIsOpen(true);
            setIsFullscreen(false); // Open in windowed mode by default
            setIsMinimized(false);
        } else {
            setIsOpen(false);
            setIsFullscreen(false);
            setIsMinimized(false);
        }
    };

    const handleMinimize = () => {
        setIsMinimized(!isMinimized);
    };

    const handleFullscreen = () => {
        setIsFullscreen(!isFullscreen);
        setIsMinimized(false);
    };

    // Multi-step polling state
    const [pollingInterval, setPollingInterval] = useState(null);
    const [lastPolledChatId, setLastPolledChatId] = useState(null);

    // Multi-step progress polling function
    const startMultiStepPolling = useCallback(async (chatId) => {
        // Clear any existing polling
        if (pollingInterval) {
            clearInterval(pollingInterval);
            setPollingInterval(null);
        }

        setLastPolledChatId(chatId);

        const pollProgress = async () => {
            try {
                // Use loadChat to get the latest chat state
                const response = await axios.get(`/chat/chat-history/${chatId}`, {
                    headers: {
                        'auth-token': localStorage.getItem('auth-token')
                    }
                });

                if (response.data.success) {
                    const chat = response.data.chat;

                    // Update messages
                    const formattedMessages = chat.messages.map((msg, index) => ({
                        id: index + 1,
                        text: msg.content,
                        sender: msg.role === 'user' ? 'user' : 'bot',
                        timestamp: new Date(msg.timestamp),
                        metadata: msg.metadata,
                        visualizationData: msg.visualization,
                        stepResults: msg.stepResults,
                        multiStep: msg.metadata?.type === 'multi_step_plan' || msg.metadata?.type === 'step_result'
                    }));

                    setMessages(formattedMessages);

                    // Update multi-step data
                    if (chat.stepResults) {
                        setMultiStepData({
                            reportId: chat.reportId,
                            title: chat.title,
                            goal: chat.multiStepPlan?.goal,
                            stepResults: Object.values(chat.stepResults),
                            totalSteps: chat.multiStepPlan?.totalSteps,
                            completedSteps: chat.multiStepPlan?.completedSteps,
                            status: chat.status
                        });
                    }

                    // Calculate progress
                    const progress = chat.multiStepPlan?.completedSteps && chat.multiStepPlan?.totalSteps
                        ? (chat.multiStepPlan.completedSteps / chat.multiStepPlan.totalSteps) * 100
                        : 0;

                    setProgressInfo({
                        progress,
                        stage: chat.multiStepPlan?.currentStepDescription || 'Processing...'
                    });

                    // Stop polling if completed or failed
                    if (chat.status === 'completed' || chat.status === 'failed') {
                        console.log(`Multi-step analysis ${chat.status}, stopping polling`);
                        clearInterval(pollingInterval);
                        setPollingInterval(null);
                        setLastPolledChatId(null);
                        setProgressInfo({ progress: 100, stage: 'Complete' });
                        setIsLoading(false);
                        await loadChatHistory();
                    }
                }
            } catch (error) {
                console.error('Error polling progress:', error);
            }
        };

        // Start polling immediately, then every 3 seconds
        await pollProgress();
        const intervalId = setInterval(pollProgress, 5000);
        setPollingInterval(intervalId);
    }, [pollingInterval]);

    // Cleanup polling on unmount or chat change
    useEffect(() => {
        return () => {
            if (pollingInterval) {
                clearInterval(pollingInterval);
            }
        };
    }, [pollingInterval]);

    // Message handling
    const handleSendMessage = async () => {
        if (!inputValue.trim() || isLoading) return;
        
        // Clear any existing polling before starting new message
        if (pollingInterval) {
            clearInterval(pollingInterval);
            setPollingInterval(null);
        }

        // Create new chat if none exists
        if (!currentChatId) {
            await createNewChat();
        }

        const userMessage = {
            id: Date.now(),
            text: inputValue.trim(),
            sender: 'user',
            timestamp: new Date()
        };

        const newMessages = [...messages, userMessage];
        setMessages(newMessages);
        setInputValue('');
        setIsLoading(true);
        setProgressInfo({ progress: 0, stage: '' });

        try {
            // Build the chat chain for the LLM (trims to token limit + formats roles)
            const chatChain = buildChatChain(newMessages);

            // Call the async workflow analysis endpoint
            const response = await workflowAnalysis(
                userMessage.text,
                chatChain,
                currentChatId,
                (progress) => {
                    setProgressInfo({
                        progress: progress.progress || 0,
                        stage: progress.stage || ''
                    });
                }
            );

            console.log('Response from workflowAnalysis:', response);
            
            if (response && response.success) {
                // Update chat title if a new title was generated
                if (response.chatTitle && response.chatTitle !== currentChatTitle) {
                    setCurrentChatTitle(response.chatTitle);
                }

                const { botResponse, multiStepData: parsedMultiStep, isExecuting } =
                    parseWorkflowAnalysisResponse(response, currentChatTitle);

                setMessages(prev => [...prev, botResponse]);

                if (parsedMultiStep) {
                    setMultiStepData(parsedMultiStep);
                    if (isExecuting) {
                        console.log('Multi-step analysis started, beginning progress polling...');
                        startMultiStepPolling(response.chatId);
                    }
                }

                // Refresh chat history to show updated last message and title
                await loadChatHistory();
            } else {
                throw new Error(response?.error || 'No response received from server');
            }
        } catch (error) {
            console.error('Chat error:', error);
            
            let errorMessage = "Sorry, I'm having trouble connecting right now. Please try again.";
            
            if (error.response?.status === 401) {
                errorMessage = "Your session has expired. Please refresh the page and log in again.";
            } else if (error.response?.status === 404) {
                errorMessage = "I don't have any workflow data to analyze yet. Please create and run some workflows first.";
            } else if (error.response?.data?.error) {
                errorMessage = error.response.data.error;
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            const errorMessageObj = {
                id: Date.now() + 1,
                text: errorMessage,
                sender: 'bot',
                timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMessageObj]);
        } finally {
            setIsLoading(false);
            setProgressInfo({ progress: 0, stage: '' });
        }
    };

    const handleKeyPress = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSendMessage();
        }
    };

    // Helper functions
    const formatTimestamp = (timestamp) => {
        const now = new Date();
        const msgTime = new Date(timestamp);
        const diffMinutes = Math.floor((now - msgTime) / (1000 * 60));
        
        if (diffMinutes < 1) return 'Just now';
        if (diffMinutes < 60) return `${diffMinutes}m`;
        if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)}h`;
        return msgTime.toLocaleDateString();
    };

    const getStatusColor = (status) => {
        switch (status) {
            case 'completed': return 'success';
            case 'failed': return 'error';
            default: return 'warning';
        }
    };
    
    const capitalizeFirst = (str) => {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    };

    // Handle report close to prevent reopening
    const handleReportClose = () => {
        setIsReportOpen(false);
        setReportClosedOnce(true);

        // Remove reportId from URL
        const url = new URL(window.location);
        url.searchParams.delete('reportid');
        window.history.replaceState({}, '', url);
    };


    if (!isOpen) {
        return (
            <Zoom in={!isOpen}>
                <Fab
                    color="primary"
                    onClick={handleToggleChat}
                    sx={{
                        position: 'fixed',
                        bottom: 24,
                        right: 24,
                        zIndex: 1000,
                        boxShadow: theme.shadows[8]
                    }}
                >
                    <ChatIcon />
                </Fab>
            </Zoom>
        );
    }

    // Main ChatGPT-style interface
    return (
        <>
            <Slide direction="up" in={isOpen} mountOnEnter unmountOnExit>
                <Paper
                    elevation={16}
                    sx={{
                        position: 'fixed',
                        bottom: isFullscreen ? 0 : isMinimized ? 'auto' : 60,
                        left: isFullscreen ? 0 : isMinimized ? 'auto' : 'auto',
                        right: isFullscreen ? 0 : 24,
                        bottom: isFullscreen ? 0 : 24,
                        width: isFullscreen ? '100vw' : isMinimized ? 320 : 480,
                        height: isFullscreen ? '100vh' : isMinimized ? 60 : 600,
                        zIndex: 8,
                        display: 'flex',
                        flexDirection: isMinimized ? 'row' : 'row',
                        overflow: 'hidden',
                        borderRadius: isFullscreen ? 0 : 3,
                        bgcolor: 'background.paper'
                    }}
                >
                    {/* Minimized state */}
                    {isMinimized ? (
                        <Box sx={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            p: 1.5, 
                            bgcolor: 'primary.main',
                            color: 'primary.contrastText',
                            width: '100%',
                            cursor: 'pointer'
                        }}
                        onClick={handleMinimize}
                        >
                            <ChatIcon sx={{ mr: 1 }} />
                            <Typography variant="body2" sx={{ flex: 1, fontWeight: 500, color: 'white' }}>
                                Business Assistant
                            </Typography>
                            <Typography variant="caption" sx={{ mr: 1, opacity: 0.8 }}>
                                {currentChatTitle}
                            </Typography>
                            <IconButton size="small" onClick={handleToggleChat} sx={{ color: 'inherit' }}>
                                <CloseIcon />
                            </IconButton>
                        </Box>
                    ) : (
                        <>
                            {/* Sidebar - only show in fullscreen */}
                            {isFullscreen && (
                                <ChatSidebar
                                    sidebarWidth={sidebarWidth}
                                    isLoadingHistory={isLoadingHistory}
                                    chatHistory={chatHistory}
                                    currentChatId={currentChatId}
                                    editingTitleId={editingTitleId}
                                    editTitle={editTitle}
                                    createNewChat={createNewChat}
                                    loadChat={loadChat}
                                    formatTimestamp={formatTimestamp}
                                    capitalizeFirst={capitalizeFirst}
                                    getStatusColor={getStatusColor}
                                    setEditTitle={setEditTitle}
                                    setEditingTitleId={setEditingTitleId}
                                    saveEditedTitle={saveEditedTitle}
                                    handleChatMenu={handleChatMenu}
                                />
                            )}
                            
                            {/* Main chat area */}
                            <ChatArea
                                isFullscreen={isFullscreen}
                                currentChatTitle={currentChatTitle}
                                multiStepData={multiStepData}
                                handleFullscreen={handleFullscreen}
                                handleToggleChat={handleToggleChat}
                                chatContainerRef={chatContainerRef}
                                messages={messages}
                                isLoading={isLoading}
                                progressInfo={progressInfo}
                                messagesEndRef={messagesEndRef}
                                inputRef={inputRef}
                                inputValue={inputValue}
                                setInputValue={setInputValue}
                                handleKeyPress={handleKeyPress}
                                handleSendMessage={handleSendMessage}
                                formatTimestamp={formatTimestamp}
                                onSaveToMain={onSaveToMain}
                            />
                        </>
                    )}
                </Paper>
            </Slide>

            {/* Context menu for chat history */}
            <Menu
                anchorEl={anchorEl}
                open={Boolean(anchorEl)}
                onClose={handleMenuClose}
            >
                <MenuItem onClick={() => startEditingTitle(selectedChatId, chatHistory.find(c => c.chatId === selectedChatId)?.title || '')}>
                    <EditIcon sx={{ mr: 2 }} />
                    Rename
                </MenuItem>
                <MenuItem onClick={() => {
                    deleteChat(selectedChatId);
                    handleMenuClose();
                }}>
                    <DeleteIcon sx={{ mr: 2 }} />
                    Delete
                </MenuItem>
            </Menu>

            {/* Multi-step report dialog */}
            {multiStepData && (
                <MultiStepReport
                    open={isReportOpen}
                    onClose={handleReportClose}
                    reportData={multiStepData}
                />
            )}
        </>
    );
};

export default ChatBot;