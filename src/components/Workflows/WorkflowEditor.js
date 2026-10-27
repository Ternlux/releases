import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { debounce } from 'lodash';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  useReactFlow,
  Panel,
} from 'reactflow';
import { Button, Space, Input, message, Typography, Modal, Spin, Dropdown, Menu } from 'antd';
import { SaveOutlined, UndoOutlined, SettingOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined, ExportOutlined, MoreOutlined, CloseOutlined, HistoryOutlined } from '@ant-design/icons';
import 'reactflow/dist/style.css';

import StartNode from './nodes/StartNode';
import DataSourceNode from './nodes/DataSourceNode';
import TransformerNode from './nodes/TransformerNode';
import JoinNode from './nodes/JoinNode';
import OutputNode from './nodes/OutputNode';
import NodeTypePanel from './NodeTypePanel';
import NodeChatPanel from './NodeChatPanel';
import LocalFileConnectionForm from './connections/LocalFileConnectionForm';
import {
  detectFileType, collectDroppableFiles, fileDragHandlers, FileDropOverlay,
  LOCAL_FILE_MODAL_TITLES,
} from './connections/localFileDrop';
import DataPreview from './DataPreview';
import WorkflowStepsEditor from './WorkflowStepsEditor';
import WorkflowHistory from './WorkflowHistory';
import {
  generateStepsFromNodes,
  resolveExecutionSteps,
  sanitizeExecutionSteps,
  sourceChangeRequestText,
  syncNodeSourcesToEdges,
  hasRequiredInputs,
  nodeRequirementMessage,
} from '../../utils/workflowUtils';
import { persistedNameFor, withPersistedNodeNames, withJoinInputHandles, nodeDisplayName, targetIsSourceWarning } from './nodes/nodeCardShared';
import { connectionsDb, workflowHistoryDb, CONNECTIONS_CHANGED_EVENT } from '../../utils/localDb';
import { relinkReaddedConnections } from '../../utils/connectionRefs';
import { stripNodeBookkeeping } from '../../utils/workflowHistory';
import {
  MATERIALIZING_NODE_TYPES, markPending, prunedExecutedNodes,
} from '../../utils/executedNodes';
import { useWorkflowExecution, refreshExecutions } from '../../utils/executionMonitorStore';
import axios from 'axios';

const { Title } = Typography;

const nodeTypes = {
  start: StartNode,
  dataSource: DataSourceNode,
  transformer: TransformerNode,
  join: JoinNode,
  output: OutputNode,
};

// Strip non-structured-cloneable values (class instances like Apache Arrow
// Vectors, functions, circular refs) before sending workflow data through
// Electron IPC. Throws with a clearer message than the IPC bridge does.
const toCloneable = (value, label = 'workflow') => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    throw new Error(`Cannot serialize ${label} for save: ${err.message}`);
  }
};

const initialNodes = [];
const initialEdges = [];


// Which extensions are droppable, and which import form each one opens, is
// owned by connections/localFileDrop so the canvas accepts exactly the files
// the Connections tab does — and hands each to the form that can actually read
// it. Nodes created from consecutive dropped files are fanned out from the drop
// point by this much so they don't land on top of each other.
const DROP_STACK_OFFSET = 48;

// Which CSS class a node carries while the AI builder is working on it. The
// glow is applied to ReactFlow's node wrapper (not the card itself) so every
// node type gets it without each one having to know about builds.
const buildClassFor = (step) => {
  if (!step) return '';
  switch (step.status) {
    case 'running': return 'wf-node-building';
    // The build stopped on this node — it is waiting on an answer from the
    // user, or it failed. A steady ring, not a pulse: nothing is happening.
    case 'paused':  return 'wf-node-paused';
    case 'failed':  return 'wf-node-failed';
    default:        return 'wf-node-built';
  }
};

// What the canvas banner says about the build in flight. A paused build is the
// one worth spelling out: the canvas is showing a half-written workflow and
// nothing is moving, and the reason is a question sitting in the chat.
const buildBannerText = (live, runningLabel) => {
  const total = live.totalSteps || live.nodes.length;
  const built = Math.min(live.nodes.length, total);
  switch (live.phase) {
    case 'done':
      return `Built ${live.nodes.length} node${live.nodes.length === 1 ? '' : 's'}`;
    case 'paused':
      return 'Paused — answer the assistant to continue building';
    case 'failed':
      return 'Build stopped — see the chat for what went wrong';
    default:
      return `Building${runningLabel ? ` ${runningLabel}` : ''} — ${built} of ${total}`;
  }
};

// Which CSS class each node carries for the workflow's execution state, keyed
// by node id. Two separate things are being shown (see Workflows.css):
//
//  - While a run is in flight: the step executing right now flashes green, and
//    steps this run has already finished keep a quiet green ring so you can see
//    how far it has got.
//  - Once it has finished: only failure is marked, and only from the MOST
//    RECENT run — a red ring on the node that broke, which stays until the
//    workflow runs again. A clean run leaves the canvas unmarked.
//
// `running` is the in-flight execution (null if none) and `latest` the newest
// execution whatever its status; while a run is in flight they are the same
// record.
const runClassesFor = (running, latest) => {
  const classes = new Map();
  const source = running || latest;
  if (!source) return classes;

  // Steps that have already reported in. During a run this grows as it goes
  // (the main process flushes nodeExecutions after each node).
  (source.nodeExecutions || []).forEach((n) => {
    if (!n?.nodeId) return;
    if (n.status === 'failed') classes.set(n.nodeId, 'wf-node-run-failed');
    else if (running) classes.set(n.nodeId, 'wf-node-run-done');
  });

  // A run killed mid-step (the app closed) never got to record that step, but
  // it does still name the node it was on — mark that one, so an interrupted
  // run points somewhere instead of looking clean. Deliberately keyed off
  // currentNodeId rather than "the last step recorded", which for an interrupt
  // is a node that genuinely completed.
  if (!running && latest?.status === 'failed' && latest.currentNodeId
      && !classes.has(latest.currentNodeId)) {
    classes.set(latest.currentNodeId, 'wf-node-run-failed');
  }

  // The node in flight wins over anything recorded for it.
  if (running?.currentNodeId) classes.set(running.currentNodeId, 'wf-node-running');

  return classes;
};

// Size declared on live-build placeholder cards.
//
// ReactFlow measures a node on first render and reports the result back
// through onNodesChange, expecting it to be written onto the node in state.
// A placeholder is deliberately NOT in that state (see the live build overlay
// below), so its measurement is dropped and it arrives "unmeasured" on every
// render — and ReactFlow renders an unmeasured node with visibility:hidden
// until it knows its size. That is a strobe, and a feedback loop with it: hide
// → measure → report → new nodes array → hide again. Declaring the size up
// front settles it. Every node card is a fixed 264px wide; the height is only
// used for fitView bounds (edges are routed from measured handle positions),
// so an approximation costs nothing.
const PLACEHOLDER_NODE_WIDTH = 264;
const PLACEHOLDER_NODE_HEIGHT = 96;
const NO_GHOSTS = new Set();

