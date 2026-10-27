/**
 * Plugin Manager for Ternlux
 * Handles loading and managing database connector plugins
 */

const fs = require('fs');
const path = require('path');
const { traceCall, isTracing, safeConfig, batchRowRange } = require('./NodeExecution/executionLog');

/**
 * Connector plugin folders that are shipped but deliberately not loaded.
 *
 * The plugin directory is the registry — every folder under plugins/connectors
 * is discovered and registered — so a connector is switched off here rather
 * than by deleting its code. Nothing downstream (the chat assistant's connector
 * list, the IPC handlers, the transform prompts) sees a connector that never
 * registers. To bring one back, drop it from this set and uncomment its UI
 * entries (see src/components/Workflows/connections/connectorCatalog.js).
 */
const DISABLED_CONNECTORS = new Set(['redshift']);

/**
 * Connector methods worth tracing, and how to describe a call to each.
 *
 * Every connector is reached through getConnector, so wrapping here covers the
 * transformer, the join helpers, the output writers and output validation at
 * once — instrumenting their ~29 individual call sites would have missed the
 * next one anybody adds.
 *
 * Each entry pulls the readable part out of that method's arguments. The
 * signatures genuinely differ: runQuery takes a `{ query }` OBJECT while
 * streamQuery takes the SQL as a bare string, and batchInsert has no statement
 * at all, only a table and rows.
 */
const TRACED_CONNECTOR_METHODS = {
  runQuery: (args) => ({ sql: args[2]?.query ?? null }),
  streamQuery: (args) => ({ sql: typeof args[2] === 'string' ? args[2] : null }),
  // `rowRange` is what makes a run of batch lines readable: a chunked load
  // writes one of these per call, and "rows=50000" repeated six times says
  // nothing about how far in the loop is. The range comes from the write loop's
  // own offset (executionLog.setBatchWindow) and is simply absent for a caller
  // that sets none.
  batchInsert: (args) => {
    const table = args[2] ?? null;
    const rows = Array.isArray(args[4]) ? args[4].length : null;
    return { detail: { table, rows, rowRange: batchRowRange(table, rows) } };
  },
  getTables: () => ({}),
  getColumns: (args) => ({ detail: { schema: args[2] ?? null, table: args[3] ?? null } }),
  // Which object a configured name actually resolves to decides where a load
  // lands, so it belongs in the run log. Untraced, a same-connection copy that
  // declined because the name resolved to nothing left NO line at all — the
  // only visible symptom was the streaming path running instead, which looks
  // like a decision nobody made.
  resolveTableRef: (args) => ({ detail: { schema: args[3] ?? null, table: args[2] ?? null } }),
  testConnection: () => ({}),
};

/**
 * Skill methods worth tracing.
 *
 * `execute` is traced in executeSkill itself, since that is the documented
 * entry point. These are the ones the executor calls STRAIGHT off the skill
 * object — the vector paths in the transformer, the join helpers and the output
 * writers — which would otherwise be the one part of a vector workflow that
 * left no trace at all.
 */
const TRACED_SKILL_METHODS = [
  'executeDataToVector',
  'exportToLanceDB',
  'fetchVectorSourceRecords',
  'embedAndUpsertJoinedRows',
];

const tracedSkills = new WeakMap();

/**
 * A connector wrapped so its calls land in the running node's execution log.
 *
 * Built lazily per plugin and cached: callers compare and reuse connector
 * objects, and handing back a fresh wrapper each time would defeat any identity
 * check and re-wrap on every query. The cache is keyed on the plugin itself, so
 * a reloaded plugin gets a new wrapper.
 */
const tracedConnectors = new WeakMap();

