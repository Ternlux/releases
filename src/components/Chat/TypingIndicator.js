import React from 'react';
import {
    Box,
    Paper,
    Typography,
    Avatar,
    CircularProgress,
    LinearProgress,
    Fade
} from '@mui/material';
import {
    SmartToy as BotIcon
} from '@mui/icons-material';

const TypingIndicator = ({ isLoading, progressInfo, isFullscreen }) => (
    <Fade in={isLoading}>
        <Box
            sx={{
                display: 'flex',
                mb: 2,
                justifyContent: 'flex-start',
                px: isFullscreen ? 3 : 2
            }}
        >
            <Avatar 
                sx={{ 
                    width: 32, 
                    height: 32, 
                    mr: 2,
                    bgcolor: 'primary.main',
                    alignSelf: 'flex-end'
                }}
            >
                <BotIcon fontSize="small" />
            </Avatar>
            
            <Paper
                elevation={0}
                sx={{
                    p: 2,
                    bgcolor: 'grey.100',
                    borderRadius: 4,
                    borderTopLeftRadius: 1,
                    minWidth: 120
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={16} />
                    <Typography variant="body2" color="text.secondary">
                        {progressInfo.stage || 'Thinking...'}
                    </Typography>
                </Box>
                {progressInfo.progress > 0 && (
                    <Box sx={{ mt: 1 }}>
                        <LinearProgress 
                            variant="determinate" 
                            value={progressInfo.progress}
                            sx={{ borderRadius: 1, height: 4 }}
                        />
                        <Typography variant="caption" color="text.secondary">
                            {Math.round(progressInfo.progress)}% complete
                        </Typography>
                    </Box>
                )}
            </Paper>
        </Box>
    </Fade>
);

export default TypingIndicator;