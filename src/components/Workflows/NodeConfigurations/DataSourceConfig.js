import React, { useState, useEffect } from 'react';
import { Form, Input, Select, Button, Space, Divider, Typography, message } from 'antd';
import { DatabaseOutlined, EditOutlined } from '@ant-design/icons';

const { Option } = Select;
const { Text } = Typography;

const DataSourceConfig = ({ 
  node,
  onConfigUpdate,
  connections, 
  selectedConnection, 
  setSelectedConnection,
  availableSheets, 
  setAvailableSheets,
  availableSources, 
  setAvailableSources,
  loadingSheets, 
  setLoadingSheets,
  handleEditDataSource,
  fetchSheets,
  handleConnectionChange,
  onSave
}) => {
  const [form] = Form.useForm();

  // Initialize form when node changes
  useEffect(() => {
    if (node) {
      form.setFieldsValue(node.data.config || {});
    }
  }, [node, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      
      // Add connection name and source type to the configuration
      if (selectedConnection) {
        values.connectionName = selectedConnection.name;
        values.sourceType = selectedConnection.fileType || selectedConnection.apiType || selectedConnection.dbType;
        values.connectionType = selectedConnection.connectionType || 'file';

        // For database connections, store dbType for runtime query execution
        if (selectedConnection.connectionType === 'database') {
          values.dbType = selectedConnection.dbType;
          values.dbConfig = selectedConnection.config;
        }
        
        // For CSV files (which don't have multiple sheets/tables), set a default dataset
        if (selectedConnection.fileType === 'csv' && !values.table && !values.dataset) {
          values.dataset = selectedConnection.name; // Use connection name as default dataset
        }
        
        // For Excel files with only one sheet, auto-select it
        if (selectedConnection.fileType === 'excel' && availableSheets.length === 1 && !values.table) {
          values.table = availableSheets[0].sheetName;
        }
      }
      
      console.log('DEBUG - Saving DataSource configuration:', values);
      onConfigUpdate(node.id, values);
      message.success('Data Source configuration saved');
      
      if (onSave) {
        onSave();
      }
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };


  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={handleSave}
    >
      <Form.Item
        name="connectionId"
        label="Data Source Connection"
        rules={[{ required: true, message: 'Please select a data source connection' }]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select 
            placeholder="Select a data source connection"
            style={{ width: '100%' }}
            value={form.getFieldValue('connectionId')}
            onChange={(value) => {
              // Update form field first
              form.setFieldsValue({ connectionId: value });
              // console.log('setFieldsValue:', value);

              // Then handle connection change
              handleConnectionChange(value);
            }}
            optionLabelProp="label"
            dropdownRender={menu => (
              <div>
                {menu}
                <Divider style={{ margin: '8px 0' }} />
                <div style={{ padding: '8px', textAlign: 'center' }}>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Need to upload a new data source? Drop the file in the workflow or create a new connection.
                  </Text>
                </div>
              </div>
            )}
          >
            {connections.map(conn => {
              // Get selected table from node config if this connection is selected
              const isSelectedConn = conn.id === form.getFieldValue('connectionId');
              const selectedTable = isSelectedConn && node?.data?.config?.table;

              return (
                <Option key={conn.id} value={conn.id} label={conn.name}>
                  <div>
                    <Space>
                      <DatabaseOutlined />
                      <div>
                        <div style={{ fontWeight: '500' }}>{conn.name}</div>
                        <div style={{ fontSize: '12px', color: '#666' }}>
                          {selectedTable && <><strong>Table:</strong> {selectedTable} • </>}
                          {conn.fileType ? `${conn.fileType.toUpperCase()} file` : conn.apiType ? `${conn.apiType.toUpperCase()} connection` : conn.dbType ? `${conn.dbType.toUpperCase()} database` : ''} •
                          {conn.fileInfo?.fileSize ? ` ${(conn.fileInfo.fileSize / 1024 / 1024).toFixed(1)}MB` : ''} •
                          {conn.createdAt ? new Date(conn.createdAt).toLocaleDateString() : ''}
                        </div>
                      </div>
                    </Space>
                  </div>
                </Option>
              );
            })}
          </Select>
          
          <Form.Item dependencies={['connectionId']} noStyle>
            {({ getFieldValue }) => {
              const connectionId = getFieldValue('connectionId');
              const connection = connections.find(c => c.id === connectionId);
              // Only show edit button for file connections (not POS/API connections)
              const canEdit = connectionId && connection && (connection.fileType === 'csv' || connection.fileType === 'excel');
              
              return canEdit ? (
                <Button 
                  type="link" 
                  icon={<EditOutlined />} 
                  onClick={handleEditDataSource}
                  style={{ padding: 0, height: 'auto' }}
                >
                  Edit Data Source
                </Button>
              ) : null;
            }}
          </Form.Item>
        </Space>
      </Form.Item>

      <Divider />

      {/* Hidden field for sourceType */}
      <Form.Item name="sourceType" hidden>
        <Input />
      </Form.Item>

      {/* Conditional fields based on connection type */}
      <Form.Item dependencies={['connectionId']} noStyle>
        {({ getFieldValue }) => {
          const connectionId = getFieldValue('connectionId');
          
          // console.log('DEBUG - Form dependency render:', {
          //   connectionId,
          //   connections: connections.length,
          //   selectedConnection,
          //   formValues: form.getFieldsValue()
          // });
          
          if (!connectionId) {
            console.log('DEBUG - No connectionId selected');
            return null;
          }

          // console.log('DEBUG - Found connection:', {
          //   selectedConnection,
          //   fileType: selectedConnection?.fileType,
          //   apiType: selectedConnection?.apiType,
          //   availableSheets: availableSheets.length
          // });
          
          if (!selectedConnection) {
            console.log('DEBUG - No current connection found');
            return null;
          }
          // console.log('selectedConnection.fileType: ', selectedConnection.fileType)
          // For Excel files - show sheet selection dropdown
          if (selectedConnection.fileType === 'excel') {
            console.log('DEBUG - Rendering Excel sheet dropdown with sheets:', availableSheets);
            return (
              <Form.Item
                name="table"
                label="Sheet/Tab Name"
                rules={[{ required: true, message: 'Please select a sheet' }]}
                help="Select the Excel sheet you want to import data from"
              >
                <Select 
                  placeholder="Select a sheet"
                  loading={loadingSheets}
                  disabled={loadingSheets}
                >
                  {availableSheets.map(sheet => (
                    <Option key={sheet} value={sheet}>
                      {sheet}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            );
          }

          // For POS connections - show dataset selection
          if (selectedConnection.apiType === 'clover_pos' || selectedConnection.apiType === 'square_pos') {
            const datasets = availableSources.filter(s => s.type === 'dataset');
            console.log('DEBUG - Rendering POS dataset dropdown with datasets:', datasets);
            return (
              <Form.Item
                name="dataset"
                label="Dataset"
                rules={[{ required: true, message: 'Please select a dataset' }]}
                help="Select the type of data you want to import from your POS system"
              >
                <Select placeholder="Select a dataset">
                  {datasets.map(dataset => (
                    <Option key={dataset.identifier} value={dataset.identifier}>
                      {dataset.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            );
          }

          // For CSV files - no additional fields needed
          if (selectedConnection.fileType === 'csv') {
            console.log('DEBUG - CSV file selected, no additional dropdown needed');
            return null;
          }

          // For database connections — show selected table
          if (selectedConnection.connectionType === 'database') {
            const isMongo = selectedConnection.dbType === 'mongodb';
            const selectedTable = node?.data?.config?.table;
            const selectedTables = node?.data?.config?.selectedTables;

            return (
              <>
                {selectedTable && (
                  <Form.Item
                    label={isMongo ? 'Selected Collection' : 'Selected Table'}
                  >
                    <Input
                      value={selectedTable}
                      disabled
                      style={{
                        backgroundColor: '#f5f5f5',
                        color: '#000',
                        fontWeight: 500
                      }}
                      prefix={<DatabaseOutlined />}
                    />
                    {selectedTables && selectedTables.length > 0 && (
                      <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>
                        {selectedTables.length} {selectedTables.length === 1 ? 'table' : 'tables'} selected
                      </div>
                    )}
                  </Form.Item>
                )}
                {!selectedTable && (
                  <div style={{
                    padding: 16,
                    backgroundColor: '#f0f5ff',
                    border: '1px dashed #1890ff',
                    borderRadius: 4,
                    marginBottom: 16
                  }}>
                    <Text type="secondary">
                      No table selected. Use the chat interface to configure this data source and select a table.
                    </Text>
                  </div>
                )}
              </>
            );
          }

          console.log('DEBUG - No matching connection type, returning null');
          return null;
        }}
      </Form.Item>
      
      <Divider />
      
      <Form.Item style={{ marginBottom: 0 }}>
        <Button type="primary" htmlType="submit">
          Save Configuration
        </Button>
      </Form.Item>
    </Form>
  );
};

export default DataSourceConfig;