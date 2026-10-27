import React, { useState } from 'react';
import {
  DatabaseOutlined,
  SettingOutlined,
  MergeOutlined,
  ExportOutlined,
  BranchesOutlined
} from '@ant-design/icons';

const MONO = "'JetBrains Mono', monospace";
const SANS = "'Inter',-apple-system,sans-serif";
const TEXT = '#111827';
const MUTED = '#5a6678';
const DIM = '#9ca3af';
const BORDER = '#e2e6eb';

const NODE_TYPES = [
  { type: 'dataSource', label: 'Data Source', icon: DatabaseOutlined, color: '#0891b2' },
  { type: 'transformer', label: 'Transformer', icon: SettingOutlined, color: '#7c3aed' },
  { type: 'join', label: 'Join', icon: MergeOutlined, color: '#d97706' },
  // { type: 'branch', label: 'Branch', icon: BranchesOutlined, color: '#059669' },
  { type: 'output', label: 'Output', icon: ExportOutlined, color: '#db2777' },
];

const PaletteItem = ({ type, label, icon: Icon, color, onDragStart }) => {
  const [hov, setHov] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, type)}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        border: `1px solid ${hov ? color + '66' : BORDER}`,
        borderRadius: 5,
        background: hov ? color + '0f' : '#fff',
        cursor: 'grab',
        marginBottom: 5,
        fontSize: 12,
        fontWeight: 500,
        color: hov ? color : TEXT,
        transition: 'all 0.15s',
        userSelect: 'none',
        fontFamily: SANS,
        overflow: 'hidden',
        boxShadow: hov ? `0 2px 8px ${color}1a` : 'none',
      }}
    >
      {/* Colored stripe */}
      <div
        style={{
          width: 6,
          background: color,
          flexShrink: 0,
        }}
      />
      {/* Content */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          flex: 1,
          minWidth: 0,
        }}
      >
        <Icon style={{ fontSize: 13, color: hov ? color : MUTED, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      </div>
    </div>
  );
};

const NodeTypePanel = () => {
  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      style={{
        width: 180,
        background: '#fff',
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: '14px 12px',
        fontFamily: SANS,
        boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
      }}
    >
      <div style={{
        fontSize: 9,
        fontFamily: MONO,
        fontWeight: 700,
        letterSpacing: '0.12em',
        color: DIM,
        textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        Node Types
      </div>
      <div style={{
        fontSize: 11,
        color: MUTED,
        marginBottom: 14,
        lineHeight: 1.5,
      }}>
        Drag nodes to the canvas to build your workflow
      </div>
      {NODE_TYPES.map((n) => (
        <PaletteItem key={n.type} {...n} onDragStart={onDragStart} />
      ))}
    </div>
  );
};

export default NodeTypePanel;
