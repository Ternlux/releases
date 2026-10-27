const { registerCronJob } = require('./cronTriggers');
const { registerFileWatcher } = require('./fileWatchTriggers');

/**
 * Load and register all triggers from saved workflows on app start
 * @param {Object} getDb - Function to get database instance
 * @param {Function} executeWorkflowFromTrigger - Workflow execution function
 */
async function registerAllWorkflowTriggers(getDb, executeWorkflowFromTrigger) {
  try {
    console.log('[Trigger] Loading workflow triggers from database...');

    const workflowsDb = getDb('workflows');
    const workflows = await workflowsDb.findAsync({});

    let cronCount = 0;
    let fileWatchCount = 0;

    for (const workflow of workflows) {
      if (!workflow.nodes || workflow.nodes.length === 0) continue;

      // Find all start nodes in the workflow
      const startNodes = workflow.nodes.filter(node => node.type === 'start');

      for (const node of startNodes) {
        const config = node.data?.config;
        if (!config) continue;

        const workflowId = workflow.id;
        const nodeId = node.id;

        // Register CRON trigger
        if (config.triggerType === 'time' && config.cronExpression) {
          const result = await registerCronJob(
            {
              nodeId,
              workflowId,
              cronExpression: config.cronExpression,
              description: config.description || 'Scheduled trigger'
            },
            executeWorkflowFromTrigger
          );

          if (result.success) {
            cronCount++;
            console.log(`[Trigger] Registered CRON job for workflow "${workflow.name}": ${config.cronExpression} (${config.description})`);
          } else {
            console.error(`[Trigger] Failed to register CRON job for workflow ${workflow.name}:`, result.message);
          }
        }

        // Register file watcher trigger
        if (config.triggerType === 'file' && config.fileWatchConfig) {
          const { path: watchPath, events, type: watchType } = config.fileWatchConfig;

          if (!watchPath || !events || events.length === 0) {
            console.warn(`[Trigger] Invalid file watch config for workflow ${workflow.name}, node ${nodeId}`);
            continue;
          }

          const result = await registerFileWatcher(
            {
              nodeId,
              workflowId,
              path: watchPath,
              events,
              pattern: config.fileWatchConfig.pattern
            },
            executeWorkflowFromTrigger
          );

          if (result.success) {
            fileWatchCount++;
            console.log(`[Trigger] Registered file watcher for workflow "${workflow.name}": ${watchPath} (events: ${events.join(', ')})`);
          } else {
            console.error(`[Trigger] Failed to register file watcher for workflow ${workflow.name}:`, result.message);
          }
        }
      }
    }

    console.log(`[Trigger] Registration complete: ${cronCount} CRON jobs, ${fileWatchCount} file watchers`);
  } catch (error) {
    console.error('[Trigger] Failed to load workflow triggers:', error);
  }
}

module.exports = {
  registerAllWorkflowTriggers
};
