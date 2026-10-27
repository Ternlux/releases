import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Form, Input, Button, Space, Alert, Table, Tag, Typography, message,
} from 'antd';
import { FileExcelOutlined, DatabaseOutlined, FolderOpenOutlined } from '@ant-design/icons';

const { Text } = Typography;

const TYPE_COLOR = { number: 'blue', date: 'green', boolean: 'purple', text: 'default' };

function inferType(values) {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return 'text';
  if (nonNull.every(v => typeof v === 'boolean')) return 'boolean';
  if (nonNull.every(v => typeof v === 'number' || (!isNaN(Number(v)) && v !== ''))) return 'number';
  if (nonNull.every(v => {
    if (v instanceof Date) return true;
    if (typeof v === 'string') return !isNaN(Date.parse(v)) && /\d{4}/.test(v);
    return false;
  })) return 'date';
  return 'text';
}

function buildSchemaFromIpcResult(result) {
  const schemasMap = {};
  result.sheets.forEach(sheetName => {
    const { columns, rows } = result.data[sheetName];
    const colDefs = columns.map(colName => {
      const values = rows.map(r => r[colName]);
      const samples = values
        .filter(v => v !== null && v !== undefined && v !== '')
        .slice(0, 5)
        .map(String);
      return { name: colName, type: inferType(values), samples };
    });
    schemasMap[sheetName] = { columns: colDefs, rowCount: rows.length };
  });
  return schemasMap;
}

function buildSchemaFromWorkbook(workbook) {
  const schemasMap = {};
  workbook.SheetNames.forEach(sheetName => {
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
    if (rows.length === 0) return;
    const headers = (rows[0] || []).map((h, i) =>
      h !== null && h !== undefined && String(h).trim() !== '' ? String(h) : `Column ${i + 1}`
    );
    const dataRows = rows.slice(1, 101);
    const colDefs = headers.map((colName, colIdx) => {
      const values = dataRows.map(row => (row ? row[colIdx] : null));
      const samples = values.filter(v => v !== null && v !== undefined && v !== '').slice(0, 5).map(String);
      return { name: colName, type: inferType(values), samples };
    });
    schemasMap[sheetName] = { columns: colDefs, rowCount: dataRows.length };
  });
  return schemasMap;
}

const SCHEMA_COLUMNS = [
  {
    title: 'Column',
    dataIndex: 'name',
    key: 'name',
    render: n => <Text strong style={{ fontSize: 13 }}>{n}</Text>,
  },
  {
    title: 'Type',
    dataIndex: 'type',
    key: 'type',
    width: 90,
    render: t => <Tag color={TYPE_COLOR[t] || 'default'}>{t}</Tag>,
  },
  {
    title: 'Sample values',
    dataIndex: 'samples',
    key: 'samples',
    ellipsis: true,
    render: s => <Text type="secondary" style={{ fontSize: 12 }}>{s.join(', ')}</Text>,
  },
];

const isElectron = () => Boolean(window.electronAPI?.openFileDialog);

