import React, { useState, useEffect } from 'react';
import { Form, Select, AutoComplete, Card, Button, message, Divider, Typography, Space, Alert } from 'antd';
import { RobotOutlined, CheckCircleOutlined, SaveOutlined, EditOutlined } from '@ant-design/icons';
import ProviderKeyForm from '../ApiKeySetup/ProviderKeyForm';
import OthersProviderForm from '../ApiKeySetup/OthersProviderForm';
import { hasApiKeyForProvider } from '../../utils/apiKeyStorage';
import {
  OPENAI_COMPAT_PROVIDERS,
  DEFAULT_MAX_TOKENS,
  loadDefaultAiSettings,
  saveDefaultAiSettings,
} from '../../utils/aiProviders';
import AI_CONFIG from '../../config/aiProviders.json';
import useProviderModels, { COMPAT_IDS } from '../../utils/useProviderModels';

const { Option } = Select;
const { Title, Text, Paragraph } = Typography;

const PROVIDER_INFO = AI_CONFIG.PROVIDER_INFO;

// Built-in providers plus every OpenAI-compatible provider — used to detect
// which providers already have a key/config stored.
const PROVIDER_IDS = ['gemini', 'claude', 'openai', ...COMPAT_IDS];

// Display name + accent color for any provider id (built-in or compat).
const getProviderInfo = (id) =>
  PROVIDER_INFO[id] ||
  (OPENAI_COMPAT_PROVIDERS[id]
    ? { name: OPENAI_COMPAT_PROVIDERS[id].name, color: OPENAI_COMPAT_PROVIDERS[id].color }
    : { name: id, color: '#8c8c8c' });

