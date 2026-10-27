const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Exposes a minimal, safe API to the renderer process via contextBridge.
 * The renderer accesses these methods via window.electronAPI.
 *
 * All LLM key storage/retrieval is handled by the main process using
 * Electron safeStorage (OS-level encryption via keychain / Credential Store).
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Encrypts and persists the LLM provider key to disk.
   * @param {string} provider - 'claude' | 'gemini' | 'chatgpt'
   * @param {string} key      - The raw API key
   * @returns {Promise<{success: boolean}>}
   */
  saveApiKey: (provider, key) =>
    ipcRenderer.invoke('api-key:save', { provider, key }),

  /**
   * Loads and decrypts the stored LLM provider key.
   * @returns {Promise<{provider: string, key: string} | null>}
   */
  loadApiKey: () =>
    ipcRenderer.invoke('api-key:load'),

  /**
   * Deletes the stored LLM provider key file.
   * @returns {Promise<{success: boolean}>}
   */
  clearApiKey: () =>
    ipcRenderer.invoke('api-key:clear'),

  /**
   * How securely this system can hold the keys saved above.
   *
   * `weak` is true on Linux boxes with no desktop keyring, where secrets fall
   * back to an in-memory key and are recoverable by anything that can read the
   * file. Worth surfacing before the user pastes a production key in.
   *
   * @returns {Promise<{
   *   platform: string,
   *   available: boolean,
   *   backend: 'gnome_libsecret'|'kwallet'|'kwallet5'|'kwallet6'|'basic_text'|'unknown'|null,
   *   weak: boolean
   * }>}
   */
  getSecretStorageStatus: () =>
    ipcRenderer.invoke('secret-storage:status'),

  /**
   * The app's own metadata store — internal bookkeeping, not user data.
   * Collections: 'workflows' | 'connections' | 'executions' | 'chatSessions'
   *            | 'workflowHistory'
   */
  /**
   * Data Explorer. Every database interaction the explorer performs, plus its
   * persistent query notepad. Backed by public/database/.
   */
  explorer: {
    /** Dialect for this engine: language mode, keywords, functions, labels. */
    metadata: (dbType) =>
      ipcRenderer.invoke('explorer:metadata', { dbType }),

    /** Schemas each holding tables / views / collections. */
    schemaTree: (dbType, config, connectionId = null) =>
      ipcRenderer.invoke('explorer:schema-tree', { dbType, config, connectionId }),

    /** Columns for one object. Loaded lazily, and used for completions. */
    columns: (dbType, config, connectionId, schema, table) =>
      ipcRenderer.invoke('explorer:columns', { dbType, config, connectionId, schema, table }),

    /**
     * Syntax-check statements. Each is { text, startLine, startColumn } so the
     * issues come back positioned against the worksheet, not the statement.
     */
    validate: (dbType, statements) =>
      ipcRenderer.invoke('explorer:validate', { dbType, statements }),

    /** Pretty-print a statement in this engine's dialect. */
    format: (dbType, statement) =>
      ipcRenderer.invoke('explorer:format', { dbType, statement }),

    /** The default preview statement for a table, in this engine's syntax. */
    previewQuery: (dbType, schema, table, limit = 100) =>
      ipcRenderer.invoke('explorer:preview-query', { dbType, schema, table, limit }),

    /** Run one statement. Returns { rows, columns, rowCount, ms, truncated }. */
    run: (dbType, config, connectionId, statement, limit) =>
      ipcRenderer.invoke('explorer:run', { dbType, config, connectionId, statement, limit }),

    /** The notepad — worksheets persist per connection across restarts. */
    worksheets: {
      list: (connectionId) =>
        ipcRenderer.invoke('explorer:worksheets:list', { connectionId }),
      save: (worksheet) =>
        ipcRenderer.invoke('explorer:worksheets:save', { worksheet }),
      remove: (id) =>
        ipcRenderer.invoke('explorer:worksheets:delete', { id }),
    },

    /** Every statement that was run, successful or not. */
    history: {
      list: (connectionId, limit = 100) =>
        ipcRenderer.invoke('explorer:history:list', { connectionId, limit }),
      add: (entry) =>
        ipcRenderer.invoke('explorer:history:add', { entry }),
      clear: (connectionId) =>
        ipcRenderer.invoke('explorer:history:clear', { connectionId }),
    },
  },

  db: {
    /** Insert a document. Returns the inserted doc (with _id). */
    insert: (collection, doc) =>
      ipcRenderer.invoke('db:insert', { collection, doc }),

    /** Find documents. Returns an array. */
    find: (collection, query = {}, sort = null, limit = 0, skip = 0) =>
      ipcRenderer.invoke('db:find', { collection, query, sort, limit, skip }),

    /** Return the first matching document or null. */
    findOne: (collection, query = {}) =>
      ipcRenderer.invoke('db:findOne', { collection, query }),

    /** Update matching documents. Returns { numReplaced, ... }. */
    update: (collection, query, update, options = {}) =>
      ipcRenderer.invoke('db:update', { collection, query, update, options }),

    /** Remove matching documents. Returns numRemoved. */
    remove: (collection, query, options = {}) =>
      ipcRenderer.invoke('db:remove', { collection, query, options }),

    /** Count documents matching query. Returns a number. */
    count: (collection, query = {}) =>
      ipcRenderer.invoke('db:count', { collection, query }),

    /** Read from a local DuckDB or SQLite file. Returns { success, rows, rowCount, json }. */
    readLocalCollection: (filePath, limit = 100, storageType = 'duckdb', sqlPreview = null, tableName = null) =>
      ipcRenderer.invoke('db:read-local-collection', { filePath, limit, storageType, sqlPreview, tableName }),
  },

  /**
   * Open the native OS file picker and return the selected file path.
   * Returns { canceled: bool, filePaths: string[] }
   */
  openFileDialog: (options) =>
    ipcRenderer.invoke('dialog:open-file', options),

  /**
   * Extract the real system path from a File object (for drag-and-drop).
   * @param {File} file - The File object from drag-and-drop
   * @returns {string} The absolute file path
   */
  getFilePath: (file) => webUtils.getPathForFile(file),

  /**
   * Open the native OS save file dialog and return the selected file path.
   * Returns { canceled: bool, filePath: string }
   */
  selectSavePath: (defaultFileName, fileExtension) =>
    ipcRenderer.invoke('dialog:save-file', defaultFileName, fileExtension),

  /**
   * Read rows from a local spreadsheet file (xlsx / xls / csv).
   * No upload — reads directly from the filesystem path.
   */
  fileReader: {
    /** Read up to `limit` rows from a local file. Returns { success, sheets, data }. */
    readRows: (filePath, limit = 1000) =>
      ipcRenderer.invoke('file:read-rows', { filePath, limit }),
  },

  /**
   * Import files into internal databases
   */
  /**
   * Record a local file as a data source. Nothing is imported or converted:
   * CSV/JSON/Parquet/Excel/Avro are registered by path and queried in place by
   * DuckDB (Excel and Avro through its excel and avro extensions).
   * Returns { success, format, converted, tables: [{ name, path, rowCount, schema }] }.
   * @param {{ filePath: string, importId?: string }} params
   */
  registerLocalFile: (params) =>
    ipcRenderer.invoke('file:register-local', params),

  /**
   * Subscribe to progress from a running file import. Imports stream in
   * batches, so this fires roughly four times a second with what has landed
   * so far — pass an `importId` to registerLocalFile and match on it.
   * The callback receives:
   *   { importId, phase: 'reading'|'writing', rows, table?, sheet?,
   *     bytesRead?, totalBytes?, file? }
   * Returns an unsubscribe function — call it on cleanup to avoid leaks.
   * @param {(evt: object) => void} callback
   * @returns {() => void}
   */
  onImportProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },

  listLanceDBTables: (dbPath) =>
    ipcRenderer.invoke('list-lancedb-tables', dbPath),

  /**
   * Direct database connections (runs in main process via native drivers).
   * No backend server required.
   */
  dbConnect: {
    /** Test connectivity. Returns { success, message }. */
    test: (dbType, config, connectionId = null) =>
      ipcRenderer.invoke('dbconn:test', { dbType, config, connectionId }),

    /** List tables/collections. Returns { success, tables: [{schema, name, type}] }. */
    getTables: (dbType, config, connectionId = null) =>
      ipcRenderer.invoke('dbconn:get-tables', { dbType, config, connectionId }),

    /** List columns for a table. Returns { success, columns: [{name, type, nullable, isPrimary}] }. */
    getColumns: (dbType, config, schema, table, connectionId = null) =>
      ipcRenderer.invoke('dbconn:get-columns', { dbType, config, connectionId, schema, table }),

    /** Get table schema with inferred types and sample data. Returns { success, tableName, columns, sampleData }. */
    getTableSchema: (dbType, config, connectionId, tableName, sheetName = null, limit = 5) =>
      ipcRenderer.invoke('dbconn:get-table-schema', { dbType, config, connectionId, tableName, sheetName, limit }),

    /** Run a SQL query or MongoDB JSON query. Returns { success, rows, columns, rowCount }. */
    runQuery: (dbType, config, query, connectionId = null) =>
      ipcRenderer.invoke('dbconn:run-query', { dbType, config, connectionId, query }),



    /** NoSQL transformation against the source's document-store connector. */
    transformNoSQL: (dbType, config, connectionId, sourceLocalPath, sourceCollection, targetCollection, operationType, nosqlOperation, transformFunction, storageLocation, operationMode, targetLocalPath = null, scope = {}) =>
      ipcRenderer.invoke('dbconn:transform-nosql', {
        dbType,
        config,
        connectionId,
        sourceLocalPath,
        sourceCollection,
        targetCollection,
        operationType,
        nosqlOperation,
        transformFunction,
        storageLocation,
        operationMode,
        targetLocalPath,
        // Optional { workflowId, nodeId } — scopes the local output table.
        workflowId: scope.workflowId || null,
        nodeId: scope.nodeId || null
      }),

    /** SQL transformation (for PostgreSQL, MySQL, MSSQL, DuckDB local files). */
    transformSQL: (dbType, config, connectionId, ddl, sql, previewSql, storageLocation, operationMode, targetSchema, targetTableName, sourceLocalPath = null, insertSql = null, targetLocalPath = null, scope = {}) =>
      ipcRenderer.invoke('dbconn:transform-sql', {
        dbType,
        config,
        connectionId,
        ddl,
        sql,
        previewSql,
        storageLocation,
        operationMode,
        targetSchema,
        targetTableName,
        sourceLocalPath,
        insertSql,
        targetLocalPath,
        // Optional { workflowId, nodeId } — scopes this node's local output
        // file, so configuring a node interactively writes to the same place
        // the workflow runner would.
        workflowId: scope.workflowId || null,
        nodeId: scope.nodeId || null,
        sourceFormat: scope.sourceFormat || null
      }),

    /** Execute join operation (combines multiple sources into destination). */
    executeJoin: (destinationConnection, joinConfig, operationMode, scope = {}) =>
      ipcRenderer.invoke('dbconn:execute-join', {
        destinationConnection,
        joinConfig,
        operationMode,
        // Optional { workflowId, nodeId } — scopes the local output table.
        workflowId: scope.workflowId || null,
        nodeId: scope.nodeId || null
      }),

    /**
     * Execute branch validation plan.
     * params: {
     *   sources: Array<{ sourceNodeId, connection, tableName }>,
     *   steps:   Array<{ stepNumber, sourceNodeId, sql?, nosqlOperation?, selectedColumns? }>,
     *   validationFunction: string (JS function expression),
     *   outputRoutes: { true: string, false: string }
     * }
     * returns: { success, result:boolean, route, stepResults }
     */
    executeBranch: (params) =>
      ipcRenderer.invoke('dbconn:execute-branch', params),

    /**
     * Execute a REST API fetch function and materialise the response locally.
     * params: {
     *   apiConnectionId: string,
     *   apiConnectionConfig: object,     // public config (no secrets)
     *   apiFetchCode: string,            // async JS function expression with
     *                                    // {{PLACEHOLDER}} tokens
     *   targetCollection: string,
     *   operationMode?: 'new_table' | 'append'
     * }
     * returns: { success, rowCount, collection, localPath, sampleRow, error? }
     *
     * Secrets are decrypted and substituted into the code string in the main
     * process, then the function is evaluated and invoked. The resolved code
     * is never returned across this IPC.
     */
    executeRestApiFetch: (params) =>
      ipcRenderer.invoke('rest-api:execute-fetch', params),

    /** Execute output operation (export to file or insert to connection). */
    executeOutput: (sourceConnection, sourceTableSchema, outputSettings) =>
      ipcRenderer.invoke('dbconn:execute-output', sourceConnection, sourceTableSchema, outputSettings),

    /** List all available connector plugins. Returns { success, connectors: [{id, name, type, icon, version, description, configSchema}] }. */
    listPlugins: () =>
      ipcRenderer.invoke('dbconn:list-plugins'),

    /** Generate transformation prompt from a plugin. Returns { success, prompt: string }. */
    generateTransformPrompt: (dbType, operationMode, settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName, sourceConnection = null, targetSchema = null, fullTableName = null, sourceSchema = null, sourceFullTableName = null) =>
      ipcRenderer.invoke('dbconn:generate-transform-prompt', {
        dbType,
        operationMode,
        settings,
        sourceTableInfo,
        settingsContext,
        sourceTableSchema,
        targetTableName,
        sourceConnection,
        targetSchema,
        fullTableName,
        sourceSchema,
        sourceFullTableName
      }),

    /** Quote identifier for specific database type. Returns { success, quotedIdentifier }. */
    quoteIdentifier: (dbType, identifier, schema = null, config = null, connectionId = null) =>
      ipcRenderer.invoke('dbconn:quote-identifier', { dbType, identifier, schema, config, connectionId }),

    /** Get database-specific preview query. Returns { success, previewQuery }. */
    getPreviewQuery: (dbType, tableName, limit = 100) =>
      ipcRenderer.invoke('dbconn:get-preview-query', { dbType, tableName, limit }),

    /** Import Google Sheet to a local DuckDB file. Returns { success, localPath, tableName, rowCount, message }. */
    importGoogleSheetToDuckDb: (config, connectionId, spreadsheetId, sheetName) =>
      ipcRenderer.invoke('google-sheets:import-to-duckdb', { config, connectionId, spreadsheetId, sheetName }),
  },

  /**
   * Secure database credential storage.
   * Credentials are encrypted using OS-level safeStorage.
   */
  dbCredentials: {
    /** Save credentials for a connection. Returns { success }. */
    save: (connectionId, credentials) =>
      ipcRenderer.invoke('db-credentials:save', { connectionId, credentials }),

    /** Load credentials for a connection. Returns credentials object or null. */
    load: (connectionId) =>
      ipcRenderer.invoke('db-credentials:load', { connectionId }),

    /** Update credentials for a connection (replaces all credentials and closes cached connection). Returns { success }. */
    update: (connectionId, credentials, dbType) =>
      ipcRenderer.invoke('db-credentials:update', { connectionId, credentials, dbType }),

    /** Delete credentials for a connection. Returns { success }. */
    delete: (connectionId) =>
      ipcRenderer.invoke('db-credentials:delete', { connectionId }),
  },

  /**
   * Account authentication helpers.
   * The Google OAuth loopback flow must run in the main process (system
   * browser + local callback server); the renderer exchanges the returned
   * code with the backend for a JWT.
   */
  auth: {
    /** Run Google sign-in. Returns { success, code, redirectUri, codeVerifier } or { success: false, message }. */
    googleLogin: () =>
      ipcRenderer.invoke('auth:google-login'),

    /* Apple sign-in disabled
    appleLogin: () =>
      ipcRenderer.invoke('auth:apple-login'),
    */
  },

  /**
   * Plugin management.
   * Install, uninstall, and list connector plugins.
   */
  plugins: {
    /** List installed connector plugins. Returns { success, connectors: [{id, name, type, version, ...}] }. */
    listInstalled: () =>
      ipcRenderer.invoke('dbconn:list-plugins'),

    /** Install a plugin from the backend server. Returns { success, message }. */
    install: (pluginId) =>
      ipcRenderer.invoke('plugins:install', { pluginId }),

    /** Uninstall an installed plugin. Returns { success, message }. */
    uninstall: (pluginId) =>
      ipcRenderer.invoke('plugins:uninstall', { pluginId }),
  },

  /**
   * AI provider operations. The renderer never sees decrypted API keys —
   * everything is dispatched through these handlers in the main process.
   */
  ai: {
    /**
     * Call the configured/requested AI provider with a prompt.
     * @param {Object} args - { prompt, options }
     * @param {string} args.prompt
     * @param {Object} [args.options] - { provider?, model?, maxTokens?, systemPrompt?, chatHistory? }
     * @returns {Promise<{success: boolean, text?: string, message?: string}>}
     */
    call: ({ prompt, options = {} } = {}) =>
      ipcRenderer.invoke('ai:call', { prompt, options }),

    /**
     * Finish an answer that stopped at the model's output limit.
     * Pass the `resume` payload from a MAX_TOKENS failure; the resolved `text`
     * is the partial output plus the continuation, already joined.
     * @returns {Promise<{success: boolean, text?: string, message?: string,
     *                    code?: string, resume?: object}>}
     */
    continue: ({ resume } = {}) =>
      ipcRenderer.invoke('ai:continue', { resume }),

    /** List providers that have a usable API key configured. */
    listProviders: () =>
      ipcRenderer.invoke('ai:listProviders'),

    /** List the models a provider currently offers (fetched live via its SDK). */
    listModels: (provider) =>
      ipcRenderer.invoke('ai:listModels', { provider }),

    /** Read the persisted default { provider, model, modelProvider, maxTokens } —
     *  the only store for them; every AI call uses these. */
    getDefaultProvider: () =>
      ipcRenderer.invoke('ai:getDefaultProvider'),

    /** Non-secret config { hasKey, baseURL, model } for an OpenAI-compatible provider. */
    getCompatProvider: (provider) =>
      ipcRenderer.invoke('ai:getCompatProvider', { provider }),

    /** Save { apiKey, baseURL, model } for a compat provider; blank apiKey keeps the existing key. */
    saveCompatProvider: (provider, config) =>
      ipcRenderer.invoke('ai:saveCompatProvider', { provider, config }),

    /** Persist the user's default provider (and optionally its model) so the
     *  main process honors it for backend-internal AI calls. */
    setDefaultProvider: (provider, model) =>
      ipcRenderer.invoke('ai:setDefaultProvider', { provider, model }),

    /** Persist the user's Max Tokens (used by every AI call). */
    setMaxTokens: (maxTokens) =>
      ipcRenderer.invoke('ai:setMaxTokens', { maxTokens }),
  },

  /**
   * Agentic chat assistant — one step at a time. The renderer drives the
   * loop, passing the running `scratchpad` back on each call until `done`.
   * Cancellation = stop calling step().
   *
   * @param {Object} args
   * @param {string} args.message           The user's original question.
   * @param {Array}  [args.history]         Prior cross-turn chat: [{ role, text }]
   * @param {Array}  [args.scratchpad]      Steps taken so far for this question.
   * @param {Object} [args.activeContext]   { kind, id, name, summary }
   * @param {string} [args.provider]
   * @returns {Promise<{
   *   success: boolean,
   *   done: boolean,
   *   thought: string,
   *   actions: Array<{ tool, args, ok, error?, result? }>,
   *   finalAnswer: string|null,
   *   step: object,
   * } | { success:false, message:string }>}
   */
  chat: {
    step: ({
      message,
      history = [],
      scratchpad = [],
      activeContext = null,
      provider = null,
      agentMode = 'main',
      workflowSession = null,
      // Set when the previous turn batched plan_workflow_build with other
      // tools: main deferred it and handed the args back, and the renderer
      // restarts the loop with them so the build runs directly instead of
      // costing another AI turn. Dropping this here silently disabled that
      // whole branch — every field the renderer sends must be listed.
      triggerPlanWorkflowBuild = null,
      targetNode = null,
      // First message of a brand-new conversation. The main agent then returns
      // the chat's name as `chatTitle` alongside its answer — there is no
      // separate naming call.
      isNewChat = false,
    } = {}) => ipcRenderer.invoke('chat:step', {
      message, history, scratchpad, activeContext, provider, agentMode, workflowSession,
      triggerPlanWorkflowBuild, targetNode, isNewChat,
    }),

    /**
     * Execute AI-generated JavaScript the user has just approved.
     * `runToken` comes from a step's `pendingApproval`. Returns
     * { success, result } with the same shape run_javascript used to return
     * directly ({ ran, explanation, transformFunction, recordCount, rows }).
     * Single-use — a token cannot be run twice.
     */
    runApprovedJavascript: ({ runToken, provider = null } = {}) =>
      ipcRenderer.invoke('chat:run-approved-javascript', { runToken, provider }),

    /** Drop generated code the user declined, freeing its captured rows. */
    discardJavascript: ({ runToken } = {}) =>
      ipcRenderer.invoke('chat:discard-javascript', { runToken }),

    /**
     * Print the open presentation (build_presentation) to a PDF the user picks.
     * Returns { success, filePath } or { success: false, canceled | message }.
     */
    exportPresentationPdf: ({ title } = {}) =>
      ipcRenderer.invoke('presentation:export-pdf', { title }),
    // NOTE: `skillStep` (chat:skillStep) was removed. A skill that needs more
    // input now raises an ordinary clarification through the builder, so its
    // question travels the same path as any other build question and the answer
    // returns via executeBuild / build_* — no separate skill channel.
  },

  /**
   * Workflow operations.
   * - executeBuild: applies a plan_workflow_build envelope directly (wired from
   *   the renderer's "Accept plan" button so confirmations don't burn a turn).
   * - executeWorkflow: runs a workflow's nodes in topological order.
   */
  workflow: {
    /**
     * @param {Object} args
     * @param {Object} args.plan  Plan envelope from plan_workflow_build,
     *                            with action='plan' and a steps[] array.
     * @returns {Promise<{ success, workflowId?, workflowName?, nodeCount?, edgeCount?, warnings?, message? }>}
     */
    executeBuild: ({ plan } = {}) => ipcRenderer.invoke('workflow:executeBuild', { plan }),

    /**
     * Author (or re-author) a workflow's output-validation function. Persists it
     * onto the workflow doc and returns the saved outputValidation.
     * @param {{ workflowId: string }} args
     * @returns {Promise<{ success, outputValidation?, message? }>}
     */
    generateValidation: ({ workflowId } = {}) => ipcRenderer.invoke('workflow:generateValidation', { workflowId }),

    /**
     * Check whether an edited workflow has drifted from the goal its saved
     * validation function was written for. `workflow` is the in-progress doc.
     * @param {{ workflow: object }} args
     * @returns {Promise<{ drifted: boolean, reason: string }>}
     */
    checkValidationDrift: ({ workflow } = {}) => ipcRenderer.invoke('workflow:checkValidationDrift', { workflow }),

    /**
     * Review a just-applied change (creation, modification, or a single node
     * rebuilt from chat) against the conversation that produced it, before it
     * runs. Also reports output-validation drift when the workflow has one.
     * @param {Object} args
     * @param {string} args.workflowId
     * @param {Object} args.change       { kind: 'create'|'update'|'node', summary?, nodeIds? }
     * @param {Array}  args.chatHistory  [{ role, text }] — the brief the builder
     *                                   worked from, NOT the chat panel.
     * @param {Object} [args.pendingNode] { nodeId, nodeType?, label?, config }
     *                                   applied but not yet saved. Overlaid onto
     *                                   the saved node, or appended when the node
     *                                   is new and has never been saved.
     * @returns {Promise<{ success, valid, reason, issues, remediation,
     *                     inconclusive?, drift: { drifted, reason } }>}
     */
    validateChange: ({ workflowId, change = {}, chatHistory = [], priorActions = [], pendingNode = null, fixRounds = 0 } = {}) =>
      ipcRenderer.invoke('workflow:validateChange', { workflowId, change, chatHistory, priorActions, pendingNode, fixRounds }),

    /**
     * Subscribe to live build-progress events emitted by executeBuild while a
     * plan is being applied. The callback receives one event object per step:
     *   { phase: 'start', mode, workflowId, workflowName, totalSteps }
     *   { phase: 'step', status: 'running'|'done', stepIndex, stepType, label,
     *     action, nodeId, nodeType, position, sources }
     *   { phase: 'graph', workflowId, nodes: [{ id, type, position, label }], edges }
     *   { phase: 'paused', workflowId, nodeId, stepIndex, question }
     *   { phase: 'failed', workflowId, nodeId, stepIndex, message }
     *   { phase: 'done', workflowId, workflowName, nodeCount, edgeCount }
     * A build that pauses for a clarification ends on 'paused' and resumes with
     * a fresh 'start' carrying the same workflowId.
     * The chat folds these into its build log; the workflow canvas uses the
     * node fields to draw each node as it is built (see WorkflowEditor's live
     * build overlay). Note that workflow:generateValidation streams on this
     * same channel with { phase: 'investigating'|'done', thought } — those
     * events carry no workflowId, which is how consumers tell them apart.
     * Returns an unsubscribe function — call it on cleanup to avoid leaks.
     * @param {(evt: object) => void} callback
     * @returns {() => void}
     */
    onBuildProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload);
      ipcRenderer.on('workflow:buildProgress', listener);
      return () => ipcRenderer.removeListener('workflow:buildProgress', listener);
    },

    /**
     * @param {object} params - { workflowId, workflowName, nodes, edges }
     * @returns {Promise<{ success, executionId, message, results }>}
     */
    executeWorkflow: (params) => ipcRenderer.invoke('workflow:execute', params),

    /**
     * Ask a running execution to stop.
     *
     * Cancellation is cooperative and lands BETWEEN nodes: the step in flight
     * finishes and is recorded, then the run ends with status 'cancelled'. It
     * does NOT abort a connector call mid-write, so a node that is loading a
     * large table will keep loading it until it is done. The execution row is
     * marked `cancelRequested: true` straight away, which is what the monitor
     * shows as "stopping…".
     * @param {{ executionId: string }} args
     * @returns {Promise<{ success: boolean, message: string, alreadyRequested?: boolean }>}
     */
    cancelWorkflow: ({ executionId } = {}) =>
      ipcRenderer.invoke('workflow:cancel', { executionId }),

    /**
     * Run a SINGLE node the way a full run would, without recording an
     * execution. Backs the chat assistant's "Run this node" approval — upstream
     * nodes are not re-run, so the node reads whatever its sources last wrote.
     * @param {object} params - { workflowId, nodeId, nodes, edges }
     * @returns {Promise<{ success, message, recordsProcessed?, duration? }>}
     */
    executeNode: (params) => ipcRenderer.invoke('workflow:executeNode', params),

    /**
     * Start watching the open workflow's externalized-code folder
     * ({userData}/workflow-code/{workflow}). When a code file changes on disk
     * the main process emits 'workflow:codeChanged' — subscribe with
     * onCodeChanged to reload the editor. Editor sync only; does not run the
     * workflow.
     * @param {string} workflowId
     * @returns {Promise<{ success, message, watching? }>}
     */
    watchCode: (workflowId) => ipcRenderer.invoke('workflow:watchCode', { workflowId }),

    /**
     * Stop watching a workflow's code folder.
     * @param {string} workflowId
     * @returns {Promise<{ success, message }>}
     */
    unwatchCode: (workflowId) => ipcRenderer.invoke('workflow:unwatchCode', { workflowId }),

    /**
     * Subscribe to code-file changes for watched workflows. The callback
     * receives { workflowId, event, path }. Returns an unsubscribe function —
     * call it on cleanup to avoid leaks.
     * @param {(evt: { workflowId: string, event: string, path: string }) => void} callback
     * @returns {() => void}
     */
    onCodeChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload);
      ipcRenderer.on('workflow:codeChanged', listener);
      return () => ipcRenderer.removeListener('workflow:codeChanged', listener);
    },
  },

  /**
   * Anonymous usage analytics. The renderer pushes the user's opt-in choice;
   * the main process gates all outbound events on this flag.
   */
  analytics: {
    setOptIn: (optIn) =>
      ipcRenderer.invoke('analytics:set-opt-in', { optIn: !!optIn }),
  },

  /**
   * Terms & Conditions acceptance, persisted to userData via the main process
   * so it survives across launches.
   */
  terms: {
    get: () => ipcRenderer.invoke('terms:get'),
    save: (record) => ipcRenderer.invoke('terms:save', record),
  },

  /**
   * Durable mirror of the renderer's localStorage.
   *
   * A packaged window runs from a file:// origin, whose storage Chromium drops
   * when the window closes. src/utils/persistentLocalStorage.js reloads this at
   * startup and writes it back on change, so localStorage call sites work
   * unchanged and survive a restart.
   */
  store: {
    /** Every persisted key as a { key: string } map. `{}` when nothing is saved. */
    load: () => ipcRenderer.invoke('store:load'),
    /** Replace the saved store with this complete snapshot. */
    save: (entries) => ipcRenderer.invoke('store:save', entries),
  },

  /**
   * Skills Plugin operations
   */
  skills: {
    /** List installed skill plugins. Returns { success, skills: [{id, name, category, version, ...}] }. */
    listInstalled: () =>
      ipcRenderer.invoke('skills:listInstalled'),

    /** Get skills by category (transformer/join). Returns { success, skills: [...] }. */
    getByCategory: (category) =>
      ipcRenderer.invoke('skills:getByCategory', category),

    /** Get skill descriptions for AI context. Returns { success, descriptions: [...] }. */
    getDescriptions: (category = null, context = {}) =>
      ipcRenderer.invoke('skills:getDescriptions', category, context),

    /** Analyze a skill request. Returns { success, action, followUpQuestion, questionsNeeded, skillParams, ... }. */
    analyze: ({ skillId, params }) =>
      ipcRenderer.invoke('skills:analyze', { skillId, params }),

    /** Build skill prompt for AI. Returns { success, prompt, context }. */
    buildPrompt: ({ skillId, params }) =>
      ipcRenderer.invoke('skills:buildPrompt', { skillId, params }),

    /** Process AI response through skill. Returns { success, action, pythonCode, explanation, followUpQuestion, directAnswer, ... }. */
    processResponse: ({ skillId, aiResponse, operationType, currentState, availableConnections }) =>
      ipcRenderer.invoke('skills:processResponse', { skillId, aiResponse, operationType, currentState, availableConnections }),

    /** Execute a skill. Returns { success, data, recordCount, ... }. */
    execute: ({ skillId, params }) =>
      ipcRenderer.invoke('skills:execute', { skillId, params }),

    /** Query vector database for preview. Returns { success, data, recordCount, isJson, storageType }. */
    queryVectorPreview: (params) =>
      ipcRenderer.invoke('skills:queryVectorPreview', params),
  },

  /**
   * Chat prompt builders sourced from public/ChatPrompts. The renderer passes
   * a "moduleName.methodName" key and the argument array; the main process
   * calls the matching prompt function and returns { success, prompt }.
   */
  chatPrompts: {
    build: (key, args = []) =>
      ipcRenderer.invoke('chatPrompts:build', key, args),
  },

  /**
   * Cloud Storage operations
   */
  cloudStorage: {
    /** Get list of containers/buckets. Returns { success, containers, message }. */
    getContainers: (connectionId, dbType) =>
      ipcRenderer.invoke('cloud-storage:get-containers', { connectionId, dbType }),

    /**
     * List objects in a container with pagination and search support.
     * @param {number} maxKeys - Maximum objects per page (default 100)
     * @param {string} continuationToken - Pagination token from previous response
     * @param {string} searchTerm - Search term for server-side filtering
     * Returns { success, objects, isTruncated, nextContinuationToken, totalCount, message }
     */
    listObjects: (connectionId, dbType, containerName, prefix = '', maxKeys = 100, continuationToken = null, searchTerm = '') =>
      ipcRenderer.invoke('cloud-storage:list-objects', { connectionId, dbType, containerName, prefix, maxKeys, continuationToken, searchTerm }),

    /** Download an object from cloud storage. Returns { success, data, contentType, message }. */
    downloadObject: (connectionId, dbType, containerName, objectName) =>
      ipcRenderer.invoke('cloud-storage:download-object', { connectionId, dbType, containerName, objectName }),

    /** Export Google Workspace file (Sheets, Docs, etc.). Returns { success, data, name, mimeType, message }. */
    exportObject: (connectionId, dbType, fileId, mimeType) =>
      ipcRenderer.invoke('cloud-storage:export-object', { connectionId, dbType, fileId, mimeType }),


    /**
     * Write downloaded bytes to a path the user chose and register the result
     * as a local data source — the same treatment a file picked off disk gets.
     * Returns { success, filePath, format, tables: [{ name, path, sheet, schema }] }.
     */
    saveAndRegister: (params) =>
      ipcRenderer.invoke('cloud-storage:save-and-register', params),

    /** Analyze Excel file for sheet names. Returns { success, sheets: string[] }. */
    analyzeExcelFile: (fileData) =>
      ipcRenderer.invoke('cloud-storage:analyze-excel', fileData),

    /** Get Google Picker credentials for frontend integration. Returns { success, accessToken, apiKey, clientId, message }. */
    getPickerCredentials: (connectionId, dbType) =>
      ipcRenderer.invoke('cloud-storage:get-picker-credentials', { connectionId, dbType }),
  },

  /**
   * Enhanced file reader operations
   */
  fileReaderEnhanced: {
    /** Analyze Excel file and return sheet names. Returns { success, sheets: string[] }. */
    analyzeExcel: (fileData) =>
      ipcRenderer.invoke('file-reader:analyze-excel', fileData),
  },

  /**
   * OAuth2.0 operations
   */
  oauth: {
    /**
     * Generate OAuth2.0 authorization URL for a connector.
     * @param {string} dbType - Connector type (e.g., 'google-sheets', 'dropbox')
     * @param {object} config - OAuth config (clientId, clientSecret, redirectUri)
     * Returns { success, authUrl, scopes, state }
     */
    getAuthorizationUrl: (dbType, config) =>
      ipcRenderer.invoke('oauth:get-authorization-url', { dbType, config }),

    /**
     * Exchange authorization code for access/refresh tokens.
     * @param {string} dbType - Connector type
     * @param {object} config - OAuth config
     * @param {string} code - Authorization code from OAuth callback
     * @param {string} state - CSRF state token
     * Returns { success, tokens: { accessToken, refreshToken, expiryDate, ... } }
     */
    exchangeCode: (dbType, config, code, state) =>
      ipcRenderer.invoke('oauth:exchange-code', { dbType, config, code, state }),

    /**
     * Open system browser to OAuth authorization URL.
     * @param {string} url - Authorization URL to open
     * Returns { success }
     */
    openBrowser: (url) =>
      ipcRenderer.invoke('oauth:open-browser', { url }),

    /**
     * Start local HTTP server to handle OAuth callback.
     * @param {number} port - Port to listen on (default 3000)
     * Returns { success, code, state, error, errorDescription }
     */
    startCallbackServer: (port = 3000) =>
      ipcRenderer.invoke('oauth:start-callback-server', { port }),

    /**
     * Cancel an active OAuth callback server.
     * @param {number} port - Port of the server to cancel (default 3000)
     * Returns { success }
     */
    cancelServer: (port = 3000) =>
      ipcRenderer.invoke('oauth:cancel-server', { port }),
  },

  /**
   * Start trigger management for workflow automation.
   * Register and manage CRON jobs and file watchers.
   */
  startTriggers: {
    /**
     * Register a CRON job for time-based workflow triggers.
     * @param {object} params - { nodeId, workflowId, cronExpression, description }
     * Returns { success, message, cronExpression, nextRun }
     */
    registerCron: (params) =>
      ipcRenderer.invoke('start-trigger:register-cron', params),

    /**
     * Unregister a CRON job.
     * @param {object} params - { nodeId, workflowId }
     * Returns { success, message }
     */
    unregisterCron: (params) =>
      ipcRenderer.invoke('start-trigger:unregister-cron', params),

    /**
     * Register a file watcher for file/directory change triggers.
     * @param {object} params - { nodeId, workflowId, path, events, pattern }
     * Returns { success, message, path, events }
     */
    registerFileWatch: (params) =>
      ipcRenderer.invoke('start-trigger:register-file-watch', params),

    /**
     * Unregister a file watcher.
     * @param {object} params - { nodeId, workflowId }
     * Returns { success, message }
     */
    unregisterFileWatch: (params) =>
      ipcRenderer.invoke('start-trigger:unregister-file-watch', params),

    /**
     * Get all active triggers (CRON jobs and file watchers).
     * Returns { success, triggers: { cron, file } }
     */
    getActiveTriggers: () =>
      ipcRenderer.invoke('start-trigger:get-active'),
  },

  /**
   * Window chrome the renderer can't draw itself.
   */
  ui: {
    /**
     * Open the native Copy/Paste menu at the pointer. Electron ships no default
     * context menu, so a right-click does nothing until something calls this.
     * @param {object} params - { hasSelection, isEditable }
     */
    showTextContextMenu: (params) =>
      ipcRenderer.invoke('ui:showTextContextMenu', params),
  },
});
