import React, { useState, useEffect, useCallback } from 'react';
import { Modal, Button, Space, Typography, Input, Select, Card, message, Divider, Checkbox, Alert } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  DragOutlined,
  SaveOutlined,
  PlayCircleOutlined,
  DatabaseOutlined,
  SettingOutlined,
  MergeOutlined,
  ExportOutlined,
  SafetyCertificateOutlined,
  CodeOutlined,
  ExpandOutlined
} from '@ant-design/icons';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import axios from 'axios';
import Editor from '@monaco-editor/react';
import CodeEditorPopup from '../Chat/CodeEditorPopup';
import {
  generateStepsFromNodes,
  hydrateSteps,
  sanitizeExecutionSteps,
  stepDescriptionOf,
} from '../../utils/workflowUtils';
import { nodeDisplayName } from './nodes/nodeCardShared';

const { Title, Text } = Typography;
const { Option } = Select;
const { TextArea } = Input;

// Node type to icon mapping
const NODE_TYPE_ICONS = {
  start: <PlayCircleOutlined style={{ color: '#1890ff' }} />,
  dataSource: <DatabaseOutlined style={{ color: '#52c41a' }} />,
  transformer: <SettingOutlined style={{ color: '#1890ff' }} />,
  join: <MergeOutlined style={{ color: '#fa8c16' }} />,
  output: <ExportOutlined style={{ color: '#722ed1' }} />,
};

// Node type display names
const NODE_TYPE_NAMES = {
  start: 'Start',
  dataSource: 'Data Source',
  transformer: 'Transformer',
  join: 'Join',
  output: 'Output',
};

