/**
 * Amazon S3 Storage Connector Plugin for Ternlux
 * Handles all S3 storage operations
 */

const { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

// S3 client cache
const s3Clients = new Map();

/**
 * Get or create S3 client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!s3Clients.has(key)) {
    const clientConfig = {
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };

    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
      clientConfig.forcePathStyle = true;
    }

    const client = new S3Client(clientConfig);
    s3Clients.set(key, client);
  }

  return s3Clients.get(key);
}

module.exports = {
  type: 'connector',
  id: 's3',
  name: 'Amazon S3',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',

  /**
   * Test S3 connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);

      // Try to list buckets to verify credentials
      const command = new ListBucketsCommand({});
      await client.send(command);

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (buckets in S3)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);
      const command = new ListBucketsCommand({});
      const response = await client.send(command);

      return {
        success: true,
        containers: response.Buckets.map(bucket => ({
          name: bucket.Name,
          creationDate: bucket.CreationDate
        }))
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a container
   * @param {string} prefix - Filter objects by prefix (folder path)
   * @param {number} maxKeys - Maximum number of objects to return (default 100, max 1000)
   * @param {string} continuationToken - Token for pagination (from previous response)
   * @param {string} searchTerm - Search term to filter object names (server-side filtering)
   */
  listObjects: async (config, connectionId, containerName, prefix = '', maxKeys = 100, continuationToken = null, searchTerm = '') => {
    try {
      const client = getClient(config, connectionId);

      // Combine prefix with search term for server-side filtering
      const effectivePrefix = searchTerm ? `${prefix}${searchTerm}` : prefix;

      const commandParams = {
        Bucket: containerName,
        Prefix: effectivePrefix,
        MaxKeys: maxKeys,
        Delimiter: '/' // This helps identify folders vs files
      };

      if (continuationToken) {
        commandParams.ContinuationToken = continuationToken;
      }

      const command = new ListObjectsV2Command(commandParams);
      const response = await client.send(command);

      // Process folders (common prefixes)
      const folders = (response.CommonPrefixes || []).map(p => ({
        name: p.Prefix.replace(prefix, '').replace(/\/$/, ''), // Use original prefix, not effectivePrefix
        objectKey: p.Prefix, // Full key for navigation
        isFolder: true,
        size: 0,
        lastModified: null
      }));

      // Process files (contents)
      const files = (response.Contents || [])
        .filter(obj => obj.Key !== effectivePrefix) // Exclude the prefix itself
        .map(obj => ({
          name: obj.Key.replace(prefix, ''), // Use original prefix, not effectivePrefix
          objectKey: obj.Key, // Full key for downloading
          size: obj.Size,
          lastModified: obj.LastModified,
          etag: obj.ETag,
          isFolder: false
        }));

      return {
        success: true,
        objects: [...folders, ...files],
        isTruncated: response.IsTruncated || false,
        nextContinuationToken: response.NextContinuationToken || null,
        totalCount: (folders.length + files.length)
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
      console.log('downloadObject: ', containerName, objectName)
      const command = new GetObjectCommand({
        Bucket: containerName,
        Key: objectName
      });
      const response = await client.send(command);

      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      console.log('buffer: ', buffer)
      return {
        success: true,
        data: buffer,
        contentType: response.ContentType,
        contentLength: response.ContentLength
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

      const upload = new Upload({
        client,
        params: {
          Bucket: containerName,
          Key: objectName,
          Body: data,
          ContentType: contentType
        }
      });

      await upload.done();

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
      const command = new DeleteObjectCommand({
        Bucket: containerName,
        Key: objectName
      });

      await client.send(command);

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
      const command = new HeadObjectCommand({
        Bucket: containerName,
        Key: objectName
      });

      const response = await client.send(command);

      return {
        success: true,
        metadata: {
          size: response.ContentLength,
          contentType: response.ContentType,
          lastModified: response.LastModified,
          etag: response.ETag
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
    if (s3Clients.has(connectionId)) {
      const client = s3Clients.get(connectionId);
      client.destroy();
      s3Clients.delete(connectionId);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'accessKeyId',
        type: 'string',
        label: 'Access Key ID',
        placeholder: 'AKIAIOSFODNN7EXAMPLE',
        required: true,
        sensitive: true
      },
      {
        name: 'secretAccessKey',
        type: 'password',
        label: 'Secret Access Key',
        required: true,
        sensitive: true
      },
      {
        name: 'region',
        type: 'string',
        label: 'Region',
        placeholder: 'us-east-1',
        default: 'us-east-1',
        required: true,
        sensitive: false
      },
      {
        name: 'endpoint',
        type: 'string',
        label: 'Custom Endpoint (Optional)',
        placeholder: 'https://s3.custom-endpoint.com',
        required: false,
        sensitive: false,
        helpText: 'For S3-compatible services like MinIO'
      }
    ]
  }
};
