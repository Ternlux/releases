/**
 * Google Cloud Storage Connector Plugin for Ternlux
 * Handles all GCS storage operations
 *
 * Authentication is OAuth2, the same user-consent flow the other Google
 * connectors use (Drive, Sheets): the app opens a browser, captures the
 * redirect, and stores the resulting tokens on the connection. Requests are
 * then made AS THE USER, so what the connection can reach is that user's own
 * IAM grants — there is no service-account key to mint, hand around, or leak.
 */

const { Storage } = require('@google-cloud/storage');
const { OAuth2Client } = require('google-auth-library');

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/oauth/callback';

// Enough to list buckets, and to read, write and delete objects. Bucket
// listing additionally needs the signed-in user to hold a project role that
// carries `storage.buckets.list` — the scope grants reach, not permission.
const SCOPES = ['https://www.googleapis.com/auth/devstorage.read_write'];

// GCS client cache
const gcsClients = new Map();
const tokenRefreshCallbacks = new Map();

/**
 * Build an OAuth2 client from the tokens stored on the connection.
 */
function createOAuthClient(config) {
  const oauth2Client = new OAuth2Client(
    config.clientId,
    config.clientSecret,
    config.redirectUri || DEFAULT_REDIRECT_URI
  );

  if (config.accessToken || config.refreshToken) {
    oauth2Client.setCredentials({
      access_token: config.accessToken,
      refresh_token: config.refreshToken,
      scope: config.scope,
      token_type: 'Bearer',
      expiry_date: config.expiryDate
    });
  }

  return oauth2Client;
}

/**
 * True when the connection was saved with OAuth rather than a service account.
 */
function isOAuthConfig(config) {
  return !!(config.clientId || config.accessToken || config.refreshToken);
}

