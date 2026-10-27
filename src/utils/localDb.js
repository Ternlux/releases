/**
 * localDb.js — Local NeDB storage for offline / guest users (no JWT).
 *
 * In Electron the datastores are file-backed and run in the main process.
 * The renderer accesses them via window.electronAPI.db (IPC + contextBridge).
 *
 * In a plain browser session (npm start without Electron) four in-memory
 * NeDB instances are created directly in the renderer as a fallback.
 * Data is NOT persisted across page reloads in that mode.
 *
 * Collections
 *  - workflows
 *  - connections
 *  - executions
 *  - chatSessions     (messages embedded inside each session document)
 *  - workflowHistory  (versions embedded inside each workflow's document)
 *
 * Exported namespaces
 *  workflowsDb, connectionsDb, executionsDb, chatDb, workflowHistoryDb
 */

import {
  snapshotOf, diffSnapshots, describeDiff, isUnchanged, MAX_VERSIONS,
} from './workflowHistory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isElectron() {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}

/** Generate a simple UUID v4. */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Browser-only in-memory fallback datastores (lazy-created)
// ---------------------------------------------------------------------------

let _browserDbs = null;
let _browserDbsPromise = null;

async function buildBrowserDbs() {
  // Dynamic import so CRA/webpack can tree-shake for Electron builds
  const Datastore = (await import('@seald-io/nedb')).default;
  const dbs = {
    workflows:       new Datastore({ inMemoryOnly: true }),
    connections:     new Datastore({ inMemoryOnly: true }),
    executions:      new Datastore({ inMemoryOnly: true }),
    chatSessions:    new Datastore({ inMemoryOnly: true }),
    workflowHistory: new Datastore({ inMemoryOnly: true }),
  };
  // The same indexes the Electron store declares (see getDb in electron.js), so
  // the fallback enforces the same rules — one history document per workflow
  // above all, which is what keeps a lost race loud instead of silent.
  await dbs.workflowHistory.ensureIndexAsync({ fieldName: 'workflowId', unique: true });
  _browserDbs = dbs;
  return dbs;
}

async function getBrowserDbs() {
  if (_browserDbs) return _browserDbs;
  // Memoize the PROMISE, not just the result: two callers racing the first
  // access would otherwise each build a separate set of datastores, and one
  // of them would be writing to a store nothing else ever reads.
  if (!_browserDbsPromise) _browserDbsPromise = buildBrowserDbs();
  return _browserDbsPromise;
}

// ---------------------------------------------------------------------------
// Low-level adapters — route through IPC or in-memory NeDB
// ---------------------------------------------------------------------------

async function dbInsert(collection, doc) {
  if (isElectron()) return window.electronAPI.db.insert(collection, doc);
  const dbs = await getBrowserDbs();
  return dbs[collection].insertAsync(doc);
}

async function dbFind(collection, query = {}, sort = null, limit = 0, skip = 0) {
  if (isElectron()) return window.electronAPI.db.find(collection, query, sort, limit, skip);
  const dbs = await getBrowserDbs();
  let cursor = dbs[collection].findAsync(query);
  if (sort)  cursor = cursor.sort(sort);
  if (skip)  cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  return cursor;
}

async function dbFindOne(collection, query = {}) {
  if (isElectron()) return window.electronAPI.db.findOne(collection, query);
  const dbs = await getBrowserDbs();
  return dbs[collection].findOneAsync(query);
}

async function dbUpdate(collection, query, update, options = {}) {
  if (isElectron()) return window.electronAPI.db.update(collection, query, update, options);
  const dbs = await getBrowserDbs();
  return dbs[collection].updateAsync(query, update, options);
}

async function dbRemove(collection, query, options = {}) {
  if (isElectron()) return window.electronAPI.db.remove(collection, query, options);
  const dbs = await getBrowserDbs();
  return dbs[collection].removeAsync(query, options);
}

async function dbCount(collection, query = {}) {
  if (isElectron()) return window.electronAPI.db.count(collection, query);
  const dbs = await getBrowserDbs();
  return dbs[collection].countAsync(query);
}

