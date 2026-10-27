import React, { useState } from 'react';
import { Typography, Card, Space, Input, Button, Tabs, Table, Select } from 'antd';
import { FileExcelOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Text, Title } = Typography;

const SchemaMapping = ({
  // Props
  editingSchema,
  uploading,
  loadingSchema,
  setLoadingSchema,
  fileSchema,
  setFileSchema,
  uploadedFile,
  skipRows,
  
  // Handlers
  handleCancel,
  handleCreateConnection,
  setCurrentStep
}) => {
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [loadingSheetSchema, setLoadingSheetSchema] = useState(false);
  
  const handleRefreshSchema = async (sheetName = null) => {
    setLoadingSchema(true);
    try {
      const requestBody = {
        fileInfo: uploadedFile,
        skipRows: skipRows
      };
      
      // If sheetName is provided, include it in the request
      if (sheetName) {
        requestBody.sheetName = sheetName;
      }
      
      const response = await axios.post('/workflow/extract-schema', requestBody, {
        headers: {
          'auth-token': localStorage.getItem('auth-token')
        }
      });
      if (response.data.success) {
        setFileSchema(response.data.data);
        // Use message from parent's scope
        if (window.antd && window.antd.message) {
          window.antd.message.success('Schema refreshed from file');
        }
      }
    } catch (error) {
      if (window.antd && window.antd.message) {
        window.antd.message.error('Failed to refresh schema');
      }
    } finally {
      setLoadingSchema(false);
    }
  };
  
  const handleSheetChange = async (sheetIndex) => {
    const sheetIndexNum = parseInt(sheetIndex);
    setActiveSheetIndex(sheetIndexNum);
    
    if (fileSchema.sheets && fileSchema.sheets[sheetIndexNum]) {
      const selectedSheet = fileSchema.sheets[sheetIndexNum];
      setLoadingSheetSchema(true);
      
      try {
        // Check if we have schema for this sheet already
        if (fileSchema.allSheetSchemas && fileSchema.allSheetSchemas[selectedSheet.name]) {
          // Use existing schema from allSheetSchemas
          const sheetSchema = fileSchema.allSheetSchemas[selectedSheet.name];
          setFileSchema({
            ...fileSchema,
            columns: sheetSchema.columns,
            totalRows: sheetSchema.totalRows,
            activeSheet: selectedSheet.name
          });
          
          if (window.antd && window.antd.message) {
            window.antd.message.success(`Switched to sheet: ${selectedSheet.name}`);
          }
        } else {
          // Extract schema for the selected sheet from server
          await handleRefreshSchema(selectedSheet.name);
          
          if (window.antd && window.antd.message) {
            window.antd.message.success(`Switched to sheet: ${selectedSheet.name}`);
          }
        }
      } catch (error) {
        if (window.antd && window.antd.message) {
          window.antd.message.error('Failed to load sheet schema');
        }
      } finally {
        setLoadingSheetSchema(false);
      }
    }
  };

  if (loadingSchema) {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 8 }} />
          <Title level={4}>Configure Data Schema</Title>
          <Text type="secondary">
            Map columns and configure data types for your data source
          </Text>
        </div>
        
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div style={{ marginBottom: 16 }}>
            <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff' }} />
          </div>
          <div style={{ fontSize: '16px', marginBottom: '8px' }}>Loading Schema...</div>
          <Text type="secondary">Extracting current schema from file</Text>
        </div>
      </Space>
    );
  }

  if (!fileSchema) {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 8 }} />
          <Title level={4}>Configure Data Schema</Title>
          <Text type="secondary">
            Map columns and configure data types for your data source
          </Text>
        </div>
        
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div style={{ marginBottom: 16 }}>
            <FileExcelOutlined style={{ fontSize: 48, color: '#ccc' }} />
          </div>
          <div style={{ fontSize: '16px', marginBottom: '8px', color: '#666' }}>No Schema Available</div>
          <Text type="secondary">
            {editingSchema 
              ? 'Unable to load schema from file. Please try the "Refresh from File" button.'
              : 'Please go back and upload a file first.'}
          </Text>
        </div>
      </Space>
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 8 }} />
        <Title level={4}>Configure Data Schema</Title>
        <Text type="secondary">
          Map columns and configure data types for your data source
        </Text>
      </div>

      {/* File Tabs */}
      {fileSchema.sheets && fileSchema.sheets.length > 1 && (
        <Card title="File Sheets" size="small" style={{ marginBottom: 16 }}>
          <Tabs 
            activeKey={activeSheetIndex.toString()} 
            onChange={handleSheetChange}
            disabled={loadingSheetSchema}
          >
            {fileSchema.sheets.map((sheet, index) => (
              <Tabs.TabPane 
                tab={
                  <span>
                    {sheet.name}
                    {loadingSheetSchema && index === activeSheetIndex && (
                      <span style={{ marginLeft: 8 }}>⏳</span>
                    )}
                  </span>
                } 
                key={index}
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text type="secondary">
                    {sheet.rowCount} rows • {sheet.columnCount} columns
                  </Text>
                  {index === activeSheetIndex && fileSchema.activeSheet && (
                    <Text type="success" style={{ fontSize: '12px' }}>
                      ✓ Schema loaded from: {fileSchema.activeSheet}
                    </Text>
                  )}
                </Space>
              </Tabs.TabPane>
            ))}
          </Tabs>
        </Card>
      )}

      {/* Schema Mapping Table */}
      <Card 
        title="Column Mapping" 
        style={{ marginBottom: 16 }}
        extra={editingSchema && (
          <Button 
            size="small" 
            onClick={() => {
              const activeSheet = fileSchema.sheets && fileSchema.sheets[activeSheetIndex];
              handleRefreshSchema(activeSheet ? activeSheet.name : null);
            }}
            loading={loadingSchema || loadingSheetSchema}
          >
            Refresh from File
          </Button>
        )}
      >
        <Table
          dataSource={fileSchema.columns}
          pagination={false}
          size="small"
          loading={loadingSheetSchema}
          columns={[
            {
              title: 'Position',
              dataIndex: 'position',
              key: 'position',
              width: 70,
              render: (position) => <Text code>{position}</Text>
            },
            {
              title: 'Column Name',
              dataIndex: 'name',
              key: 'name',
              width: 180,
              render: (name, record) => (
                <Input
                  value={name}
                  onChange={(e) => {
                    const newColumns = [...fileSchema.columns];
                    newColumns[record.index] = { ...record, name: e.target.value };
                    setFileSchema({ ...fileSchema, columns: newColumns });
                  }}
                  placeholder="Enter column name"
                />
              )
            },
            {
              title: 'Data Type',
              dataIndex: 'dataType',
              key: 'dataType',
              width: 150,
              render: (dataType, record) => (
                <Select
                  value={dataType}
                  onChange={(value) => {
                    const newColumns = [...fileSchema.columns];
                    newColumns[record.index] = { ...record, dataType: value };
                    setFileSchema({ ...fileSchema, columns: newColumns });
                  }}
                  style={{ width: '100%' }}
                >
                  <Select.Option value="Text">Text</Select.Option>
                  <Select.Option value="Number">Number</Select.Option>
                  <Select.Option value="Currency">Currency</Select.Option>
                  <Select.Option value="Date">Date</Select.Option>
                  <Select.Option value="Percentage">Percentage</Select.Option>
                  <Select.Option value="Boolean">Boolean</Select.Option>
                </Select>
              )
            },
            {
              title: 'Sample Values',
              dataIndex: 'sampleValues',
              key: 'sampleValues',
              width: 200,
              render: (sampleValues) => (
                <div style={{ fontSize: '12px', color: '#666' }}>
                  {sampleValues && sampleValues.length > 0 ? (
                    sampleValues.slice(0, 3).map((value, idx) => (
                      <div key={idx} style={{ 
                        overflow: 'hidden', 
                        textOverflow: 'ellipsis', 
                        whiteSpace: 'nowrap',
                        maxWidth: '180px'
                      }}>
                        {String(value)}
                      </div>
                    ))
                  ) : (
                    <Text type="secondary">No data</Text>
                  )}
                </div>
              )
            }
          ]}
          scroll={{ y: 400 }}
        />
      </Card>

      <div style={{ textAlign: 'right' }}>
        <Space>
          {!editingSchema && (
            <Button 
              icon={<ArrowLeftOutlined />} 
              onClick={() => setCurrentStep(1)}
            >
              Back
            </Button>
          )}
          <Button onClick={handleCancel}>
            Cancel
          </Button>
          <Button 
            type="primary" 
            onClick={handleCreateConnection}
            disabled={uploading}
            loading={uploading}
          >
            {editingSchema ? 'Update Schema' : 'Create Data Source'}
          </Button>
        </Space>
      </div>
    </Space>
  );
};

export default SchemaMapping;