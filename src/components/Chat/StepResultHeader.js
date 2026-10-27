import React from 'react';
import {
    Box,
    Paper,
    Typography,
    Chip
} from '@mui/material';
import {
    Analytics as AnalyticsIcon,
    AccountTree as DecisionIcon,
    DataUsage as WorkflowIcon,
    CheckCircle as CheckCircleIcon,
    Schedule as ScheduleIcon,
    Error as ErrorIcon
} from '@mui/icons-material';

const StepResultHeader = ({ metadata }) => {
    const getStepColor = (stepType) => {
        switch (stepType) {
            case 'workflow':
                return {
                    main: '#dcfce7', // light green
                    border: '#bbf7d0',
                    text: '#166534'
                };
            case 'analysis':
                return {
                    main: '#dbeafe', // light blue
                    border: '#bfdbfe',
                    text: '#1e40af'
                };
            case 'decision':
                return {
                    main: '#fed7aa', // light orange
                    border: '#fdba74',
                    text: '#c2410c'
                };
            default:
                return {
                    main: '#f3f4f6',
                    border: '#d1d5db',
                    text: '#374151'
                };
        }
    };

    const getStepIcon = (stepType, status = 'completed') => {
        const iconProps = { fontSize: 'small' };
        
        if (status === 'error') {
            return <ErrorIcon {...iconProps} />;
        }
        
        switch (stepType) {
            case 'workflow':
                return <WorkflowIcon {...iconProps} />;
            case 'analysis':
                return <AnalyticsIcon {...iconProps} />;
            case 'decision':
                return <DecisionIcon {...iconProps} />;
            default:
                return status === 'completed' ? <CheckCircleIcon {...iconProps} /> : <ScheduleIcon {...iconProps} />;
        }
    };

    const capitalizeFirst = (str) => {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    };

    const colors = getStepColor(metadata.stepType);
    const status = 'completed'; // Step results are always completed

    return (
        <Paper
            sx={{
                mt: 2,
                mb: 2,
                p: 1.5,
                bgcolor: colors.main,
                border: `1px solid ${colors.border}`,
                borderRadius: 2
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                {/* Step Icon */}
                <Box
                    sx={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        bgcolor: status === 'error' ? '#ef4444' : 
                               status === 'completed' ? '#10b981' : '#9ca3af',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                        flexShrink: 0
                    }}
                >
                    {getStepIcon(metadata.stepType, status)}
                </Box>

                {/* Step Info */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                        <Typography variant="body2" fontWeight={600} sx={{ color: 'text.primary' }}>
                            Step {metadata.stepId}: {capitalizeFirst(metadata.stepType)}
                        </Typography>
                        <Chip
                            label="Complete"
                            size="small"
                            color="success"
                            sx={{ fontSize: '0.7rem', height: 20 }}
                        />
                    </Box>
                    {metadata.stepDescription && (
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            {metadata.stepDescription}
                        </Typography>
                    )}
                </Box>
            </Box>
        </Paper>
    );
};

export default StepResultHeader;