/**
 * Get or create GCS client
 *
 * `authClient` hands the storage library a ready-made credential instead of
 * letting it hunt for application-default ones, which is what lets an OAuth2
 * user client stand in for a service-account key. `projectId` must still be
 * supplied — bucket listing is a project-scoped call and the user's token
 * carries no project of its own.
 *
 * Service-account fields are still honoured so connections saved before the
 * move to OAuth keep working; nothing in the form writes them any more.
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!gcsClients.has(key)) {
    const options = {
      projectId: config.projectId,
    };

    if (isOAuthConfig(config)) {
      const oauth2Client = createOAuthClient(config);

      // The library refreshes an expired access token on its own; this is how
      // the new one gets back out to the stored connection rather than living
      // only in this process.
      oauth2Client.on('tokens', (tokens) => {
        const callback = connectionId && tokenRefreshCallbacks.get(connectionId);
        if (!callback) return;
        Promise.resolve(callback({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || config.refreshToken,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope
        })).catch(err => console.error('[GCS] Token persist error:', err));
      });

      options.authClient = oauth2Client;
    } else if (config.keyFilePath) {
      options.keyFilename = config.keyFilePath;
    } else if (config.credentials) {
      const creds = typeof config.credentials === 'string'
        ? JSON.parse(config.credentials)
        : config.credentials;
      options.credentials = creds;
    }

    const client = new Storage(options);
    gcsClients.set(key, client);
  }

  return gcsClients.get(key);
}

module.exports = {
  type: 'connector',
  id: 'gcs',
  name: 'Google Cloud Storage',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const oauth2Client = createOAuthClient(config);

      const authUrl = oauth2Client.generateAuthUrl({
        // Without offline access Google returns no refresh token, and the
        // connection would stop working an hour after it was saved.
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        state: config.state
      });

      return { success: true, authUrl, scopes: SCOPES };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Exchange authorization code for tokens
   */
  exchangeCodeForTokens: async (config, code) => {
    try {
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || DEFAULT_REDIRECT_URI
      );

      const { tokens } = await oauth2Client.getToken(code);

      return {
        success: true,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope
        }
      };
    } catch (error) {
      console.error('[GCS] Token exchange error:', error.response?.data?.error_description || error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Refresh access token using refresh token
   */
  refreshAccessToken: async (config) => {
    try {
      if (!config.refreshToken) {
        return { success: false, message: 'No refresh token available' };
      }

      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || DEFAULT_REDIRECT_URI
      );
      oauth2Client.setCredentials({ refresh_token: config.refreshToken });

      const { credentials } = await oauth2Client.refreshAccessToken();

      return {
        success: true,
        tokens: {
          accessToken: credentials.access_token,
          refreshToken: credentials.refresh_token || config.refreshToken,
          expiryDate: credentials.expiry_date,
          tokenType: credentials.token_type,
          scope: credentials.scope
        }
      };
    } catch (error) {
      console.error('[GCS] Token refresh error:', error.response?.data?.error_description || error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Register token refresh callback so the app can persist rotated tokens
   */
  registerTokenRefreshCallback: (connectionId, callback) => {
    tokenRefreshCallbacks.set(connectionId, callback);
  },

  /**
   * Test GCS connection
   */
  testConnection: async (config, connectionId = null) => {
    const bucketName = String(config.bucket || '').trim();
    try {
      const storage = getClient(config, connectionId);

      // An account scoped to ONE bucket cannot list the project's buckets —
      // `storage.buckets.list` lives in project roles (Storage Admin /
      // Viewer / Bucket Viewer), not in Storage Object Admin. So when a
      // bucket is named, prove access to THAT bucket instead: listing one
      // object needs only `storage.objects.list`, which every object role has.
      if (bucketName) {
        await storage.bucket(bucketName).getFiles({ maxResults: 1 });
        return { success: true, message: `Connection successful — reached bucket "${bucketName}"` };
      }

      // No bucket named, so the connection is expected to browse the project.
      await storage.getBuckets({ maxResults: 1 });

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      // The most common misconfiguration by far, and the raw message does not
      // say what to do about it.
      if (/storage\.buckets\.list/.test(error.message || '')) {
        return {
          success: false,
          message: `${error.message}\n\nListing every bucket in a project needs the `
            + `project-level "storage.buckets.list" permission — Storage Object Admin does not `
            + `include it. Either name a single Bucket on this connection (then only object `
            + `access is needed), or grant the signed-in Google account Storage Admin / Storage `
            + `Viewer / Storage Bucket Viewer on the project.`,
        };
      }
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (buckets in GCS)
   */
  getContainers: async (config, connectionId = null) => {
    const bucketName = String(config.bucket || '').trim();
    try {
      const storage = getClient(config, connectionId);

      // Scoped connection: the one bucket it was given, without asking the
      // project for a list the signed-in user may not be allowed to see.
      if (bucketName) {
        return {
          success: true,
          containers: [{ name: bucketName, description: 'Configured bucket' }],
        };
      }

      const [buckets] = await storage.getBuckets();

      return {
        success: true,
        containers: buckets.map(bucket => ({
          name: bucket.name,
          location: bucket.metadata.location,
          storageClass: bucket.metadata.storageClass,
          created: bucket.metadata.timeCreated
        }))
      };
    } catch (error) {
      if (/storage\.buckets\.list/.test(error.message || '')) {
        return {
          success: false,
          message: 'This account cannot list the project\'s buckets. Set the Bucket field '
            + 'on the connection to browse a single bucket, or grant the signed-in Google account '
            + 'Storage Admin / Storage Viewer / Storage Bucket Viewer on the project.',
        };
      }
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a container
   * @param {string} prefix - Filter objects by prefix (folder path)
   * @param {number} maxKeys - Maximum number of objects to return (default 100)
   * @param {string} pageToken - Token for pagination (from previous response)
   * @param {string} searchTerm - Search term to filter object names
   */
  listObjects: async (config, connectionId, containerName, prefix = '', maxKeys = 100, pageToken = null, searchTerm = '') => {
    try {
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);

      // Combine prefix with search term
      const effectivePrefix = searchTerm ? `${prefix}${searchTerm}` : prefix;

      const options = {
        prefix: effectivePrefix,
        maxResults: maxKeys,
        delimiter: '/',
        autoPaginate: false
      };

      if (pageToken) {
        options.pageToken = pageToken;
      }

      const [files, , response] = await bucket.getFiles(options);

      // Process folders (prefixes) - use original prefix, not effectivePrefix
      const folders = (response.prefixes || []).map(p => ({
        name: p.replace(prefix, '').replace(/\/$/, ''),
        objectKey: p, // Full key for navigation
        isFolder: true,
        size: 0,
        lastModified: null
      }));

      // Process files - use original prefix, not effectivePrefix
      const fileObjects = files
        .filter(file => file.name !== effectivePrefix)
        .map(file => ({
          name: file.name.replace(prefix, ''),
          objectKey: file.name, // Full key for downloading
          size: parseInt(file.metadata.size),
          contentType: file.metadata.contentType,
          lastModified: file.metadata.updated,
          created: file.metadata.timeCreated,
          isFolder: false
        }));

      return {
        success: true,
        objects: [...folders, ...fileObjects],
        isTruncated: !!response.nextPageToken,
        nextContinuationToken: response.nextPageToken || null,
        totalCount: folders.length + fileObjects.length
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
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata();

      return {
        success: true,
        data: buffer,
        contentType: metadata.contentType,
        size: metadata.size
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
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      await file.save(data, {
        contentType,
        resumable: false
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
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      await file.delete();

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
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      const [metadata] = await file.getMetadata();

      return {
        success: true,
        metadata: {
          size: metadata.size,
          contentType: metadata.contentType,
          lastModified: metadata.updated,
          etag: metadata.etag
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
    if (gcsClients.has(connectionId)) {
      gcsClients.delete(connectionId);
    }
    if (tokenRefreshCallbacks.has(connectionId)) {
      tokenRefreshCallbacks.delete(connectionId);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'projectId',
        type: 'string',
        label: 'Project ID',
        placeholder: 'my-gcp-project',
        required: true,
        sensitive: true,
        helpText: 'The GCP project that owns the buckets. Still needed with OAuth — a user '
          + 'token carries no project of its own, and bucket listing is a project-scoped call.'
      },
      {
        name: 'clientId',
        type: 'string',
        label: 'OAuth Client ID',
        placeholder: 'xxxxx.apps.googleusercontent.com',
        required: true,
        sensitive: true,
        helpText: 'Get this from Google Cloud Console'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'OAuth Client Secret',
        required: true,
        sensitive: true,
        helpText: 'Get this from Google Cloud Console'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: DEFAULT_REDIRECT_URI,
        default: DEFAULT_REDIRECT_URI,
        required: false,
        sensitive: false,
        helpText: 'Leave at the default. A Desktop app OAuth client accepts any loopback '
          + 'address without registering it, but Ternlux listens on port 3000 — so the port '
          + 'here must stay 3000.'
      },
      {
        name: 'bucket',
        type: 'string',
        label: 'Bucket (optional)',
        placeholder: 'my-bucket',
        required: false,
        sensitive: false,
        helpText: 'Name one bucket to work with an account that only has object access '
          + '(e.g. Storage Object Admin). Leave blank to browse every bucket in the project, '
          + 'which needs the project-level storage.buckets.list permission.'
      },
      {
        name: 'accessToken',
        type: 'hidden',
        label: 'Access Token',
        required: false,
        sensitive: true
      },
      {
        name: 'refreshToken',
        type: 'hidden',
        label: 'Refresh Token',
        required: false,
        sensitive: true
      },
      {
        name: 'expiryDate',
        type: 'hidden',
        label: 'Token Expiry Date',
        required: false,
        sensitive: false
      }
    ]
  }
};
