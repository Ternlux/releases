import React, { useState, useEffect, useCallback } from 'react';
import Workflows from './components/Workflows/Workflows'
import ChatBot from './components/Chat/ChatBot';
import ChatAssistant from './components/Chat/ChatAssistant';
import ExecutionMonitor from './components/Workflows/ExecutionMonitor';
import ApiKeySetup from './components/ApiKeySetup/ApiKeySetup';
import TermsAndConditions, { TERMS_VERSION } from './components/TermsAndConditions/TermsAndConditions';
import Settings from './components/Settings/Settings';
import { hasAnyApiKey } from './utils/apiKeyStorage';
import './App.css';

function App() {
  const [activeView, setActiveView] = useState('workflow');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // null = still checking, false = not yet accepted/set, true = ready
  const [termsAccepted, setTermsAccepted] = useState(null);
  const [apiKeyReady, setApiKeyReady] = useState(null);

  // ── Assistant wiring ───────────────────────────────────────────────────
  // The assistant sits here rather than inside Workflows so that pinning it
  // right makes it a sibling column of the entire app: the view reflows to
  // the space left over instead of being covered by a floating panel.
  // What the user last clicked, reported up by the tabs: { kind, id, name, summary }.
  const [chatContext, setChatContext] = useState(null);
  // Accept-plan result handed back down to Workflows. The bump counter makes
  // the same workflow id re-open if it is built twice in a row.
  const [builtWorkflow, setBuiltWorkflow] = useState(null); // { id, bump }

  const handleWorkflowBuilt = useCallback(({ workflowId } = {}) => {
    if (!workflowId) return;
    setBuiltWorkflow((prev) => ({ id: workflowId, bump: (prev?.bump || 0) + 1 }));
  }, []);
  const handleChatContextChange = useCallback((ctx) => setChatContext(ctx || null), []);

  useEffect(() => {
    const init = async () => {
      let accepted = false;
      try {
        if (window.electronAPI?.terms?.get) {
          const record = await window.electronAPI.terms.get();
          accepted = !!record?.accepted && record?.version === TERMS_VERSION;
        } else {
          accepted = localStorage.getItem('ternlux_terms_accepted') === 'true'
            && localStorage.getItem('ternlux_terms_version') === TERMS_VERSION;
        }
      } catch (e) {
        console.warn('Could not read terms acceptance:', e);
        accepted = localStorage.getItem('ternlux_terms_accepted') === 'true';
      }
      setTermsAccepted(accepted);

      // Push the persisted analytics preference to the main process so it
      // can gate event sending. Default to off if it has never been set.
      try {
        const optIn = localStorage.getItem('ternlux_analytics_opt_in') === 'true';
        await window.electronAPI?.analytics?.setOptIn(optIn);
      } catch (e) {
        console.warn('Could not sync analytics preference:', e);
      }

      // An LLM API key is required to use the app; signing in is optional
      // and lives in Settings → Account.
      const hasLlmKey = await hasAnyApiKey();
      setApiKeyReady(hasLlmKey);
    };
    init();
  }, []);

  // While we check storage, render nothing (avoids flash of main UI)
  if (termsAccepted === null || apiKeyReady === null) return null;

  if (!termsAccepted) {
    return (
      <TermsAndConditions
        onComplete={() => setTermsAccepted(true)}
      />
    );
  }

  if (!apiKeyReady) {
    return (
      <ApiKeySetup
        onComplete={() => setApiKeyReady(true)}
      />
    );
  }

  return (
    // Row layout: the app view, then the assistant. Floating or closed, the
    // assistant is position:fixed and takes no space here; pinned, it becomes
    // a real 440px column and the view shrinks to fit beside it.
    <div className="app" style={{ flexDirection: 'row', height: '100vh', overflow: 'hidden' }}>
      <div className="app-view">
        <Workflows
          onChatContextChange={handleChatContextChange}
          builtWorkflow={builtWorkflow}
        />
      </div>
      <ChatAssistant
        activeContext={chatContext}
        onWorkflowBuilt={handleWorkflowBuilt}
      />
      {/* Live view of every workflow currently executing — top-left, over
          everything, and invisible when nothing is running. Mounted here
          rather than inside Workflows so a CRON or file-watcher run shows up
          whatever tab is open. */}
      <ExecutionMonitor />
    </div>
    // <div className="app">
    //   <nav className="app-nav">
    //     {/* <div className="app-nav-brand">Ternlux</div> */}
    //     <div className="app-nav-tabs">
    //       {/* <button
    //         className={`app-nav-tab${activeView === 'dashboard' ? ' active' : ''}`}
    //         onClick={() => setActiveView('dashboard')}
    //       >
    //         Dashboard
    //       </button> */}
    //       <button
    //         className={`app-nav-tab${activeView === 'workflow' ? ' active' : ''}`}
    //         onClick={() => setActiveView('workflow')}
    //       >
    //         Workflow
    //       </button>
    //     </div>
    //     <div className="app-nav-actions">
    //       <button
    //         className="app-nav-settings-btn"
    //         onClick={() => setIsSettingsOpen(true)}
    //         title="Settings"
    //       >
    //         ⚙️
    //       </button>
    //     </div>
    //   </nav>
    //   <main className="app-content">
    //     {activeView === 'dashboard' ? <ChatBot /> : <Workflows />}
    //   </main>

    //   {/* Settings Modal */}
    //   {isSettingsOpen && (
    //     <Settings onClose={() => setIsSettingsOpen(false)} />
    //   )}
    // </div>
  );
}

export default App;