const SpreadsheetConnectionForm = ({ onSave, onCancel, editingConnection }) => {
  const [form] = Form.useForm();
  const fileInputRef = useRef(null);

  // Pre-populate from editingConnection so existing info is visible immediately
  const [selectedFile, setSelectedFile] = useState(
    editingConnection?.fileInfo
      ? {
          name: editingConnection.fileInfo.originalName,
          path: editingConnection.fileInfo.filePath || null,
          size: editingConnection.fileInfo.fileSize || 0,
        }
      : null
  );
  const [schema, setSchema]                   = useState(editingConnection?.schema?.columns || null);
  const [sheets, setSheets]                   = useState(editingConnection?.schema?.sheets || []);
  const [activeSheet, setActiveSheet]         = useState(editingConnection?.schema?.activeSheet || null);
  const [allSheetSchemas, setAllSheetSchemas] = useState(editingConnection?.schema?.allSheetSchemas || {});
  const [parsing, setParsing]                 = useState(false);
  const [saving, setSaving]                   = useState(false);
  const [parseError, setParseError]           = useState(null);

  const initialValues = editingConnection
    ? { name: editingConnection.name, description: editingConnection.description }
    : {};

  // ── apply parsed schema map to state ────────────────────────────────────

  const applySchemas = (schemasMap, sheetNames, fileName) => {
    setAllSheetSchemas(schemasMap);
    setSheets(sheetNames);
    const first = sheetNames[0];
    setActiveSheet(first);
    setSchema(schemasMap[first]?.columns || []);
    if (!form.getFieldValue('name') && fileName) {
      form.setFieldValue('name', fileName.replace(/\.[^/.]+$/, ''));
    }
  };

  // ── Electron: open native dialog → read via IPC ─────────────────────────

  const handlePickElectron = async () => {
    setParsing(true);
    setParseError(null);
    setSchema(null);
    try {
      const dialogResult = await window.electronAPI.openFileDialog();
      if (dialogResult.canceled || !dialogResult.filePaths?.length) {
        setParsing(false);
        return;
      }
      const filePath = dialogResult.filePaths[0];
      const fileName = filePath.split(/[\\/]/).pop();

      // Read first 100 rows via IPC (main process, guaranteed path access)
      const result = await window.electronAPI.fileReader.readRows(filePath, 100);
      if (!result.success) {
        setParseError('Failed to read file: ' + result.message);
        return;
      }

      setSelectedFile({ name: fileName, path: filePath, size: null });
      const schemasMap = buildSchemaFromIpcResult(result);
      applySchemas(schemasMap, result.sheets, fileName);
    } catch (err) {
      setParseError('Failed to read file: ' + err.message);
    } finally {
      setParsing(false);
    }
  };

  // ── Browser fallback: <input type="file"> + XLSX in renderer ────────────

  const handleBrowserFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setParsing(true);
    setParseError(null);
    setSchema(null);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', sheetRows: 101, cellDates: true });
      setSelectedFile({ name: file.name, path: null, size: file.size });
      const schemasMap = buildSchemaFromWorkbook(workbook);
      applySchemas(schemasMap, workbook.SheetNames, file.name);
    } catch (err) {
      setParseError('Failed to parse file: ' + err.message);
    } finally {
      setParsing(false);
    }
  };

  const handlePickFile = () => {
    if (isElectron()) {
      handlePickElectron();
    } else {
      fileInputRef.current?.click();
    }
  };

  // ── sheet tab switch ─────────────────────────────────────────────────────

  const handleSheetChange = (sheetName) => {
    setActiveSheet(sheetName);
    setSchema(allSheetSchemas[sheetName]?.columns || []);
  };

  // ── save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    try {
      const v = await form.validateFields();
      if (!selectedFile && !editingConnection) {
        message.error('Please select a file first.');
        return;
      }
      setSaving(true);
      const fileInfo = selectedFile
        ? {
            originalName: selectedFile.name,
            filePath: selectedFile.path,
            fileSize: selectedFile.size,
          }
        : editingConnection?.fileInfo;

      const ext = (selectedFile?.name || editingConnection?.fileInfo?.originalName || '').toLowerCase();
      await onSave({
        name: v.name,
        description: v.description || '',
        connectionType: 'file',
        fileType: ext.endsWith('.csv') ? 'csv' : 'excel',
        fileInfo,
        schema: schema
          ? { sheets, activeSheet, columns: schema, allSheetSchemas }
          : editingConnection?.schema,
        status: 'ready',
      });
    } catch (_) {
    } finally {
      setSaving(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  const fileLabel = selectedFile
    ? `${selectedFile.name}${selectedFile.size ? `  (${(selectedFile.size / 1024).toFixed(1)} KB)` : ''}`
    : editingConnection?.fileInfo?.originalName || null;

  return (
    <Form form={form} layout="vertical" initialValues={initialValues}>
      {/* File picker */}
      <div
        style={{
          border: `2px dashed ${selectedFile ? '#52c41a' : '#d9d9d9'}`,
          borderRadius: 8, padding: 28, textAlign: 'center',
          marginBottom: 16, cursor: 'pointer',
          background: '#fafafa', transition: 'border-color 0.2s',
        }}
        onClick={handlePickFile}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#1890ff'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = selectedFile ? '#52c41a' : '#d9d9d9'; }}
      >
        {/* browser-only hidden input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: 'none' }}
          onChange={handleBrowserFileChange}
        />
        <FileExcelOutlined
          style={{ fontSize: 32, color: selectedFile ? '#52c41a' : '#1890ff', marginBottom: 8 }}
        />
        <div style={{ marginBottom: 4 }}>
          {fileLabel
            ? <Text strong>{fileLabel}</Text>
            : <Text type="secondary">Click to select an Excel or CSV file</Text>}
        </div>
        {selectedFile?.path && (
          <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
            {selectedFile.path}
          </Text>
        )}
        {!selectedFile && (
          <div style={{ marginTop: 6 }}>
            <Space size={4}>
              <FolderOpenOutlined style={{ color: '#8c8c8c' }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {isElectron() ? 'Opens native file picker' : 'Supported: .xlsx, .xls, .csv'}
              </Text>
            </Space>
          </div>
        )}
        {selectedFile && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            Click to change file
          </Text>
        )}
      </div>

      {parseError && (
        <Alert type="error" showIcon message={parseError} style={{ marginBottom: 16 }} />
      )}

      {parsing && (
        <Alert type="info" showIcon message="Reading file…" style={{ marginBottom: 16 }} />
      )}

      {/* Sheet tabs if multiple sheets */}
      {sheets.length > 1 && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {sheets.map(s => (
            <Button
              key={s}
              size="small"
              type={s === activeSheet ? 'primary' : 'default'}
              onClick={() => handleSheetChange(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {/* Schema preview */}
      {schema && (
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Schema — {schema.length} column{schema.length !== 1 ? 's' : ''}
            {activeSheet && sheets.length > 1 ? ` (${activeSheet})` : ''}
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
              first 100 rows sampled
            </Text>
          </Text>
          <Table
            dataSource={schema}
            columns={SCHEMA_COLUMNS}
            rowKey={(r, i) => `${r.name}_${i}`}
            size="small"
            pagination={false}
            scroll={{ y: 220 }}
          />
        </div>
      )}

      <Form.Item
        name="name"
        label="Connection Name"
        rules={[{ required: true, message: 'Name is required' }]}
      >
        <Input placeholder="My Spreadsheet" />
      </Form.Item>

      <Form.Item name="description" label="Description">
        <Input.TextArea rows={2} placeholder="Optional description" />
      </Form.Item>

      <Space>
        <Button
          type="primary"
          icon={<DatabaseOutlined />}
          onClick={handleSave}
          loading={saving || parsing}
          disabled={!schema && !editingConnection}
        >
          {editingConnection ? 'Update Connection' : 'Save Connection'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Space>
    </Form>
  );
};

export default SpreadsheetConnectionForm;