function traced(plugin, id) {
  if (!plugin || typeof plugin !== 'object') return plugin;
  const cached = tracedConnectors.get(plugin);
  if (cached) return cached;

  // Prototype-linked rather than copied: connectors are plain object literals
  // today, but a plugin that keeps state on `this` still sees its own object,
  // and any method NOT traced passes straight through untouched.
  const wrapper = Object.create(plugin);
  for (const [method, describe] of Object.entries(TRACED_CONNECTOR_METHODS)) {
    if (typeof plugin[method] !== 'function') continue;
    wrapper[method] = function tracedMethod(...args) {
      // Outside a workflow run — an IPC call from the Data Explorer, say —
      // there is nothing to log to, so call straight through rather than pay
      // for the description.
      if (!isTracing()) return plugin[method].apply(this, args);
      const { sql = null, detail = null } = describe(args) || {};
      return traceCall(
        {
          kind: 'connector',
          label: `${id}.${method}`,
          sql,
          detail: { connector: id, ...(safeConfig(args[0]) || {}), ...(detail || {}) },
        },
        () => plugin[method].apply(this, args),
      );
    };
  }

  tracedConnectors.set(plugin, wrapper);
  return wrapper;
}

/** The same wrapping for a skill plugin. See `traced`. */
function tracedSkill(skill, id) {
  if (!skill || typeof skill !== 'object') return skill;
  const cached = tracedSkills.get(skill);
  if (cached) return cached;

  const wrapper = Object.create(skill);
  for (const method of TRACED_SKILL_METHODS) {
    if (typeof skill[method] !== 'function') continue;
    wrapper[method] = function tracedMethod(...args) {
      if (!isTracing()) return skill[method].apply(this, args);
      return traceCall(
        { kind: 'skill', label: `${id}.${method}`, detail: { skillId: id } },
        () => skill[method].apply(this, args),
      );
    };
  }

  tracedSkills.set(skill, wrapper);
  return wrapper;
}

class PluginManager {
  constructor() {
    this.connectors = new Map();
    this.skills = new Map();
    this.connectorsDir = path.join(__dirname, '../plugins/connectors');
    this.skillsDir = path.join(__dirname, '../plugins/skills');
  }

  /**
   * Load all plugins from the plugins directory
   */
  loadPlugins() {
    this.loadConnectors();
    this.loadSkills();
  }

  /**
   * Load all connector plugins
   */
  loadConnectors() {
    console.log('Loading connector plugins from:', this.connectorsDir);

    if (!fs.existsSync(this.connectorsDir)) {
      console.warn('Connectors directory does not exist:', this.connectorsDir);
      return;
    }

    const pluginFolders = fs.readdirSync(this.connectorsDir);

    for (const folder of pluginFolders) {
      try {
        // Skip non-directories and hidden files
        const pluginPath = path.join(this.connectorsDir, folder);
        if (!fs.statSync(pluginPath).isDirectory() || folder.startsWith('.')) {
          continue;
        }

        if (DISABLED_CONNECTORS.has(folder)) {
          console.log(`Skipping disabled connector plugin: ${folder}`);
          continue;
        }

        this.loadConnectorPlugin(folder);
      } catch (error) {
        console.error(`Failed to load connector plugin ${folder}:`, error.message);
      }
    }

    console.log(`Loaded ${this.connectors.size} connector plugins`);
  }

  /**
   * Load all skill plugins
   */
  loadSkills() {
    console.log('Loading skill plugins from:', this.skillsDir);

    if (!fs.existsSync(this.skillsDir)) {
      console.warn('Skills directory does not exist:', this.skillsDir);
      return;
    }

    const skillFolders = fs.readdirSync(this.skillsDir);

    for (const folder of skillFolders) {
      try {
        // Skip non-directories and hidden files
        const skillPath = path.join(this.skillsDir, folder);
        if (!fs.statSync(skillPath).isDirectory() || folder.startsWith('.')) {
          continue;
        }

        this.loadSkillPlugin(folder);
      } catch (error) {
        console.error(`Failed to load skill plugin ${folder}:`, error.message);
      }
    }

    console.log(`Loaded ${this.skills.size} skill plugins`);
  }

