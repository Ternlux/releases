import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Form, Input, InputNumber, Switch, Button, Space, message, Alert, Select } from 'antd';
import { LinkOutlined, CheckCircleOutlined } from '@ant-design/icons';
import KeyValueFields, { MAX_PAIRS, normalisePairs } from './KeyValueFields';
import { uniqueNameRule } from './connectionNameRule';
import SecretStorageWarning from '../../SecretStorageWarning/SecretStorageWarning';

/**
 * Dynamic Connection Form
 * Generates a connection form based on plugin configSchema
 */
const DynamicConnectionForm = ({
  plugin,
  onSave,
  onCancel,
  onTest,
  editingConnection,
  existingConnections = []
}) => {
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(false);

  // keyValue fields declared by the plugin schema. Their values are sensitive
  // and live in the OS keychain, so only the key names round-trip through the
  // saved connection (`field.publicKeysField`).
  const keyValueFields = useMemo(
    () => (plugin.configSchema?.fields || []).filter(f => f.type === 'keyValue'),
    [plugin]
  );

  useEffect(() => {
    if (editingConnection?.dbConfig) {
      const dbConfig = { ...editingConnection.dbConfig };

      // Rebuild the editor rows from the stored key names. Values stay blank —
      // the renderer never pulls decrypted secrets back out of the keychain,
      // and a blank value on save means "keep the stored one".
      keyValueFields.forEach(f => {
        const savedKeys = f.publicKeysField ? editingConnection.dbConfig[f.publicKeysField] : null;
        dbConfig[f.name] = Array.isArray(savedKeys)
          ? savedKeys.map(k => ({ key: String(k), value: '' }))
          : [];
      });

      form.setFieldsValue(dbConfig);

      // Check if OAuth tokens exist
      if (plugin.authType === 'oauth2' && editingConnection.dbConfig.accessToken) {
        setIsAuthorized(true);
      }
    } else {
      // Set default values from schema
      const defaults = {};
      plugin.configSchema?.fields?.forEach(field => {
        if (field.default !== undefined) {
          defaults[field.name] = field.default;
        }
      });
      keyValueFields.forEach(f => { defaults[f.name] = defaults[f.name] || []; });
      form.setFieldsValue(defaults);
    }
  }, [editingConnection, plugin, form, keyValueFields]);

  // Cleanup OAuth server on unmount
  useEffect(() => {
    return () => {
      // console.log('window.electronAPI?.oauth?.cancelServer: ', window.electronAPI?.oauth)
      if (window.electronAPI?.oauth?.cancelServer && authorizing) {
        console.log('[DynamicConnectionForm] Cleaning up OAuth server on unmount');
        window.electronAPI.oauth.cancelServer(3000);
      }
    };
  }, [authorizing]);

  const handleTest = async () => {
    try {
      const values = applyKeyValueFields(await form.validateFields());
      setTesting(true);
      await onTest(plugin.id, values);
    } catch (error) {
      console.error('Validation failed:', error);
    } finally {
      setTesting(false);
    }
  };

  /**
   * Collapse every keyValue field into its saved shape:
   *   - blank keys dropped (a value with no key has nowhere to go)
   *   - capped at maxPairs
   *   - key names mirrored into `publicKeysField` so the rest of the app can
   *     name the pairs without ever touching the encrypted values
   * Mutates and returns `values`.
   */
  const applyKeyValueFields = (values) => {
    keyValueFields.forEach(f => {
      const pairs = normalisePairs(values[f.name]).slice(0, f.maxPairs || MAX_PAIRS);
      values[f.name] = pairs;
      if (f.publicKeysField) values[f.publicKeysField] = pairs.map(p => p.key);
    });
    return values;
  };

  const handleSave = async () => {
    try {
      const values = applyKeyValueFields(await form.validateFields());
      setSaving(true);

      const connectionData = {
        name: values.connectionName || `${plugin.name} Connection`,
        description: values.description || `Connection to ${plugin.name}`,
        connectionType: 'database',
        dbType: plugin.id,
        dbCategory: plugin.dbCategory || null,
        dbConfig: { ...values },
      };
      // console.log('connectionData: ', connectionData)
      // Remove form-only fields from dbConfig
      delete connectionData.dbConfig.connectionName;
      delete connectionData.dbConfig.description;

      await onSave(connectionData);
    } catch (error) {
      console.error('Validation failed:', error);
      message.error('Please fill in all required fields');
    } finally {
      setSaving(false);
    }
  };

  const handleOAuthAuthorize = async () => {
    if (!window.electronAPI?.oauth) {
      message.error('OAuth is only available in the desktop app');
      return;
    }

    let serverPromise = null;
    let timeoutId = null;

    try {
      setAuthorizing(true);
      const values = form.getFieldsValue();

      // Validate required OAuth fields (clientId, clientSecret)
      const requiredFields = ['clientId', 'clientSecret'];
      const missingFields = requiredFields.filter(field => !values[field]);
      if (missingFields.length > 0) {
        message.error(`Please fill in: ${missingFields.join(', ')}`);
        setAuthorizing(false);
        return;
      }

      // Step 1: Start local callback server (don't await yet - let it run in background)
      message.loading('Starting OAuth flow...', 0);
      serverPromise = window.electronAPI.oauth.startCallbackServer(3000);

      // Step 2: Get authorization URL
      const authResult = await window.electronAPI.oauth.getAuthorizationUrl(plugin.id, values);

      if (!authResult.success) {
        message.destroy();
        message.error('Failed to generate authorization URL: ' + authResult.message);
        setAuthorizing(false);
        return;
      }

      // Step 3: Open browser
      await window.electronAPI.oauth.openBrowser(authResult.authUrl);
      message.destroy();

      // Show info message with key to destroy it
      const hideMessage = message.info('Browser opened. Please complete authorization...');

      // Step 4: Wait for callback with timeout (2 minutes)
      // Race between server callback and timeout
      const serverResult = await Promise.race([
        serverPromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('Authorization timed out'));
          }, 2 * 60 * 1000); // 2 minutes timeout
        })
      ]);

      // Clear timeout if we got a result
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      hideMessage();
      console.log('serverResult: ', serverResult)
      if (!serverResult.success) {
        message.error(serverResult.error || serverResult.message || 'OAuth authorization failed');
        setAuthorizing(false);
        return;
      }

      // Step 5: Exchange code for tokens
      message.loading('Exchanging authorization code for tokens...', 0);
      const tokenResult = await window.electronAPI.oauth.exchangeCode(
        plugin.id,
        values,
        serverResult.code,
        serverResult.state
      );

      message.destroy();
      console.log('tokenResult: ', tokenResult)
      if (!tokenResult.success) {
        message.error('Failed to exchange code for tokens: ' + tokenResult.message);
        setAuthorizing(false);
        return;
      }
      // console.log('tokenResult: ', tokenResult)
      // Step 6: Update form with tokens
      form.setFieldsValue({
        accessToken: tokenResult.tokens.accessToken,
        refreshToken: tokenResult.tokens.refreshToken,
        expiryDate: tokenResult.tokens.expiryDate,
      });

      setIsAuthorized(true);
      message.success('Authorization successful! You can now save the connection.');
    } catch (error) {
      console.error('OAuth authorization error:', error);

      // Clean up timeout if it exists
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Cancel the OAuth server
      if (window.electronAPI?.oauth?.cancelServer) {
        window.electronAPI.oauth.cancelServer(3000);
      }

      // Show appropriate error message
      if (error.message.includes('timed out')) {
        message.error('Authorization timed out. Please try again.');
      } else {
        message.error('OAuth authorization failed: ' + error.message);
      }
    } finally {
      setAuthorizing(false);
      message.destroy();
    }
  };
  
  const renderField = (field) => {
    const rules = [
      {
        required: field.required,
        message: `${field.label} is required`,
      },
    ];

    switch (field.type) {
      // Declared in the schema so the save path can classify it (sensitive vs
      // not), but written programmatically — never rendered.
      case 'internal':
        return null;

      case 'hidden':
        // Render hidden fields so form tracks them, but hide from UI
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            hidden
          >
            <Input type="hidden" />
          </Form.Item>
        );

      case 'number':
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={rules}
            tooltip={field.helpText}
          >
            <InputNumber
              style={{ width: '100%' }}
              placeholder={field.placeholder}
            />
          </Form.Item>
        );

      case 'boolean':
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            valuePropName="checked"
            tooltip={field.helpText}
          >
            <Switch />
          </Form.Item>
        );

      case 'password':
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={rules}
            tooltip={field.helpText}
          >
            <Input.Password
              placeholder={field.placeholder}
              autoComplete="new-password"
            />
          </Form.Item>
        );

      case 'keyValue':
        return (
          <KeyValueFields
            key={field.name}
            field={field}
            editing={Boolean(editingConnection)}
          />
        );

      case 'select':
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={rules}
            tooltip={field.helpText}
          >
            <Select
              placeholder={field.placeholder}
              options={(field.options || []).map(opt =>
                typeof opt === 'string'
                  ? { value: opt, label: opt }
                  : { value: opt.value, label: opt.label ?? String(opt.value) }
              )}
            />
          </Form.Item>
        );

      case 'textarea':
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={rules}
            tooltip={field.helpText}
          >
            <Input.TextArea
              placeholder={field.placeholder}
              rows={field.rows || 3}
            />
          </Form.Item>
        );

      case 'string':
      default:
        return (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={rules}
            tooltip={field.helpText}
          >
            <Input
              placeholder={field.placeholder}
            />
          </Form.Item>
        );
    }
  };

  // Resolve fields visible given current form values. Supports
  //   visibleWhen: { fieldName: 'expectedValue' | [values...] }
  // All listed fields must match for the row to show. Fields without
  // `visibleWhen` are always visible.
  const watchedValues = Form.useWatch([], form) || {};
  const isFieldVisible = (field) => {
    if (!field.visibleWhen) return true;
    return Object.entries(field.visibleWhen).every(([k, expected]) => {
      const actual = watchedValues[k];
      if (Array.isArray(expected)) return expected.includes(actual);
      return actual === expected;
    });
  };
  const visibleFields = (plugin.configSchema?.fields || []).filter(isFieldVisible);

  return (
    // Cap the form to the viewport. A cloud-storage/OAuth connector renders
    // name + description + every credential field + the authorize block + an
    // alert — around 900px — and the popup hosting this sizes to its content,
    // so without a cap it grows past the bottom of the window and sits low
    // with its buttons below the fold. The FIELDS scroll instead, keeping the
    // popup short (so it stays high on screen) and the action row in view.
    <div style={{
      padding: '20px 0',
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 'calc(100vh - 200px)',
    }}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          connectionName: editingConnection?.name || '',
          description: editingConnection?.description || '',
        }}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        {/* Scrolls when the connector has more fields than the window fits.
            The right padding keeps the scrollbar off the inputs. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        {/* Every password/keyValue field below is written to db-credentials.dat.
            Says so up front when this machine cannot actually protect it. */}
        <SecretStorageWarning />
        {/* Connection metadata fields */}
        <Form.Item
          name="connectionName"
          label="Connection Name"
          rules={[
            { required: true, message: 'Connection name is required' },
            uniqueNameRule(existingConnections, editingConnection),
          ]}
        >
          <Input placeholder={`${plugin.name} Database`} />
        </Form.Item>

        <Form.Item
          name="description"
          label="Description"
        >
          <Input.TextArea
            placeholder="Optional description for this connection"
            rows={2}
          />
        </Form.Item>

        {/* Dynamic fields from plugin configSchema (respecting visibleWhen) */}
        {visibleFields.map(renderField)}

        {/* OAuth2.0 Authorization */}
        {plugin.authType === 'oauth2' && (
          <>
            <Form.Item style={{ marginTop: 24 }}>
              {isAuthorized ? (
                <Alert
                  message="Authorization Successful"
                  description="This connection has been authorized. You can now test and save it."
                  type="success"
                  icon={<CheckCircleOutlined />}
                  showIcon
                />
              ) : (
                <Button
                  type="default"
                  size="large"
                  icon={<LinkOutlined />}
                  onClick={handleOAuthAuthorize}
                  loading={authorizing}
                  block
                  style={{
                    height: 48,
                    fontSize: 16,
                    borderColor: '#1890ff',
                    color: '#1890ff',
                  }}
                >
                  {authorizing ? 'Authorizing...' : `Authorize with ${plugin.name}`}
                </Button>
              )}
            </Form.Item>

            {!isAuthorized && (
              <Alert
                message="Authorization Required"
                description="Please fill in your OAuth credentials above, then click the authorize button to complete the OAuth flow."
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}
          </>
        )}
        </div>

        {/* Action buttons — outside the scroll region so they stay reachable. */}
        <Form.Item style={{ marginBottom: 0, marginTop: 24, flexShrink: 0 }}>
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={onCancel}>
              Cancel
            </Button>
            {plugin.authType !== 'oauth2' && (
              <Button onClick={handleTest} loading={testing}>
                Test Connection
              </Button>
            )}
            <Button
              type="primary"
              onClick={handleSave}
              loading={saving}
              disabled={plugin.authType === 'oauth2' && !isAuthorized}
            >
              {editingConnection ? 'Update' : 'Save'} Connection
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </div>
  );
};

export default DynamicConnectionForm;
