import React, { useState, useEffect } from 'react';
import { asyncJobClient } from '../../utils/asyncJobClient';
import { connectionsDb } from '../../utils/localDb';
import {
  transformationAnalysis,
  parseTransformationResponse,
  joinNodesAnalysis,
  parseJoinResponse,
} from '../api/workflowApi';
import { Card, Form, Button, Space, Typography, message, Modal, Divider } from 'antd';
import { CloseOutlined, DatabaseOutlined, SettingOutlined, MergeOutlined, ExportOutlined, EyeOutlined, PlayCircleOutlined } from '@ant-design/icons';
import DataPreviewModal from './DataPreviewModal';
import LocalFileConnectionForm from './connections/LocalFileConnectionForm';
import { DataSourceConfig, TransformerConfig, JoinConfig, StartConfig, OutputConfig } from './NodeConfigurations';
import axios from 'axios';

const { Title, Text } = Typography;

const NodeSidebar = ({ isOpen, node, nodes, edges, onClose, onConfigUpdate }) => {
  const [connections, setConnections] = useState([]);
  const [transConnection, setTransConnection] = useState([]);
  const [previewData, setPreviewData] = useState(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [isEditDataSourceOpen, setIsEditDataSourceOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState(null);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [availableSheets, setAvailableSheets] = useState([]);
  const [availableSources, setAvailableSources] = useState([]);
  const [loadingSheets, setLoadingSheets] = useState(false);
  const [transformationSteps, setTransformationSteps] = useState([]);
  const [isAnalyzingTransformation, setIsAnalyzingTransformation] = useState(false);
  const [transformationAnalysis, setTransformationAnalysis] = useState(null);
  const [isAnalyzingJoin, setIsAnalyzingJoin] = useState(false);
  const [joinAnalysis, setJoinAnalysis] = useState(null);
  const [joinDescription, setJoinDescription] = useState('');
  const [transformationRequest, setTransformationRequest] = useState('');
  const [isConfigSaved, setIsConfigSaved] = useState(false);
  const [cachedNode, setCachedNode] = useState({});

  // Reset config saved state when form changes
  useEffect(() => {
    setIsConfigSaved(false);
  }, [node, isOpen]);

  // Reset config saved state when inputs change
  useEffect(() => {
    setIsConfigSaved(false);
  }, [transformationRequest, joinDescription]);

  // Load real connections from API
  useEffect(() => {
    if (isOpen) {
      fetchConnections();
    }
  }, [isOpen, node]);

  // Load existing transformer configuration only when node changes
  useEffect(() => {
    // Check if node has actually changed by comparing node IDs
    const hasNodeChanged = node?.id !== cachedNode?.id;
    console.log('hasNodeChanged: ', hasNodeChanged, node)

    if (isOpen && node?.type === 'transformer' && hasNodeChanged) {
      const { transformationPlan, transformationRequest: nodeTransformationRequest } = node.data?.config || {};
      // Set or clear transformation analysis based on what exists
      if (transformationPlan) {
        setTransformationAnalysis(transformationPlan);
        setTransformationSteps(transformationPlan.steps || []);
      } else {
        setTransformationAnalysis(null);
        setTransformationSteps([]);
      }
      
      // Set transformationRequest from node config only when node changes
      console.log('Node changed - Setting transformationRequest from node config: ', nodeTransformationRequest);
      setTransformationRequest(nodeTransformationRequest || '');
      
      // Update cached node
      setCachedNode(node);
    } else if (isOpen && node?.type !== 'transformer' && hasNodeChanged) {
      // Clear transformer data when switching to non-transformer nodes
      setTransformationAnalysis(null);
      setTransformationSteps([]);
      setTransformationRequest('');
      
      // Update cached node
      setCachedNode(node);
    }
  }, [isOpen, node]);

  // Helper function to handle authentication errors
  const handleAuthError = (error) => {
    if (error.response?.status === 401 || error.response?.status === 204 || 
        (error.response?.status === 400)) {
      localStorage.removeItem('auth-token');
      message.error('Session expired. Please log in again.');
      window.location.href = '/login';
      return true;
    }
    return false;
  };

  const fetchConnections = async () => {
    const token = localStorage.getItem('auth-token');

    if (!token) {
      // No session — load from the local store
      try {
        const local = await connectionsDb.getAll();
        setConnections(local);
      } catch (err) {
        console.error('Error loading local connections:', err);
        message.error('Failed to load local data sources');
      }
      return;
    }

    try {
      const [response, response_trans] = await Promise.all([
        axios.post('/workflow/connections', { transformer: false }, {
          headers: { 'auth-token': token, 'Content-Type': 'application/json' },
        }),
        axios.post('/workflow/connections', { transformer: true }, {
          headers: { 'auth-token': token, 'Content-Type': 'application/json' },
        }),
      ]);

      if (response.data.success) setConnections(response.data.data);
      if (response_trans.data.success) setTransConnection(response_trans.data.data);
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error fetching connections:', error);
      message.error('Failed to load data sources');
    }
  };

  const handleConnectionChange = async (connectionId) => {
    console.log('DEBUG - Connection changed:', connectionId);
    const connection = connections.find(c => c.id === connectionId);
    console.log('DEBUG - Found connection in handleConnectionChange:', {
      connection,
      fileType: connection?.fileType,
      apiType: connection?.apiType
    });
    
    setSelectedConnection(connection);
    
    // Clear sheet/dataset selection when connection changes
    setAvailableSheets([]);
    setAvailableSources([]);
    
    if (connection) {
      console.log('DEBUG - Connection details:', {
        id: connection.id,
        name: connection.name,
        fileType: connection.fileType,
        apiType: connection.apiType
      });
      
      // Fetch available sources for all connection types
      console.log('DEBUG - Fetching sources for connection');
      await fetchSheets(connectionId);
    } else {
      console.log('DEBUG - No connection found');
    }
  };

  const fetchSheets = async (connectionId) => {
    setLoadingSheets(true);
    try {
      const response = await axios.get(`/workflow/connection-sheets/${connectionId}`, {
        headers: {
          'auth-token': localStorage.getItem('auth-token')
        }
      });

      if (response.data.success) {
        // Store all available sources (sheets and datasets)
        const sources = response.data.data.sources || [];
        console.log('DEBUG - Fetched sources:', sources);
        
        setAvailableSources(sources);
        
        // For backward compatibility, still set sheets for Excel files
        const sheets = sources.filter(s => s.type === 'sheet').map(s => s.name);
        setAvailableSheets(sheets);
      }
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error fetching sources:', error);
      message.error('Failed to load connection sources');
    } finally {
      setLoadingSheets(false);
    }
  };

  const getPosDatasets = (connection) => {
    if (!connection?.apiType) return [];
    
    if (connection.apiType === 'clover_pos') {
      return [
        { value: 'orders', label: 'Orders' },
        { value: 'merchants', label: 'Merchant Info' },
        { value: 'payments', label: 'Payments' },
        { value: 'customers', label: 'Customers' },
        { value: 'items', label: 'Items/Inventory' },
        { value: 'categories', label: 'Categories' }
      ];
    } else if (connection.apiType === 'square_pos') {
      return [
        { value: 'orders', label: 'Orders' },
        { value: 'locations', label: 'Locations' },
        { value: 'payments', label: 'Payments' },
        { value: 'customers', label: 'Customers' },
        { value: 'items', label: 'Catalog Items' },
        { value: 'inventory', label: 'Inventory' }
      ];
    }
    
    return [];
  };

  // Initialize data when node changes
  useEffect(() => {
    if (node && isOpen) {
      // If there's a connectionId, set the selected connection
      const connectionId = node.data.config?.connectionId;
      if (connectionId && connections.length > 0) {
        const connection = connections.find(c => c.id === connectionId);
        if (connection) {
          setSelectedConnection(connection);
          
          // Fetch available sources for all connection types
          fetchSheets(connectionId);
        } else {
          setSelectedConnection(null);
        }
      } else {
        setSelectedConnection(null);
      }
      
      // For join nodes, restore join analysis and description only if node has changed
      const hasNodeChanged = node?.id !== cachedNode?.id;
      console.log('hasNodeChanged: ', hasNodeChanged, node, cachedNode)

      if (node.type === 'join' && hasNodeChanged) {
        const nodeJoinAnalysis = node.data.config?.joinAnalysis || null;
        const nodeJoinDescription = node.data.config?.joinDescription || '';

        setJoinAnalysis(nodeJoinAnalysis);
        
        // Set joinDescription from node config only when node changes
        console.log('Node changed - Setting joinDescription from node config: ', nodeJoinDescription);
        setJoinDescription(nodeJoinDescription);
        
        // Update cached node if not already updated by transformer logic
        if (node?.type !== 'transformer') {
          setCachedNode(node);
        }
      } else if (node.type !== 'join' && hasNodeChanged) {
        // Clear join data when switching to non-join nodes
        setJoinAnalysis(null);
        setJoinDescription('');
        
        // Update cached node if not already updated by transformer logic
        if (node?.type !== 'transformer') {
          setCachedNode(node);
        }
      }
    } else if (!isOpen) {
      // Clear all state when sidebar closes
      setSelectedConnection(null);
      setJoinAnalysis(null);
      setJoinDescription('');
    }
  }, [node, isOpen]);

  const handleConfigSave = () => {
    // Mark as saved for join and transformer nodes, close for others
    if (node.type === 'join' || node.type === 'transformer') {
      setIsConfigSaved(true);
    } else {
      onClose();
    }
  };

  const handleSendTestEmail = async (emailConfig) => {
    try {
      const testEmailData = {
        nodeId: node.id,
        emailAddress: emailConfig.emailAddress,
        emailSubject: emailConfig.emailSubject || 'Test Email from Workflow',
        emailBody: emailConfig.emailBody || 'This is a test email from your workflow configuration.',
        isTest: true
      };
      
      const response = await axios.post('/workflow/send-test-email', testEmailData, {
        headers: {
          'Content-Type': 'application/json',
          'auth-token': localStorage.getItem('auth-token')
        }
      });
      
      if (response.data.success) {
        message.success('Test email sent successfully!');
      } else {
        message.error('Failed to send test email: ' + response.data.error);
      }
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Test email error:', error);
      message.error('Failed to send test email');
    }
  };

  const handleTestAnalysis = async (analysisConfig) => {
    try {
      const messageKey = 'test-analysis-progress';
      message.loading('Starting analysis...', 0, messageKey);
      
      const response = await asyncJobClient.testAnalysis(
        node.id,
        analysisConfig.analysisPrompt,
        true,
        {
          onProgress: (progress) => {
            message.loading({
              content: `Analyzing... ${progress.progress}% - ${progress.stage}`,
              key: messageKey,
              duration: 0
            });
          }
        }
      );
      
      message.destroy(messageKey);
      
      if (response.success) {
        message.success('Analysis test completed!');
        
        // Show the analysis result in a modal
        Modal.info({
          title: 'AI Analysis Result',
          width: 800,
          content: (
            <div>
              <p><strong>Prompt:</strong> {analysisConfig.analysisPrompt}</p>
              <Divider />
              <div style={{ 
                maxHeight: '400px', 
                overflow: 'auto',
                padding: '12px',
                backgroundColor: '#f5f5f5',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap'
              }}>
                {response.data.analysis}
              </div>
            </div>
          )
        });
      } else {
        message.error('Failed to run analysis: ' + response.error);
      }
    } catch (error) {
      message.destroy('test-analysis-progress');
      if (handleAuthError(error)) return;
      console.error('Test analysis error:', error);
      message.error('Failed to run test analysis');
    }
  };

  const handleEditDataSource = () => {
    if (selectedConnection) {
      setEditingConnection(selectedConnection);
      setIsEditDataSourceOpen(true);
    } else {
      message.warning('Please select a data source first');
    }
  };

  const handleDataSourceSave = async (connectionData) => {
    // Persist the local file connection (same path ConnectionsTab uses for file
    // connections), then refresh and close the modal.
    try {
      const connectionId = editingConnection?.id || editingConnection?._id;
      if (connectionId) {
        await connectionsDb.update(connectionId, connectionData);
      } else {
        await connectionsDb.save(connectionData);
      }
      fetchConnections();
      setIsEditDataSourceOpen(false);
      setEditingConnection(null);
      message.success('Data source updated successfully');
    } catch (error) {
      console.error('Error saving data source:', error);
      message.error('Failed to save data source.');
    }
  };


  const getInputNodes = (nodeId) => {
    return edges
      .filter(edge => edge.target === nodeId)
      .map(edge => nodes.find(n => n.id === edge.source))
      .filter(Boolean);
  };

  const getConnectedDataSource = () => {
    if (!node || node.type !== 'transformer') return null;
    
    // Find connected data source nodes
    const inputNodes = getInputNodes(node.id);
    const dataSourceNode = inputNodes.find(inputNode => inputNode.type === 'dataSource');
    
    if (!dataSourceNode || !dataSourceNode.data?.config?.connectionId) {
      return null;
    }
    
    // Return connection info for schema lookup
    return {
      connectionId: dataSourceNode.data.config.connectionId,
      schema: dataSourceNode.data.config.schema || null
    };
  };

  const getConnectedNodeForTransformation = () => {
    if (!node) return null;
    
    // Find connected data source nodes
    const inputNodes = getInputNodes(node.id);
    const dataSourceNode = inputNodes[0]//.find(inputNode => inputNode.type === 'dataSource');
    console.log('dataSourceNode: ', dataSourceNode.data)

    if (!dataSourceNode || !dataSourceNode.data?.config?.connectionId) {
      return null;
    }

    const config = dataSourceNode.data.config;
    const connectionId = config.connectionId;
    const dataset = config.dataset;
    const sourceType = config.sourceType;
    const table = config.table;
    
    
    return {
      nodeId: dataSourceNode.id.replace('dataSource-', ''),
      dataset: dataset || table || config.connectionName,
      connectionId: connectionId,
      table: table
    };
  };

  const getNodeIcon = () => {
    switch (node?.type) {
      case 'start':
        return <PlayCircleOutlined style={{ color: '#1890ff' }} />;
      case 'dataSource':
        return <DatabaseOutlined style={{ color: '#52c41a' }} />;
      case 'transformer':
        return <SettingOutlined style={{ color: '#1890ff' }} />;
      case 'join':
        return <MergeOutlined style={{ color: '#fa8c16' }} />;
      case 'output':
        return <ExportOutlined style={{ color: '#722ed1' }} />;
      default:
        return null;
    }
  };

  const renderDataSourceConfig = () => (
    <DataSourceConfig
      node={node}
      onConfigUpdate={onConfigUpdate}
      connections={connections}
      selectedConnection={selectedConnection}
      setSelectedConnection={setSelectedConnection}
      availableSheets={availableSheets}
      setAvailableSheets={setAvailableSheets}
      availableSources={availableSources}
      setAvailableSources={setAvailableSources}
      loadingSheets={loadingSheets}
      setLoadingSheets={setLoadingSheets}
      handleEditDataSource={handleEditDataSource}
      fetchSheets={fetchSheets}
      handleConnectionChange={handleConnectionChange}
      onSave={handleConfigSave}
    />
  );

  const handleAnalyzeTransformation = async (radiusMiles, transformationType) => {


    
  //   setIsAnalyzingTransformation(true);
    
  //   try {
  //     // Get connected node data for transformation
  //     const connectedNode = getConnectedNodeForTransformation();
      
  //     if (!connectedNode) {
  //       message.error('Please connect a data source to this transformer node');
  //       setIsAnalyzingTransformation(false);
  //       return;
  //     }

  //     const messageKey = 'transformation-progress';

      // const response = await transformationAnalysis(
      //   transformationRequest || `${transformationType} enrichment`,
      //   connectedNode,
      //   node.id,
      //   isEnrichmentType ? transformationType : null,
      //   isEnrichmentType ? radiusMiles : null,
      //   node.data?.config?.node_name || null,
      //   (progress) => {
      //     message.loading({
      //       content: `Processing transformation... ${progress.progress}% - ${progress.stage}`,
      //       key: messageKey,
      //       duration: 0
      //     });
      //   }
      // );

    //   if (response.success) {
    //     const { plan, autoSaveValues, isEnrichment } = parseTransformationResponse(
    //       response,
    //       node.data.config,
    //       transformationType,
    //       radiusMiles,
    //       transformationRequest
    //     );

    //     setTransformationAnalysis(plan);

    //     if (isEnrichment) {
    //       setTransformationSteps([]);
    //       message.success(`${transformationType.replace('_', ' ')} enrichment completed successfully! Found ${response.enrichmentResult?.locationsFound || 0} locations.`);
    //     } else {
    //       setTransformationSteps([plan]);
    //       if (response.newConnectionId) {
    //         message.success('Transformation completed successfully! New data connection created.');
    //       } else if (response.warning) {
    //         message.warning(`Transformation executed but ${response.warning.message}`);
    //       } else {
    //         message.success('Transformation analysis completed successfully');
    //       }
    //     }

    //     onConfigUpdate(node.id, autoSaveValues);
    //     setIsConfigSaved(true);
    //     message.success(isEnrichment ? 'Enrichment configuration saved automatically' : 'Transformation configuration saved automatically');
    //   } else {
    //     throw new Error(response.message || response.details || 'Failed to process transformation');
    //   }
    // } catch (error) {
    //   if (handleAuthError(error)) return;
    //   console.error('Transformation analysis error:', error);
    //   message.error(error.message || 'Failed to process transformation');
    // } finally {
    //   setIsAnalyzingTransformation(false);
    //   message.destroy('transformation-progress'); // Clear the specific loading message
    // }
  };
  

  const handleAnalyzeJoin = async (nodeName = null) => {
    if (!joinDescription?.trim()) {
      message.warning('Please enter a join description');
      return;
    }
    
    setIsAnalyzingJoin(true);
    
    try {
      // Get connected data sources for join analysis
      const connectedNodes = getConnectedNodesForJoin();
      
      if (connectedNodes.length < 2) {
        message.warning('Please connect at least two data sources to this join node');
        setIsAnalyzingJoin(false);
        return;
      }
      console.log('connectedNodes: ', connectedNodes)
      
      const messageKey = 'join-analysis-progress';

      const response = await joinNodesAnalysis(
        joinDescription,
        connectedNodes,
        node.id,
        nodeName || node.data?.config?.node_name || null,
        (progress) => {
          message.loading({
            content: `Analyzing join... ${progress.progress}% - ${progress.stage}`,
            key: messageKey,
            duration: 0
          });
        }
      );

      if (response.success) {
        const { joinResult, autoSaveValues, hasError, errorType } = parseJoinResponse(
          response,
          node.data.config,
          joinDescription
        );

        if (hasError) {
          if (errorType === 'execution') {
            setJoinAnalysis(joinResult);
            message.error(`Join analysis completed but execution failed: ${response.executionError.message}`);
          } else if (errorType === 'connection') {
            message.warning(`Join executed successfully but connection creation had issues: ${response.connectionError.message}`);
          } else {
            message.warning('Join analysis completed but connection info is missing');
          }
        } else {
          message.success('Join analysis and execution completed successfully');
          onConfigUpdate(node.id, autoSaveValues);
          setIsConfigSaved(true);
          message.success('Join configuration saved automatically');
        }
      } else {
        setJoinAnalysis(null);
        message.error(response.error || 'Failed to analyze join');
      }
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Join analysis error:', error);
      message.error('Failed to analyze join. Please try again.');
    } finally {
      message.destroy('join-analysis-progress'); // Clear the loading message
      setIsAnalyzingJoin(false);
    }
  };

  // Helper function to get connected nodes for join analysis
  const getConnectedNodesForJoin = () => {
    // Get all nodes that are connected to this join node as inputs
    const connectedNodes = [];
    
    if (edges && node) {
      // Find all edges that connect to this join node as target
      const incomingEdges = edges.filter(edge => edge.target === node.id);
      
      incomingEdges.forEach(edge => {
        // Find the source node
        const sourceNode = nodes.find(n => n.id === edge.source);
        if (sourceNode) {
          let nodeSchema = null;
          let s3Key = null;
          // console.log('sourceNode: ', sourceNode)
          const config = sourceNode.data.config ? sourceNode.data.config : {};
          const connectionId = config.connectionId
          const dataset = config.dataset
          const sourceType = config.sourceType

          // Find the connection to get schema
          const connection = connections.find(c => c.id === connectionId);
          // console.log('connection: ', connection, config)
          if (connection && connection.dataStructures && connection.dataStructures.length > 0) {
            if(sourceType != 'csv'){
              const datasource = connection.dataStructures.find(d => d.sourceIdentifier === dataset)
              const availableSources = connection.availableSources.find(d => d.identifier === dataset)

              if(datasource){
                nodeSchema = datasource.columns.map(col => ({
                  name: col.name,
                  type: col.type
                }));
              }
              if(availableSources){
                s3Key = availableSources.s3Key
              }

            }else{
              nodeSchema = connection.dataStructures[0].columns.map(col => ({
                name: col.name,
                type: col.type
              }));
              s3Key = connection.fileInfo ? connection.fileInfo.fileName : connection.availableSources[0].s3Key
            }

          }
        
          
          connectedNodes.push({
            nodeId: sourceNode.id.replace('dataSource-', ''),
            dataset: dataset ? dataset : config.connectionName,
            connectionId: connectionId,
            s3Key: s3Key,
            schema: nodeSchema
          });
        }
      });
    }
    
    return connectedNodes;
  };

  const renderTransformerConfig = () => (
    <TransformerConfig
      node={node}
      onConfigUpdate={onConfigUpdate}
      transformationRequest={transformationRequest}
      setTransformationRequest={setTransformationRequest}
      transformationAnalysis={transformationAnalysis}
      transformationSteps={transformationSteps}
      isAnalyzingTransformation={isAnalyzingTransformation}
      handleAnalyzeTransformation={handleAnalyzeTransformation}
      onSave={handleConfigSave}
    />
  );

  const renderJoinConfig = () => (
    <JoinConfig
      node={node}
      onConfigUpdate={onConfigUpdate}
      joinDescription={joinDescription}
      setJoinDescription={setJoinDescription}
      joinAnalysis={joinAnalysis}
      isAnalyzingJoin={isAnalyzingJoin}
      handleAnalyzeJoin={handleAnalyzeJoin}
      onSave={handleConfigSave}
    />
  );

  const renderOutputConfig = () => (
    <OutputConfig
      node={node}
      onConfigUpdate={onConfigUpdate}
      handleSendTestEmail={handleSendTestEmail}
      handleTestAnalysis={handleTestAnalysis}
      onSave={handleConfigSave}
    />
  );

  const renderStartConfig = () => (
    <StartConfig 
      node={node} 
      onConfigUpdate={onConfigUpdate}
      onSave={handleConfigSave}
    />
  );

  const renderNodeConfig = () => {
    switch (node?.type) {
      case 'start':
        return renderStartConfig();
      case 'dataSource':
        return renderDataSourceConfig();
      case 'transformer':
        return renderTransformerConfig();
      case 'join':
        return renderJoinConfig();
      case 'output':
        return renderOutputConfig();
      default:
        return null;
    }
  };

  if (!isOpen || !node) {
    return null;
  }

  return (
    <div className={`workflow-sidebar ${isOpen ? 'open' : ''}`}>
      <div className="workflow-sidebar-content">
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '24px'
        }}>
          <Space>
            {getNodeIcon()}
            <Title level={4} style={{ margin: 0 }}>
              Configure {node.data.label}
            </Title>
          </Space>
          <Button 
            type="text" 
            icon={<CloseOutlined />} 
            onClick={onClose}
          />
        </div>


        <Card>
          {renderNodeConfig()}

          <Divider />

          {/* <Space>
            <Button 
              icon={<EyeOutlined />} 
              onClick={handlePreviewData}
              loading={isGeneratingPreview}
              disabled={node.type === 'join' && (!joinAnalysis || joinAnalysis?.error)}
              title={
                node.type === 'join' && !joinAnalysis ? 'Please run "Analyze Join" first' :
                node.type === 'join' && joinAnalysis?.error ? 'Please fix join analysis errors first' : ''
              }
            >
              Preview Data
            </Button>
          </Space> */}
        </Card>
        <div style={{ 
          marginBottom: '16px',
          padding: '8px 12px',
          backgroundColor: '#f5f5f5',
          borderRadius: '4px',
          border: '1px solid #d9d9d9'
        }}>
          <Text type="secondary" style={{ fontSize: '12px' }}>
            Node ID: 
          </Text>
          <Text 
            style={{ 
              fontSize: '10px', 
              fontFamily: 'monospace',
              marginLeft: '8px'
            }}
          >
            {node.id}
          </Text>
        </div> 
      </div>

      <DataPreviewModal
        open={isPreviewOpen}
        data={previewData}
        onClose={() => setIsPreviewOpen(false)}
      />

      <Modal
        title="Edit Data Source"
        open={isEditDataSourceOpen}
        onCancel={() => {
          setIsEditDataSourceOpen(false);
          setEditingConnection(null);
        }}
        footer={null}
        width={640}
        destroyOnClose
      >
        <LocalFileConnectionForm
          fileType={editingConnection?.fileType || editingConnection?.dbType || 'spreadsheet'}
          editingConnection={editingConnection}
          onSave={handleDataSourceSave}
          onCancel={() => {
            setIsEditDataSourceOpen(false);
            setEditingConnection(null);
          }}
        />
      </Modal>
 
    </div>
  );
};

export default NodeSidebar;