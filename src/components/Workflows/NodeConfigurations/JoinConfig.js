import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Space, Typography, Divider, Card, Alert, Collapse, message } from 'antd';
import { CodeOutlined } from '@ant-design/icons';

const { TextArea } = Input;
const { Text } = Typography;
const { Panel } = Collapse;

const JoinConfig = ({ 
  node,
  onConfigUpdate,
  joinDescription,
  setJoinDescription,
  joinAnalysis,
  isAnalyzingJoin,
  handleAnalyzeJoin,
  onSave
}) => {
  const [form] = Form.useForm();
  const [isConfigSaved, setIsConfigSaved] = useState(false);
  const [cachedNode, setCachedNode] = useState(null);

  // Initialize form only when node actually changes
  useEffect(() => {
    if (node && node.id !== cachedNode?.id) {
      console.log('JoinConfig - Node changed, initializing form');
      form.setFieldsValue(node.data.config || {});
      
      // For join nodes, restore join analysis and description if they exist
      if (node.data.config?.joinAnalysis) {
        // setJoinAnalysis handled by parent
      }
      if (node.data.config?.joinDescription) {
        setJoinDescription(node.data.config.joinDescription);
      }
      
      // Set node_name field
      const { connectionName, node_name } = node.data.config || {};
      form.setFieldsValue({
        node_name: node_name || connectionName || ''
      });
      
      // Update cached node
      setCachedNode(node);
    }
  }, [node, form]);

  // Reset config saved state when inputs change
  useEffect(() => {
    setIsConfigSaved(false);
  }, [joinDescription]);

  const handleSave = async () => {
    try {
      // Validate form first
      await form.validateFields();
      
      if (!joinDescription?.trim()) {
        message.warning('Please enter a join description');
        return;
      }
      
      // Get form values and update node configuration with node_name
      const formValues = form.getFieldsValue();
      const { node_name } = formValues;
      
      onConfigUpdate(node.id, {
        ...node.data.config,
        node_name: node_name
      });
      
      // Check if description has changed compared to what was previously saved
      const savedJoinDescription = node.data?.config?.joinDescription;
      const hasDescriptionChanged = savedJoinDescription !== joinDescription;
      
      // Check if we already have a valid join analysis with connection info
      // AND the description hasn't changed
      if (joinAnalysis && !joinAnalysis.error && node.data?.config?.connectionId && !hasDescriptionChanged) {
        message.success('Join configuration already saved');
        setIsConfigSaved(true);
        
        if (onSave) {
          onSave();
        }
        return;
      }
      
      
      // Run join analysis with node_name from form (this will only save if API call is successful)
      await handleAnalyzeJoin(node_name);
      
      // Check if the analysis and save were successful by checking if we now have connectionId
      if (node.data?.config?.connectionId && node.data?.config?.joinAnalysis) {
        setIsConfigSaved(true);
        message.success('Join configuration saved successfully');
        
        if (onSave) {
          onSave();
        }
      } else {
        // Analysis may have completed but save didn't happen due to API failure
        message.warning('Join analysis completed but configuration was not saved due to API issues');
      }
    } catch (error) {
      console.error('Join analysis failed:', error);
      message.error('Failed to analyze and save join configuration');
    }
  };
  
  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={handleSave}
    >
      <Form.Item
        name="node_name"
        label="Node Name"
        rules={[{ required: true, message: 'Please enter a node name' }]}
        help="Custom name for this join node"
      >
        <Input placeholder="Enter a descriptive name for this join" />
      </Form.Item>
      
      <Form.Item
        name="joinDescription"
        label="Describe Your Join"
        rules={[{ required: true, message: 'Please describe how you want to join the data' }]}
        // help="Example: 'Join customer data with orders by customer ID' or 'Merge product info with sales data where product SKU matches'"
      >
        <TextArea 
          rows={15}
          placeholder="Describe how you want to join the connected data sources..."
          onChange={(e) => setJoinDescription(e.target.value)}
          value={joinDescription}
        />
      </Form.Item>

      {joinAnalysis && (
        <>
          <Divider orientation="left" style={{ fontSize: '14px', margin: '16px 0 12px 0' }}>
            Join Analysis
          </Divider>
          
          <Card size="small" style={{ marginBottom: 16, backgroundColor: joinAnalysis.error ? '#fff2f0' : '#f6ffed' }}>
            {joinAnalysis.description && (
              <div style={{ marginBottom: 12, fontSize: '14px', color: '#333' }}>
                <Text strong>Analysis: </Text>
                <Text>{joinAnalysis.description}</Text>
              </div>
            )}
            
            {joinAnalysis.error && (
              <Alert
                message="Join Analysis Error"
                description={joinAnalysis.error}
                type="error"
                size="small"
                showIcon
                style={{ marginBottom: 12 }}
              />
            )}
            
            {joinAnalysis.sql && !joinAnalysis.error && (
              <Collapse ghost size="small">
                <Panel 
                  header={
                    <span>
                      <CodeOutlined style={{ marginRight: 8 }} />
                      View Generated SQL Query
                    </span>
                  } 
                  key="sql"
                >
                  <div style={{ 
                    fontSize: '12px', 
                    fontFamily: 'monospace', 
                    backgroundColor: '#f5f5f5', 
                    padding: 12, 
                    borderRadius: 4,
                    whiteSpace: 'pre-wrap',
                    border: '1px solid #d9d9d9'
                  }}>
                    {joinAnalysis.sql}
                  </div>
                </Panel>
              </Collapse>
            )}
          </Card>
        </>
      )}
      
      <Divider />
      
      <Form.Item style={{ marginBottom: 0 }}>
        <Button 
          type="primary" 
          htmlType="submit"
          disabled={isConfigSaved && node.data?.config?.joinDescription === joinDescription}
          title={
            (isConfigSaved && node.data?.config?.joinDescription === joinDescription) 
              ? 'Configuration is saved. Make changes to enable save again.' 
              : ''
          }
        >
          Analyze & Save Join
        </Button>
      </Form.Item>
    </Form>
  );
};

export default JoinConfig;