// ---------------------------------------------------------------------------
// workflowsDb
// ---------------------------------------------------------------------------

export const workflowsDb = {
  /**
   * Insert a new workflow.
   * @param {object} workflow - Workflow data (name, description, nodes, edges, …)
   * @returns {Promise<object>} Inserted doc with _id and id fields
   */
  async save(workflow) {
    const now = new Date().toISOString();
    const doc = {
      ...workflow,
      id: workflow.id || uuid(),
      createdAt: workflow.createdAt || now,
      updatedAt: now,
      createdBy: workflow.createdBy || 'local',
    };
    return dbInsert('workflows', doc);
  },

  /**
   * Return all workflows sorted by updatedAt descending.
   * @returns {Promise<object[]>}
   */
  async getAll() {
    return dbFind('workflows', {}, { updatedAt: -1 });
  },

  /**
   * Find one workflow by its public id field.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    return dbFindOne('workflows', { id });
  },

  /**
   * Update a workflow by its public id.
   * @param {string} id
   * @param {object} data - Fields to merge
   * @returns {Promise<object>} NeDB update result
   */
  async update(id, data) {
    const now = new Date().toISOString();
    return dbUpdate('workflows', { id }, { $set: { ...data, updatedAt: now } });
  },

  /**
   * Delete a workflow by its public id.
   * @param {string} id
   * @returns {Promise<number>} Number of removed docs
   */
  async delete(id) {
    return dbRemove('workflows', { id });
  },
};

// ---------------------------------------------------------------------------
// connectionsDb
// ---------------------------------------------------------------------------

/**
 * Tell the open screens the saved connections changed. The canvas listens so a
 * data source whose connection was just deleted turns red at once, without
 * the workflow having to be reopened.
 */
export const CONNECTIONS_CHANGED_EVENT = 'ternlux:connections-changed';
const announceConnectionsChanged = () => {
  try { window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT)); } catch (_) { /* no window (tests) */ }
};

export const connectionsDb = {
  /**
   * Insert a new connection.
   * @param {object} connection
   * @returns {Promise<object>}
   */
  async save(connection) {
    const doc = {
      ...connection,
      id: connection.id || uuid(),
      createdAt: connection.createdAt || new Date().toISOString(),
    };
    const saved = await dbInsert('connections', doc);
    announceConnectionsChanged();
    return saved;
  },

  /**
   * Return all connections sorted by createdAt descending.
   * @returns {Promise<object[]>}
   */
  async getAll() {
    return dbFind('connections', {}, { createdAt: -1 });
  },

  /**
   * Find one connection by its public id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    return dbFindOne('connections', { id });
  },

  /**
   * Update a connection by its public id.
   * @param {string} id
   * @param {object} data
   * @returns {Promise<object>}
   */
  async update(id, data) {
    const result = await dbUpdate('connections', { id }, { $set: data });
    announceConnectionsChanged();
    return result;
  },

  /**
   * Delete a connection by its public id.
   * @param {string} id
   * @returns {Promise<number>}
   */
  async delete(id) {
    const removed = await dbRemove('connections', { id });
    announceConnectionsChanged();
    return removed;
  },
};

// ---------------------------------------------------------------------------
// executionsDb
// ---------------------------------------------------------------------------

