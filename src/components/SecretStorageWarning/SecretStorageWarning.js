import React, { useState, useEffect } from 'react';

/**
 * Shown wherever a secret is about to be typed in, when this machine has no
 * way to protect it.
 *
 * On Linux, Electron encrypts saved keys through the desktop's keyring
 * (libsecret on GNOME, KWallet on KDE). A server, a minimal window manager, or
 * any session Chromium cannot identify the desktop of has none, and the app
 * falls back to a key that is not the user's — which stops `grep`, and nothing
 * beyond it. The keys still save and the app still works; what changes is that
 * anyone able to read the file can recover them.
 *
 * That is a fine default for a scratch VM and a bad surprise for someone about
 * to paste a production key, so the difference is stated rather than hidden.
 * Renders nothing at all when the keyring is working, which is every Mac,
 * every Windows box, and any ordinary Linux desktop.
 *
 * Deliberately built from plain elements and inline styles: it appears both in
 * ApiKeySetup (MUI) and ConnectionsTab (antd), and belonging to neither keeps
 * it from dragging one library's theme into the other's tree.
 */

const AMBER = '#d97706';
const AMBER_BG = 'rgba(217,119,6,0.08)';
const AMBER_BORDER = 'rgba(217,119,6,0.25)';
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const styles = {
  wrap: {
    background: AMBER_BG,
    border: `1px solid ${AMBER_BORDER}`,
    borderRadius: 6,
    padding: '12px 14px',
    marginBottom: 16,
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: AMBER,
    fontWeight: 600,
    fontSize: 13,
    lineHeight: 1.4,
  },
  body: {
    margin: '6px 0 0 24px',
    fontSize: 12.5,
    lineHeight: 1.55,
    color: '#5a6678',
  },
  toggle: {
    display: 'block',
    margin: '8px 0 0 24px',
    padding: 0,
    background: 'none',
    border: 'none',
    color: AMBER,
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  steps: {
    margin: '10px 0 0 24px',
    paddingLeft: 16,
    fontSize: 12.5,
    lineHeight: 1.6,
    color: '#5a6678',
  },
  code: {
    display: 'block',
    margin: '6px 0',
    padding: '7px 10px',
    background: '#fff',
    border: '1px solid #e2e6eb',
    borderRadius: 4,
    fontFamily: MONO,
    fontSize: 11.5,
    color: '#111827',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
};

export default function SecretStorageWarning({ style }) {
  const [status, setStatus] = useState(null);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI?.getSecretStorageStatus?.();
        if (!cancelled) setStatus(result || null);
      } catch (err) {
        // A browser build, or an older main process without the handler.
        // Staying silent is right: we cannot show a storage warning we are
        // not sure applies.
        console.warn('[SecretStorageWarning] could not read storage status:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!status?.weak) return null;

  return (
    <div style={{ ...styles.wrap, ...style }}>
      <div style={styles.heading}>
        <span aria-hidden="true">⚠</span>
        <span>This computer can&apos;t encrypt saved credentials</span>
      </div>

      <p style={styles.body}>
        No desktop keyring was found, so anything you save here is written to disk
        without real protection — anyone who can read the file can recover it.
        It will still save and the app will work normally. Fine for a test
        machine; think twice before entering a production key.
      </p>

      <button
        type="button"
        style={styles.toggle}
        onClick={() => setShowSteps((shown) => !shown)}
      >
        {showSteps ? 'Hide setup steps' : 'How do I turn on encryption?'}
      </button>

      {showSteps && (
        <ol style={styles.steps}>
          <li>
            Install a keyring, if you don&apos;t have one:
            <code style={styles.code}>sudo apt install gnome-keyring</code>
          </li>
          <li>Quit Ternlux completely.</li>
          <li>
            Start it again, telling it to use the keyring:
            <code style={styles.code}>ternlux --password-store=gnome-libsecret</code>
            Running the AppImage instead? Use its filename in place of
            <code style={styles.code}>./Ternlux-1.0.0.AppImage --password-store=gnome-libsecret</code>
          </li>
          <li>
            Still seeing this message? Your session has no keyring running.
            Start one and launch inside it:
            <code style={styles.code}>dbus-run-session -- ternlux --password-store=gnome-libsecret</code>
          </li>
          <li>
            Any keys you already saved were stored unprotected. Once encryption
            is on, re-enter them so they get written properly.
          </li>
        </ol>
      )}
    </div>
  );
}
