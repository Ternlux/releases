import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Modal, message, Spin } from 'antd';
import WorkflowEditor from './WorkflowEditor';
// No axios import: every remote workflow endpoint returns 403 for logged-in
// tokens, so this tab reads and writes the local store and runs workflows over
// IPC. The commented-out calls below are kept as a record of what the server
// path was; re-enabling one means restoring the import with it.
import moment from 'moment';
import { workflowsDb, connectionsDb, workflowHistoryDb } from '../../utils/localDb';
import { resolveExecutionSteps } from '../../utils/workflowUtils';
import { refreshExecutions } from '../../utils/executionMonitorStore';
import {
  C, MONO, Btn, Tag, MetaItem, MoreMenu, PageHeader, fullscreenModalProps,
} from './_designShared';
import { collectDroppableFiles, fileDragHandlers, FileDropOverlay } from './connections/localFileDrop';
import { reassignImportedNodeIds } from '../../utils/workflowImportIds';

const TYPE_COLORS = {
  transformation: { color: C.accent,  bg: C.aD,                       border: 'rgba(37,99,235,0.18)' },
  aggregation:    { color: C.violet,  bg: C.vD,                       border: 'rgba(124,58,237,0.18)' },
  reconciliation: { color: C.amber,   bg: C.amD,                      border: 'rgba(217,119,6,0.18)' },
  'ml-prep':      { color: C.cyan,    bg: C.cD,                       border: 'rgba(8,145,178,0.18)' },
  etl:            { color: C.green,   bg: C.gD,                       border: 'rgba(5,150,105,0.18)' },
  cleaning:       { color: '#db2777', bg: 'rgba(219,39,119,0.06)',    border: 'rgba(219,39,119,0.18)' },
};

const WorkflowCard = ({ wf, onEdit, onRun, onDelete }) => {
  const [hov, setHov] = useState(false);
  const tc = TYPE_COLORS[wf.type] || TYPE_COLORS.etl;
  return (
    <div
      onMouseOver={() => setHov(true)} onMouseOut={() => setHov(false)}
      onClick={() => onEdit(wf)}
      style={{
        background: '#fff', border: `1px solid ${hov ? C.border2 : C.border}`,
        borderRadius: 6, overflow: 'hidden', cursor: 'pointer', transition: 'all 0.15s',
        boxShadow: hov ? '0 4px 16px rgba(0,0,0,0.07)' : '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex', flexDirection: 'column',
      }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', borderBottom: `1px solid ${C.border}`, gap: 8,
      }}>
        <span title={wf.name} style={{
          fontSize: 13, fontWeight: 600, color: C.text, letterSpacing: '-0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {wf.name || 'Untitled workflow'}
        </span>
        <MoreMenu items={[
          { label: 'Run Workflow', icon: 'play', onClick: () => onRun(wf.id) },
          { label: 'Edit',         icon: 'edit', onClick: () => onEdit(wf) },
          { label: 'Delete',       icon: 'trash', danger: true, onClick: () => onDelete(wf.id) },
        ]} />
      </div>
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          fontSize: 12, color: C.muted, lineHeight: 1.55,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          minHeight: 36,
        }}>
          {wf.description || <span style={{ color: C.dim, fontStyle: 'italic' }}>No description</span>}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
          {wf.nodeCount != null && <MetaItem icon="node">{wf.nodeCount} nodes</MetaItem>}
          {wf.createdBy && <MetaItem icon="user">{wf.createdBy}</MetaItem>}
          {wf.createdAt && <MetaItem icon="cal">{wf.createdAt.format('MMM DD')}</MetaItem>}
        </div>
        {/* <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 'auto', paddingTop: 4,
        }}>
          {wf.type ? <Tag {...tc}>{wf.type}</Tag> : <span />}
          <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>
            {wf.lastRun ? `ran ${wf.lastRun.fromNow()}` : 'never run'}
          </span>
        </div> */}
      </div>
    </div>
  );
};

