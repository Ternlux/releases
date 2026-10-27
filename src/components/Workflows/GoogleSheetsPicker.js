import React, { useState } from 'react';
import { Modal, List, Input, Button, Space, Typography, Spin, Empty, Tag, message } from 'antd';
import { FileExcelOutlined, TableOutlined, LinkOutlined } from '@ant-design/icons';

const { Text } = Typography;

/**
 * Google Sheets picker — spreadsheet, then tab.
 *
 * WHY THERE IS NO FILE BROWSER HERE
 *
 * Two ways to let someone choose a spreadsheet were tried, and neither works in
 * this app:
 *
 *   1. Listing their spreadsheets ourselves (drive.files.list) needs
 *      `drive.metadata.readonly`, which Google classifies as a RESTRICTED
 *      scope — publishing an app that asks for it requires an annual
 *      third-party security assessment.
 *
 *   2. Google's own Picker avoids that scope, but it validates the PAGE ORIGIN
 *      against the OAuth client's authorized JavaScript origins. This renderer
 *      runs from `file://` when packaged (electron.js `loadFile`), and the
 *      OAuth client is a DESKTOP client, which has no JavaScript origins at
 *      all. So the Picker always falls back to "You must sign in to access this
 *      content" and then hands off to a browser session the app cannot see.
 *
 * Neither is needed. The `spreadsheets` scope this connection already holds is
 * account-wide — "See, edit, create, and delete all your Google Sheets
 * spreadsheets" — so any spreadsheet can be opened BY ID. All the Drive scopes
 * ever bought was discovery, and the user already has that in their browser's
 * address bar. So: paste the link, we read the tabs, they pick one.
 *
 *   mode="import"  choose a tab → downloaded as CSV → saved where the user says
 *                  → read in place by DuckDB, refreshed on every run
 *   mode="output"  choose an existing tab, or type a new one to be created
 */

/**
 * The id inside a Sheets URL, or the id itself.
 *
 * Accepts what a person actually has to hand: the address-bar URL, a shared
 * link with query or fragment attached, or a bare id pasted out of either.
 */
export const spreadsheetIdFrom = (input) => {
  const value = String(input || '').trim();
  if (!value) return null;
  const inUrl = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (inUrl) return inUrl[1];
  // A bare id: Google's file ids are long, with no spaces or slashes.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(value)) return value;
  return null;
};

