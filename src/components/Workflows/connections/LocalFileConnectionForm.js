import React, { useState, useRef } from 'react';
import { Form, Input, InputNumber, Button, Space, message, Upload, Card, Typography, Progress } from 'antd';
import {
  InboxOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  CheckCircleOutlined,
  LoadingOutlined
} from '@ant-design/icons';
import { ReactComponent as ParquetIcon } from '../../ConnectorImages/Parquet.svg';
import { ReactComponent as AvroIcon } from '../../ConnectorImages/Avro.svg';
import { uniqueNameRule } from './connectionNameRule';

const { Dragger } = Upload;
const { TextArea } = Input;
const { Text, Title } = Typography;

// Imports stream in batches, so the main process reports how far it has got.
// Where the source is a plain byte stream (CSV, JSON) we know the file size and
// can show a true percentage; a workbook or columnar file only reports rows, so
// the bar approaches the end of the import band without ever claiming to
// arrive. The bands: 0-25 selecting/reading, 25-90 writing, 90-100 finalising.
const IMPORT_BAND_START = 25;
const IMPORT_BAND_SIZE = 65;
const ROWS_HALFWAY = 250000; // rows at which a total-less import reads ~half done

const importPercent = ({ phase, bytesRead, totalBytes, rows = 0, total = 0 }) => {
  if (phase === 'reading') return IMPORT_BAND_START;
  // Registering a file describes its tables rather than reading its rows, so
  // progress is how many of them are done — one step per sheet of a workbook.
  if (phase === 'describing') {
    return Math.round(IMPORT_BAND_START + IMPORT_BAND_SIZE * (total > 0 ? rows / total : 0));
  }
  const ratio = (totalBytes > 0 && bytesRead >= 0)
    ? Math.min(1, bytesRead / totalBytes)
    : 1 - Math.exp(-rows / ROWS_HALFWAY);
  return Math.round(IMPORT_BAND_START + IMPORT_BAND_SIZE * ratio);
};

const formatCount = (n) => (typeof n === 'number' ? n.toLocaleString() : '0');

// SVG Icon wrapper with consistent sizing
const DbIcon = ({ Icon, bg }) => (
  <div style={{
    width: 48, height: 48, borderRadius: 10,
    background: bg, display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: 8,
  }}>
    <Icon style={{ width: '100%', height: '100%', fill: '#fff' }} />
  </div>
);