export const executionsDb = {
  /**
   * Insert a new execution record.
   * @param {object} execution
   * @returns {Promise<object>}
   */
  async save(execution) {
    const doc = {
      ...execution,
      executionId: execution.executionId || uuid(),
      startTime: execution.startTime || new Date().toISOString(),
    };
    return dbInsert('executions', doc);
  },

  /**
   * Return paginated executions sorted by startTime descending.
   * @param {{ page?: number, limit?: number }} options
   * @returns {Promise<{ docs: object[], total: number, hasMore: boolean }>}
   */
  async getAll({ page = 1, limit = 10 } = {}) {
    const skip = (page - 1) * limit;
    const [docs, total] = await Promise.all([
      dbFind('executions', {}, { startTime: -1 }, limit, skip),
      dbCount('executions', {}),
    ]);
    return { docs, total, hasMore: skip + docs.length < total };
  },

  /**
   * Find one execution by its executionId.
   * @param {string} executionId
   * @returns {Promise<object|null>}
   */
  async getById(executionId) {
    return dbFindOne('executions', { executionId });
  },

  /**
   * Find the most recent still-running execution for a workflow, if any.
   * Used to reflect an in-progress run when the editor is re-opened.
   * @param {string} workflowId
   * @returns {Promise<object|null>}
   */
  async getRunningByWorkflow(workflowId) {
    if (!workflowId) return null;
    const docs = await dbFind('executions', { workflowId, status: 'running' }, { startTime: -1 }, 1, 0);
    return docs[0] || null;
  },

  /**
   * Every execution currently in progress, across all workflows, newest first.
   * Backs the execution monitor panel.
   * @returns {Promise<object[]>}
   */
  async getRunning() {
    return dbFind('executions', { status: 'running' }, { startTime: -1 });
  },

  /**
   * The most recent execution for a workflow whatever its status — the "most
   * recent run" the canvas reads to mark which node failed last time.
   * @param {string} workflowId
   * @returns {Promise<object|null>}
   */
  async getLatestByWorkflow(workflowId) {
    if (!workflowId) return null;
    const docs = await dbFind('executions', { workflowId }, { startTime: -1 }, 1, 0);
    return docs[0] || null;
  },

  /**
   * Update an execution by its executionId.
   * @param {string} executionId
   * @param {object} data - Fields to merge
   * @returns {Promise<object>} NeDB update result
   */
  async update(executionId, data) {
    return dbUpdate('executions', { executionId }, { $set: data });
  },

  /**
   * Delete an execution by executionId.
   * @param {string} executionId
   * @returns {Promise<number>}
   */
  async delete(executionId) {
    return dbRemove('executions', { executionId });
  },

  /**
   * Compute aggregate stats across all local executions.
   * @returns {Promise<{ totalExecutions: number, completedExecutions: number, failedExecutions: number, successRate: number }>}
   */
  async getStats() {
    const [total, completed, failed] = await Promise.all([
      dbCount('executions', {}),
      dbCount('executions', { status: 'completed' }),
      dbCount('executions', { status: 'failed' }),
    ]);
    return {
      totalExecutions: total,
      completedExecutions: completed,
      failedExecutions: failed,
      successRate: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  },
};

// ---------------------------------------------------------------------------
// chatDb
// ---------------------------------------------------------------------------

export const chatDb = {
  /**
   * Create a new chat session with an empty messages array.
   * @param {string} chatId - UUID for the new session
   * @param {string} title  - Display title
   * @returns {Promise<object>} Inserted session doc
   */
  async saveSession(chatId, title = 'New Chat') {
    const now = new Date().toISOString();
    return dbInsert('chatSessions', {
      chatId: chatId || uuid(),
      title,
      status: 'pending',
      lastMessageAt: now,
      messages: [],
    });
  },

  /**
   * Return all sessions sorted by lastMessageAt descending (without messages array).
   * @returns {Promise<Array<{ chatId, title, status, lastMessageAt }>>}
   */
  async getSessions() {
    const sessions = await dbFind('chatSessions', {}, { lastMessageAt: -1 });
    return sessions.map(({ _id, chatId, title, status, lastMessageAt }) => ({
      _id, chatId, title, status, lastMessageAt,
    }));
  },

  /**
   * Return one full session (including messages) by chatId.
   * @param {string} chatId
   * @returns {Promise<object|null>}
   */
  async getSession(chatId) {
    return dbFindOne('chatSessions', { chatId });
  },

  /**
   * Update session metadata (title, status, lastMessageAt, …).
   * @param {string} chatId
   * @param {object} data - Fields to $set
   * @returns {Promise<object>}
   */
  async updateSession(chatId, data) {
    return dbUpdate('chatSessions', { chatId }, { $set: data });
  },

  /**
   * Delete a session and all its embedded messages.
   * @param {string} chatId
   * @returns {Promise<number>}
   */
  async deleteSession(chatId) {
    return dbRemove('chatSessions', { chatId });
  },

  /**
   * Append a message to a session's embedded messages array.
   * Also updates lastMessageAt and sets status to 'completed'.
   * @param {string} chatId
   * @param {object} message - { id, text, sender, timestamp, …}
   * @returns {Promise<object>}
   */
  async appendMessage(chatId, message) {
    const now = new Date().toISOString();
    return dbUpdate(
      'chatSessions',
      { chatId },
      {
        $push: { messages: message },
        $set: { lastMessageAt: now, status: 'completed' },
      },
    );
  },

  /**
   * Return just the messages array for a session.
   * @param {string} chatId
   * @returns {Promise<object[]>}
   */
  async getMessages(chatId) {
    const session = await dbFindOne('chatSessions', { chatId });
    return session ? session.messages : [];
  },
};

// ---------------------------------------------------------------------------
// workflowHistoryDb
// ---------------------------------------------------------------------------
//
// One document per workflow, keyed by workflowId — that is this collection's
// primary key (unique-indexed in the main process), so a workflow's whole
// history is one read and one write.
//
//   {
//     workflowId,        // primary key — matches workflows.id
//     workflowName,      // name at the time of the last recorded version
//     versionCounter,    // monotonic; never reused, even after pruning
//     createdAt, updatedAt,
//     versions: [        // oldest → newest
//       { versionId, version, timestamp, source, label, summary, counts,
//         nodeCount, snapshot: { name, description, nodes, edges, executionSteps } }
//     ]
//   }
//
// Every version carries a FULL snapshot rather than a delta: that is what a
// revert restores, and it means pruning old versions can never corrupt the ones
// that remain. The diff shown in the UI is recomputed from adjacent snapshots
// (see utils/workflowHistory.js) instead of being stored twice.

const HISTORY_COLLECTION = 'workflowHistory';

// `record` is a read-modify-write, and its callers are not coordinated with
// each other: the editor records when it loads a workflow, again when a build
// lands, and again on every save — and React's StrictMode runs mount effects
// twice in development, so the load path alone fires twice. Two calls that both
// read "no history yet" would both INSERT, which the unique index on workflowId
// rejects ("it violates the unique constraint"); two that read the same version
// list would each append to their own copy and one entry would be lost.
//
// So record() runs one at a time per workflow: each call waits for the previous
// one to finish, and therefore reads what it wrote.
const _recordQueues = new Map();

function queuePerWorkflow(workflowId, task) {
  const prior = _recordQueues.get(workflowId) || Promise.resolve();
  // Run next whether the previous call resolved or rejected — one failed record
  // must not wedge the queue for the rest of the session.
  const run = prior.then(task, task);
  // What the NEXT caller waits on: settled, never rejected.
  const tail = run.then(() => {}, () => {});
  _recordQueues.set(workflowId, tail);
  tail.then(() => {
    // Drop the entry once the queue has drained, so the map doesn't hold a
    // promise per workflow the session ever touched.
    if (_recordQueues.get(workflowId) === tail) _recordQueues.delete(workflowId);
  });
  return run;
}

/**
 * Did this write lose a race to create the history document? The unique index
 * on workflowId is what reports it. Electron drops custom error properties when
 * it serializes a rejection back over IPC, so the message is checked too.
 */
const isUniqueViolation = (err) => (
  err?.errorType === 'uniqueViolated' || /unique constraint/i.test(err?.message || '')
);

export const workflowHistoryDb = {
  /**
   * The whole history document for a workflow, or null if it has none yet.
   * @param {string} workflowId
   * @returns {Promise<object|null>}
   */
  async getByWorkflowId(workflowId) {
    if (!workflowId) return null;
    return dbFindOne(HISTORY_COLLECTION, { workflowId });
  },

  /**
   * A workflow's versions, newest first — the order the history list renders.
   * @param {string} workflowId
   * @returns {Promise<object[]>}
   */
  async getVersions(workflowId) {
    const doc = await this.getByWorkflowId(workflowId);
    if (!doc || !Array.isArray(doc.versions)) return [];
    return [...doc.versions].reverse();
  },

  /**
   * Append a version.
   *
   * Returns the entry that was written, or null when the workflow is identical
   * to the last recorded version (a save that changed nothing must not add a
   * row to the history).
   *
   * @param {string} workflowId
   * @param {object} workflow - The workflow payload being saved
   * @param {{ source?: string, label?: string, maxVersions?: number }} options
   *   source: 'save' | 'revert' | 'ai-build' | 'import' — what caused the version
   *   label:  optional human note shown in the list
   * @returns {Promise<object|null>}
   */
  async record(workflowId, workflow, options = {}) {
    if (!workflowId || !workflow) return null;
    return queuePerWorkflow(workflowId, () => this._writeVersion(workflowId, workflow, options));
  },

  /**
   * The body of `record`. Never call this directly — it assumes it is the only
   * writer for this workflow, which is what queuePerWorkflow guarantees.
   * @private
   */
  async _writeVersion(workflowId, workflow, { source = 'save', label = null, maxVersions = MAX_VERSIONS } = {}, isRetry = false) {
    const doc = await this.getByWorkflowId(workflowId);
    const existing = Array.isArray(doc?.versions) ? doc.versions : [];
    const previous = existing.length ? existing[existing.length - 1].snapshot : null;

    if (isUnchanged(previous, workflow)) return null;

    const snapshot = snapshotOf(workflow);
    const diff = diffSnapshots(previous, snapshot);
    const now = new Date().toISOString();
    const version = (doc?.versionCounter || 0) + 1;

    const entry = {
      versionId: uuid(),
      version,
      timestamp: now,
      source,
      label: label || null,
      // Precomputed so the list renders without walking every snapshot; the
      // detail pane recomputes the full diff from the snapshots themselves.
      summary: previous ? describeDiff(diff) : 'Initial version',
      counts: diff.counts,
      nodeCount: snapshot.nodes.length,
      snapshot,
    };

    // Oldest first out the front, so the newest `maxVersions` are what remain.
    const versions = [...existing, entry].slice(-Math.max(1, maxVersions));

    if (doc) {
      await dbUpdate(HISTORY_COLLECTION, { workflowId }, {
        $set: {
          versions,
          versionCounter: version,
          workflowName: snapshot.name,
          updatedAt: now,
        },
      });
      return entry;
    }

    try {
      await dbInsert(HISTORY_COLLECTION, {
        workflowId,
        workflowName: snapshot.name,
        versionCounter: version,
        createdAt: now,
        updatedAt: now,
        versions,
      });
    } catch (err) {
      // Someone created the document between the read above and this insert —
      // a second window, or the main process. The queue rules that out within
      // one renderer, so this is the last line of defence: re-read and append
      // to what is actually there. Once only, so a genuinely broken index can
      // never spin.
      if (isRetry || !isUniqueViolation(err)) throw err;
      return this._writeVersion(workflowId, workflow, { source, label, maxVersions }, true);
    }

    return entry;
  },

  /**
   * One version by its versionId — what a revert reads.
   * @param {string} workflowId
   * @param {string} versionId
   * @returns {Promise<object|null>}
   */
  async getVersion(workflowId, versionId) {
    const doc = await this.getByWorkflowId(workflowId);
    if (!doc) return null;
    return (doc.versions || []).find((v) => v.versionId === versionId) || null;
  },

  /**
   * Drop a workflow's history. Called when the workflow itself is deleted —
   * the main process does this too (see db:remove), so this is for the browser
   * fallback and for an explicit "clear history".
   * @param {string} workflowId
   * @returns {Promise<number>}
   */
  async deleteByWorkflowId(workflowId) {
    if (!workflowId) return 0;
    return dbRemove(HISTORY_COLLECTION, { workflowId });
  },
};
