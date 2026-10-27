import React from 'react';
import { Form, Input, Button, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;

export const MAX_PAIRS = 50;

/**
 * Normalise a key/value list the way the form saves it:
 *   - trim keys
 *   - drop rows whose key is blank (a value with no key has nowhere to go)
 *   - coerce values to strings
 */
export function normalisePairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs
    .map(p => ({
      key: String(p && p.key != null ? p.key : '').trim(),
      value: p && p.value != null ? String(p.value) : '',
    }))
    .filter(p => p.key);
}

/**
 * Open-ended credential/parameter editor for a connection.
 *
 * Rendered for `type: 'keyValue'` fields in a plugin configSchema. The list is
 * stored on the form as `[{ key, value }, ...]` under `field.name`; values are
 * masked and, when the field is marked sensitive, encrypted on save.
 *
 * Editing an existing connection intentionally does NOT pull the stored values
 * back into the renderer: rows come back with their keys and a blank value,
 * and a blank value means "keep whatever is stored". Clearing a value means
 * deleting the row.
 */
const KeyValueFields = ({ field, editing = false }) => {
  const max = field.maxPairs || MAX_PAIRS;
  const form = Form.useFormInstance();
  const pairs = Form.useWatch(field.name, form) || [];
  const usedCount = pairs.filter(p => p && String(p.key || '').trim()).length;

  // A duplicate involves two rows, so editing one has to clear (or raise) the
  // error on the other — revalidate every key whenever any key changes.
  const revalidateKeys = () => {
    const current = form.getFieldValue(field.name) || [];
    if (current.length === 0) return;
    form
      .validateFields(current.map((_row, i) => [field.name, i, 'key']))
      .catch(() => {});
  };

  // A key is invalid if another row already claims it (case-insensitively).
  const validateKey = (index) => ({
    validator(_rule, value) {
      const key = String(value || '').trim();
      if (!key) return Promise.resolve(); // blank rows are dropped on save
      const current = form.getFieldValue(field.name) || [];
      const clash = current.some((row, i) =>
        i !== index && String((row && row.key) || '').trim().toLowerCase() === key.toLowerCase()
      );
      if (clash) {
        return Promise.reject(new Error(`"${key}" is already used — keys must be unique for this connection.`));
      }
      return Promise.resolve();
    },
  });

  return (
    <Form.Item
      label={field.label}
      tooltip={field.helpText}
      style={{ marginBottom: 16 }}
      required={field.required}
    >
      <Form.List
        name={field.name}
        rules={field.required ? [{
          validator: async (_rule, value) => {
            if (normalisePairs(value).length === 0) {
              throw new Error(`${field.label} needs at least one key.`);
            }
          },
        }] : undefined}
      >
        {(rows, { add, remove }, { errors }) => (
          <div>
            {rows.length === 0 && (
              <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
                No entries yet. Add the tokens, headers, or parameters this API needs.
              </Text>
            )}

            {rows.map(({ key: rowKey, name, ...rest }) => (
              <div
                key={rowKey}
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}
              >
                <Form.Item
                  {...rest}
                  name={[name, 'key']}
                  rules={[validateKey(name)]}
                  style={{ flex: '1 1 40%', marginBottom: 0 }}
                >
                  <Input
                    placeholder={field.keyPlaceholder || 'Key (e.g. X-API-Key)'}
                    autoComplete="off"
                    onChange={revalidateKeys}
                  />
                </Form.Item>

                <Form.Item
                  {...rest}
                  name={[name, 'value']}
                  style={{ flex: '1 1 60%', marginBottom: 0 }}
                >
                  <Input.Password
                    placeholder={
                      editing
                        ? 'Leave blank to keep the saved value'
                        : (field.valuePlaceholder || 'Value')
                    }
                    autoComplete="new-password"
                  />
                </Form.Item>

                <Tooltip title="Remove">
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => { remove(name); revalidateKeys(); }}
                    style={{ marginTop: 2 }}
                  />
                </Tooltip>
              </div>
            ))}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
              <Button
                type="dashed"
                onClick={() => add({ key: '', value: '' })}
                icon={<PlusOutlined />}
                disabled={rows.length >= max}
              >
                Add key / value
              </Button>
              <Text type={usedCount >= max ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                {usedCount} / {max}
              </Text>
            </div>

            <Form.ErrorList errors={errors} />

            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              Rows with an empty key are discarded on save. Values are encrypted on this
              machine and are never sent to the chat — the assistant only sees the key names.
            </Text>
          </div>
        )}
      </Form.List>
    </Form.Item>
  );
};

export default KeyValueFields;