const LocalFileConnectionForm = ({
  fileType, // 'duckdb', 'sqlite', 'lancedb', 'json', 'spreadsheet', 'parquet', 'avro'
  onSave,
  onCancel,
  editingConnection,
  initialFile, // optional File object (e.g. dropped onto the workflow canvas)
  existingConnections = []
}) => {
  const [form] = Form.useForm();
  const [filePath, setFilePath] = useState(editingConnection?.fileInfo?.filePath || '');
  const [fileName, setFileName] = useState(editingConnection?.fileInfo?.originalName || '');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // Live counters from the streaming import in the main process.
  const [importStatus, setImportStatus] = useState(null);

  // A workbook being edited gets one Header row per sheet: a title above one
  // sheet's header says nothing about the others, and a single file-wide row
  // would cut the first row off every sheet that has none. A new upload has
  // no sheets yet — it gets the single field, and a sheet that needs its own
  // row is flagged when it is added.
  const editingSheets = [...new Set(Object.values(editingConnection?.fileInfo?.tableSheets || {}))];
  const sheetHeaderRows = (values) => {
    if (fileType !== 'spreadsheet' || editingSheets.length === 0) return null;
    return Object.fromEntries(editingSheets.map((sheet) => [sheet, Number(values.headerRows?.[sheet]) || 1]));
  };

  // Initialize form with editing data
  React.useEffect(() => {
    if (editingConnection) {
      form.setFieldsValue({
        name: editingConnection.name,
        description: editingConnection.description,
      });
      setFilePath(editingConnection.fileInfo?.filePath || '');
      setFileName(editingConnection.fileInfo?.originalName || '');
    }
  }, [editingConnection, form]);

  const handleBrowseFile = async () => {
    // Prevent opening dialog if already open
    if (isDialogOpen || !window.electronAPI?.openFileDialog) {
      if (!window.electronAPI?.openFileDialog) {
        message.error('File browser requires desktop app');
      }
      return;
    }

    setIsDialogOpen(true);

    // Define file extensions based on type
    const filters = {
      sqlite: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      duckdb: [{ name: 'DuckDB Database', extensions: ['duckdb'] }],
      // No lancedb entry: it opens a DIRECTORY picker below, which ignores
      // filters. The `.lance` filter that used to sit here only advertised the
      // wrong thing to pick — a single table folder rather than the database
      // directory that holds them.
      json: [{ name: 'JSON Files', extensions: ['json'] }],
      // No .xls or .xlsb: DuckDB reads a workbook as an OOXML zip, which the
      // legacy binary formats are not. Offering them in the picker would only
      // let a user get as far as the error.
      spreadsheet: [
        { name: 'Spreadsheet Files', extensions: ['csv', 'xlsx', 'xlsm'] },
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'Excel Files', extensions: ['xlsx', 'xlsm'] }
      ],
      parquet: [{ name: 'Parquet Files', extensions: ['parquet'] }],
      avro: [{ name: 'Avro Files', extensions: ['avro'] }]
    };

    try {
      // For LanceDB, open directory instead of file
      const dialogOptions = fileType === 'lancedb'
        ? { properties: ['openDirectory'] }
        : { properties: ['openFile'], filters: filters[fileType] || [] };

      const result = await window.electronAPI.openFileDialog(dialogOptions);

      if (!result.canceled && result.filePaths?.length > 0) {
        const selectedPath = result.filePaths[0];
        const selectedFileName = selectedPath.split(/[\\/]/).pop();

        // For LanceDB (directory), skip file extension validation
        if (fileType !== 'lancedb') {
          // Validate file extension for file-based types
          if (!isValidFileType(selectedFileName)) {
            setIsDialogOpen(false);
            return;
          }
        }

        setFilePath(selectedPath);
        setFileName(selectedFileName);

        // Auto-populate name if empty
        if (!form.getFieldValue('name')) {
          const nameWithoutExt = selectedFileName.replace(/\.[^/.]+$/, '');
          form.setFieldValue('name', nameWithoutExt);
        }

        message.success('File selected successfully');
      }
    } catch (error) {
      console.error('File dialog error:', error);
      message.error('Failed to open file browser');
    } finally {
      setIsDialogOpen(false);
    }
  };

  // Excel formats DuckDB cannot open, named so the rejection can say why and
  // what to do about it rather than just listing what was expected.
  const LEGACY_SPREADSHEETS = {
    '.xls': 'Excel 97–2003 (.xls)',
    '.xlsb': 'Binary Excel (.xlsb)',
  };

  const isValidFileType = (filename) => {
    const validExtensions = {
      sqlite: ['.db', '.sqlite', '.sqlite3'],
      duckdb: ['.duckdb'],
      lancedb: ['.lance'],
      json: ['.json'],
      spreadsheet: ['.csv', '.xlsx', '.xlsm'],
      parquet: ['.parquet'],
      avro: ['.avro']
    };

    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    const valid = validExtensions[fileType].includes(ext);

    if (!valid) {
      if (LEGACY_SPREADSHEETS[ext]) {
        message.error(
          `${LEGACY_SPREADSHEETS[ext]} files aren't supported. Open the file in Excel and save it as .xlsx.`,
        );
      } else {
        message.error(`Invalid file type. Expected: ${validExtensions[fileType].join(', ')}`);
      }
    }

    return valid;
  };

  const handleBeforeUpload = async (file) => {
    // Validate file type (skip for LanceDB directories)
    if (fileType !== 'lancedb' && !isValidFileType(file.name)) {
      return Upload.LIST_IGNORE;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Use webUtils.getPathForFile() via preload script to extract real system path
      if (!window.electronAPI?.getFilePath) {
        console.error('getFilePath API not available');
        message.error('File path extraction not available. Please restart the application.');
        setUploading(false);
        return Upload.LIST_IGNORE;
      }

      const uploadedPath = window.electronAPI.getFilePath(file);
      console.log("Extracted file path:", uploadedPath);

      if (!uploadedPath) {
        console.error('File path not found. File object:', file);
        message.error('Could not read file path. Please try again.');
        setUploading(false);
        return Upload.LIST_IGNORE;
      }

      // Simulate progress for user feedback
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + 10;
        });
      }, 100);

      setFilePath(uploadedPath);
      setFileName(file.name);

      // Auto-populate name if empty
      if (!form.getFieldValue('name')) {
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        form.setFieldValue('name', nameWithoutExt);
      }

      clearInterval(progressInterval);
      setUploadProgress(100);

      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
      }, 500);

      message.success('File selected successfully');
    } catch (error) {
      console.error('Upload error:', error);
      message.error('Failed to process file');
      setUploading(false);
      setUploadProgress(0);
    }

    return false; // Prevent default upload behavior
  };

  // Auto-process a file handed in from outside the form (e.g. dropped onto the
  // workflow canvas) so the user lands on a pre-filled form instead of an empty one.
  //
  // Guarded by identity rather than a plain dependency array: StrictMode mounts
  // effects twice in development, and handleBeforeUpload is not idempotent — it
  // re-extracts the path, starts a second progress interval and toasts again,
  // which is why the success message appeared twice per drop. A new drop is a
  // new File object, so comparing the object itself is enough to tell a repeat
  // effect run from a genuinely different file.
  const autoImportedFileRef = useRef(null);
  React.useEffect(() => {
    if (!initialFile || editingConnection) return;
    if (autoImportedFileRef.current === initialFile) return;
    autoImportedFileRef.current = initialFile;
    handleBeforeUpload(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  const handleSave = async () => {
    try {
      await form.validateFields();
      const values = form.getFieldsValue();

      if (!filePath) {
        message.error('Please select a file');
        return;
      }

      // Preserve the original file path before any imports
      const originalFilePath = filePath;

      // Check for duplicate connection names (only if not editing)
      if (!editingConnection && window.electronAPI?.db) {
        const existingConnections = await window.electronAPI.db.find('connections', {});
        const nameExists = existingConnections.some(
          conn => conn.name.toLowerCase() === values.name.toLowerCase()
        );

        if (nameExists) {
          message.error(`A connection named "${values.name}" already exists. Please choose a different name.`);
          return;
        }
      }

      let targetDbType;
      let targetFilePath = filePath;
      let connectionType = 'file';
      let importedTables = null;
      let schemas = null; // Schema(s) reported by DuckDB
      let tablePaths = null; // table name -> the file DuckDB reads for it
      let tableSheets = null; // table name -> sheet, for a workbook's tables
      let fileFormat = null; // how DuckDB reads it: csv | json | parquet | xlsx | avro

      setUploading(true);
      setUploadProgress(10);

      // Data files are no longer imported into a local database, and no longer
      // converted either. Every supported format — including Excel and Avro,
      // which DuckDB reads through extensions that ship with the app — is
      // registered by path and queried in place, so adding a file is instant
      // regardless of its size, and an edit goes back into the file itself.
      if (['spreadsheet', 'parquet', 'avro', 'json'].includes(fileType)) {
        setUploadProgress(IMPORT_BAND_START);

        // Registration reports each table it describes back from the main
        // process, so a workbook's bar tracks real sheets rather than a timer.
        const importId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const unsubscribe = window.electronAPI?.onImportProgress
          ? window.electronAPI.onImportProgress((evt) => {
            if (evt.importId !== importId) return;
            setImportStatus(evt);
            setUploadProgress(importPercent(evt));
          })
          : () => {};

        let result;
        try {
          // The header row is saved before the file is described, so the
          // columns recorded for it are read from the right row.
          const headerRow = fileType === 'spreadsheet' ? (Number(values.headerRow) || 1) : 1;
          result = await window.electronAPI.registerLocalFile({
            filePath, importId, headerRow, headerRows: sheetHeaderRows(values),
          });
        } finally {
          unsubscribe();
        }

        if (!result?.success) {
          message.error('Failed to add file: ' + (result?.message || 'unknown error'));
          setUploading(false);
          setUploadProgress(0);
          setImportStatus(null);
          return;
        }

        targetDbType = 'duckdb';
        fileFormat = result.format;
        targetFilePath = result.tables[0].path;
        importedTables = result.tables.map((t) => t.name);
        tablePaths = Object.fromEntries(result.tables.map((t) => [t.name, t.path]));
        // Only a workbook has sheets; for everything else this stays null so
        // the connector's config keeps the shape it had.
        const sheeted = result.tables.filter((t) => t.sheet);
        tableSheets = sheeted.length ? Object.fromEntries(sheeted.map((t) => [t.name, t.sheet])) : null;
        schemas = result.tables.map((t) => t.schema).filter(Boolean);

        // A sheet that looks like it has a title above its header: say so, with
        // the fix, rather than let it load with columns missing.
        result.tables.filter((t) => t.warning).forEach((t) => message.warning(t.warning, 10));

        if (result.tables.length > 1) {
          message.success(
            `Added ${result.tables.length} sheets from ${fileName} — read in place, no import needed`,
          );
        } else {
          message.success(`Added ${result.tables[0].name} — queried in place, no import needed`);
        }

        setUploadProgress(90);
      } else {
        // Databases and LanceDB — referenced where they are, nothing imported.
        //
        // A DuckDB or SQLite file is opened BY DuckDB: it attaches the file and
        // its tables stay real tables, so they can be read, written and joined
        // against every other local connection in one query. That is why both
        // become a `duckdb` connection rather than one per format.
        targetDbType = (fileType === 'sqlite' || fileType === 'duckdb') ? 'duckdb' : fileType;
        setUploadProgress(50);

        // For LanceDB, list the tables in the database directory
        if (fileType === 'lancedb') {
          setUploadProgress(60);

          if (window.electronAPI?.listLanceDBTables) {
            try {
              const tablesResult = await window.electronAPI.listLanceDBTables(filePath);
              if (tablesResult.success) {
                importedTables = tablesResult.tables || [];
                // Zero tables is a broken connection, not a successful one: the
                // assistant is handed a vector store with nothing to search and
                // can only ask the user which table to use. Say so here, while
                // the picker is still open and the path can be corrected.
                if (importedTables.length === 0) {
                  message.warning(
                    'No tables found in this LanceDB directory. Select the database folder '
                    + '— the one that CONTAINS the .lance table folders — not a .lance folder itself.'
                  );
                } else {
                  message.success(`Found ${importedTables.length} table(s) in LanceDB`);
                }
              } else {
                message.warning('Could not list LanceDB tables: ' + tablesResult.message);
              }
            } catch (error) {
              console.error('Failed to list LanceDB tables:', error);
              message.warning('Could not list LanceDB tables');
            }
          }

          setUploadProgress(80);
        }
      }

      const connectionData = {
        name: values.name,
        description: values.description,
        connectionType: connectionType,
        dbType: targetDbType,
        dbCategory: targetDbType === 'lancedb' ? 'Vector' : undefined,
        fileType: fileType,
        fileInfo: {
          originalName: fileName,
          // The file DuckDB reads — the user's own, whatever the format. Nothing
          // is converted: Excel and Avro are read through extensions that ship
          // with the app, so this is the path they picked (for a workbook, the
          // first sheet's entry in `tablePaths`, which is that same file).
          filePath: targetFilePath,
          sourceFilePath: originalFilePath, // Always the file the user picked
          format: fileFormat, // csv | json | parquet | xlsx | avro
          fileSize: null,
          uploadedAt: new Date().toISOString(),
          tables: importedTables, // Table (sheet) names belonging to this connection
          tablePaths, // table name -> path, when a connection spans several files
          tableSheets, // table name -> sheet, for a multi-sheet workbook
          schemas: schemas, // Schema(s) reported by DuckDB
          // Row the header is on (1 = first). Applied by the reader itself —
          // see public/duckdb/readOptions.js — recorded here so the form shows it.
          ...(fileType === 'spreadsheet' ? { headerRow: Number(values.headerRow) || 1 } : {}),
          ...(sheetHeaderRows(values) ? { headerRows: sheetHeaderRows(values) } : {}),
        },
        status: 'ready',
        createdAt: editingConnection?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setUploadProgress(100);
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
        setImportStatus(null);
        onSave(connectionData);
      }, 500);
    } catch (error) {
      console.error('Save error:', error);
      message.error('Failed to save connection');
      setUploading(false);
      setUploadProgress(0);
      setImportStatus(null);
    }
  };

  const getTitle = () => {
    const titles = {
      sqlite: 'SQLite Database',
      duckdb: 'DuckDB Database',
      lancedb: 'LanceDB Vector Database',
      json: 'JSON File',
      spreadsheet: 'CSV/Excel File',
      parquet: 'Parquet File',
      avro: 'Avro File'
    };
    return titles[fileType] || 'Local File';
  };

  const getIcon = () => {
    const icons = {
      sqlite: <DatabaseOutlined style={{ fontSize: 48, color: '#0f80cc' }} />,
      duckdb: <DatabaseOutlined style={{ fontSize: 48, color: '#fff100' }} />,
      lancedb: <DatabaseOutlined style={{ fontSize: 48, color: '#722ed1' }} />,
      json: <FileTextOutlined style={{ fontSize: 48, color: '#fa8c16' }} />,
      spreadsheet: <FileTextOutlined style={{ fontSize: 48, color: '#1890ff' }} />,
      parquet: <DbIcon Icon={ParquetIcon} bg="#9254de" />,
      avro: <DbIcon Icon={AvroIcon} bg="#eb2f96" />
    };
    return icons[fileType] || <DatabaseOutlined style={{ fontSize: 48, color: '#1890ff' }} />;
  };

  const getDescription = () => {
    const descriptions = {
      sqlite: 'Connect to an existing SQLite database file on your computer',
      duckdb: 'Connect to an existing DuckDB database file on your computer',
      lancedb: 'Connect to a local LanceDB vector database directory',
      json: 'Add a JSON file — queried where it is, no import step',
      spreadsheet: 'Add a CSV or Excel file — queried where it is, no import step',
      parquet: 'Add a Parquet file — queried where it is, no import step',
      avro: 'Add an Avro file — queried where it is, no import step'
    };
    return descriptions[fileType] || 'Select a file to use as a data source';
  };

  const getDragText = () => {
    const texts = {
      sqlite: 'Click or drag SQLite database file to this area',
      duckdb: 'Click or drag DuckDB database file to this area',
      lancedb: 'Click to select LanceDB directory (contains .lance table folders)',
      json: 'Click or drag a JSON file to this area',
      spreadsheet: 'Click or drag a CSV or Excel file to this area',
      parquet: 'Click or drag a Parquet file to this area',
      avro: 'Click or drag an Avro file to this area'
    };
    return texts[fileType] || 'Click or drag file to this area';
  };

  const getAcceptedFiles = () => {
    const accepts = {
      sqlite: '.db,.sqlite,.sqlite3',
      duckdb: '.duckdb',
      // A LanceDB connection points at the database DIRECTORY, whose children
      // are the `.lance` table folders. Advertising `.lance` here steered the
      // picker at one of those children — a single table, which `connect()`
      // reads as a database holding no tables at all.
      lancedb: '',
      json: '.json',
      spreadsheet: '.csv,.xlsx,.xlsm',
      parquet: '.parquet',
      avro: '.avro'
    };
    return accepts[fileType] || '*';
  };

  const getHelpText = () => {
    const helps = {
      sqlite: 'SQLite database files (.db, .sqlite, .sqlite3)',
      duckdb: 'DuckDB database files (.duckdb)',
      lancedb: 'LanceDB vector database directory - Contains table folders with vector embeddings and metadata',
      json: 'JSON files (.json) - Arrays or single objects',
      spreadsheet: 'Excel (.xlsx, .xls) and CSV (.csv) files - Multi-sheet Excel files will create multiple tables',
      parquet: 'Parquet files (.parquet) - Columnar storage format',
      avro: 'Avro files (.avro) - Row-based storage format'
    };
    return helps[fileType] || 'Select a valid file';
  };

  const uploadProps = {
    name: 'file',
    multiple: false,
    accept: getAcceptedFiles(),
    beforeUpload: handleBeforeUpload,
    showUploadList: false,
    onDrop: () => setDragActive(false),
    onDragEnter: () => setDragActive(true),
    onDragLeave: () => setDragActive(false),
    // Disable default file dialog, we'll handle it ourselves
    openFileDialogOnClick: false,
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        {getIcon()}
        <Title level={4} style={{ marginTop: 8, marginBottom: 4 }}>
          {editingConnection ? `Edit ${getTitle()} Connection` : `Connect ${getTitle()}`}
        </Title>
        <Text type="secondary">
          {getDescription()}
        </Text>
      </div>

      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="Connection Name"
          rules={[
            { required: true, message: 'Please enter a connection name' },
            {
              validator: (_, value) => {
                if (!value) return Promise.resolve();

                // Check if name would be valid after sanitization
                const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
                if (sanitized === '' || /^[0-9_]+$/.test(sanitized)) {
                  return Promise.reject(new Error('Name must contain at least one letter'));
                }

                return Promise.resolve();
              }
            },
            uniqueNameRule(existingConnections, editingConnection)
          ]}
          help="A unique name for this data source (letters, numbers, and underscores)"
        >
          <Input
            placeholder="e.g., Sales Data, Customer Records"
            disabled={uploading}
          />
        </Form.Item>

        {fileType === 'spreadsheet' && editingSheets.length > 0 && editingSheets.map((sheet) => (
          <Form.Item
            key={sheet}
            name={['headerRows', sheet]}
            label={`Header row — ${sheet}`}
            initialValue={editingConnection?.fileInfo?.headerRows?.[sheet] || 1}
            help="The row that holds this sheet's column names. Set it when the sheet has a title or notes above the header (e.g. 2 when row 1 is a title)."
          >
            <InputNumber min={1} max={1000} disabled={uploading} />
          </Form.Item>
        ))}

        {fileType === 'spreadsheet' && editingSheets.length === 0 && (
          <Form.Item
            name="headerRow"
            label="Header row"
            initialValue={editingConnection?.fileInfo?.headerRow || 1}
            help="The row that holds the column names. Set it when the sheet has a title or notes above the header (e.g. 2 when row 1 is a title)."
          >
            <InputNumber min={1} max={1000} disabled={uploading} />
          </Form.Item>
        )}

        <Form.Item
          name="description"
          label="Description"
          help="Optional description of this data source"
        >
          <TextArea
            rows={2}
            placeholder="Describe what this data source contains..."
            disabled={uploading}
          />
        </Form.Item>

        <Form.Item
          label={editingConnection ? "Replace File (Optional)" : "Select File"}
          required={!editingConnection}
        >
          {filePath && !uploading ? (
            <Card
              size="small"
              style={{
                backgroundColor: '#f6ffed',
                border: '1px solid #b7eb8f',
                marginBottom: 16
              }}
            >
              <Space>
                <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />
                <div>
                  <Text strong>{fileName}</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Path: {filePath}
                  </Text>
                </div>
              </Space>
            </Card>
          ) : null}

          <div onClick={() => !uploading && !isDialogOpen && handleBrowseFile()} style={{ cursor: uploading ? 'default' : 'pointer' }}>
            <Dragger
              {...uploadProps}
              style={{
                padding: 20,
                backgroundColor: dragActive ? '#e6f7ff' : undefined
              }}
              disabled={uploading}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined style={{ fontSize: 48, color: uploading ? '#ccc' : '#1890ff' }} />
              </p>
              <p className="ant-upload-text">
                {uploading ? 'Processing...' : getDragText()}
              </p>
              <p className="ant-upload-hint">
                {getHelpText()}
                <br />
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  {editingConnection && (
                    <>
                      <strong>Current file:</strong> {editingConnection.fileInfo?.originalName}
                    </>
                  )}
                </Text>
              </p>
            </Dragger>
          </div>
        </Form.Item>

        {uploading && (
          <div style={{ marginTop: 16, marginBottom: 16 }}>
            <Progress
              percent={uploadProgress}
              status="active"
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
            />
            <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
              {importStatus
                ? (importStatus.phase === 'reading'
                  ? 'Reading workbook...'
                  : importStatus.phase === 'describing'
                    ? (importStatus.sheet
                      ? `Reading sheet "${importStatus.sheet}"...`
                      : 'Reading file...')
                    : `Imported ${formatCount(importStatus.rows)} ${fileType === 'json' ? 'documents' : 'rows'}${importStatus.sheet ? ` from "${importStatus.sheet}"` : ''}...`)
                : uploadProgress < IMPORT_BAND_START ? 'Reading file...' :
                  uploadProgress < 90 ? 'Importing data...' :
                  uploadProgress < 100 ? 'Finalizing...' :
                  'Complete!'}
            </Text>
            {importStatus && (
              <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 4, fontSize: 12 }}>
                Streaming in batches — large files import without loading fully into memory.
              </Text>
            )}
          </div>
        )}

        <div style={{ marginTop: 24, textAlign: 'right' }}>
          <Space>
            <Button onClick={onCancel} disabled={uploading}>
              Cancel
            </Button>
            <Button
              type="primary"
              onClick={handleSave}
              disabled={uploading || (!editingConnection && !filePath)}
              icon={uploading ? <LoadingOutlined /> : null}
              loading={uploading}
            >
              {editingConnection ? 'Update' : 'Create'} Connection
            </Button>
          </Space>
        </div>
      </Form>
    </Space>
  );
};

export default LocalFileConnectionForm;
