/**
 * DEPRECATED — commented out, kept for reference only.
 *
 * Transformer and Join nodes are no longer configured through a per-node chat
 * form. Both are built by the chat assistant through public/chat/workflowBuilder
 * (buildTransformerConfig / buildJoinConfig), and NodeChatPanel hands those node
 * types to the assistant instead of rendering this component — its import and
 * its JSX branch here have been commented out since that move.
 *
 * The file is commented line by line rather than wrapped in one block comment,
 * because the code below contains JSDoc blocks whose terminators would close a
 * wrapper early. Nothing imports this module; deleting it is safe whenever the
 * reference is no longer wanted.
 */

// import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
// import axios from 'axios';
// import { connectionsDb } from '../../../utils/localDb';
// import ChatArea from '../../Chat/ChatArea';
// import { qualifyLocalTableName } from '../../../utils/workflowNaming';
// import { buildChatPrompt } from '../../../utils/chatPrompts';
// import { loadTableSchema } from '../../../utils/tableSchemaUtils';
// import {
//   FileExcelOutlined,
//   FileTextOutlined,
//   DatabaseOutlined,
//   ApiOutlined,
//   CloudOutlined,
//   AppstoreOutlined,
// } from '@ant-design/icons';
// import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
// import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
// import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
// import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
// import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
// import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
// import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
// import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
// import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';
//
// const DESTINATION_GROUP_COLOR = {
//   'Cloud Storage': '#0891b2',
//   APIs: '#2563eb',
//   Vector: '#16a34a',
//   Databases: '#7c3aed',
//   'Local Files': '#d97706',
//   Other: '#5a6678',
// };
//
// const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);
//
// const categorizeConnection = (conn) => {
//   if (!conn) return 'Other';
//   if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
//   if (conn.dbCategory === 'API' || conn.dbType === 'rest-api') return 'APIs';
//   if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return 'Vector';
//   if (conn.connectionType === 'database') return 'Databases';
//   if (conn.connectionType === 'file') return 'Local Files';
//   return 'Other';
// };
//
// const getDbIcon = (dbType) => {
//   const iconMap = {
//     postgres: PostgresIcon,
//     mysql: MysqlIcon,
//     mssql: MssqlIcon,
//     mongodb: MongodbIcon,
//     sqlite: SqlliteIcon,
//     nedb: SqlliteIcon,
//     gcs: GoogleCloudStorageIcon,
//     dropbox: DropboxIcon,
//     'google-drive': GoogleDriveIcon,
//     'google-sheets': GoogleSheetsIcon,
//   };
//   return iconMap[dbType?.toLowerCase()] || null;
// };
//
// const getConnectionIcon = (connection) => {
//   if (!connection) return null;
//   const category = categorizeConnection(connection);
//   if (category === 'APIs') return <ApiOutlined style={{ fontSize: 18 }} />;
//   if (category === 'Vector') return <AppstoreOutlined style={{ fontSize: 18 }} />;
//   if (category === 'Cloud Storage') {
//     const IconComponent = getDbIcon(connection.dbType);
//     return IconComponent
//       ? <IconComponent style={{ width: 20, height: 20 }} />
//       : <CloudOutlined style={{ fontSize: 18 }} />;
//   }
//   if (connection.connectionType === 'file') {
//     const fileName = connection.fileInfo?.fileName?.toLowerCase() || '';
//     if (fileName.endsWith('.csv')) {
//       return <FileTextOutlined style={{ fontSize: 20 }} />;
//     }
//     const IconComponent = getDbIcon(connection.dbType);
//     if (IconComponent) {
//       return <IconComponent style={{ width: 20, height: 20 }} />;
//     }
//     return <FileExcelOutlined style={{ fontSize: 20 }} />;
//   }
//   const IconComponent = getDbIcon(connection.dbType);
//   return IconComponent
//     ? <IconComponent style={{ width: 20, height: 20 }} />
//     : <DatabaseOutlined style={{ fontSize: 18 }} />;
// };
//
// // ─────────────────────────────────────────────────────────────────────────────
// // Join Node Chat Component
// // Handles joining multiple data sources with intelligent configuration
// // ─────────────────────────────────────────────────────────────────────────────
//
// const formatTimestamp = (ts) => {
//   const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
//   if (diff < 1) return 'Just now';
//   if (diff < 60) return `${diff}m`;
//   return `${Math.floor(diff / 60)}h`;
// };
//
// const JoinNodeChat = ({
//   node,
//   nodes,
//   edges,
//   initialChat,
//   onSave,
//   onLoadDatabaseTables,
//   onConfigUpdate,
//   onPreviewConfigUpdate,
//   executeJoin,
//   executingInd,
//   executing = false,
//   workflowScopeId = null
// }) => {
//   const messagesEndRef = useRef(null);
//   const chatContainerRef = useRef(null);
//   const inputRef = useRef(null);
//   const initialized = useRef(false);
//   const userRequestRef = useRef(null);
//
//   const [chat, setChat] = useState(initialChat);
//   const [inputValue, setInputValue] = useState('');
//   const [loading, setLoading] = useState(false);
//   const [aiLoading, setAiLoading] = useState(false);
//
//   // Multiple source nodes (joins require 2+ inputs)
//   const [sourceNodes, setSourceNodes] = useState([]);
//   const [sourceConnections, setSourceConnections] = useState([]);
//   const [sourceTableSchemas, setSourceTableSchemas] = useState([]);
//
//   // Skills state
//   const [availableSkills, setAvailableSkills] = useState([]);
//   const [activeSkill, setActiveSkill] = useState(null); // { skillId, skillState: { code, params, etc. }, readyToExecute: bool }
//
//   // Destination/target configuration
//   const [targetConnection, setTargetConnection] = useState(null);
//   const [availableDestinations, setAvailableDestinations] = useState([]);
//   const [destinationTables, setDestinationTables] = useState([]); // Tables in destination for merge_existing
//
//   // Join configuration state
//   const [latestJoinConfig, setLatestJoinConfig] = useState(null);
//   const [saveState, setSaveState] = useState(false);
//   const [disableInput, setDisableInput] = useState(false);
//
//   // Error state for failed joins
//   const [executionError, setExecutionError] = useState(null);
//
//   // Join settings state
//   const [joinSettings, setJoinSettings] = useState({
//     operationMode: null,           // "new_table" or "merge_existing"
//     destinationSelection: null,    // Selected destination connection ID
//     targetTableName: null,         // Table name for output
//     joinColumns: [],               // Array of join conditions
//     selectedColumns: {},           // {sourceNodeId: [columns]}
//     userRequest: null              // Original user request
//   });
//
//   // Local joins all write into the one shared app-data.db, so a user/AI-chosen
//   // table name is prefixed with this workflow's token to stop two workflows
//   // dropping and recreating each other's table. Node-id defaults are already
//   // unique. Applied before the AI writes the DDL, which the executor runs
//   // verbatim.
//   const resolveJoinTableName = (settings) => {
//     const base = settings?.targetTableName || node.id.replace('-', '_').toLowerCase();
//     return qualifyLocalTableName(base, {
//       workflowId: workflowScopeId,
//       isLocal: !!settings?.destinationSelection?.startsWith('local-'),
//     });
//   };
//
//   const [pendingChoices, setPendingChoices] = useState([]);
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Initialize
//   // ─────────────────────────────────────────────────────────────────────────
//
//   /**
//    * Load available skills for join category
//    */
//   const loadAvailableSkills = async () => {
//     if (window.electronAPI?.skills?.getDescriptions) {
//       try {
//         // Determine operationType based on target connection dbType
//         const dbType = targetConnection?.dbType;
//         const operationType = dbType === 'mongodb' ? 'nosql' : 'sql';
//
//         // Load join skills with context
//         const result = await window.electronAPI.skills.getDescriptions('join', {
//           operationType,
//           sourceSchemas: sourceTableSchemas
//         });
//
//         if (result.success) {
//           // Vector cases are handled inline by generateJoinQuery (see Join.js
//           // prompt + analyzeJoinRequest). Hide vector-db-executor from the
//           // join-skill list so the AI doesn't try to route through its
//           // single-source buildSkillPrompt — that path returns an empty
//           // response when fed multi-source join params.
//           const filtered = (result.descriptions || [])
//             .filter((s) => s.id !== 'vector-db-executor');
//           console.log('[JoinNodeChat] Loaded skills:', filtered);
//           setAvailableSkills(filtered);
//         }
//       } catch (error) {
//         console.error('[JoinNodeChat] Failed to load skills:', error);
//       }
//     }
//   };
//
//   const initializationFunc = async () => {
//     const sourcesDetectionResult = await detectSourceNodes();
//
//     // Restore state from saved config if reopening a saved node
//     const savedConfig = node?.data?.config;
//     if (savedConfig && initialChat.length > 0) {
//       console.log('Restoring saved join config:', savedConfig);
//
//       // Restore latestJoinConfig
//       if (savedConfig.targetSql || savedConfig.aggregationPipeline) {
//         const restoredData = {
//           ddl: savedConfig.targetDdl || '',
//           sql: savedConfig.targetSql,
//           insertSql: savedConfig.targetInsertSql || null,
//           previewSql: savedConfig.targetPreviewSql || '',
//           explanation: savedConfig.targetSqlExplanation || '',
//           joinRequest: savedConfig.joinRequest || '',
//           joinSettings: savedConfig.joinSettings || null,
//           targetDbType: savedConfig.targetDbType || null,
//           joinColumns: savedConfig.joinColumns,
//           executionPlan: savedConfig.executionPlan
//         };
//
//         // Add NoSQL-specific fields if present
//         if (savedConfig.aggregationPipeline) {
//           restoredData.aggregationPipeline = savedConfig.aggregationPipeline;
//         }
//
//         setLatestJoinConfig(restoredData);
//       }
//
//       // Restore join settings
//       if (savedConfig.joinSettings) {
//         setJoinSettings(savedConfig.joinSettings);
//         if (savedConfig.joinSettings.userRequest) {
//           userRequestRef.current = savedConfig.joinSettings.userRequest;
//         }
//       }
//
//       // Restore target connection
//       if (savedConfig.targetConnectionId) {
//         const restoredConnection = availableDestinations.find(d => d.id === savedConfig.targetConnectionId);
//         if (restoredConnection) {
//           setTargetConnection(restoredConnection.connection);
//         }
//       }
//     } else {
//       // New node - start with destination selection
//       if (initialChat.length === 0 && sourcesDetectionResult) {
//         setDisableInput(true);
//
//         // Get destination choices - use the result directly since state might not be updated yet
//         if (sourcesDetectionResult.destinations && sourcesDetectionResult.destinations.length > 0) {
//           const choices = sourcesDetectionResult.destinations.map(dest => ({
//             label: dest.label,
//             value: dest.value,
//             description: dest.description,
//             _data: dest,
//             variant: 'outlined',
//             fullWidth: true,
//             icon: dest.icon,
//             group: dest.group,
//             groupColor: dest.groupColor,
//           }));
//
//           const questionText = `I detected ${sourcesDetectionResult.sources.length} data sources connected to this join node.\n\n**First, select where you want to store the joined data:**`;
//
//           setPendingChoices(choices);
//           addBotMessage(questionText, true, 'choice', 'destinationSelection', '', null);
//         }
//
//         setDisableInput(false);
//       }
//     }
//   };
//
//   useEffect(() => {
//     if (!initialized.current) {
//       initialized.current = true;
//       initializationFunc();
//     }
//   }, []);
//
//   // Load available skills when target connection and source schemas are ready
//   useEffect(() => {
//     if (targetConnection && sourceTableSchemas.length > 0) {
//       loadAvailableSkills();
//     }
//   }, [targetConnection, sourceTableSchemas]);
//
//   // Sync chat state with initialChat prop when node changes
//   useEffect(() => {
//     if (initialized.current && initialChat.length > 0) {
//       setChat(initialChat);
//     }
//   }, [node?.id, initialChat]);
//
//   // Auto-scroll to bottom when chat messages change
//   useEffect(() => {
//     if (messagesEndRef.current) {
//       messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
//     }
//   }, [chat]);
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Core Functions
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const addBotMessage = (text, responseRequired = false, responseType = 'text', ref = '', placeholder = '', metadata = null) => {
//     setChat(prev => [...prev, {
//       id: `bot-${Date.now()}-${Math.random()}`,
//       sender: 'bot',
//       text,
//       timestamp: new Date(),
//       responseRequired,
//       responseType,
//       ref,
//       placeholder: placeholder || 'Type your response…',
//       metadata,
//     }]);
//   };
//
//   const addUserMessage = (text, ref, value, data = null) => {
//     const userMsg = {
//       id: `user-${Date.now()}-${Math.random()}`,
//       sender: 'user',
//       text,
//       timestamp: new Date(),
//       ref,
//       value: value || text,
//       data,
//     };
//     setChat(prev => [...prev, userMsg]);
//     return userMsg;
//   };
//
//   // Surface an invalid (non-JSON / truncated) AI response cleanly: a short
//   // "Invalid response" message plus an expandable "raw response" node so the
//   // user can inspect exactly what the model returned. Stops the spinner.
//   const showInvalidResponse = (rawResponse) => {
//     const raw = typeof rawResponse === 'string'
//       ? rawResponse
//       : (() => { try { return JSON.stringify(rawResponse, null, 2); } catch (_) { return String(rawResponse); } })();
//     addBotMessage(
//       'Invalid response — the AI did not return a valid result. Expand "raw response" below to see what it returned, then try again or rephrase.',
//       false, 'text', '', '',
//       { invalidJson: raw || '(empty response)' }
//     );
//     setAiLoading(false);
//     setLoading(false);
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Detect Source Nodes
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const detectSourceNodes = async () => {
//     setLoading(true);
//
//     // Find all connected source nodes (must have 2 or more for join)
//     const connectedEdges = edges.filter(e => e.target === node.id);
//     if (connectedEdges.length < 2) {
//       addBotMessage('A join requires at least 2 connected data sources. Please connect more sources.', false);
//       setLoading(false);
//       return null;
//     }
//
//     const sources = [];
//     const connections = [];
//     const schemas = [];
//
//     // Load each connected source
//     for (const edge of connectedEdges) {
//       const sourceNode = nodes.find(n => n.id === edge.source);
//       if (!sourceNode || !sourceNode.data?.config) {
//         addBotMessage(`Source node "${sourceNode?.data?.label}" is not configured. Please configure all sources first.`, false);
//         setLoading(false);
//         return null;
//       }
//
//       const sourceConfig = sourceNode.data.config;
//       const nodeType = sourceConfig.nodeType;
//       const isDataSource = nodeType === 'datasource';
//
//       // Extract connection info (use target for transformers, source for data sources)
//       const connection = {
//         id: isDataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
//         name: isDataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
//         connectionType: isDataSource ? sourceConfig.sourceConnectionType : sourceConfig.targetConnectionType,
//         dbType: isDataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
//         dbConfig: isDataSource ? sourceConfig.sourceDbConfig : sourceConfig.targetDbConfig,
//         localPath: isDataSource ? sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath
//       };
//
//       // Get schema from saved config or load from database
//       let schema;
//       const savedSchema = isDataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;
//
//       if (savedSchema) {
//         schema = {
//           sourceNodeId: sourceNode.id,
//           sourceNodeLabel: sourceNode.data.label,
//           tableName: (isDataSource ? sourceConfig.sourceTableName : sourceConfig.targetTableName) ||
//                      (isDataSource ? sourceConfig.sourceCollection : sourceConfig.targetCollection) ||
//                      savedSchema.tableName,
//           columns: savedSchema.columns,
//           sampleData: savedSchema.sampleData
//         };
//       } else {
//         // Load schema from database
//         schema = await loadSourceTableSchema(sourceNode, connection);
//         if (schema) {
//           schema.sourceNodeId = sourceNode.id;
//           schema.sourceNodeLabel = sourceNode.data.label;
//         }
//       }
//       console.log('schema: ', sourceConfig, schema)
//       if (!schema) {
//         addBotMessage(`Failed to load schema for source "${sourceNode.data.label}".`, false);
//         setLoading(false);
//         return null;
//       }
//
//       sources.push(sourceNode);
//       connections.push(connection);
//       schemas.push(schema);
//     }
//
//     setSourceNodes(sources);
//     setSourceConnections(connections);
//     setSourceTableSchemas(schemas);
//
//     // Build available destinations list from ALL database connections
//     const destinations = [];
//     const seenConnectionIds = new Set();
//
//     // Load all database connections from the system
//     const token = localStorage.getItem('auth-token');
//     let allConnections = [];
//     // if (!token) {
//       allConnections = await connectionsDb.getAll();
//     // } else {
//     //   const res = await axios.post('/workflow/connections', { transformer: false }, {
//     //     headers: { 'auth-token': token },
//     //   });
//     //   allConnections = res.data || [];
//     // }
//
//     // Add all connections as potential destinations (deduplicated by connection ID),
//     // categorized so the picker shows separate sections for Databases, APIs, Vector
//     // stores, Cloud Storage, and Local Files.
//     allConnections.forEach((conn) => {
//       if (!conn || seenConnectionIds.has(conn.id)) return;
//       seenConnectionIds.add(conn.id);
//       const group = categorizeConnection(conn);
//       destinations.push({
//         id: conn.id,
//         label: conn.name,
//         value: conn.id,
//         description: `Store in ${conn.name} (${conn.dbType})`,
//         connection: conn,
//         icon: getConnectionIcon(conn),
//         group,
//         groupColor: DESTINATION_GROUP_COLOR[group] || DESTINATION_GROUP_COLOR.Other,
//       });
//     });
//
//     // Add local storage options (always available)
//     // One local destination: the join result is written as a Parquet file this
//     // node owns, and read back by DuckDB. Tabular and document data alike.
//     destinations.push({
//       id: 'local-duckdb',
//       label: 'Local file',
//       value: 'local-duckdb',
//       description: 'Store the result as a local file (Parquet)',
//       connection: { dbType: 'duckdb', connectionType: 'file' },
//       icon: <DatabaseOutlined style={{ fontSize: 18 }} />,
//       group: 'Local Files',
//       groupColor: DESTINATION_GROUP_COLOR['Local Files'],
//     });
//
//     setAvailableDestinations(destinations);
//     setLoading(false);
//
//     // Return both sources and destinations for immediate use
//     return {
//       sources,
//       destinations
//     };
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Load Source Table Schema
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const loadSourceTableSchema = async (source, connection) => {
//     if (!window.electronAPI?.dbConnect && connection.connectionType === 'database') {
//       console.warn('Database API not available');
//       return null;
//     }
//
//     try {
//       const sourceConfig = source?.data?.config || {};
//       const isNoSQL = connection.dbType === 'mongodb';
//
//       let tableName = null;
//       let tableSchema = null;
//       let localPath = null;
//       let queryConnection = connection;
//
//       if (isNoSQL) {
//         tableName = sourceConfig.targetCollection ||
//                     sourceConfig.sourceCollection ||
//                     sourceConfig.table;
//         localPath = sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
//
//       } else {
//         tableSchema = sourceConfig.targetSchema || sourceConfig.sourceSchema || connection.dbConfig?.schema;
//         tableName = sourceConfig.targetTableName ||
//                     sourceConfig.sourceTableName ||
//                     sourceConfig.table;
//       }
//
//       if (!tableName && !localPath) {
//         console.warn('Could not determine table name or local path from source config');
//         return null;
//       }
//
//       const schema = await loadTableSchema({
//         connection: queryConnection,
//         tableName,
//         tableSchema,
//         localPath,
//         limit: 5
//       });
//
//       return schema;
//     } catch (error) {
//       console.error('Failed to load source schema:', error);
//       return null;
//     }
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Handle User Responses
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const handleUserResponse = async (text, ref, value, data) => {
//     const userMsg = addUserMessage(text, ref, value, data);
//
//     if (ref === 'joinRequest' || ref === 'chatContinue') {
//       // Check if we're in skill mode
//       if (activeSkill) {
//         // Route to skill flow
//         await handleSkillFlow(userMsg);
//       } else {
//         // Normal join flow
//         await startJoinFlow(userMsg);
//       }
//     } else if (ref === 'skillFollowUp') {
//       // Skill follow-up question response
//       await handleSkillFlow(userMsg);
//     } else if (ref === 'destinationSelection') {
//       await handleDestinationResponse(value, data);
//     } else if (ref === 'operationMode') {
//       await handleOperationModeResponse(value);
//     } else if (ref === 'targetTableName') {
//       await handleTargetTableNameResponse(text);
//     }
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Multi-Step Join Configuration Flow
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const startJoinFlow = async (userMsg) => {
//     setAiLoading(true);
//     setLoading(true);
//
//     // Store user's request
//     userRequestRef.current = userMsg.text;
//     setJoinSettings(prev => ({
//       ...prev,
//       userRequest: userMsg.text
//     }));
//
//     // Clear any pending state
//     setPendingChoices([]);
//     setExecutionError(null);
//
//     try {
//       // Build sources information for AI
//       const sourcesInfo = sourceTableSchemas.map(schema => ({
//         label: schema.sourceNodeLabel,
//         tableName: schema.tableName,
//         columns: schema.columns,
//         sampleData: schema.sampleData
//       }));
//
//       const chatHistory = chat.map(msg => ({
//         sender: msg.sender,
//         text: msg.text
//       }));
//
//       // Analyze the join request to determine next steps
//       await analyzeJoinRequest(userMsg.text, sourcesInfo, chatHistory);
//     } catch (error) {
//       console.error('Join analysis error:', error);
//       addBotMessage(error?.message || `Failed to analyze your request. Error: ${error}`, false);
//       setAiLoading(false);
//       setLoading(false);
//     }
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Skill Flow - Dedicated flow for skill interactions
//   // ─────────────────────────────────────────────────────────────────────────
//
//   /**
//    * Handle all skill interactions through the skill's main function
//    * @param {Object} userMsg - User message object
//    * @param {Object} skillInfo - Optional skill info to use (for initial call when state hasn't updated yet)
//    */
//   const handleSkillFlow = async (userMsg, skillInfo = null) => {
//     const currentSkill = skillInfo || activeSkill;
//
//     if (!currentSkill || !currentSkill.skillId) {
//       console.error('[handleSkillFlow] No active skill');
//       addBotMessage('Error: No active skill found.', false);
//       setAiLoading(false);
//       setLoading(false);
//       return;
//     }
//
//     console.log('[handleSkillFlow] Processing request with skill:', currentSkill.skillId);
//
//     setAiLoading(true);
//     setLoading(true);
//
//     try {
//       // Build chat history
//       const chatHistory = chat.map(msg => ({
//         sender: msg.sender,
//         text: msg.text
//       }));
//
//       // Determine operationType
//       const dbType = targetConnection?.dbType;
//       const operationType = dbType === 'mongodb' ? 'nosql' : 'sql';
//
//       // Build source schemas for context
//       const sourcesInfo = sourceTableSchemas.map(schema => ({
//         label: schema.sourceNodeLabel,
//         tableName: schema.tableName,
//         columns: schema.columns,
//         sampleData: schema.sampleData
//       }));
//
//       // Step 1: Build the skill prompt
//       const promptResult = await window.electronAPI.skills.buildPrompt({
//         skillId: currentSkill.skillId,
//         params: {
//           userRequest: userMsg.text,
//           chatHistory,
//           sourceSchema: { sources: sourcesInfo }, // Join has multiple sources
//           operationType,
//           settings: joinSettings,
//           currentState: currentSkill.skillState || {}
//         }
//       });
//
//       if (!promptResult.success) {
//         addBotMessage(`Error building prompt: ${promptResult.message}`, false);
//         setAiLoading(false);
//         setLoading(false);
//         return;
//       }
//
//       let result;
//
//       if (promptResult.prompt) {
//         // Standard flow: skill returned a prompt to send to AI, then we hand
//         // the response back through processSkillResponse for validation.
//         const aiResponse = await getWorkflowAssistance(
//           `skill-${currentSkill.skillId}`,
//           promptResult.prompt,
//           promptResult.context,
//           chatHistory
//         );
//
//         // Defensive: an empty AI response means the skill prompt was malformed
//         // for the join context. Drop back to the standard join flow so the
//         // user sees something useful instead of a silent empty bot message.
//         if (!aiResponse || (typeof aiResponse === 'string' && aiResponse.trim() === '')) {
//           console.warn('[handleSkillFlow] Empty AI response; falling back to standard join flow.');
//           setActiveSkill(null);
//           setAiLoading(false);
//           setLoading(false);
//           addBotMessage(
//             `The ${currentSkill.skillId} skill could not produce a configuration for this join. Falling back to the standard join flow — please rephrase or describe your join in more detail.`,
//             true,
//             'text',
//             'joinRequest',
//             'Describe your join...'
//           );
//           return;
//         }
//
//         result = await window.electronAPI.skills.processResponse({
//           skillId: currentSkill.skillId,
//           aiResponse,
//           operationType,
//           currentState: currentSkill.skillState || {},
//           availableConnections: promptResult.context?.availableConnections
//         });
//
//         if (!result.success) {
//           addBotMessage(`Error: ${result.message}`, false);
//           setAiLoading(false);
//           setLoading(false);
//           return;
//         }
//       } else {
//         // Pre-resolved flow: skill orchestrated its own AI calls and returned
//         // a fully-validated result (action + relevant fields) at the top
//         // level. Skip the AI roundtrip and processResponse entirely.
//         result = promptResult;
//       }
//
//       console.log('[handleSkillFlow] Skill response:', result);
//
//       // Handle different actions
//       switch (result.action) {
//         case 'unrelateSkill':
//           // Exit skill mode and go back to normal flow
//           addBotMessage(
//             result.explanation || 'This request is not related to the skill join. Switching back to standard join flow.',
//             false
//           );
//           setActiveSkill(null);
//           setAiLoading(false);
//           setLoading(false);
//
//           // Re-process the request through normal flow
//           await startJoinFlow(userMsg);
//           break;
//
//         case 'answer_directly':
//           // Answer the user's question
//           setAiLoading(false);
//           setLoading(false);
//           addBotMessage(result.directAnswer || result.explanation, false);
//           addBotMessage(
//             'Continue refining your join, or execute when ready.',
//             true,
//             'text',
//             'chatContinue',
//             'Ask another question or refine the join...'
//           );
//           break;
//
//         case 'ask_questions':
//           // Ask follow-up questions
//           setAiLoading(false);
//           setLoading(false);
//           addBotMessage(
//             result.followUpQuestion || result.explanation,
//             true,
//             'text',
//             'skillFollowUp',
//             'Provide additional details...'
//           );
//           break;
//
//         case 'execute':
//           // Ready to execute - show save button
//           setAiLoading(false);
//           setLoading(false);
//
//           // Update skill state with execution params
//           const updatedSkill = {
//             ...currentSkill,
//             skillState: {
//               ...currentSkill.skillState,
//               ...result // Store all execution params
//             },
//             readyToExecute: true
//           };
//           setActiveSkill(updatedSkill);
//
//           // Prepare metadata to display code in chat
//           const skillMetadata = {
//             skillId: currentSkill.skillId,
//             ...result // Contains pythonCode or other skill-specific code
//           };
//
//           addBotMessage(
//             `✓ Join ready:\n${result.explanation || 'Ready to execute'}`,
//             false,
//             'text',
//             '',
//             '',
//             skillMetadata
//           );
//
//           // Re-enable chat input so users can refine before clicking Execute.
//           // chatContinue routes back through handleSkillFlow while activeSkill is set.
//           addBotMessage(
//             'Continue refining your join, or execute when ready.',
//             true,
//             'text',
//             'chatContinue',
//             'Ask another question or refine the join...'
//           );
//
//           // Set pending choices to show execute button
//           setPendingChoices([{
//             label: '▶ Execute & Save',
//             value: 'execute_skill',
//             variant: 'contained',
//             fullWidth: true
//           }]);
//           break;
//
//         default:
//           addBotMessage(`Unknown action: ${result.action}`, false);
//           setAiLoading(false);
//           setLoading(false);
//       }
//
//     } catch (error) {
//       console.error('[handleSkillFlow] Error:', error);
//       addBotMessage(`Error processing skill request: ${error.message}`, false);
//       setAiLoading(false);
//       setLoading(false);
//     }
//   };
//
//   const analyzeJoinRequest = async (userRequest, sourcesInfo, chatHistory = []) => {
//     const sourcesInfoStr = JSON.stringify(sourcesInfo, null, 2);
//
//     const hasVectorSource = sourceConnections.some(
//       (c) => c?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(c?.dbType)
//     );
//     const hasVectorDestination =
//       targetConnection?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(targetConnection?.dbType);
//
//     const analysisPrompt = await buildChatPrompt('join.joinAnalysisRequest', [
//       userRequest,
//       sourcesInfoStr,
//       availableDestinations.map(d => `${d.label} (${d.description})`).join('\n'),
//       joinSettings.operationMode,
//       availableSkills,
//       { hasVectorSource, hasVectorDestination },
//     ]);
//
//     const response = await getWorkflowAssistance('join', analysisPrompt, {
//       sources: sourcesInfo,
//       destinations: availableDestinations,
//       userRequest
//     }, chatHistory);
//
//     let analysis;
//     try {
//       analysis = JSON.parse(response);
//     } catch (e) {
//       // Invalid JSON (often truncated or wrapped in prose). Don't fall through
//       // to a generic "I need more details" re-prompt — surface a clear "Invalid
//       // response" with the raw text expandable, and abort.
//       console.error('Failed to parse join analysis JSON:', e, response);
//       showInvalidResponse(response);
//       return;
//     }
//
//     console.log('Join analysis:', analysis);
//
//     // Vector source/destination joins are handled inline by generateJoinQuery,
//     // not by a skill. The vector-db-executor skill's buildSkillPrompt is built
//     // for single-source transformer flows and produces an empty/garbled prompt
//     // when fed multi-source join params, so route those cases through the
//     // standard generate_join path instead.
//     if (analysis.usesSkill && analysis.skillId === 'vector-db-executor') {
//       console.log('[JoinNodeChat] Ignoring vector-db-executor skill route; handling vector join inline.');
//       analysis.usesSkill = false;
//       analysis.skillId = null;
//       if (analysis.action !== 'ask_questions' && analysis.action !== 'answer_directly') {
//         analysis.action = 'generate_join';
//       }
//     }
//
//     // Check if a skill was selected
//     if (analysis.usesSkill && analysis.skillId) {
//       console.log('[JoinNodeChat] Skill selected:', analysis.skillId);
//
//       // Find the skill name from availableSkills
//       const selectedSkill = availableSkills.find(s => s.id === analysis.skillId);
//       const skillName = selectedSkill?.name || analysis.skillId;
//
//       // Create skill info object
//       const skillInfo = {
//         skillId: analysis.skillId,
//         skillState: analysis.skillParams || {},
//         readyToExecute: false
//       };
//
//       // Activate skill mode
//       setActiveSkill(skillInfo);
//
//       // Add bot message explaining skill will be used
//       addBotMessage(
//         `Activating ${skillName}:\n${analysis.skillExplanation || analysis.explanation || ''}`,
//         false
//       );
//
//       // Automatically start skill flow with the user's request
//       // Create a mock user message object for the skill flow
//       const userMsgForSkill = {
//         text: userRequest,
//         timestamp: new Date()
//       };
//
//       // Call skill flow directly, passing the skill info since state hasn't updated yet
//       await handleSkillFlow(userMsgForSkill, skillInfo);
//       return; // End processing - skill flow is handling it
//     }
//
//     // Update join settings with inferred values
//     const inferredSettings = { ...joinSettings, ...analysis.inferredSettings };
//     inferredSettings.userRequest = userRequest;
//     // The analyser is the single authority for whether this join needs
//     // embedding/similarity-search code (Scenario B). Persist its decision so
//     // generateJoinConfiguration can gate the Scenario B prompt block.
//     inferredSettings.vectorRequired = analysis.vectorRequired === true;
//
//     setJoinSettings(inferredSettings);
//
//     if (analysis.action === 'answer_directly') {
//       // Just answer the question without creating a join
//       setAiLoading(false);
//       setLoading(false);
//       addBotMessage(analysis.directAnswer || 'Here is the information you requested.', false);
//       addBotMessage(
//         'Is there anything else you\'d like to know, or would you like to configure a join?',
//         true,
//         'text',
//         'joinRequest',
//         'Ask a question or describe a join...'
//       );
//     } else if (analysis.action === 'generate_join') {
//       // Request is clear - generate join immediately
//       setAiLoading(false);
//       setLoading(false);
//
//       const message = `✓ Join configuration complete.\nGenerating join query...`;
//       addBotMessage(message, false);
//
//       await generateJoinConfiguration(inferredSettings);
//     } else if (analysis.action === 'ask_questions') {
//       // Need to ask a follow-up question
//       setAiLoading(false);
//       setLoading(false);
//
//       const followUpQuestion = analysis.followUpQuestion || 'Can you provide more details about how you want to join these tables?';
//
//       // Ask the follow-up question and wait for user response
//       addBotMessage(followUpQuestion, true, 'text', 'joinRequest', 'Describe your join...');
//     }
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Choice Response Handlers
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const handleDestinationResponse = async (value, data) => {
//     const destination = data || availableDestinations.find(d => d.value === value);
//     if (!destination) {
//       addBotMessage('Invalid destination selection. Please try again.', false);
//       return;
//     }
//
//     setTargetConnection(destination.connection);
//
//     const updatedSettings = {
//       ...joinSettings,
//       destinationSelection: value
//     };
//
//     setJoinSettings(updatedSettings);
//
//     // Check if destination is NoSQL
//     const isNoSQL = destination.connection?.dbType === 'mongodb' ||
//                     value?.startsWith('local-mongodb');
//
//     // A local destination is this node's own output file, rewritten in full on
//     // every run — there is no existing table to merge into, so don't offer a
//     // choice that cannot be honoured.
//     const isLocalFileDestination = destination.connection?.dbType === 'duckdb' ||
//                     value === 'local-duckdb';
//
//     // For these destinations, automatically set to new_table and skip the question
//     if (isNoSQL || isLocalFileDestination) {
//       const updatedSettingsWithMode = {
//         ...updatedSettings,
//         operationMode: 'new_table'
//       };
//       setJoinSettings(updatedSettingsWithMode);
//
//       // Proceed directly to join request
//       addBotMessage(
//         'Great! Now, please describe how you want to join these sources.',
//         true,
//         'text',
//         'joinRequest',
//         'Describe your join...'
//       );
//       setPendingChoices([]);
//       return;
//     }
//
//     // For SQL destinations, ask about operation mode
//     const operationModeChoices = [
//       {
//         label: 'New Table',
//         value: 'new_table',
//         description: 'Create a new table with the joined data',
//         variant: 'outlined',
//         fullWidth: true
//       },
//       {
//         label: 'Merge into Existing',
//         value: 'merge_existing',
//         description: 'Merge joined data into an existing table',
//         variant: 'outlined',
//         fullWidth: true
//       }
//     ];
//
//     setPendingChoices(operationModeChoices);
//
//     // Then add bot message
//     addBotMessage(
//       'How should the join be executed?',
//       true,
//       'choice',
//       'operationMode',
//       '',
//       null
//     );
//   };
//
//   const handleOperationModeResponse = async (value) => {
//     const updatedSettings = {
//       ...joinSettings,
//       operationMode: value
//     };
//
//     setJoinSettings(updatedSettings);
//
//     // If merge_existing, ask which table to merge into
//     if (value === 'merge_existing') {
//       setLoading(true);
//
//       // Load tables from destination connection
//       try {
//         const isLocalPlaceholder = targetConnection?.id?.startsWith('local-');
//
//         let tables = [];
//         if (isLocalPlaceholder) {
//           // For local storage, we can't list tables easily, ask user to type
//           addBotMessage(
//             'What is the name of the existing table you want to merge into?',
//             true,
//             'text',
//             'targetTableName',
//             'Enter table name...'
//           );
//           setLoading(false);
//           return;
//         } else {
//           // Load tables from database connection using the prop function
//           const result = await onLoadDatabaseTables(targetConnection);
//
//           if (result.success) {
//             tables = result.tables || [];
//           }
//         }
//
//         if (tables.length === 0) {
//           addBotMessage(
//             'No tables found in the destination. What table name would you like to use?',
//             true,
//             'text',
//             'targetTableName',
//             'Enter table name...'
//           );
//         } else {
//           setDestinationTables(tables);
//
//           // Create choices from tables
//           const tableChoices = tables.map(table => ({
//             label: table.schema ? `${table.schema}.${table.name}` : table.name,
//             value: table.name,
//             description: `Merge into ${table.name}`,
//             variant: 'outlined',
//             fullWidth: true,
//             displayType: 'dropdown'
//           }));
//
//           setPendingChoices(tableChoices);
//           addBotMessage(
//             'Select the existing table you want to merge the joined data into:',
//             true,
//             'choice',
//             'targetTableName',
//             'Select table...'
//           );
//         }
//       } catch (error) {
//         console.error('Error loading destination tables:', error);
//         addBotMessage(
//           'Could not load tables from destination. What table name would you like to use?',
//           true,
//           'text',
//           'targetTableName',
//           'Enter table name...'
//         );
//       } finally {
//         setLoading(false);
//       }
//     } else {
//       setPendingChoices([]);
//
//       // For new_table, proceed directly to join request
//       addBotMessage(
//         'Great! Now, please describe how you want to join these sources.',
//         true,
//         'text',
//         'joinRequest',
//         'Describe your join...'
//       );
//     }
//   };
//
//   const handleTargetTableNameResponse = async (tableName) => {
//     const updatedSettings = {
//       ...joinSettings,
//       targetTableName: tableName
//     };
//
//     setJoinSettings(updatedSettings);
//
//     // Clear any pending choices from table selection
//     setPendingChoices([]);
//
//     // After getting table name, we should have all basic info - ask for join description
//     addBotMessage(
//       'Now, please describe how you want to join these sources.',
//       true,
//       'text',
//       'joinRequest',
//       'Describe your join...'
//     );
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // AI Join Configuration Generation
//   // ─────────────────────────────────────────────────────────────────────────
//
//   /**
//    * Handle execute skill button click
//    */
//   const handleExecuteSkill = async () => {
//     if (!activeSkill || !activeSkill.readyToExecute) {
//       addBotMessage('Skill is not ready to execute. Please complete the configuration first.', false);
//       return;
//     }
//
//     // Clear pending choices
//     setPendingChoices([]);
//
//     addBotMessage('Skill-based joins are not yet fully implemented. This feature will execute the skill and save the configuration.', false);
//
//     // TODO: Implement skill execution for joins
//     // For now, just notify the user
//     addBotMessage(
//       'The skill execution framework is ready, but join-specific execution logic needs to be implemented.',
//       false
//     );
//   };
//
//   const generateJoinConfiguration = async (settings) => {
//     setAiLoading(true);
//     setLoading(true);
//
//     const targetDbType = targetConnection?.dbType ||
//                         (settings.destinationSelection?.startsWith('local-')
//                           ? settings.destinationSelection.replace('local-', '')
//                           : 'duckdb');
//
//     const isNoSQL = targetDbType === 'mongodb';
//     const isVectorDestination =
//       targetConnection?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(targetDbType);
//     // A local destination writes a file via DuckDB — no temp tables to stage
//     // sources into, so its sources need far less from the model.
//     const isLocalDestination = targetDbType === 'duckdb';
//
//     const targetTableName = resolveJoinTableName(settings);
//
//     const destinationConnectionId = targetConnection?.id || settings.destinationSelection;
//
//     // Build sources info for AI with preprocessing to determine what's needed
//     const sourcesInfo = sourceTableSchemas.map((schema, idx) => {
//       const sourceConnectionId = sourceConnections[idx]?.id;
//       const sourceDbType = sourceConnections[idx]?.dbType;
//       const isSourceNoSQL = sourceDbType === 'mongodb';
//       const isSourceVector =
//         sourceConnections[idx]?.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(sourceDbType);
//       const isSourceLocalFile = sourceDbType === 'duckdb';
//       const isInDestinationDb = sourceConnectionId === destinationConnectionId;
//
//       // Determine what fields are needed for this source
//       let requiredFields = [];
//
//       if (isVectorDestination) {
//         // Vector destination: JS join in memory; pull each source however appropriate.
//         if (isSourceVector) requiredFields = ['vectorFetchOperation'];
//         else if (isSourceNoSQL) requiredFields = ['nosqlOperation'];
//         else requiredFields = ['sql'];
//       } else if (isNoSQL) {
//         // NoSQL Destination: Everything loaded into memory, no temp tables
//         if (isSourceVector) {
//           requiredFields = ['vectorFetchOperation']; // Skill pulls vectors as rows
//         } else if (isSourceNoSQL) {
//           requiredFields = ['nosqlOperation']; // Query to fetch from NoSQL source
//         } else {
//           requiredFields = ['sql']; // Query to fetch from SQL source
//         }
//       } else if (isLocalDestination) {
//         // Local destination: DuckDB reads each source and writes one file.
//         // A local file source needs nothing but a name to be referred to by —
//         // it is read where it sits, so no DDL and no staging query. Remote
//         // sources still need their rows fetched, but DuckDB infers the types,
//         // so they need no DDL either.
//         if (isSourceLocalFile) {
//           requiredFields = ['tempTableName'];
//         } else if (isSourceVector) {
//           requiredFields = ['tempTableName', 'vectorFetchOperation', 'selectedColumns'];
//         } else if (isSourceNoSQL) {
//           requiredFields = ['tempTableName', 'nosqlOperation', 'selectedColumns'];
//         } else {
//           requiredFields = ['tempTableName', 'sql', 'selectedColumns'];
//         }
//       } else {
//         if (isSourceVector) {
//           // Vector source feeding a SQL destination: skill pulls rows, executor inserts into a temp table
//           requiredFields = ['tempTableName', 'ddl', 'vectorFetchOperation', 'insertSql'];
//         } else if (isSourceNoSQL) {
//           requiredFields = ['tempTableName', 'ddl', 'nosqlOperation', 'insertSql']; // Query to fetch from NoSQL source
//         } else if (isInDestinationDb) {
//           // Source already in destination - reference directly in joinSql
//           requiredFields = []; // No temp table needed
//         } else {
//           // External source - needs temp table
//           requiredFields = ['tempTableName', 'ddl', 'sql', 'insertSql'];
//         }
//       }
//
//       return {
//         sourceNodeId: schema.sourceNodeId,
//         sourceNodeLabel: schema.sourceNodeLabel,
//         tableName: schema.tableName,
//         columns: schema.columns,
//         sampleData: schema.sampleData,
//         connectionId: sourceConnectionId,
//         dbType: sourceDbType,
//         connectionType: sourceConnections[idx]?.connectionType,
//         // Surface the local file path so the AI can pass it as ctx.runQuery's
//         // dbPath when this source is a local nedb / sqlite / lancedb file.
//         localPath: sourceConnections[idx]?.localPath || null,
//         isInDestinationDb: isInDestinationDb,
//         isSourceVector,
//         requiredFields: requiredFields
//       };
//     });
//
//     // True when any source — or the destination — is a local nedb / sqlite /
//     // lancedb file. Gates the dbPath note in the join-generation prompt.
//     const LOCAL_DB_TYPES_FOR_PROMPT = new Set(['duckdb', 'lancedb']);
//     const hasLocalSource = sourcesInfo.some((s) => s.localPath);
//     const destinationIsLocal = LOCAL_DB_TYPES_FOR_PROMPT.has(targetDbType);
//
//     const destinationConfig = {
//       dbType: targetDbType,
//       tableName: targetTableName,
//       operationMode: settings.operationMode,
//       connectionId: destinationConnectionId,
//       isVectorDestination,
//       // Set by the analyser (joinAnalysisRequest) — true only when the join
//       // needs runtime embedding / similarity-search logic (Scenario B). Gates
//       // the JS-function-with-ctx block in the generation prompt.
//       vectorRequired: settings.vectorRequired === true,
//       // Gates the local-dbPath note in the prompt (cheap to compute, keeps the
//       // section out of the prompt when no local file is involved).
//       hasLocalConnection: hasLocalSource || destinationIsLocal
//     };
//
//     const chatHistory = chat.slice(0, -1).map(msg => ({
//       sender: msg.sender,
//       text: msg.text
//     }));
//
//     try {
//       const joinPrompt = await buildChatPrompt('join.generateJoinQuery', [
//         targetDbType,
//         sourcesInfo,
//         settings,
//         destinationConfig,
//       ]);
//       console.log('[JoinNodeChat] Vector context for join prompt:', {
//         isVectorDestination,
//         vectorSources: sourcesInfo.filter((s) => s.isSourceVector).map((s) => s.sourceNodeId)
//       });
//
//       const response = await getWorkflowAssistance('join', joinPrompt, {
//         sources: sourcesInfo,
//         destination: destinationConfig,
//         joinSettings: settings
//       }, chatHistory);
//
//       let parsedResponse;
//       try {
//         parsedResponse = JSON.parse(response);
//       } catch (e) {
//         // Invalid/truncated JSON — never mark anything runnable (TLX-012).
//         // Show a clear "Invalid response" with the raw text expandable.
//         console.error('Failed to parse join response JSON:', e, response);
//         setSaveState(false);
//         showInvalidResponse(response);
//         return;
//       }
//
//       console.log('Join configuration:', parsedResponse);
//
//       // Enrich sourcesConfig with connection information
//       if (parsedResponse.sourcesConfig) {
//         parsedResponse.sourcesConfig = parsedResponse.sourcesConfig.map((sourceConfig) => {
//           const sourceIndex = sourceTableSchemas.findIndex(
//             schema => schema.sourceNodeId === sourceConfig.sourceNodeId
//           );
//
//           if (sourceIndex !== -1) {
//             const connection = sourceConnections[sourceIndex];
//             return {
//               ...sourceConfig,
//               connection: {
//                 id: connection.id,
//                 dbType: connection.dbType,
//                 dbConfig: connection.dbConfig,
//                 fileInfo: connection.fileInfo,
//                 localPath: connection.localPath
//               }
//             };
//           }
//           return sourceConfig;
//         });
//       }
//
//       // Add targetTableName if not provided by AI
//       if (!parsedResponse.targetTableName) {
//         parsedResponse.targetTableName = targetTableName || node.id.replace(/-/g, '_').toLowerCase();
//       }
//
//       // Build execution plan (same for SQL and NoSQL)
//       const executionPlan = buildExecutionPlan(sourcesInfo, destinationConfig, parsedResponse);
//
//       // Apply join configuration
//       const joinConfig = {
//         ...parsedResponse,
//         targetDbType,
//         executionPlan,
//         joinSettings: settings,
//         joinRequest: settings.userRequest
//       };
//
//       // For NoSQL or vector destinations, the join runs in JS — surface the
//       // function as transformFunction (the executor reads either name).
//       if ((isNoSQL || isVectorDestination) && parsedResponse.javascriptFunction) {
//         joinConfig.transformFunction = parsedResponse.javascriptFunction;
//       }
//
//       // Completeness gate — never present an incomplete/invalid config as
//       // runnable (TLX-012). A SQL join needs a non-empty joinSql; a NoSQL/
//       // vector join needs its JavaScript function. If the model's output was
//       // truncated or missing the runnable piece, refuse to enable Run.
//       const needsJsFunction = isNoSQL || isVectorDestination;
//       const hasRunnable = needsJsFunction
//         ? !!(parsedResponse.javascriptFunction && String(parsedResponse.javascriptFunction).trim())
//         : !!(parsedResponse.joinSql && String(parsedResponse.joinSql).trim());
//
//       if (!hasRunnable) {
//         // Valid JSON, but it's missing the runnable join query/function.
//         setSaveState(false);
//         setLatestJoinConfig(null);
//         addBotMessage(
//           `✗ I couldn't produce a complete join configuration — it did not include a runnable join query.\n\nNothing has been marked ready to run. Please try again, or simplify the request (fewer columns, avoid CTEs/temp tables).`,
//           false
//         );
//         addBotMessage(
//           'Describe the join again or refine your request…',
//           true,
//           'text',
//           'chatContinue',
//           'Ask a follow-up question or request changes…'
//         );
//         return;
//       }
//
//       setLatestJoinConfig(joinConfig);
//       setSaveState(true);
//
//       // Display explanation
//       const executionNote = isVectorDestination
//         ? '\n\n**Note:** This join runs locally in JavaScript; the vector-db-executor skill embeds the chosen column and upserts vectors into the destination.'
//         : (isNoSQL
//           ? '\n\n**Note:** This join will be executed using JavaScript in the local environment, then uploaded to the destination database.'
//           : '');
//
//       addBotMessage(
//         `✓ Join configuration generated!\n\n${parsedResponse.explanation || 'Join is ready to execute.'}${executionNote}`,
//         false,
//         'text',
//         null,
//         '',
//         {
//           sourcesConfig: parsedResponse.sourcesConfig,
//           targetDdl: parsedResponse.targetDdl,
//           joinSql: parsedResponse.joinSql,
//           joinColumns: parsedResponse.joinColumns,
//           selectedColumns: parsedResponse.selectedColumns,
//           javascriptFunction: parsedResponse.javascriptFunction
//         }
//       );
//
//       addBotMessage(
//         'You can refine this join or click Run & Save Configuration when ready.',
//         true,
//         'text',
//         'chatContinue',
//         'Ask a follow-up question or request changes…'
//       );
//
//     } catch (error) {
//       console.error('Join generation error:', error);
//       // Prefer the plain-language provider error when we have one.
//       addBotMessage(error?.message || 'Failed to generate join configuration. Please try again.', false);
//     } finally {
//       setAiLoading(false);
//       setLoading(false);
//     }
//   };
//
//   const buildExecutionPlan = (sources, destination, joinConfig) => {
//     const plan = {
//       steps: []
//     };
//
//     // Step 1-N: Load each source into temp table in destination
//     sources.forEach((source, idx) => {
//       const tempTableName = `temp_join_${node.id}_source${idx + 1}_${Date.now()}`.replace(/-/g, '_');
//
//       plan.steps.push({
//         type: 'load_temp_table',
//         stepNumber: idx + 1,
//         sourceNodeId: source.sourceNodeId,
//         sourceLabel: source.sourceNodeLabel,
//         sourceTable: source.tableName,
//         tempTableName: tempTableName,
//         action: `Extract data from "${source.sourceNodeLabel}" and load into temp table "${tempTableName}" in destination database`,
//         connection: source.connection
//       });
//     });
//
//     // Final step: Execute join on temp tables
//     plan.steps.push({
//       type: 'execute_join',
//       stepNumber: plan.steps.length + 1,
//       action: `Execute join on temporary tables and insert into "${destination.tableName}"`,
//       outputTable: destination.tableName
//     });
//
//     return plan;
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Build Configuration
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const buildConfig = async () => {
//     if (!sourceConnections || sourceConnections.length === 0) return {};
//
//     const isNoSQL = targetConnection?.dbType === 'mongodb';
//     const isLocalStorage = joinSettings.destinationSelection?.startsWith('local-');
//
//     // Base configuration
//     const config = {
//       nodeType: 'join',
//
//       // Multiple sources
//       sources: sourceNodes.map((sourceNode, idx) => ({
//         sourceNodeId: sourceNode.id,
//         sourceNodeLabel: sourceNode.data?.label,
//         sourceConnectionId: sourceConnections[idx]?.id,
//         sourceConnectionName: sourceConnections[idx]?.name,
//         sourceConnectionType: sourceConnections[idx]?.connectionType,
//         sourceDbType: sourceConnections[idx]?.dbType,
//         sourceTableSchema: sourceTableSchemas[idx],
//         sourceTableName: sourceTableSchemas[idx]?.tableName,
//         sourceCollection: sourceTableSchemas[idx]?.tableName,
//         sourceLocalPath: sourceConnections[idx]?.localPath
//       }))
//     };
//
//     if (!latestJoinConfig) return config;
//
//     // Join settings
//     config.joinRequest = latestJoinConfig.joinRequest || userRequestRef.current;
//     config.joinSettings = joinSettings;
//     config.joinColumns = latestJoinConfig.joinColumns;
//     config.executionPlan = latestJoinConfig.executionPlan;
//
//     // Store sourcesConfig and join configuration for execution
//     config.sourcesConfig = latestJoinConfig.sourcesConfig;
//     config.joinSql = latestJoinConfig.joinSql;
//     config.targetDdl = latestJoinConfig.targetDdl;
//     config.transformFunction = latestJoinConfig.transformFunction || latestJoinConfig.javascriptFunction;
//     if (latestJoinConfig.vectorDestination) {
//       config.vectorDestination = latestJoinConfig.vectorDestination;
//     }
//
//     // Target configuration
//     const targetTableName = resolveJoinTableName(joinSettings);
//
//     if (isLocalStorage) {
//       // A local join result is a Parquet file this node owns, read by DuckDB.
//       // Vector destinations keep their own token and are handled above.
//       const localDbType = joinSettings.destinationSelection === 'local-lancedb' ? 'lancedb' : 'duckdb';
//       config.targetConnectionId = `local-${localDbType}`;
//       config.targetConnectionName = localDbType === 'lancedb' ? 'Local LanceDB' : 'Local file';
//       config.targetConnectionType = 'file';
//       config.targetDbType = localDbType;
//       config.targetDbConfig = {};
//     } else {
//       config.targetConnectionId = targetConnection?.id;
//       config.targetConnectionName = targetConnection?.name;
//       config.targetConnectionType = targetConnection?.connectionType || 'database';
//       config.targetDbType = targetConnection?.dbType;
//       config.targetDbConfig = targetConnection?.dbConfig || {};
//     }
//
//     // NoSQL vs SQL specific config
//     if (isNoSQL) {
//       config.targetCollection = targetTableName;
//       config.aggregationPipeline = latestJoinConfig.aggregationPipeline;
//       config.targetPreviewSql = JSON.stringify({
//         collection: targetTableName,
//         filter: {},
//         limit: 100
//       });
//
//       if (isLocalStorage || latestJoinConfig.localPath) {
//         config.targetLocalPath = latestJoinConfig.localPath;
//       }
//     } else {
//       config.targetTableName = targetTableName;
//       config.targetDdl = latestJoinConfig.targetDdl || '';
//       config.targetSql = latestJoinConfig.sql;
//       config.targetInsertSql = latestJoinConfig.insertSql || null;
//       config.targetSqlExplanation = latestJoinConfig.explanation || '';
//
//       if (isLocalStorage) {
//         // Local SQLite storage
//         const previewResult = await window.electronAPI.dbConnect.getPreviewQuery('sqlite', targetTableName, 100);
//         config.targetPreviewSql = latestJoinConfig.previewSql || previewResult.previewQuery;
//         config.targetLocalPath = latestJoinConfig.localPath;
//       } else {
//         const targetSchema = targetConnection?.dbConfig?.schema;
//         const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
//           targetConnection.dbType,
//           targetTableName,
//           targetSchema,
//           targetConnection.dbConfig,
//           targetConnection.id
//         );
//         const fullTableName = quotedResult.quotedIdentifier;
//
//         // Use database-specific preview query
//         const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
//           targetConnection.dbType,
//           fullTableName,
//           100
//         );
//         config.targetPreviewSql = latestJoinConfig.previewSql || previewResult.previewQuery;
//       }
//     }
//
//     return config;
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Execute Join
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const handleSave = async () => {
//     setSaveState(false);
//     setExecutionError(null);
//     let localPathFromResult = null;
//
//     const isNoSQL = targetConnection?.dbType === 'mongodb';
//     const targetTableName = resolveJoinTableName(joinSettings);
//
//     // Execute join using the new executeJoin function
//     executingInd(true);
//
//     const result = await executeJoin({
//       destinationConnection: targetConnection,
//       joinConfig: latestJoinConfig,
//       operationMode: joinSettings.operationMode || 'new_table',
//       onSuccess: (res) => {
//         addBotMessage(`✓ ${res.message}`, false);
//         if (res.localPath) {
//           addBotMessage(`📁 ${isNoSQL ? 'Local collection' : 'Local SQLite database'} saved at: ${res.localPath}`, false);
//           localPathFromResult = res.localPath;
//           setLatestJoinConfig(prev => ({ ...prev, localPath: res.localPath }));
//         }
//       },
//       onError: (err) => {
//         addBotMessage(`✗ Join failed: ${err.error || err.message}`, false);
//         setExecutionError({
//           error: err.error || err.message,
//           joinConfig: latestJoinConfig
//         });
//       }
//     });
//
//     executingInd(false);
//
//     if (!result.success) return;
//
//     // Fetch joined table schema after successful execution
//     let joinedSchema = null;
//     try {
//       const isLocalStorage = joinSettings.destinationSelection?.startsWith('local-');
//       const targetDbType = targetConnection?.dbType ||
//                           (joinSettings.destinationSelection?.startsWith('local-')
//                             ? joinSettings.destinationSelection.replace('local-', '')
//                             : 'sqlite');
//
//       const schemaLocalPath = isLocalStorage ? localPathFromResult : null;
//
//       if (isNoSQL) {
//         joinedSchema = await loadTableSchema({
//           connection: isLocalStorage ? { dbType: targetDbType, dbConfig: {} } : targetConnection,
//           tableName: targetTableName,
//           localPath: schemaLocalPath
//         });
//       } else {
//         joinedSchema = await loadTableSchema({
//           connection: isLocalStorage ? { dbType: 'sqlite', dbConfig: {} } : targetConnection,
//           tableName: targetTableName,
//           tableSchema: targetConnection?.dbConfig?.schema,
//           localPath: schemaLocalPath
//         });
//       }
//     } catch (error) {
//       console.error('Failed to fetch joined schema:', error);
//     }
//
//     setSaveState(false);
//
//     // Save configuration
//     const config = await buildConfig();
//
//     // Add local path if returned from execution
//     if (localPathFromResult) {
//       config.targetLocalPath = localPathFromResult;
//     }
//
//     // Add joined table schema
//     if (joinedSchema) {
//       config.targetTableSchema = joinedSchema;
//     }
//
//     console.log('Saving join config:', config);
//     onSave(config, chat);
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // UI Helpers
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const getCurrentQuestion = () => {
//     for (let i = 0; i < chat.length; i++) {
//       const msg = chat[i];
//       if (msg.sender === 'bot' && msg.responseRequired) {
//         const nextMsg = chat[i + 1];
//         if (!nextMsg || nextMsg.sender !== 'user') {
//           return msg;
//         }
//       }
//     }
//     return null;
//   };
//
//   const currentQ = getCurrentQuestion();
//
//   const getPlaceholder = () => {
//     if (!currentQ) return '';
//     return currentQ.placeholder || 'Type your response…';
//   };
//
//   const handleSendMessage = () => {
//     const text = inputValue.trim();
//     if (!text || !currentQ) return;
//     setInputValue('');
//     handleUserResponse(text, currentQ.ref, text, null);
//   };
//
//   const handleKeyPress = (e) => {
//     if (e.key === 'Enter' && !e.shiftKey) {
//       e.preventDefault();
//       handleSendMessage();
//     }
//   };
//
//   const displayChoices = () => {
//     if (loading || aiLoading || executing) return [];
//
//     if (pendingChoices.length > 0) {
//       return pendingChoices;
//     }
//
//     if (executionError) {
//       return [{
//         label: '🔧 Ask AI to Fix Error',
//         value: 'fix_error',
//         variant: 'outlined',
//         fullWidth: true
//       }];
//     }
//
//     if (saveState) {
//       return [{ label: 'Run & Save Configuration', value: 'save', variant: 'contained', fullWidth: true }];
//     }
//
//     return [];
//   };
//
//   const handleChoiceClick = (choice) => {
//     if (choice.value === 'save') {
//       handleSave();
//       return;
//     }
//
//     if (choice.value === 'fix_error') {
//       const errorText = executionError?.error || 'an unknown error';
//       // Feed the FAILING code + error back to the model so it can patch the
//       // specific problem, instead of restarting and re-asking for columns the
//       // user already gave. The failed SQL/function is injected into the chat
//       // history via this user message.
//       const failedCfg = executionError?.joinConfig || latestJoinConfig || {};
//       const failedSql = failedCfg.joinSql || failedCfg.targetSql || '';
//       const failedFn = failedCfg.transformFunction || failedCfg.javascriptFunction || '';
//       let message = `The join failed at execution with this error:\n${errorText}\n\n`;
//       if (failedSql) message += `The join query that failed was:\n\`\`\`sql\n${failedSql}\n\`\`\`\n\n`;
//       if (failedFn) message += `The join function that failed was:\n\`\`\`javascript\n${failedFn}\n\`\`\`\n\n`;
//       message += `Diagnose the cause and return a corrected join configuration. Reuse the configuration I already provided — do not ask me to re-specify columns or join type; fix only what caused the error.`;
//       setExecutionError(null);
//       handleUserResponse(message, 'chatContinue', message, null);
//       return;
//     }
//
//     if (choice.value === 'execute_skill') {
//       handleExecuteSkill();
//       return;
//     }
//
//     const currentQ = getCurrentQuestion();
//     if (!currentQ) return;
//
//     handleUserResponse(
//       choice.label,
//       currentQ.ref,
//       choice.value,
//       choice._data || null
//     );
//   };
//
//   const displayMessages = chat.map(m => ({
//     id: m.id,
//     text: m.text,
//     metadata: m.metadata,
//     sender: m.sender,
//     timestamp: m.timestamp || new Date(),
//   }));
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Code popup wiring
//   // ─────────────────────────────────────────────────────────────────────────
//   const safeParseJson = (str) => {
//     if (typeof str !== 'string') return str;
//     try { return JSON.parse(str); } catch { return str; }
//   };
//
//   const handleCodeSave = useCallback((field, value, message) => {
//     setChat(prev => prev.map(m =>
//       m.id === message?.id
//         ? { ...m, metadata: { ...m.metadata, [field]: value } }
//         : m
//     ));
//
//     if (!onConfigUpdate || !node?.id) return;
//
//     let update;
//     switch (field) {
//       case 'sql':
//         update = { targetSql: value };
//         break;
//       case 'ddl':
//       case 'targetDdl':
//         update = { targetDdl: value };
//         break;
//       case 'joinSql':
//         update = { targetSql: value, joinSql: value };
//         break;
//       case 'joinColumns':
//         update = { joinColumns: safeParseJson(value) };
//         break;
//       case 'selectedColumns':
//         update = { selectedColumns: safeParseJson(value) };
//         break;
//       case 'sourcesConfig':
//         update = { sourcesConfig: safeParseJson(value) };
//         break;
//       case 'javascriptFunction':
//         update = { javascriptFunction: value };
//         break;
//       case 'pythonCode':
//         update = { pythonCode: value };
//         break;
//       default:
//         update = { [field]: value };
//     }
//     onConfigUpdate(node.id, update);
//   }, [onConfigUpdate, node?.id]);
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Render
//   // ─────────────────────────────────────────────────────────────────────────
//
//   return (
//     <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
//       <ChatArea
//         hideHeader
//         isFullscreen={false}
//         currentChatTitle=""
//         multiStepData={null}
//         handleFullscreen={() => {}}
//         handleToggleChat={() => {}}
//         chatContainerRef={chatContainerRef}
//         messages={displayMessages}
//         isLoading={loading || aiLoading}
//         progressInfo={{ progress: 0, stage: (loading || aiLoading) ? 'Processing...' : '' }}
//         messagesEndRef={messagesEndRef}
//         inputRef={inputRef}
//         inputValue={inputValue}
//         setInputValue={setInputValue}
//         handleKeyPress={handleKeyPress}
//         handleSendMessage={handleSendMessage}
//         formatTimestamp={formatTimestamp}
//         onSaveToMain={null}
//         choices={displayChoices()}
//         onChoiceSelect={handleChoiceClick}
//         inputPlaceholder={getPlaceholder()}
//         disableInput={disableInput}
//         showRunButton={false}
//         onRun={null}
//         runButtonLoading={false}
//         onCodeSave={handleCodeSave}
//       />
//     </div>
//   );
// };
//
// export default JoinNodeChat;
//