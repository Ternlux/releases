import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Space, Typography, Divider, Select, Slider, message, Collapse } from 'antd';
import { SettingOutlined, DatabaseOutlined, EnvironmentOutlined, TeamOutlined, CodeOutlined } from '@ant-design/icons';

const { TextArea } = Input;
const { Text } = Typography;
const { Option } = Select;
const { Panel } = Collapse;

const TransformerConfig = ({ 
  node,
  onConfigUpdate,
  transformationRequest,
  setTransformationRequest,
  transformationAnalysis,
  transformationSteps,
  handleAnalyzeTransformation,
  onSave
}) => {
  const [form] = Form.useForm();
  const [transformationType, setTransformationType] = useState('custom');
  const [radiusMiles, setRadiusMiles] = useState(15);
  const [isConfigSaved, setIsConfigSaved] = useState(false);
  const [cachedNode, setCachedNode] = useState(null);

  // Initialize form only when node actually changes
  useEffect(() => {
    if (node && node.id !== cachedNode?.id) {
      console.log('TransformerConfig - Node changed, initializing form');
      form.setFieldsValue(node.data.config || {});

      // Load existing transformer configuration
      if (node.data?.config) {
        const { transformationPlan, transformationRequest, connectionName, node_name, radiusMiles: savedRadiusMiles, transformationType: savedTransformationType } = node.data.config;

        // Set transformation type
        setTransformationType(savedTransformationType || 'custom');

        // Set radius from saved config if available
        if (savedRadiusMiles) {
          setRadiusMiles(savedRadiusMiles);
        }

        if (transformationPlan) {
          // Set form values based on saved config
        }

        form.setFieldsValue({
          transformationRequest: transformationRequest || '',
          transformationPlan: transformationPlan || null,
          node_name: node_name || connectionName || '',
          transformationType: savedTransformationType || 'custom',
          radiusMiles: savedRadiusMiles || 15
        });
      }

      // Update cached node
      setCachedNode(node);
    }
  }, [node, form]);

  // Reset config saved state when inputs change
  useEffect(() => {
    setIsConfigSaved(false);
  }, [transformationRequest]);

  const handleSave = async () => {
    try {
      // Validate form first
      await form.validateFields();

      const formValues = form.getFieldsValue();
      const { node_name, transformationType } = formValues;

      // Update node configuration with node_name, transformationType, and radiusMiles
      onConfigUpdate(node.id, {
        ...node.data.config,
        node_name: node_name,
        transformationType: transformationType,
        radiusMiles: radiusMiles
      });

      const isEnrichmentType = transformationType === 'menu_items' || transformationType === 'locations_top_visitors' || transformationType === 'demographic_breakdown' || transformationType === 'location_enrichment';
      console.log('transformationType: ', transformationType, transformationRequest)
      if (!isEnrichmentType && !transformationRequest?.trim()) {
        message.warning('Please enter a transformation request');
        return;
      }

      // Run transformation analysis before saving
      await handleAnalyzeTransformation(radiusMiles, transformationType);
      setIsConfigSaved(true);

      if (onSave) {
        onSave();
      }
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  const transformationTypes = [
    {
      value: 'menu_items',
      label: 'Menu Items Enrichment',
      description: 'Add nearby restaurant menu data within 15 miles',
      icon: <DatabaseOutlined style={{ color: '#52c41a' }} />
    },
    {
      value: 'locations_top_visitors',
      label: 'Locations Top Visitors',
      description: 'Top categories of visitors to the location including demographic breakdown aggregated to groups',
      icon: <TeamOutlined style={{ color: '#fa8c16' }} />
    },
    {
      value: 'demographic_breakdown',
      label: 'Demographic Breakdown',
      description: 'Most in-depth breakdown by age, urban type, income, race',
      icon: <TeamOutlined style={{ color: '#722ed1' }} />
    },
    {
      value: 'location_enrichment',
      label: 'Location Enrichment',
      description: 'Enrich data with detailed location information',
      icon: <EnvironmentOutlined style={{ color: '#13c2c2' }} />
    },
    {
      value: 'custom',
      label: 'Custom Transformation',
      description: 'Apply custom SQL transformations to your data',
      icon: <SettingOutlined style={{ color: '#1890ff' }} />
    }
  ];

  const handleTransformationTypeChange = (value) => {
    setTransformationType(value);
    form.setFieldsValue({ transformationType: value });

    // Clear previous analysis when type changes
    form.setFieldsValue({ transformationPlan: null });
    setIsConfigSaved(false)
    // Set default radius for enrichment types
    if (value === 'menu_items' || value === 'locations_top_visitors' || value === 'demographic_breakdown' || value === 'location_enrichment') {
      setRadiusMiles(15);
      form.setFieldsValue({ radiusMiles: 15 });
    }
  };

  const handleRadiusChange = (value) => {
    setRadiusMiles(value);
    setIsConfigSaved(false)
    form.setFieldsValue({ radiusMiles: value });
  };

  const getPlaceholderText = () => {
    switch (transformationType) {
      case 'menu_items':
        return 'This will find all menu items from restaurants within the specified radius of your location data. Ensure your data has "latitude" and "longitude" columns.';
      case 'locations_top_visitors':
        return 'This will find top categories of visitors to locations within the specified radius, including demographic breakdown aggregated to groups. Ensure your data has "latitude" and "longitude" columns.';
      case 'demographic_breakdown':
        return 'This will provide the most in-depth demographic breakdown by age, urban type, income, and race within the specified radius. Ensure your data has "latitude" and "longitude" columns.';
      case 'location_enrichment':
        return 'This will enrich your location data with detailed location information within the specified radius. Ensure your data has "latitude" and "longitude" columns.';
      default:
        return 'Describe what transformation you want to apply to the data...';
    }
  };

  const getHelpText = () => {
    switch (transformationType) {
      case 'menu_items':
        return 'Source data must contain "latitude" and "longitude" columns for geospatial matching';
      case 'locations_top_visitors':
        return 'Source data must contain "latitude" and "longitude" columns for geospatial matching';
      case 'demographic_breakdown':
        return 'Source data must contain "latitude" and "longitude" columns for geospatial matching';
      case 'location_enrichment':
        return 'Source data must contain "latitude" and "longitude" columns for geospatial matching';
      default:
        return "Example: 'Remove duplicate rows and calculate total sales by region' or 'Filter data for last 30 days and group by product category'";
    }
  };

  const isEnrichmentType = transformationType === 'menu_items' || transformationType === 'locations_top_visitors' || transformationType === 'demographic_breakdown' || transformationType === 'location_enrichment';

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
        help="Custom name for this transformer node"
      >
        <Input placeholder="Enter a descriptive name for this transformer" />
      </Form.Item>
      
      <Form.Item
        name="transformationType"
        label="Transformation Type"
        rules={[{ required: true, message: 'Please select a transformation type' }]}
        initialValue="custom"
      >
        <Select 
          onChange={handleTransformationTypeChange}
          value={transformationType}
          placeholder="Select transformation type"
        >
          {transformationTypes.map(type => (
            <Option key={type.value} value={type.value}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {type.icon}
                <div>
                  <div style={{ fontWeight: 'bold' }}>{type.label}</div>
                  {/* <div style={{ fontSize: '12px', color: '#666' }}>{type.description}</div> */}
                </div>
              </div>
            </Option>
          ))}
        </Select>
      </Form.Item>

      {isEnrichmentType ? (
        <Form.Item
          name="radiusMiles"
          label="Search Radius"
          rules={[{ required: true, message: 'Please select a search radius' }]}
          help="Select the radius in miles to search for nearby locations"
          initialValue={15}
        >
          <div>
            <Slider
              min={1}
              max={15}
              value={radiusMiles}
              onChange={handleRadiusChange}
              marks={{
                1: '1 mile',
                5: '5 miles',
                10: '10 miles',
                15: '15 miles'
              }}
              step={1}
            />
            <div style={{ textAlign: 'center', marginTop: '8px' }}>
              <Text strong>{radiusMiles} miles</Text>
            </div>
          </div>
        </Form.Item>
      ) : (
        <Form.Item
          name="transformationRequest"
          label="Describe Your Transformation"
          rules={[{ required: true, message: 'Please describe the transformation you want' }]}
          // help="Example: 'Remove duplicate rows and calculate total sales by region' or 'Filter data for last 30 days and group by product category'"
        >
          <TextArea 
            rows={15}
            placeholder="Describe what transformation you want to apply to the data..."
            onChange={(e) => setTransformationRequest(e.target.value)}
            value={transformationRequest}
          />
        </Form.Item>
      )}
      
      {transformationAnalysis && (
        <>
          <Divider orientation="left" style={{ fontSize: '14px', margin: '16px 0 12px 0' }}>
            <SettingOutlined /> {isEnrichmentType ? 'Enrichment Results' : 'Transformation Plan'}
          </Divider>
          
          <div style={{ 
            background: '#f8f9fa', 
            padding: '12px', 
            borderRadius: '6px', 
            marginBottom: '16px',
            border: '1px solid #e1e5e9'
          }}>
            {isEnrichmentType ? (
              // Enrichment Results Display
              <>
                <div style={{ marginBottom: '8px' }}>
                  <Text strong style={{ color: '#1890ff' }}>
                    Type: {transformationAnalysis.enrichmentType?.replace('_', ' ').toUpperCase()} ENRICHMENT
                  </Text>
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <Text style={{ color: '#666', fontSize: '13px' }}>
                    {transformationAnalysis.enrichmentResult?.locationsFound || 0} locations found within 15 miles
                  </Text>
                </div>
                
                <div style={{ marginBottom: '8px' }}>
                  <Text strong style={{ fontSize: '12px' }}>Results:</Text>
                </div>
                
                <div style={{ 
                  background: 'white',
                  padding: '8px 12px',
                  marginBottom: '6px',
                  borderRadius: '4px',
                  border: '1px solid #e8e8e8'
                }}>
                  <div style={{ fontSize: '12px', marginBottom: '4px' }}>
                    <Text strong>Locations Found: </Text>
                    <Text>{transformationAnalysis.enrichmentResult?.locationsFound || 0}</Text>
                  </div>
                  <div style={{ fontSize: '12px', marginBottom: '4px' }}>
                    <Text strong>Records to Insert: </Text>
                    <Text>{transformationAnalysis.enrichmentResult?.recordsToInsert || 0}</Text>
                  </div>

                </div>
              </>
            ) : (
              // Regular Transformation Display
              <>
                <div style={{ marginBottom: '8px' }}>
                  <Text strong style={{ color: '#1890ff' }}>
                    Type: {transformationAnalysis.transformationType?.replace('_', ' ').toUpperCase()}
                  </Text>
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <Text style={{ color: '#666', fontSize: '13px' }}>
                    {transformationAnalysis.summary}
                  </Text>
                </div>

                {transformationSteps && transformationSteps.length > 0 && (
                  <>
                    <div style={{ marginBottom: '8px' }}>
                      <Text strong style={{ fontSize: '12px' }}>Steps:</Text>
                    </div>

                    {transformationSteps.map((step, index) => (
                      <div
                        key={index}
                        style={{
                          background: 'white',
                          padding: '8px 12px',
                          marginBottom: '6px',
                          borderRadius: '4px',
                          border: '1px solid #e8e8e8'
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          marginBottom: '4px'
                        }}>
                          <Text strong style={{ fontSize: '12px', color: '#1890ff' }}>
                            Step {step.step}: {step.operation}
                          </Text>
                        </div>
                        <div style={{ fontSize: '11px', color: '#666' }}>
                          {step.description}
                        </div>
                        {step.parameters && Object.keys(step.parameters).length > 0 && (
                          <div style={{
                            fontSize: '11px',
                            color: '#888',
                            marginTop: '4px',
                            fontFamily: 'monospace'
                          }}>
                            {JSON.stringify(step.parameters, null, 2)}
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}

                {transformationAnalysis.sql && (
                  <div style={{ marginTop: '12px' }}>
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
                          {transformationAnalysis.sql}
                        </div>
                      </Panel>
                    </Collapse>
                  </div>
                )}
              </>
            )}
          </div>
          
        </>
      )}
      
      {/* Hidden field to store the transformation plan */}
      <Form.Item name="transformationPlan" style={{ display: 'none' }}>
        <Input />
      </Form.Item>
      
      <Divider />
      
      <Form.Item style={{ marginBottom: 0 }}>
        <Button 
          type="primary" 
          htmlType="submit"
          disabled={isConfigSaved}
          title={isConfigSaved ? 'Configuration is saved. Make changes to enable save again.' : ''}
        >
          Process & Save
        </Button>
      </Form.Item>
    </Form>
  );
};

export default TransformerConfig;