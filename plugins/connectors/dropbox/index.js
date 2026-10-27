/**
 * Dropbox Storage Connector Plugin for Ternlux
 * Handles all Dropbox storage operations
 */

const { Dropbox } = require('dropbox');

// Dropbox client cache
const dropboxClients = new Map();
const tokenRefreshCallbacks = new Map();

/**
 * Check if token is expired or about to expire (within 5 minutes)
 */
function isTokenExpired(expiryDate) {
  if (!expiryDate) return true;
  const now = Date.now();
  const bufferTime = 5 * 60 * 1000; // 5 minutes
  return now >= (expiryDate - bufferTime);
}

// Tokens from the last refresh, per connection, reused until they come within
// the expiry buffer. The stored connection config is not rewritten by a
// refresh, so every run reads the same expired token; without this each call
// refreshed again, even seconds apart and several times in one run.
const refreshedTokens = new Map();
const refreshesInFlight = new Map();

/** Refresh the access token, remember it for this session, and tell any listener. */
async function refreshAndCache(config, connectionId, key) {
  console.log('[Dropbox] Token expired or about to expire, refreshing...');

  const module = require('./index.js');
  const refreshResult = await module.refreshAccessToken(config);

  if (!refreshResult.success) {
    console.error('[Dropbox] Token refresh failed:', refreshResult.message);
    throw new Error('Token refresh failed: ' + refreshResult.message);
  }

  console.log('[Dropbox] Token refreshed successfully');
  refreshedTokens.set(key, refreshResult.tokens);

  // Trigger callback to update connection in database if registered
  if (tokenRefreshCallbacks.has(connectionId)) {
    const callback = tokenRefreshCallbacks.get(connectionId);
    await callback(refreshResult.tokens);
  }

  return refreshResult.tokens;
}

/**
 * Extract a useful error message from a Dropbox SDK error.
 * The SDK's DropboxResponseError exposes the raw API body on `.error`:
 *   - 4xx/5xx with JSON body → object with `error_summary` / `error['.tag']`
 *   - 400 errors → plaintext string describing the bad request (missing
 *     scope, malformed path root, invalid argument, etc.)
 * `error.message` alone is just "Response failed with a NNN code", so it's
 * useless for diagnosing the underlying cause.
 */
function formatDropboxError(error) {
  if (!error) return 'Unknown Dropbox error';
  const body = error.error;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed) return trimmed;
    } else if (typeof body === 'object') {
      if (body.error_summary) return body.error_summary;
      if (body.error && body.error['.tag']) {
        const tag = body.error['.tag'];
        const userMsg = body.user_message && body.user_message.text;
        return userMsg ? `${tag}: ${userMsg}` : tag;
      }
      try {
        return JSON.stringify(body);
      } catch (_) {
        // fall through to message
      }
    }
  }
  return error.message || 'Unknown Dropbox error';
}

/**
 * Get or create Dropbox client with automatic token refresh
 */
async function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  // A refresh earlier in this session is still valid: use it instead of the
  // stored token, which a refresh never updates (see refreshedTokens).
  const cached = refreshedTokens.get(key);
  if (cached && !isTokenExpired(cached.expiryDate)
      && (!config.expiryDate || config.expiryDate < cached.expiryDate)) {
    Object.assign(config, cached);
  }

  if (isTokenExpired(config.expiryDate)) {
    // One refresh per connection at a time: a call that arrives while one is in
    // flight waits for it rather than refreshing again.
    if (!refreshesInFlight.has(key)) {
      refreshesInFlight.set(key, refreshAndCache(config, connectionId, key)
        .finally(() => refreshesInFlight.delete(key)));
    }
    Object.assign(config, await refreshesInFlight.get(key));

    // Clear cached client to force recreation with new token
    dropboxClients.delete(key);
  }

  if (!dropboxClients.has(key)) {
    let client = new Dropbox({
      accessToken: config.accessToken
    });

    // Tokens issued for team-space accounts treat path "" as the team root,
    // not the user's home, and listing path "" without a Dropbox-API-Path-Root
    // header returns 400. Probe the account once and rebuild the client with
    // the proper path root if needed.
    try {
      const accountResp = await client.usersGetCurrentAccount();
      const rootInfo = accountResp && accountResp.result && accountResp.result.root_info;
      if (
        rootInfo &&
        rootInfo.root_namespace_id &&
        rootInfo.home_namespace_id &&
        rootInfo.root_namespace_id !== rootInfo.home_namespace_id
      ) {
        client = new Dropbox({
          accessToken: config.accessToken,
          pathRoot: JSON.stringify({ '.tag': 'root', root: rootInfo.root_namespace_id })
        });
      }
    } catch (e) {
      console.warn('[Dropbox] Could not detect path root:', formatDropboxError(e));
    }

    dropboxClients.set(key, client);
  }

  return dropboxClients.get(key);
}

/**
 * Register a callback to be called when token is refreshed
 * This allows the main app to update the connection config
 */
function registerTokenRefreshCallback(connectionId, callback) {
  tokenRefreshCallbacks.set(connectionId, callback);
}

