/**
 * workflowCodeWatcher.js — Keep the open workflow in the editor in sync with
 * its externalized code files on disk.
 *
 * Node code (SQL / JS / Python) is externalized to files under
 * {userData}/workflow-code/{workflow}/... by lib/workflowCode.js. Those files
 * are the source of truth on read, so editing one in an external editor or AI
 * tool changes what the workflow actually runs. This watcher notices such
 * edits and tells the renderer to reload the workflow it has open, so the
 * canvas and the on-disk code never drift apart.
 *
 * This is editor sync only — unlike triggers/fileWatchTriggers.js it never
 * executes the workflow. It mirrors that module's chokidar setup.
 *
 * Watchers are keyed per (renderer, workflow) so multiple windows can each
 * watch their own open workflow independently.
 */

const chokidar = require('chokidar');
const fs = require('fs');

// Key format: `${webContentsId}:${workflowId}` → chokidar watcher
const activeCodeWatchers = new Map();

// workflowId → timestamp until which this workflow's file events are OUR OWN.
const selfWriteUntil = new Map();

// How long after an app write its file events keep arriving. chokidar holds an
// event back until the file has been quiet for `stabilityThreshold` (500ms
// below), and a build persists a whole workflow's code in one go, so the window
// has to outlast the slowest of those settles rather than the write itself.
const SELF_WRITE_WINDOW_MS = 3000;

/**
 * Declare that the app is about to rewrite this workflow's code files.
 *
 * The watcher exists to catch EXTERNAL edits — an IDE, an AI tool, anything
 * outside the app — and reload the canvas from them. A write the app made is
 * never external: the editor already has that state, or is about to be handed
 * it. Every such write funnels through the workflows-collection wrapper in
 * electron.js, which externalizes node code on insert and update, so calling
 * this there covers all of them: the AI builder persisting a node, an execution
 * flagging one, and the editor's own save.
 *
 * Without it, a build that adds a node rewrites the code folder, chokidar
 * reports it, and the editor reloads the workflow mid-build — repeatedly, once
 * per write, while the build is still going.
 */
function suppressWorkflowCodeEvents(workflowId, ms = SELF_WRITE_WINDOW_MS) {
  if (!workflowId) return;
  const until = Date.now() + ms;
  const current = selfWriteUntil.get(workflowId) || 0;
  if (until > current) selfWriteUntil.set(workflowId, until);
}

function isSelfWrite(workflowId) {
  const until = selfWriteUntil.get(workflowId);
  if (!until) return false;
  if (Date.now() < until) return true;
  selfWriteUntil.delete(workflowId);
  return false;
}

function watcherKey(webContentsId, workflowId) {
  return `${webContentsId}:${workflowId}`;
}

/**
 * Start watching a workflow's externalized-code folder.
 * @param {Object} params
 * @param {number} params.webContentsId - Owning renderer's webContents id
 * @param {string} params.workflowId    - Workflow being watched
 * @param {string} params.watchPath      - Absolute path of {codeBaseDir}/{workflowDir}
 * @param {(payload: { workflowId: string, event: string, path: string }) => void} notify
 *        - Called (debounced by awaitWriteFinish) when a code file changes.
 * @returns {{ success: boolean, message: string }}
 */
function watchWorkflowCode(params, notify) {
  try {
    const { webContentsId, workflowId, watchPath } = params;

    if (webContentsId == null || !workflowId || !watchPath) {
      return { success: false, message: 'Missing required parameters: webContentsId, workflowId, watchPath' };
    }

    const key = watcherKey(webContentsId, workflowId);

    // Replace any existing watcher for this renderer+workflow.
    unwatchWorkflowCode({ webContentsId, workflowId });

    // The folder may not exist yet (e.g. a freshly created workflow with no
    // externalized code). Nothing to watch — the renderer re-registers after
    // the first save, once the workflow id and its code files exist.
    if (!fs.existsSync(watchPath)) {
      return { success: true, message: `No code folder yet for ${workflowId}`, watching: false };
    }

    const watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/Thumbs.db'],
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    const onChange = (event) => (filePath) => {
      // Our own write coming back at us — the editor is already in step with it.
      if (isSelfWrite(workflowId)) return;
      console.log(`[CodeWatch] ${event} detected for ${workflowId}: ${filePath}`);
      try {
        notify({ workflowId, event, path: filePath });
      } catch (err) {
        console.error(`[CodeWatch] notify failed for ${key}:`, err);
      }
    };

    watcher.on('change', onChange('change'));
    watcher.on('add', onChange('add'));
    watcher.on('unlink', onChange('unlink'));
    watcher.on('error', (error) => {
      console.error(`[CodeWatch] Watcher error for ${key}:`, error);
    });

    activeCodeWatchers.set(key, watcher);
    console.log(`[CodeWatch] Watching ${watchPath} for ${key}`);
    return { success: true, message: `Watching ${watchPath}`, watching: true };
  } catch (error) {
    console.error('[CodeWatch] watch error:', error);
    return { success: false, message: `Failed to watch workflow code: ${error.message}` };
  }
}

/**
 * Stop watching a workflow's code folder for one renderer.
 * @param {Object} params - { webContentsId, workflowId }
 */
async function unwatchWorkflowCode(params) {
  const { webContentsId, workflowId } = params || {};
  const key = watcherKey(webContentsId, workflowId);
  const watcher = activeCodeWatchers.get(key);
  if (!watcher) return { success: true, message: 'No active code watcher' };
  await watcher.close();
  activeCodeWatchers.delete(key);
  console.log(`[CodeWatch] Stopped watching ${key}`);
  return { success: true, message: 'Stopped watching workflow code' };
}

/**
 * Stop every code watcher owned by one renderer (call when its window closes).
 * @param {number} webContentsId
 */
async function unwatchAllForWebContents(webContentsId) {
  const prefix = `${webContentsId}:`;
  const closePromises = [];
  for (const [key, watcher] of activeCodeWatchers) {
    if (key.startsWith(prefix)) {
      closePromises.push(watcher.close());
      activeCodeWatchers.delete(key);
    }
  }
  await Promise.all(closePromises);
}

/** Stop all code watchers (app shutdown). */
async function stopAllCodeWatchers() {
  const closePromises = [];
  activeCodeWatchers.forEach((watcher, key) => {
    console.log(`[CodeWatch] Stopping watcher: ${key}`);
    closePromises.push(watcher.close());
  });
  await Promise.all(closePromises);
  activeCodeWatchers.clear();
}

module.exports = {
  watchWorkflowCode,
  unwatchWorkflowCode,
  unwatchAllForWebContents,
  stopAllCodeWatchers,
  suppressWorkflowCodeEvents,
};
