const cron = require('node-cron');

// Store active CRON jobs
// Key format: `${workflowId}:${nodeId}`
const activeCronJobs = new Map();

/**
 * Register a CRON job for time-based workflow triggers
 * @param {Object} params - Registration parameters
 * @param {Function} executeWorkflowFromTrigger - Workflow execution function
 * @returns {Promise<Object>} Registration result
 */
async function registerCronJob(params, executeWorkflowFromTrigger) {
  try {
    const { nodeId, workflowId, cronExpression, description } = params;

    if (!nodeId || !workflowId || !cronExpression) {
      return {
        success: false,
        message: 'Missing required parameters: nodeId, workflowId, cronExpression'
      };
    }

    // Validate CRON expression
    if (!cron.validate(cronExpression)) {
      return {
        success: false,
        message: `Invalid CRON expression: ${cronExpression}`
      };
    }

    const triggerKey = `${workflowId}:${nodeId}`;

    // Stop existing job if any
    if (activeCronJobs.has(triggerKey)) {
      const existingJob = activeCronJobs.get(triggerKey);
      existingJob.stop();
      activeCronJobs.delete(triggerKey);
      console.log(`[CRON] Stopped existing job for ${triggerKey}`);
    }

    // Create new CRON job
    const job = cron.schedule(cronExpression, () => {
      console.log(`[CRON] Triggered workflow ${workflowId} via node ${nodeId}`);

      // Execute workflow without awaiting (fire and forget)
      // This allows the CRON job to continue its schedule
      // The execution lock in executeWorkflowFromTrigger prevents concurrent runs
      executeWorkflowFromTrigger(workflowId, nodeId, {
        type: 'cron',
        description: description,
        cronExpression: cronExpression
      }).catch(error => {
        console.error(`[CRON] Workflow execution error for ${workflowId}:`, error);
      });
    }, {
      scheduled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });

    activeCronJobs.set(triggerKey, job);

    console.log(`[CRON] Registered job for ${triggerKey}: ${cronExpression} (${description})`);

    return {
      success: true,
      message: `CRON job registered: ${description}`,
      cronExpression
    };

  } catch (error) {
    console.error('[CRON] Registration error:', error);
    return {
      success: false,
      message: `Failed to register CRON job: ${error.message}`
    };
  }
}

/**
 * Unregister a CRON job
 * @param {Object} params - Unregistration parameters
 * @returns {Promise<Object>} Unregistration result
 */
async function unregisterCronJob(params) {
  try {
    const { nodeId, workflowId } = params;
    const triggerKey = `${workflowId}:${nodeId}`;

    if (activeCronJobs.has(triggerKey)) {
      const job = activeCronJobs.get(triggerKey);
      job.stop();
      activeCronJobs.delete(triggerKey);

      console.log(`[CRON] Unregistered job for ${triggerKey}`);

      return {
        success: true,
        message: 'CRON job stopped'
      };
    }

    return {
      success: true,
      message: 'No active CRON job found'
    };

  } catch (error) {
    console.error('[CRON] Unregistration error:', error);
    return {
      success: false,
      message: `Failed to unregister CRON job: ${error.message}`
    };
  }
}

/**
 * Get all active CRON jobs
 * @returns {Array} List of active CRON jobs
 */
function getActiveCronJobs() {
  return Array.from(activeCronJobs.keys()).map(key => {
    const [workflowId, nodeId] = key.split(':');
    return { workflowId, nodeId, type: 'cron' };
  });
}

/**
 * Stop all CRON jobs (for cleanup)
 */
function stopAllCronJobs() {
  activeCronJobs.forEach((job, key) => {
    job.stop();
    console.log(`[CRON] Stopped job: ${key}`);
  });
  activeCronJobs.clear();
}

module.exports = {
  registerCronJob,
  unregisterCronJob,
  getActiveCronJobs,
  stopAllCronJobs
};
