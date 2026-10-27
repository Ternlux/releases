import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { message } from 'antd';
import {
  FormScope, FormBody, FormFooter, Card, Fields, Field,
  Segmented, SelectInput, NumberInput, TimeInput, PathPicker, CheckGrid, Note,
  toTimeString, fromTimeString,
} from './_formShared';

/**
 * Start Node configuration form.
 *
 * Same three trigger types the chat flow supported — Manual, Time-based (CRON)
 * and File/Folder watch — asked all at once instead of one question at a time.
 * The trigger registration logic in handleSave is unchanged.
 */

const TRIGGER_OPTIONS = [
  { label: 'Manual', value: 'manual' },
  { label: 'Schedule', value: 'time' },
  { label: 'File watch', value: 'file' },
];

const FREQUENCY_OPTIONS = [
  { label: 'Hourly', value: 'hourly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const WATCH_TYPE_OPTIONS = [
  { label: 'Single file', value: 'file' },
  { label: 'Directory', value: 'directory' },
];

const FILE_EVENTS = [
  { label: 'File added', value: 'add' },
  { label: 'File changed', value: 'change' },
  { label: 'File deleted', value: 'unlink' },
];
const DIRECTORY_EVENTS = [
  ...FILE_EVENTS,
  { label: 'Directory added', value: 'addDir' },
  { label: 'Directory deleted', value: 'unlinkDir' },
];

const DEFAULT_CRON = { frequency: 'daily', month: null, day: null, dayOfWeek: null, hour: 9, minute: 0 };
const DEFAULT_WATCH = { path: null, type: 'file', events: ['add', 'change'], pattern: null };

const buildCronExpression = ({ frequency, month, day, dayOfWeek, hour, minute }) => {
  if (frequency === 'yearly') return `${minute} ${hour} ${day} ${month} *`;
  if (frequency === 'monthly') return `${minute} ${hour} ${day} * *`;
  if (frequency === 'weekly') return `${minute} ${hour} * * ${dayOfWeek}`;
  if (frequency === 'daily') return `${minute} ${hour} * * *`;
  if (frequency === 'hourly') return `${minute} * * * *`;
  return null;
};

const describeSchedule = ({ frequency, month, day, dayOfWeek, hour, minute }) => {
  const hhmm = `${hour}:${String(minute).padStart(2, '0')}`;
  if (frequency === 'yearly') return `Every year on ${MONTH_ABBR[month - 1]} ${day} at ${hhmm}`;
  if (frequency === 'monthly') return `Every month on day ${day} at ${hhmm}`;
  if (frequency === 'weekly') return `Every ${DAY_NAMES[dayOfWeek]} at ${hhmm}`;
  if (frequency === 'daily') return `Every day at ${hhmm}`;
  if (frequency === 'hourly') return `Every hour at minute ${minute}`;
  return 'Not configured';
};

const StartNodeChat = ({ node, initialConfig, currentWorkflowId, onSave, onCancel, onDirtyChange }) => {
  const saved = initialConfig?.nodeType === 'start' ? initialConfig : null;

  const [triggerType, setTriggerType] = useState(saved?.triggerType || 'manual');
  const [cronConfig, setCronConfig] = useState({ ...DEFAULT_CRON, ...(saved?.cronConfig || {}) });
  const [fileWatchConfig, setFileWatchConfig] = useState({ ...DEFAULT_WATCH, ...(saved?.fileWatchConfig || {}) });

  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const touch = useCallback(() => { setDirty(true); }, []);

  const patchCron = (patch) => { touch(); setCronConfig((prev) => ({ ...prev, ...patch })); };
  const patchWatch = (patch) => { touch(); setFileWatchConfig((prev) => ({ ...prev, ...patch })); };

  // ── Validation ───────────────────────────────────────────────────────────
  // A field is only flagged red after a failed Save, per the spec.

  const missing = useMemo(() => {
    const out = {};
    if (triggerType === 'time') {
      const { frequency, month, day, dayOfWeek, hour, minute } = cronConfig;
      // `== null` on purpose — 0 is a valid minute and Sunday is day 0.
      const unset = (v) => v === null || v === undefined;
      if (!frequency) out.frequency = true;
      if (frequency === 'yearly' && !month) out.month = true;
      if ((frequency === 'yearly' || frequency === 'monthly') && !day) out.day = true;
      if (frequency === 'weekly' && unset(dayOfWeek)) out.dayOfWeek = true;
      if (frequency === 'hourly' && unset(minute)) out.minute = true;
      if (frequency && frequency !== 'hourly' && (unset(hour) || unset(minute))) out.time = true;
    } else if (triggerType === 'file') {
      if (!fileWatchConfig.path) out.path = true;
      if (!fileWatchConfig.events || fileWatchConfig.events.length === 0) out.events = true;
    }
    return out;
  }, [triggerType, cronConfig, fileWatchConfig]);

  const missingCount = Object.keys(missing).length;
  const invalid = (key) => attempted && !!missing[key];

  // Nothing edited, nothing to save — so the button stays disabled until
  // something changes. It used to come up active the moment a fresh node was
  // opened, inviting a save of a config the user had not touched. Missing
  // fields do NOT disable Save once it IS live — clicking it is what reveals
  // them.
  const saveDisabled = saving || !dirty;

  // ── Path picker ──────────────────────────────────────────────────────────

  const browsePath = async () => {
    const dialogOptions = fileWatchConfig.type === 'file'
      ? { properties: ['openFile'] }
      : { properties: ['openDirectory'] };
    try {
      const result = await window.electronAPI.openFileDialog(dialogOptions);
      if (!result.canceled && result.filePaths?.length > 0) {
        patchWatch({ path: result.filePaths[0] });
      }
    } catch (error) {
      console.error('Failed to select path:', error);
      message.error('Failed to select path');
    }
  };

  // Switching between file and directory invalidates the chosen path and any
  // directory-only events.
  const changeWatchType = (type) => {
    const allowed = new Set((type === 'file' ? FILE_EVENTS : DIRECTORY_EVENTS).map((e) => e.value));
    patchWatch({
      type,
      path: null,
      events: (fileWatchConfig.events || []).filter((e) => allowed.has(e)),
    });
  };

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setAttempted(true);
    if (missingCount > 0) return;
    if (saving) return; // a second click must not re-register the trigger

    try {
      setSaving(true);

      const previousConfig = node?.data?.config;
      const config = { nodeType: 'start', triggerType };

      if (triggerType === 'manual') {
        // Switching to manual tears down whatever trigger was registered.
        if (previousConfig?.triggerType && previousConfig.triggerType !== 'manual') {
          if (previousConfig.triggerType === 'time') {
            await window.electronAPI.startTriggers.unregisterCron({ nodeId: node.id, workflowId: currentWorkflowId });
          } else if (previousConfig.triggerType === 'file') {
            await window.electronAPI.startTriggers.unregisterFileWatch({ nodeId: node.id, workflowId: currentWorkflowId });
          }
        }
        config.description = 'Manual trigger';
      } else if (triggerType === 'time') {
        const cronExpression = buildCronExpression(cronConfig);
        if (!cronExpression) {
          message.error('Invalid CRON configuration');
          setSaving(false);
          return;
        }

        config.cronConfig = cronConfig;
        config.cronExpression = cronExpression;
        config.description = describeSchedule(cronConfig);

        if (previousConfig?.triggerType === 'time') {
          await window.electronAPI.startTriggers.unregisterCron({ nodeId: node.id, workflowId: currentWorkflowId });
        } else if (previousConfig?.triggerType === 'file') {
          await window.electronAPI.startTriggers.unregisterFileWatch({ nodeId: node.id, workflowId: currentWorkflowId });
        }

        const result = await window.electronAPI.startTriggers.registerCron({
          nodeId: node.id,
          workflowId: currentWorkflowId,
          cronExpression,
          description: config.description,
        });

        if (!result.success) {
          message.error(`Failed to register schedule: ${result.message}`);
          setSaving(false);
          return;
        }
      } else if (triggerType === 'file') {
        config.fileWatchConfig = fileWatchConfig;
        config.description = `Watch ${fileWatchConfig.type}: ${fileWatchConfig.path}`;

        if (previousConfig?.triggerType === 'file') {
          await window.electronAPI.startTriggers.unregisterFileWatch({ nodeId: node.id, workflowId: currentWorkflowId });
        } else if (previousConfig?.triggerType === 'time') {
          await window.electronAPI.startTriggers.unregisterCron({ nodeId: node.id, workflowId: currentWorkflowId });
        }

        const result = await window.electronAPI.startTriggers.registerFileWatch({
          nodeId: node.id,
          workflowId: currentWorkflowId,
          path: fileWatchConfig.path,
          events: fileWatchConfig.events,
          pattern: fileWatchConfig.pattern,
        });

        if (!result.success) {
          message.error(`Failed to register file watcher: ${result.message}`);
          setSaving(false);
          return;
        }
      }

      onSave(config, []);
      setSaving(false);
      setDirty(false);
      setAttempted(false);
    } catch (error) {
      console.error('Failed to save start node config:', error);
      message.error('Failed to save configuration');
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const { frequency } = cronConfig;
  const showTimeOfDay = triggerType === 'time' && frequency && frequency !== 'hourly';
  const eventOptions = fileWatchConfig.type === 'file' ? FILE_EVENTS : DIRECTORY_EVENTS;

  return (
    <FormScope>
      <FormBody>
        <Card label="Trigger">
          <Fields>
            <Field label="How does this workflow start?">
              <Segmented
                value={triggerType}
                options={TRIGGER_OPTIONS}
                onChange={(v) => { touch(); setTriggerType(v); }}
              />
            </Field>

            {triggerType === 'manual' && (
              <Note>Runs only when someone presses Execute. No further configuration needed.</Note>
            )}

            {triggerType === 'time' && (
              <Field label="Frequency" required invalid={invalid('frequency')}>
                <Segmented
                  value={frequency}
                  options={FREQUENCY_OPTIONS}
                  onChange={(v) => patchCron({ frequency: v })}
                />
              </Field>
            )}

            {triggerType === 'time' && frequency === 'hourly' && (
              <Field label="Minute past the hour" required invalid={invalid('minute')}>
                <NumberInput
                  value={cronConfig.minute}
                  min={0}
                  max={59}
                  onChange={(v) => patchCron({ minute: v })}
                />
              </Field>
            )}

            {triggerType === 'time' && frequency === 'yearly' && (
              <Field label="Month" required invalid={invalid('month')}>
                <SelectInput
                  value={cronConfig.month ?? ''}
                  placeholder="Select a month…"
                  options={MONTHS.map((m, i) => ({ label: m, value: i + 1 }))}
                  onChange={(v) => patchCron({ month: Number(v) })}
                />
              </Field>
            )}

            {triggerType === 'time' && (frequency === 'yearly' || frequency === 'monthly') && (
              <Field label="Day of month" required invalid={invalid('day')}>
                <NumberInput value={cronConfig.day} min={1} max={31} onChange={(v) => patchCron({ day: v })} />
              </Field>
            )}

            {triggerType === 'time' && frequency === 'weekly' && (
              <Field label="Day of week" required invalid={invalid('dayOfWeek')}>
                <SelectInput
                  value={cronConfig.dayOfWeek ?? ''}
                  placeholder="Select a day…"
                  options={DAY_NAMES.map((d, i) => ({ label: d, value: i }))}
                  onChange={(v) => patchCron({ dayOfWeek: Number(v) })}
                />
              </Field>
            )}

            {showTimeOfDay && (
              <Field label="Time of day" required invalid={invalid('time')}>
                <TimeInput
                  value={toTimeString(cronConfig.hour, cronConfig.minute)}
                  onChange={(v) => {
                    const parsed = fromTimeString(v);
                    if (parsed) patchCron(parsed);
                  }}
                />
              </Field>
            )}

            {triggerType === 'file' && (
              <>
                <Field label="Watch a file or a directory?">
                  <Segmented
                    value={fileWatchConfig.type}
                    options={WATCH_TYPE_OPTIONS}
                    onChange={changeWatchType}
                  />
                </Field>

                <Field
                  label={fileWatchConfig.type === 'file' ? 'File to watch' : 'Folder to watch'}
                  required
                  invalid={invalid('path')}
                  hint="Opens the native picker."
                >
                  <PathPicker
                    value={fileWatchConfig.path}
                    placeholder={fileWatchConfig.type === 'file' ? '/Users/you/drops/orders.csv' : '/Users/you/drops'}
                    onChange={(v) => patchWatch({ path: v || null })}
                    onBrowse={browsePath}
                    browseTitle={fileWatchConfig.type === 'file' ? 'Choose a file' : 'Choose a folder'}
                  />
                </Field>

                <Field label="Trigger on" required invalid={invalid('events')}>
                  <CheckGrid
                    value={fileWatchConfig.events || []}
                    options={eventOptions}
                    onChange={(v) => patchWatch({ events: v })}
                  />
                </Field>
              </>
            )}
          </Fields>
        </Card>
      </FormBody>

      <FormFooter
        error={saving
          ? 'Registering the trigger…'
          : attempted && missingCount > 0
            ? `${missingCount} field${missingCount === 1 ? '' : 's'} still needed`
            : null}
        onCancel={onCancel}
        cancelDisabled={saving}
        onSave={handleSave}
        saveLabel={saving ? 'Saving…' : 'Save configuration'}
        saveDisabled={saveDisabled}
        saveDisabledReason={saving
          ? 'Registering the trigger — wait for it to finish.'
          : 'Nothing has changed yet.'}
      />
    </FormScope>
  );
};

export default StartNodeChat;