  /**
   * Load a single connector plugin
   */
  loadConnectorPlugin(pluginFolder) {
    // Also checked here, not only in loadConnectors, so a disabled connector
    // stays disabled when the install handler reloads plugins by folder name.
    if (DISABLED_CONNECTORS.has(pluginFolder)) {
      console.log(`Skipping disabled connector plugin: ${pluginFolder}`);
      return;
    }

    const pluginPath = path.join(this.connectorsDir, pluginFolder);
    const indexPath = path.join(pluginPath, 'index.js');

    // Check if index.js exists
    if (!fs.existsSync(indexPath)) {
      throw new Error(`index.js not found in ${pluginFolder}`);
    }

    // Load the plugin module
    const plugin = require(indexPath);

    // Validate plugin type
    if (plugin.type !== 'connector') {
      throw new Error(`Plugin ${pluginFolder} is not a connector plugin`);
    }

    // Validate plugin interface
    if (!this.validateConnectorPlugin(plugin)) {
      throw new Error(`Plugin ${pluginFolder} does not implement required connector interface`);
    }

    // Register plugin
    const pluginId = plugin.id;
    this.connectors.set(pluginId, {
      ...plugin,
      metadata: plugin.metadata || {}
    });

    console.log(`✓ Loaded connector plugin: ${plugin.metadata?.displayName || plugin.name || pluginId}`);
  }

  /**
   * Load a single skill plugin
   */
  loadSkillPlugin(pluginFolder) {
    const pluginPath = path.join(this.skillsDir, pluginFolder);
    const indexPath = path.join(pluginPath, 'index.js');

    // Check if index.js exists
    if (!fs.existsSync(indexPath)) {
      throw new Error(`index.js not found in ${pluginFolder}`);
    }

    // Load the plugin module
    const plugin = require(indexPath);

    // Validate plugin type
    if (plugin.type !== 'skill') {
      throw new Error(`Plugin ${pluginFolder} is not a skill plugin`);
    }

    // Validate plugin interface
    if (!this.validateSkillPlugin(plugin)) {
      throw new Error(`Plugin ${pluginFolder} does not implement required skill interface`);
    }

    // Register plugin
    const pluginId = plugin.id;
    this.skills.set(pluginId, {
      ...plugin,
      metadata: plugin.metadata || {}
    });

    console.log(`✓ Loaded skill plugin: ${plugin.metadata?.displayName || plugin.name || pluginId}`);
  }