const WorkflowEditor = ({
  workflow, liveBuild = null, onSave, onAutoSave, onCancel, onCloseRequest,
  onContextChange = () => {},
}) => {
  const reactFlowWrapper = useRef(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  // The AI builder is writing this workflow right now, or has paused mid-build
  // waiting for the user to answer something. Either way the canvas is showing
  // a workflow that isn't finished and isn't the user's to save or run yet.
  const buildInFlight = !!liveBuild && (liveBuild.phase === 'building' || liveBuild.phase === 'paused');
  const [selectedNode, setSelectedNode] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [saving, setSaving] = useState(false);
  // Dropped-file import, mirroring the Connections tab: one popup per file,
  // opened for whichever form matches that file's type, with the rest of the
  // drop queued behind it. `activeFileType` doubles as the modal's open flag.
  const [activeFileType, setActiveFileType] = useState(null);
  const [droppedFile, setDroppedFile] = useState(null);
  const [fileQueue, setFileQueue] = useState([]); // remaining dropped files waiting for their popup
  const [isDragOver, setIsDragOver] = useState(false);
  // Where on the canvas the files were dropped, and how many of that batch have
  // already produced a node — together they place each new node near the cursor
  // instead of stacking every one at a fixed spot.
  const dropOriginRef = useRef(null);
  const dropIndexRef = useRef(0);
  // Set true when the user cancels (X / Cancel) so an in-flight import that
  // finishes afterwards doesn't persist the connection or open the next file.
  const importCancelledRef = useRef(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [initialWorkflowState, setInitialWorkflowState] = useState(null);
  const [isStepsEditorOpen, setIsStepsEditorOpen] = useState(false);
  const [executionSteps, setExecutionSteps] = useState([]);
  // The workflow's output-validation settings, LIVE. Like executionSteps, this
  // is state rather than something read off the `workflow` prop: that prop is
  // the record as it was when the editor opened and is never refreshed, so
  // anything read from it goes stale the moment the user saves.
  const [outputValidation, setOutputValidation] = useState(workflow?.outputValidation || null);
  // Which nodes have actually run — `{ [nodeId]: boolean }`, read by the Data
  // Preview before it queries a table a node only PLANS to write. Workflow
  // state, not node state, deliberately: see utils/executedNodes.js for why.
  const [executedNodes, setExecutedNodes] = useState(workflow?.executedNodes || {});
  const [triggerSidebarSave, setTriggerSidebarSave] = useState(false);
  const [currentWorkflowId, setCurrentWorkflowId] = useState(workflow?.id || null);
  // Nodes write files (local DuckDB tables) as soon as they execute, which
  // can be well before the workflow is first saved. currentWorkflowId stays
  // null until then — it doubles as the "already persisted?" flag for the save
  // path — so this ref carries an id from the moment the editor opens and is
  // what file scoping keys on. workflowsDb.save honours a supplied id, so the
  // provisional value becomes the real one on first save rather than being
  // replaced (which would orphan anything already written under it).
  const workflowScopeIdRef = useRef(workflow?.id || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const newScopeId = () => `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // The current graph, readable from window-event handlers that are registered
  // once and would otherwise close over a stale render's nodes/edges.
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const [editorLoading, setEditorLoading] = useState(!!workflow?.id);
  // Temp-state save: auto-save persists work-in-progress but marks the record
  // as "temp" (tempStateSave: true). The user must click Save to commit a real
  // save (which clears the flag). Execute and
  // Close are gated on this so unverified changes aren't run or lost silently.
  const [tempStateSave, setTempStateSave] = useState(false);
  // Controlled 3-button "unsaved changes" prompt shown on Execute/Close when
  // there are uncommitted changes. intent = 'close' | 'execute'.
  const [unsavedPrompt, setUnsavedPrompt] = useState({ open: false, intent: null });
  // Joins whose kept target must be dropped and recreated before they can run
  // (append / merge into a table that no longer fits) — listed for approval
  // when Execute is pressed. See startExecution.
  const [rebuildPrompt, setRebuildPrompt] = useState({ open: false, items: [] });
  // Version history drawer (see WorkflowHistory).
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // What the NEXT save should be recorded as in the history. A revert loads an
  // old version onto the canvas but does not persist it, so the version the
  // following save creates is the one that has to be labelled — set here, read
  // by the save paths, and cleared once it has been used.
  const pendingHistoryMetaRef = useRef(null);
  // Why the last validateWorkflow() refused, for callers that report it.
  const validationFailureRef = useRef(null);

  // Latest signals the on-disk code watcher reads to decide whether a
  // 'workflow:codeChanged' event should reload the canvas. `suppressUntil`
  // ignores the file writes our own auto-save makes (which would otherwise
  // trigger a reload loop).
  const reloadGuardRef = useRef({ saving: false, hasUnsavedChanges: false, suppressUntil: 0 });

  // Database schema state (shared between chat and preview)
  const [dbTables, setDbTables] = useState([]); // Full table objects with schema info
  const [activeConnection, setActiveConnection] = useState(null); // Current database connection
  const [dataPreviewRefreshTrigger, setDataPreviewRefreshTrigger] = useState(0); // Increment to trigger DataPreview refresh

  // Context menu state
  const [contextMenu, setContextMenu] = useState(null);
  const [contextMenuNode, setContextMenuNode] = useState(null);

  // Execution state
  const [isExecuting, setIsExecuting] = useState(false);
  // Live execution state for this workflow, from the shared poller in
  // utils/executionMonitorStore (the same one the execution monitor panel
  // reads, so an open canvas costs no extra polling).
  //  - `runningExecution`: an in-flight run, so the editor reflects one even
  //    when it is reopened mid-run.
  //  - `latestExecution`: the newest run whatever its status, which is where
  //    "the node that failed on the most recent run" comes from.
  //
  // Keyed on the scope id, not currentWorkflowId: a run started from a
  // workflow that has only just been saved is recorded under the scope id
  // (handleExecuteWorkflow sends the same fallback), and currentWorkflowId can
  // still be null on that render. The first save adopts the scope id, so the
  // two are the same value from then on.
  const { running: runningExecution, latest: latestExecution } =
    useWorkflowExecution(currentWorkflowId || workflowScopeIdRef.current);

  // A run we were tracking just finished — refresh the data preview so it
  // shows what the run wrote.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !runningExecution) setDataPreviewRefreshTrigger(t => t + 1);
    wasRunningRef.current = !!runningExecution;
  }, [runningExecution]);

  // Close context menu when clicking anywhere in the document
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu) {
        setContextMenu(null);
        setContextMenuNode(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [contextMenu]);

  // Clear dbTables when the selected node isn't a configured data source.
  // Both database AND file (local DuckDB/SQLite) sources populate the Schema
  // tab, so we must not wipe file sources here — doing so left the Schema tab
  // empty for configured local sources even though Preview worked (TLX-005).
  useEffect(() => {
    const connType = selectedNode?.data?.config?.connectionType;
    const isConfiguredSource =
      selectedNode?.type === 'dataSource' &&
      (connType === 'database' || connType === 'file');
    if (!isConfiguredSource) {
      setDbTables([]);
      setActiveConnection(null);
    }
  }, [selectedNode?.id, selectedNode?.type, selectedNode?.data?.config?.connectionType]);

  // Fetch a saved workflow from the local database and hydrate the editor.
  // Reused for the initial load and for live reloads when the workflow's
  // externalized code files change on disk (see the code-watcher effect).
  const loadWorkflowFromDb = useCallback(async (id, { isReload = false } = {}) => {
    if (!isReload) setEditorLoading(true);
    try {
      // User is not logged in - fetch from local database
      const { workflowsDb } = await import('../../utils/localDb');
      const fullWorkflow = await workflowsDb.getById(id);

      if (!fullWorkflow) {
        if (!isReload) message.error('Failed to load workflow details');
        return;
      }

      // Set workflow data
      setWorkflowName(fullWorkflow.name || '');
      setWorkflowDescription(fullWorkflow.description || '');
      setCurrentWorkflowId(fullWorkflow.id || null);
      if (fullWorkflow.id) workflowScopeIdRef.current = fullWorkflow.id;
      setTempStateSave(!!fullWorkflow.tempStateSave);

      // Which nodes have run is read off the workflow, beside the nodes rather
      // than on them — see utils/executedNodes.js.
      setExecutedNodes(fullWorkflow.executedNodes || {});
      const workflowNodes = Array.isArray(fullWorkflow.nodes) ? fullWorkflow.nodes : [];
      const workflowEdges = Array.isArray(fullWorkflow.edges) ? fullWorkflow.edges : [];

      setNodes(workflowNodes);
      setEdges(workflowEdges);
      // Workflows saved before steps were pruned can carry steps for nodes that
      // were deleted long ago. Drop them on the way in, so nothing downstream
      // has to reason about a step with no node.
      setExecutionSteps(sanitizeExecutionSteps(fullWorkflow.executionSteps, workflowNodes));
      setOutputValidation(fullWorkflow.outputValidation || null);

      setInitialWorkflowState({
        name: fullWorkflow.name || '',
        description: fullWorkflow.description || '',
        nodes: workflowNodes,
        edges: workflowEdges
      });

      // Whatever reaches the canvas from the database is a state worth having
      // in the history — including states this editor never saved. Ordinary
      // saves are recorded in saveWorkflowData, but two writers go around it:
      // the assistant's builder writes finished workflows straight from the
      // main process, and the code watcher picks up edits made to the
      // externalized files on disk. Recording at the point of load catches
      // both, and seeds the first version for a workflow that predates the
      // history. `record` no-ops when nothing differs from the last version,
      // so an ordinary open writes nothing.
      try {
        await workflowHistoryDb.record(fullWorkflow.id, fullWorkflow, {
          source: isReload ? 'external-edit' : 'load',
        });
      } catch (err) {
        console.warn('[workflowHistory] could not record loaded version:', err);
      }

      if (isReload) message.info('Workflow code changed on disk — canvas reloaded');
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 204 ||
          error.response?.status === 400) {
        localStorage.removeItem('auth-token');
        message.error('Session expired. Please log in again.');
        window.location.href = '/login';
        return;
      }
      console.error('Error loading workflow:', error);
      if (!isReload) message.error('Failed to load workflow details');
    } finally {
      if (!isReload) setEditorLoading(false);
    }
  }, [setNodes, setEdges]);

  // Initialize workflow data
  useEffect(() => {
    if (workflow?.id) {
      loadWorkflowFromDb(workflow.id);
    } else if (workflow?.nodes) {
      // Pre-loaded imported workflow (has nodes/edges but no saved id yet).
      // Nothing in it has run HERE, whatever the file claims — a materializing
      // node's target table is a name until a run on this machine creates it.
      setExecutedNodes(markPending({}, Array.isArray(workflow.nodes) ? workflow.nodes : []));
      const workflowNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
      const workflowEdges = Array.isArray(workflow.edges) ? workflow.edges : [];
      setWorkflowName(workflow.name || '');
      setWorkflowDescription(workflow.description || '');
      setNodes(workflowNodes);
      setEdges(workflowEdges);
      setExecutionSteps(sanitizeExecutionSteps(workflow.executionSteps, workflowNodes));
      setOutputValidation(workflow.outputValidation || null);
      setCurrentWorkflowId(null);
      workflowScopeIdRef.current = newScopeId();
      setTempStateSave(false);
      setInitialWorkflowState({
        name: workflow.name || '',
        description: workflow.description || '',
        nodes: workflowNodes,
        edges: workflowEdges,
      });
    } else {
      // Create new workflow with start node
      const startNode = {
        id: 'start-node',
        type: 'start',
        position: { x: 100, y: 200 },
        data: {
          label: 'Start',
          config: {
            triggerType: 'manual',
            undeletable: true
          }
        },
        deletable: false,
        draggable: true
      };

      setNodes([startNode]);
      setEdges([]);
      setWorkflowName('');
      setWorkflowDescription('');
      setExecutionSteps([]);
      setCurrentWorkflowId(null);
      workflowScopeIdRef.current = newScopeId();
      setTempStateSave(false);

      setInitialWorkflowState({
        name: '',
        description: '',
        nodes: [startNode],
        edges: []
      });
      setEditorLoading(false);
    }
  }, [workflow, setNodes, setEdges, loadWorkflowFromDb]);

  // A different workflow in the same editor — a build taking the canvas over,
  // or the finished workflow replacing its placeholder. The editor is reused
  // rather than remounted, so its panels would otherwise stay open over a node
  // that belongs to the workflow that just left.
  const workflowKey = workflow?.id || workflow?._id || workflow?.liveBuildId || null;
  useEffect(() => {
    setSelectedNode(null);
    setIsSidebarOpen(false);
    setContextMenu(null);
    setContextMenuNode(null);
  }, [workflowKey]);

  // A modify build rewrites the canvas the editor is already on, so the key
  // above never changes — close the panels when the build starts instead. The
  // node they were opened for is about to be rebuilt underneath them.
  const buildingId = liveBuild?.phase === 'building' ? liveBuild.workflowId : null;
  useEffect(() => {
    if (!buildingId) return;
    setSelectedNode(null);
    setIsSidebarOpen(false);
  }, [buildingId]);

  // Latest code-change handler, kept in a ref so the watcher-registration
  // effect below can depend ONLY on currentWorkflowId. If the effect also
  // depended on loadWorkflowFromDb (or an inline closure over it), every render
  // that changed that identity would tear the watcher down and re-create it —
  // producing the rapid "Watching / Stopped watching" churn — and each teardown
  // fires racy async unwatch/watch IPC. Routing through a ref means the watcher
  // is registered exactly once per workflow id while still calling the latest
  // logic (fresh loadWorkflowFromDb / guard state) on every event.
  const codeChangedHandlerRef = useRef(() => {});
  codeChangedHandlerRef.current = (workflowId, wfId) => {
    if (workflowId !== wfId) return;
    const guard = reloadGuardRef.current;
    if (guard.saving || Date.now() < guard.suppressUntil) return;
    if (guard.hasUnsavedChanges) {
      message.warning('Workflow code changed on disk, but you have unsaved canvas edits — not reloaded.');
      return;
    }
    loadWorkflowFromDb(wfId, { isReload: true });
  };

  // Watch the open workflow's externalized-code folder on disk. When a code
  // file is edited externally (e.g. in an IDE or by an AI tool), reload the
  // canvas so the editor and {userData}/workflow-code/{workflow} stay in sync.
  // Reloads are skipped while saving / shortly after a save (our own writes)
  // and when there are unsaved canvas edits (to avoid clobbering them).
  useEffect(() => {
    const api = window.electronAPI?.workflow;
    if (!api?.watchCode || !api?.onCodeChanged || !currentWorkflowId) return;
    const wfId = currentWorkflowId;

    api.watchCode(wfId);
    const unsubscribe = api.onCodeChanged(({ workflowId }) => {
      codeChangedHandlerRef.current(workflowId, wfId);
    });

    return () => {
      unsubscribe();
      api.unwatchCode(wfId);
    };
  }, [currentWorkflowId]);

  // Mirror save state into the code-watcher guard so externally-detected file
  // changes can tell our own auto-save writes apart from real edits.
  useEffect(() => { reloadGuardRef.current.saving = saving; }, [saving]);
  useEffect(() => { reloadGuardRef.current.hasUnsavedChanges = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Re-point every node's recorded input at whatever feeds it NOW.
  //
  // A node copies its parent's identity and output schema into its own
  // `source*` fields when it is configured, and the executor prefers that copy
  // over the live graph. So dropping a transformer between a data source and an
  // output moved the edge but left the output still reading the data source —
  // the new node ran, and its result was ignored.
  //
  // Running on every nodes/edges change (not just onConnect) is deliberate:
  // an edge can also be deleted and redrawn, and a parent's own output can be
  // reconfigured under a child. syncNodeSourcesToEdges returns the same array
  // when nothing moved, so this settles in one pass and does not loop.
  useEffect(() => {
    const { repointed } = syncNodeSourcesToEdges(nodes, edges);
    if (!repointed.length) return;
    // Re-derived from the latest nodes rather than set from this render's copy:
    // an update queued since this render (a config the chat just applied) would
    // otherwise be overwritten by the older array.
    setNodes((prev) => syncNodeSourcesToEdges(prev, edges).nodes);

    // A flagged transformer/join says so on the canvas — SourceChangedPopup
    // floats over the card with what moved and the two answers to it — so a
    // toast repeating that would only be noise the user has to dismiss twice.
    // Coming BACK is worth a word, though: the prompt disappears on its own,
    // and without this nothing would say why.
    for (const r of repointed) {
      if (r.nodeType === 'output' || !r.restored) continue;
      message.success(`${r.nodeLabel} is back on ${r.from.join(', ')} — its logic matches its source again.`, 4);
    }
  }, [nodes, edges, setNodes]);

  // Track changes to detect unsaved modifications (for UI display only, not auto-save)
  useEffect(() => {
    if (!initialWorkflowState) return;

    const currentState = {
      name: workflowName,
      description: workflowDescription,
      nodes,
      edges
    };

    // ReactFlow mutates transient UI/layout fields (selection, drag state,
    // measured width/height, absolute position) on every click, drag, and
    // render. Those are not user content, so strip them before comparing —
    // otherwise selecting a node after a save would re-flag "unsaved changes"
    // and the close confirmation would pop up even though nothing was edited.
    const NODE_TRANSIENT_KEYS = [
      'position', 'positionAbsolute', 'selected', 'dragging',
      'resizing', 'width', 'height',
    ];
    const EDGE_TRANSIENT_KEYS = ['selected'];

    const stripKeys = (obj, keys) => {
      const out = { ...obj };
      for (const k of keys) delete out[k];
      return out;
    };

    // `stripNodeBookkeeping` draws the same line the version history does: a
    // name we derived and re-stamp on every save is not an edit. Treating it as
    // one is what had the save after a build light up "unsaved changes" and
    // trigger another save whose only content was that name.
    const compareNodesWithoutPosition = (nodes1, nodes2) => {
      if (nodes1.length !== nodes2.length) return false;
      const norm = (list) => list.map((node) => stripNodeBookkeeping(stripKeys(node, NODE_TRANSIENT_KEYS)));
      return JSON.stringify(norm(nodes1)) === JSON.stringify(norm(nodes2));
    };

    const compareEdges = (edges1, edges2) => {
      const norm = (list) => (list || []).map((edge) => stripKeys(edge, EDGE_TRANSIENT_KEYS));
      return JSON.stringify(norm(edges1)) === JSON.stringify(norm(edges2));
    };

    const hasChanges = (
      currentState.name !== initialWorkflowState.name ||
      currentState.description !== initialWorkflowState.description ||
      !compareNodesWithoutPosition(currentState.nodes, initialWorkflowState.nodes) ||
      !compareEdges(currentState.edges, initialWorkflowState.edges)
    );

    setHasUnsavedChanges(hasChanges);
  }, [workflowName, workflowDescription, nodes, edges, initialWorkflowState]);

  const handleCancel = useCallback(() => {
    // Uncommitted work exists if there are unsaved edits OR the last save was a
    // background temp save the user hasn't committed. Prompt with Save / Don't
    // save / Cancel so the temp state is covered by an explicit save on close.
    if (hasUnsavedChanges || tempStateSave) {
      setUnsavedPrompt({ open: true, intent: 'close' });
    } else {
      onCancel();
    }
  }, [hasUnsavedChanges, tempStateSave, onCancel]);

  // Register close request handler with parent
  useEffect(() => {
    if (onCloseRequest) {
      onCloseRequest(handleCancel);
    }
  }, [onCloseRequest, handleCancel]);

  // A node can only be a parent (the source of a connection) once it has been
  // configured AND run — otherwise it has no output for the child node to
  // consume, and the failure only surfaces later as an opaque downstream error.
  // Checking it here lets us show the user a clear, actionable message instead.
  const isNodeConfiguredAndRun = (node) => {
    const cfg = node?.data?.config || {};
    switch (node?.type) {
      case 'start':
        // Root node — nothing to configure/run before it can feed data sources.
        return true;
      case 'dataSource': {
        const connectionId = cfg.sourceConnectionId || cfg.connectionId;
        const isApiSource = cfg.sourceDbCategory === 'API' || cfg.sourceConnectionType === 'api';
        if (isApiSource) {
          // A REST API source only has data once its fetch function has run.
          return !!(cfg.sourceLocalPath && cfg.apiFetchCode);
        }
        // A regular source is "run" once a connection and a table/collection/
        // query/materialised file are in place.
        const hasOutput = !!(cfg.sourceTableName || cfg.sourceCollection ||
          cfg.sourcePreviewSql || cfg.sourceLocalPath || cfg.sourceIndexName);
        return !!connectionId && hasOutput;
      }
      case 'transformer':
      case 'join':
        // A transform/join has run once its output is materialised. The output
        // location is set the same way regardless of mode — SQL, NoSQL, or a
        // Python/JavaScript/vector-db skill — so check the mode-agnostic target
        // markers rather than SQL-only fields (targetPreviewSql is absent for
        // several of those modes).
        return !!(cfg.targetConnectionId && (
          cfg.targetTableName || cfg.targetCollection ||
          cfg.targetLocalPath || cfg.targetPreviewSql
        ));
      default:
        // Branch and any future types: don't block.
        return true;
    }
  };

  const onConnect = useCallback((params) => {
    // Get the source and target nodes
    const sourceNode = nodes.find(node => node.id === params.source);
    const targetNode = nodes.find(node => node.id === params.target);

    if (!sourceNode || !targetNode) {
      message.error('Invalid connection attempt');
      return;
    }

    // A node with no output yet cannot feed another node. Without this guard the
    // edge forms silently and only errors later, deep in execution.
    if (!isNodeConfiguredAndRun(sourceNode)) {
      message.error('Please configure and run this node before connecting it to another node.');
      return;
    }

    // Enforce connection rules
    if (sourceNode.type === 'start') {
      // Start nodes can only connect to data source nodes
      if (targetNode.type !== 'dataSource') {
        message.error('Start nodes can only connect to Data Source nodes');
        return;
      }
      
      // Start nodes can have multiple connections to different data sources
      // Check if already connected to this specific data source
      const existingConnection = edges.find(edge => edge.source === sourceNode.id && edge.target === targetNode.id);
      if (existingConnection) {
        message.error('This data source is already connected to the start node');
        return;
      }
    }
    
    if (targetNode.type === 'dataSource') {
      // Data source nodes can only receive connections from start nodes
      if (sourceNode.type !== 'start') {
        message.error('Data Source nodes can only receive connections from Start nodes');
        return;
      }
      
      // Check if data source already has an incoming connection
      const existingConnection = edges.find(edge => edge.target === targetNode.id);
      if (existingConnection) {
        message.error('Data Source nodes can only have one incoming connection');
        return;
      }
    }
    
    if (sourceNode.type === 'dataSource') {
      // Data source nodes can connect to transformer, join, or output nodes
      if (!['transformer', 'join', 'output'].includes(targetNode.type)) {
        message.error('Data Source nodes can only connect to Transformer, Join, or Output nodes');
        return;
      }
    }
    
    if (targetNode.type === 'transformer') {
      // A transformer reads exactly one upstream node: executeTransformNode
      // takes the FIRST incoming edge and its config pins a single
      // sourceNodeId, so a second input would be silently ignored at run time.
      // Use a Join node to combine two sources.
      const existingConnection = edges.find(edge => edge.target === targetNode.id);
      if (existingConnection) {
        message.error('Transformer nodes can only have one input source. Use a Join node to combine two sources.');
        return;
      }
    }

    if (targetNode.type === 'output') {
      // Output (Data Export) nodes can only have one incoming connection
      const existingConnection = edges.find(edge => edge.target === targetNode.id);
      if (existingConnection) {
        message.error('Data Export nodes can only have one incoming connection');
        return;
      }
    }
    
    // Allow the connection if all rules pass
    setEdges((eds) => addEdge(params, eds));
  }, [setEdges, nodes, edges]);

  // While an import popup is open it owns the drop — see fileDragHandlers.
  const dropDisabled = Boolean(activeFileType);
  const { onDragOver, onDragLeave } = useMemo(
    () => fileDragHandlers(setIsDragOver, dropDisabled), [dropDisabled]);

  // Open the import popup for the next queued file, storing the rest so it can
  // be resumed after this one is saved. When the queue is empty everything is
  // closed. The file is only read once its popup mounts (see the
  // LocalFileConnectionForm initialFile effect), so nothing imports early.
  const processNextFile = useCallback((remaining) => {
    if (!remaining || remaining.length === 0) {
      setActiveFileType(null);
      setDroppedFile(null);
      setFileQueue([]);
      return;
    }
    importCancelledRef.current = false; // fresh popup — this file's import is allowed
    const [next, ...rest] = remaining;
    setFileQueue(rest);
    setDroppedFile(next);
    setActiveFileType(detectFileType(next.name));
  }, []);

  const onDrop = useCallback(
    (event) => {
      if (dropDisabled) return;
      event.preventDefault();
      setIsDragOver(false);

      // Files dropped on the canvas become data sources, one popup at a time,
      // exactly as they do on the Connections tab.
      if (event.dataTransfer.files?.length > 0) {
        // The editor is itself inside the Workflows tab's modal, whose own drop
        // target would otherwise see this too and bounce to Connections.
        event.stopPropagation();

        const validFiles = collectDroppableFiles(event);
        if (validFiles.length === 0) return;

        // Remember where they landed so the nodes appear under the cursor.
        const bounds = reactFlowWrapper.current?.getBoundingClientRect();
        dropOriginRef.current = bounds && reactFlowInstance
          ? reactFlowInstance.project({
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          })
          : null;
        dropIndexRef.current = 0;

        processNextFile(validFiles);
        return;
      }

      // Handle node drops (existing functionality)
      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const type = event.dataTransfer.getData('application/reactflow');

      if (typeof type === 'undefined' || !type) {
        return;
      }

      const position = reactFlowInstance.project({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });

      const newNode = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { 
          label: getNodeLabel(type),
          config: getDefaultNodeConfig(type)
        },
      };

      // Auto-connect data source nodes to start node BEFORE adding to nodes
      if (type === 'dataSource') {
        // Find the start node in current nodes state
        const startNode = nodes.find(node => node.type === 'start' && node.id === 'start-node');
        console.log('DEBUG - Auto-connection:', { startNode, newNodeId: newNode.id });
        
        if (startNode) {
          // Check if start node is already connected to this specific data source
          const existingConnection = edges.find(edge => edge.source === startNode.id && edge.target === newNode.id);
          
          if (existingConnection) {
            message.warning('This data source is already connected to the start node.');
            return; // Don't add the node if already connected
          }
          
          const newEdge = {
            id: `edge-${startNode.id}-${newNode.id}`,
            source: startNode.id,
            target: newNode.id,
            type: 'default'
          };
          console.log('DEBUG - Creating auto-connection edge:', newEdge);
          
          // Add both node and edge together
          setNodes((nds) => nds.concat(newNode));
          setEdges((eds) => [...eds, newEdge]);
        } else {
          console.log('DEBUG - No start node found for auto-connection');
          setNodes((nds) => nds.concat(newNode));
        }
      } else {
        // For non-data source nodes, just add the node
        setNodes((nds) => nds.concat(newNode));
      }
    },
    [reactFlowInstance, setNodes, setEdges, nodes, edges, processNextFile, dropDisabled]
  );

  const getNodeLabel = (type) => {
    switch (type) {
      case 'start':
        return 'Start';
      case 'dataSource':
        return 'Data Source'; // This will be overridden by the component based on configuration
      case 'transformer':
        return 'Transformer';
      case 'join':
        return 'Join';
      case 'branch':
        return 'Branch';
      case 'output':
        return 'Output';
      default:
        return 'Node';
    }
  };

  const getDefaultNodeConfig = (type) => {
    switch (type) {
      case 'start':
        return { triggerType: 'manual', scheduleType: 'interval', interval: 5, intervalUnit: 'minutes' };
      case 'dataSource':
        return { connectionId: null, table: '', query: '' };
      case 'transformer':
        return { operation: '', config: {} };
      case 'join':
        return { joinType: 'inner', condition: '' };
      case 'branch':
        return { steps: [], validationFunction: null };
      case 'output':
        return { destination: '', format: 'table' };
      default:
        return {};
    }
  };

  // Ids of live-build placeholder cards, readable from the click handlers.
  // They're computed further down (with the overlay they belong to) and go
  // through a ref because these callbacks are created above that point.
  const ghostIdsRef = useRef(NO_GHOSTS);

  const onNodeClick = useCallback((event, node) => {
    // A card the AI builder is still writing. It has no config and no edges
    // yet — opening it would show an empty node panel and a preview
    // complaining about missing inputs, describing the placeholder rather
    // than the node being built. Say what it actually is instead.
    if (ghostIdsRef.current.has(node.id)) {
      message.info('This node is still being built — it will open once the build finishes.');
      return;
    }

    // Everything the clicked node is carrying — the raw node (position, data)
    // and its full config, chat transcript and schemas included, plus how it
    // is wired. Logged as live objects so the console can expand them.
    console.log('[WorkflowEditor] node clicked:', node );

    // Close context menu if open
    setContextMenu(null);
    setContextMenuNode(null);

    // Check if node has required inputs (transformer needs 1 upstream, join 2).
    const canOpenSidebar = canNodeOpenSidebar(node, nodes, edges);
    if (!canOpenSidebar) {
      message.warning(getNodeRequirementMessage(node));
      return;
    }

    // Transformer/Join are configured through the chat assistant (which targets
    // the focused node), NOT the per-node sidebar. Selecting them shows the
    // DataPreview (Details tab) and focuses the chat via the node-focus effect.
    if (node.type === 'transformer' || node.type === 'join') {
      setSelectedNode(node);
      setIsSidebarOpen(false);
    } else {
      // Data Source / Start / Output — option-picking config in the sidebar.
      setSelectedNode(node);
      setIsSidebarOpen(true);
    }
  }, [nodes, edges]);

  // Handle node context menu (right-click)
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();
    // Nothing on the menu (edit, rename, delete) applies to a card that is
    // still being built.
    if (ghostIdsRef.current.has(node.id)) return;

    setContextMenuNode(node);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  // Handle Edit from context menu
  const handleEditNode = useCallback(() => {
    if (contextMenuNode) {
      setContextMenu(null);
      const canOpenSidebar = canNodeOpenSidebar(contextMenuNode, nodes, edges);

      if (!canOpenSidebar) {
        message.warning(getNodeRequirementMessage(contextMenuNode));
      } else if (contextMenuNode.type === 'transformer' || contextMenuNode.type === 'join') {
        // Chat-configured — select (shows Details + focuses chat), no sidebar.
        setSelectedNode(contextMenuNode);
        setIsSidebarOpen(false);
      } else {
        setSelectedNode(contextMenuNode);
        setIsSidebarOpen(true);
      }
      setContextMenuNode(null);
    }
  }, [contextMenuNode, nodes, edges]);

  // Handle Delete from context menu
  const handleDeleteNode = useCallback(() => {
    if (contextMenuNode) {
      setContextMenu(null);

      // Remove the node
      setNodes((nds) => nds.filter((n) => n.id !== contextMenuNode.id));

      // Remove connected edges
      setEdges((eds) => eds.filter(
        (edge) => edge.source !== contextMenuNode.id && edge.target !== contextMenuNode.id
      ));

      message.success(`Node deleted successfully`);
      setContextMenuNode(null);

      // Close sidebar if deleted node was selected
      if (selectedNode?.id === contextMenuNode.id) {
        setIsSidebarOpen(false);
        setSelectedNode(null);
      }
    }
  }, [contextMenuNode, selectedNode, setNodes, setEdges]);

  // Close context menu when clicking anywhere
  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
    setContextMenuNode(null);
    // Clicking empty canvas takes the node out of focus — same as the Data
    // Preview close button (closes the preview and clears the chat's focus).
    setSelectedNode(null);
    setIsSidebarOpen(false);
  }, []);
  // console.log('nodes: ', selectedNode)
  /**
   * Merge a config onto a node and bring its derived name along.
   *
   * The name is re-derived here rather than only on save because it is read
   * straight away — by the card, the panel header, the steps editor — and a name
   * we derived earlier describes the config it was derived FROM. Point a data
   * source at a different connection and the old name is simply wrong.
   *
   * Shared by both ways a config arrives: the chat builder's apply-node-config
   * and the form panels' onConfigUpdate. They used to differ, which is why a
   * chat-rebuilt transformer renamed itself and a form-configured data source
   * did not.
   *
   * `replace` is for a FINISHED build, which hands back a complete config and
   * must not inherit anything from the run before it. Merging one of those is
   * how a rebuilt node kept fields the new build simply didn't write: a
   * transformer retargeted from local DuckDB onto BigQuery took the new
   * targetDdl and targetConnection* but carried its OLD targetSql forward —
   * `SELECT … FROM earliest_transactions` — and the run created the BigQuery
   * table, then failed loading it from a table that only ever existed locally.
   * The plan-build path never had this: executeBuild writes
   * `data: { label, config }` wholesale. Everything meant to survive a rebuild
   * already travels INSIDE the built config — the builder puts the node's whole
   * chat transcript on it (buildNodeConfig sets config.chat) — so replacing
   * loses nothing that should have carried.
   *
   * Form panels stay on the merge path: they send ONE field at a time, and
   * replacing on those would erase the rest of the node.
   */
  const mergeConfigWithName = useCallback((node, config, { replace = false } = {}) => {
    const next = { ...node, data: { ...node.data, config: replace ? { ...config } : { ...(node.data?.config || {}), ...config } } };
    // Whatever set `sourceChanged` (a rewire re-pointing this node's input) is
    // answered by this save: the config now in hand was built against the
    // current source, which therefore becomes its new baseline. Clearing both
    // here covers either way a config arrives — chat builder or form panel.
    delete next.data.config.sourceChanged;
    delete next.data.config.sourceChangeKind;
    delete next.data.config.sourceChangedTo;
    delete next.data.config.sourceBuiltAgainst;
    const name = persistedNameFor(next.type, next.data);
    return name
      ? { ...next, data: { ...next.data, config: { ...next.data.config, node_name: name, node_nameAuto: true } } }
      : next;
  }, []);

  /**
   * Record that these nodes describe an output they have not produced.
   *
   * A transformer/join/output names its target table the moment it is built or
   * reconfigured, so until it runs that name is a plan and nothing else. This
   * is the "not yet" half of markNodesExecuted, and it is called from the two
   * places a node's logic is (re)written: the node chat's save and a chat
   * build. Not from every config update — the config forms also send single
   * fields (a typed name, a toggle), and those leave the node's output alone.
   *
   * Takes `{ id, type }`, with `type` optional: only materializing types are
   * tracked, and the caller does not always know which this is. The canvas
   * answers when it doesn't — and a caller that DOES know says so, because a
   * build can land before the node it wrote has settled into `nodesRef`.
   */
  const markNodesPending = useCallback((entries) => {
    const live = nodesRef.current || [];
    const resolved = entries.map(({ id, type }) => ({
      id,
      type: type || live.find((n) => n.id === id)?.type,
    }));
    setExecutedNodes((prev) => markPending(prev, resolved));
  }, []);

  // Handle node configuration updates.
  //
  // `resetExecuted` says this update rewrote what the node produces — the node
  // chat's save, not a form field — so whatever it wrote before no longer
  // stands. See markNodesPending.
  const onNodeConfigUpdate = useCallback((nodeId, config, { resetExecuted = false } = {}) => {
    console.log('config: ', config)
    setNodes((nds) => nds.map((node) => (node.id === nodeId ? mergeConfigWithName(node, config) : node)));
    // The open panel and the preview read `selectedNode`, not the nodes array,
    // so without this the form that just saved keeps showing the old title.
    setSelectedNode((prev) => (prev && prev.id === nodeId ? mergeConfigWithName(prev, config) : prev));
    if (resetExecuted) markNodesPending([{ id: nodeId }]);

    // Trigger auto-save flag for sidebar changes
    setTriggerSidebarSave(true);
  }, [setNodes, mergeConfigWithName, markNodesPending]);

  // ── Chat-assistant canvas graph ──────────────────────────────────────────
  //
  // The canvas as the chat's context: node ids, types, labels and the config
  // fields that say what each node reads and writes. The assistant renders one
  // line per node from this (workflowHeadline in public/chat/chatAssistant.js).
  //
  // It is sent because the DATABASE is not what the user is looking at. A
  // never-saved canvas has no row at all, and a saved one with unsaved edits has
  // a row describing the last save — either way the chat used to see only
  // "6 nodes on the canvas" and had to guess the rest.
  //
  // Pruned here, before IPC, for three reasons: schema sample rows are by far the
  // largest thing on a node (a single imported-JSON source carries ~13k chars of
  // them), SQL and generated code are fetched on demand by node id instead, and
  // live node objects are not structured-cloneable — that is what `toCloneable`
  // guards, and sending them raw is what previously failed with "object could not
  // be cloned".
  const canvasGraph = useMemo(() => {
    // Statements and generated code: named, never sent. Whether a node HAS one is
    // the part that belongs in a summary ("SQL" / "JS" / "not configured yet");
    // the code itself is what get_workflow_nodes is for. Dropping them silently
    // made a configured join read as unconfigured, so the names travel as
    // `hasLogic` — see logicLabel in public/chat/chatAssistant.js.
    const LOGIC = [
      'transformFunction', 'apiFetchCode', 'targetSql', 'joinSql',
      'targetDdl', 'insertSql', 'nosqlOperation', 'vectorFetchOperation',
    ];
    const DROP = new Set([
      'chat',
      ...LOGIC,
      'sourceSql', 'sourcePreviewSql', 'targetPreviewSql',
      // Restates every source's schema and connection, all of it already here.
      'sources', 'sourcesConfig', 'executed',
    ]);
    const slimSchema = (s) => (s && typeof s === 'object'
      ? { tableName: s.tableName || null, columns: (s.columns || []).map((c) => ({ name: c?.name, type: c?.type })) }
      : undefined);
    try {
      return toCloneable({
        nodes: (nodes || []).map((n) => {
          const cfg = n.data?.config || {};
          const out = {};
          for (const [k, v] of Object.entries(cfg)) {
            if (DROP.has(k) || v == null || v === '') continue;
            if (k === 'sourceTableSchema' || k === 'targetTableSchema') out[k] = slimSchema(v);
            else out[k] = typeof v === 'string' ? v.slice(0, 400) : v;
          }
          const hasLogic = LOGIC.filter((k) => cfg[k] != null && cfg[k] !== '');
          if (hasLogic.length) out.hasLogic = hasLogic;
          return { id: n.id, type: n.type, data: { label: n.data?.label || null, config: out } };
        }),
        edges: (edges || []).map((e) => ({ source: e.source, target: e.target })),
      }, 'canvasGraph');
    } catch (err) {
      // Context is a nicety; never let it break a turn.
      console.warn('[WorkflowEditor] could not build the canvas graph for chat context:', err);
      return null;
    }
  }, [nodes, edges]);

  // ── Chat-assistant node targeting ────────────────────────────────────────
  // Build the payload the ChatAssistant sends to chat:step as `targetNode`, so
  // the main prompt can route to the transformer/join (or REST-API dataSource)
  // builder for THIS node. Only chat-configured node types are targetable.
  const buildTargetNodePayload = useCallback((node) => {
    if (!node) return null;
    const type = node.type;
    const cfg = node.data?.config || {};
    const isApiDS = type === 'dataSource' &&
      (cfg.sourceConnectionType === 'api' || cfg.sourceDbType === 'rest-api' || cfg.dbType === 'rest-api');
    if (type !== 'transformer' && type !== 'join' && !isApiDS) return null;
    try {
      const upstreamNodes = edges
        .filter((e) => e.target === node.id)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter(Boolean);
      return {
        // The scope id, not currentWorkflowId: a chat build can write files
        // before the workflow has ever been saved.
        workflowId: workflowScopeIdRef.current || currentWorkflowId || null,
        nodeId: node.id,
        type,
        // The name the CARD shows, not `data.label`: that is the type label
        // ("Join", "Transformer") until someone renames the node, so the chat
        // chip read "Join Join" and could not tell two joins apart.
        label: nodeDisplayName(type, node.data || {}, node.data?.label || type),
        config: toCloneable(node.data?.config || {}, 'targetNode.config'),
        upstreamNodes: toCloneable(upstreamNodes, 'targetNode.upstream'),
        connectionId: isApiDS ? (cfg.sourceApiConnectionId || cfg.sourceConnectionId || null) : null,
        isApi: !!isApiDS,
      };
    } catch (e) {
      console.warn('[WorkflowEditor] could not build targetNode payload:', e);
      return null;
    }
  }, [nodes, edges, currentWorkflowId]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // ── Live build overlay ────────────────────────────────────────────────────
  //
  // While the AI builder applies a plan it streams one event per node (see
  // public/chat/workflowBuilder.js). Workflows.js accumulates them and hands
  // the running graph down as `liveBuild`, which we draw ON TOP of the canvas:
  // a card appears the moment a node's build starts, glows while the builder
  // works on it, and settles when that step finishes.
  //
  // The overlay never touches `nodes` / `edges` state. That matters — those
  // drive saving, execution, the steps editor and the unsaved-changes check,
  // and a half-built placeholder must not reach any of them. It exists only in
  // what we hand ReactFlow to render, and only for ids the real graph doesn't
  // have yet: a node that already exists (a modify build, or the finished
  // workflow after it reloads) keeps its real card and merely picks up the
  // glow class. When there is no build in flight these are the state arrays
  // themselves, identity included, so nothing about the editor changes.
  const liveSteps = liveBuild?.nodes;

  // Ids drawn only from the progress stream — nodes the real graph doesn't
  // have yet. ReactFlow reports changes for them (it can't know they're not
  // ours to keep); those are filtered out below rather than run through
  // applyNodeChanges, which would rebuild the state array for nothing.
  const ghostIds = useMemo(() => {
    if (!liveSteps || liveSteps.length === 0) return NO_GHOSTS;
    const real = new Set(nodes.map((n) => n.id));
    const ids = liveSteps.filter((s) => s.id && s.type && !real.has(s.id)).map((s) => s.id);
    return ids.length ? new Set(ids) : NO_GHOSTS;
  }, [nodes, liveSteps]);
  ghostIdsRef.current = ghostIds;

  // Execution rings — which node is running, which have run, which failed last
  // time. Independent of the build overlay above: a build and a run never
  // happen at once, but both write to the node's className.
  const runClasses = useMemo(
    () => runClassesFor(runningExecution, latestExecution),
    [runningExecution, latestExecution],
  );

  // The ids of the saved connections, so a data source whose connection has
  // been deleted can say so on its card — the same red banner a transformer
  // shows when its parent moves. null until the first read: nothing is
  // flagged on a guess. Re-read whenever a connection is saved or deleted
  // (connectionsDb announces it) and when the window regains focus.
  const [savedConnections, setSavedConnections] = useState(null);
  const savedConnectionIds = useMemo(
    () => (savedConnections ? new Set(savedConnections.map((c) => c.id).filter(Boolean)) : null),
    [savedConnections],
  );
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const all = await connectionsDb.getAll();
        if (alive) setSavedConnections(all || []);
      } catch (_) { /* keep the last answer */ }
    };
    load();
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, load);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener(CONNECTIONS_CHANGED_EVENT, load);
      window.removeEventListener('focus', load);
    };
  }, [currentWorkflowId]);

  // A deleted connection that has been added back is a new record with a new
  // id. When exactly one saved connection is plainly the same one (same type,
  // and the same name or file path), every node that named the old id is
  // pointed at it — no red card, no re-picking it node by node. Anything less
  // certain stays red for the user to choose. See utils/connectionRefs.
  useEffect(() => {
    if (!savedConnections) return;
    const { nodes: next, relinked } = relinkReaddedConnections(nodesRef.current || nodes, savedConnections);
    if (!relinked.length) return;
    setNodes(next);
    setHasUnsavedChanges(true);
    message.info(
      `Reconnected to ${relinked.map((r) => `"${r.name}"`).join(', ')} — the connection was added back. Save to keep it.`,
      6,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedConnections, currentWorkflowId]);

  // Nodes with the derived `connectionMissing` flag on each data source whose
  // saved connection no longer exists. Derived for display only — never
  // saved — so restoring the connection clears it. `local-…` ids are
  // placeholders for the workflow's own storage, not saved connections.
  const nodesWithConnectionState = useMemo(() => {
    if (!savedConnectionIds) return nodes;
    let changed = false;
    const next = nodes.map((n) => {
      if (n.type !== 'dataSource') return n;
      const id = n.data?.config?.sourceConnectionId;
      const missing = !!id && !String(id).startsWith('local-') && !savedConnectionIds.has(id);
      if (!!n.data?.connectionMissing === missing) return n;
      changed = true;
      return { ...n, data: { ...n.data, connectionMissing: missing } };
    });
    return changed ? next : nodes;
  }, [nodes, savedConnectionIds]);

  const displayNodes = useMemo(() => {
    const nodes = nodesWithConnectionState;
    if ((!liveSteps || liveSteps.length === 0) && runClasses.size === 0) return nodes;
    const stepById = new Map((liveSteps || []).map((s) => [s.id, s]));
    const withGlow = nodes.map((n) => {
      const cls = [buildClassFor(stepById.get(n.id)), runClasses.get(n.id)].filter(Boolean).join(' ');
      return cls ? { ...n, className: [n.className, cls].filter(Boolean).join(' ') } : n;
    });
    if (!liveSteps || liveSteps.length === 0) return withGlow;
    const placeholders = liveSteps
      .filter((s) => ghostIds.has(s.id))
      .map((s) => ({
        id: s.id,
        type: s.type,
        position: s.position || { x: 0, y: 0 },
        // An empty config is what an unconfigured node has, so every card
        // renders its "not configured yet" state — which is exactly true.
        data: { label: s.label || 'Node', config: {} },
        className: buildClassFor(s),
        // Declared rather than measured — see PLACEHOLDER_NODE_WIDTH.
        width: PLACEHOLDER_NODE_WIDTH,
        height: PLACEHOLDER_NODE_HEIGHT,
        // Inert: it isn't a real node yet, so it can't be moved, wired,
        // opened or deleted.
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
      }));
    return placeholders.length ? withGlow.concat(placeholders) : withGlow;
  }, [nodesWithConnectionState, liveSteps, ghostIds, runClasses]);

  // Drop ReactFlow's changes for placeholder nodes: they aren't in `nodes`, so
  // applyNodeChanges can only discard them anyway — but it returns a fresh
  // array every time it is called, and that new identity re-renders the canvas
  // and re-triggers the measurement it just answered.
  const handleNodesChange = useCallback((changes) => {
    if (ghostIds.size === 0) { onNodesChange(changes); return; }
    const own = changes.filter((c) => !ghostIds.has(c.id));
    if (own.length) onNodesChange(own);
  }, [onNodesChange, ghostIds]);

  const liveEdges = liveBuild?.edges;
  const displayEdges = useMemo(() => {
    const merged = (!liveSteps || liveSteps.length === 0 || !liveEdges?.length)
      ? edges
      : (() => {
        const have = new Set(edges.map((e) => `${e.source}->${e.target}`));
        const extra = liveEdges
          .filter((e) => e && e.source && e.target && !have.has(`${e.source}->${e.target}`))
          .map((e) => ({
            id: e.id || `live-${e.source}-${e.target}`,
            source: e.source,
            target: e.target,
            // Named by the builder for a join; filled in below when it isn't.
            ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
            animated: true,
            selectable: false,
            deletable: false,
            focusable: false,
            style: { stroke: '#3b82f6', strokeWidth: 2, strokeDasharray: '6 4' },
          }));
        return extra.length ? edges.concat(extra) : edges;
      })();

    // Two things are fixed up for DRAWING only — `edges` state, and so what is
    // saved, is left exactly as it was:
    //
    //  · A join has one input dot per source. An edge that doesn't say which
    //    one it lands on is routed to the FIRST (see getHandle in
    //    @reactflow/core), which stacked every incoming edge on the top dot and
    //    ran the second one diagonally across the card to reach it. Only a
    //    hand-drawn connection names its handle; everything the AI builder and
    //    the live preview derive, and every workflow saved before this, needs
    //    the dot filled in.
    //
    //  · The route. A bezier edge leaves its dot along a control arm scaled to
    //    the horizontal gap between the two cards — 56px at the builder's
    //    column spacing — so two nodes in different rows were joined by a curve
    //    that bulged back over both cards. 'smoothstep' leaves the source dot
    //    horizontally, turns in the corridor between the columns, and comes
    //    into the target dot horizontally, which is the dot-to-dot line the
    //    cards are drawn for. Edges that ask for a specific type keep it.
    const withHandles = withJoinInputHandles(merged, displayNodes);
    let routed = false;
    const out = withHandles.map((e) => {
      if (!e || (e.type && e.type !== 'default')) return e;
      routed = true;
      return { ...e, type: 'smoothstep' };
    });
    return routed ? out : withHandles;
  }, [edges, liveEdges, liveSteps, displayNodes]);

  // The node the builder is on right now: the canvas banner names it, and the
  // view follows it (below).
  const runningStep = useMemo(
    () => (liveSteps || []).find((s) => s.status === 'running') || null,
    [liveSteps],
  );
  const buildingLabel = runningStep ? (runningStep.label || runningStep.type || '') : '';
  const runningStepId = runningStep?.id || null;
  // Read by the follow effect when it fires, so the step's position is the
  // latest one reported rather than the one captured when it started running.
  const runningStepRef = useRef(null);
  runningStepRef.current = runningStep;

  // Follow the builder. A build fans out to the right and downward, so a fixed
  // view loses it within a few nodes — and re-fitting the whole graph on every
  // node (what this used to do) zooms further out with each one until the cards
  // are unreadable smudges. Instead the canvas pans to centre each node as its
  // build STARTS, at whatever zoom the user is on, so the node being written is
  // the one being looked at. Keyed on the node's id alone: a step re-reporting
  // itself (running → done) doesn't move the view, and the user is free to pan
  // around between nodes.
  useEffect(() => {
    if (!reactFlowInstance || !runningStepId) return undefined;
    const t = setTimeout(() => {
      try {
        // A node the canvas already owns (a modify build rewriting one the user
        // placed) is wherever the user left it; a brand-new one is only in the
        // progress event so far.
        const pos = nodesRef.current.find((n) => n.id === runningStepId)?.position
          || runningStepRef.current?.position;
        if (!pos) return;
        // Cards are a fixed width; the height is an approximation (see
        // PLACEHOLDER_NODE_HEIGHT) and only shifts the centre by a few pixels.
        const zoom = Math.min(Math.max(reactFlowInstance.getZoom() || 1, 0.55), 1.25);
        reactFlowInstance.setCenter(
          pos.x + PLACEHOLDER_NODE_WIDTH / 2,
          pos.y + PLACEHOLDER_NODE_HEIGHT / 2,
          { zoom, duration: 400 },
        );
      } catch (_) { /* view is optional */ }
    }, 60);
    return () => clearTimeout(t);
  }, [runningStepId, reactFlowInstance]);

  // Nothing left to follow: show the finished workflow whole, once.
  const liveBuildPhase = liveBuild?.phase || null;
  useEffect(() => {
    if (!reactFlowInstance || liveBuildPhase !== 'done') return undefined;
    const t = setTimeout(() => {
      try { reactFlowInstance.fitView({ padding: 0.2, duration: 400 }); } catch (_) { /* view is optional */ }
    }, 120);
    return () => clearTimeout(t);
  }, [liveBuildPhase, reactFlowInstance]);

  // A finished build is the change a user is most likely to want to undo, and
  // it is written by the main process — so it reaches the database without
  // passing the editor's save path at all. Record it as its own version the
  // moment the build lands, rather than waiting for the next manual save to
  // fold it into an unrelated one. Reading from the database (not the canvas)
  // because the canvas may still be showing the build's overlay; `record`
  // no-ops if the load-time recorder above already got there first.
  const buildWorkflowId = liveBuild?.workflowId || null;
  useEffect(() => {
    if (liveBuildPhase !== 'done') return undefined;
    const wfId = buildWorkflowId || currentWorkflowId;
    if (!wfId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { workflowsDb } = await import('../../utils/localDb');
        const built = await workflowsDb.getById(wfId);
        if (!built || cancelled) return;
        await workflowHistoryDb.record(wfId, built, { source: 'ai-build' });
      } catch (err) {
        console.warn('[workflowHistory] could not record built version:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [liveBuildPhase, buildWorkflowId, currentWorkflowId]);

  // Broadcast the focused node to the ChatAssistant. It re-fires when the
  // node's config changes (e.g. right after a build) so the chat always has
  // the current SQL/JS for refinement. Clears focus when nothing is selected.
  // Its inputs too: the payload carries the node's upstream nodes, and the chat
  // decides from them whether the node can be built yet.
  const selectedInputs = selectedNode
    ? edges.filter((e) => e.target === selectedNode.id).map((e) => e.source).join('|')
    : '';
  useEffect(() => {
    const payload = selectedNode ? buildTargetNodePayload(selectedNode) : null;
    window.dispatchEvent(new CustomEvent('ternlux:node-focus', { detail: payload }));
    // Fire only when the selection, its config or its wiring changes (not on
    // every canvas drag/highlight). buildTargetNodePayload is intentionally
    // excluded — it reads the current nodes/edges at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode?.id, selectedNode?.data?.config, selectedInputs]);

  // Closing the workflow takes the canvas — and therefore the focused node —
  // away with it. The assistant outlives this editor, so drop the focus on the
  // way out or it keeps offering to edit a node that is no longer on screen.
  // Tell the assistant which workflow is open, so a "Run this node" card for a
  // node of another (or a closed) workflow is disabled until this one is open.
  // Same id the node-focus payload carries (the scope id a first save adopts).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ternlux:workflow-open', {
      detail: { workflowId: workflowScopeIdRef.current || currentWorkflowId || null },
    }));
  }, [currentWorkflowId]);
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('ternlux:workflow-open', { detail: { workflowId: null } }));
  }, []);

  // `closed` tells the assistant this is the canvas going away, not a node
  // being deselected — a deselect can leave a node in the conversation while
  // its builder waits for an answer, a closed workflow never does.
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('ternlux:node-focus', { detail: { closed: true } }));
  }, []);

  // Tell the ChatAssistant whether this canvas has uncommitted work.
  //
  // A build reads the workflow from the DATABASE, so accepting a plan while the
  // canvas holds unsaved edits would plan against the older saved version and
  // write over them. The save gate already catches that at click time, but
  // being told "no" after committing to a build is a worse experience than the
  // button saying up front that it is waiting on a save. `tempStateSave` counts
  // as uncommitted for the same reason handleCancel treats it that way: it is a
  // background save the user has not accepted.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ternlux:workflow-dirty', {
      detail: { dirty: hasUnsavedChanges || tempStateSave, name: workflowName || null },
    }));
  }, [hasUnsavedChanges, tempStateSave, workflowName]);

  // No editor, nothing unsaved — otherwise the assistant would keep a plan
  // disabled forever over a canvas that has since closed.
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('ternlux:workflow-dirty', { detail: { dirty: false } }));
  }, []);

  // Keep the ChatAssistant's focus chip on whatever workflow this canvas holds.
  //
  // The tab reports context when the user opens a SAVED workflow, which left a
  // freshly created one with no focus at all: it has no name until the user
  // types one, and no database row until the first save, so there was nothing
  // to report it by. Report the id it is already scoped by — the same id the
  // first save persists under — with the name as it actually stands (null until
  // the user names it) and `unsaved` while there is no record behind that id.
  // The assistant turns those into what it shows and what it sends; this only
  // states the facts.
  //
  // `workflow` is a dependency because the init effect above reassigns
  // workflowScopeIdRef when the prop changes; it is declared before this one,
  // so by the time this runs the ref already holds that commit's scope id.
  useEffect(() => {
    // A saved workflow is still being read out of the database — its name is
    // momentarily '' and reporting now would replace the name the tab already
    // put on the chip with an id, for one frame, on every open.
    if (editorLoading) return;
    onContextChange({
      kind: 'workflow',
      id: currentWorkflowId || workflowScopeIdRef.current,
      name: workflowName.trim() || null,
      unsaved: !currentWorkflowId,
      summary: workflowDescription
        || `${nodes.length} node${nodes.length === 1 ? '' : 's'} on the canvas`,
      // What the assistant describes the workflow FROM — see canvasGraph. In the
      // deps below rather than `nodes.length`, so a node whose config changed
      // (renamed, retargeted, pointed at another file) re-reports; the memo
      // returns a new object only when the nodes or edges actually change.
      graph: canvasGraph,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow, editorLoading, currentWorkflowId, workflowName, workflowDescription, canvasGraph, onContextChange]);

  // Read through a ref so the cleanup below can stay mount-only: a changed
  // callback identity must not clear the context mid-life, since the effect
  // above would not re-report it (its own deps wouldn't have changed).
  const onContextChangeRef = useRef(onContextChange);
  onContextChangeRef.current = onContextChange;
  // The canvas is what "the workflow in focus" means, so the focus goes with it.
  useEffect(() => () => onContextChangeRef.current(null), []);

  // Apply a config the ChatAssistant built for a node (via build_transformer /
  // build_join / build_dataSource). Writes it onto the node + the selectedNode
  // snapshot, flags unsaved, and refreshes the preview.
  useEffect(() => {
    const handler = (e) => {
      const nb = e.detail;
      if (!nb || !nb.nodeId || !nb.config) return;
      // Apply the built config, then re-derive the node's name from it: a
      // rebuild that retargets a transformer should rename it, and the name
      // has to be on the node before a run or save reads it.
      //
      // A finished build REPLACES the config; only a `partial` commit (the
      // builder's question/answer chat, carrying no build output) merges. See
      // mergeConfigWithName for what carrying a rebuild's leftovers costs.
      const withName = (n) => mergeConfigWithName(n, nb.config, { replace: !nb.partial });
      setNodes((prev) => prev.map((n) => (n.id === nb.nodeId ? withName(n) : n)));
      setSelectedNode((prev) => (prev && prev.id === nb.nodeId ? withName(prev) : prev));
      setHasUnsavedChanges(true);
      // `partial` = a follow-up chat commit (question/answer only), not a build.
      if (!nb.partial) {
        // A build just rewrote what this node produces, so whatever it wrote
        // before — if it had ever run — no longer stands.
        markNodesPending([{ id: nb.nodeId, type: nb.nodeType }]);
        message.success(`Updated ${nb.nodeType || 'node'} configuration from chat.`);
        if (handleDataPreviewRefresh) handleDataPreviewRefresh();
      }
    };
    window.addEventListener('ternlux:apply-node-config', handler);
    return () => window.removeEventListener('ternlux:apply-node-config', handler);
  }, [setNodes, mergeConfigWithName, markNodesPending]);

  // ── "Your input moved" prompt ────────────────────────────────────────────
  //
  // The card floating over a flagged transformer or join (SourceChangedPopup)
  // offers two answers, and both land here: only the canvas has the nodes, the
  // bridge to the assistant, and the unsaved-changes bookkeeping.
  useEffect(() => {
    const findNode = (nodeId) => (nodesRef.current || []).find((n) => n.id === nodeId) || null;

    // "Keep as is" — the logic still holds against the input the node has now,
    // so that input becomes its baseline. Dropping these four fields is exactly
    // what a regenerated node does on save (see mergeConfigWithName): the next
    // sync pass re-derives the baseline from what the node currently reads and
    // finds nothing stale, so the flag stays down.
    const onConfirm = (e) => {
      const nodeId = e.detail?.nodeId;
      if (!nodeId) return;
      const accept = (n) => {
        const {
          sourceChanged: _flag, sourceChangeKind: _kind, sourceChangedTo, ...rest
        } = (n.data?.config || {});
        // The answer is RECORDED against the input it was given for, not
        // applied by wiping what the node remembers. Dropping
        // `sourceBuiltAgainst` here is what used to lose the original: the next
        // sync pass re-derived a baseline from the copy that had already
        // followed the parent, so pointing the source back at the original read
        // as a fresh move and the card asked again with no way out. Keeping
        // both lets syncNodeSourcesToEdges see "still the input they accepted"
        // (stay quiet) and "back on the original" (clear everything).
        const config = Array.isArray(sourceChangedTo) && sourceChangedTo.length
          ? { ...rest, sourceChangeAcked: sourceChangedTo }
          : rest;
        return { ...n, data: { ...n.data, config } };
      };
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? accept(n) : n)));
      setSelectedNode((prev) => (prev && prev.id === nodeId ? accept(prev) : prev));
      setHasUnsavedChanges(true);
      message.success('Kept as is — this node now counts its current input as what it was built for.');
    };

    // "Rebuild" — hand the node to the assistant. Focus it first (that is what
    // routes the turn to the transformer/join builder for THIS node), then ask
    // for a fresh chat carrying what moved. The rebuild itself comes back the
    // ordinary way, as `ternlux:apply-node-config` above, which clears the flag.
    const onRebuild = (e) => {
      const node = findNode(e.detail?.nodeId);
      if (!node) return;
      window.dispatchEvent(new CustomEvent('ternlux:node-focus', {
        detail: buildTargetNodePayload(node),
      }));
      window.dispatchEvent(new CustomEvent('ternlux:chat-new-message', {
        detail: { text: sourceChangeRequestText(node, workflowName) },
      }));
    };

    window.addEventListener('ternlux:node-source-confirm', onConfirm);
    window.addEventListener('ternlux:node-source-rebuild', onRebuild);
    return () => {
      window.removeEventListener('ternlux:node-source-confirm', onConfirm);
      window.removeEventListener('ternlux:node-source-rebuild', onRebuild);
    };
  }, [setNodes, buildTargetNodePayload, workflowName]);

  // Run one node on the chat assistant's behalf. The assistant holds the
  // approval UI but not the graph, so it asks here and we answer through the
  // `resolve` callback the event carries (same renderer — a function in the
  // detail is fine). Nodes are read out of setNodes rather than the closure so
  // a config applied moments ago is already in what we send.
  useEffect(() => {
    const handler = (e) => {
      const { nodeId, resolve } = e.detail || {};
      // Tells a synchronous dispatcher that this listener took the event, so a
      // caller awaiting `resolve` knows the difference between "running" and
      // "nothing is listening". See runNode in NodeChatPanel.
      if (e.detail) e.detail.handled = true;
      const done = typeof resolve === 'function' ? resolve : () => {};
      if (!nodeId) { done({ success: false, message: 'No node was named.' }); return; }
      (async () => {
        try {
          if (!window.electronAPI?.workflow?.executeNode) {
            done({ success: false, message: 'Node execution is not available.' });
            return;
          }
          const result = await window.electronAPI.workflow.executeNode({
            workflowId: workflowScopeIdRef.current || currentWorkflowId || null,
            nodeId,
            // The run card showed the drop-and-recreate warning: Run approves it.
            approvedRebuilds: e.detail?.approveRebuild ? [nodeId] : [],
            // Same sanitization the full-run path needs: live nodes carry Arrow
            // vectors and circular refs that cannot cross IPC.
            nodes: toCloneable(nodesRef.current, 'nodes'),
            edges: toCloneable(edgesRef.current, 'edges'),
          });
          if (result?.success) {
            // What the run learned about the node — a REST API source's columns
            // after its first approved fetch. Written onto the node like any
            // config change (so the nodes built after it can read them, and the
            // save keeps them).
            if (result.configPatch && typeof result.configPatch === 'object') {
              const patch = result.configPatch;
              const apply = (n) => ({ ...n, data: { ...n.data, config: { ...(n.data?.config || {}), ...patch } } });
              setNodes((prev) => prev.map((n) => (n.id === nodeId ? apply(n) : n)));
              setSelectedNode((prev) => (prev && prev.id === nodeId ? apply(prev) : prev));
              setHasUnsavedChanges(true);
            }
            // Before the refresh: the preview decides what it may query from
            // this flag, so it must be on the node when the refresh arrives.
            markNodesExecuted((n) => n.id === nodeId);
            if (handleDataPreviewRefresh) handleDataPreviewRefresh();
          }
          done(result || { success: false, message: 'No result returned.' });
        } catch (err) {
          done({ success: false, message: err.message || String(err) });
        }
      })();
    };
    window.addEventListener('ternlux:execute-node', handler);
    return () => window.removeEventListener('ternlux:execute-node', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkflowId]);

  // Update only the selectedNode for preview purposes (doesn't save to workflow)
  const onPreviewConfigUpdate = useCallback((nodeId, config) => {
    // console.log('onPreviewConfigUpdate: ', selectedNode, nodeId, config)
    if (selectedNode && selectedNode.id === nodeId) {
      setSelectedNode(prev => ({
        ...prev,
        data: {
          ...prev.data,
          config: {
            ...prev.data.config,
            ...config
          }
        }
      }));
    }
  }, [selectedNode]);

  // Refresh DataPreview (called after execution completes)
  const handleDataPreviewRefresh = useCallback(() => {
    setDataPreviewRefreshTrigger(prev => prev + 1);
  }, []);

  /**
   * Mirror the executor's record of what has run onto the editor's copy.
   *
   * A transformer/join/output names its output table the moment it is built, so
   * nothing in its config separates "this table exists" from "this table is
   * planned" — which is how the Data Preview came to query a table no run had
   * created yet. executeNode writes `executedNodes` to the saved workflow; the
   * editor keeps its own copy, and the preview reads THAT, so a run has to
   * update it too or the preview stays blocked until the workflow reloads.
   *
   * `matches(node)` picks the nodes the run covered: all of them after a full
   * run, one after a single-node run. Nothing is cleared here — a node whose
   * output has gone stale is a config-time concern (see markNodesPending), not
   * a run-time one. This does NOT set hasUnsavedChanges, and cannot: the map
   * lives beside the nodes rather than on them, and the dirty check compares
   * nodes and edges. That is exactly why it lives there — a flag on the node
   * made a run dirty the canvas and record a version holding only that flag.
   */
  const markNodesExecuted = useCallback((matches) => {
    setExecutedNodes((prev) => {
      let next = prev;
      for (const node of nodesRef.current || []) {
        if (!MATERIALIZING_NODE_TYPES.has(node.type)) continue;
        if (!matches(node) || prev[node.id] === true) continue;
        if (next === prev) next = { ...prev };
        next[node.id] = true;
      }
      return next;
    });
  }, []);

  // A REST API data source has no form fields beyond the connection — once it
  // is saved the request itself is described in the chat. Close the form (the
  // node panel and the assistant share the same corner, so the assistant is
  // hidden while it is open) and open the assistant, which picks this node up
  // through the ternlux:node-focus broadcast below.
  const handleRequestChatHandoff = useCallback((nodeId) => {
    setIsSidebarOpen(false);
    window.dispatchEvent(new CustomEvent('ternlux:open-chat', { detail: { nodeId } }));
  }, []);

  // Load database tables (called from DataSourceNodeChat)
  const loadDatabaseTables = useCallback(async (connection) => {
    try {
      console.log('connection: ', connection)
      // Store the connection for use in DataPreview
      setActiveConnection(connection);

      // Handle file-based connections (local DuckDB/SQLite files)
      if (connection.connectionType === 'file') {
        const filePath = connection.fileInfo?.filePath;
        if (!filePath) {
          console.error('File path not found in connection');
          return {
            success: false,
            tables: [],
            message: 'this connection has no file path recorded — it may have been saved before the file was chosen, or the record is incomplete',
          };
        }

        if (!window.electronAPI?.dbConnect) {
          console.error('Database API not available');
          return {
            success: false,
            tables: [],
            message: 'the database API is unavailable — local files can only be read in the desktop app',
          };
        }

        // Ask the CONNECTOR, exactly as the Data Explorer does.
        //
        // A file connection is one of two things, and only the connector can
        // tell them apart. An IMPORT — csv, a workbook's sheets, json —
        // records its tables when it is added, so listing them is a matter of
        // reading the record. A DATABASE the user picked — .duckdb, .sqlite,
        // .db — records nothing of the kind: its tables live in its own
        // catalog, and the only way to know them is to open it.
        //
        // This used to read `fileInfo.tables` and stop, which is right for the
        // first kind and silently empty for the second: a .duckdb holding
        // `earliest_transactions` reported no tables at all, while the Data
        // Explorer — which has always gone through the connector — listed it
        // correctly. Handing the connector the same config the explorer builds
        // makes both kinds work through one path.
        const fileConfig = {
          ...(connection.dbConfig || {}),
          dbPath: filePath,
          tables: connection.fileInfo?.tables || null,
          tablePaths: connection.fileInfo?.tablePaths || null,
          tableSheets: connection.fileInfo?.tableSheets || null,
          format: connection.fileInfo?.format || null,
        };

        const fileResult = await window.electronAPI.dbConnect.getTables(
          connection.dbType,
          fileConfig,
          connection.id
        );

        if (fileResult?.success) {
          const tableList = fileResult.tables || [];
          const tableObjects = tableList.map((t) => ({
            name: t.name || String(t),
            schema: t.schema || null,
          }));

          setDbTables(tableObjects);
          return { success: true, tables: tableList };
        }

        return {
          success: false,
          tables: [],
          message: fileResult?.message || `could not list the tables in ${filePath}`,
        };
      }

      // Handle database connections (remote databases)
      if (!window.electronAPI?.dbConnect) {
        console.error('Database API not available');
        return {
          success: false,
          tables: [],
          message: 'the database API is unavailable — direct connections only run in the desktop app',
        };
      }

      const result = await window.electronAPI.dbConnect.getTables(
        connection.dbType,
        connection.dbConfig,
        connection.id
      );

      if (result.success) {
        const tableList = result.tables || [];

        // Store full table objects with schema information
        const tableObjects = tableList.map(t => ({
          name: t.name || String(t),
          schema: t.schema || null
        }));

        setDbTables(tableObjects);
        return { success: true, tables: tableList };
      }

      // Carry the connector's reason back. Dropping it left the node panel with
      // nothing to show but an empty dropdown, which reads as "this database has
      // no tables" when the truth is "the list could not be read".
      return { success: false, tables: [], message: result.message || null };
    } catch (error) {
      console.error('Failed to load database tables:', error);
      return { success: false, tables: [], error: error.message };
    }
  }, []);

  const canNodeOpenSidebar = (node, allNodes, allEdges) => (
    hasRequiredInputs(node.type, allEdges.filter((edge) => edge.target === node.id).length)
  );

  const getNodeRequirementMessage = (node) => nodeRequirementMessage(node.type);

  const onCloseSidebar = () => {
    setIsSidebarOpen(false);
    setSelectedNode(null);
  };

  const validateWorkflow = () => {
    validationFailureRef.current = null;
    // Shown to the user, and kept for callers that report why (the save gate).
    const fail = (msg) => {
      message.error(msg);
      validationFailureRef.current = msg;
      return false;
    };
    if (!workflowName.trim()) {
      return fail('Please enter a workflow name');
    }

    if (nodes.length === 0) {
      return fail('Workflow must contain at least one node');
    }

    // Check if there's a start node
    const hasStart = nodes.some(node => node.type === 'start');
    if (!hasStart) {
      return fail('Workflow must contain a start node');
    }

    // Check if there's at least one data source node
    const hasDataSource = nodes.some(node => node.type === 'dataSource');
    if (!hasDataSource) {
      return fail('Workflow must contain at least one data source node');
    }

    // Check if start node is connected to at least one data source
    const startNode = nodes.find(node => node.type === 'start');
    if (startNode) {
      const startConnections = edges.filter(edge => edge.source === startNode.id);
      if (startConnections.length === 0) {
        return fail('Start node must be connected to at least one data source');
      }
      
      // Verify all connections from start are to data sources
      for (const connection of startConnections) {
        const connectedNode = nodes.find(node => node.id === connection.target);
        if (!connectedNode || connectedNode.type !== 'dataSource') {
          return fail('Start node can only connect to data source nodes');
        }
      }
    }

    // Check if all nodes are properly configured
    for (const node of nodes) {
      if (!canNodeOpenSidebar(node, nodes, edges)) {
        const label = nodeDisplayName(node.type, node.data || {}, node.data?.label || node.type);
        const reason = `${getNodeRequirementMessage(node)} ("${label}" is not wired to its input).`;
        return fail(reason);
      }
    }

    return true;
  };

  /**
   * The assistant's save gate.
   *
   * A build reads the workflow from the DATABASE, so canvas edits that were
   * never saved are invisible to it — the agent would plan against a workflow
   * the user is no longer looking at, and then overwrite their edits with the
   * result. Rather than guess, the build asks here first.
   *
   * Resolves { ok: true } when there is nothing uncommitted (the common case,
   * and no prompt is shown). Otherwise it answers { ok: false } AT ONCE and
   * opens the Execution Steps editor — the same route Execute takes — so the
   * user can save. Nothing reaches the builder until the workflow is saved,
   * and the chat is never left waiting on a dialog: it says what happened and
   * the user asks again (Retry) once the save is done.
   *
   * It used to hold the chat open until the dialog closed. That stalled the
   * assistant on "Workflow builder…" behind a modal it never mentioned, and a
   * successful save still reported "untouched": the steps editor calls onSave
   * and then onClose in the same tick, and the close settled the gate as
   * cancelled before the save had finished.
   */
  const requestSaveGate = useCallback(() => new Promise((resolve) => {
    // This canvas is a build in progress — very likely one opened by that
    // build itself. There are no user edits here to protect, and a build that
    // paused to ask a question asks the gate again on the way back in: stopping
    // it behind a save prompt would strand a half-built workflow that the user
    // has no way to finish. Let it through.
    if (buildInFlight) {
      resolve({ ok: true, reason: 'live-build' });
      return;
    }
    // Nothing but the seeded start node. This is the ordinary "build me a
    // workflow" starting point, not a workflow in its own right: there is no
    // work here to protect, and validateWorkflow could not commit it anyway
    // (it requires a data source node), so a save prompt would be a dead end
    // the user cannot get past. Typing a NAME on such a canvas counts as an
    // unsaved change, which is why this is checked before the dirty flags.
    const hasContent = nodes.some((n) => n.type !== 'start');
    if (!hasContent) {
      resolve({ ok: true, reason: 'empty-canvas' });
      return;
    }
    // Built here, but never saved. The builder reads and writes the DATABASE,
    // and this workflow has no row in it — so a build cannot modify it. It
    // would create a SEPARATE workflow and silently leave everything on this
    // canvas out. Naming and saving first is what makes the canvas the same
    // object the build is about to extend.
    const needsFirstSave = !currentWorkflowId;
    if (!needsFirstSave && !hasUnsavedChanges && !tempStateSave) {
      resolve({ ok: true, reason: 'clean' });
      return;
    }
    const name = (workflowName || '').trim() || null;
    if (!validateWorkflow()) {
      // The steps editor cannot commit, so don't open it. `detail` is what the
      // validator found, so the assistant can say it rather than guess.
      resolve({
        ok: false,
        reason: needsFirstSave ? 'unnamed-workflow' : 'invalid-workflow',
        detail: validationFailureRef.current,
      });
      return;
    }
    // No dialog: Save is one click on the toolbar, and the chat says so.
    message.info('Save the workflow, then press Retry in the chat.');
    resolve({ ok: false, reason: 'needs-save', workflowName: name });
  }), [buildInFlight, nodes, currentWorkflowId, hasUnsavedChanges, tempStateSave, validateWorkflow, workflowName]);

  // The assistant lives outside this tree entirely (App renders it beside
  // Workflows), so the gate is offered through a window event rather than
  // threaded down four components — the same bridge the Settings request uses.
  // When no editor is mounted nothing answers, and the caller proceeds: there
  // is no open canvas, so there is nothing unsaved to lose.
  // Read through a ref so the listener is registered ONCE. `requestSaveGate`
  // changes on every render that touches the canvas (it closes over the
  // unsaved flags), and re-binding a window listener on every node drag is
  // needless churn.
  const requestSaveGateRef = useRef(requestSaveGate);
  requestSaveGateRef.current = requestSaveGate;

  useEffect(() => {
    const handler = (e) => { e.detail?.respond?.(requestSaveGateRef.current()); };
    window.addEventListener('ternlux:workflow-save-gate', handler);
    return () => window.removeEventListener('ternlux:workflow-save-gate', handler);
  }, []);

  /**
   * Load a stored version onto the canvas.
   *
   * This does NOT write to the workflow record. The editor has exactly one path
   * that persists (Save), and routing a revert through it means the user can
   * look at the restored version, change their mind, and close without saving —
   * the same promise every other edit on this canvas makes. The save that
   * follows is recorded as the revert (see pendingHistoryMetaRef), so the
   * history keeps a forward-only record the way a revert commit does.
   */
  const handleRevertToVersion = useCallback(async (entry) => {
    const snapshot = entry?.snapshot;
    if (!snapshot) throw new Error('That version has no snapshot to restore');

    // The panels are open over nodes from the version being replaced.
    setSelectedNode(null);
    setIsSidebarOpen(false);
    setContextMenu(null);
    setContextMenuNode(null);

    setWorkflowName(snapshot.name || '');
    setWorkflowDescription(snapshot.description || '');
    setNodes(snapshot.nodes || []);
    setEdges(snapshot.edges || []);
    setExecutionSteps(sanitizeExecutionSteps(snapshot.executionSteps, snapshot.nodes || []));
    // The dirty-check effect recomputes this against initialWorkflowState on
    // the next render — including the case where the reverted-to version turns
    // out to be identical to what is already saved, which is not a change.
    setHasUnsavedChanges(true);

    pendingHistoryMetaRef.current = {
      source: 'revert',
      label: `Reverted to v${entry.version}`,
    };

    message.success(`Reverted to version ${entry.version} — review it, then Save to keep it.`);
  }, [setNodes, setEdges]);

  const handleSave = async (providedExecutionSteps = null) => {
    if (!validateWorkflow()) {
      return;
    }

    setSaving(true);
    try {
      // Extract final_dataset s3key from Data Export node's connected source
      const outputNode = nodes.find(node => node.type === 'output');
      let finalDatasetS3Key = null;

      if (outputNode) {
        // Find the edge that connects to the output node
        const outputConnection = edges.find(edge => edge.target === outputNode.id);
        if (outputConnection) {
          // Find the source node that connects to output
          const sourceNode = nodes.find(node => node.id === outputConnection.source);
          if (sourceNode && sourceNode.data?.config) {
            // Extract s3key based on source node type
            if (sourceNode.type === 'join') {
              finalDatasetS3Key = {...sourceNode.data.config, connectionName: sourceNode.id};
            } else if (sourceNode.type === 'transformer') {
              finalDatasetS3Key = {...sourceNode.data.config, connectionName: sourceNode.id};
            } else if (sourceNode.type === 'dataSource') {
              // For direct data source connections, use the connection's s3key
              finalDatasetS3Key = sourceNode.data.config;
            }
          }
        }
      }

      // Write each node's display name into its config before anything is
      // serialized. The canvas derives a name on the fly; the execution log
      // cannot — it is written in the main process from the SAVED workflow, so
      // a name that lives only in the renderer shows up there as "Transformer".
      const namedNodes = withPersistedNodeNames(nodes);
      if (namedNodes !== nodes) setNodes(namedNodes);

      // Use provided execution steps, stored execution steps, or auto-generate if none exist
      let finalExecutionSteps = providedExecutionSteps || executionSteps;
      if (!finalExecutionSteps.length && namedNodes.length > 0) {
        // Auto-generate execution steps using shared utility function
        finalExecutionSteps = generateStepsFromNodes(namedNodes, edges);
      }
      // What is written is `{ nodeId, order }` per live node — no step for a
      // node that is gone, and nothing copied off the node. See
      // sanitizeExecutionSteps.
      finalExecutionSteps = sanitizeExecutionSteps(finalExecutionSteps, namedNodes);

      const workflowData = {
        // Pin the id the editor has been scoping files under, so the first
        // save adopts it instead of minting a different one.
        id: currentWorkflowId || workflowScopeIdRef.current,
        name: workflowName,
        description: workflowDescription,
        nodes: toCloneable(namedNodes, 'nodes'),
        edges: toCloneable(edges, 'edges'),
        nodeCount: namedNodes.length,
        type: 'Custom',
        final_dataset: toCloneable(finalDatasetS3Key, 'final_dataset'),
        executionSteps: finalExecutionSteps || [],
        // Which nodes have run. Beside the nodes rather than on them, so the
        // dirty check and the version history — which read nodes and edges —
        // never see a run as an edit. See utils/executedNodes.js.
        executedNodes: prunedExecutedNodes(executedNodes, namedNodes),
        // How the version history should label what this save produced. Stripped
        // off before the document is stored (see WorkflowsTab.saveWorkflowData).
        ...(pendingHistoryMetaRef.current ? {
          __historySource: pendingHistoryMetaRef.current.source,
          __historyLabel: pendingHistoryMetaRef.current.label,
        } : {}),
      };

      // Let the parent component handle the API call to avoid duplication
      await onSave(workflowData);
      pendingHistoryMetaRef.current = null;

      // Update initial state to current state after successful save
      setInitialWorkflowState({
        name: workflowName,
        description: workflowDescription,
        nodes: namedNodes,
        edges
      });
      setHasUnsavedChanges(false);

    } catch (error) {
      console.error('Error saving workflow:', error);

      // Handle authentication errors
      if (error.response?.status === 401 || error.response?.status === 204 ||
          (error.response?.status === 400)) {
        localStorage.removeItem('auth-token');
        message.error('Session expired. Please log in again.');
        window.location.href = '/login';
        return;
      }

      message.error('Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  // Auto-save with debouncing to avoid excessive API calls.
  // `explicit` = true → a committed save (Save button, after verifying steps):
  //   clears the temp-state flag. `explicit` = false → a background temp save
  //   (marks the record tempStateSave: true). Returns true on success so
  //   callers can perform a deferred action (close/execute) only if it saved.
  const autoSave = useCallback(async ({ explicit = false, executionStepsOverride = null, outputValidation = null } = {}) => {
    if (saving) {
      // Don't auto-save if already saving
      return false;
    }

    if (!workflowName.trim()) {
      // Don't auto-save if workflow doesn't have a name
      message.warning('Cannot save: Please enter a workflow name');
      return false;
    }

    // Custom validation for auto-save with error messages
    if (nodes.length === 0) {
      message.warning('Cannot save: Workflow must have at least one node');
      return false;
    }

    // Check if there's a start node
    const hasStart = nodes.some(node => node.type === 'start');
    if (!hasStart) {
      message.warning('Cannot save: Workflow must have a Start node');
      return false;
    }

    // Check if there's at least one data source node
    const hasDataSource = nodes.some(node => node.type === 'dataSource');
    if (!hasDataSource) {
      message.warning('Cannot save: Workflow must have at least one Data Source node');
      return false;
    }

    // Check if start node is connected to at least one data source
    const startNode = nodes.find(node => node.type === 'start');
    if (startNode) {
      const startConnections = edges.filter(edge => edge.source === startNode.id);
      if (startConnections.length === 0) {
        message.warning('Cannot save: Start node must be connected to at least one Data Source');
        return false;
      }
    }


    
    setSaving(true);
    try {
      // Extract final_dataset from Data Export node's connected source
      const outputNodeForSave = nodes.find(node => node.type === 'output');
      let finalDatasetS3Key = null;
      if (outputNodeForSave) {
        const outputConnection = edges.find(edge => edge.target === outputNodeForSave.id);
        if (outputConnection) {
          const sourceNode = nodes.find(node => node.id === outputConnection.source);
          if (sourceNode?.data?.config) {
            if (sourceNode.type === 'join' || sourceNode.type === 'transformer') {
              finalDatasetS3Key = { ...sourceNode.data.config, connectionName: sourceNode.id };
            } else if (sourceNode.type === 'dataSource') {
              finalDatasetS3Key = sourceNode.data.config;
            }
          }
        }
      }

      // Names are persisted on every save, background ones included — see
      // handleSave. An auto-save is what most runs read from.
      const namedNodes = withPersistedNodeNames(nodes);
      if (namedNodes !== nodes) setNodes(namedNodes);

      let finalExecutionSteps = executionStepsOverride || executionSteps;
      if (!finalExecutionSteps.length && namedNodes.length > 0) {
        finalExecutionSteps = generateStepsFromNodes(namedNodes, edges);
      }
      // Same rule as handleSave: `{ nodeId, order }` per live node, and a
      // deleted node leaves no step behind.
      finalExecutionSteps = sanitizeExecutionSteps(finalExecutionSteps, namedNodes);

      const workflowData = {
        // Pin the id the editor has been scoping files under, so the first
        // save adopts it instead of minting a different one.
        id: currentWorkflowId || workflowScopeIdRef.current,
        name: workflowName,
        description: workflowDescription,
        nodes: toCloneable(namedNodes, 'nodes'),
        edges: toCloneable(edges, 'edges'),
        nodeCount: namedNodes.length,
        type: 'Custom',
        final_dataset: toCloneable(finalDatasetS3Key, 'final_dataset'),
        executionSteps: finalExecutionSteps || [],
        // Which nodes have run. Beside the nodes rather than on them, so the
        // dirty check and the version history — which read nodes and edges —
        // never see a run as an edit. See utils/executedNodes.js.
        executedNodes: prunedExecutedNodes(executedNodes, namedNodes),
        // A background auto-save is a temporary, unverified snapshot; an
        // explicit Save (after the user verifies Execution Steps) commits it.
        tempStateSave: !explicit,
        // Output-validation toggle/function from the steps editor. Only included
        // when set so the DB $set merge leaves any existing field alone otherwise.
        ...(outputValidation ? { outputValidation } : {}),
        // How the version history should label what this save produced. Stripped
        // off before the document is stored (see WorkflowsTab.saveWorkflowData).
        ...(pendingHistoryMetaRef.current ? {
          __historySource: pendingHistoryMetaRef.current.source,
          __historyLabel: pendingHistoryMetaRef.current.label,
        } : {}),
      };

      // Arm the reload guard BEFORE the save writes any code files. onAutoSave
      // rewrites this workflow's externalized code on disk, which the watcher
      // sees; arming here (not just after) guarantees the guard is already in
      // place when chokidar emits, so a slow save can't lose the race and bounce
      // the canvas.
      reloadGuardRef.current.suppressUntil = Date.now() + 3000;
      const savedId = await onAutoSave(workflowData, currentWorkflowId);
      pendingHistoryMetaRef.current = null;
      if (savedId && !currentWorkflowId) {
        setCurrentWorkflowId(savedId);
      }

      if (executionStepsOverride) setExecutionSteps(finalExecutionSteps);
      setInitialWorkflowState({ name: workflowName, description: workflowDescription, nodes: namedNodes, edges });
      setHasUnsavedChanges(false);
      setTempStateSave(!explicit);
      if (explicit) message.success('Workflow saved');
      // Re-extend the guard past the save's own writes (chokidar's
      // awaitWriteFinish delays emission ~500ms after the last write settles).
      reloadGuardRef.current.suppressUntil = Date.now() + 3000;
      return true;
    } catch (error) {
      console.error('Auto-save failed:', error, );
      if (error.message === 'Duplicate workflow name') {
        // message already shown by WorkflowsTab
      } else if (error.response?.status === 404) {
        message.error('Cannot save: Workflow not found. It may have been deleted.');
        setCurrentWorkflowId(null);
      } else if (error.response) {
        message.error(`Cannot save: ${error.response?.data?.error || error.message || 'Unknown error'}`);
      } else if (error.message === 'Network Error') {
        message.error('Cannot save: Network error. Please check your connection.');
      } else {
        // Local failure (e.g. serialization / IPC error) — surface the real
        // message instead of blaming the network for a local operation.
        message.error(`Cannot save: ${error.message || 'Unknown error'}`);
      }
      setHasUnsavedChanges(false);
      return false;
    } finally {
      setSaving(false);
    }
  }, [workflowName, nodes, edges, executionSteps, workflowDescription, currentWorkflowId, saving, onAutoSave, executedNodes, outputValidation]);

  // Debounced auto-save (2 seconds delay)
  // Use ref to store the latest autoSave function
  const autoSaveRef = useRef(autoSave);

  useEffect(() => {
    autoSaveRef.current = autoSave;
  }, [autoSave]);

  // Create a stable debounced function that always calls the latest autoSave.
  //
  // AUTO-SAVE DISABLED: background auto-save is commented out so that nothing is
  // persisted until the user explicitly clicks Save. Previously a background
  // auto-save wrote changes to the workflow record, which meant "Don't save" in
  // the unsaved-changes prompt could not truly discard — the state had already
  // been persisted. With auto-save off, "Don't save" really discards, and the
  // only path that writes to the DB is the explicit Save (which calls
  // autoSave({ explicit: true }) directly after the user verifies the steps).
  //
  // The debounce wrapper is kept (as a no-op) so the effects below can still
  // call debouncedAutoSave() / .cancel() without breaking. To re-enable
  // auto-save, restore the `autoSaveRef.current();` call below.
  const debouncedAutoSave = useRef(
    debounce(() => {
      // autoSaveRef.current();  // ← re-enable to turn background auto-save back on
    }, 2000)
  ).current;

  // Auto-save when nodes array size changes (nodes added/deleted)
  useEffect(() => {
    if (initialWorkflowState && workflowName.trim()) {
      const currentNodeCount = nodes.length;
      const initialNodeCount = initialWorkflowState.nodes.length;

      if (currentNodeCount !== initialNodeCount) {
        debouncedAutoSave.cancel();
        debouncedAutoSave();
      }
    }
  }, [nodes.length, initialWorkflowState, workflowName]);

  // Auto-save when edges are modified
  useEffect(() => {
    if (initialWorkflowState && workflowName.trim()) {
      const currentEdges = JSON.stringify(edges);
      const initialEdges = JSON.stringify(initialWorkflowState.edges);

      if (currentEdges !== initialEdges) {
        debouncedAutoSave.cancel();
        debouncedAutoSave();
      }
    }
  }, [edges, initialWorkflowState, workflowName]);

  // Auto-save when workflow name or description changes
  useEffect(() => {
    if (initialWorkflowState && workflowName.trim()) {
      const hasNameDescChange = (
        workflowName !== initialWorkflowState.name ||
        workflowDescription !== initialWorkflowState.description
      );

      if (hasNameDescChange) {
        debouncedAutoSave.cancel();
        debouncedAutoSave();
      }
    }
  }, [workflowName, workflowDescription, initialWorkflowState]);

  // Auto-save when sidebar trigger is set
  useEffect(() => {
    if (triggerSidebarSave && workflowName.trim()) {
      setTriggerSidebarSave(false); // Reset the trigger
      debouncedAutoSave.cancel();
      debouncedAutoSave();
    }
  }, [triggerSidebarSave, workflowName]);

  // Cancelling drops the whole batch: this file isn't saved and the queued ones
  // never open. Matches the Connections tab, where ✕ / Cancel exits the
  // multi-file flow rather than advancing through it.
  const handleUploadCancel = () => {
    importCancelledRef.current = true; // stop any in-flight import from advancing
    setActiveFileType(null);
    setDroppedFile(null);
    setFileQueue([]);
    dropOriginRef.current = null;
    dropIndexRef.current = 0;
  };

  // Place a node for a freshly imported file near where the batch was dropped,
  // fanning consecutive files out diagonally so they stay individually clickable.
  const droppedNodePosition = () => {
    const origin = dropOriginRef.current || { x: 100, y: 100 };
    const step = dropIndexRef.current * DROP_STACK_OFFSET;
    dropIndexRef.current += 1;
    return { x: origin.x + step, y: origin.y + step };
  };

  const handleSaveDroppedConnection = async (connectionData) => {
    // The user hit ✕/Cancel while this file's import was still running — abort
    // the whole flow: don't save this connection and don't open the next file.
    // handleUploadCancel already cleared the state; the flag is reset by
    // processNextFile when the next drop opens a popup.
    if (importCancelledRef.current) return;

    // Persist the local file connection (same path ConnectionsTab uses for file
    // connections) so we get a connection with an id to reference from the node.
    let saved;
    try {
      saved = await connectionsDb.save(connectionData);
    } catch (error) {
      console.error('Error saving dropped data source:', error);
      message.error('Failed to create data source.');
      return; // leave the popup open so the user can retry or cancel
    }

    message.success(`Data source "${saved.name}" created.`);

    // Add a data source node for it, wired to the start node the same way a
    // node dragged from the palette is.
    const newNode = {
      id: `dataSource-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'dataSource',
      position: droppedNodePosition(),
      data: {
        label: 'Data Source',
        config: {
          connectionId: saved.id,
          connectionName: saved.name,
        },
      },
    };
    const startNode = nodesRef.current.find(node => node.type === 'start' && node.id === 'start-node');
    if (startNode) {
      setNodes((nds) => nds.concat(newNode));
      setEdges((eds) => [...eds, {
        id: `edge-${startNode.id}-${newNode.id}`,
        source: startNode.id,
        target: newNode.id,
        type: 'default',
      }]);
    } else {
      setNodes((nds) => nds.concat(newNode));
    }

    // Advance to the next dropped file (if any); otherwise this closes the popup.
    processNextFile(fileQueue);
  };

  const handleOpenStepsEditor = () => {
    setIsStepsEditorOpen(true);
  };

  /**
   * The one-click save behind every Save button: the toolbar, the
   * unsaved-changes prompt, and anything else that commits the canvas. The run
   * order is the saved one with any new nodes placed by the graph — the same
   * order the Edit Steps editor would open on — so saving never needs that
   * editor; reordering is its own action. Resolves true when the save landed.
   */
  const commitSave = async () => {
    if (!validateWorkflow()) return false;
    let steps = null;
    try {
      steps = resolveExecutionSteps(executionSteps, nodes, edges)
        .map((st, i) => ({ nodeId: st.nodeId, order: i }));
    } catch (_) { /* autoSave derives an order when none is given */ }
    if (steps) setExecutionSteps(steps);
    const priorFn = outputValidation?.validationFunction || null;
    const ok = await autoSave({ explicit: true, executionStepsOverride: steps });
    if (ok && steps) maybeOfferRevalidation(outputValidation, steps, priorFn);
    return ok;
  };

  const handleSaveWorkflow = () => {
    // The builder saves the workflow itself when it finishes. Saving now would
    // commit whatever half of it has reached the canvas — for a workflow being
    // built from scratch, an empty one.
    if (buildInFlight) {
      message.warning('The assistant is still building this workflow — it saves itself when it finishes.');
      return;
    }
    // The Save button is always clickable (never silently disabled). Give clear
    // feedback instead of a dead "not-allowed" cursor.
    if (saving) {
      message.warning('A save is already in progress. Please wait…');
      return;
    }
    // validateWorkflow (inside commitSave) shows a specific message, e.g.
    // "Please enter a workflow name" — nothing more to do on a refusal.
    commitSave();
  };

  const handleExportJSON = () => {
    const workflowData = {
      name: workflowName,
      description: workflowDescription,
      nodes,
      edges,
      nodeCount: nodes.length,
      type: 'Custom',
      // The export is a picture of the workflow as it stands: the run order of
      // the nodes above, with no steps left over from deleted ones.
      executionSteps: sanitizeExecutionSteps(executionSteps, nodes),
      exportedAt: new Date().toISOString(),
    };

    const safeName = (workflowName || 'workflow').replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
    const blob = new Blob([JSON.stringify(workflowData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    message.success('Workflow exported as JSON');
  };

  const handleStepsEditorClose = () => {
    setIsStepsEditorOpen(false);
  };

  // Lightweight goal-drift check after an explicit save. Only fires when the
  // saved validation function is the SAME one that came in (user didn't
  // regenerate). One cheap AI call (skipped in the backend when structure is
  // unchanged); on drift, offers to regenerate against the just-saved workflow.
  //
  // `priorFn` is the function as it stood BEFORE this save — the caller reads it
  // off the live state before replacing it. It used to come from the `workflow`
  // prop, which is frozen at the moment the editor opened, so after one save
  // every later save compared against the wrong function.
  const maybeOfferRevalidation = async (savedValidation, savedExecutionSteps, priorFn) => {
    try {
      const savedFn = savedValidation?.validationFunction || null;
      if (!savedValidation?.enabled || !savedFn || savedFn !== priorFn) return;

      const wfId = currentWorkflowId || workflowScopeIdRef.current;
      const savedWorkflow = toCloneable({
        id: wfId,
        nodes,
        edges,
        executionSteps: savedExecutionSteps,
        outputValidation: savedValidation,
      }, 'driftCheck');
      const drift = await window.electronAPI.workflow.checkValidationDrift({ workflow: savedWorkflow });
      if (!drift?.drifted) return;

      Modal.confirm({
        title: 'Validation may be out of date',
        content: drift.reason || 'This workflow changed since its output-validation function was written. Regenerate it to match the current pipeline?',
        okText: 'Regenerate',
        cancelText: 'Keep current',
        onOk: async () => {
          const res = await window.electronAPI.workflow.generateValidation({ workflowId: wfId });
          if (res?.success) message.success('Validation regenerated');
          else message.error(res?.message || 'Failed to regenerate validation');
        },
      });
    } catch (_) {
      // Drift check is best-effort — never block the save on it.
    }
  };

  const handleStepsEditorSave = async (savedExecutionSteps, opts = {}) => {
    // Update the workflow state to include execution steps. This state — not the
    // `workflow` prop — is what the steps editor is seeded from next time it
    // opens, which is why an order saved here survives a reopen without a round
    // trip through the database.
    setExecutionSteps(savedExecutionSteps);
    const savedValidation = opts.outputValidation || null;
    // Read before the state is replaced below: the drift check asks whether the
    // saved function is the one the user came in with.
    const priorValidationFn = outputValidation?.validationFunction || null;
    if (savedValidation) setOutputValidation(savedValidation);

    console.log('Execution steps saved to workflow state:', savedExecutionSteps);

    // "Save Steps" commits — the same one-click save as the toolbar's Save,
    // with the order and validation the user just set. Nothing else opens this
    // editor as a step of saving any more.
    setIsStepsEditorOpen(false);
    if (!validateWorkflow()) {
      // Not savable yet (e.g. no name): keep the steps in state for the next save.
      setHasUnsavedChanges(true);
      return;
    }
    const ok = await autoSave({
      explicit: true,
      executionStepsOverride: savedExecutionSteps,
      outputValidation: savedValidation,
    });
    if (!ok) return;
    // Goal-drift check: if we just saved a PRE-EXISTING validation function the
    // user did not regenerate, verify it still fits the (possibly edited)
    // workflow and offer to regenerate. Non-blocking.
    maybeOfferRevalidation(savedValidation, savedExecutionSteps, priorValidationFn);
  };

  /**
   * Execute button entry point. Gate on uncommitted changes first: if there are
   * unsaved edits or an uncommitted temp save, prompt the user to save (verify
   * Execution Steps) before running, so a run never executes unverified state.
   */
  const handleExecuteWorkflow = async () => {
    if (buildInFlight) {
      message.warning('The assistant is still building this workflow — wait for it to finish before running it.');
      return;
    }
    if (!nodes || nodes.length === 0) {
      message.warning('No nodes to execute');
      return;
    }
    if (hasUnsavedChanges || tempStateSave) {
      setUnsavedPrompt({ open: true, intent: 'execute' });
      return;
    }
    startExecution();
  };

  /**
   * Execute the entire workflow (no save-gate — call only after the gate).
   * Iterates through nodes in order and executes each one.
   */
  /**
   * The last stop before a run: a join whose kept target has to be dropped and
   * recreated (joinSettings.targetRebuild, not already approved at build time)
   * needs a yes first. Nothing is asked when there is none.
   */
  const startExecution = () => {
    const items = (nodesRef.current || nodes || [])
      .filter((n) => n.type === 'join')
      .map((n) => ({ node: n, rb: n.data?.config?.joinSettings?.targetRebuild }))
      .filter(({ rb }) => rb?.pending && !(rb.approvedFingerprint && rb.approvedFingerprint === rb.ddlFingerprint))
      .map(({ node, rb }) => ({
        nodeId: node.id,
        label: node.data?.label || node.data?.config?.targetTableName || node.id,
        table: rb.table,
        rowCount: rb.rowCount,
        reason: rb.reason,
        warning: targetIsSourceWarning(rb),
      }));
    if (items.length) {
      setRebuildPrompt({ open: true, items });
      return;
    }
    doExecuteWorkflow();
  };

  const doExecuteWorkflow = async ({ approvedRebuilds = [] } = {}) => {
    if (!nodes || nodes.length === 0) {
      message.warning('No nodes to execute');
      return;
    }

    if (!window.electronAPI?.workflow?.executeWorkflow) {
      message.error('Workflow execution not available');
      return;
    }

    setIsExecuting(true);

    try {
      // Use stored execution steps or auto-generate if none exist
      let finalExecutionSteps = executionSteps;
      if (!finalExecutionSteps || finalExecutionSteps.length === 0) {
        finalExecutionSteps = generateStepsFromNodes(nodes, edges);
      }
      // A step for a deleted node has no node to run and would only pad the
      // run's step count; the config snapshot is not what the executor runs.
      finalExecutionSteps = sanitizeExecutionSteps(finalExecutionSteps, nodesRef.current || nodes);

      // Send notification that workflow is running
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Ternlux', {
          body: `Workflow "${workflowName || 'Untitled Workflow'}" is now running...`,
          // icon: '/image/ternlux.png'
        });
      } else if (window.Notification && Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification('Ternlux', {
              body: `Workflow "${workflowName || 'Untitled Workflow'}" is now running...`,
              // icon: '/image/ternlux.png'
            });
          }
        });
      }

      // executeWorkflow only resolves once the whole run is over, so the live
      // canvas rings and the execution monitor come from polling the execution
      // record. Kick the poller now so the first node lights up immediately
      // rather than at the next tick.
      setTimeout(refreshExecutions, 150);

      // Start execution. Strip non-structured-cloneable values (Arrow Vectors,
      // functions, circular refs) first — the same sanitization the save path
      // uses. Without this, executing a saved multi-node workflow fails at the
      // IPC boundary with "An object could not be cloned".
      const result = await window.electronAPI.workflow.executeWorkflow({
        // The scope id, not currentWorkflowId: that state is still null on the
        // render that ran the save gate (setCurrentWorkflowId hasn't committed
        // yet when handleStepsEditorSave calls straight through to here), and a
        // run without a workflow id has no DuckDB database to write into.
        // workflowScopeIdRef holds the id the first save adopts, so both agree.
        workflowId: currentWorkflowId || workflowScopeIdRef.current,
        workflowName: workflowName || 'Untitled Workflow',
        // Named here as well: a run can start from edits that were never
        // saved, and the log is written from exactly what we send.
        //
        // Read from the REFS, not the closure — same reason the single-node run
        // does (see executeNode above). Execute gates on unsaved changes and
        // hands off to the prompt, so by the time this runs the render it was
        // defined in can be several state updates old: a config the chat
        // builder applied in between is on the canvas but not in `nodes` here.
        // That is how a rebuilt transformer ran its PREVIOUS targetSql — new
        // targetDdl, stale SELECT — against the new connection.
        nodes: toCloneable(withPersistedNodeNames(nodesRef.current), 'nodes'),
        edges: toCloneable(edgesRef.current, 'edges'),
        executionSteps: toCloneable(finalExecutionSteps, 'executionSteps'),
        // Joins whose target the user just approved dropping and recreating.
        approvedRebuilds,
      });

      // What the run learned about its nodes (a join whose target was
      // recreated stops asking) — written onto the canvas like a single-node
      // run's configPatch.
      const patches = result?.configPatches && typeof result.configPatches === 'object' ? result.configPatches : null;
      if (patches && Object.keys(patches).length) {
        const apply = (n) => (patches[n.id]
          ? { ...n, data: { ...n.data, config: { ...(n.data?.config || {}), ...patches[n.id] } } }
          : n);
        setNodes((prev) => prev.map(apply));
        setSelectedNode((prev) => (prev ? apply(prev) : prev));
        setHasUnsavedChanges(true);
      }

      if (result.success) {
        message.success(`Workflow executed successfully! Execution ID: ${result.executionId}`);

        // The run went through every step, so every node that writes an output
        // now has one. Mirror the flag the executor wrote to the saved workflow
        // onto the canvas, which is what the Data Preview reads.
        markNodesExecuted(() => true);

        // Send success notification
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('Ternlux - Workflow Completed', {
            body: `Workflow "${workflowName || 'Untitled Workflow'}" executed successfully!`,
            // icon: '/image/ternlux.png'
          });
        }

        // Refresh data preview if available
        if (handleDataPreviewRefresh) {
          handleDataPreviewRefresh();
        }
      } else if (result.cancelled) {
        // The user pressed stop in the execution monitor. Nothing broke, so
        // this must not be reported as a failure — the nodes that did run
        // wrote their outputs, and the ones after them never started.
        message.warning(result.message || 'Workflow run stopped.');

        if (window.Notification && Notification.permission === 'granted') {
          new Notification('Ternlux - Workflow Stopped', {
            body: `Workflow "${workflowName || 'Untitled Workflow'}" was stopped. ${result.message || ''}`.trim(),
          });
        }

        if (handleDataPreviewRefresh) {
          handleDataPreviewRefresh();
        }
      } else {
        message.error(`Workflow execution failed: ${result.message || 'Unknown error'}`);

        // Send failure notification
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('Ternlux - Workflow Failed', {
            body: `Workflow "${workflowName || 'Untitled Workflow'}" failed: ${result.message || 'Unknown error'}`,
            // icon: '/image/ternlux.png'
          });
        }
      }
    } catch (error) {
      console.error('Execute workflow error:', error);
      message.error(`Execution error: ${error.message}`);

      // Send error notification
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Ternlux - Workflow Error', {
          body: `Workflow "${workflowName || 'Untitled Workflow'}" encountered an error: ${error.message}`,
          // icon: '/image/ternlux.png'
        });
      }
    } finally {
      setIsExecuting(false);
    }
  };

  // ── Unsaved-changes prompt (Save / Don't save / Cancel) ──────────────────
  // Shown from Execute and Close when there are uncommitted changes.

  // Saves (one click — see commitSave), then runs the deferred action.
  const handlePromptSave = async () => {
    const intent = unsavedPrompt.intent;
    setUnsavedPrompt({ open: false, intent: null });
    if (saving) {
      message.warning('A save is already in progress. Please wait…');
      return;
    }
    // e.g. missing name — validateWorkflow says so; the user fixes it and retries.
    const ok = await commitSave();
    if (!ok) return;

    if (intent === 'close') {
      onCancel();
    } else if (intent === 'execute') {
      startExecution();
    }
  };

  const handlePromptDontSave = () => {
    const intent = unsavedPrompt.intent;
    setUnsavedPrompt({ open: false, intent: null });
    if (intent === 'close') {
      onCancel();
    } else if (intent === 'execute') {
      startExecution();
    }
  };

  const handlePromptCancel = () => {
    setUnsavedPrompt({ open: false, intent: null });
  };

  if (editorLoading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="Loading workflow..." />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: "'Inter',-apple-system,sans-serif" }}>
      {/* Header. The modal's own close button is turned off (closable={false}
          in WorkflowsTab) so the ✕ can live here, aligned with the other
          actions and inside the same padding as the name and description. */}
      <div style={{
        padding: '12px 20px',
        borderBottom: '1px solid #e2e6eb',
        background: '#fff',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Borderless inputs are pulled left by their own padding so the text
              lines up with the header's edge, and get it back on hover/focus
              so they still read as editable fields. */}
          <Input
            placeholder="Enter workflow name"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            className="workflow-title-input"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: '#111827',
              padding: '2px 6px',
              marginLeft: -6,
              letterSpacing: '-0.02em',
              borderRadius: 4,
            }}
            bordered={false}
          />
          <Input.TextArea
            placeholder="Enter workflow description"
            value={workflowDescription}
            onChange={(e) => setWorkflowDescription(e.target.value)}
            autoSize={{ minRows: 1, maxRows: 2 }}
            className="workflow-title-input"
            style={{
              fontSize: 12,
              lineHeight: 1.45,
              padding: '2px 6px',
              marginLeft: -6,
              marginTop: 2,
              color: '#5a6678',
              resize: 'none',
              borderRadius: 4,
            }}
            bordered={false}
          />
        </div>
        <Space size={6}>
          {runningExecution && (
            <span
              title={`Execution ${runningExecution.executionId} is running`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 4,
                background: 'rgba(37,99,235,0.16)', border: '1px solid rgba(37,99,235,0.4)',
                color: '#1d4ed8', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              }}
            >
              <Spin size="small" /> Running…
            </span>
          )}
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleExecuteWorkflow}
            disabled={!nodes || nodes.length === 0 || isExecuting || !!runningExecution}
            loading={isExecuting || !!runningExecution}
            title="Execute workflow"
            size="small"
            style={{
              borderRadius: 4,
              background: '#2563eb',
              borderColor: '#2563eb',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Execute
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSaveWorkflow}
            loading={saving}
            title="Save workflow"
            size="small"
            className="workflow-save-button"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Dropdown
            overlay={
              <Menu>
                <Menu.Item
                  key="edit-steps"
                  icon={<SettingOutlined />}
                  disabled={!nodes || nodes.length === 0}
                  onClick={handleOpenStepsEditor}
                >
                  Edit Steps
                </Menu.Item>
                <Menu.Item
                  key="export-json"
                  icon={<ExportOutlined />}
                  disabled={!nodes || nodes.length === 0}
                  onClick={handleExportJSON}
                >
                  Export Workflow
                </Menu.Item>
                {/* Only a saved workflow has versions — history is recorded on
                    save, so an unsaved canvas has nothing to show. */}
                <Menu.Item
                  key="history"
                  icon={<HistoryOutlined />}
                  disabled={!currentWorkflowId}
                  onClick={() => setIsHistoryOpen(true)}
                >
                  History
                </Menu.Item>
              </Menu>
            }
            trigger={['click']}
            placement="bottomRight"
          >
            <Button
              size="small"
              icon={<MoreOutlined />}
              style={{ borderRadius: 4, borderColor: '#e2e6eb', color: '#5a6678' }}
            />
          </Dropdown>
          {saving && (
            <span style={{ color: '#2563eb', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
              Auto-saving…
            </span>
          )}
          {/* Separated from the actions so it never reads as one of them —
              it still routes through handleCancel, so unsaved work prompts. */}
          <span style={{ width: 1, height: 20, background: '#e2e6eb', margin: '0 4px' }} />
          <Button
            size="small"
            icon={<CloseOutlined />}
            onClick={handleCancel}
            title="Close workflow"
            aria-label="Close workflow"
            style={{ borderRadius: 4, borderColor: '#e2e6eb', color: '#5a6678' }}
          />
        </Space>
      </div>

      {/* Workflow Editor */}
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlowProvider>
          <div className="react-flow-wrapper" ref={reactFlowWrapper} style={{ height: '100%' }}>
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={setReactFlowInstance}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onPaneClick={handlePaneClick}
              nodeTypes={nodeTypes}
              fitView
              attributionPosition="top-right"
            >
              <Controls />
              <MiniMap
                style={{
                  background: 'rgba(255,255,255,0.92)',
                  border: '1px solid #e2e6eb',
                  borderRadius: 5,
                }}
                maskColor="rgba(247,249,252,0.6)"
                nodeColor={(n) => {
                  const map = {
                    start: '#2563eb',
                    dataSource: '#0891b2',
                    transformer: '#7c3aed',
                    join: '#d97706',
                    branch: '#059669',
                    output: '#db2777',
                  };
                  return map[n.type] || '#cdd2db';
                }}
              />
              <Background variant="dots" gap={16} size={1.4} color="#cdd2db" />

              {/* Node Types Panel */}
              <Panel position="top-right">
                <NodeTypePanel />
              </Panel>

              {/* Workflow Info */}
              <Panel position="top-left">
                <div className="workflow-toolbar">
                  {displayNodes.length} nodes · {displayEdges.length} connections
                </div>
                {liveBuild && (
                  <div className={`wf-build-banner wf-build-banner--${liveBuild.phase}`}>
                    <span className="wf-build-dot" />
                    {buildBannerText(liveBuild, buildingLabel)}
                  </div>
                )}
              </Panel>
            </ReactFlow>
          </div>
        </ReactFlowProvider>

        {/* Context Menu */}
        {contextMenu && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              zIndex: 10000,
              backgroundColor: '#fff',
              border: '1px solid #e2e6eb',
              borderRadius: 6,
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              minWidth: 150,
              overflow: 'hidden',
              fontFamily: "'Inter',-apple-system,sans-serif",
            }}
          >
            <div
              onClick={handleEditNode}
              style={{
                padding: '7px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: '#111827',
                transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f7f9fc'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <EditOutlined style={{ fontSize: 12, color: '#2563eb' }} />
              <span>Edit</span>
            </div>
            <div
              onClick={handleDeleteNode}
              style={{
                padding: '7px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#fef2f2'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <DeleteOutlined style={{ fontSize: 12, color: '#dc2626' }} />
              <span style={{ color: '#dc2626' }}>Delete</span>
            </div>
          </div>
        )}

        {/* Node Configuration Chat Panel */}
        <NodeChatPanel
          isOpen={isSidebarOpen}
          node={selectedNode}
          nodes={nodes}
          edges={edges}
          currentWorkflowId={currentWorkflowId}
          workflowScopeId={workflowScopeIdRef.current}
          onClose={onCloseSidebar}
          onConfigUpdate={onNodeConfigUpdate}
          onPreviewConfigUpdate={onPreviewConfigUpdate}
          onLoadDatabaseTables={loadDatabaseTables}
          onDataPreviewRefresh={handleDataPreviewRefresh}
          onRequestChatHandoff={handleRequestChatHandoff}
        />

        {/* Data Preview Component */}
        <DataPreview
          selectedNode={selectedNode}
          nodes={nodes}
          edges={edges}
          executedNodes={executedNodes}
          isNodeSidebarOpen={isSidebarOpen}
          onNodeUpdate={onNodeConfigUpdate}
          dbTables={dbTables}
          activeConnection={activeConnection}
          refreshTrigger={dataPreviewRefreshTrigger}
          onClose={() => { setSelectedNode(null); setIsSidebarOpen(false); }}
        />

        {/* File Drop Overlay */}
        {isDragOver && <FileDropOverlay title="Drop a file to add a data source" />}
      </div>

      {/* Dropped-file import — same form, titles and one-popup-per-file flow as
          the Connections tab, opened for the type the dropped file actually is. */}
      {activeFileType && (
        <Modal
          // Remount the form per dropped file so its name/state resets cleanly
          // between consecutive uploads of the same file type.
          key={droppedFile ? `${droppedFile.name}-${droppedFile.lastModified}` : activeFileType}
          title={LOCAL_FILE_MODAL_TITLES[activeFileType] || 'Create Data Source from File'}
          open
          onCancel={handleUploadCancel}
          footer={null}
          width={640}
          destroyOnClose
        >
          <LocalFileConnectionForm
            fileType={activeFileType}
            initialFile={droppedFile}
            onSave={handleSaveDroppedConnection}
            onCancel={handleUploadCancel}
          />
        </Modal>
      )}

      {/* Workflow Steps Editor */}
      {/* Everything here is the editor's LIVE state. The `workflow` prop is the
          record as it was when the editor opened and is never refreshed, so
          seeding this dialog from it showed the order (and the validation) from
          before the last save — reopening the workflow was the only way to see
          what had actually been saved. */}
      <WorkflowStepsEditor
        open={isStepsEditorOpen}
        onClose={handleStepsEditorClose}
        onSave={handleStepsEditorSave}
        executionSteps={executionSteps}
        outputValidation={outputValidation}
        workflowId={currentWorkflowId}
        workflowName={workflowName}
        nodes={nodes}
        edges={edges}
      />

      {/* Version history — every recorded save, with a before/after of the
          nodes each one changed, and a revert back onto the canvas. */}
      <WorkflowHistory
        open={isHistoryOpen}
        workflowId={currentWorkflowId}
        workflowName={workflowName}
        onRevert={handleRevertToVersion}
        onClose={() => setIsHistoryOpen(false)}
      />

      {/* Drop-and-recreate approval for joins whose kept target no longer
          fits what they write. Run approves every table listed. */}
      <Modal
        open={rebuildPrompt.open}
        title="Recreate tables before running?"
        onCancel={() => setRebuildPrompt({ open: false, items: [] })}
        maskClosable={false}
        footer={[
          <Button key="cancel" onClick={() => setRebuildPrompt({ open: false, items: [] })}>
            Cancel
          </Button>,
          <Button
            key="run"
            type="primary"
            danger
            onClick={() => {
              const ids = rebuildPrompt.items.map((it) => it.nodeId);
              setRebuildPrompt({ open: false, items: [] });
              doExecuteWorkflow({ approvedRebuilds: ids });
            }}
          >
            Drop, recreate and run
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 8 }}>
          These tables already exist and no longer fit what their join writes. Running drops each one
          and recreates it — the rows in it now are deleted. Later runs append or merge into it as usual.
        </div>
        {rebuildPrompt.items.map((it) => (
          <div key={it.nodeId} style={{ marginBottom: 6 }}>
            <strong>{it.table}</strong>
            {Number.isFinite(it.rowCount) ? ` (${it.rowCount} row${it.rowCount === 1 ? '' : 's'})` : ''}
            {' '}— {it.label}: {it.reason}
            {it.warning && (
              <div style={{ marginTop: 4, padding: '6px 8px', borderRadius: 4, background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', fontSize: 12.5, lineHeight: 1.45 }}>
                ⚠ {it.warning}
              </div>
            )}
          </div>
        ))}
      </Modal>

      {/* Unsaved-changes prompt (Save / Don't save / Cancel). Save is the
          one-click commitSave; the run order is edited with Edit Steps. */}
      <Modal
        open={unsavedPrompt.open}
        title="Unsaved changes"
        onCancel={handlePromptCancel}
        maskClosable={false}
        footer={[
          <Button key="cancel" onClick={handlePromptCancel}>
            Cancel
          </Button>,
          <Button key="dontsave" danger onClick={handlePromptDontSave}>
            Don't save
          </Button>,
          <Button key="save" type="primary" icon={<SaveOutlined />} onClick={handlePromptSave}>
            Save
          </Button>,
        ]}
      >
        <div>
          {unsavedPrompt.intent === 'execute'
            ? 'You have unsaved changes. Save before running, or run without saving?'
            : 'You have unsaved changes. Save before closing, or discard them?'}
        </div>
      </Modal>
    </div>
  );
};

export default WorkflowEditor;