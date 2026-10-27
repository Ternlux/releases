import React from 'react';
import { Upload, Progress, Typography, Card, Space, Input, Form, Button, message } from 'antd';
import { InboxOutlined, FileExcelOutlined, CloudUploadOutlined, LoadingOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { stubTrue } from 'lodash';

const { Dragger } = Upload;
const { Text, Title } = Typography;

const UploadStep = ({
  // Props
  editingConnection,
  droppedFile,
  uploading,
  uploadProgress,
  uploadedFile,
  connectionName,
  setConnectionName,
  description,
  setDescription,
  skipRows,
  setSkipRows,
  form,
  nameValidationStatus,
  nameValidationMessage,
  isCheckingName,
  loadingSchema,

  // Handlers
  handleCancel,
  handleNext,
  handleCreateConnection,
  uploadProps,
  onFileSelect
}) => {
  const handleBrowseFiles = async () => {
    if (!window.electronAPI?.openFileDialog) {
      message.warning('File browser requires the desktop app');
      return;
    }

    try {
      const result = await window.electronAPI.openFileDialog();

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return;
      }

      const filePath = result.filePaths[0];
      const fileName = filePath.split(/[\\/]/).pop();

      // Validate file extension
      const validExtensions = ['.xlsx', '.xls', '.csv'];
      const fileExtension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();

      if (!validExtensions.includes(fileExtension)) {
        message.error('Please select an Excel (.xlsx, .xls) or CSV (.csv) file');
        return;
      }

      // Create a File-like object from the path
      const file = {
        name: fileName,
        path: filePath,
        type: fileExtension === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };

      // Call the file selection handler
      if (onFileSelect) {
        onFileSelect(file);
      }
    } catch (error) {
      console.error('Error opening file dialog:', error);
      message.error('Failed to open file browser');
    }
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 8 }} />
        <Title level={4}>
          {editingConnection ? 'Edit Data Source Connection' : 
           droppedFile ? 'Create Data Source from Dropped File' :
           'Create Data Source Connection'}
        </Title>
        <Text type="secondary">
          {editingConnection 
            ? 'Update your data source connection details' 
            : droppedFile
            ? `File "${droppedFile.name}" is being uploaded. Please enter connection details.`
            : 'Upload your Excel or CSV file and create a new data source connection'}
        </Text>
      </div>

      <Form form={form} layout="vertical">
        <Form.Item
          label="Connection Name"
          name="name"
          required={stubTrue}
          validateStatus={nameValidationStatus}
          help={nameValidationMessage}
        >
          <Input 
            placeholder={uploadedFile ? " Connection Name" : "Enter a connection name that isn't a duplicate"}
            value={connectionName}
            onChange={(e) => setConnectionName(e.target.value)}
            suffix={isCheckingName ? <LoadingOutlined /> : null}
          />
        </Form.Item>

        <Form.Item
          label="Description"
          name="description"
        >
          <Input.TextArea 
            placeholder="Optional description for your data source"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Form.Item>

        <Form.Item
          label="Skip Rows from Top"
          name="skipRows"
          help="Number of rows to skip from the beginning of the file (useful for headers or metadata)"
        >
          <Input 
            type="number"
            min={0}
            max={100}
            placeholder="0"
            value={skipRows}
            onChange={(e) => setSkipRows(parseInt(e.target.value) || 0)}
          />
        </Form.Item>

        <Form.Item label={editingConnection ? "Replace File (Optional)" : droppedFile ? "Uploaded File" : "Upload File"} required={!editingConnection && !droppedFile}>
          {droppedFile && !editingConnection ? (
            // Show dropped file info instead of upload area
            <div style={{ 
              border: '2px dashed #d9d9d9', 
              borderRadius: '6px', 
              padding: '20px', 
              textAlign: 'center',
              backgroundColor: '#fafafa'
            }}>
              <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 8 }} />
              <div style={{ fontSize: '16px', fontWeight: '500', marginBottom: '4px' }}>
                {droppedFile.name}
              </div>
              <div style={{ fontSize: '14px', color: '#666' }}>
                {(droppedFile.size / 1024 / 1024).toFixed(2)} MB
              </div>
            </div>
          ) : (
            <>
              <Dragger {...uploadProps} style={{ padding: 20 }}>
                <p className="ant-upload-drag-icon">
                  <InboxOutlined style={{ fontSize: 48, color: uploading ? '#ccc' : '#1890ff' }} />
                </p>
                <p className="ant-upload-text">
                  {uploading ? 'Uploading...' :
                   editingConnection ? 'Click or drag a new file to replace the existing file' :
                   'Click or drag Excel or CSV file to this area to upload'}
                </p>
                <p className="ant-upload-hint">
                  Excel (.xlsx, .xls) and CSV (.csv) files are supported. Maximum file size: 50GB
                  <br />
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {editingConnection ? (
                      <>
                        You can also drag and drop files anywhere on this page
                        <span> • <strong>Current file:</strong> {editingConnection.fileInfo?.originalName}</span>
                      </>
                    ) : (
                      <></>
                    )}
                  </Text>
                </p>
              </Dragger>
              {window.electronAPI?.openFileDialog && (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <Button
                    icon={<FolderOpenOutlined />}
                    onClick={handleBrowseFiles}
                    disabled={uploading}
                  >
                    Browse Files
                  </Button>
                </div>
              )}
            </>
          )}
        </Form.Item>

        {uploading && (
          <div style={{ marginTop: 16 }}>
            <Progress 
              percent={uploadProgress} 
              status="active"
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
            />
            <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
              Uploading in chunks... {uploadProgress}%
            </Text>
          </div>
        )}

        {uploadedFile && !uploading && (
          <Card size="small" style={{ 
            marginTop: 16, 
            backgroundColor: uploadedFile.status === 'temporary' ? '#fff7e6' : '#f6ffed', 
            border: `1px solid ${uploadedFile.status === 'temporary' ? '#ffd591' : '#b7eb8f'}` 
          }}>
            <Space>
              <CloudUploadOutlined style={{ color: uploadedFile.status === 'temporary' ? '#fa8c16' : '#52c41a' }} />
              <div>
                <Text strong>{uploadedFile.originalName}</Text>
                {uploadedFile.status === 'temporary' && (
                  <Text type="warning" style={{ marginLeft: 8, fontSize: '12px' }}>
                    (Temporary - Click "Create Data Source" to save)
                  </Text>
                )}
                <br />
                <Text type="secondary">
                  Size: {(uploadedFile.fileSize / 1024 / 1024).toFixed(2)} MB | 
                  Type: {uploadedFile.fileType} | 
                  Uploaded: {new Date(uploadedFile.uploadedAt).toLocaleString()}
                </Text>
              </div>
            </Space>
          </Card>
        )}

        <div style={{ marginTop: 24, textAlign: 'right' }}>
          <Space>
            <Button onClick={handleCancel}>
              Cancel
            </Button>
            <Button 
              type="primary" 
              onClick={editingConnection ? handleCreateConnection : handleNext}
              disabled={uploading || (!editingConnection && !uploadedFile)}
              loading={loadingSchema || uploading}
            >
              {editingConnection ? 'Update Data Source' : 'Next'}
            </Button>
          </Space>
        </div>
      </Form>
    </Space>
  );
};

export default UploadStep;