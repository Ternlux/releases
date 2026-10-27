import React, { useState } from 'react';
import { Form, Input, InputNumber, Switch, Select, Button, Space, Alert, Row, Col } from 'antd';
import { DatabaseOutlined, ApiOutlined } from '@ant-design/icons';

const { Option } = Select;

const ENGINE_OPTIONS = [
  { value: 'sqlite',     label: 'SQLite' },
  { value: 'oracle',     label: 'Oracle' },
  { value: 'db2',        label: 'IBM Db2' },
  // Redshift disabled for now — see connectorCatalog.js.
  // { value: 'redshift',   label: 'Amazon Redshift' },
  { value: 'bigquery',   label: 'Google BigQuery' },
  { value: 'snowflake',  label: 'Snowflake' },
  { value: 'cockroach',  label: 'CockroachDB' },
  { value: 'mariadb',    label: 'MariaDB' },
  { value: 'other',      label: 'Other' },
];

const GenericSQLConnectionForm = ({ onSave, onCancel, onTest, editingConnection }) => {
  const [form] = Form.useForm();
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving]         = useState(false);

  const initialValues = editingConnection?.dbConfig
    ? { name: editingConnection.name, description: editingConnection.description, ...editingConnection.dbConfig }
    : { port: 5432, ssl: false, engine: 'other' };

  const handleTest = async () => {
    try {
      await form.validateFields(['engine', 'host', 'port', 'database', 'username']);
      setTesting(true);
      setTestResult(null);
      const v = form.getFieldsValue();
      const result = await onTest('generic', {
        engine: v.engine, host: v.host, port: v.port,
        database: v.database, username: v.username, password: v.password, ssl: v.ssl,
      });
      setTestResult(result);
    } catch (_) {
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const v = await form.validateFields();
      setSaving(true);
      await onSave({
        name: v.name,
        description: v.description || '',
        connectionType: 'database',
        dbType: 'generic',
        dbConfig: {
          engine: v.engine, host: v.host, port: v.port,
          database: v.database, username: v.username, password: v.password,
          ssl: v.ssl || false,
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
            <Input placeholder="My Database" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="description" label="Description">
        <Input.TextArea rows={2} placeholder="Optional description" />
      </Form.Item>

      <Form.Item name="engine" label="Database Engine" rules={[{ required: true, message: 'Select a database engine' }]}>
        <Select placeholder="Select engine">
          {ENGINE_OPTIONS.map(e => <Option key={e.value} value={e.value}>{e.label}</Option>)}
        </Select>
      </Form.Item>

      <Row gutter={16}>
        <Col span={17}>
          <Form.Item name="host" label="Host" rules={[{ required: true, message: 'Host is required' }]}>
            <Input placeholder="localhost" />
          </Form.Item>
        </Col>
        <Col span={7}>
          <Form.Item name="port" label="Port" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="database" label="Database Name" rules={[{ required: true, message: 'Database name is required' }]}>
        <Input placeholder="my_database" />
      </Form.Item>

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }]}>
            <Input placeholder="admin" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="password" label="Password">
            <Input.Password placeholder="Password" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="ssl" label="Use SSL" valuePropName="checked">
        <Switch />
      </Form.Item>

      {testResult && (
        <Alert type={testResult.success ? 'success' : 'error'} message={testResult.message} showIcon style={{ marginBottom: 16 }} />
      )}

      <Space>
        <Button icon={<ApiOutlined />} onClick={handleTest} loading={testing}>Test Connection</Button>
        <Button
          type="primary"
          icon={<DatabaseOutlined />}
          onClick={handleSave}
          loading={saving}
          disabled={!testResult?.success}
          title={!testResult?.success ? 'Please test the connection first' : ''}
        >
          Save Connection
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Space>
    </Form>
  );
};

export default GenericSQLConnectionForm;