const GoogleSheetsPicker = ({ connection, mode = 'import', onFileSelect, onClose }) => {
  const [linkInput, setLinkInput] = useState('');
  const [spreadsheet, setSpreadsheet] = useState(null); // { id, name }
  const [tabs, setTabs] = useState([]);
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [selectedTab, setSelectedTab] = useState('');
  const [busy, setBusy] = useState(false);

  const isImport = mode === 'import';

  const openSpreadsheet = async () => {
    const id = spreadsheetIdFrom(linkInput);
    if (!id) {
      message.warning('Paste a Google Sheets link, or the spreadsheet id from it');
      return;
    }

    setLoadingTabs(true);
    try {
      const result = await window.electronAPI.cloudStorage.listObjects(
        connection.id,
        connection.dbType,
        id,
      );
      if (!result.success) {
        message.error('Could not open that spreadsheet: ' + result.message);
        return;
      }
      const found = result.objects || [];
      setSpreadsheet({ id, name: result.containerName || id });
      setTabs(found);
      // One tab is not a choice — preselect it so the user just confirms.
      if (found.length === 1) setSelectedTab(found[0].objectKey);
    } catch (err) {
      console.error('[GoogleSheetsPicker] open failed', err);
      message.error('Could not open that spreadsheet');
    } finally {
      setLoadingTabs(false);
    }
  };

  /** Import: pull the chosen tab down as CSV and register it as a local source. */
  const importTab = async () => {
    const tab = selectedTab.trim();
    if (!tab || !spreadsheet) return;
    setBusy(true);
    try {
      const download = await window.electronAPI.cloudStorage.downloadObject(
        connection.id,
        connection.dbType,
        spreadsheet.id,
        tab,
      );
      if (!download.success) {
        message.error('Failed to read the sheet: ' + download.message);
        return;
      }

      const fileName = `${tab}.csv`;
      const chosen = await window.electronAPI.selectSavePath(fileName, 'csv');
      if (chosen.canceled || !chosen.filePath) return;

      const saved = await window.electronAPI.cloudStorage.saveAndRegister({
        data: download.data,
        targetPath: chosen.filePath,
      });
      if (!saved.success) {
        message.error('Failed to save the sheet: ' + saved.message);
        return;
      }

      message.success(`Saved ${fileName} — read in place, no import needed`);
      onFileSelect({
        fileName,
        localPath: saved.filePath,
        dbType: 'duckdb',
        format: saved.format,
        tables: saved.tables.map((t) => t.name),
        tablePaths: Object.fromEntries(saved.tables.map((t) => [t.name, t.path])),
        tableSheets: null,
        schemas: saved.tables.map((t) => t.schema).filter(Boolean),
        // The coordinates a run re-downloads from: spreadsheet + tab. Same
        // shape every cloud source records, so executeDataSourceNode refreshes
        // this file exactly as it refreshes an S3 object.
        cloudSource: {
          connectionId: connection.id,
          connectionName: connection.name,
          dbType: connection.dbType,
          containerName: spreadsheet.id,
          objectName: fileName,
          objectKey: tab,
          objectPath: `${spreadsheet.name}/${tab}`,
          localPath: saved.filePath,
        },
      });
      onClose?.();
    } catch (err) {
      console.error('[GoogleSheetsPicker] import failed', err);
      message.error('Failed to import the sheet');
    } finally {
      setBusy(false);
    }
  };

  /** Output: record spreadsheet + tab; the tab is created on write if new. */
  const selectOutputTab = () => {
    const tab = selectedTab.trim();
    if (!tab || !spreadsheet) return;
    onFileSelect({
      containerName: spreadsheet.id,
      objectPath: tab,
      fullPath: `${spreadsheet.id}/${tab}`,
      displayPath: `${spreadsheet.name} → ${tab}`,
    });
    onClose?.();
  };

  const existingTab = tabs.some((t) => t.objectKey === selectedTab.trim());

  return (
    <Modal
      title={
        <Space>
          <FileExcelOutlined style={{ color: '#0f9d58' }} />
          <Text strong>{spreadsheet ? spreadsheet.name : 'Google Sheets'}</Text>
          {connection && <Tag color="green">{connection.name}</Tag>}
        </Space>
      }
      open
      onCancel={() => onClose?.()}
      footer={null}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {!spreadsheet ? (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Open the spreadsheet in your browser and paste its link here. Any spreadsheet on
              this Google account can be opened by link — there is nothing else to set up.
            </Text>
            <Input
              autoFocus
              prefix={<LinkOutlined style={{ color: '#8c8c8c' }} />}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              onPressEnter={openSpreadsheet}
            />
            <Button
              type="primary"
              block
              loading={loadingTabs}
              disabled={!linkInput.trim()}
              onClick={openSpreadsheet}
            >
              Open spreadsheet
            </Button>
          </>
        ) : (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {isImport
                ? 'Which tab should this data source read?'
                : 'Which tab should the rows be written to?'}
            </Text>

            {loadingTabs ? (
              <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
            ) : tabs.length === 0 ? (
              <Empty description="This spreadsheet has no tabs" />
            ) : (
              <List
                size="small"
                bordered
                style={{ maxHeight: 260, overflowY: 'auto' }}
                dataSource={tabs}
                renderItem={(tab) => {
                  const active = selectedTab.trim() === tab.objectKey;
                  return (
                    <List.Item
                      onClick={() => setSelectedTab(tab.objectKey)}
                      style={{ cursor: 'pointer', background: active ? '#f0f5ff' : undefined }}
                    >
                      <Space>
                        <TableOutlined style={{ color: active ? '#1890ff' : '#8c8c8c' }} />
                        <Text strong={active}>{tab.objectKey}</Text>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            )}

            {!isImport && (
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                  Tab name
                </Text>
                <Input
                  value={selectedTab}
                  placeholder="Pick a tab above, or type a new name"
                  onChange={(e) => setSelectedTab(e.target.value)}
                  onPressEnter={selectOutputTab}
                />
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                  {selectedTab.trim() && !existingTab
                    ? `"${selectedTab.trim()}" does not exist yet and will be created.`
                    : 'An existing tab — the output\'s Write mode decides whether its rows are kept or cleared first.'}
                </Text>
              </div>
            )}

            <Space style={{ width: '100%' }}>
              <Button onClick={() => { setSpreadsheet(null); setTabs([]); setSelectedTab(''); }}>
                Different spreadsheet
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={!selectedTab.trim()}
                onClick={isImport ? importTab : selectOutputTab}
              >
                {isImport ? 'Import this tab' : 'Use this tab'}
              </Button>
            </Space>
          </>
        )}
      </Space>
    </Modal>
  );
};

export default GoogleSheetsPicker;
