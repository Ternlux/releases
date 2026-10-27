const chokidar = require('chokidar');
const fs = require('fs');

// Store active file watchers
// Key format: `${workflowId}:${nodeId}`
const activeFileWatchers = new Map();

/**
 * Register a file watcher for file/directory change triggers
 * @param {Object} params - Registration parameters
 * @param {Function} executeWorkflowFromTrigger - Workflow execution function
 * @returns {Promise<Object>} Registration result
 */
async function registerFileWatcher(params, executeWorkflowFromTrigger) {
  try {
    const { nodeId, workflowId, path: watchPath, events, pattern } = params;

    if (!nodeId || !workflowId || !watchPath || !events || events.length === 0) {
      return {
        success: false,
        message: 'Missing required parameters: nodeId, workflowId, path, events'
      };
    }

    // Validate path exists
    if (!fs.existsSync(watchPath)) {
      return {
        success: false,
        message: `Path does not exist: ${watchPath}`
      };
    }

    const triggerKey = `${workflowId}:${nodeId}`;

    // Stop existing watcher if any
    if (activeFileWatchers.has(triggerKey)) {
      const existingWatcher = activeFileWatchers.get(triggerKey);
      await existingWatcher.close();
      activeFileWatchers.delete(triggerKey);
      console.log(`[FileWatch] Stopped existing watcher for ${triggerKey}`);
    }

    // Create new file watcher
    const watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/Thumbs.db'],
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      }
    });

    // Set up event handlers based on selected events
    const handleEvent = (eventType, filePath) => {
      console.log(`[FileWatch] ${eventType} detected: ${filePath}`);

      // Execute workflow without awaiting (fire and forget)
      // This allows the file watcher to continue processing events
      // The execution lock in executeWorkflowFromTrigger prevents concurrent runs
      executeWorkflowFromTrigger(workflowId, nodeId, {
        type: 'file-watch',
        description: `File ${eventType} on ${filePath}`,
        event: eventType,
        path: filePath,
        watchPath: watchPath
      }).catch(error => {
        console.error(`[FileWatch] Workflow execution error for ${filePath}:`, error);
      });
    };

    if (events.includes('add')) {
      watcher.on('add', (path) => handleEvent('add', path));
    }
    if (events.includes('change')) {
      watcher.on('change', (path) => handleEvent('change', path));
    }
    if (events.includes('unlink')) {
      watcher.on('unlink', (path) => handleEvent('unlink', path));
    }
    if (events.includes('addDir')) {
      watcher.on('addDir', (path) => handleEvent('addDir', path));
    }
    if (events.includes('unlinkDir')) {
      watcher.on('unlinkDir', (path) => handleEvent('unlinkDir', path));
    }

    watcher.on('error', (error) => {
      console.error(`[FileWatch] Watcher error for ${triggerKey}:`, error);
    });

    activeFileWatchers.set(triggerKey, watcher);

    console.log(`[FileWatch] Registered watcher for ${triggerKey}: ${watchPath} (events: ${events.join(', ')})`);

    return {
      success: true,
      message: `File watcher registered for ${watchPath}`,
      path: watchPath,
      events
    };

  } catch (error) {
    console.error('[FileWatch] Registration error:', error);
    return {
      success: false,
      message: `Failed to register file watcher: ${error.message}`
    };
  }
}

/**
 * Unregister a file watcher
 * @param {Object} params - Unregistration parameters
 * @returns {Promise<Object>} Unregistration result
 */
async function unregisterFileWatcher(params) {
  try {
    const { nodeId, workflowId } = params;
    const triggerKey = `${workflowId}:${nodeId}`;

    if (activeFileWatchers.has(triggerKey)) {
      const watcher = activeFileWatchers.get(triggerKey);
      await watcher.close();
      activeFileWatchers.delete(triggerKey);

      console.log(`[FileWatch] Unregistered watcher for ${triggerKey}`);

      return {
        success: true,
        message: 'File watcher stopped'
      };
    }

    return {
      success: true,
      message: 'No active file watcher found'
    };

  } catch (error) {
    console.error('[FileWatch] Unregistration error:', error);
    return {
      success: false,
      message: `Failed to unregister file watcher: ${error.message}`
    };
  }
}

/**
 * Get all active file watchers
 * @returns {Array} List of active file watchers
 */
function getActiveFileWatchers() {
  return Array.from(activeFileWatchers.keys()).map(key => {
    const [workflowId, nodeId] = key.split(':');
    return { workflowId, nodeId, type: 'file' };
  });
}

/**
 * Stop all file watchers (for cleanup)
 */
async function stopAllFileWatchers() {
  const closePromises = [];
  activeFileWatchers.forEach((watcher, key) => {
    console.log(`[FileWatch] Stopping watcher: ${key}`);
    closePromises.push(watcher.close());
  });
  await Promise.all(closePromises);
  activeFileWatchers.clear();
}

module.exports = {
  registerFileWatcher,
  unregisterFileWatcher,
  getActiveFileWatchers,
  stopAllFileWatchers
};