// Draggable step item component.
//
// `step` is hydrated (see hydrateSteps): `{ nodeId, order, node }`. A saved step
// is only `{ nodeId, order }`, so everything drawn here — icon, name, summary —
// comes from the live node. That is also why a renamed or rebuilt node shows up
// correctly the moment this list opens; it used to draw a snapshot taken when
// the step was written.
const DraggableStepItem = ({ step, index }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: step.nodeId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const nodeType = step.node?.type;

  const getStepIcon = () => {
    return NODE_TYPE_ICONS[nodeType] || <SettingOutlined />;
  };

  // The same naming rule as the canvas card — one function, so the step list
  // and the node it stands for can never disagree.
  const getStepTitle = () => nodeDisplayName(
    nodeType,
    step.node?.data,
    `${NODE_TYPE_NAMES[nodeType] || 'Unknown'} - Unnamed`,
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className="workflow-step-item"
    >
      <Card 
        size="small" 
        style={{ 
          marginBottom: 8,
          border: '1px solid #d9d9d9',
          cursor: 'move'
        }}
        bodyStyle={{ 
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}
      >
        <div {...listeners} style={{ cursor: 'grab', color: '#8c8c8c' }}>
          <DragOutlined />
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {getStepIcon()}
          <Text strong>{index + 1}</Text>
        </div>
        
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>{getStepTitle()}</div>
          <div style={{ 
            fontSize: '12px', 
            color: '#8c8c8c',
            maxWidth: '300px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {stepDescriptionOf(step.node) || 'No description provided'}
          </div>
        </div>

        <div style={{ color: '#8c8c8c', fontSize: '12px' }}>
          {NODE_TYPE_NAMES[nodeType]}
        </div>
      </Card>
    </div>
  );
};

/**
 * Everything this dialog shows comes from the editor's live state, passed in
 * piece by piece — never from a saved workflow record. A record read when the
 * editor opened does not know about saves made since, and seeding from one made
 * this dialog reopen on the order the user had already replaced.
 *
 * `savedExecutionSteps` is the order as last saved/verified, `nodes`/`edges` the
 * canvas as it stands now, and `workflowId` is set only once the workflow exists
 * in the database (which is what authoring a validation function requires).
 */
const WorkflowStepsEditor = ({
  open,
  onClose,
  onSave,
  executionSteps: savedExecutionSteps,
  outputValidation: savedOutputValidation,
  workflowId,
  workflowName,
  nodes,
  edges
}) => {
  const [steps, setSteps] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [hasModifiedOrder, setHasModifiedOrder] = useState(false);
  const [autoGeneratedSteps, setAutoGeneratedSteps] = useState([]);
  // Output validation: an AI-authored validate(ctx) function that runs at the
  // end of every execution. `outputValidation` holds the saved object
  // (goal/validationFunction/explanation); `validationEnabled` is the toggle.
  const [validationEnabled, setValidationEnabled] = useState(false);
  const [outputValidation, setOutputValidation] = useState(null);
  const [generatingValidation, setGeneratingValidation] = useState(false);
  // Set when the author's AI call ran out of output room — drives the Continue
  // button below, which finishes that one call rather than re-running the lot.
  const [validationResume, setValidationResume] = useState(null);
  // Collapsible view of the authored validate(ctx) source, plus the same
  // full-screen editor the chat uses for its code sections.
  const [showValidationCode, setShowValidationCode] = useState(false);
  const [codePopupOpen, setCodePopupOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Check if all nodes are covered by existing execution steps
  const areAllNodesInExecutionSteps = (existingSteps, workflowNodes) => {
    if (!existingSteps || !workflowNodes) return false;
    
    // Get node IDs from workflow
    const currentNodeIds = new Set(workflowNodes.map(node => node.id));
    
    // Get node IDs from execution steps
    const executionStepNodeIds = new Set(existingSteps.map(step => step.nodeId));
    
    // Check if all current nodes are in execution steps
    for (const nodeId of currentNodeIds) {
      if (!executionStepNodeIds.has(nodeId)) {
        console.log('Missing node in execution steps:', nodeId);
        return false;
      }
    }
    
    console.log('All nodes are covered by existing execution steps');
    return true;
  };

  // Seed the list when the dialog opens, from the order the editor holds —
  // which includes whatever was saved from this dialog a moment ago.
  useEffect(() => {
    if (open) {
      const ov = savedOutputValidation || null;
      setOutputValidation(ov);
      setValidationEnabled(Boolean(ov?.enabled));
      if (savedExecutionSteps && savedExecutionSteps.length > 0) {
        // Steps whose node has been deleted are dropped before anything else
        // looks at the list. The coverage check below only asks whether the
        // CURRENT nodes all have a step, which a leftover step never breaks —
        // so without this the editor (and the save behind it) kept listing
        // sources and outputs that are no longer on the canvas.
        const existingSteps = sanitizeExecutionSteps(savedExecutionSteps, nodes);

        // Check if all current nodes are already in execution steps
        if (areAllNodesInExecutionSteps(existingSteps, nodes)) {
          // All nodes are covered, keep existing execution steps as-is
          console.log('Using existing execution steps - all nodes are covered, keeping current order');
          setSteps(hydrateSteps(existingSteps, nodes));
          setHasModifiedOrder(true);
          setAutoGeneratedSteps([]);
        } else {
          // New node detected - do a full rebuild of steps
          console.log('New node detected - doing full rebuild of execution steps');
          const generatedSteps = hydrateSteps(generateStepsFromNodes(nodes, edges), nodes);
          setSteps(generatedSteps);
          setAutoGeneratedSteps([...generatedSteps]);
          setHasModifiedOrder(false);
        }
      } else if (nodes && nodes.length > 0) {
        // Auto-generate steps from workflow nodes
        console.log('Auto-generating execution steps from nodes');
        const generatedSteps = hydrateSteps(generateStepsFromNodes(nodes, edges), nodes);
        setSteps(generatedSteps);
        setAutoGeneratedSteps([...generatedSteps]); // Keep track of original auto-generated order
        setHasModifiedOrder(false);
      } else {
        setSteps([]);
        setAutoGeneratedSteps([]);
        setHasModifiedOrder(false);
      }
    }
  }, [open, savedExecutionSteps, savedOutputValidation, nodes, edges]);


  const handleDragStart = (event) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      setSteps((prevSteps) => {
        // The sortable id IS the node id — a step has nothing else to be
        // identified by, and the node it names is unique in the workflow.
        const draggedStep = prevSteps.find(step => step.nodeId === active.id);

        // Start is the only pinned step — it has to run first. Output nodes are
        // ordinary steps: a workflow can have several, and the user decides
        // where each one runs (mid-pipeline exports are legitimate).
        if (draggedStep?.node?.type === 'start') {
          message.warning('The Start node must stay first.');
          return prevSteps;
        }

        const oldIndex = prevSteps.findIndex(step => step.nodeId === active.id);
        const newIndex = prevSteps.findIndex(step => step.nodeId === over.id);
        const startIndex = prevSteps.findIndex(step => step.node?.type === 'start');

        if (startIndex !== -1 && newIndex <= startIndex) {
          message.warning('Nodes cannot be placed before the Start node.');
          return prevSteps;
        }

        // Update order property
        const finalSteps = arrayMove(prevSteps, oldIndex, newIndex).map((step, index) => ({
          ...step,
          order: index
        }));

        // The order is honored literally at run time, so a step that now sits
        // ahead of a node it reads from will find no input. Say so — but keep
        // the order the user chose.
        const position = new Map(finalSteps.map((step, index) => [step.nodeId, index]));
        const runsTooEarly = (edges || []).some(edge =>
          position.has(edge.source) &&
          position.has(edge.target) &&
          position.get(edge.source) > position.get(edge.target)
        );
        if (runsTooEarly) {
          message.warning('This order runs a step before a node it reads from — execution may fail.');
        }

        // Mark as modified since user manually reordered
        setHasModifiedOrder(true);

        return finalSteps;
      });
    }
  };


  // Author (or re-author) the workflow's output-validation function. Requires a
  // saved workflow (the generator studies the persisted pipeline + produced
  // data). The returned object is held in state and persisted on save.
  // Shared by the initial run and the Continue path — both land the same way.
  const applyValidationResult = (res) => {
    if (res?.success && res.outputValidation) {
      setOutputValidation(res.outputValidation);
      setValidationEnabled(true);
      setValidationResume(null);
      message.success('Validation function generated');
      return;
    }
    // The author ran out of output room. Keep the resume payload so the user
    // can finish that one call instead of starting the whole run over.
    if (res?.code === 'MAX_TOKENS' && res.resume) {
      setValidationResume(res.resume);
      return;
    }
    setValidationResume(null);
    message.error(res?.message || 'Failed to generate validation function');
  };

  const handleGenerateValidation = async () => {
    if (!workflowId) {
      message.warning('Save the workflow first, then generate its validation.');
      return;
    }
    setGeneratingValidation(true);
    setValidationResume(null);
    try {
      applyValidationResult(await window.electronAPI.workflow.generateValidation({ workflowId }));
    } catch (err) {
      message.error(err.message || 'Failed to generate validation function');
    } finally {
      setGeneratingValidation(false);
    }
  };

  // Finish the truncated call and let the author loop pick up where it stopped.
  // Same ai:continue channel every other Continue in the app uses.
  const handleContinueValidation = async () => {
    if (!validationResume || !window.electronAPI?.ai?.continue) return;
    setGeneratingValidation(true);
    try {
      applyValidationResult(await window.electronAPI.ai.continue({ resume: validationResume }));
    } catch (err) {
      message.error(err.message || 'Failed to continue the validation function');
    } finally {
      setGeneratingValidation(false);
    }
  };

  const handleSave = () => {
    // What gets persisted is the ORDER and nothing else: which node, and where
    // in the run it sits. Everything this list draws comes from the node, so
    // there is nothing else worth writing down.
    const executionSteps = steps.map((step, index) => ({
      nodeId: step.nodeId,
      order: index,
    }));

    // Resolve the outputValidation to persist. Passing null means "no change" —
    // parent skips it so the $set merge leaves any existing field alone.
    let outputValidationToSave = null;
    if (outputValidation) {
      outputValidationToSave = { ...outputValidation, enabled: validationEnabled };
    } else if (validationEnabled) {
      // Toggled on but not generated yet — persist the intent; execution no-ops
      // until a function exists.
      outputValidationToSave = { enabled: true };
    }

    // Pass execution steps + validation to parent component
    onSave(executionSteps, { outputValidation: outputValidationToSave });
    message.success('Execution steps saved to workflow');
    onClose();
  };

  const draggedStep = activeId ? steps.find(step => step.nodeId === activeId) : null;

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SettingOutlined />
          <span>Edit Execution Steps</span>
          {workflowName && (
            <Text type="secondary">- {workflowName}</Text>
          )}
        </div>
      }
      open={open}
      onCancel={onClose}
      width={800}
      footer={
        <Space>
          <Button onClick={onClose}>
            Cancel
          </Button>
          <Button 
            type="primary" 
            icon={<SaveOutlined />}
            onClick={handleSave}
          >
            Save Steps
          </Button>
        </Space>
      }
    >
      <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
        <div style={{ marginBottom: 16 }}>
          <Text>
            Define the execution order of your workflow steps. Drag and drop to reorder, 
            or customize names and descriptions for each step.
          </Text>
        </div>

        {steps.length > 0 ? (
          <DndContext 
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={steps.map(step => step.nodeId)}
              strategy={verticalListSortingStrategy}
            >
              {steps.map((step, index) => (
                <DraggableStepItem
                  key={step.nodeId}
                  step={step}
                  index={index}
                />
              ))}
            </SortableContext>

            <DragOverlay>
              {draggedStep && (
                <DraggableStepItem
                  step={draggedStep}
                  index={steps.findIndex(s => s.nodeId === draggedStep.nodeId)}
                />
              )}
            </DragOverlay>
          </DndContext>
        ) : (
          <Card style={{ textAlign: 'center', padding: '40px' }}>
            <Text type="secondary">
              No execution steps defined. Add steps to customize the execution order.
            </Text>
          </Card>
        )}

        <Divider />

        <div>
          <Checkbox
            checked={validationEnabled}
            onChange={(e) => setValidationEnabled(e.target.checked)}
          >
            <Text strong>Validate workflow output when execution completes</Text>
          </Checkbox>
          <div style={{ marginLeft: 24, marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Runs an AI-authored check at the end of each run and flags the run if the
              output doesn't match the workflow's goal. It does not fail or roll back the run.
            </Text>
          </div>

          {validationEnabled && (
            <div style={{ marginLeft: 24, marginTop: 12 }}>
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <Button
                  icon={<SafetyCertificateOutlined />}
                  loading={generatingValidation}
                  onClick={handleGenerateValidation}
                  disabled={!workflowId}
                >
                  {outputValidation?.validationFunction ? 'Regenerate validation' : 'Generate validation'}
                </Button>
                {!workflowId && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Save the workflow first to generate a validation function.
                  </Text>
                )}
                {validationResume && (
                  <Alert
                    type="warning"
                    showIcon
                    message="The AI ran out of room before finishing"
                    description="Continue picks up from exactly where it stopped — the investigation it already did is kept, so only the unfinished reply is completed."
                    action={
                      <Button
                        size="small"
                        type="primary"
                        loading={generatingValidation}
                        onClick={handleContinueValidation}
                      >
                        Continue
                      </Button>
                    }
                  />
                )}
                {outputValidation?.goal && (
                  <Card size="small" style={{ background: 'rgba(0,0,0,0.02)' }}>
                    <Text strong style={{ fontSize: 12 }}>Goal</Text>
                    <div style={{ marginBottom: 8 }}>
                      <Text style={{ fontSize: 12 }}>{outputValidation.goal}</Text>
                    </div>
                    {outputValidation.explanation && (
                      <>
                        <Text strong style={{ fontSize: 12 }}>What it checks</Text>
                        <div>
                          <Text style={{ fontSize: 12 }}>{outputValidation.explanation}</Text>
                        </div>
                      </>
                    )}
                  </Card>
                )}

                {/* The authored validate(ctx) source — same collapsible-preview +
                    full-editor pattern the chat uses for its code sections.
                    Editing here updates state; Save persists it with the rest. */}
                {outputValidation?.validationFunction && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <Button
                        type="link"
                        size="small"
                        icon={<CodeOutlined />}
                        style={{ padding: 0 }}
                        onClick={() => setShowValidationCode((v) => !v)}
                      >
                        {showValidationCode ? 'Hide validation code' : 'View validation code'}
                      </Button>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {outputValidation.validationFunction.split('\n').length} lines
                      </Text>
                      <div style={{ flex: 1 }} />
                      <Button
                        type="text"
                        size="small"
                        icon={<ExpandOutlined />}
                        onClick={() => setCodePopupOpen(true)}
                      >
                        Open in full editor
                      </Button>
                    </div>
                    {showValidationCode && (
                      <div style={{ border: '1px solid #e2e6eb', borderRadius: 4, overflow: 'hidden' }}>
                        <Editor
                          height={Math.min(400, (outputValidation.validationFunction.split('\n').length + 1) * 19 + 20)}
                          defaultLanguage="javascript"
                          value={outputValidation.validationFunction}
                          onChange={(value) => setOutputValidation((prev) => ({
                            ...prev,
                            validationFunction: value ?? '',
                          }))}
                          options={{
                            minimap: { enabled: false },
                            fontSize: 12,
                            scrollBeyondLastLine: false,
                            wordWrap: 'on',
                            tabSize: 2,
                          }}
                        />
                      </div>
                    )}
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Edits are kept when you save the workflow. The function receives
                      <Text code style={{ fontSize: 11 }}>ctx</Text> and returns
                      <Text code style={{ fontSize: 11 }}>{'{ valid, reason }'}</Text>.
                    </Text>
                  </div>
                )}
              </Space>
            </div>
          )}
        </div>

      </div>

      {/* Full-screen editor — the same component the chat uses, so code edits
          look and behave identically in both places. */}
      <CodeEditorPopup
        open={codePopupOpen}
        onClose={() => setCodePopupOpen(false)}
        title="Output validation function"
        code={outputValidation?.validationFunction || ''}
        language="javascript"
        onSave={(newCode) => setOutputValidation((prev) => ({ ...prev, validationFunction: newCode }))}
      />
    </Modal>
  );
};

export default WorkflowStepsEditor;