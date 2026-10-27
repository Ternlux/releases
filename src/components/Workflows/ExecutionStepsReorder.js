/**
 * Drag-to-reorder list of execution steps.
 *
 * The compact form of what WorkflowStepsEditor offers, for embedding where
 * there is no room for the full editor — currently the unsaved-changes prompt.
 * Same rules: Start stays first, and an order that runs a step before a node it
 * reads from is warned about but allowed.
 */

import React from 'react';
import { message } from 'antd';
import { HolderOutlined } from '@ant-design/icons';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { nodeDisplayName } from './nodes/nodeCardShared';

const TYPE_LABELS = {
  start: 'Start',
  dataSource: 'Data Source',
  transformer: 'Transformer',
  join: 'Join',
  output: 'Output',
};

// `steps` here are hydrated — `{ nodeId, order, node }`, see hydrateSteps. A
// saved step is only `{ nodeId, order }`, so the name and the type shown come
// from the live node, exactly as the canvas card derives them.
const titleOf = (step) =>
  nodeDisplayName(step.node?.type, step.node?.data, step.nodeId || 'Unnamed');

const SortableStep = ({ step, index }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.nodeId });

  const nodeType = step.node?.type;
  const pinned = nodeType === 'start';

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        marginBottom: 4,
        borderRadius: 4,
        border: '1px solid #f0f0f0',
        background: isDragging ? '#fafafa' : '#fff',
        boxShadow: isDragging ? '0 2px 8px rgba(0,0,0,0.12)' : 'none',
      }}
    >
      <span
        {...(pinned ? {} : listeners)}
        title={pinned ? 'Start always runs first' : 'Drag to reorder'}
        style={{
          display: 'flex',
          cursor: pinned ? 'not-allowed' : 'grab',
          color: pinned ? '#d9d9d9' : '#bfbfbf',
        }}
      >
        <HolderOutlined />
      </span>

      <span style={{ width: 16, fontSize: 11, color: '#8c8c8c' }}>{index + 1}</span>

      <span style={{
        flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {titleOf(step)}
      </span>

      <span style={{ fontSize: 11, color: '#8c8c8c', flexShrink: 0 }}>
        {TYPE_LABELS[nodeType] || nodeType}
      </span>
    </div>
  );
};

const ExecutionStepsReorder = ({ steps = [], edges = [], onChange, maxHeight = '42vh' }) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;

    // The sortable id is the node id — see WorkflowStepsEditor.
    const dragged = steps.find((s) => s.nodeId === active.id);
    if (dragged?.node?.type === 'start') {
      message.warning('The Start node must stay first.');
      return;
    }

    const from = steps.findIndex((s) => s.nodeId === active.id);
    const to = steps.findIndex((s) => s.nodeId === over.id);
    const startIndex = steps.findIndex((s) => s.node?.type === 'start');
    if (from < 0 || to < 0) return;
    if (startIndex !== -1 && to <= startIndex) {
      message.warning('Nodes cannot be placed before the Start node.');
      return;
    }

    const next = arrayMove(steps, from, to).map((s, i) => ({ ...s, order: i }));

    // The order is honored literally at run time — flag a step that now runs
    // before something it reads from, but keep the order the user chose.
    const position = new Map(next.map((s, i) => [s.nodeId, i]));
    const tooEarly = (edges || []).some((e) =>
      position.has(e.source) && position.has(e.target) &&
      position.get(e.source) > position.get(e.target));
    if (tooEarly) {
      message.warning('This order runs a step before a node it reads from — execution may fail.');
    }

    onChange(next);
  };

  if (steps.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#8c8c8c' }}>
        No steps yet — add a start node and connect your nodes.
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={steps.map((s) => s.nodeId)} strategy={verticalListSortingStrategy}>
        <div style={{ maxHeight, overflowY: 'auto', paddingRight: 4 }}>
          {steps.map((s, i) => <SortableStep key={s.nodeId} step={s} index={i} />)}
        </div>
      </SortableContext>
    </DndContext>
  );
};

export default ExecutionStepsReorder;
