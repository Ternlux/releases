import React, { useEffect } from 'react';
import { Form, Input, Select, Button, Typography, Divider, Checkbox, message } from 'antd';

const { Option } = Select;
const { TextArea } = Input;

const OutputConfig = ({ 
  node,
  onConfigUpdate,
  handleSendTestEmail, 
  handleTestAnalysis,
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
      
      console.log('DEBUG - Saving Output configuration:', values);
      onConfigUpdate(node.id, values);
      message.success('Output configuration saved');
      
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
        name="outputType"
        label="Output Type"
        rules={[{ required: true, message: 'Please select output type' }]}
        initialValue="analysis"
      >
        <Select placeholder="Select output type">
          <Option value="analysis">AI Data Analysis</Option>
          <Option value="export">Data Export</Option>
          <Option value="both">Analysis + Export</Option>
        </Select>
      </Form.Item>

      <Divider />

      {/* AI Analysis Section */}
      <Form.Item dependencies={['outputType']} noStyle>
        {({ getFieldValue }) => {
          const outputType = getFieldValue('outputType');
          
          if (outputType === 'analysis' || outputType === 'both') {
            return (
              <>
                <Typography.Title level={5}>AI Data Analysis</Typography.Title>
                <Form.Item
                  name="analysisPrompt"
                  label="Analysis Prompt"
                  rules={[{ required: true, message: 'Please enter analysis prompt' }]}
                  help=""
                >
                  <TextArea 
                    rows={14} 
                    placeholder="e.g., Analyze the sales trends in this data and provide insights on seasonal patterns, top performing products, and recommendations for improving sales performance."
                  />
                </Form.Item>
                
                <Divider />
              </>
            );
          }
          return null;
        }}
      </Form.Item>

      {/* Email Notification Section */}
      <Form.Item dependencies={['outputType']} noStyle>
        {({ getFieldValue }) => {
          const outputType = getFieldValue('outputType');
          
          if (outputType === 'export' || outputType === 'both') {
            return (
              <>
                <Typography.Title level={5}>Email Notification (Optional)</Typography.Title>
                
                <Form.Item
                  name="enableEmailNotification"
                  valuePropName="checked"
                  initialValue={false}
                >
                  <Checkbox>
                    Send email notification when workflow completes
                  </Checkbox>
                </Form.Item>

                <Form.Item dependencies={['enableEmailNotification']} noStyle>
                  {({ getFieldValue: getEmailEnabled }) => {
                    const emailEnabled = getEmailEnabled('enableEmailNotification');
                    
                    if (emailEnabled) {
                      return (
                        <>
                          <Form.Item
                            name="emailAddress"
                            label="Email Address"
                            rules={[
                              { required: true, message: 'Please enter email address' },
                              { type: 'email', message: 'Please enter a valid email address' }
                            ]}
                          >
                            <Input placeholder="recipient@example.com" />
                          </Form.Item>

                          <Form.Item
                            name="emailSubject"
                            label="Email Subject"
                            rules={[{ required: true, message: 'Please enter email subject' }]}
                            initialValue="Workflow Report"
                          >
                            <Input placeholder="Workflow Report" />
                          </Form.Item>

                          <Form.Item
                            name="emailBody"
                            label="Email Message"
                            initialValue="Please find the attached workflow report."
                          >
                            <TextArea 
                              rows={15} 
                              placeholder="Please find the attached workflow report."
                            />
                          </Form.Item>

                          <Form.Item
                            name="includeData"
                            valuePropName="checked"
                            initialValue={true}
                          >
                            <Checkbox defaultChecked>
                              Include processed data as CSV attachment
                            </Checkbox>
                          </Form.Item>

                          <Form.Item>
                            <Button 
                              type="default" 
                              onClick={handleSendTestEmail}
                              loading={false}
                              style={{ width: '100%' }}
                            >
                              Send Test Email
                            </Button>
                          </Form.Item>
                        </>
                      );
                    }
                    return null;
                  }}
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

export default OutputConfig;