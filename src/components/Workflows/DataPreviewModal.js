import React, { useState, useEffect } from 'react';
import { Modal, Typography, Tag, Select, Space, Spin, message, Button } from 'antd';
import { DataGrid } from '@mui/x-data-grid';
import { FileExcelOutlined, DatabaseOutlined, DownloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { fullscreenModalProps } from './_designShared';

const { Title, Text } = Typography;

const DataPreviewModal = ({ open, data, onClose }) => {
  const [selectedSource, setSelectedSource] = useState(null);
  const [sourceData, setSourceData] = useState(null);
  const [loading, setLoading] = useState(false);

  // Extract connection data safely
  const connection = data?.connection;
  const isPOSConnection = connection?.connectionType === 'api';
  const availableSources = connection?.availableSources || [];

  // Initialize selected source for POS connections
  useEffect(() => {
    if (isPOSConnection && availableSources.length > 0 && !selectedSource) {
      setSelectedSource(availableSources[0].identifier);
    }
  }, [isPOSConnection, availableSources, selectedSource]);

  // Fetch preview data for selected POS source
  const fetchSourcePreview = async (sourceId) => {
    if (!sourceId || !isPOSConnection) return;

    setLoading(true);
    try {
      const response = await axios.post('/workflow/pos-source-preview', {
        connectionId: connection.id,
        sourceIdentifier: sourceId,
        limit: 50
      }, {
        headers: {
          'auth-token': localStorage.getItem('auth-token')
        }
      });

      if (response.data.success) {
        setSourceData(response.data.data);
      } else {
        message.error('Failed to fetch preview data');
      }
    } catch (error) {
      console.error('Error fetching source preview:', error);
      message.error('Failed to fetch preview data');
    } finally {
      setLoading(false);
    }
  };

  // Handle source selection
  const handleSourceChange = (sourceId) => {
    setSelectedSource(sourceId);
    fetchSourcePreview(sourceId);
  };

  // Fetch initial source data for POS connections
  useEffect(() => {
    if (selectedSource && isPOSConnection) {
      fetchSourcePreview(selectedSource);
    }
  }, [selectedSource]);

  // Early return after all hooks
  if (!data) return null;

  // Prepare data for display
  let displayData = data;
  if (isPOSConnection && sourceData) {
    displayData = {
      ...data,
      data: sourceData.rows || [],
      columns: sourceData.headers || []
    };
  }

  // Convert data to DataGrid format
  const columns = displayData.columns.map((column, index) => ({
    field: column,
    headerName: column.charAt(0).toUpperCase() + column.slice(1),
    width: 150,
    sortable: true,
    filterable: true
  }));

  const rows = displayData.data.map((row, index) => ({
    id: index,
    ...row
  }));

  // Export data to CSV
  const handleExportCSV = () => {
    try {
      // Create CSV header
      const csvHeaders = displayData.columns.join(',');

      // Create CSV rows
      const csvRows = displayData.data.map(row => {
        return displayData.columns.map(column => {
          const value = row[column];
          // Handle values that contain commas, quotes, or newlines
          if (value === null || value === undefined) return '';
          const stringValue = String(value);
          if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
            return `"${stringValue.replace(/"/g, '""')}"`;
          }
          return stringValue;
        }).join(',');
      });

      // Combine headers and rows
      const csvContent = [csvHeaders, ...csvRows].join('\n');

      // Create blob and download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const sourceName = isPOSConnection
        ? selectedSource || 'data'
        : connection?.name || 'data';
      const filename = `${sourceName}_export_${timestamp}.csv`;

      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      message.success('CSV exported successfully!');
    } catch (error) {
      console.error('Error exporting CSV:', error);
      message.error('Failed to export CSV');
    }
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isPOSConnection ? (
              <DatabaseOutlined style={{ color: '#1890ff' }} />
            ) : (
              <FileExcelOutlined style={{ color: '#52c41a' }} />
            )}
            <span>Data Preview - {connection?.name}</span>
          </div>
          {/* <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={handleExportCSV}
            disabled={loading || displayData.data.length === 0}
          >
            Export CSV
          </Button> */}
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      {...fullscreenModalProps({ bodyPadding: 20 })}
    >
      <div style={{ marginBottom: '16px' }}>
        {/* Source Selector for POS Connections */}
        {isPOSConnection && availableSources.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <Space>
              <Text strong>Data Source:</Text>
              <Select
                value={selectedSource}
                onChange={handleSourceChange}
                style={{ minWidth: 200 }}
                loading={loading}
              >
                {availableSources.map(source => (
                  <Select.Option key={source.identifier} value={source.identifier}>
                    <Space>
                      <DatabaseOutlined />
                      {source.name}
                      <Tag size="small" color="blue">{source.rowCount || 0} rows</Tag>
                    </Space>
                  </Select.Option>
                ))}
              </Select>
            </Space>
          </div>
        )}

        <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <Tag color="blue">
            Type: {isPOSConnection ? connection?.apiType?.toUpperCase() : connection?.fileType?.toUpperCase()}
          </Tag>
          <Tag color="green">
            Sample Rows: {loading ? 'Loading...' : displayData.data.length}
          </Tag>
          <Tag color="orange">
            Columns: {loading ? 'Loading...' : displayData.columns.length}
          </Tag>
          {isPOSConnection && selectedSource && (
            <Tag color="purple">
              Source: {availableSources.find(s => s.identifier === selectedSource)?.name || selectedSource}
            </Tag>
          )}
          {isPOSConnection && sourceData?.totalRows && (
            <Tag color="cyan">
              Total Rows: {sourceData.totalRows.toLocaleString()}
            </Tag>
          )}
          {!isPOSConnection && data.metadata?.totalRowsInFile && (
            <Tag color="purple">
              Total File Rows: {data.metadata.totalRowsInFile.toLocaleString()}
            </Tag>
          )}
          {!isPOSConnection && data.metadata?.sheetName && (
            <Tag color="cyan">
              Sheet: {data.metadata.sheetName}
            </Tag>
          )}
          {!isPOSConnection && data.metadata?.fileName && (
            <Tag color="volcano">
              File: {data.metadata.fileName}
            </Tag>
          )}
        </div>
        <div style={{ marginBottom: '8px' }}>
          <Text type="secondary">
            {connection?.description}
          </Text>
        </div>
        {(data.metadata || sourceData) && (
          <div style={{ fontSize: '12px', color: '#666' }}>
            {!isPOSConnection && data.metadata?.totalSampleRows && (
              <span style={{ marginRight: '16px' }}>
                Showing {data.metadata.returnedRows} of {data.metadata.totalSampleRows} sample rows
              </span>
            )}
            {isPOSConnection && sourceData && (
              <span style={{ marginRight: '16px' }}>
                Showing {sourceData.rows?.length || 0} sample rows from {selectedSource}
              </span>
            )}
            {(!isPOSConnection && data.metadata?.extractedAt) && (
              <span>
                Sample extracted: {new Date(data.metadata.extractedAt).toLocaleString()}
              </span>
            )}
            {isPOSConnection && sourceData?.extractedAt && (
              <span>
                Data extracted: {new Date(sourceData.extractedAt).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      <div style={{ height: 'calc(100% - 80px)', width: '100%' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px' }}>
            <Spin size="large" />
          </div>
        ) : (
          <DataGrid
            rows={rows}
            columns={columns}
            pageSizeOptions={[10, 25, 50, 100]}
            initialState={{
              pagination: {
                paginationModel: { pageSize: 25 },
              },
            }}
            checkboxSelection={false}
            disableRowSelectionOnClick
            density="compact"
            sx={{
              '& .MuiDataGrid-cell': {
                borderRight: '1px solid #f0f0f0',
              },
              '& .MuiDataGrid-columnHeader': {
                backgroundColor: '#fafafa',
                borderRight: '1px solid #f0f0f0',
                fontWeight: 600,
              },
              '& .MuiDataGrid-row:hover': {
                backgroundColor: '#f5f5f5',
              }
            }}
          />
        )}
      </div>
    </Modal>
  );
};

export default DataPreviewModal;