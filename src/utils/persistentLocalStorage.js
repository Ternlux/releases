/**
 * Makes localStorage survive a restart in the packaged app.
 *
 * A packaged window is loaded with loadFile(), so the renderer's origin is
 * file://, and Chromium treats that as opaque for storage — everything written
 * to localStorage lives exactly as long as the window. In dev the renderer is
 * served from http://localhost:3000, a real origin that persists normally,
 * which is why this only ever bites once packaged. Terms acceptance was moved
 * to a file in userData for this same reason; the signed-in session and the
 * chosen AI model were not, and came back to defaults on every launch.
 *
 * Around twenty modules read localStorage synchronously — axios interceptors
 * and render paths among them — so converting them to async IPC would be a
 * wide, risky change for a storage bug. Instead the store is mirrored to a file
 * in userData: loaded back before React mounts, and rewritten after each
 * change. Every existing `localStorage.getItem(...)` keeps working as-is.
 *
 * The patch lives on Storage.prototype rather than the localStorage instance
 * deliberately: assigning a property to a Storage object stores an ITEM under
 * that name, so defining `setItem` on the instance would write a storage entry
 * called "setItem" instead of overriding the method. The `this` check keeps
 * sessionStorage — which genuinely should not outlive the window — untouched.
 */

// Long enough to collapse a burst of writes into one file rewrite, short
// enough that quitting right after a change still catches it.
const FLUSH_DELAY_MS = 300;

let flushTimer = null;
let installed = false;

/** Every current localStorage entry, as the plain object the main process stores. */
function snapshot() {
  const entries = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key !== null) entries[key] = localStorage.getItem(key);
  }
  return entries;
}

async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await window.electronAPI?.store?.save?.(snapshot());
  } catch (err) {
    console.warn('[persistentLocalStorage] could not persist:', err);
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
}

/** Mirror every write, without disturbing sessionStorage. */
function installWriteMirror() {
  if (installed) return;
  installed = true;

  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const nativeClear = Storage.prototype.clear;

  Storage.prototype.setItem = function setItem(key, value) {
    nativeSetItem.call(this, key, value);
    if (this === window.localStorage) scheduleFlush();
  };

  Storage.prototype.removeItem = function removeItem(key) {
    nativeRemoveItem.call(this, key);
    if (this === window.localStorage) scheduleFlush();
  };

  Storage.prototype.clear = function clear() {
    nativeClear.call(this);
    if (this === window.localStorage) scheduleFlush();
  };

  // Best-effort catch for a change made within the final FLUSH_DELAY_MS. The
  // IPC is async and the window may go before it lands, which is the reason
  // the debounce is short rather than the reason to drop it.
  window.addEventListener('pagehide', () => { flushNow(); });
}

/**
 * Restore the saved store, then keep it in sync. Must finish before anything
 * reads localStorage — call it before mounting React.
 *
 * A no-op outside Electron, where localStorage persists on its own.
 */
export default async function hydrateLocalStorage() {
  if (!window.electronAPI?.store?.load) return;

  try {
    const saved = await window.electronAPI.store.load();
    if (saved && typeof saved === 'object') {
      for (const [key, value] of Object.entries(saved)) {
        // A value already present came from this session and is newer, so it
        // wins. Written through the native method so restoring does not queue
        // a flush per key.
        if (typeof value === 'string' && localStorage.getItem(key) === null) {
          Storage.prototype.setItem.call(localStorage, key, value);
        }
      }
    }
  } catch (err) {
    console.warn('[persistentLocalStorage] could not restore saved store:', err);
  }

  installWriteMirror();

  // Captures anything localStorage already held that the file does not —
  // the first run after upgrading, where state exists but was never mirrored.
  scheduleFlush();
}
