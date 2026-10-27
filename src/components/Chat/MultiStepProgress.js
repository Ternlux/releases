import React, { useState } from 'react';
import {
    Box,
    Typography,
    Stepper,
    Step,
    StepLabel,
    StepContent,
    Paper,
    Chip,
    Button,
    Collapse,
    IconButton,
    Divider,
    useTheme
} from '@mui/material';
import {
    Analytics as AnalyticsIcon,
    AccountTree as DecisionIcon,
    DataUsage as WorkflowIcon,
    CheckCircle as CheckCircleIcon,
    Schedule as ScheduleIcon,
    Error as ErrorIcon,
    ExpandMore as ExpandMoreIcon,
    Code as CodeIcon
} from '@mui/icons-material';

const MultiStepProgress = ({ data, compact = false }) => {
    const theme = useTheme();
    const [expandedSteps, setExpandedSteps] = useState({});
    const [showSql, setShowSql] = useState({});

    if (!data) return null;

    const toggleStepExpansion = (stepId) => {
        setExpandedSteps(prev => ({
            ...prev,
            [stepId]: !prev[stepId]
        }));
    };

    const toggleSqlView = (stepId) => {
        setShowSql(prev => ({
            ...prev,
            [stepId]: !prev[stepId]
        }));
    };

    const getStepIcon = (stepType, status = 'pending') => {
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
    }

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

    const getStepStatus = (stepId) => {
        if (!data.stepResults) return 'pending';
        const stepResult = data.stepResults[`step_${stepId}`] || Object.values(data.stepResults).find(s => s.stepId === stepId);
        if (!stepResult) return 'pending';
        if (stepResult.result?.error) return 'error';
        if (stepResult.skipped || stepResult.result?.skipped) return 'skipped';
        return 'completed';
    };

    const getStepResult = (stepId) => {
        if (!data.stepResults) return null;
        return data.stepResults[`step_${stepId}`] || Object.values(data.stepResults).find(s => s.stepId === stepId);
    };

    const renderExecutionPlan = () => {
        if (!data.steps) return null;

        return (
            <Box sx={{ mb: 2 }}>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 2 }}>
                    Multi-step progress:
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {data.steps.map((step, index) => {
                        const colors = getStepColor(step.type);
                        const status = getStepStatus(step.id);
                        const stepResult = getStepResult(step.id);
                        const isExpanded = expandedSteps[step.id];
                        const canShowSql = step.type === 'workflow' && step.transformations?.length > 0;

                        return (
                            <Paper
                                key={step.id}
                                sx={{
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
                                                   status === 'completed' ? '#10b981' :
                                                   status === 'skipped' ? '#94a3b8' : '#9ca3af',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            color: 'white',
                                            flexShrink: 0
                                        }}
                                    >
                                        {getStepIcon(step.type, status)}
                                    </Box>

                                    {/* Step Info */}
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                                            <Typography variant="body2" fontWeight={600} sx={{ color: 'text.primary' }}>
                                                Step {step.id}: {capitalizeFirst(step.type)}
                                            </Typography>
                                            <Chip
                                                label={status === 'error' ? 'Error' :
                                                      status === 'completed' ? 'Complete' :
                                                      status === 'skipped' ? 'Skipped' : 'Pending'}
                                                size="small"
                                                color={status === 'error' ? 'error' :
                                                      status === 'completed' ? 'success' :
                                                      status === 'skipped' ? 'default' : 'default'}
                                                sx={{
                                                    fontSize: '0.7rem',
                                                    height: 20,
                                                    ...(status === 'skipped' && {
                                                        bgcolor: '#e2e8f0',
                                                        color: '#64748b'
                                                    })
                                                }}
                                            />
                                        </Box>
                                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                            {step.description}
                                        </Typography>
                                    </Box>

                                    {/* Actions */}
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>

                                        {(stepResult || canShowSql) && (
                                            <IconButton
                                                size="small"
                                                onClick={() => toggleStepExpansion(step.id)}
                                                sx={{
                                                    color: colors.text,
                                                    transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                                    transition: 'transform 0.2s'
                                                }}
                                            >
                                                <ExpandMoreIcon fontSize="small" />
                                            </IconButton>
                                        )}
                                    </Box>
                                </Box>

                                {/* Expanded Content */}
                                <Collapse in={isExpanded}>
                                    <Box sx={{ mt: 2, pt: 2, borderTop: `1px solid ${colors.border}` }}>
                                    {canShowSql && (
                                            <IconButton
                                                size="small"
                                                onClick={() => toggleSqlView(step.id)}
                                                sx={{ color: colors.text }}
                                            >
                                                <CodeIcon fontSize="small" />
                                            </IconButton>
                                        )}
                                        {/* SQL Display */}
                                        {canShowSql && showSql[step.id] && (
                                            <Box sx={{ mb: 2 }}>
                                                <Typography variant="caption" fontWeight={600} sx={{ mb: 1, display: 'block' }}>
                                                    SQL Executed:
                                                </Typography>
                                                {step.transformations.map((transformation, idx) => (
                                                    <Paper
                                                        key={idx}
                                                        sx={{
                                                            p: 1.5,
                                                            bgcolor: 'grey.900',
                                                            color: 'grey.100',
                                                            fontFamily: 'monospace',
                                                            fontSize: '0.8rem',
                                                            mb: idx < step.transformations.length - 1 ? 1 : 0,
                                                            border: '1px solid #374151'
                                                        }}
                                                    >
                                                        <Typography variant="caption" sx={{ color: 'grey.300', mb: 0.5, display: 'block' }}>
                                                            Workflow: {transformation.workflow}
                                                        </Typography>
                                                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                                                            {transformation.sql}
                                                        </Typography>
                                                    </Paper>
                                                ))}
                                            </Box>
                                        )}

                                        {/* Step Results */}
                                        {stepResult && (
                                            <Box>
                                                {stepResult.result.error ? (
                                                    <Box sx={{
                                                        p: 1.5,
                                                        bgcolor: '#fef2f2',
                                                        border: '1px solid #fecaca',
                                                        borderRadius: 1
                                                    }}>
                                                        <Typography variant="caption" fontWeight={600} sx={{ color: '#dc2626' }}>
                                                            Error: {stepResult.result.error}
                                                        </Typography>
                                                    </Box>
                                                ) : stepResult.result.skipped ? (
                                                    <Box sx={{
                                                        p: 1.5,
                                                        bgcolor: '#f8fafc',
                                                        border: '1px solid #cbd5e1',
                                                        borderRadius: 1
                                                    }}>
                                                        <Typography variant="caption" fontWeight={600} sx={{ color: '#64748b', mb: 0.5, display: 'block' }}>
                                                            Step Skipped
                                                        </Typography>
                                                        <Typography variant="caption" sx={{ color: '#475569' }}>
                                                            {stepResult.result.reason || 'This step was skipped based on previous analysis'}
                                                        </Typography>
                                                    </Box>
                                                ) : (
                                                    <Box>
                                                        {/* Workflow Results */}
                                                        {step.type === 'workflow' && stepResult.result.datasets && (
                                                            <Box sx={{ mb: 1 }}>
                                                                <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
                                                                    Data Processed:
                                                                </Typography>
                                                                {stepResult.result.datasets.map((dataset, idx) => (
                                                                    <Typography key={idx} variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                                                                        • {dataset.tableName}: {dataset.rowCount || 'N/A'} rows
                                                                    </Typography>
                                                                ))}
                                                            </Box>
                                                        )}

                                                        {/* Analysis Results */}
                                                        {step.type === 'analysis' && stepResult.result.analysis && (
                                                            <Box sx={{ mb: 1 }}>
                                                                <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
                                                                    Analysis:
                                                                </Typography>
                                                                <Typography variant="body2" sx={{ fontSize: '0.8rem', lineHeight: 1.4 }}>
                                                                    {stepResult.result.analysis.response}
                                                                </Typography>
                                                            </Box>
                                                        )}

                                                        {/* Decision Results */}
                                                        {step.type === 'decision' && stepResult.result.decision && (
                                                            <Box sx={{ mb: 1 }}>
                                                                <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
                                                                    Decision:
                                                                </Typography>
                                                                <Typography variant="body2" sx={{ fontSize: '0.8rem', lineHeight: 1.4 }}>
                                                                    {stepResult.result.decision.decision}
                                                                </Typography>
                                                                {stepResult.result.decision.recommendations?.length > 0 && (
                                                                    <Box sx={{ mt: 1 }}>
                                                                        <Typography variant="caption" fontWeight={600}>
                                                                            Recommendations:
                                                                        </Typography>
                                                                        {stepResult.result.decision.recommendations.map((rec, idx) => (
                                                                            <Typography key={idx} variant="caption" sx={{ display: 'block', ml: 1 }}>
                                                                                • {rec}
                                                                            </Typography>
                                                                        ))}
                                                                    </Box>
                                                                )}
                                                            </Box>
                                                        )}
                                                    </Box>
                                                )}
                                                
                                                <Typography variant="caption" sx={{ 
                                                    color: 'text.secondary', 
                                                    fontSize: '0.7rem',
                                                    display: 'block',
                                                    textAlign: 'right',
                                                    mt: 1
                                                }}>
                                                    {stepResult.completedAt && `Completed: ${new Date(stepResult.completedAt).toLocaleTimeString()}`}
                                                </Typography>
                                            </Box>
                                        )}
                                    </Box>
                                </Collapse>
                            </Paper>
                        );
                    })}
                </Box>
            </Box>
        );
    };

    return (
        <Box sx={{ width: '100%' }}>
            {data.goal && (
                <Box sx={{ mb: 2 }}>
                    <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                        Goal:
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.primary', fontSize: '0.9rem' }}>
                        {data.goal}
                    </Typography>
                </Box>
            )}
            
            {renderExecutionPlan()}
            
            {data.status === 'completed' && (
                <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                    <Chip
                        label="Analysis Complete"
                        color="success"
                        size="small"
                        icon={<CheckCircleIcon />}
                    />
                </Box>
            )}
        </Box>
    );
};

export default MultiStepProgress;