  /**
   * Validate that a connector plugin implements the required interface
   */
  validateConnectorPlugin(plugin) {
    // Different validation rules for different connector types
    let requiredMethods;

    if (plugin.storageType === 'cloud-storage') {
      // Cloud storage connectors require different methods
      requiredMethods = ['testConnection', 'getContainers', 'listObjects', 'downloadObject', 'uploadObject', 'deleteObject'];
    } else {
      // Database connectors require these methods
      requiredMethods = ['testConnection', 'getTables', 'getColumns', 'runQuery'];
    }

    for (const method of requiredMethods) {
      if (typeof plugin[method] !== 'function') {
        console.error(`Connector plugin missing required method: ${method}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Validate that a skill plugin implements the required interface
   */
  validateSkillPlugin(plugin) {
    // Skills require these methods
    const requiredMethods = ['getDescription', 'execute'];

    for (const method of requiredMethods) {
      if (typeof plugin[method] !== 'function') {
        console.error(`Skill plugin missing required method: ${method}`);
        return false;
      }
    }

    // Validate category. 'chat' skills are used only by the main chat assistant;
    // getSkillsByCategory('transformer' | 'join') never returns them.
    if (!plugin.category || !['transformer', 'join', 'both', 'chat'].includes(plugin.category)) {
      console.error(`Skill plugin must have category: transformer, join, both, or chat`);
      return false;
    }

    return true;
  }

  /**
   * Get a connector plugin by ID
   */
  getConnector(id) {
    return traced(this.connectors.get(id), id);
  }

  /**
   * Check if a connector exists
   */
  hasConnector(id) {
    return this.connectors.has(id);
  }

  /**
   * List all available connector plugins
   */
  listConnectors() {
    return Array.from(this.connectors.values()).map(plugin => ({
      id: plugin.id,
      name: plugin.metadata?.displayName || plugin.name,
      type: plugin.type,
      icon: plugin.icon,
      configSchema: plugin.configSchema,
      version: plugin.metadata?.version || '1.0.0',
      description: plugin.metadata?.description || '',
      dbCategory: plugin.dbCategory || null,
      storageType: plugin.storageType || null,
      authType: plugin.authType || null
    }));
  }

  /**
   * Get a skill plugin by ID
   */
  getSkill(id) {
    return tracedSkill(this.skills.get(id), id);
  }

  /**
   * Check if a skill exists
   */
  hasSkill(id) {
    return this.skills.has(id);
  }

  /**
   * List all available skill plugins
   */
  listSkills() {
    return Array.from(this.skills.values()).map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      type: plugin.type,
      category: plugin.category,
      icon: plugin.icon,
      version: plugin.metadata?.version || '1.0.0',
      description: plugin.metadata?.description || '',
      metadata: plugin.metadata || {}
    }));
  }

  /**
   * Get skills by category
   */
  getSkillsByCategory(category) {
    return Array.from(this.skills.values())
      .filter(skill => skill.category === category || skill.category === 'both')
      .map(plugin => ({
        id: plugin.id,
        name: plugin.name,
        category: plugin.category,
        description: plugin.metadata?.description || '',
        metadata: plugin.metadata || {}
      }));
  }

  /**
   * Get skill descriptions for AI context
   * Used to inject skill information into transformation/join prompts
   * @param {String} category - Filter by category ('transformer', 'join', or null for all)
   * @param {Object} context - Context to pass to getTransformPrompts (e.g., operationType, sourceSchema)
   */
  getSkillDescriptions(category = null, context = {}) {
    const skills = category
      ? this.getSkillsByCategory(category)
      : this.listSkills();

    return skills.map(skill => {
      const plugin = this.skills.get(skill.id);
      const description = plugin.getDescription ? plugin.getDescription() : {};
      const prompts = plugin.getTransformPrompts ? plugin.getTransformPrompts(context) : {};

      return {
        id: skill.id,
        name: skill.name,
        category: skill.category,
        description: description,
        prompts: prompts
      };
    });
  }

  /**
   * Analyze a skill request
   * @param {String} skillId - The skill ID
   * @param {Object} params - Analysis parameters
   */
  async analyzeSkillRequest(skillId, params) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.analyzeRequest !== 'function') {
      // If skill doesn't have analyzeRequest, assume it's ready to execute
      return {
        action: 'generate_transformation',
        skillParams: params.skillParams || {}
      };
    }

    return await skill.analyzeRequest(params);
  }

  /**
   * Build a skill prompt (main skill interaction function)
   * @param {String} skillId - The skill ID
   * @param {Object} params - Request parameters
   */
  async buildSkillPrompt(skillId, params) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.buildSkillPrompt !== 'function') {
      throw new Error(`Skill ${skillId} does not implement buildSkillPrompt method`);
    }

    return await skill.buildSkillPrompt(params);
  }

  /**
   * Process a skill response from AI
   * @param {String} skillId - The skill ID
   * @param {String} aiResponse - AI response to process
   * @param {String} operationType - 'sql' or 'nosql' or 'vector'
   * @param {Object} currentState - Current state including isSourceVector flag
   * @param {Array} availableConnections - Available database connections
   * @param {Object} [helpers] - Injected helpers (callAI, runQuery, ...) for skills that need them
   */
  async processSkillResponse(skillId, aiResponse, operationType, currentState = {}, availableConnections = [], helpers = null) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.processSkillResponse !== 'function') {
      throw new Error(`Skill ${skillId} does not implement processSkillResponse method`);
    }

    return skill.processSkillResponse(aiResponse, operationType, currentState, availableConnections, helpers);
  }

  /**
   * Execute a skill
   */
  async executeSkill(skillId, params) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.execute !== 'function') {
      throw new Error(`Skill ${skillId} does not implement execute method`);
    }

    // Params carry the skill's whole working set — code, rows, connection
    // configs — so only its shape is described, never its contents.
    return await traceCall(
      {
        kind: 'skill',
        label: `skill ${skillId}`,
        detail: {
          skillId,
          operation: params?.operationType || params?.operation || null,
          language: params?.language || null,
        },
      },
      () => skill.execute(params),
    );
  }

  /**
   * Unload a connector plugin
   */
  unloadConnector(pluginId) {
    const plugin = this.connectors.get(pluginId);
    if (plugin && typeof plugin.closeConnection === 'function') {
      // Close any open connections
      plugin.closeConnection();
    }
    this.connectors.delete(pluginId);
  }

  /**
   * Unload a skill plugin
   */
  unloadSkill(pluginId) {
    this.skills.delete(pluginId);
  }
}

module.exports = new PluginManager();
