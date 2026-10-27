import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import hydrateLocalStorage from './utils/persistentLocalStorage';

// ── ResizeObserver: deliver notifications on the next frame ────────────────
// "ResizeObserver loop completed with undelivered notifications" is what the
// browser reports when an observer callback changes the layout of something
// that same observer watches, leaving entries it cannot deliver in that frame.
// Monaco's automaticLayout does exactly this — hence the burst of them when the
// transformer/join code, a data preview, or the query editor appears.
//
// The notice is harmless (layout settles on the next frame), but it arrives as
// a window "error" event, which the dev server's overlay renders as a fatal
// runtime error. Deferring each callback by one animation frame breaks the
// same-frame loop, so the notifications are delivered normally. This fixes the
// condition rather than swallowing the report: a genuine, non-terminating
// resize loop would still surface.
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'function') {
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => callback(entries, observer));
      });
    }
  };
}

const root = ReactDOM.createRoot(document.getElementById('root'));

// A packaged window runs from file://, whose localStorage Chromium discards
// when the window closes. Restore the mirrored copy BEFORE mounting: the
// signed-in session and the saved AI model are read during the first render,
// and a component that reads them too early decides the user is logged out.
hydrateLocalStorage().finally(() => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