const WorkflowsTab = ({
  onContextChange = () => {},
  pendingOpenWorkflow = null,           // { id, bump } — signal from ChatAssistant via Workflows.js
  onPendingOpenHandled = () => {},      // call after we've handled the signal so it doesn't re-fire
  onFilesDropped = () => {},            // hands a validated data-file drop to the Connections tab
  liveBuild = null,                     // in-flight builder progress, collected in Workflows.js
}) => {
  const [workflows, setWorkflows] = useState([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploadedDataSource, setUploadedDataSource] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const workflowCloseHandlerRef = useRef(null);
  const importInputRef = useRef(null);
  // Ids currently executing from this list. A run resolves only when the whole
  // workflow is done, so without this a second click starts a second run over
  // the same DuckDB tables. A ref, not state: nothing renders from it, and it
  // must be current inside the async handler.
  const runningIdsRef = useRef(new Set());

  const handleAuthError = (error) => {
    if (error.response?.status === 401 || error.response?.status === 204 ||
        (error.response?.status === 400)) {
      localStorage.removeItem('auth-token');
      message.error('Session expired. Please log in again.');
      window.location.href = '/login';
      return true;
    }
    return false;
  };

  useEffect(() => {
    fetchWorkflows();
  }, []);

  // Refresh the list from the local store and open one workflow in the editor.
  // Returns whether that workflow was found. `isCancelled` lets callers abandon
  // the open if their effect was torn down while the read was in flight.
  const refreshAndOpen = async (workflowId, isCancelled = () => false) => {
    const localWorkflows = await workflowsDb.getAll();
    if (isCancelled()) return false;
    const enriched = localWorkflows.map((wf) => ({
      ...wf,
      createdAt: moment(wf.createdAt),
      lastRun: wf.lastExecuted ? moment(wf.lastExecuted) : null,
      updatedAt: moment(wf.updatedAt),
    }));
    setWorkflows(enriched);
    const target = enriched.find((w) => (w.id || w._id) === workflowId);
    if (!target) return false;
    handleEditWorkflow(target);
    return true;
  };

  // When ChatAssistant (via Workflows.js) signals a freshly-built workflow,
  // refresh the list and open that workflow in the editor. Keyed on `bump`
  // so re-building the same id still re-triggers.
  useEffect(() => {
    if (!pendingOpenWorkflow?.id) return;
    let cancelled = false;
    (async () => {
      try {
        await refreshAndOpen(pendingOpenWorkflow.id, () => cancelled);
      } finally {
        if (!cancelled) onPendingOpenHandled();
      }
    })();
    return () => { cancelled = true; };
    // handleEditWorkflow is stable enough for this use; we key purely on bump+id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenWorkflow?.id, pendingOpenWorkflow?.bump]);

  // ── Live build ───────────────────────────────────────────────────────────
  // A build has started: put its canvas on screen so the user watches the
  // pipeline being written instead of a spinner in the chat. A brand-new
  // workflow isn't in the database yet, so the editor opens on a placeholder
  // carrying only `liveBuildId` — that is what it matches the progress stream
  // against, and the empty nodes/edges keep it off the "create a start node"
  // path. A modify build opens the saved workflow so its existing nodes are
  // there to be glowed and rewired.
  //
  // The build TAKES OVER the editor, even when it is open on another workflow.
  // The user asked for this build; watching it write itself is the point, and
  // leaving the old canvas up meant a workflow was being created behind a
  // screen showing something unrelated. Nothing is lost by the swap: every path
  // into a build goes through the save gate first (requestWorkflowSaveGate in
  // ChatAssistant), so an open workflow with unsaved edits has already been
  // saved — or the build was cancelled and never reached here. An editor
  // already showing THIS build's canvas is left alone.
  const liveBuildId = liveBuild?.workflowId || null;
  const liveBuildPhase = liveBuild?.phase || null;
  // Whether the open editor (if any) is the one this build belongs to. This is
  // now the ONLY thing the takeover checks — a previous build's placeholder and
  // a workflow the user opened are both simply "not this build", and both get
  // re-pointed. (There used to be a separate `staleLiveCanvas` for the former,
  // back when the latter was left alone.)
  const editorOwnsBuild = isEditorOpen
    && (editingWorkflow?.id || editingWorkflow?._id || editingWorkflow?.liveBuildId) === liveBuildId;
  useEffect(() => {
    // The only case with nothing to do is the editor already being on this
    // build's canvas — `editorOwnsBuild` is what feeds it the progress stream.
    // Anything else (closed, another workflow, a previous build's placeholder)
    // gets re-pointed at this build.
    if (!liveBuildId || liveBuildPhase !== 'building') return undefined;
    if (editorOwnsBuild) return undefined;
    let cancelled = false;
    (async () => {
      if (liveBuild.mode === 'modify' && await refreshAndOpen(liveBuildId, () => cancelled)) return;
      if (cancelled) return;
      setEditingWorkflow({
        liveBuildId,
        name: liveBuild.workflowName || 'New Workflow',
        description: '',
        nodes: [],
        edges: [],
        executionSteps: [],
      });
      setIsEditorOpen(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBuildId, liveBuildPhase, editorOwnsBuild]);

  // The build finished — swap the preview for the real thing. This does NOT
  // wait for ChatAssistant's post-build review to hand the workflow over: the
  // review can take a while, and a failed one never hands it over at all,
  // which would leave the canvas showing placeholders for a workflow that is
  // already saved and openable.
  //
  // No "is the editor showing something else?" guard: the 'building' effect
  // above has already pointed it at this build, and if that never arrived (a
  // build too fast to render a progress frame, a reload mid-build) opening the
  // finished workflow is still the right end state.
  useEffect(() => {
    if (!liveBuildId || liveBuildPhase !== 'done') return undefined;
    let cancelled = false;
    refreshAndOpen(liveBuildId, () => cancelled).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBuildId, liveBuildPhase]);

  const fetchWorkflows = async () => {
    setLoading(true);
    try {
      // Remote workflow fetch disabled — backend returns 403 for logged-in
      // tokens, so we rely on the local IndexedDB store below instead.
      // const token = localStorage.getItem('auth-token');
      //
      // if (token) {
      //   const response = await axios.get('/workflow/workflows', {
      //     headers: { 'auth-token': token }
      //   });
      //
      //   if (response.data.success) {
      //     const workflowsData = response.data.data.workflows.map(workflow => ({
      //       ...workflow,
      //       createdAt: moment(workflow.createdAt),
      //       lastRun: workflow.lastExecuted ? moment(workflow.lastExecuted) : null,
      //       updatedAt: moment(workflow.updatedAt),
      //     }));
      //     setWorkflows(workflowsData);
      //   }
      // }
      const localWorkflows = await workflowsDb.getAll();
      setWorkflows(localWorkflows.map(workflow => ({
        ...workflow,
        createdAt: moment(workflow.createdAt),
        lastRun: workflow.lastExecuted ? moment(workflow.lastExecuted) : null,
        updatedAt: moment(workflow.updatedAt),
      })));
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error fetching workflows:', error);
      message.error('Failed to load workflows');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWorkflow = () => {
    setEditingWorkflow(null);
    setIsEditorOpen(true);
  };

  const fetchAllConnections = async () => {
    // Remote connections fetch disabled — backend returns 403 for logged-in
    // tokens, so we use the local IndexedDB store only.
    // const token = localStorage.getItem('auth-token');
    // if (token) {
    //   try {
    //     const response = await axios.post('/workflow/connections', { transformer: false }, {
    //       headers: { 'auth-token': token },
    //     });
    //     if (response.data.success) return response.data.data;
    //   } catch (e) { /* fall through to local */ }
    // }
    return connectionsDb.getAll();
  };

  const resolveDataSourceNodes = (nodes, connections) => {
    return nodes.map(node => {
      if (node.type !== 'dataSource') return node;
      const config = node.data?.config;
      if (!config) return node;

      if (config.sourceConnectionId) {
        const byId = connections.find(c => (c.id || c._id) === config.sourceConnectionId);
        if (byId) return node;
      }

      if (config.sourceConnectionName && config.sourceConnectionType) {
        const byNameType = connections.find(
          c => c.connectionName === config.sourceConnectionName &&
               c.connectionType === config.sourceConnectionType,
        );
        if (byNameType) {
          return {
            ...node,
            data: { ...node.data, config: { ...config, sourceConnectionId: byNameType.id || byNameType._id } },
          };
        }
      }

      if (config.sourceLocalPath) {
        const byPath = connections.find(c => c.fileInfo?.filePath === config.sourceLocalPath);
        if (byPath) {
          return {
            ...node,
            data: {
              ...node.data,
              config: {
                ...config,
                sourceConnectionId: byPath.id || byPath._id,
                sourceConnectionName: byPath.connectionName,
                sourceConnectionType: byPath.connectionType,
              },
            },
          };
        }
      }
      node.unsupported = true;
      return node;
    });
  };

  const handleImportClick = () => importInputRef.current?.click();

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      message.error('Invalid JSON file');
      return;
    }

    if (!parsed.nodes || !parsed.edges) {
      message.error('File does not appear to be a valid workflow export');
      return;
    }

    let connections = [];
    try { connections = await fetchAllConnections(); } catch { /* proceed without */ }

    const resolvedNodes = resolveDataSourceNodes(parsed.nodes, connections);
    const unresolvedCount = resolvedNodes.filter(n => n.unsupported).length;
    if (unresolvedCount > 0) {
      message.warning(
        `${unresolvedCount} Data Source node${unresolvedCount > 1 ? 's' : ''} could not be matched to an existing connection. You can update them in the editor.`,
      );
    }

    // Fresh node ids, so the import is a workflow of its own — see
    // utils/workflowImportIds for why shared ids collided at run time.
    const fresh = reassignImportedNodeIds({
      nodes: resolvedNodes,
      edges: parsed.edges,
      executionSteps: parsed.executionSteps || [],
    });

    setEditingWorkflow({
      name: parsed.name || '',
      description: parsed.description || '',
      nodes: fresh.nodes,
      edges: fresh.edges,
      executionSteps: fresh.executionSteps,
    });
    setIsEditorOpen(true);
  };

  const handleEditWorkflow = (workflow) => {
    setEditingWorkflow(workflow);
    setIsEditorOpen(true);
    onContextChange({
      kind: 'workflow',
      id: workflow.id || workflow._id,
      name: workflow.name,
      summary: workflow.description || `${workflow.nodes?.length || 0} nodes · ${workflow.type || 'workflow'}`,
    });
  };

  const handleDeleteWorkflow = async (workflowId) => {
    Modal.confirm({
      title: 'Delete Workflow',
      content: 'Are you sure you want to delete this workflow? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      async onOk() {
        try {
          // Remote delete disabled — backend returns 403 for logged-in tokens,
          // so we always delete from the local IndexedDB store.
          // const token = localStorage.getItem('auth-token');
          // if (token) {
          //   const response = await axios.post('/workflow/workflow-action', {
          //     action: 'delete', workflowId,
          //   }, { headers: { 'auth-token': token } });
          //   if (response.data.success) {
          //     setWorkflows(prev => prev.filter(w => w.id !== workflowId));
          //     message.success('Workflow deleted successfully');
          //   }
          // } else {
          await workflowsDb.delete(workflowId);
          // The version history goes with the workflow — there is nothing left
          // to revert into, and leaving it behind would hand its versions to
          // the next workflow that happened to reuse the id. The main process
          // does this too when it sees a workflows removal (see db:remove in
          // electron.js); doing it here as well covers the browser fallback,
          // and removing an already-removed document is a no-op.
          await workflowHistoryDb.deleteByWorkflowId(workflowId);
          setWorkflows(prev => prev.filter(w => w.id !== workflowId));
          message.success('Workflow deleted locally');
          // }
        } catch (error) {
          if (handleAuthError(error)) return;
          console.error('Error deleting workflow:', error);
          message.error('Failed to delete workflow');
        }
      },
    });
  };

  // Run a saved workflow from the list, without opening the editor.
  //
  // This runs through the SAME path the editor's Execute button uses
  // (doExecuteWorkflow → workflow:execute over IPC), because that is the only
  // path that exists: the remote POST /executions this used to call is part of
  // the same backend whose workflow endpoints all return 403 for logged-in
  // tokens — see fetchWorkflows / saveWorkflowData / handleDeleteWorkflow, which
  // moved to the local store for exactly that reason. It was the last caller
  // still pointed at the server.
  //
  // The editor runs the LIVE canvas; here there is no canvas, so the saved
  // record is the input. handleSave writes nodes/edges/executionSteps into it,
  // so a saved workflow carries everything workflow:execute needs.
  const handleRunWorkflow = async (workflowId) => {
    if (runningIdsRef.current.has(workflowId)) {
      message.warning('That workflow is already running.');
      return;
    }
    if (!window.electronAPI?.workflow?.executeWorkflow) {
      message.error('Workflow execution not available');
      return;
    }

    let hideRunning = null;
    try {
      const wf = await workflowsDb.getById(workflowId);
      if (!wf) {
        message.error('Workflow not found');
        return;
      }

      const nodes = wf.nodes || [];
      const edges = wf.edges || [];
      if (nodes.length === 0) {
        message.warning('No nodes to execute');
        return;
      }
      // Same rule the editor and the steps editor use: saved order is honoured
      // while it still covers every node, otherwise it is rebuilt from the graph.
      const executionSteps = resolveExecutionSteps(wf.executionSteps, nodes, edges);

      runningIdsRef.current.add(workflowId);
      // executeWorkflow resolves only when the whole run is over, so the run is
      // reported live by the execution monitor. Kick the poller now rather than
      // waiting for its next tick.
      setTimeout(refreshExecutions, 150);
      hideRunning = message.loading(`Running "${wf.name || 'workflow'}"…`, 0);

      const result = await window.electronAPI.workflow.executeWorkflow({
        workflowId: wf.id,
        workflowName: wf.name || 'Untitled Workflow',
        // No sanitization pass here: these came back out of the local store, so
        // they have already survived a structured clone. The editor needs
        // toCloneable because its nodes are live canvas state carrying Arrow
        // vectors and circular refs.
        nodes,
        edges,
        executionSteps,
      });

      if (result?.success) {
        message.success(`Workflow executed successfully! Execution ID: ${result.executionId}`);
      } else if (result?.cancelled) {
        // Stopped from the execution monitor — not a failure, so it does not
        // get the red toast.
        message.warning(result.message || 'Workflow run stopped.');
      } else {
        message.error(`Workflow execution failed: ${result?.message || 'Unknown error'}`);
      }
      // Either way, re-read the store: markNodeExecuted writes each finished
      // node into the workflow's `executedNodes` map, and opening the editor
      // from a stale list would show a workflow that has never run.
      fetchWorkflows();
      refreshExecutions();
    } catch (error) {
      console.error('Error running workflow:', error);
      message.error(`Execution error: ${error.message}`);
    } finally {
      if (hideRunning) hideRunning();
      runningIdsRef.current.delete(workflowId);
    }
  };

  const saveWorkflowData = async (workflowData, workflowId) => {
    // `__history*` are instructions for the version history, not workflow
    // fields — peel them off so they never reach the stored document.
    const { __historySource: historySource, __historyLabel: historyLabel, ...persisted } = workflowData;
    workflowData = persisted;

    const nameConflict = workflows.some(w => {
      if (workflowId && w.id === workflowId) return false;
      return w.name?.trim().toLowerCase() === workflowData.name?.trim().toLowerCase();
    });
    if (nameConflict) {
      message.error(`A workflow named "${workflowData.name}" already exists. Please choose a unique name.`);
      throw new Error('Duplicate workflow name');
    }

    // Remote save/update disabled — backend returns 403 for logged-in tokens,
    // so we always persist to the local IndexedDB store.
    // const token = localStorage.getItem('auth-token');
    // if (token) {
    //   if (workflowId) {
    //     const response = await axios.post('/workflow/workflow-action', {
    //       action: 'update', workflowId, ...workflowData,
    //     }, { headers: { 'auth-token': token } });
    //     if (!response.data.success) throw new Error(response.data.error || 'Failed to update workflow');
    //     return workflowId;
    //   } else {
    //     const newWorkflowData = {
    //       ...workflowData,
    //       ...(uploadedDataSource && { connectionId: uploadedDataSource.connectionId }),
    //     };
    //     const response = await axios.post('/workflow/workflow-save', newWorkflowData, {
    //       headers: { 'auth-token': token },
    //     });
    //     if (!response.data.success) throw new Error(response.data.error || 'Failed to create workflow');
    //     return response.data.data?.id || null;
    //   }
    // } else {
    console.log("workflowId, workflowData: ", workflowId, workflowData)
    let savedId;
    if (workflowId) {
      await workflowsDb.update(workflowId, workflowData);
      savedId = workflowId;
    } else {
      const newWorkflow = {
        ...workflowData,
        ...(uploadedDataSource && { connectionId: uploadedDataSource.connectionId }),
      };
      const saved = await workflowsDb.save(newWorkflow);
      savedId = saved.id;
    }

    // Every write to a workflow passes through here, so this is the one place
    // the history has to be recorded from. It is deliberately best-effort: a
    // failure to record a version must not fail the save that produced it.
    // `record` is a no-op when nothing actually changed.
    try {
      await workflowHistoryDb.record(savedId, workflowData, {
        source: historySource || 'save',
        label: historyLabel || null,
      });
    } catch (err) {
      console.warn('[workflowHistory] could not record version:', err);
    }

    return savedId;
    // }
  };

  const handleSaveWorkflow = async (workflowData) => {
    try {
      const workflowId = editingWorkflow?.id || null;
      console.log('workflowId: ', workflowId, workflowData)
      await saveWorkflowData(workflowData, workflowId);
      message.success(workflowId ? 'Workflow updated successfully' : 'Workflow created successfully');
      await fetchWorkflows();
      setIsEditorOpen(false);
      setEditingWorkflow(null);
      setUploadedDataSource(null);
      onContextChange(null);
    } catch (error) {
      if (error.message === 'Duplicate workflow name') throw error;
      if (handleAuthError(error)) return;
      console.error('Error saving workflow:', error);
      message.error('Failed to save workflow');
      throw error;
    }
  };

  const handleAutoSave = async (workflowData, workflowId) => {
    try {
      const savedId = await saveWorkflowData(workflowData, workflowId);
      await fetchWorkflows();
      return savedId;
    } catch (error) {
      if (handleAuthError(error)) return null;
      throw error;
    }
  };

  const handleModalClose = () => {
    if (workflowCloseHandlerRef.current) {
      workflowCloseHandlerRef.current();
    } else {
      handleWorkflowClose();
    }
  };

  const handleWorkflowClose = () => {
    setIsEditorOpen(false);
    setEditingWorkflow(null);
    setUploadedDataSource(null);
    workflowCloseHandlerRef.current = null;
    // Nothing is open any more — drop the chat assistant's focus chip.
    onContextChange(null);
  };

  const registerWorkflowCloseHandler = (handler) => {
    workflowCloseHandlerRef.current = handler;
  };

  // A data file dropped here isn't a workflow, so there is nothing to do with
  // it on this tab. Validate it with the same rules the Connections tab uses,
  // then hand the batch over and let the app switch there, where the import
  // popups open. The editor renders in a portal, so its own canvas drops never
  // reach this handler.
  // The editor renders inside this tab's modal and handles its own canvas
  // drops, so this target stands down entirely while it is open.
  const { onDragOver, onDragLeave } = useMemo(
    () => fileDragHandlers(setIsDragOver, isEditorOpen), [isEditorOpen]);

  const onDrop = (event) => {
    if (isEditorOpen) return;
    event.preventDefault();
    setIsDragOver(false);
    const validFiles = collectDroppableFiles(event);
    if (validFiles.length > 0) onFilesDropped(validFiles);
  };

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: C.surface, position: 'relative' }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && <FileDropOverlay title="Drop a file to create a data source" />}

      <PageHeader
        title="Workflows"
        sub="Create and manage your data processing workflows"
        actions={[
          <Btn key="imp" icon="import" onClick={handleImportClick}>Import</Btn>,
          <input key="imp-input" ref={importInputRef} type="file"
            accept=".json,application/json" style={{ display: 'none' }}
            onChange={handleImportFile} />,
          <Btn key="new" variant="primary" icon="plus" onClick={handleCreateWorkflow}>Create Workflow</Btn>,
        ]}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 50 }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: C.muted, fontSize: 12 }}>Loading workflows…</div>
          </div>
        ) : workflows.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '60px 24px', background: '#fff',
            border: `1px dashed ${C.border2}`, borderRadius: 6, color: C.muted,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              No workflows created yet
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>
              Create a connection and create your first workflow to start processing data
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {workflows.map(wf => (
              <WorkflowCard key={wf.id || wf._id}
                wf={wf}
                onEdit={handleEditWorkflow}
                onRun={handleRunWorkflow}
                onDelete={handleDeleteWorkflow}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={isEditorOpen}
        onCancel={handleModalClose}
        footer={null}
        {...fullscreenModalProps({ bodyPadding: 0 })}
        // The editor draws its own ✕ in its header, next to Execute / Save,
        // where it has room to breathe — antd's floating one would land on
        // top of those buttons.
        closable={false}
        destroyOnClose
        maskClosable={false}
      >
        <WorkflowEditor
          workflow={editingWorkflow}
          liveBuild={editorOwnsBuild ? liveBuild : null}
          dataSource={uploadedDataSource}
          onSave={handleSaveWorkflow}
          onAutoSave={handleAutoSave}
          onCancel={handleWorkflowClose}
          onCloseRequest={registerWorkflowCloseHandler}
          // The editor owns the chat's focus while it is open: it is the only
          // place that knows the workflow's live name and id, including for a
          // new workflow that has neither yet.
          onContextChange={onContextChange}
        />
      </Modal>
    </div>
  );
};

export default WorkflowsTab;
