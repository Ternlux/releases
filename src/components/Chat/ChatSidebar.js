import React, { useState, useEffect } from 'react';
import {
    Box,
    Button,
    Typography,
    List,
    ListItem,
    ListItemButton,
    CircularProgress,
    IconButton,
    TextField,
    Chip,
    alpha,
    useTheme
} from '@mui/material';
import {
    Chat as ChatIcon,
    Add as AddIcon,
    MoreVert as MoreVertIcon,
    ChevronLeft as ChevronLeftIcon,
    ChevronRight as ChevronRightIcon
} from '@mui/icons-material';
import OutsideClickHandler from 'react-outside-click-handler';

const ChatSidebar = ({
    sidebarWidth,
    isLoadingHistory,
    chatHistory,
    currentChatId,
    editingTitleId,
    editTitle,
    createNewChat,
    loadChat,
    formatTimestamp,
    capitalizeFirst,
    getStatusColor,
    setEditTitle,
    setEditingTitleId,
    saveEditedTitle,
    handleChatMenu
}) => {
    const theme = useTheme();
    const [isCollapsed, setIsCollapsed] = useState(false);
    
    const toggleSidebar = () => {
        setIsCollapsed(!isCollapsed);
    };
    
    // console.log('editingTitleId: ', editingTitleId)
    return (
        <Box
            sx={{
                position: 'relative',
                width: isCollapsed ? 0 : sidebarWidth,
                height: '100%',
                bgcolor: 'grey.50',
                borderRight: 1,
                borderColor: 'divider',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'visible',
                transition: 'width 0.3s ease-in-out'
            }}
        >
            {/* Collapse/Expand Toggle Button */}
            <IconButton
                onClick={toggleSidebar}
                sx={{
                    position: 'absolute',
                    top: '50%',
                    right: -25, // Stick out to the right
                    transform: 'translateY(-50%)',
                    width: 25,
                    height: 70,
                    bgcolor: 'white',
                    color: 'black',
                    border: 1,
                    borderColor: 'divider',
                    // boxShadow: 2,
                    // border: 1,
                    zIndex: 10,
                    '&:hover': {
                        bgcolor: 'white',
                        boxShadow: 1
                    },
                    borderRadius: 0
                }}
            >
                {isCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            </IconButton>
            
            {!isCollapsed && (
                <>
                    {/* Sidebar header */}
                    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
                <Button
                    fullWidth
                    variant="outlined"
                    startIcon={<AddIcon />}
                    onClick={createNewChat}
                    sx={{
                        justifyContent: 'flex-start',
                        textTransform: 'none',
                        borderRadius: 2,
                        height: 32,
                        py: 1
                    }}
                >
                    New chat
                </Button>
            </Box>

            {/* Chat history list */}
            <Box sx={{ flex: 1, overflow: 'auto' }}>
                {isLoadingHistory ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                        <CircularProgress size={24} />
                    </Box>
                ) : chatHistory.length === 0 ? (
                    <Box sx={{ p: 3, textAlign: 'center' }}>
                        <Typography variant="body2" color="text.secondary">
                            No conversations yet
                        </Typography>
                    </Box>
                ) : (
                    <List sx={{ p: 1 }}>
                        {chatHistory.map((chat, index) => (
                            <ListItem key={chat.chatId} disablePadding sx={{ mb: 0.5 }}>
                                <ListItemButton
                                    onClick={() => loadChat(chat.chatId)}
                                    selected={chat.chatId === currentChatId}
                                    sx={{
                                        borderRadius: 2,
                                        py: 1.5,
                                        px: 2,
                                        '&.Mui-selected': {
                                            bgcolor: alpha(theme.palette.primary.main, 0.1),
                                            '&:hover': {
                                                bgcolor: alpha(theme.palette.primary.main, 0.15),
                                            }
                                        },
                                        '&:hover': {
                                            bgcolor: alpha(theme.palette.grey[500], 0.05)
                                        }
                                    }}
                                >
                                    <Box sx={{ 
                                        display: 'flex', 
                                        alignItems: 'center', 
                                        width: '100%',
                                        overflow: 'hidden'
                                    }}>
                                        <ChatIcon sx={{ 
                                            mr: 1.5, 
                                            fontSize: 18, 
                                            color: 'text.secondary',
                                            flexShrink: 0
                                        }} />
                                        <Box sx={{ flex: 1, overflow: 'hidden' }}>
                                            {editingTitleId === chat.chatId ? (
                                                <OutsideClickHandler onOutsideClick={() => saveEditedTitle()} >
                                                    <TextField
                                                        value={editTitle}
                                                        onChange={(e) => setEditTitle(e.target.value)}
                                                        // onBlur={saveEditedTitle}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                saveEditedTitle();
                                                            }
                                                            if (e.key === 'Escape') {
                                                                e.preventDefault();
                                                                setEditTitle('');
                                                                setEditingTitleId(null);
                                                            }
                                                        }}
                                                        size="small"
                                                        variant="standard"
                                                        autoFocus
                                                        fullWidth
                                                        sx={{ fontSize: '0.875rem' }}
                                                    />
                                                </OutsideClickHandler>
                                            ) : (
                                                <Typography 
                                                    variant="body2" 
                                                    noWrap
                                                    sx={{ 
                                                        fontWeight: chat.chatId === currentChatId ? 600 : 400,
                                                        color: chat.chatId === currentChatId ? 'primary.main' : 'text.primary'
                                                    }}
                                                >
                                                    {chat.title}
                                                </Typography>
                                            )}
                                            <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5, gap: 1 }}>
                                                <Typography variant="caption" color="text.secondary">
                                                    {formatTimestamp(chat.lastMessageAt)}
                                                </Typography>
                                                <Chip
                                                    label={capitalizeFirst(chat.status)}
                                                    size="small"
                                                    color={getStatusColor(chat.status)}
                                                    sx={{ 
                                                        height: 16, 
                                                        fontSize: '0.65rem',
                                                        '& .MuiChip-label': { px: 1 }
                                                    }}
                                                />
                                            </Box>
                                        </Box>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => handleChatMenu(e, chat.chatId)}
                                            sx={{ 
                                                opacity: 0,
                                                transition: 'opacity 0.2s',
                                                '.MuiListItemButton-root:hover &': { opacity: 1 }
                                            }}
                                        >
                                            <MoreVertIcon fontSize="small" />
                                        </IconButton>
                                    </Box>
                                </ListItemButton>
                            </ListItem>
                        ))}
                    </List>
                )}
            </Box>
                </>
            )}
        </Box>
    );
};

export default ChatSidebar;