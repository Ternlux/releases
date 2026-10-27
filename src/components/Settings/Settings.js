import React, { useState } from 'react';
import { Layout, Menu } from 'antd';
import {
  SettingOutlined,
  UserOutlined,
  RobotOutlined,
  CloseOutlined,
  SafetyOutlined
} from '@ant-design/icons';
import ProviderSettings from './ProviderSettings';
import ApiKeySetup from '../ApiKeySetup/ApiKeySetup';
import PrivacySettings from './PrivacySettings';
import CommunityLink from '../ui_components/CommunityLink';
import './Settings.css';

const { Sider, Content } = Layout;

const Settings = ({ onClose, initialTab = 'account' }) => {
  const [activeTab, setActiveTab] = useState(initialTab);

  const menuItems = [
    {
      key: 'account',
      icon: <UserOutlined />,
      label: 'Account'
    },
    {
      key: 'provider',
      icon: <RobotOutlined />,
      label: 'AI Provider'
    },
    {
      key: 'privacy',
      icon: <SafetyOutlined />,
      label: 'Privacy'
    }
  ];

  const handleApiKeyComplete = () => {
    // When API key setup is complete in settings, just show a success message
    // Don't close settings, let user stay and configure more
    console.log('API key setup complete');
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'provider':
        return <ProviderSettings />;
      case 'account':
        return <ApiKeySetup isSettingsMode={true} onComplete={handleApiKeyComplete} />;
      case 'privacy':
        return <PrivacySettings />;
      default:
        return <ApiKeySetup isSettingsMode={true} onComplete={handleApiKeyComplete} />;
    }
  };

  return (
    <div className="settings-overlay">
      <div className="settings-container">
        <div className="settings-header">
          <div className="settings-header-left">
            <SettingOutlined style={{ fontSize: 20, marginRight: 12 }} />
            <h2>Settings</h2>
          </div>
          <button className="settings-close-btn" onClick={onClose}>
            <CloseOutlined />
          </button>
        </div>

        <Layout className="settings-layout">
          <Sider width={240} className="settings-sider">
            <Menu
              mode="inline"
              selectedKeys={[activeTab]}
              onClick={({ key }) => setActiveTab(key)}
              items={menuItems}
              className="settings-menu"
            />
            <div className="settings-sider-footer">
              <CommunityLink variant="compact" />
            </div>
          </Sider>

          <Content className="settings-content">
            {renderContent()}
          </Content>
        </Layout>
      </div>
    </div>
  );
};

export default Settings;
