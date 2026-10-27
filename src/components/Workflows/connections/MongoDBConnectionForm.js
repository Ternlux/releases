import React, { useState } from 'react';
import { Form, Input, InputNumber, Button, Space, Alert, Row, Col, Tabs } from 'antd';
import { DatabaseOutlined, ApiOutlined } from '@ant-design/icons';

const { TabPane } = Tabs;

const MongoDBConnectionForm = ({ onSave, onCancel, onTest, editingConnection }) => {
  const [form] = Form.useForm();
  const [mode, setMode]             = useState('uri');   // 'uri' | 'fields'
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving]         = useState(false);

  const initialFields = editingConnection?.dbConfig
    ? { name: editingConnection.name, description: editingConnection.description, ...editingConnection.dbConfig }
    : { port: 27017 };

  const handleTest = async () => {
    try {
      setTesting(true);
      setTestResult(null);
      // console.log('mode: ', mode, form.getFieldsValue())
      let uri;
      if (mode === 'uri') {
        await form.validateFields(['name', 'uri']);
        const v = form.getFieldsValue();
        uri = v.uri;
      } else {
        await form.validateFields(['name', 'host', 'port', 'database']);
        const v = form.getFieldsValue();
        const auth = v.username
          ? `${encodeURIComponent(v.username)}:${encodeURIComponent(v.password || '')}@`
          : '';
        uri = `mongodb://${auth}${v.host}:${v.port}/${v.database}`;
      }
    
      const result = await onTest('mongodb', { uri });
      setTestResult(result);
    } catch (_) {
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);

      let uri;
      if (mode === 'uri') {
        await form.validateFields(['name', 'uri']);
        const v = form.getFieldsValue();
        uri = v.uri;
      } else {
        const v = await form.validateFields(['name', 'host', 'port', 'database']);
        const all = form.getFieldsValue();
        const auth = all.username
          ? `${encodeURIComponent(all.username)}:${encodeURIComponent(all.password || '')}@`
          : '';
        uri = `mongodb://${auth}${all.host}:${all.port}/${all.database}`;
      }

      const all = form.getFieldsValue();
      await onSave({
        name: all.name,
        description: all.description || '',
        connectionType: 'database',
        dbType: 'mongodb',
        dbConfig: { uri },
      });
    } catch (_) {
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form form={form} layout="vertical" initialValues={initialFields}>
      <Row gutter={16}>
        <Col span={16}>
          <Form.Item name="name" label="Connection Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="My MongoDB Database" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="description" label="Description">
        <Input.TextArea rows={2} placeholder="Optional description" />
      </Form.Item>

      <Tabs activeKey={mode} onChange={(k) => { setMode(k); setTestResult(null); }} style={{ marginBottom: 16 }}>
        <TabPane tab="Connection String" key="uri">
          <Form.Item
            name="uri"
            label="MongoDB URI"
            rules={mode === 'uri' ? [{ required: true, message: 'Connection string is required' }] : []}
            help="e.g. mongodb://user:pass@host:27017/dbname  or  mongodb+srv://… for Atlas"
          >
            <Input.Password
              placeholder="mongodb://username:password@host:27017/database"
              visibilityToggle
            />
          </Form.Item>
        </TabPane>

        <TabPane tab="Manual Fields" key="fields">
          <Row gutter={16}>
            <Col span={17}>
              <Form.Item name="host" label="Host" rules={mode === 'fields' ? [{ required: true }] : []}>
                <Input placeholder="localhost" />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="port" label="Port" rules={mode === 'fields' ? [{ required: true }] : []}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="database" label="Database Name" rules={mode === 'fields' ? [{ required: true }] : []}>
            <Input placeholder="my_database" />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="username" label="Username">
                <Input placeholder="admin" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="password" label="Password">
                <Input.Password placeholder="Password" />
              </Form.Item>
            </Col>
          </Row>
        </TabPane>
      </Tabs>

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

export default MongoDBConnectionForm;
