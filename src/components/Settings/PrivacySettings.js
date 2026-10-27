import React, { useState, useEffect } from 'react';
import { Card, Switch, Button, message, Typography, Space, Alert, Tag } from 'antd';
import { SafetyOutlined, BarChartOutlined, SaveOutlined, LockOutlined } from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

const STORAGE_KEY_ANALYTICS = 'ternlux_analytics_opt_in';
const STORAGE_KEY_ACCEPTED_AT = 'ternlux_terms_accepted_at';
const STORAGE_KEY_TERMS_VERSION = 'ternlux_terms_version';

const PrivacySettings = () => {
  const [analyticsOptIn, setAnalyticsOptIn] = useState(false);
  const [initialOptIn, setInitialOptIn] = useState(false);
  const [acceptedAt, setAcceptedAt] = useState(null);
  const [termsVersion, setTermsVersion] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY_ANALYTICS);
    const optIn = stored === 'true';
    setAnalyticsOptIn(optIn);
    setInitialOptIn(optIn);
    setAcceptedAt(localStorage.getItem(STORAGE_KEY_ACCEPTED_AT));
    setTermsVersion(localStorage.getItem(STORAGE_KEY_TERMS_VERSION));
  }, []);

  const isDirty = analyticsOptIn !== initialOptIn;

  const handleSave = async () => {
    setLoading(true);
    try {
      localStorage.setItem(STORAGE_KEY_ANALYTICS, analyticsOptIn ? 'true' : 'false');
      localStorage.setItem('ternlux_analytics_updated_at', new Date().toISOString());

      try {
        await window.electronAPI?.analytics?.setOptIn(analyticsOptIn);
      } catch (e) {
        console.warn('Could not push analytics opt-in to main:', e);
      }

      setInitialOptIn(analyticsOptIn);
      message.success(
        analyticsOptIn
          ? 'Analytics sharing enabled. Thanks for helping us improve Ternlux!'
          : 'Analytics sharing disabled.'
      );
    } catch (e) {
      message.error('Failed to update privacy preferences.');
    } finally {
      setLoading(false);
    }
  };

  const formatAcceptedAt = (iso) => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Header */}
        <div>
          <Title level={3}>
            <SafetyOutlined style={{ marginRight: 12, color: '#1890ff' }} />
            Privacy & Analytics
          </Title>
          <Paragraph type="secondary">
            Control what usage data Ternlux collects. Your workflow contents and credentials
            are never shared.
          </Paragraph>
        </div>

        {/* Analytics opt-in card */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: analyticsOptIn ? '#1890ff' : '#f0f0f0',
                color: analyticsOptIn ? '#fff' : '#8c8c8c',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'all 0.15s ease',
              }}
            >
              <BarChartOutlined style={{ fontSize: 22 }} />
            </div>

            <div style={{ flex: 1 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                  marginBottom: 8,
                }}
              >
                <Text strong style={{ fontSize: 15 }}>
                  Share anonymous analytics
                </Text>
                <Switch
                  checked={analyticsOptIn}
                  onChange={setAnalyticsOptIn}
                  checkedChildren="On"
                  unCheckedChildren="Off"
                />
              </div>
              <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
                Help us improve Ternlux by sharing anonymous usage data — feature
                interactions, performance metrics, and crash reports. We never collect
                your workflow contents, credentials, or personally identifiable
                information.
              </Paragraph>

              <Space size={4} style={{ flexWrap: 'wrap' }}>
                <Tag icon={<LockOutlined />} color="default">Anonymous</Tag>
                <Tag color="default">Aggregated</Tag>
                <Tag color="default">No workflow data</Tag>
              </Space>
            </div>
          </div>
        </Card>

        {/* What we collect / don't collect */}
        <Card size="small" style={{ background: '#f6ffed', borderColor: '#b7eb8f' }}>
          <Text strong style={{ color: '#389e0d' }}>What we collect when enabled</Text>
          <ul style={{ marginTop: 8, marginBottom: 0, color: '#595959', fontSize: 13, marginLeft: 15 }}>
            <li>App version, OS, and locale</li>
            <li>Feature usage counts (e.g. how often a node type is added)</li>
            <li>Performance metrics and anonymized crash reports</li>
          </ul>
        </Card>

        <Card size="small" style={{ background: '#fff1f0', borderColor: '#ffa39e' }}>
          <Text strong style={{ color: '#cf1322' }}>What we never collect</Text>
          <ul style={{ marginTop: 8, marginBottom: 0, color: '#595959', fontSize: 13, marginLeft: 15 }}>
            <li>Your workflow contents, queries, or data</li>
            <li>API keys, passwords, or connection credentials</li>
            <li>Personally identifiable information</li>
            <li>The contents of files you import or export</li>
          </ul>
        </Card>

        {/* Save button */}
        <Button
          type="primary"
          size="large"
          icon={<SaveOutlined />}
          loading={loading}
          onClick={handleSave}
          disabled={!isDirty}
          block
        >
          {isDirty ? 'Save Privacy Preferences' : 'Saved'}
        </Button>

        {/* Terms acceptance footer */}
        {(acceptedAt || termsVersion) && (
          <Alert
            type="info"
            showIcon
            message="Terms acceptance"
            description={
              <Space direction="vertical" size={2}>
                {termsVersion && (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    Accepted Terms version <Text strong>{termsVersion}</Text>
                  </Text>
                )}
                {acceptedAt && (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    on {formatAcceptedAt(acceptedAt)}
                  </Text>
                )}
              </Space>
            }
          />
        )}
      </Space>
    </div>
  );
};

export default PrivacySettings;
