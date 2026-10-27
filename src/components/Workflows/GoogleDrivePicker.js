import React, { useState, useEffect } from 'react';
import { message } from 'antd';

/**
 * Google Drive Picker Component
 * Handles Google Picker integration for selecting files from Google Drive
 */
const GoogleDrivePicker = ({ connection, onFileSelect, onClose }) => {
  const [pickerCredentials, setPickerCredentials] = useState(null);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [downloadingFile, setDownloadingFile] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  // Load Google Picker API
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi.load('picker', () => {
        console.log('Google Picker API loaded');
      });
    };
    document.body.appendChild(script);

    return () => {
      // Cleanup script on unmount
      const scripts = document.querySelectorAll('script[src="https://apis.google.com/js/api.js"]');
      scripts.forEach(s => s.remove());
    };
  }, []);

  // Load picker credentials when component mounts
  useEffect(() => {
    if (connection) {
      loadPickerCredentials();
    }
  }, [connection]);

  // Auto-open picker when credentials are loaded
  useEffect(() => {
    if (pickerCredentials && window.google?.picker) {
      // Small delay to ensure everything is ready
      const timer = setTimeout(() => {
        openGooglePicker();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [pickerCredentials]);

  const loadPickerCredentials = async () => {
    setLoadingPicker(true);
    try {
      const result = await window.electronAPI.cloudStorage.getPickerCredentials(
        connection.id,
        connection.dbType
      );

      if (result.success) {
        setPickerCredentials({
          accessToken: result.accessToken,
          apiKey: result.apiKey,
          clientId: result.clientId
        });
      } else {
        message.error('Failed to load Google Picker: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading picker credentials:', error);
      message.error('Failed to load Google Picker');
    } finally {
      setLoadingPicker(false);
    }
  };

  const openGooglePicker = () => {
    if (!pickerCredentials) return;

    const google = window.google;
    if (!google || !google.picker) {
      message.error('Google Picker API not loaded');
      return;
    }

    const pickerBuilder = new google.picker.PickerBuilder()
      .addView(google.picker.ViewId.DOCS)
      .setOAuthToken(pickerCredentials.accessToken)
      .setCallback(handlePickerCallback);

    // Set developer key if available (optional with OAuth)
    if (pickerCredentials.apiKey) {
      pickerBuilder.setDeveloperKey(pickerCredentials.apiKey);
    }

    const picker = pickerBuilder.build();
    picker.setVisible(true);
  };

  const handlePickerCallback = async (data) => {
    if (data.action === window.google.picker.Action.PICKED) {
      const doc = data.docs[0];

      // Check if it's a Google Workspace file that needs export
      const isGoogleWorkspaceFile = doc.mimeType && doc.mimeType.startsWith('application/vnd.google-apps.');

      if (isGoogleWorkspaceFile) {
        // Handle Google Workspace files (Sheets, Docs, etc.)
        handleGoogleWorkspaceFile(doc);
      } else {
        // Regular file - download normally
        downloadFile(doc);
      }
    }
  };

  const handleGoogleWorkspaceFile = async (doc) => {
    // For now, only support Google Sheets
    if (doc.mimeType === 'application/vnd.google-apps.spreadsheet') {
      message.info('Exporting Google Sheet to Excel format...');
      // Download will be handled by exportObject instead of downloadObject
      setDownloadingFile(true);
      try {
        const result = await window.electronAPI.cloudStorage.exportObject(
          connection.id,
          connection.dbType,
          doc.id,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' // Export as Excel
        );

        if (result.success) {
          // Add .xlsx extension if not present
          const fileName = doc.name.endsWith('.xlsx') ? doc.name : `${doc.name}.xlsx`;
          await processDownloadedFile(fileName, result.data, result.contentType || result.mimeType);
        } else {
          message.error('Failed to export Google Sheet: ' + result.message);
        }
      } catch (error) {
        console.error('Error exporting Google Sheet:', error);
        message.error('Failed to export Google Sheet');
      } finally {
        setDownloadingFile(false);
      }
    } else {
      message.error(`Google ${doc.mimeType.replace('application/vnd.google-apps.', '')} files are not supported yet. Please use native Excel, CSV, or JSON files.`);
      onClose();
    }
  };

  const downloadFile = async (doc) => {
    setDownloadingFile(true);
    try {
      const result = await window.electronAPI.cloudStorage.downloadObject(
        connection.id,
        connection.dbType,
        'root', // containerName not used for Google Drive with picker
        doc.id // Use file ID from picker
      );

      if (result.success) {
        // Process the downloaded file
        await processDownloadedFile(doc.name, result.data, result.contentType || result.mimeType);
      } else {
        message.error('Failed to download file: ' + result.message);
      }
    } catch (error) {
      console.error('Error downloading file:', error);
      message.error('Failed to download file');
    } finally {
      setDownloadingFile(false);
    }
  };

  const processDownloadedFile = async (fileName, data, contentType) => {
    const fileExtension = fileName.split('.').pop().toLowerCase();
    const localFileType = getLocalFileType(fileName);

    // Check if file type is supported
    if (!checkFileType({ name: fileName })) {
      message.error(`Unsupported file type: ${fileExtension}`);
      return;
    }

    if (!localFileType) {
      message.error('Unsupported file type');
      return;
    }

    // Create a temporary file object for metadata
    const fileObject = { name: fileName, data, contentType };

    // A workbook is no longer analysed for its sheets here. It is saved whole
    // and registered, and every sheet in it becomes a table — so there is
    // nothing to choose between at download time.
    setSelectedFile(fileObject);
    await saveFileLocally(data, fileName);
  };

  /**
   * Keep the downloaded file where the user asks, then register it as a local
   * data source — the same treatment a file picked off disk gets.
   *
   * Nothing is imported into the app's SQLite database any more. A Google Sheet
   * exported as .xlsx lands as a real workbook the user owns, and every one of
   * its sheets becomes a table DuckDB reads in place.
   */
  const saveFileLocally = async (fileData, fileName) => {
    try {
      if (!window.electronAPI?.selectSavePath || !window.electronAPI?.cloudStorage?.saveAndRegister) {
        message.error('Saving Drive files is not available');
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

      const sheeted = result.tables.filter((t) => t.sheet);
      message.success(
        result.tables.length > 1
          ? `Saved ${fileName} — ${result.tables.length} tables, read in place`
          : `Saved ${fileName} — read in place, no import needed`,
      );

      onFileSelect({
        fileName,
        localPath: result.filePath,
        dbType: 'duckdb',
        format: result.format,
        tables: result.tables.map((t) => t.name),
        tablePaths: Object.fromEntries(result.tables.map((t) => [t.name, t.path])),
        tableSheets: sheeted.length
          ? Object.fromEntries(sheeted.map((t) => [t.name, t.sheet]))
          : null,
        schemas: result.tables.map((t) => t.schema).filter(Boolean),
        cloudSource: {
          connectionId: connection.id,
          connectionName: connection.name,
          containerName: 'root',
          objectName: fileName,
          objectPath: fileName,
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

  const isSupportedFileType = (fileName) => {
    const name = fileName.toLowerCase();
    const supportedTypes = ['.csv', '.xlsx', '.xls', '.json', '.sqlite', '.db', '.parquet', '.avro', '.duckdb'];
    return supportedTypes.some(ext => name.endsWith(ext));
  };

  const checkFileType = (file) => {
    const isSupported = isSupportedFileType(file.name);

    if (!isSupported) {
      message.warning('This file type is not supported. Please select CSV, Excel, JSON, SQLite, Parquet, or Avro files.');
      return false;
    }
    return true;
  };

  const getLocalFileType = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls')) return 'spreadsheet';
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return 'sqlite';
    if (name.endsWith('.duckdb')) return 'duckdb';
    if (name.endsWith('.parquet')) return 'parquet';
    if (name.endsWith('.avro')) return 'avro';
    return null;
  };

  // There is no sheet to choose any more: a workbook is saved whole and each
  // of its sheets is registered as a table, so the picker's job ends at the
  // download.

  return null;
};

export default GoogleDrivePicker;
