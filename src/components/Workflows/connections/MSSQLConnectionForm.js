import React, { useState, useEffect } from 'react';
import { Form, Input, InputNumber, Switch, Button, Space, Alert, Row, Col, Select } from 'antd';
import { DatabaseOutlined, ApiOutlined } from '@ant-design/icons';

const MSSQLConnectionForm = ({ onSave, onCancel, onTest, editingConnection }) => {
  const [form] = Form.useForm();
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving]         = useState(false);
  const [schemas, setSchemas] = useState([]);
  const [selectedSchema, setSelectedSchema] = useState(null);
  const [connectionTested, setConnectionTested] = useState(false);

  const initialValues = editingConnection?.dbConfig
    ? {
        name: editingConnection.name,
        description: editingConnection.description,
        ...editingConnection.dbConfig,
        schema: editingConnection.dbConfig.schema
      }
    : { port: 1433, ssl: false };

  // Set initial state when editing a connection
  useEffect(() => {
    if (editingConnection?.dbConfig?.schema) {
      setSelectedSchema(editingConnection.dbConfig.schema);
      setConnectionTested(true);
      setSchemas([editingConnection.dbConfig.schema]);
    }
  }, [editingConnection]);

  const handleTest = async () => {
    try {
      await form.validateFields(['host', 'port', 'database', 'username']);
      setTesting(true);
      setTestResult(null);
      setSchemas([]);
      setSelectedSchema(null);
      setConnectionTested(false);

      const v = form.getFieldsValue();
      const config = {
        host: v.host,
        port: v.port,
        database: v.database,
        username: v.username,
        password: v.password,
        instanceName: v.instanceName,
        ssl: v.ssl
      };

      const result = await onTest('mssql', config);
      setTestResult(result);

      if (result.success) {
        setConnectionTested(true);

        // Fetch schemas from the database
        if (window.electronAPI?.dbConnect) {
          try {
            const tablesResult = await window.electronAPI.dbConnect.getTables('mssql', config);
            if (tablesResult.success && tablesResult.tables) {
              // Extract unique schemas
              const uniqueSchemas = [...new Set(tablesResult.tables.map(t => t.schema))];
              setSchemas(uniqueSchemas.sort());
            }
          } catch (error) {
            console.error('Error fetching schemas:', error);
          }
        }
      }
    } catch (_) {
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const v = await form.validateFields();

      if (!selectedSchema) {
        return;
      }

      setSaving(true);
      await onSave({
        name: v.name,
        description: v.description || '',
        connectionType: 'database',
        dbType: 'mssql',
        dbConfig: {
          host: v.host,
          port: v.port,
          database: v.database,
          username: v.username,
          password: v.password,
          instanceName: v.instanceName || '',
          ssl: v.ssl || false,
          schema: selectedSchema
        },
      });
    } catch (_) {
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form form={form} layout="vertical" initialValues={initialValues}>
      <Row gutter={16}>
        <Col span={16}>
          <Form.Item name="name" label="Connection Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="My SQL Server Database" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="description" label="Description">
        <Input.TextArea rows={2} placeholder="Optional description" />
      </Form.Item>

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="host" label="Host" rules={[{ required: true, message: 'Host is required' }]}>
            <Input placeholder="localhost" />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item name="port" label="Port" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item name="instanceName" label="Instance Name">
            <Input placeholder="SQLEXPRESS" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="database" label="Database Name" rules={[{ required: true, message: 'Database name is required' }]}>
        <Input placeholder="master" />
      </Form.Item>

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }]}>
            <Input placeholder="sa" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="password" label="Password">
            <Input.Password placeholder="Password" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="ssl" label="Encrypt Connection (SSL)" valuePropName="checked">
        <Switch />
      </Form.Item>

      {testResult && (
        <Alert type={testResult.success ? 'success' : 'error'} message={testResult.message} showIcon style={{ marginBottom: 16 }} />
      )}

      {connectionTested && schemas.length > 0 && (
        <Form.Item label="Schema to Write Into" required>
          <Select
            placeholder="Select a schema"
            value={selectedSchema}
            onChange={setSelectedSchema}
            showSearch
          >
            {schemas.map(schema => (
              <Select.Option key={schema} value={schema}>
                {schema}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
      )}

      <Space>
        <Button icon={<ApiOutlined />} onClick={handleTest} loading={testing}>Test Connection</Button>
        <Button
          type="primary"
          icon={<DatabaseOutlined />}
          onClick={handleSave}
          loading={saving}
          disabled={!connectionTested || !selectedSchema}
        >
          Save Connection
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Space>
    </Form>
  );
};

export default MSSQLConnectionForm;
