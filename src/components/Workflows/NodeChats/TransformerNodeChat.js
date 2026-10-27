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
// import ChatArea from '../../Chat/ChatArea';
// import { qualifyLocalTableName } from '../../../utils/workflowNaming';
// import { buildChatPrompt } from '../../../utils/chatPrompts';
// import { loadTableSchema } from '../../../utils/tableSchemaUtils';
// // ─────────────────────────────────────────────────────────────────────────────
// // Transformer Node Chat Component
// // Handles custom transformations and enrichments
// // ─────────────────────────────────────────────────────────────────────────────
//
// const formatTimestamp = (ts) => {
//   const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
//   if (diff < 1) return 'Just now';
//   if (diff < 60) return `${diff}m`;
//   return `${Math.floor(diff / 60)}h`;
// };
//
// const TransformerNodeChat = ({
//   node,
//   nodes,
//   edges,
//   initialChat,
//   onSave,
//   onConfigUpdate,
//   onPreviewConfigUpdate,
//   executeTransformation,
//   getSourceLocalPath,
//   executingInd,
//   executing = false,
//   workflowScopeId = null
// }) => {
//   const messagesEndRef = useRef(null);
//   const chatContainerRef = useRef(null);
//   const inputRef = useRef(null);
//   const initialized = useRef(false);
//   const userRequestRef = useRef(null); // Store latest user request
//
//   const [chat, setChat] = useState(initialChat);
//   const [inputValue, setInputValue] = useState('');
//   const [loading, setLoading] = useState(false);
//   const [aiLoading, setAiLoading] = useState(false);
//
//   // Source data state (single source node)
//   const [sourceNode, setSourceNode] = useState(null); // Connected source node
//   const [sourceConnection, setSourceConnection] = useState(null); // Source connection
//   const [sourceTableSchema, setSourceTableSchema] = useState(null); // { tableName, columns, sampleData }
//   const [latestWithSQL, setLatestWithSQL] = useState(null);
//   const [saveState, setSaveState] = useState(false);
//   const [disableInput, setDisableInput] = useState(false);
//
//   // Skills state
//   const [availableSkills, setAvailableSkills] = useState([]);
//   const [activeSkill, setActiveSkill] = useState(null); // { skillId, skillState: { code, params, etc. }, readyToExecute: bool }
//
//   // Error state for failed transformations
//   const [executionError, setExecutionError] = useState(null); // { error: string, transformation: object }
//
//   // Transformation settings state
//   const [transformationSettings, setTransformationSettings] = useState({
//     operationMode: null,      // "new_table" or "in_place"
//     storageLocation: null,    // "database" or "local" (storage location)
//     userRequest: null,        // original user request
//     tableName: null           // custom output table/collection name
//   });
//   const [pendingChoices, setPendingChoices] = useState([]);
//   const [questionsNeeded, setQuestionsNeeded] = useState({}); // Object: { operationMode: "question text", ... }
//   const [questionKeys, setQuestionKeys] = useState([]); // Array of question keys to iterate through
//   const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Initialize
//   // ─────────────────────────────────────────────────────────────────────────
//
//   /**
//    * Load available skills for transformer category
//    */
//   const loadAvailableSkills = async () => {
//     if (window.electronAPI?.skills?.getDescriptions) {
//       try {
//         // Determine operationType based on source connection dbCategory
//         const dbType = sourceConnection?.dbType;
//         const operationType = sourceConnection?.dbCategory ? sourceConnection.dbCategory.toLowerCase() : 'sql';
//
//         // Load transformer skills with context
//         const result = await window.electronAPI.skills.getDescriptions('transformer', {
//           operationType,
//           sourceSchema: sourceTableSchema
//         });
//
//         if (result.success) {
//           console.log('[TransformerNodeChat] Loaded skills:', result.descriptions);
//           setAvailableSkills(result.descriptions || []);
//         }
//       } catch (error) {
//         console.error('[TransformerNodeChat] Failed to load skills:', error);
//       }
//     }
//   };
//
//   const initializationFunc = async () => {
//     const source_name = await detectSourceNode();
//
//     // Restore state from saved config if reopening a saved node
//     const savedConfig = node?.data?.config;
//     if (savedConfig && initialChat.length > 0) {
//       console.log('Restoring saved transformer config:', savedConfig);
//
//       // Restore latestWithSQL - read from target* prefixes (saved config) and store without prefix (internal state)
//       if (savedConfig.targetSql || savedConfig.operationType) {
//         const restoredData = {
//           ddl: savedConfig.targetDdl || '',
//           sql: savedConfig.targetSql,
//           insertSql: savedConfig.targetInsertSql || null,
//           previewSql: savedConfig.targetPreviewSql || '',
//           explanation: savedConfig.targetSqlExplanation || '',
//           transformationRequest: savedConfig.transformationRequest || '',
//           transformationSettings: savedConfig.transformationSettings || null,
//           targetDbType: savedConfig.targetDbType || null
//         };
//
//         // Add NoSQL-specific fields if present (MongoDB or NeDB)
//         if (savedConfig.operationType) {
//           restoredData.operationType = savedConfig.operationType;
//           restoredData.nosqlOperation = savedConfig.nosqlOperation;
//           restoredData.transformFunction = savedConfig.transformFunction;
//           restoredData.sourceCollection = savedConfig.sourceCollection;
//           restoredData.targetCollection = savedConfig.targetCollection;
//           restoredData.localPath = savedConfig.targetLocalPath;
//         }
//
//         setLatestWithSQL(restoredData);
//       }
//
//       // Restore transformation settings
//       if (savedConfig.transformationSettings) {
//         setTransformationSettings(savedConfig.transformationSettings);
//         // Also restore userRequest to ref
//         if (savedConfig.transformationSettings.userRequest) {
//           userRequestRef.current = savedConfig.transformationSettings.userRequest;
//         }
//       }
//       // After restoring a previously-built node (including ones the workflow
//       // assistant pre-populated), leave the input enabled so the user can
//       // ask follow-up questions about the existing config.
//       setDisableInput(false);
//     } else {
//       // New node - detect source and start chat
//       if (initialChat.length === 0) {
//         setDisableInput(true);
//         // Show connected source
//         addBotMessage(
//           `Connected to source: ${source_name}\n\nDescribe how you want to transform this data:`,
//           true,
//           'text',
//           'transformationRequest',
//           'Describe the transformation…'
//         );
//         setDisableInput(false);
//
//       }
//     }
//   }
//
//
//   useEffect(() => {
//     if (!initialized.current) {
//       initialized.current = true;
//       initializationFunc()
//     }
//   }, []);
//
//   // Load available skills when source connection and table schema are ready
//   useEffect(() => {
//     if (sourceConnection && sourceTableSchema) {
//       loadAvailableSkills();
//     }
//   }, [sourceConnection, sourceTableSchema]);
//
//   // Sync chat state with initialChat prop when node changes
//   useEffect(() => {
//     if (initialized.current && initialChat.length > 0) {
//       setChat(initialChat);
//     }
//     // console.log('node?.id, initialChat: ', )
//   }, [node?.id, initialChat]);
//
//   // Auto-scroll to bottom when chat messages change
//   useEffect(() => {
//     if (messagesEndRef.current) {
//       messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
//     }
//   }, [chat]);
//
//   // Update node config when SQL changes to trigger data preview refresh
//   useEffect(() => {
//     if (latestWithSQL && latestWithSQL.previewSql && onPreviewConfigUpdate && sourceConnection) {
//       const previewConfig = {
//         connectionId: sourceConnection.id,
//         connectionName: sourceConnection.name,
//         connectionType: sourceConnection.connectionType,
//         dbType: sourceConnection.dbType,
//         dbConfig: sourceConnection.dbConfig,
//         sourceType: sourceConnection.dbType,
//         ddl: latestWithSQL.ddl || '',
//         sql: latestWithSQL.sql,
//         previewSql: latestWithSQL.previewSql,
//         sqlExplanation: latestWithSQL.explanation,
//         transformationRequest: latestWithSQL.transformationRequest
//       };
//
//       onPreviewConfigUpdate(node.id, previewConfig);
//     }
//   }, [latestWithSQL?.previewSql, sourceConnection]);
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
//   // Detect Source Node
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const detectSourceNode = async () => {
//     setLoading(true);
//
//     // Find connected source node (only one)
//     const connectedEdges = edges.filter(e => e.target === node.id);
//     if (connectedEdges.length === 0) {
//       addBotMessage('No source node connected. Please connect a data source or another transformer first.', false);
//       setLoading(false);
//       return;
//     }
//
//     // Get the first (and only) connected source
//     const sourceNodeId = connectedEdges[0].source;
//     const source = nodes.find(n => n.id === sourceNodeId);
//
//     if (!source || !source.data?.config) {
//       addBotMessage('Source node is not configured. Please configure the source node first.', false);
//       setLoading(false);
//       return;
//     }
//
//     // Extract connection info from source node
//     const sourceConfig = source.data.config;
//     // console.log('sourceConfig: ', sourceConfig, connectedEdges[0]);
//     const nodeType = sourceConfig.nodeType;
//     const dataSource = nodeType === 'datasource';
//
//     // If source is a transformer, use its target properties as our source
//     const connection = {
//       id: dataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
//       name: dataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
//       connectionType: dataSource ? sourceConfig.sourceConnectionType : sourceConfig.targetConnectionType,
//       dbType: dataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
//       dbConfig: dataSource ? sourceConfig.sourceDbConfig : sourceConfig.targetDbConfig,
//       localPath: dataSource ?  sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath,
//       dbCategory: dataSource ?  sourceConfig.sourceDbCategory : sourceConfig.targetDbCategory,
//       indexName: dataSource ? sourceConfig.sourceIndexName : sourceConfig.targetIndexName // For Pinecone
//     };
//
//     // Get schema from saved config (if available) or load from database
//     let schema;
//     // Try target schema first (for transformer chains), then source schema (for data sources)
//     const savedSchema = dataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;
//     if (savedSchema) {
//       // Schema is already saved in the source node config
//       schema = {
//         sourceNodeLabel: source.data.label,
//         tableName: sourceConfig.targetTableName || sourceConfig.sourceTableName || sourceConfig.targetCollection || sourceConfig.sourceCollection || savedSchema.tableName,
//         indexName: dataSource ? sourceConfig.sourceIndexName : sourceConfig.targetIndexName, // For Pinecone
//         namespace: dataSource ? sourceConfig.sourceNamespace : sourceConfig.targetNamespace, // For Pinecone
//         schema: dataSource ? sourceConfig.sourceSchema : sourceConfig.targetSchema, // Schema field (also used for namespace in some cases)
//         columns: savedSchema.columns,
//         sampleData: savedSchema.sampleData
//       };
//       // console.log('savedSchema: ', schema);
//     } else {
//       // Fallback: load schema from database (old nodes that don't have schema saved)
//       console.log('Schema not found in config, loading from database...');
//       schema = await loadSourceTableSchema(source, connection);
//       if (schema) {
//         schema.sourceNodeLabel = source.data.label;
//       }
//     }
//
//     if (!schema) {
//       addBotMessage('Failed to load source schema. Please check the source configuration.', false);
//       setLoading(false);
//       return;
//     }
//
//     console.log('detectSourceNode: ', source, connection, schema);
//     setSourceNode(source);
//     setSourceConnection(connection);
//     setSourceTableSchema(schema);
//
//     setLoading(false);
//     setDisableInput(false);
//     return source.data.label
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Load Source Table Schema
//   // ─────────────────────────────────────────────────────────────────────────
//
//
//   const loadSourceTableSchema = async (source, connection) => {
//     if (!window.electronAPI?.dbConnect) {
//       console.warn('Database API not available');
//       return null;
//     }
//
//     try {
//       const sourceConfig = source?.data?.config || {};
//       const nodeType = sourceConfig.nodeType;
//       const dataSource = nodeType === 'datasource';
//       const isNoSQL = connection.dbType === 'mongodb' || connection.dbType === 'nedb';
//
//       let tableName = null;
//       let tableSchema = null;
//       let localPath = null;
//       let queryConnection = connection;
//       let indexName = null;
//       let namespace = null;
//
//       if (isNoSQL) {
//         // 1. Resolve NoSQL/NeDB identifiers
//         // Try target first (for transformer chains), then source (for data sources)
//         tableName = sourceConfig.targetCollection ||
//                     sourceConfig.sourceCollection ||
//                     sourceConfig.table ||
//                     sourceConfig.selectedTables?.[0];
//
//         localPath = sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
//
//         // Workaround: loadTableSchema expects 'mongodb' to trigger the localPath/NeDB logic.
//         // If it's 'nedb', we temporarily mask it as 'mongodb' so it doesn't fall into the SQL block.
//         if (connection.dbType === 'nedb') {
//           queryConnection = { ...connection, dbType: 'mongodb' };
//         }
//       } else {
//         // 2. Resolve SQL identifiers
//         tableSchema = sourceConfig.targetSchema || sourceConfig.sourceSchema || sourceConfig.dbConfig?.schema || null;
//
//         tableName = sourceConfig.targetTableName ||
//                     sourceConfig.sourceTableName ||
//                     sourceConfig.table ||
//                     (source.id ? source.id.replace('-', '_').toLowerCase() : null);
//
//         // For vector databases (Pinecone), extract indexName and namespace
//         indexName = dataSource ? sourceConfig.sourceIndexName : sourceConfig.targetIndexName;
//         namespace = dataSource ? sourceConfig.sourceNamespace : sourceConfig.targetNamespace;
//       }
//
//       if (!tableName && !localPath) {
//         console.warn('Could not determine table name or local path from source config');
//         return null;
//       }
//
//       // 3. Call the unified utility function
//       const schema = await loadTableSchema({
//         connection: queryConnection,
//         tableName,
//         tableSchema,
//         localPath,
//         limit: 5 // Matching your original sample size
//       });
//
//       // 4. Add vector database fields if applicable
//       if (schema && indexName) {
//         schema.indexName = indexName;
//       }
//       if (schema && namespace) {
//         schema.namespace = namespace;
//       }
//       if (schema && tableSchema && !schema.schema) {
//         schema.schema = tableSchema;
//       }
//
//       console.log('Loaded source schema:', schema);
//       return schema;
//
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
//     if (ref === 'transformationRequest' || ref === 'chatContinue') {
//       // Check if we're in skill mode
//       if (activeSkill) {
//         // Route to skill flow
//         await handleSkillFlow(userMsg);
//       } else {
//         // Normal transformation flow
//         await startTransformationFlow(userMsg);
//       }
//     } else if (ref === 'skillFollowUp') {
//       // Skill follow-up question response
//       await handleSkillFlow(userMsg);
//     } else if (ref === 'operationMode') {
//       await handleOperationModeResponse(value);
//     } else if (ref === 'storageLocation') {
//       await handleStorageLocationResponse(value);
//     }
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Multi-Step Transformation Configuration Flow
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const startTransformationFlow = async (userMsg) => {
//     setAiLoading(true);
//     setLoading(true);
//
//     // Store the user's request in both state and ref
//     userRequestRef.current = userMsg.text;
//     setTransformationSettings(prev => ({
//       ...prev,
//       userRequest: userMsg.text
//     }));
//
//     // Clear any pending state
//     setPendingChoices([]);
//     setQuestionsNeeded({});
//     setQuestionKeys([]);
//     setCurrentQuestionIndex(0);
//     setExecutionError(null); // Clear any previous error state
//
//     try {
//       // Check if source is a vector database - route directly to vector skill
//       if (sourceConnection?.dbCategory === 'Vector') {
//         console.log('Vector database detected - routing to vector-db-executor skill');
//
//         const skillInfo = {
//           skillId: 'vector-db-executor',
//           skillState: { isSourceVector: true },
//           readyToExecute: false
//         };
//
//         setActiveSkill(skillInfo);
//         await handleSkillFlow(userMsg, skillInfo);
//         return;
//       }
//
//       // Build chat history for AI context
//       const chatHistory = chat.map(msg => ({
//         sender: msg.sender,
//         text: msg.text
//       }));
//
//       // Analyze the request to determine what to do next
//       await analyzeTransformationRequest(userMsg.text, chatHistory);
//     } catch (error) {
//       console.error('Analysis error:', error);
//       addBotMessage(error?.message || `Failed to analyze your request. Error: ${error}`, false);
//       setAiLoading(false);
//       setLoading(false);
//     }
//   };
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
//       const dbType = sourceConnection?.dbType;
//       const operationType = ['mongodb', 'nedb'].includes(dbType) ? 'nosql' : 'sql';
//
//       // Step 1: Build the skill prompt
//       const promptResult = await window.electronAPI.skills.buildPrompt({
//         skillId: currentSkill.skillId,
//         params: {
//           userRequest: userMsg.text,
//           chatHistory,
//           sourceTableSchema: sourceTableSchema,
//           sourceConnection: sourceConnection,
//           operationType,
//           settings: transformationSettings,
//           currentState: currentSkill.skillState || {}
//         }
//       });
//       console.log('promptResult: ', promptResult)
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
//
//       console.log('[handleSkillFlow] Skill response:', result);
//
//       // Handle different actions
//       switch (result.action) {
//         case 'unrelateSkill':
//           // Exit skill mode and go back to normal flow
//           addBotMessage(
//             result.explanation || 'This request is not related to the skill transformation. Switching back to standard transformation flow.',
//             false
//           );
//           setActiveSkill(null);
//           setAiLoading(false);
//           setLoading(false);
//
//           // Re-process the request through normal flow
//           await startTransformationFlow(userMsg);
//           break;
//
//         case 'answer_directly':
//           // Answer the user's question
//           setAiLoading(false);
//           setLoading(false);
//           addBotMessage(result.directAnswer || result.explanation, false);
//           addBotMessage(
//             'Continue refining your transformation, or execute when ready.',
//             true,
//             'text',
//             'chatContinue',
//             'Ask another question or refine the transformation...'
//           );
//           break;
//
//         case 'ask_questions':
//           // Ask follow-up questions
//           setAiLoading(false);
//           setLoading(false);
//
//           // Format questions from questionsNeeded object
//           let questionText = result.followUpQuestion || result.explanation || 'I need some additional information:';
//
//           if (result.questionsNeeded && typeof result.questionsNeeded === 'object') {
//             const questions = Object.entries(result.questionsNeeded)
//               .filter(([key, question]) => question && question.trim() !== '') // Filter out empty questions
//               .map(([key, question]) => `• ${question}`)
//               .join('\n\n');
//
//             if (questions) {
//               questionText = `I need some additional information:\n\n${questions}`;
//             }
//           }
//
//           addBotMessage(
//             questionText,
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
//               ...result // Store all execution params (pythonCode, etc.)
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
//             `✓ Transformation ready:\n${result.explanation || 'Ready to execute'}`,
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
//             'Continue refining your transformation, or execute when ready.',
//             true,
//             'text',
//             'chatContinue',
//             'Ask another question or refine the transformation...'
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
//   // console.log('sourceNode: ', sourceNode)
//   const analyzeTransformationRequest = async (userRequest, chatHistory = []) => {
//     var finalSettings = {};
//
//     // Get properly quoted source table name with schema
//     const sourceSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
//     const dbType = sourceConnection?.dbType;
//     const dbCategory = sourceConnection?.dbCategory;
//     const isNoSQL = dbCategory === 'NoSQL' || ['mongodb', 'nedb'].includes(dbType);
//     const isVectorDB = dbCategory === 'Vector';
//
//     let sourceFullTableName = sourceTableSchema.tableName || 'unknown';
//     if (!isNoSQL && dbType !== 'sqlite' && sourceSchema) {
//       const quotedSourceResult = await window.electronAPI.dbConnect.quoteIdentifier(
//         dbType,
//         sourceTableSchema.tableName,
//         sourceSchema,
//         sourceConnection?.dbConfig,
//         sourceConnection?.id
//       );
//       sourceFullTableName = quotedSourceResult.quotedIdentifier;
//     } else if (sourceSchema) {
//       sourceFullTableName = `${sourceSchema}.${sourceTableSchema.tableName}`;
//     }
//
//     // Build source table information
//     const sourceTableInfo = `
// Source: ${sourceTableSchema.sourceNodeLabel}
// - Table/Collection name: ${sourceFullTableName}
// - Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
// - Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
//     `;
//
//     // Determine if source is local (data stored in local file vs remote database)
//     const isSourceLocal = isFileLocal()
//
//     const analysisPrompt = await buildChatPrompt('transfomer.transformationRequest', [
//       userRequest,
//       sourceTableInfo,
//       isVectorDB ? 'vector' : sourceConnection.dbType,
//       isSourceLocal,
//       availableSkills,
//     ]);
//
//     const response = await getWorkflowAssistance('transformer', analysisPrompt, {
//       sourceTable: sourceTableSchema.tableName,
//       sourceSchema: sourceTableSchema,
//       dbType: sourceConnection.dbType,
//       userRequest
//     }, chatHistory);
//
//     // console.log('Analysis response:', response);
//
//     let analysis = null;
//     try {
//       analysis = JSON.parse(response);
//     } catch (e) {
//       // The model returned invalid JSON (often truncated or wrapped in prose).
//       // Do NOT fall through to the question flow — that previously leaked the
//       // raw "operationMode" field name into the UI. Surface a clear "Invalid
//       // response" with the raw text expandable, and abort.
//       console.error('Failed to parse analysis JSON:', e, response);
//       showInvalidResponse(response);
//       return;
//     }
//
//     console.log('Parsed analysis:', analysis);
//
//     // The model may omit these fields; ensure they always exist so downstream
//     // property access (e.g. analysis.questionsNeeded.storageLocation) is safe.
//     if (!analysis.questionsNeeded) analysis.questionsNeeded = {};
//     if (!analysis.inferredSettings) analysis.inferredSettings = {};
//
//     // Check if a skill was selected
//     if (analysis.usesSkill && analysis.skillId) {
//       console.log('[TransformerNodeChat] Skill selected:', analysis.skillId);
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
//     if(!analysis.inferredSettings.operationMode) delete analysis.inferredSettings.operationMode
//     if(!analysis.inferredSettings.storageLocation) delete analysis.inferredSettings.storageLocation
//
//     // Update transformation settings with inferred values
//     const inferredSettings = {...transformationSettings, ...analysis.inferredSettings};
//     inferredSettings.tableName = analysis.tableName || transformationSettings.tableName || node.id.replace(/-/g, '_').toLowerCase();
//
//     // Default operationMode to 'new_table' if null and not being asked
//     if (!inferredSettings.operationMode && !analysis.questionsNeeded.operationMode) {
//       inferredSettings.operationMode = 'new_table';
//     }
//     // console.log('sourceNode?.data?.config?.targetLocalPath: ', sourceNode?.data?.config)
//     // Default storageLocation based on source type if null and not being asked.
//     // Important: only fill a default when the analyser didn't already infer one —
//     // otherwise an explicit "store locally" request on a DB source (where
//     // isFileLocal() is false) would get silently overwritten back to 'database'.
//     if (isFileLocal()) {
//       // A local-file source has no remote DB to write back to, so force local.
//       inferredSettings.storageLocation = 'local';
//     } else if (!inferredSettings.storageLocation && !analysis.questionsNeeded.storageLocation) {
//       inferredSettings.storageLocation = 'database';
//     }
//
//     setTransformationSettings(inferredSettings);
//
//     if(analysis.questionsNeeded && Object.keys(analysis.questionsNeeded).length){
//       analysis.action = 'ask_questions'
//     }
//     // console.log('after_change:', analysis);
//
//     // Handle the determined action
//     if (analysis.action === 'answer_directly') {
//       // Answer the question directly without generating transformation
//       setAiLoading(false);
//       setLoading(false);
//       addBotMessage(analysis.directAnswer || 'Here is the information you requested.', false);
//       addBotMessage(
//         'Is there anything else you\'d like to know, or would you like to create a transformation?',
//         true,
//         'text',
//         'chatContinue',
//         'Ask a question or describe a transformation...'
//       );
//     } 
//     // else if (analysis.action === 'refine_transformation') {
//     //   // User wants to refine the existing transformation
//     //   setAiLoading(false);
//     //   setLoading(false);
//
//     //   const update = analysis.transformationUpdate || {};
//
//     //   // Apply the transformation result using consolidated helper
//     //   const success = applyTransformationResult(update, inferredSettings, userRequest, true);
//
//     //   if (success) {
//     //     addBotMessage(
//     //       'Continue refining, or click Run & Save Configuration when ready.',
//     //       true,
//     //       'text',
//     //       'chatContinue',
//     //       'Ask another question...'
//     //     );
//     //   }
//     // } 
//     else if (analysis.action === 'generate_transformation') {
//       // Request is clear enough - generate transformation immediately
//       setAiLoading(false);
//       setLoading(false);
//
//       finalSettings = {
//         ...transformationSettings,
//         operationMode: inferredSettings.operationMode,
//         storageLocation: inferredSettings.storageLocation,
//         tableName: inferredSettings.tableName,
//         userRequest: userRequest
//       };
//
//       setTransformationSettings(finalSettings);
//       const message = `✓ Request understood.\nGenerating transformation with:\n${[`• Mode: ${ finalSettings.operationMode === 'in_place' ?  'Updating Source Table' : 'Creating a New Table' }`,
//         `• Storage Location: ${ finalSettings.storageLocation === 'database' ? 'Database' : 'Local' }`
//       ].filter(Boolean).join('\n')}`;
//       addBotMessage(message, false);
//
//       await generateTransformation(finalSettings);
//     } else {
//       // Need to ask questions
//       setAiLoading(false);
//       setLoading(false);
//
//       const questionsObj = analysis.questionsNeeded || {};
//       let keys = Object.keys(questionsObj);
//
//       // Reset settings for questions that need to be asked (questionsNeeded supersedes current settings)
//       const resetSettings = {};
//       keys.forEach(key => {
//         resetSettings[key] = null;
//       });
//       // console.log('transformationSettings: ', transformationSettings, resetSettings, inferredSettings)
//
//       // Apply the reset to transformationSettings
//       setTransformationSettings(prev => ({
//         ...prev,
//         ...inferredSettings
//       }));
//
//       setQuestionsNeeded(questionsObj);
//       setQuestionKeys(keys);
//       setCurrentQuestionIndex(0);
//
//       if (keys.length === 0) {
//         // No questions needed but action is ask_questions - should not happen, but handle gracefully
//         finalSettings = {
//           ...transformationSettings,
//           operationMode: inferredSettings.operationMode || 'new_table',
//           storageLocation: inferredSettings.storageLocation || 'database',
//           tableName: inferredSettings.tableName,
//           userRequest
//         };
//         setTransformationSettings(finalSettings);
//         await generateTransformation(finalSettings);
//         return;
//       }
//
//       // Ask the first question - pass the fresh values instead of relying on state
//       askNextQuestion(questionsObj, keys, 0, finalSettings);
//     }
//   };
//
//   const askNextQuestion = (questionsObj = questionsNeeded, keys = questionKeys, index = currentQuestionIndex, currentSettings = null) => {
//     console.log('finalSettings: ', currentSettings, transformationSettings)
//     // Update state to reflect current values
//     setQuestionsNeeded(questionsObj);
//     setQuestionKeys(keys);
//     setCurrentQuestionIndex(index);
//
//     // Use passed settings or fall back to state
//     const settingsToUse = currentSettings || transformationSettings;
//     console.log('questionsObj: ', questionsObj, keys, index, settingsToUse)
//
//     // Check if there are more questions to ask
//     let currentIndex = index;
//     while (currentIndex < keys.length) {
//       const questionType = keys[currentIndex];
//
//       // Check dependencies - skip question if dependency not met
//       if (questionType === 'storageLocation') {
//         // Only ask for storage location (storageLocation) if operationMode is new_table AND source is database
//         if (settingsToUse.operationMode !== 'new_table') {
//           currentIndex++;
//           continue;
//         }
//       }
//
//       // Update the current question index in state
//       setCurrentQuestionIndex(currentIndex);
//
//       // Get the question text from questionsNeeded object. Never show the raw
//       // internal field name (e.g. "operationMode") to the user — fall back to a
//       // human-friendly label when the AI omitted the text or echoed the key
//       // back (TLX-009).
//       const rawText = typeof questionsObj?.[questionType] === 'string' ? questionsObj[questionType].trim() : '';
//       const questionText = (rawText && rawText !== questionType) ? rawText : getDefaultQuestionText(questionType);
//
//       // Get the choices for this question
//       const choices = getDefaultChoices(questionType);
//
//       if (choices.length > 0) {
//         // Display the question with choices
//         displayQuestionWithChoices(questionType, questionText, choices);
//         return;
//       } else {
//         // No choices - display as text input question
//         addBotMessage(questionText, true, 'text', questionType, '', null);
//         return;
//       }
//
//     }
//
//     // No more questions - generate transformation
//     const finalSettings = {
//       ...settingsToUse,
//       // Always use the latest userRequest from ref to ensure it's not lost due to async state updates
//       userRequest: userRequestRef.current || transformationSettings.userRequest
//     };
//
//     // Fill in any missing settings with defaults
//     if (!finalSettings.operationMode) finalSettings.operationMode = 'new_table';
//
//     // For storage location, apply defaults based on operation mode and source type
//     if (!finalSettings.storageLocation) {
//       finalSettings.storageLocation = sourceNode?.data?.config?.sourceConnectionType === 'database' ? 'database' : 'local' ;
//     }
//
//     setTransformationSettings(finalSettings);
//     generateTransformation(finalSettings);
//   };
//
//   const getDefaultQuestionText = (questionType) => {
//     const questionTexts = {
//       operationMode: 'How would you like to handle the transformation output?',
//       storageLocation: 'Where should the data be stored?'
//     };
//     return questionTexts[questionType] || 'Please select an option:';
//   };
//
//   const getDefaultChoices = (questionType) => {
//     const isMongoDB = sourceConnection?.dbType === 'mongodb';
//
//     switch (questionType) {
//       case 'operationMode':
//         return [
//           {
//             label: 'New Table',
//             value: 'new_table',
//             description: 'Create a new table/collection with transformed data'
//           },
//           {
//             label: 'In Source Table',
//             value: 'in_place',
//             description: 'Update or delete existing records in the source table'
//           }
//         ];
//       case 'storageLocation':
//         return [
//           {
//             label: 'Database',
//             value: 'database',
//             description: isMongoDB
//               ? 'Run transformation using MongoDB aggregation pipeline'
//               : 'Run transformation using native SQL queries'
//           },
//           {
//             label: 'Local',
//             value: 'local',
//             description: 'Run transformation locally'
//           }
//         ];
//       default:
//         return [];
//     }
//   };
//
//   const displayQuestionWithChoices = (questionType, questionText, choices) => {
//
//     // Set choices with appropriate display type
//     const formattedChoices = choices.map(choice => ({
//       ...choice,
//       variant: 'outlined',
//       fullWidth: true
//     }));
//
//     setPendingChoices(formattedChoices);
//
//     // Add hidden message for ref tracking
//     addBotMessage(questionText, true, 'choice', questionType, '', null);
//   };
//
//   const isFileLocal = () => {
//     return sourceNode?.data?.config?.targetLocalPath || sourceNode?.data?.config?.sourceLocalPath
//   }
//   const handleOperationModeResponse = async (value) => {
//     setPendingChoices([]);
//
//     // Compute updated settings
//     const updatedSettings = {
//       ...transformationSettings,
//       operationMode: value,
//       // For in-place transformations, storage location (storageLocation) is always database
//       ...(value === 'in_place' ? { storageLocation: isFileLocal() ? 'local' : 'database' } : {})
//     };
//
//     // Update state
//     setTransformationSettings(updatedSettings);
//
//     // Move to next question - pass updated settings directly to avoid stale state
//     askNextQuestion(questionsNeeded, questionKeys, currentQuestionIndex + 1, updatedSettings);
//   };
//
//   const handleStorageLocationResponse = async (value) => {
//     setPendingChoices([]);
//
//     // Compute updated settings
//     const updatedSettings = {
//       ...transformationSettings,
//       storageLocation: value
//     };
//
//     // Update state
//     setTransformationSettings(updatedSettings);
//
//     // Move to next question - pass updated settings directly to avoid stale state
//     askNextQuestion(questionsNeeded, questionKeys, currentQuestionIndex + 1, updatedSettings);
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Apply Transformation Result (Consolidation Helper)
//   // ─────────────────────────────────────────────────────────────────────────
//
//   // The one place the target table name is decided. Local SQLite output shares
//   // a single app-data.db across every workflow, so a user/AI-chosen name is
//   // prefixed with this workflow's token; node-id defaults are already unique.
//   // in_place reuses the SOURCE table and must never be renamed.
//   const resolveTargetTableName = (settings, { inPlace = false, sourceName = null } = {}) => {
//     if (inPlace) return sourceName;
//     const base = settings?.tableName || node.id.replace('-', '_').toLowerCase();
//     return qualifyLocalTableName(base, {
//       workflowId: workflowScopeId,
//       isLocal: settings?.storageLocation === 'local',
//     });
//   };
//
//   const applyTransformationResult = async (transformationData, settings, userRequest, isRefinement = false) => {
//     const explanation = transformationData.explanation || '';
//     const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
//     const dbType = sourceConnection?.dbType;
//     const targetSchema = sourceConnection?.dbConfig?.schema;
//     const targetTableName = resolveTargetTableName(settings);
//
//     // Get properly quoted table name for SQL databases
//     let fullTableName = `${targetSchema}.${targetTableName}`;
//     if (!isNoSQL && dbType !== 'sqlite') {
//       const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
//         dbType,
//         targetTableName,
//         targetSchema,
//         sourceConnection?.dbConfig,
//         sourceConnection?.id
//       );
//       fullTableName = quotedResult.quotedIdentifier;
//     }
//
//     if (isNoSQL) {
//       // Handle NoSQL transformation (MongoDB or NeDB)
//       const operationType = transformationData.operationType;
//       const nosqlOperation = transformationData.nosqlOperation;
//       const transformFunction = transformationData.transformFunction;
//
//       // Require the actual operation before enabling Run — a response missing
//       // nosqlOperation (e.g. truncated) would otherwise process nothing.
//       if (nosqlOperation && String(nosqlOperation).trim()) {
//         setSaveState(true);
//
//         // Determine target database type based on storage location
//         const targetDbType = settings.storageLocation === 'local' ? 'nedb' : dbType;
//
//         setLatestWithSQL({
//           ddl: '',
//           sql: '',
//           previewSql: JSON.stringify({
//             collection: targetTableName,
//             filter: {},
//             limit: 100
//           }),
//           explanation,
//           transformationRequest: userRequest,
//           transformationSettings: settings,
//           targetDbType,
//           operationType,
//           nosqlOperation,
//           transformFunction: transformFunction || null,
//           sourceCollection: sourceTableSchema.tableName,
//           targetCollection: targetTableName
//         });
//
//         // Add bot message with explanation
//         if (isRefinement) {
//           addBotMessage(
//             `✓ Transformation updated!\n\n${explanation}`,
//             false,
//             'text',
//             '',
//             '',
//             { operationType, nosqlOperation, transformFunction }
//           );
//         } else {
//           const dbLabel = dbType === 'mongodb' ? 'MongoDB' : dbType === 'nedb' ? 'NeDB' : 'NoSQL';
//           const storageLabel = settings.storageLocation === 'database'
//             ? (dbType === 'mongodb' ? 'In MongoDB' : 'In Database')
//             : 'Local (NeDB)';
//
//           addBotMessage(
//             `✓ ${dbLabel} Transformation generated!\n\n${explanation}\n\nOperation: ${operationType}\nSettings:\n• Mode: ${settings.operationMode === 'in_place' ? 'Modify Source Table' : 'New Collection'}\n• Storage Location: ${storageLabel}`,
//             false,
//             'text',
//             '',
//             '',
//             { operationType, nosqlOperation, transformFunction }
//           );
//         }
//
//         return true;
//       } else {
//         setSaveState(false);
//         addBotMessage(explanation || 'Unable to generate transformation. Nothing has been marked ready to run — please try again.', false);
//         return false;
//       }
//     } else {
//       // Handle SQL transformation
//       const ddl = transformationData.ddl || '';
//       const sql = transformationData.sql;
//       const insertSql = transformationData.insertSql || null;
//       const previewSql = transformationData.previewSql;
//
//       // Require the statement that actually POPULATES the table — DDL alone
//       // (CREATE TABLE with no INSERT/SELECT) would produce an empty table and
//       // still report success (the TLX-008 zero-row failure).
//       const hasRunnableSql =
//         (sql && String(sql).trim()) || (insertSql && String(insertSql).trim());
//
//       if (hasRunnableSql) {
//         setSaveState(true);
//
//         // Determine target database type based on storage location
//         const targetDbType = settings.storageLocation === 'local' ? 'sqlite' : dbType;
//
//         setLatestWithSQL({
//           ddl,
//           sql,
//           insertSql,
//           previewSql,
//           explanation,
//           transformationRequest: userRequest,
//           transformationSettings: settings,
//           targetDbType
//         });
//
//         // Add bot message with explanation
//         if (isRefinement) {
//           addBotMessage(
//             `✓ Transformation updated!\n\n${explanation}`,
//             false,
//             'text',
//             '',
//             '',
//             { ddl, sql, previewSql }
//           );
//         } else {
//           const storageLabel = settings.storageLocation === 'database' ? 'Database' : 'Local (SQLite)';
//
//           addBotMessage(
//             `✓ Transformation generated!\n\n${explanation}\n\nSettings applied:\n• Mode: ${settings.operationMode === 'new_table' ? 'New Table' : 'Modify Source Table'}\n• Storage Location: ${storageLabel}`,
//             false,
//             'text',
//             '',
//             '',
//             { ddl, sql, previewSql }
//           );
//         }
//
//         return true;
//       } else {
//         setSaveState(false);
//         const detail = ddl
//           ? ' It only returned the table definition, not the statement that fills it.'
//           : '';
//         addBotMessage(
//           (explanation || 'Unable to generate a complete transformation.') +
//           `${detail} Nothing has been marked ready to run — please try again or refine the request.`,
//           false
//         );
//         return false;
//       }
//     }
//   };
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // AI Transformation Generation
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
//     // Determine operationType
//     const dbType = sourceConnection?.dbType;
//     const operationType = ['mongodb', 'nedb'].includes(dbType) ? 'nosql' : 'sql';
//
//     // Execute the skill transformation
//     await executeSkillTransformation(activeSkill.skillId, {
//       ...activeSkill.skillState,
//       operationType
//     });
//   };
//
//   /**
//    * Execute a skill-based transformation
//    * @param {String} skillId - ID of the skill to execute
//    * @param {Object} skillParams - Parameters for skill execution
//    */
//   // console.log("sourceConnection: ", sourceConnection)
//   const executeSkillTransformation = async (skillId, skillParams) => {
//     console.log('[executeSkillTransformation] Starting:', skillId, skillParams);
//     setAiLoading(true);
//     setLoading(true);
//
//     try {
//       addBotMessage('Executing transformation with skill...', false);
//
//       // Determine operationType
//       const isNoSQL = ['mongodb', 'nedb'].includes(sourceConnection?.dbType);
//       const operationType = isNoSQL ? 'nosql' : 'sql';
//
//       // Get properly quoted source table name with schema
//       const sourceSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
//       const dbType = sourceConnection?.dbType;
//       let quotedTableName = sourceTableSchema.tableName;
//
//       // Quote identifier for SQL databases with schema
//       if (!isNoSQL && sourceSchema && dbType !== 'sqlite') {
//         const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
//           dbType,
//           sourceTableSchema.tableName,
//           sourceSchema,
//           sourceConnection?.dbConfig,
//           sourceConnection?.id
//         );
//         quotedTableName = quotedResult.quotedIdentifier;
//       } else if (sourceSchema) {
//         // For sqlite or if quoting fails, just append schema manually
//         quotedTableName = `${sourceSchema}.${sourceTableSchema.tableName}`;
//       }
//
//       console.log('[executeSkillTransformation] Using quoted table name:', quotedTableName);
//       const sourceNodeConfig = sourceNode?.data?.config;
//
//
//       // Execute the skill - skill will pull data itself and return config
//       const result = await window.electronAPI.skills.execute({
//         skillId,
//         params: {
//           sourceConnection: {
//             id: sourceConnection.id,
//             dbType: sourceConnection.dbType,
//             dbConfig: sourceConnection.dbConfig,
//             localPath: sourceConnection.localPath,
//             connectionType: sourceConnection.connectionType,
//             dbCategory: sourceConnection.dbCategory,
//             indexName: sourceConnection.indexName // For Pinecone
//           },
//           sourceTableSchema: {
//             tableName: quotedTableName, // Use quoted table name
//             originalTableName: sourceTableSchema.tableName, // Keep original for reference
//             indexName: sourceTableSchema.indexName || sourceConnection.indexName, // For Pinecone
//             columns: sourceTableSchema.columns,
//             sampleData: sourceTableSchema.sampleData,
//             sheetName: sourceTableSchema.sheetName,
//             schema: sourceSchema,
//             namespace: sourceTableSchema.namespace || sourceSchema // For Pinecone namespace
//           },
//           operationType,
//           // Storage settings
//           targetLocalPath: sourceNodeConfig?.targetLocalPath,
//           storageLocation: transformationSettings.storageLocation,
//           operationMode: transformationSettings.operationMode,
//           // Node context for config building
//           nodeId: node.id,
//           sourceNodeId: sourceNode?.id,
//           sourceNodeLabel: sourceNode?.data?.label,
//           sourceNodeConfig: sourceNodeConfig,
//           sourceConnectionName: sourceConnection.name,
//           sourceConnectionType: sourceConnection.connectionType,
//           userRequest: skillParams.userRequest,
//           // Spread the nested skillParams if it exists, otherwise spread the whole object
//           ...(skillParams.skillParams || skillParams)
//         }
//       });
//
//       if (!result.success) {
//         addBotMessage(`Skill execution failed: ${result.error || result.message}`, false);
//         setAiLoading(false);
//         setLoading(false);
//         return;
//       }
//
//       // Skill returns config - use it directly
//       if (!result.config) {
//         addBotMessage(`Error: Skill did not return configuration`, false);
//         setAiLoading(false);
//         setLoading(false);
//         return;
//       }
//
//       // Show success messages
//       addBotMessage(
//         `✓ Transformation completed successfully!\n${result.message}\n\nTransformed ${result.recordCount} records.`,
//         false
//       );
//
//       if (result.localPath) {
//         addBotMessage(`📁 Data saved to: ${result.localPath}`, false);
//       }
//
//       // If skill indicates schema needs to be loaded, fetch it
//       let finalConfig = { ...result.config };
//       console.log('[executeSkillTransformation] Saving config from skill:', finalConfig);
//
//       if (result.config.needsSchemaLoad) {
//         try {
//           addBotMessage('Loading target table schema...', false);
//
//           const targetTableSchema = await loadTableSchema({
//             connection: {
//               dbType: result.config.targetDbType,
//               dbConfig: result.config.targetDbConfig || {}
//             },
//             tableName: result.config.targetTableName || result.config.targetCollection,
//             localPath: result.config.targetLocalPath
//           });
//
//           finalConfig.targetTableSchema = targetTableSchema;
//           delete finalConfig.needsSchemaLoad; // Remove the indicator flag
//
//           console.log('[executeSkillTransformation] Loaded target table schema:', targetTableSchema);
//         } catch (error) {
//           console.error('[executeSkillTransformation] Failed to load target schema:', error);
//           // Continue without schema - it's not critical
//         }
//       }
//
//       // Save the configuration returned by the skill
//
//       onSave(finalConfig, chat);
//
//       addBotMessage('✓ Configuration saved to node', false);
//
//       setAiLoading(false);
//       setLoading(false);
//
//     } catch (error) {
//       console.error('[executeSkillTransformation] Error:', error);
//       addBotMessage(`Error executing skill: ${error.message}`, false);
//       setAiLoading(false);
//       setLoading(false);
//     }
//   };
//
//   // console.log('sourceConnection: ', sourceConnection)
//   const generateTransformation = async (settings) => {
//     console.log('generateTransformation: ', settings)
//     // return;
//     setAiLoading(true);
//     setLoading(true);
//
//     const targetSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
//     // Use custom table name from settings if provided, otherwise use default from node ID
//     const targetTableName = resolveTargetTableName(settings);
//     const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
//     const dbType = sourceConnection?.dbType;
//
//     let fullTableName = targetTableName
//
//     if (!isNoSQL && dbType !== 'sqlite') {
//       // Get properly quoted table name for SQL databases
//       let fullTableName = `${targetSchema}.${targetTableName}`;
//       const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
//         dbType,
//         targetTableName,
//         targetSchema,
//         sourceConnection?.dbConfig,
//         sourceConnection?.id
//       );
//       fullTableName = quotedResult.quotedIdentifier;
//     }
//
//     // Build chat history for AI context
//     const chatHistory = chat.slice(0, -1).map(msg => ({
//       sender: msg.sender,
//       text: msg.text
//     }));
//
//     try {
//       // Get properly quoted source table name with schema (for SQL databases)
//       const sourceSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
//       let sourceFullTableName = sourceTableSchema.tableName;
//
//       if (!isNoSQL && dbType !== 'sqlite' && sourceSchema) {
//         const quotedSourceResult = await window.electronAPI.dbConnect.quoteIdentifier(
//           dbType,
//           sourceTableSchema.tableName,
//           sourceSchema,
//           sourceConnection?.dbConfig,
//           sourceConnection?.id
//         );
//         sourceFullTableName = quotedSourceResult.quotedIdentifier;
//       }
//
//       // Build source table information
//       const sourceTableInfo = `
// Source: ${sourceTableSchema.sourceNodeLabel}
// - Table/Collection name: ${sourceFullTableName}
// - Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
// - Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
//       `;
//
//       // Build transformation settings context
//       const settingsContext = `
// Transformation Settings:
// - Operation Mode: ${settings.operationMode === 'in_place' ? 'Source table (In-Place) Update/Delete' : 'Create New Table' }
// - Storage Location: ${settings.storageLocation === 'database' ? 'Database (store and process in database)' : 'Local (store and process locally)'}
//       `;
//
//       let transformationPrompt;
//
//       // A local target is DuckDB, whatever the shape of the data — one prompt
//       // pair covers it. Everything else is a remote engine and gets its prompt
//       // from that connector's own plugin.
//       if (dbType === 'duckdb') {
//         // In-place on a FILE addresses the per-node staging table the executor
//         // materialises it into; the prompt derives that name from the node id,
//         // so the statements the model writes match the table that exists. A
//         // source that is already a DuckDB table is addressed by its own name.
//         const inPlaceTarget = String(getSourceLocalPath(node) || '').toLowerCase().endsWith('.duckdb')
//           ? (sourceTableSchema?.tableName || null)
//           : { nodeId: node.id, fallback: sourceTableSchema?.tableName };
//
//         transformationPrompt = settings.operationMode === 'in_place'
//           ? await buildChatPrompt('transfomer.duckdbTransformationInPlace', [settings, sourceTableInfo, settingsContext, sourceTableSchema, inPlaceTarget])
//           : await buildChatPrompt('transfomer.duckdbTransformationNewTable', [settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName]);
//       } else if (isNoSQL) {
//         {
//           // Generate prompt from plugin (e.g., MongoDB)
//           const sourceSchema = sourceConnection?.dbConfig?.database;
//           const sourceFullTableName = sourceTableSchema.tableName;
//
//           const promptResult = await window.electronAPI.dbConnect.generateTransformPrompt(
//             dbType,
//             settings.operationMode,
//             settings,
//             sourceTableInfo,
//             settingsContext,
//             sourceTableSchema,
//             targetTableName,
//             sourceConnection,
//             targetSchema,
//             fullTableName,
//             sourceSchema,
//             sourceFullTableName
//           );
//           if (promptResult.success) {
//             transformationPrompt = promptResult.prompt;
//           } else {
//             throw new Error(`Failed to generate transformation prompt for ${dbType}: ${promptResult.message}`);
//           }
//         }
//       } else {
//         // Remote SQL engines: the prompt comes from that connector's plugin so
//         // it speaks the right dialect.
//         {
//           // sourceFullTableName is already defined and quoted above (before sourceTableInfo)
//
//           const promptResult = await window.electronAPI.dbConnect.generateTransformPrompt(
//             dbType,
//             settings.operationMode,
//             settings,
//             sourceTableInfo,
//             settingsContext,
//             sourceTableSchema,
//             targetTableName,
//             sourceConnection,
//             targetSchema,
//             fullTableName,
//             sourceSchema,
//             sourceFullTableName
//           );
//           if (promptResult.success) {
//             transformationPrompt = promptResult.prompt;
//           } else {
//             throw new Error(`Failed to get transformation prompts for ${dbType}`);
//           }
//         }
//       }
//       console.log('transformationPrompt: ', transformationPrompt)
//       const response = await getWorkflowAssistance('transformer', transformationPrompt, {
//         sourceTable: sourceTableSchema.tableName,
//         sourceSchema: sourceTableSchema,
//         targetTable: fullTableName,
//         dbType: sourceConnection.dbType,
//         transformationSettings: settings
//       }, chatHistory);
//
//       // console.log('Transformation AI response:', response);
//
//       // Parse JSON response
//       let parsedResponse;
//       try {
//         parsedResponse = JSON.parse(response);
//       } catch (e) {
//         // Invalid/truncated JSON — never mark anything runnable (TLX-008/012).
//         // Show a clear "Invalid response" with the raw text expandable.
//         console.error('Failed to parse transformation JSON:', e, response);
//         setSaveState(false);
//         showInvalidResponse(response);
//         return;
//       }
//       console.log('parsedResponse:', parsedResponse);
//
//       // Apply the transformation result using consolidated helper
//       const success = await applyTransformationResult(parsedResponse, settings, settings.userRequest, false);
//
//       if (success) {
//         addBotMessage(
//           'You can ask follow-up questions to refine this transformation, or click Run & Save Configuration when ready.',
//           true,
//           'text',
//           'chatContinue',
//           'Ask a follow-up question or request changes…'
//         );
//       }
//
//     } catch (error) {
//       console.error('Transformation generation error:', error);
//       // Prefer the plain-language provider error (rate limit, bad key, model
//       // unavailable, …) when we have one; otherwise a generic fallback.
//       addBotMessage(error?.message || 'Failed to generate transformation. Please try again.', false);
//     } finally {
//       setAiLoading(false);
//       setLoading(false);
//     }
//   };
//
//
//   // ─────────────────────────────────────────────────────────────────────────
//   // Build Configuration
//   // ─────────────────────────────────────────────────────────────────────────
//
//   const buildConfig = async () => {
//     if (!sourceConnection) return {};
//
//     const sourceConfig = sourceNode?.data?.config || {};
//     const isNoSQL = ['mongodb', 'nedb'].includes(sourceConnection.dbType);
//     const isInPlace = transformationSettings.operationMode === 'in_place';
//     const isLocalStorage = transformationSettings.storageLocation === 'local';
//
//     // ============================================================================
//     // 1. Base Configuration
//     // ============================================================================
//     const config = {
//       nodeType: 'transformer',
//       sourceNodeId: sourceNode?.id,
//       sourceNodeLabel: sourceNode?.data?.label,
//       sourceConnectionId: sourceConnection.id,
//       sourceConnectionName: sourceConnection.name,
//       sourceConnectionType: sourceConnection.connectionType,
//       sourceDbType: sourceConnection.dbType,
//       sourceDbConfig: sourceConnection.dbConfig,
//       sourceType: sourceConnection.dbType,
//       sourceLocalPath: sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath,
//       sourceTableName: sourceConfig.targetTableName || sourceConfig.sourceTableName,
//       sourceCollection: sourceConfig.targetCollection || sourceConfig.sourceCollection,
//       sourceSchema: sourceConfig.targetSchema || sourceConfig.sourceSchema,
//       sourceTableSchema: sourceConfig.targetTableSchema || sourceConfig.sourceTableSchema,
//       sourceDataset: sourceConfig.targetDataset || sourceConfig.sourceDataset,
//       sourcePreviewSql: sourceConfig.targetPreviewSql || sourceConfig.sourcePreviewSql
//     };
//
//
//     if (!latestWithSQL) return config;
//
//     // ============================================================================
//     // 2. Transformation Settings
//     // ============================================================================
//     config.transformationRequest = latestWithSQL.transformationRequest || '';
//     config.targetSqlExplanation = latestWithSQL.explanation || '';
//     if (latestWithSQL.transformationSettings) {
//       config.transformationSettings = latestWithSQL.transformationSettings;
//     }
//
//     // ============================================================================
//     // 3. Target Connection Configuration
//     // ============================================================================
//     if (isInPlace) {
//       // In-place: target is same as source
//       config.targetConnectionId = config.sourceConnectionId;
//       config.targetConnectionName = config.sourceConnectionName;
//       config.targetConnectionType = config.sourceConnectionType;
//       config.targetDbType = config.sourceDbType;
//       config.targetDbConfig = config.sourceDbConfig;
//     } else if (isLocalStorage) {
//       // New dataset stored locally: one Parquet file this node owns, read by
//       // DuckDB. Tabular and document data alike — there is no second store.
//       config.targetConnectionId = 'local-duckdb';
//       config.targetConnectionName = 'Local file';
//       config.targetConnectionType = 'file';
//       config.targetDbType = 'duckdb';
//       config.targetDbConfig = {};
//     } else {
//       // New table with database storage: same as source
//       config.targetConnectionId = config.sourceConnectionId;
//       config.targetConnectionName = config.sourceConnectionName;
//       config.targetConnectionType = config.sourceConnectionType;
//       config.targetDbType = latestWithSQL.targetDbType || config.sourceDbType;
//       config.targetDbConfig = config.sourceDbConfig;
//     }
//
//     // ============================================================================
//     // 5. NoSQL-specific Configuration
//     // ============================================================================
//     if (isNoSQL && latestWithSQL.operationType) {
//       config.operationType = latestWithSQL.operationType;
//       config.nosqlOperation = latestWithSQL.nosqlOperation;
//       config.transformFunction = latestWithSQL.transformFunction;
//
//       // Target collection name
//       if (isInPlace) {
//         config.targetCollection = sourceConfig.targetCollection || sourceConfig.sourceCollection || latestWithSQL.sourceCollection;
//       } else {
//         config.targetCollection = latestWithSQL.targetCollection;
//       }
//
//       // Local path for NeDB
//       if (isLocalStorage || sourceConnection.dbType === 'nedb') {
//         config.targetLocalPath = latestWithSQL.localPath || sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
//       }
//
//       // Preview query (JSON format for NoSQL)
//       config.targetPreviewSql = JSON.stringify({
//         collection: config.targetCollection,
//         filter: {},
//         limit: 100
//       });
//     }
//     // ============================================================================
//     // 6. SQL-specific Configuration
//     // ============================================================================
//     else {
//       config.targetDdl = latestWithSQL.ddl || '';
//       config.targetSql = latestWithSQL.sql;
//       config.targetInsertSql = latestWithSQL.insertSql || null;
//
//       config.targetSchema = isLocalStorage ? null : sourceConfig.targetSchema || sourceConfig.sourceSchema || sourceConnection.dbConfig?.schema;
//
//
//       // Target table name
//       config.targetTableName = resolveTargetTableName(transformationSettings, {
//         inPlace: isInPlace,
//         sourceName: sourceConfig.targetTableName || sourceConfig.sourceTableName || sourceTableSchema.tableName,
//       });
//
//       // Where the output lives: the executor reports it, since in-place
//       // updates the source in place while a new table lands in this workflow's
//       // DuckDB database.
//       if (isLocalStorage) {
//         config.targetLocalPath = latestWithSQL.localPath
//           || (isInPlace ? sourceConfig.sourceLocalPath : null)
//           || sourceConfig.targetLocalPath
//           || null;
//       } else if (isInPlace && sourceConfig.targetLocalPath) {
//         config.targetLocalPath = sourceConfig.targetLocalPath;
//       }
//
//       // Preview SQL
//       if (isLocalStorage || config.targetLocalPath) {
//         // Local SQLite storage
//         const previewResult = await window.electronAPI.dbConnect.getPreviewQuery('sqlite', config.targetTableName, 100);
//         // An in-place file update runs its statements against a per-run staging
//         // table that is dropped when the run ends, so the model's previewSql
//         // would name something that no longer exists. Preview the updated file
//         // by the name it answers to instead.
//         const inPlaceOnFile = isInPlace
//           && !String(config.targetLocalPath || '').toLowerCase().endsWith('.duckdb');
//         config.targetPreviewSql = inPlaceOnFile
//           ? previewResult.previewQuery
//           : (latestWithSQL.previewSql || previewResult.previewQuery);
//       } else {
//         const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
//           sourceConnection.dbType,
//           config.targetTableName,
//           config.targetSchema,
//           sourceConnection.dbConfig,
//           sourceConnection.id
//         );
//         const fullTableName = quotedResult.quotedIdentifier;
//
//         // Use database-specific preview query
//         const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
//           sourceConnection.dbType,
//           fullTableName,
//           100
//         );
//         config.targetPreviewSql = latestWithSQL.previewSql || previewResult.previewQuery;
//       }
//     }
//
//     return config;
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
//   const handleSave = async () => {
//     setSaveState(false)
//     setExecutionError(null); // Clear any previous error state
//     let localPathFromResult = null;
//
//     // Check if this is a NoSQL transformation (MongoDB or NeDB)
//     const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
//     const isNeDB = sourceConnection?.dbType === 'nedb';
//     console.log('latestWithSQL: ', latestWithSQL)
//
//     if (isNoSQL && latestWithSQL?.operationType) {
//       // Get source local path for NeDB
//       const sourceLocalPath = isNeDB ? getSourceLocalPath(node) : null;
//
//       if (isNeDB && !sourceLocalPath) {
//         executingInd(false);
//         addBotMessage('✗ Source NeDB file path not found', false);
//         return;
//       }
//       const result = await executeTransformation({
//         connectionConfig: {
//           dbType: sourceConnection.dbType,
//           dbConfig: sourceConnection.dbConfig
//         },
//         connectionId: sourceConnection.id,
//         sourceLocalPath,
//         sourceCollection: latestWithSQL.sourceCollection,
//         targetCollection: latestWithSQL.targetCollection,
//         operationType: latestWithSQL.operationType,
//         nosqlOperation: latestWithSQL.nosqlOperation,
//         transformFunction: latestWithSQL.transformFunction,
//         storageLocation: transformationSettings.storageLocation,
//         operationMode: transformationSettings.operationMode,
//         setExecutingFn: executingInd,
//         onSuccess: (res) => {
//           addBotMessage(`✓ ${res.message}`, false);
//           if (res.localPath) {
//             addBotMessage(`📁 Local collection saved at: ${res.localPath}`, false);
//             localPathFromResult = res.localPath;
//             setLatestWithSQL(prev => ({ ...prev, localPath: res.localPath }));
//           } else {
//             setLatestWithSQL(prev => {
//               const { localPath, ...rest } = prev || {};
//               return rest;
//             });
//           }
//         },
//         onError: (err) => {
//           addBotMessage(`✗ Transformation failed: ${err.error || err.message}`, false);
//           setExecutionError({
//             error: err.error || err.message || 'Unknown error',
//             transformation: {
//               operationType: latestWithSQL.operationType,
//               nosqlOperation: latestWithSQL.nosqlOperation,
//               transformFunction: latestWithSQL.transformFunction
//             }
//           });
//         }
//       });
//
//       if (!result.success) return;
//
//     } else if (latestWithSQL?.sql) {
//       // SQL transformation - use executeTransformation
//       const targetTableName = resolveTargetTableName(transformationSettings);
//
//       // Get source local path for a local target or an in-place rewrite
//       let sourceLocalPath = null;
//       if (transformationSettings.storageLocation === 'local' || transformationSettings.operationMode === 'in_place') {
//         sourceLocalPath = getSourceLocalPath(node);
//       }
//
//       // In-place updates the source where it lies. A new table leaves this
//       // null so the executor derives this workflow's database from the scope.
//       const targetLocalPath = transformationSettings.operationMode === 'in_place'
//         ? sourceLocalPath
//         : null;
//
//       const result = await executeTransformation({
//         connectionConfig: {
//           dbType: sourceConnection.dbType,
//           dbConfig: sourceConnection.dbConfig
//         },
//         connectionId: sourceConnection.id,
//         ddl: latestWithSQL.ddl,
//         sql: latestWithSQL.sql,
//         insertSql: latestWithSQL.insertSql,
//         previewSql: latestWithSQL.previewSql,
//         targetTableName: targetTableName,
//         sourceLocalPath: sourceLocalPath,
//         targetLocalPath,
//         sourceFormat: sourceConnection?.fileInfo?.format || null,
//         storageLocation: transformationSettings.storageLocation,
//         operationMode: transformationSettings.operationMode,
//         setExecutingFn: executingInd,
//         onSuccess: (res) => {
//           addBotMessage(`✓ ${res.message}`, false);
//           if (res.localPath) {
//             addBotMessage(`📁 Local SQLite database saved at: ${res.localPath}`, false);
//             localPathFromResult = res.localPath;
//             setLatestWithSQL(prev => ({ ...prev, localPath: res.localPath }));
//           } else {
//             setLatestWithSQL(prev => {
//               const { localPath, ...rest } = prev || {};
//               return rest;
//             });
//           }
//         },
//         onError: (err) => {
//           addBotMessage(`✗ Transformation failed: ${err.error || err.message}`, false);
//           setExecutionError({
//             error: err.error || err.message || 'Unknown error',
//             transformation: {
//               ddl: latestWithSQL.ddl,
//               sql: latestWithSQL.sql
//             }
//           });
//         }
//       });
//
//       if (!result.success) return;
//     }
//
//     // Fetch transformed table schema after successful execution
//     let transformedSchema = null;
//     try {
//       const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
//       const isInPlace = transformationSettings.operationMode === 'in_place';
//
//       if (isNoSQL) {
//         // NoSQL transformation (MongoDB or NeDB)
//         const targetCollection = isInPlace
//           ? (sourceNode?.data?.config?.targetCollection || sourceNode?.data?.config?.sourceCollection || latestWithSQL.sourceCollection)
//           : latestWithSQL.targetCollection;
//
//         // Determine local path for schema fetching
//         let schemaLocalPath = null;
//         if (sourceConnection?.dbType === 'nedb') {
//           if (isInPlace) {
//             // For in_place, use parent's target or source local path
//             schemaLocalPath = isFileLocal();
//           } else {
//             // For new_table, use result local path
//             schemaLocalPath = localPathFromResult;
//           }
//         } else if (transformationSettings.storageLocation === 'local') {
//           // MongoDB stored locally
//           schemaLocalPath = localPathFromResult;
//         }
//
//         transformedSchema = await loadTableSchema({
//           connection: sourceConnection,
//           tableName: targetCollection,
//           localPath: schemaLocalPath
//         });
//       } else {
//         // SQL transformation
//         const targetTableName = resolveTargetTableName(transformationSettings, {
//           inPlace: isInPlace,
//           sourceName: sourceNode?.data?.config?.targetTableName || sourceNode?.data?.config?.sourceTableName || sourceTableSchema.tableName,
//         });
//
//         // Determine schema and local path based on storage location
//         let schemaLocalPath = null;
//         let targetSchema = null;
//
//         if (transformationSettings.storageLocation === 'local') {
//           // For local SQLite storage
//           if (isInPlace) {
//             // For in-place, use parent's local path
//             schemaLocalPath = localPathFromResult || isFileLocal();
//           } else {
//             // For new_table, use result local path
//             schemaLocalPath = localPathFromResult;
//           }
//           targetSchema = null; // SQLite doesn't use schemas
//         } else {
//           // For database storage
//           targetSchema = isInPlace
//             ? (sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema || sourceConnection.dbConfig?.schema)
//             : (sourceConnection.dbConfig?.schema);
//         }
//
//         // console.log('transformedSchema_input: ', {
//         //   connection: transformationSettings.storageLocation === 'local' && schemaLocalPath
//         //     ? { dbType: 'sqlite', dbConfig: {} } // Use SQLite connection for local
//         //     : sourceConnection,
//         //   tableName: targetTableName,
//         //   tableSchema: targetSchema,
//         //   localPath: schemaLocalPath
//         // })
//
//         transformedSchema = await loadTableSchema({
//           connection: transformationSettings.storageLocation === 'local' && schemaLocalPath
//             ? { dbType: 'sqlite', dbConfig: {} } // Use SQLite connection for local
//             : sourceConnection,
//           tableName: targetTableName,
//           tableSchema: targetSchema,
//           localPath: schemaLocalPath
//         });
//         console.log('transformedSchema: ', transformedSchema)
//       }
//     } catch (error) {
//       console.error('Failed to fetch transformed schema:', error);
//     }
//
//     setSaveState(false);
//     // Save configuration
//     const config = await buildConfig();
//
//     // Clean up config based on storage location
//     if (transformationSettings.storageLocation === 'database') {
//       // Remove targetLocalPath if storing in database
//       config.targetLocalPath = null;
//     } else if (transformationSettings.storageLocation === 'local') {
//       // Add targetLocalPath to config if it was returned from the transformation
//       if (localPathFromResult) {
//         config.targetLocalPath = localPathFromResult;
//       }
//     }
//
//     // Add table schema to config (this is the target/output schema)
//     if (transformedSchema) {
//       config.targetTableSchema = transformedSchema;
//     }
//
//     console.log('config: ', config)
//     onSave(config, chat);
//   };
//
//   const displayChoices = () => {
//     // Don't show choices while loading
//     if (loading || aiLoading || executing) return [];
//
//     // If there are pending choices (for multi-step questions), show them
//     if (pendingChoices.length > 0) {
//       return pendingChoices;
//     }
//
//     // Show "Fix Error" button if there's an execution error
//     if (executionError) {
//       return [{
//         label: '🔧 Ask AI to Fix Error',
//         value: 'fix_error',
//         variant: 'outlined',
//         fullWidth: true
//       }];
//     }
//
//     // For database connections with SQL, show Run & Execute Configuration
//     if (sourceConnection?.connectionType === 'database' && latestWithSQL?.sql && latestWithSQL?.ddl && saveState) {
//       return [{ label: 'Run & Save Configuration', value: 'save', variant: 'contained', fullWidth: true }];
//     }
//
//     // For non-database connections, show Save when ready
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
//       // Feed the FAILING code + error back to the model so it patches the
//       // specific problem instead of restarting from scratch. The failed
//       // SQL/function is injected into the chat history via this user message.
//       const t = executionError?.transformation || latestWithSQL || {};
//       const failedSql = t.sql || '';
//       const failedFn = t.transformFunction || '';
//       let message = `The transformation failed at execution with this error:\n${errorText}\n\n`;
//       if (failedSql) message += `The SQL that failed was:\n\`\`\`sql\n${failedSql}\n\`\`\`\n\n`;
//       if (failedFn) message += `The function that failed was:\n\`\`\`javascript\n${failedFn}\n\`\`\`\n\n`;
//       message += `Diagnose the cause and return a corrected transformation. Reuse the request I already gave — do not ask me to re-describe it; fix only what caused the error.`;
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
//     // Find the current question ref
//     const currentQ = getCurrentQuestion();
//     if (!currentQ) return;
//
//     // Handle choice selection based on the current question ref
//     handleUserResponse(
//       choice.label,
//       currentQ.ref,
//       choice.value,
//       null
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
//   const handleCodeSave = useCallback((field, value, message) => {
//     const updatedChat = chat.map(m =>
//       m.id === message?.id
//         ? { ...m, metadata: { ...m.metadata, [field]: value } }
//         : m
//     );
//     setChat(updatedChat);
//
//     if (!onConfigUpdate || !node?.id) return;
//
//     let update;
//     switch (field) {
//       case 'sql':
//         update = { targetSql: value };
//         break;
//       case 'ddl':
//         update = { targetDdl: value };
//         break;
//       case 'transformFunction':
//         update = { transformFunction: value };
//         break;
//       case 'nosqlOperation':
//         update = { nosqlOperation: value };
//         break;
//       case 'pythonCode':
//         update = { pythonCode: value };
//         break;
//       case 'javascriptFunction':
//         update = { javascriptFunction: value };
//         break;
//       default:
//         update = { [field]: value };
//     }
//     onConfigUpdate(node.id, { ...update, chat: updatedChat });
//   }, [onConfigUpdate, node?.id, chat]);
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
// export default TransformerNodeChat;
//