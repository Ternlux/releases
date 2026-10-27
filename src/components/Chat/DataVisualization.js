import React, { useState } from 'react';
import {
    Box,
    Typography,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Paper,
    IconButton,
    Menu,
    MenuItem,
    CircularProgress
} from '@mui/material';
import { MoreVert as MoreVertIcon } from '@mui/icons-material';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    Title,
    Tooltip,
    Legend,
    ArcElement,
} from 'chart.js';
import { Bar, Line, Pie, Scatter } from 'react-chartjs-2';
import Editor from '@monaco-editor/react';
import { Boxdataset } from '../ui_components/boxdataset';

// Read-only Monaco JSON view for unstructured / document results, matching the
// look DataPreview uses for document-shaped data.
const defineTernluxLightTheme = (monaco) => {
    monaco.editor.defineTheme('ternlux-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
            'editor.background': '#ffffff',
            'editor.foreground': '#111827',
            'editorLineNumber.foreground': '#9ca3af',
            'editorLineNumber.activeForeground': '#5a6678',
            'editor.lineHighlightBackground': '#f7f9fc',
            'editorIndentGuide.background': '#eef1f6',
            'editorGutter.background': '#ffffff',
            'scrollbarSlider.background': '#e2e6eb88',
            'minimap.background': '#f7f9fc',
        },
    });
};

// Register Chart.js components
ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    Title,
    Tooltip,
    Legend,
    ArcElement
);

// Color palette for charts
const COLORS = [
    '#10a37f', '#007AFF', '#FF6B6B', '#4ECDC4', '#45B7D1',
    '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
];

// Chart.js options
const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            position: 'top',
            labels: {
                usePointStyle: true,
                padding: 20,
                font: {
                    size: 12
                }
            }
        },
        title: {
            display: false
        },
    },
};