module.exports = {
  type: 'connector',
  id: 'dropbox',
  name: 'Dropbox',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const clientId = config.clientId;
      const redirectUri = config.redirectUri || 'http://localhost:3000/oauth/callback';
      const state = config.state;

      const authUrl = `https://www.dropbox.com/oauth2/authorize?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}` +
        `&token_access_type=offline`;

      return {
        success: true,
        authUrl,
        scopes: ['files.content.read', 'files.content.write', 'files.metadata.read']
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Exchange authorization code for tokens
   */
  exchangeCodeForTokens: async (config, code) => {
    try {
      const axios = require('axios');
      const params = new URLSearchParams();
      params.append('code', code);
      params.append('grant_type', 'authorization_code');
      params.append('client_id', config.clientId);
      params.append('client_secret', config.clientSecret);
      params.append('redirect_uri', config.redirectUri || 'http://localhost:3000/oauth/callback');

      const response = await axios.post('https://api.dropboxapi.com/oauth2/token', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return {
        success: true,
        tokens: {
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token,
          expiryDate: Date.now() + (response.data.expires_in * 1000),
          tokenType: response.data.token_type,
          scope: response.data.scope
        }
      };
    } catch (error) {
      console.error('[Dropbox] Token exchange error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.response?.data?.error_description || error.message
      };
    }
  },

  /**
   * Refresh access token using refresh token
   */
  refreshAccessToken: async (config) => {
    try {
      const axios = require('axios');

      if (!config.refreshToken) {
        return {
          success: false,
          message: 'No refresh token available'
        };
      }

      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', config.refreshToken);
      params.append('client_id', config.clientId);
      params.append('client_secret', config.clientSecret);

      const response = await axios.post('https://api.dropboxapi.com/oauth2/token', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return {
        success: true,
        tokens: {
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token || config.refreshToken,
          expiryDate: Date.now() + (response.data.expires_in * 1000),
          tokenType: response.data.token_type,
          scope: response.data.scope
        }
      };
    } catch (error) {
      console.error('[Dropbox] Token refresh error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.response?.data?.error_description || error.message
      };
    }
  },

  /**
   * Test Dropbox connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const dbx = await getClient(config, connectionId);

      // Get current account to verify credentials
      await dbx.usersGetCurrentAccount();

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * List containers (Dropbox has no container concept, returns root)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      // Dropbox doesn't have buckets/containers, return a single root container
      return {
        success: true,
        containers: [
          {
            name: 'root',
            path: '',
            description: 'Dropbox root folder'
          }
        ]
      };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * List objects in a path
   */
  listObjects: async (config, connectionId, containerName, path = '', limit = 1000) => {
    try {
      const dbx = await getClient(config, connectionId);

      // Normalize path
      const folderPath = path === '' || path === '/' ? '' : path.startsWith('/') ? path : `/${path}`;

      const response = await dbx.filesListFolder({
        path: folderPath,
        limit: Math.min(limit, 2000)
      });

      return {
        success: true,
        objects: response.result.entries.map(entry => ({
          name: entry.name,
          path: entry.path_display,
          objectKey: entry.path_display, // Use path for downloading
          size: entry.size || 0,
          isFolder: entry['.tag'] === 'folder',
          lastModified: entry.client_modified || entry.server_modified,
          id: entry.id
        })),
        hasMore: response.result.has_more,
        cursor: response.result.cursor
      };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, containerName, objectPath) => {
    try {
      const dbx = await getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      const response = await dbx.filesDownload({ path: filePath });

      return {
        success: true,
        data: response.result.fileBinary,
        size: response.result.size,
        lastModified: response.result.client_modified
      };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, objectPath, data, contentType) => {
    try {
      const dbx = await getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      await dbx.filesUpload({
        path: filePath,
        contents: data,
        mode: { '.tag': 'overwrite' }
      });

      return {
        success: true,
        message: `Successfully uploaded ${objectPath}`
      };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, containerName, objectPath) => {
    try {
      const dbx = await getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      await dbx.filesDeleteV2({ path: filePath });

      return {
        success: true,
        message: `Successfully deleted ${objectPath}`
      };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, containerName, objectPath) => {
    try {
      const dbx = await getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      const response = await dbx.filesGetMetadata({ path: filePath });

      return {
        success: true,
        metadata: {
          name: response.result.name,
          path: response.result.path_display,
          size: response.result.size || 0,
          isFolder: response.result['.tag'] === 'folder',
          lastModified: response.result.client_modified || response.result.server_modified,
          id: response.result.id
        }
      };
    } catch (error) {
      return { success: false, message: formatDropboxError(error) };
    }
  },

  /**
   * Close connection (cleanup client)
   */
  closeConnection: async (connectionId) => {
    if (dropboxClients.has(connectionId)) {
      dropboxClients.delete(connectionId);
    }
    if (tokenRefreshCallbacks.has(connectionId)) {
      tokenRefreshCallbacks.delete(connectionId);
    }
  },

  /**
   * Register token refresh callback
   */
  registerTokenRefreshCallback: (connectionId, callback) => {
    return registerTokenRefreshCallback(connectionId, callback);
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'clientId',
        type: 'string',
        label: 'App Key (Client ID)',
        placeholder: 'xxxxxxxxxxxxxxx',
        required: true,
        sensitive: true,
        helpText: 'Get this from Dropbox App Console'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'App Secret (Client Secret)',
        required: true,
        sensitive: true,
        helpText: 'Get this from Dropbox App Console'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Dropbox App settings'
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
