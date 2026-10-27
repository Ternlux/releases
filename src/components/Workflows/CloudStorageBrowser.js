import React, { useState, useEffect } from 'react';
import {
  Modal,
  Breadcrumb,
  List,
  Button,
  Empty,
  Spin,
  message,
  Space,
  Typography,
  Tag,
  Card,
  Row,
  Col,
  Divider,
  Input,
  Select
} from 'antd';
import {
  FolderOutlined,
  FileOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  ArrowLeftOutlined,
  HomeOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  FileImageOutlined,
  FilePdfOutlined
} from '@ant-design/icons';

const { Title, Text } = Typography;
const { Option } = Select;

/**
 * Cloud Storage Browser Component
 * Modern file browser for cloud storage providers (S3, GCS, Azure Blob, etc.)
 * Allows browsing folders, previewing files, and selecting data files
 *
 * @param {boolean} mode - 'import' (default) or 'output'
 *   - import: Select existing files to import locally
 *   - output: Select path and enter filename for uploading
 * @param {string} sourceDbType - Source database type (for determining default output format)
 */
const CloudStorageBrowser = ({
  open,
  onClose,
  connection,
  onFileSelect,
  pluginManager,
  mode = 'import', // 'import' or 'output'
  sourceDbType = null // Source database type for output mode
}) => {
  const [loading, setLoading] = useState(false);
  const [containers, setContainers] = useState([]);
  const [currentContainer, setCurrentContainer] = useState(null);
  const [objects, setObjects] = useState([]);
  const [currentPath, setCurrentPath] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [downloadingFile, setDownloadingFile] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const [outputFileName, setOutputFileName] = useState('');
  const [continuationToken, setContinuationToken] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageSize] = useState(100); // Number of items per page

  // Determine default output format based on source database type
  const getDefaultFormat = () => {
    if (!sourceDbType) return 'csv';
    const noSqlTypes = ['mongodb'];
    return noSqlTypes.includes(sourceDbType.toLowerCase()) ? 'json' : 'csv';
  };

  const [outputFormat, setOutputFormat] = useState(getDefaultFormat());

  // Stores addressed by ID rather than by name. S3 / Azure Blob / GCS name a
  // bucket and walk it by path; these three hand out opaque ids and have no
  // path syntax at all — Google Drive included, whose containers list as
  // { name: 'My Drive', id: 'root' }. Recording the NAME is what sent
  // "My Drive" to the API as a folder id and came back `File not found`.
  const ID_ADDRESSED = ['onedrive', 'sharepoint', 'google-drive', 'google-sheets'];
  const isIdAddressed = () => ID_ADDRESSED.includes(connection.dbType);

  // Google Sheets browses as spreadsheet (container) → tab (object). A tab is
  // not a file: it has no format and no extension, and the output side names
  // one to write into rather than inventing a filename.
  const isSheets = connection?.dbType === 'google-sheets';

  // Helper function to get the correct container identifier based on dbType
  const getContainerIdentifier = (container) => (
    isIdAddressed() ? (container.id || container.name) : (container.name || container.id)
  );

  // Helper function to get the correct folder path/ID based on dbType
  const getFolderPrefix = (pathArray) => {
    if (!pathArray || pathArray.length === 0) {
      return '';
    }

    // OneDrive, SharePoint and Google Drive use item IDs for folder navigation
    if (isIdAddressed()) {
      // Return the ID of the last folder in the path
      const lastFolder = pathArray[pathArray.length - 1];
      return lastFolder.id || lastFolder.objectKey || '';
    }

    // S3, Azure Blob, GCS use folder names as prefixes
    const folderPath = pathArray.map(p => p.name).join('/');
    return folderPath ? folderPath + '/' : '';
  };

  useEffect(() => {
    if (open && connection) {
      loadContainers();
      // Reset output format based on source type when opening
      if (mode === 'output') {
        setOutputFormat(getDefaultFormat());
      }
    }
  }, [open, connection, sourceDbType]);

  // Debounced search effect
  useEffect(() => {
    if (!currentContainer) return;

    const debounceTimer = setTimeout(() => {
      const prefix = getFolderPrefix(currentPath);
      loadObjects(getContainerIdentifier(currentContainer), prefix, true);
    }, 500); // 500ms debounce

    return () => clearTimeout(debounceTimer);
  }, [searchTerm]);

  const loadContainers = async () => {
    setLoading(true);
    try {
      if (!window.electronAPI?.cloudStorage?.getContainers) {
        message.error('Cloud storage API not available');
        return;
      }

      const result = await window.electronAPI.cloudStorage.getContainers(
        connection.id,
        connection.dbType
      );

      if (result.success) {
        setContainers(result.containers || []);
      } else {
        message.error('Failed to load containers: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading containers:', error);
      message.error('Failed to load containers');
    } finally {
      setLoading(false);
    }
  };

  const loadObjects = async (containerName, prefix = '', resetPagination = true, searchTermOverride = null) => {
    setLoading(true);
    try {
      if (!window.electronAPI?.cloudStorage?.listObjects) {
        message.error('Cloud storage API not available');
        return;
      }

      const effectiveSearchTerm = searchTermOverride !== null ? searchTermOverride : searchTerm;

      const result = await window.electronAPI.cloudStorage.listObjects(
        connection.id,
        connection.dbType,
        containerName,
        prefix,
        pageSize,
        resetPagination ? null : continuationToken,
        effectiveSearchTerm
      );
      console.log('loadObjects: ', result)
      if (result.success) {
        if (resetPagination) {
          setObjects(result.objects || []);
        } else {
          // Append to existing objects for "Load More"
          setObjects(prev => [...prev, ...(result.objects || [])]);
        }
        setContinuationToken(result.nextContinuationToken || null);
        setHasMore(result.isTruncated || false);
      } else {
        message.error('Failed to load files: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading objects:', error);
      message.error('Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreObjects = async () => {
    if (!hasMore || loadingMore) return;

    setLoadingMore(true);
    try {
      if (!window.electronAPI?.cloudStorage?.listObjects) {
        message.error('Cloud storage API not available');
        return;
      }

      const prefix = getFolderPrefix(currentPath);

      const result = await window.electronAPI.cloudStorage.listObjects(
        connection.id,
        connection.dbType,
        getContainerIdentifier(currentContainer),
        prefix,
        pageSize,
        continuationToken,
        searchTerm
      );

      if (result.success) {
        setObjects(prev => [...prev, ...(result.objects || [])]);
        setContinuationToken(result.nextContinuationToken || null);
        setHasMore(result.isTruncated || false);
      } else {
        message.error('Failed to load more files: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading more objects:', error);
      message.error('Failed to load more files');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleContainerClick = (container) => {
    setCurrentContainer(container);
    setCurrentPath([]);
    setSearchTerm(''); // Reset search when switching containers
    loadObjects(getContainerIdentifier(container), '', true, '');
  };

  const handleObjectClick = (object) => {
    if (object.isFolder) {
      // Navigate into folder
      const newPath = [...currentPath, object];
      setCurrentPath(newPath);
      const folderPrefix = getFolderPrefix(newPath);
      loadObjects(getContainerIdentifier(currentContainer), folderPrefix, true);
    } else if (mode === 'import') {
      // Check if file type is supported before selecting
      if (checkFileType(object)) {
        setSelectedFile(object);
      }
    } else if (isSheets) {
      // Output mode: clicking a tab targets it, which is how an EXISTING tab is
      // chosen. Typing a name that is not in the list creates that tab instead.
      setOutputFileName(object.objectKey || object.name);
    }
    // For other stores in output mode, clicking files does nothing — the user
    // navigates to a folder and types a filename.
  };

  const handleBreadcrumbClick = (index) => {
    if (index === -1) {
      // Back to containers
      setCurrentContainer(null);
      setCurrentPath([]);
      setObjects([]);
      setSelectedFile(null);
      setSearchTerm('');
      setContinuationToken(null);
      setHasMore(false);
    } else if (index === 0 && currentPath.length > 0) {
      // Back to container root
      setCurrentPath([]);
      setSelectedFile(null);
      loadObjects(getContainerIdentifier(currentContainer), '', true);
    } else if (index < currentPath.length) {
      // Navigate to specific folder
      const newPath = currentPath.slice(0, index);
      setCurrentPath(newPath);
      const folderPrefix = getFolderPrefix(newPath);
      setSelectedFile(null);
      loadObjects(getContainerIdentifier(currentContainer), folderPrefix, true);
    }
  };

  const isSupportedFileType = (fileName) => {
    const name = fileName.toLowerCase();
    const supportedTypes = ['.csv', '.xlsx', '.xls', '.json', '.sqlite', '.db', '.parquet', '.avro'];
    return supportedTypes.some(ext => name.endsWith(ext));
  };

  const checkFileType = (file) => {
    const isSupported = isSupportedFileType(file.name);

    if (!isSupported) {
      message.warning('This file type is not supported. Please select CSV, Excel, JSON, SQLite, Parquet, or Avro files.');
      setSelectedFile(null); // Don't allow selection of unsupported files
      return false;
    }
    return true;
  };

  const getFileIcon = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv')) return <FileTextOutlined style={{ fontSize: 24, color: '#52c41a' }} />;
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return <FileExcelOutlined style={{ fontSize: 24, color: '#1890ff' }} />;
    if (name.endsWith('.json')) return <FileTextOutlined style={{ fontSize: 24, color: '#fa8c16' }} />;
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return <DatabaseOutlined style={{ fontSize: 24, color: '#722ed1' }} />;
    if (name.endsWith('.parquet')) return <DatabaseOutlined style={{ fontSize: 24, color: '#eb2f96' }} />;
    if (name.endsWith('.avro')) return <DatabaseOutlined style={{ fontSize: 24, color: '#13c2c2' }} />;
    if (name.endsWith('.pdf')) return <FilePdfOutlined style={{ fontSize: 24, color: '#f5222d' }} />;
    if (name.match(/\.(jpg|jpeg|png|gif|bmp|svg)$/)) return <FileImageOutlined style={{ fontSize: 24, color: '#faad14' }} />;
    return <FileOutlined style={{ fontSize: 24, color: '#8c8c8c' }} />;
  };

  const getFileTypeTag = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv')) return <Tag color="success">CSV</Tag>;
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return <Tag color="blue">Excel</Tag>;
    if (name.endsWith('.json')) return <Tag color="orange">JSON</Tag>;
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return <Tag color="purple">SQLite</Tag>;
    if (name.endsWith('.parquet')) return <Tag color="magenta">Parquet</Tag>;
    if (name.endsWith('.avro')) return <Tag color="cyan">Avro</Tag>;
    return <Tag color="default">File</Tag>;
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const handleDownloadAndImport = async () => {
    if (!selectedFile) return;

    setDownloadingFile(true);
    setProcessingFile(true);

    try {
      if (!window.electronAPI?.cloudStorage?.downloadObject) {
        message.error('Cloud storage API not available');
        setProcessingFile(false);
        return;
      }

      // Use objectKey if available, otherwise construct path-based key
      const objectIdentifier = selectedFile.objectKey || selectedFile.name;

      // Download file from cloud storage
      const downloadResult = await window.electronAPI.cloudStorage.downloadObject(
        connection.id,
        connection.dbType,
        getContainerIdentifier(currentContainer),
        objectIdentifier
      );

      if (!downloadResult.success) {
        message.error('Failed to download file: ' + downloadResult.message);
        return;
      }

      // A workbook no longer needs a sheet chosen here: the file is kept as a
      // file, and every sheet in it is registered as a table the user picks
      // between later — exactly as a workbook added from disk behaves.
      const fileName = selectedFile.name;
      const fileType = getLocalFileType(fileName);

      if (!fileType) {
        message.error('Unsupported file type');
        return;
      }

      await saveFileLocally(downloadResult.data, fileName);
    } catch (error) {
      console.error('Error downloading file:', error);
      message.error('Failed to download and import file');
      setProcessingFile(false);
    } finally {
      setDownloadingFile(false);
    }
  };

  /**
   * Keep the downloaded file, somewhere the user chooses, and register it as a
   * local data source.
   *
   * It is no longer imported into the app's shared SQLite database — the file
   * itself is the data source now, so DuckDB reads it in place, a workbook
   * keeps all of its sheets, and the user has a real file they can open.
   */
  const saveFileLocally = async (fileData, fileName) => {
    try {
      if (!window.electronAPI?.selectSavePath || !window.electronAPI?.cloudStorage?.saveAndRegister) {
        message.error('Saving cloud files is not available');
        return;
      }

      const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
      const chosen = await window.electronAPI.selectSavePath(fileName, extension);
      if (chosen.canceled || !chosen.filePath) return;

      setProcessingFile(true);
      const result = await window.electronAPI.cloudStorage.saveAndRegister({
        data: fileData,
        targetPath: chosen.filePath,
      });

      if (!result.success) {
        message.error('Failed to save file: ' + result.message);
        return;
      }

      const tableNames = result.tables.map((t) => t.name);
      const sheeted = result.tables.filter((t) => t.sheet);
      message.success(
        result.tables.length > 1
          ? `Saved ${fileName} — ${result.tables.length} tables, read in place`
          : `Saved ${fileName} — read in place, no import needed`,
      );

      onFileSelect({
        fileName,
        localPath: result.filePath,
        // Every local file is read by DuckDB, whatever format it arrived in.
        dbType: 'duckdb',
        format: result.format,
        tables: tableNames,
        tablePaths: Object.fromEntries(result.tables.map((t) => [t.name, t.path])),
        tableSheets: sheeted.length
          ? Object.fromEntries(sheeted.map((t) => [t.name, t.sheet]))
          : null,
        schemas: result.tables.map((t) => t.schema).filter(Boolean),
        cloudSource: {
          connectionId: connection.id,
          connectionName: connection.name,
          dbType: connection.dbType,
          containerName: getContainerIdentifier(currentContainer),
          objectName: selectedFile.name,
          objectKey: selectedFile.objectKey || selectedFile.name, // Use objectKey if available
          objectPath: [...currentPath, selectedFile].map(p => p.name).join('/'),
          // Where the file was saved, so a workflow run refreshes THIS file
          // rather than importing a fresh copy somewhere the user cannot see.
          localPath: result.filePath,
        }
      });

      onClose();
    } catch (error) {
      console.error('Error saving file:', error);
      message.error('Failed to save file');
    } finally {
      setProcessingFile(false);
    }
  };

  const getLocalFileType = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls')) return 'spreadsheet';
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return 'sqlite';
    if (name.endsWith('.parquet')) return 'parquet';
    if (name.endsWith('.avro')) return 'avro';
    return null;
  };

  const handleSelectOutputPath = () => {
    if (!currentContainer) {
      message.error('Please select a container first');
      return;
    }

    if (!outputFileName.trim()) {
      message.error('Please enter a filename');
      return;
    }

    // Automatically append the extension based on selected format. A Sheets
    // tab takes the name as typed — "Results.csv" would become a tab called
    // exactly that.
    const extension = `.${outputFormat}`;
    const fileNameWithExtension = isSheets
      ? outputFileName.trim()
      : (outputFileName.endsWith(extension) ? outputFileName : `${outputFileName}${extension}`);
    console.log('currentContainer: ', currentContainer)
    // Build the full path.
    //
    // OneDrive/SharePoint upload to `<driveId>:/folder/file.ext`, so the folders
    // travel in the object path by NAME. Google Drive has no such syntax — a
    // file is created under a parent id — so the folder the user browsed to
    // becomes the container and the object is just the file.
    const drivesByFolderId = connection.dbType === 'google-drive';
    const folderPath = drivesByFolderId ? '' : currentPath.map(p => p.name).join('/');
    const objectPath = folderPath ? `${folderPath}/${fileNameWithExtension}` : fileNameWithExtension;
    // Use getContainerIdentifier to get the correct identifier based on dbType
    const containerName = (drivesByFolderId && getFolderPrefix(currentPath))
      || getContainerIdentifier(currentContainer);

    onFileSelect({
      containerName,
      objectPath,
      fullPath: `${containerName}/${objectPath}`
    });

    onClose();
  };

  // No need for frontend filtering anymore - search is done server-side
  const filteredObjects = objects;

  return (
    <Modal
      title={
        <Space>
          <CloudDownloadOutlined style={{ fontSize: 20, color: '#1890ff' }} />
          <Text strong>Cloud Storage Browser</Text>
          {connection && <Tag color="blue">{connection.name}</Tag>}
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={null}
      destroyOnClose
      styles={{ body: { padding: 0, maxHeight: '70vh', overflow: 'hidden' } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '70vh' }}>
        {/* Breadcrumb Navigation */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
          <Breadcrumb>
            <Breadcrumb.Item>
              <Button
                type="text"
                size="small"
                icon={<HomeOutlined />}
                onClick={() => handleBreadcrumbClick(-1)}
                disabled={!currentContainer}
              >
                Containers
              </Button>
            </Breadcrumb.Item>
            {currentContainer && (
              <Breadcrumb.Item>
                <Button
                  type="text"
                  size="small"
                  onClick={() => handleBreadcrumbClick(0)}
                  disabled={currentPath.length === 0}
                  style={{ fontWeight: currentPath.length === 0 ? 600 : 400 }}
                >
                  {currentContainer.name || currentContainer.id}
                </Button>
              </Breadcrumb.Item>
            )}
            {currentPath.map((folder, index) => (
              <Breadcrumb.Item key={index}>
                <Button
                  type="text"
                  size="small"
                  onClick={() => handleBreadcrumbClick(index + 1)}
                  disabled={index === currentPath.length - 1}
                  style={{ fontWeight: index === currentPath.length - 1 ? 600 : 400 }}
                >
                  {folder.name}
                </Button>
              </Breadcrumb.Item>
            ))}
          </Breadcrumb>

          {currentContainer && (
            <Input
              placeholder="Search files (server-side)..."
              prefix={<SearchOutlined />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ marginTop: 12 }}
              allowClear
              suffix={loading && <Spin size="small" />}
            />
          )}
        </div>

        {/* Main Content Area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* File List */}
          <div style={{
            flex: selectedFile ? '0 0 55%' : 1,
            padding: 24,
            overflowY: 'auto',
            borderRight: selectedFile ? '1px solid #f0f0f0' : 'none'
          }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 60 }}>
                <Spin size="large" />
                <div style={{ marginTop: 16, color: '#8c8c8c' }}>Loading...</div>
              </div>
            ) : !currentContainer ? (
              // Show Containers
              <div>
                <Title level={5} style={{ marginBottom: 16 }}>Select a Container</Title>
                {containers.length === 0 ? (
                  connection.dbType === 'azure-blob' ? (
                    <Card style={{ maxWidth: 600, margin: '0 auto' }}>
                      <Empty
                        description={
                          <div>
                            <Text strong style={{ fontSize: 16 }}>No Containers Found</Text>
                            <div style={{ marginTop: 16, textAlign: 'left' }}>
                              <Text>To use Azure Blob Storage, you need to create a container first:</Text>
                              <ol style={{ marginTop: 12, paddingLeft: 20 }}>
                                <li style={{ marginBottom: 8 }}>
                                  Go to <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer">Azure Portal</a>
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Navigate to your Storage Account
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Click <strong>"Containers"</strong> in the left menu
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Click <strong>"+ Container"</strong> at the top
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Enter a name (e.g., <code>my-data</code>, <code>exports</code>)
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Set access level to <strong>"Private"</strong>
                                </li>
                                <li>
                                  Click <strong>"Create"</strong>
                                </li>
                              </ol>
                              <div style={{ marginTop: 16, padding: 12, background: '#f0f5ff', borderRadius: 4 }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  <strong>Note:</strong> Container names must be lowercase, 3-63 characters, and can only contain letters, numbers, and hyphens.
                                </Text>
                              </div>
                              <div style={{ marginTop: 16, textAlign: 'center' }}>
                                <Button type="primary" onClick={loadContainers}>
                                  Refresh Containers
                                </Button>
                              </div>
                            </div>
                          </div>
                        }
                      />
                    </Card>
                  ) : (
                    <Empty description="No containers found" />
                  )
                ) : (
                  <List
                    grid={{ gutter: 16, xs: 1, sm: 2, md: 2, lg: 2, xl: 2 }}
                    dataSource={containers}
                    renderItem={container => (
                      <List.Item>
                        <Card
                          hoverable
                          onClick={() => handleContainerClick(container)}
                          style={{ textAlign: 'center' }}
                          bodyStyle={{ padding: 24 }}
                        >
                          <FolderOutlined style={{ fontSize: 48, color: '#faad14', marginBottom: 12 }} />
                          <Title level={5} style={{ margin: 0 }}>{container.name || container.id}</Title>
                          {container.description && (
                            <Text type="secondary" style={{ fontSize: 12 }}>{container.description}</Text>
                          )}
                        </Card>
                      </List.Item>
                    )}
                  />
                )}
              </div>
            ) : (
              // Show Objects (files and folders)
              <div>
                <Title level={5} style={{ marginBottom: 16 }}>
                  {filteredObjects.length} {filteredObjects.length === 1 ? 'item' : 'items'}
                  {hasMore && <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 8 }}>(more available)</Text>}
                  {searchTerm && <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 8 }}>- filtered by "{searchTerm}"</Text>}
                </Title>
                {filteredObjects.length === 0 ? (
                  <Empty description="No files found" />
                ) : (
                  <List
                    dataSource={filteredObjects}
                    renderItem={object => {
                      const isFile = !object.isFolder;
                      const isSupported = isFile ? isSupportedFileType(object.name) : true;
                      const isClickable = object.isFolder || (mode === 'import' && isSupported);

                      return (
                        <List.Item
                          onClick={() => isClickable ? handleObjectClick(object) : null}
                          style={{
                            cursor: isClickable ? 'pointer' : 'not-allowed',
                            padding: '12px 16px',
                            borderRadius: 8,
                            border: selectedFile?.name === object.name ? '2px solid #1890ff' : '1px solid #f0f0f0',
                            marginBottom: 8,
                            background: selectedFile?.name === object.name ? '#e6f7ff' : '#fff',
                            transition: 'all 0.2s',
                            opacity: (isFile && !isSupported) || (!object.isFolder && mode === 'output') ? 0.5 : 1
                          }}
                          onMouseEnter={(e) => {
                            if (isClickable && selectedFile?.name !== object.name) {
                              e.currentTarget.style.background = '#fafafa';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (isClickable && selectedFile?.name !== object.name) {
                              e.currentTarget.style.background = '#fff';
                            }
                          }}
                        >
                        <List.Item.Meta
                          avatar={
                            object.isFolder
                              ? <FolderOutlined style={{ fontSize: 24, color: '#faad14' }} />
                              : getFileIcon(object.name)
                          }
                          title={
                            <Space>
                              <Text strong style={{ fontSize: 14, opacity: (isFile && !isSupported) ? 0.6 : 1 }}>
                                {object.name}
                              </Text>
                              {!object.isFolder && getFileTypeTag(object.name)}
                              {isFile && !isSupported && mode === 'import' && (
                                <Tag color="default">Unsupported</Tag>
                              )}
                              {selectedFile?.name === object.name && (
                                <CheckCircleOutlined style={{ color: '#1890ff' }} />
                              )}
                            </Space>
                          }
                          description={
                            !object.isFolder && (
                              <Space size="large">
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {formatFileSize(object.size)}
                                </Text>
                                {object.lastModified && (
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {new Date(object.lastModified).toLocaleDateString()}
                                  </Text>
                                )}
                              </Space>
                            )
                          }
                        />
                      </List.Item>
                    );
                    }}
                  />
                )}

                {/* Load More Button */}
                {hasMore && !loading && filteredObjects.length > 0 && (
                  <div style={{ textAlign: 'center', marginTop: 16 }}>
                    <Button
                      onClick={loadMoreObjects}
                      loading={loadingMore}
                      size="large"
                      style={{ minWidth: 200 }}
                    >
                      {loadingMore ? 'Loading...' : `Load More (${filteredObjects.length} loaded)`}
                    </Button>
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Showing {filteredObjects.length} items. Click to load more.
                      </Text>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* File Details Panel (Import Mode) */}
          {mode === 'import' && selectedFile && (
            <div style={{
              flex: '0 0 45%',
              padding: 24,
              overflowY: 'auto',
              background: '#fafafa'
            }}>
              <Title level={5} style={{ marginBottom: 16 }}>File Details</Title>

              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    {getFileIcon(selectedFile.name)}
                    <Title level={5} style={{ margin: '12px 0 4px' }}>{selectedFile.name}</Title>
                    {getFileTypeTag(selectedFile.name)}
                  </div>

                  <Divider style={{ margin: '12px 0' }} />

                  <Row gutter={[16, 12]}>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Size</Text>
                    </Col>
                    <Col span={16}>
                      <Text strong>{formatFileSize(selectedFile.size)}</Text>
                    </Col>

                    {selectedFile.lastModified && (
                      <>
                        <Col span={8}>
                          <Text type="secondary" style={{ fontSize: 12 }}>Modified</Text>
                        </Col>
                        <Col span={16}>
                          <Text>{new Date(selectedFile.lastModified).toLocaleString()}</Text>
                        </Col>
                      </>
                    )}

                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Location</Text>
                    </Col>
                    <Col span={16}>
                      <Text style={{ fontSize: 12, wordBreak: 'break-all' }}>
                        {[currentContainer.name, ...currentPath.map(p => p.name)].join(' / ')}
                      </Text>
                    </Col>
                  </Row>
                </Space>
              </Card>

              {/* A workbook needs no sheet chosen here any more: the file is
                  saved whole and every sheet becomes a table. */}

              {/* Save Button */}
              <Button
                type="primary"
                size="large"
                block
                icon={<CloudDownloadOutlined />}
                onClick={handleDownloadAndImport}
                loading={downloadingFile || processingFile}
                disabled={!isSupportedFileType(selectedFile.name)}
              >
                {processingFile ? 'Saving...' : downloadingFile ? 'Downloading...' : 'Download File'}
              </Button>

              {!isSupportedFileType(selectedFile.name) ? (
                <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12, color: '#ff4d4f' }}>
                  This file type is not supported for import
                </Text>
              ) : (
                <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12 }}>
                  You'll choose where to save it, then it's read in place
                </Text>
              )}
            </div>
          )}

          {/* Output Path Selection Panel (Output Mode) */}
          {mode === 'output' && currentContainer && (
            <div style={{
              flex: '0 0 45%',
              padding: 24,
              overflowY: 'auto',
              background: '#fafafa'
            }}>
              <Title level={5} style={{ marginBottom: 16 }}>Output Destination</Title>

              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Container</Text>
                    <Text strong style={{ fontSize: 16 }}>{currentContainer.name || currentContainer.id}</Text>
                  </div>

                  <Divider style={{ margin: '8px 0' }} />

                  {!isSheets && (
                    <>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Folder Path</Text>
                        <Text style={{ fontSize: 14 }}>
                          {currentPath.length > 0 ? currentPath.map(p => p.name).join(' / ') : '/ (root)'}
                        </Text>
                      </div>

                      <Divider style={{ margin: '8px 0' }} />
                    </>
                  )}

                  {!isSheets && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>Output Format *</Text>
                    <Select
                      value={outputFormat}
                      onChange={(value) => setOutputFormat(value)}
                      style={{ width: '100%' }}
                      size="large"
                    >
                      <Option value="json">
                        <Space>
                          <Tag color="orange">JSON</Tag>
                          <Text>JSON Format {sourceDbType && sourceDbType.toLowerCase() === 'mongodb' && '(Recommended for NoSQL)'}</Text>
                        </Space>
                      </Option>
                      <Option value="csv">
                        <Space>
                          <Tag color="success">CSV</Tag>
                          <Text>CSV Format {sourceDbType && sourceDbType.toLowerCase() !== 'mongodb' && '(Recommended for SQL)'}</Text>
                        </Space>
                      </Option>
                    </Select>
                  </div>
                  )}

                  {!isSheets && <Divider style={{ margin: '8px 0' }} />}

                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                      {isSheets ? 'Sheet tab *' : 'Output Filename *'}
                    </Text>
                    <Input
                      placeholder={isSheets
                        ? 'Tab name (click one above, or type a new one)'
                        : 'output (extension will be added automatically)'}
                      value={outputFileName}
                      onChange={(e) => setOutputFileName(e.target.value)}
                      onPressEnter={handleSelectOutputPath}
                      size="large"
                      suffix={isSheets
                        ? null
                        : (outputFormat === 'json' ? <Tag color="orange">.json</Tag> : <Tag color="success">.csv</Tag>)}
                    />
                    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                      {isSheets
                        ? 'Rows are appended when the tab already has a header row; a tab that does not exist is created.'
                        : `Extension (.${outputFormat}) will be added automatically`}
                    </Text>
                  </div>

                  <Divider style={{ margin: '8px 0' }} />

                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                      {isSheets ? 'Writes to' : 'Full Path Preview'}
                    </Text>
                    <Text code style={{ fontSize: 12, display: 'block', wordBreak: 'break-all', padding: '8px', background: '#f5f5f5', borderRadius: 4 }}>
                      {(() => {
                        if (isSheets) {
                          const container = currentContainer.name || currentContainer.id;
                          return `${container} → ${outputFileName.trim() || 'tab name'}`;
                        }
                        const extension = `.${outputFormat}`;
                        const fileNameWithExt = outputFileName ? (outputFileName.endsWith(extension) ? outputFileName : `${outputFileName}${extension}`) : `filename${extension}`;
                        return currentPath.length > 0
                          ? `${currentContainer.name || currentContainer.id}/${currentPath.map(p => p.name).join('/')}/${fileNameWithExt}`
                          : `${currentContainer.name || currentContainer.id}/${fileNameWithExt}`;
                      })()}
                    </Text>
                  </div>
                </Space>
              </Card>

              {/* Select Path Button */}
              <Button
                type="primary"
                size="large"
                block
                onClick={handleSelectOutputPath}
                disabled={!outputFileName.trim()}
              >
                Select This Path
              </Button>

              <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12 }}>
                {isSheets
                  ? 'Pick an existing tab above, or type a name to create one'
                  : 'Navigate to folders above and enter a filename'}
              </Text>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default CloudStorageBrowser;