const DataVisualization = ({ visualizationData, onSaveToMain, boxClickFunction, isLoading = false, hideMenu = false, compact = false, bare = false }) => {
    const [anchorEl, setAnchorEl] = useState(null);
    const open = Boolean(anchorEl);

    // Charts need a definite height to render. In the chat's `bare` panel the
    // surrounding container is capped by maxHeight (no fixed height), so a
    // percentage would collapse — use a definite pixel height there instead.
    // Reports/presentations keep the responsive 90%; dashboards use 400px.
    const chartHeight = bare ? '340px' : compact ? '90%' : '400px';

    if (!visualizationData) {
        return null;
    }

    // Determine if we should show the menu (only in ChatBot context and when hideMenu is false)
    const showMenu = !hideMenu && onSaveToMain !== null;
    
    // Determine if we should show the title and container box.
    // `bare` mode (used by the chat's tabbed VisualsPanel) suppresses both —
    // the panel supplies its own framing, title, and footer.
    // In chat: show container for ALL types (including box)
    // In dashboard: show container for all types EXCEPT box
    const showContainer = !bare && (onSaveToMain !== null || (onSaveToMain === null && visualizationData.type !== 'box'));
    const showTitle = showContainer;

    const handleMenuClick = (event) => {
        setAnchorEl(event.currentTarget);
    };

    const handleMenuClose = () => {
        setAnchorEl(null);
    };

    const handleSaveToMain = () => {
        if (onSaveToMain) {
            onSaveToMain(visualizationData);
        }
        handleMenuClose();
    };

    const renderChart = () => {
        switch (visualizationData.type) {
            case 'bar':
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                
                const barData = {
                    labels: visualizationData.data.map(item => item.x),
                    datasets: [
                        {
                            label: visualizationData.yAxisLabel || 'Value',
                            data: visualizationData.data.map(item => item.y),
                            backgroundColor: COLORS[0],
                            borderColor: COLORS[0],
                            borderWidth: 1,
                        },
                    ],
                };

                const barOptions = {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                font: { size: 11 }
                            }
                        },
                        x: {
                            ticks: {
                                font: { size: 11 },
                                maxRotation: 45,
                                minRotation: 0
                            }
                        }
                    }
                };

                return (
                    <div style={{ height: chartHeight }}>
                        <Bar data={barData} options={barOptions} />
                    </div>
                );

            case 'line':
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                
                const lineData = {
                    labels: visualizationData.data.map(item => item.x),
                    datasets: [
                        {
                            label: visualizationData.yAxisLabel || 'Value',
                            data: visualizationData.data.map(item => item.y),
                            borderColor: COLORS[1],
                            backgroundColor: COLORS[1] + '20',
                            borderWidth: 3,
                            fill: true,
                            tension: 0.4,
                        },
                    ],
                };

                const lineOptions = {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                font: { size: 11 }
                            }
                        },
                        x: {
                            ticks: {
                                font: { size: 11 },
                                maxRotation: 45,
                                minRotation: 0
                            }
                        }
                    }
                };

                return (
                    <div style={{ height: chartHeight }}>
                        <Line data={lineData} options={lineOptions} />
                    </div>
                );

            case 'pie':
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                
                const pieData = {
                    labels: visualizationData.data.map(item => item.x ?? item.name),
                    datasets: [
                        {
                            data: visualizationData.data.map(item => item.y ?? item.value),
                            backgroundColor: COLORS.slice(0, visualizationData.data.length),
                            borderColor: '#ffffff',
                            borderWidth: 2,
                        },
                    ],
                };

                const pieOptions = {
                    ...chartOptions,
                    plugins: {
                        ...chartOptions.plugins,
                        tooltip: {
                            callbacks: {
                                label: (context) => {
                                    const total = context.dataset.data.reduce((sum, value) => sum + value, 0);
                                    const percentage = ((context.parsed / total) * 100).toFixed(1);
                                    return `${context.label}: ${context.parsed} (${percentage}%)`;
                                }
                            }
                        }
                    }
                };

                return (
                    <div style={{ height: chartHeight }}>
                        <Pie data={pieData} options={pieOptions} />
                    </div>
                );

            case 'table':
                if (isLoading) {
                    return (
                        <TableContainer component={Paper} sx={{ maxHeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress sx={{ my: 10 }} />
                        </TableContainer>
                    );
                }

                // Unstructured / document data → read-only Monaco JSON view.
                if (visualizationData.isJson) {
                    return (
                        <div style={{ height: 360, backgroundColor: '#fff', border: '1px solid #e2e6eb', borderRadius: 6, overflow: 'hidden' }}>
                            <Editor
                                height="100%"
                                language="json"
                                value={JSON.stringify(visualizationData.json ?? visualizationData.data ?? null, null, 2)}
                                beforeMount={defineTernluxLightTheme}
                                theme="ternlux-light"
                                options={{
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    fontSize: 12,
                                    fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
                                    scrollBeyondLastLine: false,
                                    automaticLayout: true,
                                    wordWrap: 'on',
                                    tabSize: 2,
                                    lineNumbers: 'on',
                                    padding: { top: 10, bottom: 10 },
                                }}
                            />
                        </div>
                    );
                }

                // Columns may be supplied explicitly; otherwise derive them
                // from the first row's keys.
                const tableRows = Array.isArray(visualizationData.data) ? visualizationData.data : [];
                const tableColumns = (Array.isArray(visualizationData.columns) && visualizationData.columns.length)
                    ? visualizationData.columns
                    : (tableRows[0] && typeof tableRows[0] === 'object' ? Object.keys(tableRows[0]) : []);

                const renderCell = (val) => {
                    if (val === null || val === undefined) return '';
                    if (typeof val === 'object') return JSON.stringify(val);
                    return String(val);
                };

                return (
                    <TableContainer component={Paper} sx={{ maxHeight: 400 }}>
                        <Table stickyHeader size="small">
                            <TableHead>
                                <TableRow>
                                    {tableColumns.map((column, index) => (
                                        <TableCell
                                            key={index}
                                            sx={{
                                                backgroundColor: '#f5f5f5',
                                                fontWeight: 600,
                                                fontSize: 12,
                                                minWidth: 150
                                            }}
                                        >
                                            {column}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {tableRows.map((row, rowIndex) => (
                                    <TableRow key={rowIndex}>
                                        {tableColumns.map((column, colIndex) => (
                                            <TableCell
                                                key={colIndex}
                                                sx={{ fontSize: 11 }}
                                            >
                                                {renderCell(row[column])}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                );

            case 'box':
                // Box visualization data structure from workflow-analysis endpoint
                const boxData = visualizationData.data || {};
                const rawCurrentValue = visualizationData.currentValue || boxData.total_current;
                const rawPreviousValue = visualizationData.previousValue || boxData.total_past;

                // Round to 2 decimal places
                const currentValue = typeof rawCurrentValue === 'number'
                    ? Math.round(rawCurrentValue * 100) / 100
                    : rawCurrentValue;
                const previousValue = typeof rawPreviousValue === 'number'
                    ? Math.round(rawPreviousValue * 100) / 100
                    : rawPreviousValue;

                // Calculate change if not provided
                const calculatedChange = (currentValue && previousValue) ?
                    Math.round((currentValue - previousValue) / previousValue * 100) / 100 : 0;

                return (
                    <div style={{ height: 'auto', padding: '0' }}>
                        <Boxdataset
                            boxClickFunction={boxClickFunction || (() => {})}
                            classnameval={`box-container ${!previousValue && 'pb-70'}`}
                            exportInd={false}
                            starredval={true}
                            margin={154}
                            unsetarrangement={() => {}}
                            setarrangement={() => {}}
                            zoom={0}
                            arrangement={1}
                            arrangestar={true}
                            type={!isLoading}
                            top_text={visualizationData.title || 'Metric'}
                            mid_text={visualizationData.title || 'Metric'}
                            total_diff={calculatedChange}
                            total_current={currentValue}
                            total_past={previousValue}
                            description={visualizationData.description || `Current vs previous ${visualizationData.title || 'metric'}`}
                            filters={{}}
                        />
                    </div>
                );

            case 'scatter': {
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                const scatterData = {
                    datasets: [
                        {
                            label: visualizationData.title || 'Points',
                            data: (visualizationData.data || []).map(item => ({
                                x: Number(item.x),
                                y: Number(item.y),
                            })),
                            backgroundColor: COLORS[2],
                        },
                    ],
                };
                const scatterOptions = {
                    ...chartOptions,
                    scales: {
                        x: { type: 'linear', position: 'bottom', ticks: { font: { size: 11 } } },
                        y: { beginAtZero: true, ticks: { font: { size: 11 } } },
                    },
                };
                return (
                    <div style={{ height: chartHeight }}>
                        <Scatter data={scatterData} options={scatterOptions} />
                    </div>
                );
            }

            case 'kpi': {
                // One or more headline numbers: each datum is { x: label, y: value }.
                const kpis = Array.isArray(visualizationData.data) ? visualizationData.data : [];
                if (kpis.length === 0) return null;
                return (
                    <div style={{
                        display: 'flex', flexWrap: 'wrap', gap: 16,
                        alignItems: 'stretch', justifyContent: 'flex-start',
                    }}>
                        {kpis.map((item, idx) => (
                            <div key={idx} style={{
                                flex: '1 1 120px', minWidth: 120,
                                padding: '14px 16px', borderRadius: 10,
                                background: '#ffffff', border: '1px solid #e9ecef',
                            }}>
                                <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>
                                    {typeof item.y === 'number' ? item.y.toLocaleString() : String(item.y ?? '')}
                                </div>
                                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                                    {String(item.x ?? '')}
                                </div>
                            </div>
                        ))}
                    </div>
                );
            }

            default:
                return null;
        }
    };

    return (
        <Box
            sx={{
                mt: bare ? 0 : 2,
                height: '90%',
                p: showContainer ? 2 : 0, // Show container styling only in chat
                backgroundColor: showContainer ? '#f8f9fa' : 'transparent',
                borderRadius: showContainer ? '12px' : 0,
                border: showContainer ? '1px solid #e9ecef' : 'none',
                position: 'relative'
            }}
        >
            {/* 3-dots menu in top right - only show in ChatBot context */}
            {showMenu && (
                <>
                    <IconButton
                        onClick={handleMenuClick}
                        sx={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            color: '#6b7280',
                            '&:hover': {
                                backgroundColor: '#f3f4f6'
                            }
                        }}
                        size="small"
                    >
                        <MoreVertIcon fontSize="small" />
                    </IconButton>

                    <Menu
                        anchorEl={anchorEl}
                        open={open}
                        onClose={handleMenuClose}
                        anchorOrigin={{
                            vertical: 'bottom',
                            horizontal: 'right',
                        }}
                        transformOrigin={{
                            vertical: 'top',
                            horizontal: 'right',
                        }}
                    >
                        <MenuItem onClick={handleSaveToMain}>
                            Save to main page
                        </MenuItem>
                    </Menu>
                </>
            )}

            {/* Title - hide for box type since Boxdataset has its own title */}
            {showTitle && (
                <Typography
                    variant="h6"
                    sx={{
                        mb: 2,
                        fontSize: 16,
                        fontWeight: 600,
                        color: '#2d3748',
                        textAlign: 'center',
                        pr: showMenu ? 4 : 0 // Add padding only if menu is shown
                    }}
                >
                    {visualizationData.title}
                </Typography>
            )}
            
            {renderChart()}
        </Box>
    );
};

export default DataVisualization;