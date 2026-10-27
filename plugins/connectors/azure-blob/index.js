/**
 * Azure Blob Storage Connector Plugin for Ternlux
 * Handles all Azure Blob storage operations
 */

const { BlobServiceClient } = require('@azure/storage-blob');

// Azure Blob client cache
const blobClients = new Map();

/**
 * Get or create Azure Blob client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!blobClients.has(key)) {
    let client;

    if (config.connectionString) {
      client = BlobServiceClient.fromConnectionString(config.connectionString);
    } else if (config.accountName && config.accountKey) {
      const connStr = `DefaultEndpointsProtocol=https;AccountName=${config.accountName};AccountKey=${config.accountKey};EndpointSuffix=core.windows.net`;
      client = BlobServiceClient.fromConnectionString(connStr);
    } else {
      throw new Error('Either connectionString or accountName+accountKey is required');
    }

    blobClients.set(key, client);
  }

  return blobClients.get(key);
}

/**
 * Helper function to convert stream to buffer
 */
async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on('error', reject);
  });
}

module.exports = {
  type: 'connector',
  id: 'azure-blob',
  name: 'Azure Blob Storage',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',

  /**
   * Test Azure Blob connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);

      // Try to list containers to verify credentials
      const iterator = client.listContainers({ includeMetadata: false });
      await iterator.next();

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);
      const containers = [];
      console.log('client.listContainers(): ', client.listContainers())
      for await (const container of client.listContainers()) {
        containers.push({
          name: container.name,
          lastModified: container.properties.lastModified,
          publicAccess: container.properties.publicAccess
        });
      }

      return {
        success: true,
        containers
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a container
   * @param {string} prefix - Filter objects by prefix (folder path)
   * @param {number} maxKeys - Maximum number of objects to return (default 100)
   * @param {string} continuationToken - Token for pagination (from previous response)
   * @param {string} searchTerm - Search term to filter object names
   */
  listObjects: async (config, connectionId, containerName, prefix = '', maxKeys = 100, continuationToken = null, searchTerm = '') => {
    try {
      const client = getClient(config, connectionId);
      const containerClient = client.getContainerClient(containerName);

      // Combine prefix with search term
      const effectivePrefix = searchTerm ? `${prefix}${searchTerm}` : prefix;

      const options = {
        prefix: effectivePrefix,
        includeMetadata: true
      };

      const iteratorOptions = {
        maxPageSize: maxKeys
      };

      if (continuationToken) {
        iteratorOptions.continuationToken = continuationToken;
      }

      const iterator = containerClient.listBlobsByHierarchy('/', options).byPage(iteratorOptions);

      let folders = [];
      let files = [];
      let nextToken = null;

      // Get first page only
      for await (const page of iterator) {
        // Process folders (blob prefixes) - use original prefix, not effectivePrefix
        if (page.segment.blobPrefixes) {
          folders = page.segment.blobPrefixes.map(p => ({
            name: p.name.replace(prefix, '').replace(/\/$/, ''),
            objectKey: p.name, // Full key for navigation
            isFolder: true,
            size: 0,
            lastModified: null
          }));
        }

        // Process files (blob items) - use original prefix, not effectivePrefix
        if (page.segment.blobItems) {
          files = page.segment.blobItems
            .filter(blob => blob.name !== effectivePrefix)
            .map(blob => ({
              name: blob.name.replace(prefix, ''),
              objectKey: blob.name, // Full key for downloading
              size: blob.properties.contentLength,
              contentType: blob.properties.contentType,
              lastModified: blob.properties.lastModified,
              etag: blob.properties.etag,
              isFolder: false
            }));
        }

        nextToken = page.continuationToken || null;
        break; // Only get first page
      }

      return {
        success: true,
        objects: [...folders, ...files],
        isTruncated: !!nextToken,
        nextContinuationToken: nextToken,
        totalCount: folders.length + files.length
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, containerName, objectName) => {
    try {
      const client = getClient(config, connectionId);
      const containerClient = client.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(objectName);

      const downloadResponse = await blobClient.download();
      const buffer = await streamToBuffer(downloadResponse.readableStreamBody);

      return {
        success: true,
        data: buffer,
        contentType: downloadResponse.contentType,
        size: downloadResponse.contentLength
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, objectName, data, contentType) => {
    try {
      const client = getClient(config, connectionId);
      const containerClient = client.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(objectName);

      await blockBlobClient.upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType }
      });

      return {
        success: true,
        message: `Successfully uploaded ${objectName} to ${containerName}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, containerName, objectName) => {
    try {
      const client = getClient(config, connectionId);
      const containerClient = client.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(objectName);

      await blobClient.delete();

      return {
        success: true,
        message: `Successfully deleted ${objectName} from ${containerName}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, containerName, objectName) => {
    try {
      const client = getClient(config, connectionId);
      const containerClient = client.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(objectName);

      const properties = await blobClient.getProperties();

      return {
        success: true,
        metadata: {
          size: properties.contentLength,
          contentType: properties.contentType,
          lastModified: properties.lastModified,
          etag: properties.etag
        }
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Close connection (cleanup client)
   */
  closeConnection: async (connectionId) => {
    if (blobClients.has(connectionId)) {
      blobClients.delete(connectionId);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'connectionString',
        type: 'text',
        label: 'Connection String',
        placeholder: 'DefaultEndpointsProtocol=https;AccountName=...',
        required: false,
        sensitive: true,
        helpText: 'Full Azure Storage connection string'
      },
      {
        name: 'accountName',
        type: 'string',
        label: 'Account Name (Alternative)',
        placeholder: 'mystorageaccount',
        required: false,
        sensitive: true,
        helpText: 'Use with Account Key instead of connection string'
      },
      {
        name: 'accountKey',
        type: 'password',
        label: 'Account Key (Alternative)',
        required: false,
        sensitive: true,
        helpText: 'Use with Account Name instead of connection string'
      }
    ]
  }
};