const ProviderSettings = () => {
  const [form] = Form.useForm();
  const [selectedProvider, setSelectedProvider] = useState('claude');
  // The provider every AI feature actually uses. The model + Max Tokens shown
  // in the "Default AI Provider" card belong to THIS provider, not to whichever
  // one is open in the "Configure Provider" section below (that section only
  // manages API keys).
  const [defaultProvider, setDefaultProviderValue] = useState(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [providerHasKey, setProviderHasKey] = useState(true); // Track if selected provider has key
  const [changingKey, setChangingKey] = useState(false); // Replace-key form for a provider that already has one
  const [configuredProviders, setConfiguredProviders] = useState([]); // Providers that have an API key
  // Shared with onboarding (ApiKeySetup) so both screens resolve models and the
  // Max Tokens ladder the same way — see utils/useProviderModels.
  const {
    models,
    loading: modelsLoading,
    load: loadProviderModels,
    capFor,
    contextFor,
    tokenOptions,
  } = useProviderModels();

  // Load saved settings on mount. The saved default must be in the form before
  // refreshConfiguredProviders runs: it preselects the first keyed provider only
  // when no default is set.
  useEffect(() => {
    (async () => {
      const defaultId = await loadSettings();
      initSelectedProvider(defaultId);
      checkApiKey();
      refreshConfiguredProviders();
    })();
  }, []);

  // Resolve which provider panel to open on — the default provider, else the
  // first provider that has a saved key — so Settings reflects the
  // actually-configured provider instead of always showing Claude (and its false
  // "No API Key" warning).
  const initSelectedProvider = async (defaultId) => {
    try {
      let candidate = defaultId || null;
      if (!candidate) {
        const checks = await Promise.all(PROVIDER_IDS.map((id) => hasApiKeyForProvider(id)));
        candidate = PROVIDER_IDS.find((_, i) => checks[i]) || null;
      }

      // Nothing configured at all: open on Claude, as before.
      setSelectedProvider(candidate || 'claude');
      form.setFieldValue('provider', candidate || 'claude');
    } catch (e) {
      console.warn('[ProviderSettings] could not resolve configured provider:', e);
    }
  };

  // Check API key for selected provider when it changes
  useEffect(() => {
    checkProviderApiKey(selectedProvider);
  }, [selectedProvider]);

  // (Re)load the model list whenever the DEFAULT provider changes — that's the
  // provider the model belongs to. For OpenAI-compatible providers the current
  // model lives in their encrypted entry, so seed the field from there first;
  // loadModels then only supplies suggestions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (defaultProvider && COMPAT_IDS.includes(defaultProvider)) {
        let stored;
        try {
          const res = await window.electronAPI?.ai?.getCompatProvider?.(defaultProvider);
          stored = res?.meta?.model || undefined;
        } catch (e) {
          console.warn('[ProviderSettings] could not read compat provider config:', e);
        }
        if (cancelled) return;
        // Always assign: an empty stored model must clear whatever the previous
        // provider left in the field.
        form.setFieldValue('model', stored);
      }
      if (!cancelled) loadModels(defaultProvider);
    })();
    return () => { cancelled = true; };
  }, [defaultProvider]);

  // Keep the form field and its state copy in lockstep: the model list and the
  // Max Tokens cap are derived from the default provider.
  const applyDefaultProvider = (id) => {
    form.setFieldValue('defaultProvider', id || undefined);
    setDefaultProviderValue(id || null);
  };

  // Read the saved default provider, model and Max Tokens from the main process
  // — the only store, and exactly what every AI call uses. Returns the default
  // provider id (or null).
  const loadSettings = async () => {
    try {
      const saved = await loadDefaultAiSettings();
      const isCompat = !!saved.provider && COMPAT_IDS.includes(saved.provider);
      // The model goes in BEFORE the provider: setting the provider starts the
      // model-list load, which keeps the current value only if it is listed.
      // A compat provider's model lives in its encrypted entry instead — the
      // default-provider effect seeds the field from there. With no saved
      // model, loadModels fills it from the provider's live list.
      form.setFieldsValue({
        model: !isCompat && saved.model && saved.modelProvider === saved.provider
          ? saved.model : undefined,
        maxTokens: saved.maxTokens || DEFAULT_MAX_TOKENS,
      });
      applyDefaultProvider(saved.provider);
      return saved.provider;
    } catch (error) {
      console.error('Error loading provider settings:', error);
      form.setFieldsValue({ maxTokens: DEFAULT_MAX_TOKENS });
      return null;
    }
  };

  const checkApiKey = async () => {
    try {
      // Check if ANY API key is configured (safe - doesn't expose key value)
      const { hasAnyApiKey } = await import('../../utils/apiKeyStorage');
      const keyExists = await hasAnyApiKey();
      setHasApiKey(keyExists);
    } catch (error) {
      console.error('Error checking API key:', error);
      setHasApiKey(false);
    }
  };

  const refreshConfiguredProviders = async () => {
    try {
      const checks = await Promise.all(PROVIDER_IDS.map((id) => hasApiKeyForProvider(id)));
      const configured = PROVIDER_IDS.filter((_, i) => checks[i]);
      setConfiguredProviders(configured);
      // If no default has been chosen yet, preselect the first configured provider
      if (configured.length > 0 && !form.getFieldValue('defaultProvider')) {
        applyDefaultProvider(configured[0]);
      }
    } catch (error) {
      console.error('Error checking configured providers:', error);
    }
  };

  const checkProviderApiKey = async (provider) => {
    try {

      const keyExists = await hasApiKeyForProvider(provider);
      console.log('keyExists: ', keyExists, provider)
      setProviderHasKey(keyExists);
    } catch (error) {
      console.error('Error checking provider API key:', error);
      setProviderHasKey(false);
    }
  };

  // Populate the model dropdown for the default `provider`. Fetches the live
  // list via the SDK; falls back to the bundled curated list when that isn't
  // possible (outside Electron, or the call fails). Reconciles the form's
  // selected model so it stays valid for whatever list we end up with — this is
  // what stops a Claude model id from surviving a switch to OpenAI.
  const loadModels = (provider) => loadProviderModels(provider, {
    onModelsLoaded: (list, { isCompat }) => {
      const current = form.getFieldValue('model');
      if (isCompat) {
        // A compat endpoint may serve model ids it doesn't enumerate (and local
        // servers list none at all), so a stored id is never overruled — the
        // list is only a suggestion source, and only fills an empty field.
        if (!current && list.length > 0) form.setFieldValue('model', list[0].value);
        return;
      }
      if (list.length > 0 && !list.some((m) => m.value === current)) {
        form.setFieldValue('model', list[0].value);
      }
    },
  });

  // Switching the panel below only changes which provider's API key you're
  // managing — it doesn't touch the model, which follows the default provider.
  const handleProviderChange = (provider) => {
    setSelectedProvider(provider);
    setChangingKey(false);
  };

  const handleKeySetupComplete = async () => {
    // After key is saved, refresh checks
    await checkApiKey();
    await checkProviderApiKey(selectedProvider);
    await refreshConfiguredProviders();
    message.success('API key configured successfully!');
  };

  const handleKeyChanged = async () => {
    await checkApiKey();
    await checkProviderApiKey(selectedProvider);
    await refreshConfiguredProviders();
    setChangingKey(false);
    message.success('API key updated successfully!');
  };

  // An OpenAI-compatible ("Others") provider was configured. Refresh the
  // configured list and make it the default if no default is set yet.
  const handleOthersComplete = async ({ provider } = {}) => {
    await checkApiKey();
    await refreshConfiguredProviders();
    if (provider && !form.getFieldValue('defaultProvider')) {
      applyDefaultProvider(provider);
      // Compat providers carry their model in the encrypted key entry, so no
      // model is passed here (main resolves it downstream).
      try {
        await saveDefaultAiSettings({ provider });
      } catch (e) {
        console.error('[ProviderSettings] Could not persist compat default to main:', e);
      }
    }
    message.success('Provider configured successfully!');
  };

  // Save the default provider together with the model and Max Tokens that
  // belong to it — one section, one button, written straight to the main
  // process (the same write onboarding makes). The provider/model pair is
  // written as a unit so a model can never outlive the provider it was chosen
  // for.
  const handleSaveDefault = async () => {
    try {
      setSavingDefault(true);
      const values = form.getFieldsValue();
      const provider = values.defaultProvider;
      if (!provider) {
        message.warning('Select a default provider first.');
        return;
      }

      const isCompat = COMPAT_IDS.includes(provider);
      const model = (values.model || '').trim() || undefined;
      if (!model) {
        message.warning('Select a model for this provider.');
        return;
      }

      // A compat provider's model lives in its encrypted entry — that's what
      // the main process reads when a call doesn't name one. Writing only the
      // model preserves the stored key and base URL.
      if (isCompat) {
        const res = await window.electronAPI?.ai?.saveCompatProvider?.(provider, { model });
        if (res && res.success === false) {
          throw new Error(res.error || 'Failed to save the model for this provider');
        }
      }

      // Max Tokens is clamped to what the chosen model accepts.
      await saveDefaultAiSettings({
        provider,
        model: isCompat ? undefined : model,
        maxTokens: values.maxTokens || DEFAULT_MAX_TOKENS,
        cap: capFor(model),
      });
      message.success('Default AI provider saved!');
    } catch (error) {
      console.error('Error saving default provider:', error);
      message.error(error.message || 'Failed to save default provider');
    } finally {
      setSavingDefault(false);
    }
  };

  const currentProviderInfo = PROVIDER_INFO[selectedProvider];
  const isCompatDefault = !!defaultProvider && COMPAT_IDS.includes(defaultProvider);


  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Header */}
        <div>
          <Title level={3}>
            <RobotOutlined style={{ marginRight: 12, color: '#1890ff' }} />
            AI Provider Configuration
          </Title>
          <Paragraph type="secondary">
            Configure which AI provider and model to use for workflow assistance and data transformations.
          </Paragraph>
        </div>



        {/* Provider Selection Card */}
        <Card>
          <Form
            form={form}
            layout="vertical"
          >
            {/* Default provider — provider + its model + its Max Tokens, saved
                together by one button. This is what every AI feature uses; the
                "Configure Provider" section below only manages API keys. */}
            {configuredProviders.length > 0 && (
              <Card
                size="small"
                type="inner"
                title="Default AI Provider"
                style={{ marginBottom: 24, background: '#fafafa' }}
              >
                <Form.Item
                  name="defaultProvider"
                  help={
                    configuredProviders.length > 1
                      ? 'You have multiple providers configured. AI features (chat, workflow build, transforms) will use this one.'
                      : 'AI features will use this provider. Configure more providers below to switch between them.'
                  }
                  style={{ marginBottom: 16 }}
                >
                  <Select
                    size="large"
                    placeholder="Select default provider"
                    getPopupContainer={(trigger) => trigger.parentNode}
                    onChange={applyDefaultProvider}
                  >
                    {configuredProviders.map((id) => (
                      <Option key={id} value={id}>
                        <Space>
                          <span style={{ color: getProviderInfo(id).color, fontWeight: 600 }}>●</span>
                          {getProviderInfo(id).name}
                        </Space>
                      </Option>
                    ))}
                  </Select>
                </Form.Item>

                {/* Model for the default provider. The list is refetched from
                    that provider whenever it changes, and a model that isn't in
                    the new list is replaced — a Claude model can't survive a
                    switch to OpenAI. OpenAI-compatible endpoints get a free-text
                    field with their /models list as suggestions: they accept ids
                    they don't always enumerate, and local servers list none. */}
                {isCompatDefault ? (
                  <Form.Item
                    label="Model"
                    name="model"
                    rules={[{ required: true, message: 'Enter the model id to use' }]}
                    help={`The exact model id ${getProviderInfo(defaultProvider).name} expects. Suggestions are its published models — you can type any id it accepts.`}
                    style={{ marginBottom: 16 }}
                  >
                    <AutoComplete
                      size="large"
                      placeholder={OPENAI_COMPAT_PROVIDERS[defaultProvider]?.placeholderModel || 'model-id'}
                      options={models.map((m) => ({ value: m.value }))}
                      filterOption={(input, option) =>
                        String(option?.value || '').toLowerCase().includes(String(input || '').toLowerCase())
                      }
                      getPopupContainer={(trigger) => trigger.parentNode}
                      notFoundContent={modelsLoading ? 'Loading models…' : null}
                    />
                  </Form.Item>
                ) : defaultProvider ? (
                  <Form.Item
                    label="Model"
                    name="model"
                    rules={[{ required: true, message: 'Please select a model' }]}
                    style={{ marginBottom: 16 }}
                  >
                    <Select
                      size="large"
                      placeholder="Select model"
                      getPopupContainer={(trigger) => trigger.parentNode}
                      optionLabelProp="label"
                      loading={modelsLoading}
                      notFoundContent={modelsLoading ? 'Loading models…' : 'No models found'}
                    >
                      {models.map((model) => (
                        <Option
                          key={model.value}
                          value={model.value}
                          label={
                            <>
                              {model.label}
                              {model.description.includes('Recommended') && (
                                <CheckCircleOutlined
                                  style={{ marginLeft: 8, color: '#52c41a' }}
                                />
                              )}
                            </>
                          }
                        >
                          <div>
                            <div style={{ fontWeight: 500 }}>
                              {model.label}
                              {model.description.includes('Recommended') && (
                                <CheckCircleOutlined
                                  style={{ marginLeft: 8, color: '#52c41a' }}
                                />
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                              {model.description}
                            </div>
                          </div>
                        </Option>
                      ))}
                    </Select>
                  </Form.Item>
                ) : null}

                <Divider style={{ marginTop: 8 }} />

                {/* Advanced Settings */}
                <Title level={5}>Advanced Settings</Title>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  Configure maximum response length for AI outputs.
                </Paragraph>

                {/* Bounded by the selected model's published output limit, read
                    from the same provider models endpoint that fills the model
                    dropdown. Providers that don't publish limits get the full
                    ladder. */}
                <Form.Item noStyle shouldUpdate={(prev, cur) => prev.model !== cur.model}>
                  {({ getFieldValue }) => {
                    const model = getFieldValue('model');
                    const selected = models.find((m) => m.value === model);
                    const cap = capFor(model);
                    const ctx = contextFor(model);
                    return (
                      <Form.Item
                        label="Max Tokens"
                        name="maxTokens"
                        help={
                          cap
                            ? `Maximum length of AI responses. ${selected.label} accepts up to ${cap.toLocaleString()} output tokens${ctx ? ` and a ${ctx.toLocaleString()}-token context window` : ''}. Reasoning models spend part of this budget thinking before they answer, so low values can cut a reply short.`
                            : 'Maximum length of AI responses. This provider does not publish per-model limits, so an unsupported value is rejected at request time. Reasoning models spend part of this budget thinking before they answer, so low values can cut a reply short.'
                        }
                        style={{ marginBottom: 20 }}
                      >
                        <Select getPopupContainer={(trigger) => trigger.parentNode}>
                          {tokenOptions(model).map((o) => (
                            <Option key={o.value} value={o.value}>{o.label}</Option>
                          ))}
                        </Select>
                      </Form.Item>
                    );
                  }}
                </Form.Item>

                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={savingDefault}
                  onClick={handleSaveDefault}
                >
                  Save Default Provider
                </Button>
              </Card>
            )}

            {/* Provider Selection — API keys only. The model and Max Tokens
                live with the default provider above. */}
            <Form.Item
              label="Configure Provider"
              name="provider"
              help="Add or replace the API key for a provider. Which provider the app actually uses — and with which model — is set above."
              rules={[{ required: true, message: 'Please select a provider' }]}
            >
              <Select
                size="large"
                onChange={handleProviderChange}
                placeholder="Select AI provider"
                getPopupContainer={(trigger) => trigger.parentNode}
              >
                <Option value="gemini">
                  <Space>
                    <span style={{ color: PROVIDER_INFO.gemini.color, fontWeight: 600 }}>●</span>
                    Google Gemini
                  </Space>
                </Option>
                <Option value="claude">
                  <Space>
                    <span style={{ color: PROVIDER_INFO.claude.color, fontWeight: 600 }}>●</span>
                    Anthropic Claude
                  </Space>
                </Option>
                <Option value="openai">
                  <Space>
                    <span style={{ color: PROVIDER_INFO.openai.color, fontWeight: 600 }}>●</span>
                    OpenAI ChatGPT
                  </Space>
                </Option>
                <Option value="others">
                  <Space>
                    <span style={{ color: '#8c8c8c', fontWeight: 600 }}>●</span>
                    Others (OpenAI-compatible)
                  </Space>
                </Option>
              </Select>
            </Form.Item>

            {// "Others" = OpenAI-compatible providers (own dropdown + URL/key/model form).
             // Otherwise: no key → show the key form; key present → offer to replace it.
            }
  {selectedProvider === 'others' ? (
    <div>
      <Card
        size="small"
        style={{ marginBottom: 24, borderLeft: '4px solid #8c8c8c', background: '#fafafa' }}
      >
        <Text strong>Others (OpenAI-compatible)</Text>
        <br />
        <Text type="secondary" style={{ fontSize: 13 }}>
          Connect OpenRouter, Groq, Together AI, Mistral, Ollama, LM Studio, or any
          OpenAI-compatible endpoint. Pick a type to prefill its URL, or choose Custom to set your own.
        </Text>
      </Card>
      <OthersProviderForm onComplete={handleOthersComplete} />
    </div>
  ) : (!providerHasKey) ?

      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Header */}
          <div>
            <Title level={3}>
              <RobotOutlined style={{ marginRight: 12, color: '#1890ff' }} />
              Configure {PROVIDER_INFO[selectedProvider]?.name || selectedProvider}
            </Title>
            <Paragraph type="secondary">
              Set up your API key for {PROVIDER_INFO[selectedProvider]?.name || selectedProvider} to use this provider.
            </Paragraph>
          </div>

          {/* Alert explaining the situation */}
          <Alert
            message={`No API Key for ${PROVIDER_INFO[selectedProvider]?.name || selectedProvider}`}
            description={`You need to configure an API key for ${PROVIDER_INFO[selectedProvider]?.name || selectedProvider} before you can select models and configure settings for this provider.`}
            type="info"
            showIcon
          />

          {/* Provider Key Form - embedded */}
          <div style={{ marginTop: 16 }}>
            <ProviderKeyForm
              providerId={selectedProvider}
              onComplete={handleKeySetupComplete}
              compact={true}
            />
          </div>
        </Space>
      </div> :
  
            <div>
            {/* Provider Info */}
            {currentProviderInfo && (
              <Card
                size="small"
                style={{
                  marginBottom: 24,
                  borderLeft: `4px solid ${currentProviderInfo.color}`,
                  background: '#fafafa'
                }}
              >
                <Text strong>{currentProviderInfo.name}</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {currentProviderInfo.description}
                </Text>
              </Card>
            )}

            {/* API key management — the key exists; allow replacing it */}
            {!changingKey ? (
              <Alert
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
                message={`API key configured for ${currentProviderInfo?.name || selectedProvider}`}
                description="The key is encrypted and stored on this device."
                action={
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => setChangingKey(true)}
                  >
                    Change Key
                  </Button>
                }
                style={{ marginBottom: 24 }}
              />
            ) : (
              <Card
                size="small"
                title={`Change ${currentProviderInfo?.name || selectedProvider} API key`}
                extra={
                  <Button size="small" type="text" onClick={() => setChangingKey(false)}>
                    Cancel
                  </Button>
                }
                style={{ marginBottom: 24 }}
              >
                <Alert
                  type="warning"
                  showIcon
                  message="Saving a new key replaces the current one immediately."
                  style={{ marginBottom: 16 }}
                />
                <ProviderKeyForm
                  providerId={selectedProvider}
                  onComplete={handleKeyChanged}
                  compact={true}
                />
              </Card>
            )}

            {/* Nothing else to configure here: the model and Max Tokens for
                the provider the app uses live in "Default AI Provider" above. */}
            {defaultProvider !== selectedProvider && (
              <Text type="secondary" style={{ fontSize: 13 }}>
                To use {currentProviderInfo?.name || selectedProvider} for AI features,
                select it as the default provider above and pick its model.
              </Text>
            )}
            </div>}
          </Form>
        </Card>

        {/* Info Card */}
        <Card size="small" style={{ background: '#f0f5ff', borderColor: '#adc6ff' }}>
          <Text strong style={{ color: '#1890ff' }}>
            💡 How it works
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 13 }}>
            The default provider and its model are used for all AI-powered features including:
            <ul style={{ marginTop: 8, marginBottom: 0 }}>
              <li>Workflow node configuration assistance</li>
              <li>SQL query generation from natural language</li>
              <li>Data transformation suggestions</li>
              <li>Business intelligence chat responses</li>
            </ul>
          </Text>
        </Card>
      </Space>
    </div>
  );
};

export default ProviderSettings;
