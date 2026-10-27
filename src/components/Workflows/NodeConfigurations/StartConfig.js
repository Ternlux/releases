import React, { useEffect } from 'react';
import { Form, Input, Select, Button, Space, Typography, Divider, TimePicker, InputNumber, message } from 'antd';
import { PlayCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';

const { Option } = Select;
const { Title, Text } = Typography;

const StartConfig = ({ 
  node, 
  onConfigUpdate,
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
      
      console.log('DEBUG - Saving Start configuration:', values);
      onConfigUpdate(node.id, values);
      message.success('Start configuration saved');
      
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
        name="triggerType"
        label={
          <Space>
            <PlayCircleOutlined />
            <span>Trigger Type</span>
          </Space>
        }
        rules={[{ required: true, message: 'Please select a trigger type' }]}
      >
        <Select placeholder="Select trigger type">
          <Option value="manual">Manual Execution</Option>
          <Option value="schedule">Schedule-based</Option>
          <Option value="webhook">Webhook/API</Option>
        </Select>
      </Form.Item>

      <Form.Item dependencies={['triggerType']} noStyle>
        {({ getFieldValue }) => {
          const triggerType = getFieldValue('triggerType');
          
          if (triggerType === 'schedule') {
            return (
              <>
                <Divider />
                <Title level={5} style={{ marginBottom: '16px' }}>
                  <ClockCircleOutlined style={{ marginRight: '8px' }} />
                  Schedule Configuration
                </Title>
                
                <Form.Item
                  name="scheduleType"
                  label="Schedule Type"
                  rules={[{ required: true, message: 'Please select schedule type' }]}
                >
                  <Select placeholder="Select schedule type">
                    <Option value="interval">Interval (15 minute increments)</Option>
                    <Option value="daily">Daily at specific time</Option>
                    <Option value="weekly">Weekly</Option>
                    <Option value="monthly">Monthly</Option>
                  </Select>
                </Form.Item>

                <Form.Item dependencies={['scheduleType']} noStyle>
                  {({ getFieldValue: getScheduleField }) => {
                    const scheduleType = getScheduleField('scheduleType');
                    
                    switch (scheduleType) {
                      case 'interval':
                        return (
                          <Form.Item
                            name="intervalMinutes"
                            label="Run Every (15-minute increments)"
                            rules={[{ required: true, message: 'Please select interval' }]}
                          >
                            <Select placeholder="Select interval">
                              <Option value={15}>15 minutes</Option>
                              <Option value={30}>30 minutes</Option>
                              <Option value={45}>45 minutes</Option>
                              <Option value={60}>1 hour</Option>
                              <Option value={120}>2 hours</Option>
                              <Option value={180}>3 hours</Option>
                              <Option value={240}>4 hours</Option>
                              <Option value={360}>6 hours</Option>
                              <Option value={720}>12 hours</Option>
                              <Option value={1440}>24 hours</Option>
                            </Select>
                          </Form.Item>
                        );
                      
                      case 'daily':
                        return (
                          <Form.Item
                            name="dailyTime"
                            label="Time"
                            rules={[{ required: true, message: 'Please select time' }]}
                          >
                            <TimePicker format="HH:mm" style={{ width: '100%' }} />
                          </Form.Item>
                        );
                      
                      case 'weekly':
                        return (
                          <>
                            <Form.Item
                              name="weeklyDays"
                              label="Days of Week"
                              rules={[{ required: true, message: 'Please select days' }]}
                            >
                              <Select mode="multiple" placeholder="Select days">
                                <Option value="0">Sunday</Option>
                                <Option value="1">Monday</Option>
                                <Option value="2">Tuesday</Option>
                                <Option value="3">Wednesday</Option>
                                <Option value="4">Thursday</Option>
                                <Option value="5">Friday</Option>
                                <Option value="6">Saturday</Option>
                              </Select>
                            </Form.Item>
                            <Form.Item
                              name="weeklyTime"
                              label="Time"
                              rules={[{ required: true, message: 'Please select time' }]}
                            >
                              <TimePicker format="HH:mm" style={{ width: '100%' }} />
                            </Form.Item>
                          </>
                        );
                      
                      case 'monthly':
                        return (
                          <>
                            <Form.Item
                              name="monthlyDay"
                              label="Day of Month"
                              rules={[{ required: true, message: 'Please enter day' }]}
                            >
                              <InputNumber min={1} max={31} placeholder="1" style={{ width: '100%' }} />
                            </Form.Item>
                            <Form.Item
                              name="monthlyTime"
                              label="Time"
                              rules={[{ required: true, message: 'Please select time' }]}
                            >
                              <TimePicker format="HH:mm" style={{ width: '100%' }} />
                            </Form.Item>
                          </>
                        );
                      
                      default:
                        return null;
                    }
                  }}
                </Form.Item>
              </>
            );
          } else if (triggerType === 'webhook') {
            return (
              <>
                <Divider />
                <Title level={5} style={{ marginBottom: '16px' }}>
                  Webhook Configuration
                </Title>
                
                <Form.Item
                  name="apiToken"
                  label="API Token"
                  rules={[{ required: true, message: 'Please enter an API token' }]}
                  help="This token will be required in the Authorization header when calling the webhook"
                >
                  <Input.Password placeholder="Enter your API token" />
                </Form.Item>
                
                <Form.Item label="Webhook Endpoint">
                  <Input.TextArea 
                    value={`POST ${window.location.origin}/api/webhooks/trigger/${node?.id || 'workflow-id'}`}
                    readOnly
                    rows={2}
                    style={{ backgroundColor: '#f5f5f5', fontFamily: 'monospace', fontSize: '12px' }}
                  />
                  <Text type="secondary" style={{ display: 'block', marginTop: '8px', fontSize: '12px' }}>
                    Include your API token in the Authorization header: Bearer {'{your-api-token}'}
                  </Text>
                </Form.Item>
              </>
            );
          }
          
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

export default StartConfig;