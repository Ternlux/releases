import React, { useState } from 'react';
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Box,
    Typography,
    Paper,
    Divider,
    IconButton,
    CircularProgress
} from '@mui/material';
import {
    Close as CloseIcon,
    PictureAsPdf as PdfIcon,
    Print as PrintIcon
} from '@mui/icons-material';
import DataVisualization from './DataVisualization';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// Helper function to parse markdown bold syntax and newlines into React elements
const parseMarkdownBold = (text) => {
    if (!text) return text;

    const lines = text.split('\n');

    const processLine = (line, lineIndex) => {
        const parts = [];
        let lastIndex = 0;
        const boldRegex = /\*\*(.*?)\*\*/g;
        let match;

        while ((match = boldRegex.exec(line)) !== null) {
            if (match.index > lastIndex) {
                parts.push(line.substring(lastIndex, match.index));
            }
            parts.push(
                <strong key={`${lineIndex}-${match.index}`} style={{ fontWeight: 700 }}>
                    {match[1]}
                </strong>
            );
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < line.length) {
            parts.push(line.substring(lastIndex));
        }

        return parts.length > 0 ? parts : line;
    };

    const result = [];
    lines.forEach((line, index) => {
        if (index > 0) {
            result.push(<br key={`br-${index}`} />);
        }
        // Empty lines (from \n\n) already contributed a <br> above — skip rendering content
        if (line.trim() === '') return;
        result.push(...(Array.isArray(processLine(line, index)) ? processLine(line, index) : [processLine(line, index)]));
    });

    return result.length > 0 ? result : text;
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

const MultiStepReport = ({ open, onClose, reportData }) => {
    const [exportInProgress, setExportInProgress] = useState(false);

    if (!reportData) {
        return null;
    }

    // Helper function to get the slide title
    const getSlideTitle = (stepResult) => {
        return stepResult.result?.analysis?.title ||
               stepResult.result?.decision?.title ||
               stepResult.description;
    };

    // Get step results in order, filtering out skipped steps and workflow steps without visualizations
    const getOrderedStepResults = () => {
        let results = [];

        if (reportData.stepResults && Array.isArray(reportData.stepResults)) {
            results = reportData.stepResults.sort((a, b) => a.stepId - b.stepId);
        } else if (reportData.stepResults && typeof reportData.stepResults === 'object') {
            // Handle object format
            results = Object.values(reportData.stepResults).sort((a, b) => a.stepId - b.stepId);
        }

        // Filter out skipped steps and workflow steps without visualizations
        return results.filter(step => {
            // Exclude skipped steps
            if (step.skipped || step.result?.skipped) {
                return false;
            }

            // Keep all non-workflow steps (analysis, decision, etc.)
            if (step.stepType !== 'workflow') {
                return true;
            }

            // For workflow steps, only keep if they have a visualization
            return step.result?.visualization;
        });
    };

    const stepResults = getOrderedStepResults();

    const handlePrint = () => {
        window.print();
    };

    const handleExportPDF = async () => {
        if (exportInProgress) return;
        setExportInProgress(true);

        try {
            // Create PDF document in landscape with 16:9 aspect ratio
            const pdf = new jsPDF({
                orientation: 'landscape',
                unit: 'pt',
                format: [842, 595] // 16:9 aspect ratio (close to standard presentation size)
            });

            // PDF dimensions
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();

            // Get the report content element
            const reportElement = document.querySelector('[data-pdf-content="true"]');
            if (!reportElement) {
                console.error('Report content element not found');
                alert('Error: Could not find report content to export.');
                return;
            }

            // Get all step sections (each slide)
            const stepSections = Array.from(reportElement.querySelectorAll('[data-step-section]'));

            for (let i = 0; i < stepSections.length; i++) {
                const stepSection = stepSections[i];

                try {
                    // Check if component has dimensions
                    const rect = stepSection.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) {
                        continue;
                    }

                    // Render slide to canvas using html2canvas
                    const canvas = await html2canvas(stepSection, {
                        scale: 2,
                        logging: false,
                        useCORS: true,
                        allowTaint: true,
                        backgroundColor: '#ffffff'
                    });

                    if (canvas.width <= 0 || canvas.height <= 0) {
                        continue;
                    }

                    // Add new page for each slide (except the first one)
                    if (i > 0) {
                        pdf.addPage();
                    }

                    // Get the image data
                    const imgData = canvas.toDataURL('image/png');

                    // Calculate dimensions to fit full page while maintaining aspect ratio
                    const canvasAspect = canvas.width / canvas.height;
                    const pageAspect = pdfWidth / pdfHeight;

                    let imgWidth, imgHeight, xOffset, yOffset;

                    if (canvasAspect > pageAspect) {
                        // Canvas is wider - fit to width
                        imgWidth = pdfWidth;
                        imgHeight = pdfWidth / canvasAspect;
                        xOffset = 0;
                        yOffset = (pdfHeight - imgHeight) / 2;
                    } else {
                        // Canvas is taller - fit to height
                        imgHeight = pdfHeight;
                        imgWidth = pdfHeight * canvasAspect;
                        xOffset = (pdfWidth - imgWidth) / 2;
                        yOffset = 0;
                    }

                    // Add slide image to fill the page
                    pdf.addImage(imgData, 'PNG', xOffset, yOffset, imgWidth, imgHeight);

                } catch (error) {
                    console.error('Error processing step section:', error);
                }
            }

            // Generate filename using chat title if available
            const timestamp = new Date().toISOString().split('T')[0];
            const titleSlug = reportData.title
                ? reportData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
                : 'analysis-report';
            const filename = `${titleSlug}-${timestamp}.pdf`;

            // Save the PDF
            pdf.save(filename);

        } catch (error) {
            console.error('PDF export error:', error);
            alert('Error exporting PDF. Please try again.');
        } finally {
            setExportInProgress(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth="xl"
            fullWidth
            sx={{
                '& .MuiDialog-paper': {
                    minHeight: '85vh',
                    maxHeight: '95vh',
                    width: '95vw'
                }
            }}
        >
            <DialogTitle>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="h6" component="div" sx={{ fontWeight: 600, color: '#1e293b', fontSize: '1.1rem' }}>
                        Analysis Report
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <IconButton onClick={onClose} sx={{ color: '#6b7280' }}>
                            <CloseIcon />
                        </IconButton>
                    </Box>
                </Box>
            </DialogTitle>

            <DialogContent dividers data-pdf-content="true" sx={{ backgroundColor: '#e5e7eb', p: 2 }}>
                {/* Title Slide */}
                {reportData.goal && (
                    <Paper
                        sx={{
                            mb: 2,
                            aspectRatio: '16/9',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            alignItems: 'center',
                            p: 5,
                            backgroundColor: '#ffffff',
                            boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
                            position: 'relative'
                        }}
                        data-step-section="title-slide"
                    >
                        <Typography
                            variant="h4"
                            sx={{
                                mb: 2,
                                color: '#1e293b',
                                fontWeight: 700,
                                textAlign: 'center',
                                fontSize: '1.75rem'
                            }}
                        >
                            Analysis Report
                        </Typography>
                        <Typography
                            variant="h6"
                            sx={{
                                color: '#475569',
                                textAlign: 'center',
                                maxWidth: '85%',
                                lineHeight: 1.8,
                                fontSize: '1.1rem'
                            }}
                        >
                            {reportData.goal}
                        </Typography>
                        <Box sx={{ position: 'absolute', bottom: 16, right: 24, color: '#94a3b8', fontSize: '0.875rem' }}>
                            Slide 1
                        </Box>
                    </Paper>
                )}

                {/* Analysis Slides */}
                {stepResults.map((stepResult, index) => (
                    <Paper
                        key={stepResult.stepId}
                        sx={{
                            mb: 2,
                            aspectRatio: '16/9',
                            display: 'flex',
                            flexDirection: 'column',
                            p: 3,
                            backgroundColor: '#ffffff',
                            boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
                            position: 'relative'
                        }}
                        data-step-section={`step-${stepResult.stepId}`}
                    >
                        {/* Slide Title */}
                        <Box sx={{
                            borderBottom: '2px solid #3b82f6',
                            pb: 1.5,
                            mb: 2.5
                        }}>
                            <Typography
                                variant="h5"
                                sx={{
                                    color: '#1e293b',
                                    fontWeight: 600,
                                    fontSize: '1.25rem'
                                }}
                            >
                                {getSlideTitle(stepResult)}
                            </Typography>
                        </Box>

                        {/* Slide Content */}
                        <Box sx={{ flex: 1, overflow: 'auto' }}>
                            {/* Analysis Results */}
                            {stepResult.stepType === 'analysis' && stepResult.result?.analysis && (
                                <Box sx={{ display: 'flex', gap: 3, height: '100%' }}>
                                    {/* Segmentation Image */}
                                    {stepResult.result.analysis.segmentation && stepResult.result.analysis.segmentation.age && stepResult.result.analysis.segmentation.income && (
                                        <Box sx={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: 1.5,
                                            minWidth: 140,
                                            maxWidth: 140
                                        }}>
                                            <Box
                                                component="img"
                                                src={getImageLink(stepResult.result.analysis.segmentation.age, stepResult.result.analysis.segmentation.income)}
                                                alt={`${stepResult.result.analysis.segmentation.age} ${stepResult.result.analysis.segmentation.income}`}
                                                sx={{
                                                    width: '100%',
                                                    height: 'auto',
                                                    borderRadius: 2,
                                                    border: '2px solid #e2e8f0',
                                                    boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1)'
                                                }}
                                                onError={(e) => {
                                                    e.target.style.display = 'none';
                                                }}
                                            />
                                        </Box>
                                    )}

                                    {/* Analysis Text */}
                                    <Box sx={{ flex: 1 }}>
                                        <Typography
                                            variant="body1"
                                            sx={{
                                                lineHeight: 2,
                                                color: '#334155',
                                                fontSize: '0.95rem'
                                            }}
                                        >
                                            {parseMarkdownBold(stepResult.result.analysis.response)}
                                        </Typography>
                                        {stepResult.result.analysis.explanation && (
                                            <Typography
                                                variant="body2"
                                                sx={{
                                                    color: '#64748b',
                                                    fontStyle: 'italic',
                                                    mt: 2,
                                                    fontSize: '0.875rem',
                                                    lineHeight: 1.9
                                                }}
                                            >
                                                {parseMarkdownBold(stepResult.result.analysis.explanation)}
                                            </Typography>
                                        )}
                                    </Box>
                                </Box>
                            )}

                            {/* Decision Results */}
                            {stepResult.stepType === 'decision' && stepResult.result?.decision && (
                                <Box>
                                    <Typography
                                        variant="body1"
                                        sx={{
                                            lineHeight: 2,
                                            mb: 2.5,
                                            color: '#334155',
                                            fontSize: '0.95rem'
                                        }}
                                    >
                                        {parseMarkdownBold(stepResult.result.decision.response || stepResult.result.decision.decision)}
                                    </Typography>
                                    {stepResult.result.decision.reasoning && (
                                        <Typography
                                            variant="body2"
                                            sx={{
                                                color: '#64748b',
                                                mb: 2.5,
                                                fontSize: '0.875rem',
                                                lineHeight: 1.9
                                            }}
                                        >
                                            <strong>Reasoning:</strong> {parseMarkdownBold(stepResult.result.decision.reasoning)}
                                        </Typography>
                                    )}
                                    {stepResult.result.decision.recommendations?.length > 0 && (
                                        <Box sx={{ mt: 2.5 }}>
                                            <Typography
                                                variant="subtitle1"
                                                sx={{
                                                    fontWeight: 600,
                                                    mb: 1.5,
                                                    color: '#1e293b',
                                                    fontSize: '1rem'
                                                }}
                                            >
                                                Recommendations:
                                            </Typography>
                                            <Box component="ul" sx={{ pl: 3, m: 0 }}>
                                                {stepResult.result.decision.recommendations.map((rec, idx) => (
                                                    <Typography
                                                        component="li"
                                                        key={idx}
                                                        variant="body2"
                                                        sx={{
                                                            mb: 1.5,
                                                            color: '#334155',
                                                            fontSize: '0.9rem',
                                                            lineHeight: 1.9
                                                        }}
                                                    >
                                                        {parseMarkdownBold(rec)}
                                                    </Typography>
                                                ))}
                                            </Box>
                                        </Box>
                                    )}
                                </Box>
                            )}

                            {/* Workflow Results - Only shown when visualization exists */}
                            {stepResult.stepType === 'workflow' && stepResult.result?.visualization && (
                                // <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                                    // <Box sx={{ width: '100%', height: '100%', flex: 1 }}>
                                        <DataVisualization
                                            visualizationData={stepResult.result.visualization}
                                            compact={true}
                                            hideMenu={true}
                                        />
                                    // </Box>
                                // </Box>
                            )}

                            {/* Error Results */}
                            {stepResult.result?.error && (
                                <Box sx={{
                                    p: 2.5,
                                    backgroundColor: '#fef2f2',
                                    border: '2px solid #fecaca',
                                    borderRadius: 2
                                }}>
                                    <Typography variant="body1" sx={{ color: '#dc2626', fontSize: '0.95rem', lineHeight: 1.9 }}>
                                        <strong>Error:</strong> {stepResult.result.error}
                                    </Typography>
                                </Box>
                            )}
                        </Box>

                        {/* Slide Number */}
                        <Box
                            sx={{
                                position: 'absolute',
                                bottom: 16,
                                right: 24,
                                color: '#94a3b8',
                                fontSize: '0.875rem',
                                fontWeight: 500
                            }}
                        >
                            Slide {reportData.goal ? index + 2 : index + 1}
                        </Box>
                    </Paper>
                ))}
            </DialogContent>

            <DialogActions>
                {/* <Button onClick={handlePrint} startIcon={<PrintIcon />}>
                    Print Report
                </Button> */}
                <Button 
                    onClick={handleExportPDF} 
                    disabled={exportInProgress}
                    startIcon={exportInProgress ? <CircularProgress size={16} /> : <PdfIcon />}
                >
                    {exportInProgress ? 'Exporting...' : 'Export PDF'}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default MultiStepReport;