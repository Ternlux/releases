/**
 * Persistent query memory for the Data Explorer.
 *
 * Two file-backed NeDB stores in userData, separate from the app's other
 * collections so a worksheet's text is never mixed in with workflow data:
 *
 *   ternlux-explorer-worksheets.db  the notepad — one doc per open worksheet
 *   ternlux-explorer-history.db     every statement that was actually run
 *
 * Both are keyed by connectionId, so reopening a connection restores exactly
 * the sheets and history that belong to it.
 */

const path = require('path');
const Datastore = require('@seald-io/nedb');

// How many history rows we keep per connection. Trimmed on write so the file
// can't grow without bound in a long-lived session.
const HISTORY_LIMIT = 500;

// Worksheet text is the one field with no natural size bound. Cap it so a
// paste of a giant dump can't bloat the store.
const MAX_SQL_CHARS = 200000;

let _worksheets = null;
let _history = null;

// Two statements can easily be run inside the same millisecond, which makes a
// sort on `ranAt` alone non-deterministic. Every entry also carries a strictly
// increasing `seq`, and that is what history is ordered by.
let _seqCounter = 0;
function nextSeq() {
  _seqCounter = (_seqCounter + 1) % 1000;
  return Date.now() * 1000 + _seqCounter;
}

/**
 * Datastores are opened on first use rather than at registration, so the
 * userData path is resolved once Electron can actually answer for it.
 */
function stores(getUserDataDir) {
  const dir = getUserDataDir();
  if (!_worksheets) {
    _worksheets = new Datastore({
      filename: path.join(dir, 'ternlux-explorer-worksheets.db'),
      autoload: true,
    });
  }
  if (!_history) {
    _history = new Datastore({
      filename: path.join(dir, 'ternlux-explorer-history.db'),
      autoload: true,
    });
  }
  return { worksheets: _worksheets, history: _history };
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const clip = (v, max) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

/**
 * Register the query-memory IPC channels.
 * @param {object} ipcMain
 * @param {function(): string} getUserDataDir - resolves app.getPath('userData')
 */
function registerQueryStore(ipcMain, getUserDataDir) {
  const db = () => stores(getUserDataDir);

  // ── worksheets ───────────────────────────────────────────────────────────

  /** List a connection's worksheets, most recently updated first. */
  ipcMain.handle('explorer:worksheets:list', async (_e, { connectionId }) => {
    try {
      const docs = await db().worksheets.findAsync({ connectionId }).sort({ updatedAt: 1 });
      return { success: true, worksheets: docs };
    } catch (err) {
      return { success: false, message: err.message, worksheets: [] };
    }
  });

  /**
   * Create or update one worksheet. The renderer owns the id, so this is an
   * upsert — it's called on a debounce as the user types.
   */
  ipcMain.handle('explorer:worksheets:save', async (_e, { worksheet }) => {
    try {
      if (!worksheet || !worksheet.connectionId) {
        return { success: false, message: 'connectionId is required' };
      }
      const now = new Date().toISOString();
      const id = worksheet.id || uuid();
      const doc = {
        ...worksheet,
        id,
        sql: clip(worksheet.sql || '', MAX_SQL_CHARS),
        createdAt: worksheet.createdAt || now,
        updatedAt: now,
      };
      delete doc._id; // NeDB assigns its own; carrying a stale one breaks upsert
      await db().worksheets.updateAsync({ id }, doc, { upsert: true });
      return { success: true, worksheet: doc };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('explorer:worksheets:delete', async (_e, { id }) => {
    try {
      const removed = await db().worksheets.removeAsync({ id }, {});
      return { success: true, removed };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // ── history ──────────────────────────────────────────────────────────────

  /** Most recent runs first. */
  ipcMain.handle('explorer:history:list', async (_e, { connectionId, limit = 100 }) => {
    try {
      const rows = await db().history
        .findAsync({ connectionId })
        .sort({ seq: -1 })
        .limit(limit);
      return { success: true, history: rows };
    } catch (err) {
      return { success: false, message: err.message, history: [] };
    }
  });

  /**
   * Record one run. Called after every execution, successful or not — a failed
   * statement plus its error is the most useful thing in the list.
   */
  ipcMain.handle('explorer:history:add', async (_e, { entry }) => {
    try {
      if (!entry || !entry.connectionId) {
        return { success: false, message: 'connectionId is required' };
      }
      const doc = {
        ...entry,
        id: entry.id || uuid(),
        sql: clip(entry.sql || '', MAX_SQL_CHARS),
        ranAt: entry.ranAt || new Date().toISOString(),
        seq: nextSeq(),
      };
      delete doc._id;
      await db().history.insertAsync(doc);

      // Trim the tail past the cap for this connection.
      const all = await db().history
        .findAsync({ connectionId: entry.connectionId })
        .sort({ seq: -1 });
      if (all.length > HISTORY_LIMIT) {
        const stale = all.slice(HISTORY_LIMIT).map((d) => d.id);
        await db().history.removeAsync({ id: { $in: stale } }, { multi: true });
      }

      return { success: true, entry: doc };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('explorer:history:clear', async (_e, { connectionId }) => {
    try {
      const removed = await db().history.removeAsync({ connectionId }, { multi: true });
      return { success: true, removed };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
}

module.exports = { registerQueryStore, HISTORY_LIMIT };
