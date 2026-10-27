import React from 'react';
import { Handle, Position } from 'reactflow';
import { PlayCircleOutlined, ClockCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { NODE_COLORS } from './nodeCardShared';

const ACCENT = NODE_COLORS.start;
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';

const StartNode = ({ data, selected }) => {
  const getTriggerIcon = () => {
    switch (data.config?.triggerType) {
      case 'schedule':
        return <ClockCircleOutlined style={{ fontSize: '12px', color: ACCENT }} />;
      case 'webhook':
        return <ThunderboltOutlined style={{ fontSize: '12px', color: ACCENT }} />;
      default:
        return <PlayCircleOutlined style={{ fontSize: '12px', color: ACCENT }} />;
    }
  };

  const getTriggerLabel = () => {
    const config = data.config || {};
    switch (config.triggerType) {
      case 'schedule':
        return config.scheduleType || 'Schedule';
      case 'webhook':
        return 'Webhook';
      case 'manual':
        return 'Manual Trigger';
      default:
        return 'Start';
    }
  };

  const getTriggerDescription = () => {
    const config = data.config || {};
    switch (config.triggerType) {
      case 'schedule':
        if (config.scheduleType === 'interval' && config.interval) {
          return `Every ${config.interval}${config.intervalUnit?.charAt(0) || 'm'}`;
        } else if (config.scheduleType === 'daily') {
          return 'Daily schedule';
        } else if (config.scheduleType === 'weekly') {
          return 'Weekly schedule';
        } else if (config.scheduleType === 'monthly') {
          return 'Monthly schedule';
        } else if (config.scheduleType === 'cron') {
          return 'Custom cron';
        }
        return 'Configure schedule';
      case 'webhook':
        return 'HTTP trigger';
      case 'manual':
        return 'Runs on demand. No schedule configured.';
      default:
        return 'Configure trigger';
    }
  };

  const isConfigured = !!(data.config?.triggerType);

  return (
    <div
      style={{
        width: 264,
        background: '#fff',
        border: `1px solid ${selected ? ACCENT : BORDER}`,
        borderLeft: `3px solid ${ACCENT}`,
        borderRadius: 6,
        boxShadow: selected
          ? `0 0 0 3px ${ACCENT}1a, 0 4px 16px rgba(0,0,0,0.12)`
          : '0 1px 4px rgba(0,0,0,0.07)',
        position: 'relative',
        userSelect: 'none',
        fontFamily: "'Inter',-apple-system,sans-serif",
      }}
    >
      {/* Header */}
      <div style={{
        padding: '7px 10px',
        borderBottom: '1px solid #f0f2f5',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}>
        {getTriggerIcon()}
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: ACCENT,
          textTransform: 'uppercase',
        }}>
          START
        </span>
        <div style={{
          marginLeft: 'auto',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isConfigured ? GREEN : BORDER,
        }} />
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: TEXT,
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {getTriggerLabel()}
        </div>
        <div style={{
          fontSize: 11,
          color: MUTED,
          lineHeight: 1.5,
        }}>
          {getTriggerDescription()}
        </div>
      </div>

      {/* Right handle */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: ACCENT,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          right: -6,
          boxShadow: `0 0 0 1px ${ACCENT}44`,
        }}
      />
    </div>
  );
};

export default StartNode;
