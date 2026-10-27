/**
 * OneDrive Storage Connector Plugin for Ternlux
 * Handles all OneDrive storage operations via Microsoft Graph API
 */

const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

// OneDrive client cache
const onedriveClients = new Map();
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
  console.log('[OneDrive] Token expired or about to expire, refreshing...');

  const module = require('./index.js');
  const refreshResult = await module.refreshAccessToken(config);

  if (!refreshResult.success) {
    console.error('[OneDrive] Token refresh failed:', refreshResult.message);
    throw new Error('Token refresh failed: ' + refreshResult.message);
  }

  console.log('[OneDrive] Token refreshed successfully');
  refreshedTokens.set(key, refreshResult.tokens);

  // Trigger callback to update connection in database if registered
  if (tokenRefreshCallbacks.has(connectionId)) {
    const callback = tokenRefreshCallbacks.get(connectionId);
    await callback(refreshResult.tokens);
  }

  return refreshResult.tokens;
}

/**
 * Get or create OneDrive client with automatic token refresh
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
    onedriveClients.delete(key);
  }

  if (!onedriveClients.has(key)) {
    const client = Client.init({
      authProvider: (done) => {
        done(null, config.accessToken);
      }
    });

    onedriveClients.set(key, client);
  }

  return onedriveClients.get(key);
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
  id: 'onedrive',
  name: 'OneDrive',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const tenantId = config.tenantId || 'common';
      const clientId = config.clientId;
      const redirectUri = config.redirectUri || 'http://localhost:3000/oauth/callback';
      const state = config.state;

      // User.Read is needed by testConnection's /me call. Sites.* is deliberately
      // left out: it is not valid for personal accounts and tenantId defaults to
      // 'common', so requesting it would break consent for consumer sign-ins.
      const requestedScopes = ['User.Read', 'Files.ReadWrite.All', 'offline_access'];
      const scopes = encodeURIComponent(requestedScopes.join(' '));
      const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_mode=query` +
        `&scope=${scopes}` +
        `&state=${encodeURIComponent(state)}`;

      return {
        success: true,
        authUrl,
        scopes: requestedScopes
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
      const tenantId = config.tenantId || 'common';
      const params = new URLSearchParams();
      params.append('client_id', config.clientId);
      params.append('client_secret', config.clientSecret);
      params.append('code', code);
      params.append('redirect_uri', config.redirectUri || 'http://localhost:3000/oauth/callback');
      params.append('grant_type', 'authorization_code');

      const response = await axios.post(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        params,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

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
      console.error('[OneDrive] Token exchange error:', error.response?.data?.error_description || error.message);
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
      const tenantId = config.tenantId || 'common';

      if (!config.refreshToken) {
        return {
          success: false,
          message: 'No refresh token available'
        };
      }

      const params = new URLSearchParams();
      params.append('client_id', config.clientId);
      params.append('client_secret', config.clientSecret);
      params.append('refresh_token', config.refreshToken);
      params.append('grant_type', 'refresh_token');

      const response = await axios.post(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        params,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

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
      console.error('[OneDrive] Token refresh error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.response?.data?.error_description || error.message
      };
    }
  },

  /**
   * Test OneDrive connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const client = await getClient(config, connectionId);

      // Get user info to verify credentials
      await client.api('/me').get();

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (OneDrive has root drive)
   */
  getContainers: async (config, connectionId = null) => {
    const toContainer = (drive) => ({
      name: drive.name || 'OneDrive',
      id: drive.id,
      driveType: drive.driveType,
      owner: drive.owner?.user?.displayName
    });

    try {
      const client = await getClient(config, connectionId);

      // Try to enumerate every drive the user can reach. This can fail with 403
      // accessDenied on personal accounts and on tenants that block drive
      // enumeration, even when the token carries Files.ReadWrite.All.
      try {
        const response = await client.api('/me/drives').get();
        return {
          success: true,
          containers: response.value.map(toContainer)
        };
      } catch (listError) {
        console.warn(
          '[OneDrive] /me/drives failed (%s %s), falling back to default drive. Token scopes: %s',
          listError.statusCode,
          listError.code,
          config.scope || 'unknown'
        );
      }

      // Fall back to the user's own drive, which every account with OneDrive has.
      const drive = await client.api('/me/drive').get();
      return {
        success: true,
        containers: [toContainer(drive)]
      };
    } catch (error) {
      console.error('[OneDrive] Get containers error:', error.message);
      const message = error.statusCode === 403
        ? `Access denied listing OneDrive drives. The account may not have a provisioned OneDrive, or the token is missing Files.ReadWrite.All (granted scopes: ${config.scope || 'unknown'}). Reconnect the account to re-consent.`
        : error.message;
      return { success: false, message };
    }
  },

  /**
   * List objects in a folder
   */
  listObjects: async (config, connectionId, containerName, folderId = 'root', top = 1000) => {
    try {
      const client = await getClient(config, connectionId);
  
      // 1. Determine the Base Path (Specific Drive vs. Default Drive)
      // containerName here is the drive.id from your getContainers output
      const basePath = containerName 
        ? `/drives/${containerName}` 
        : '/me/drive';
  
      // 2. Determine the Item Path
      // If folderId is 'root', null, or empty, use the /root shorthand
      const isRoot = !folderId || folderId === 'root';
      const itemPath = isRoot 
        ? '/root' 
        : `/items/${folderId}`;
  
      // 3. Combine them
      const path = `${basePath}${itemPath}/children`;
      
      console.log('[OneDrive] List objects path:', path);
  
      const response = await client
        .api(path)
        .top(Math.min(top, 1000))
        .get();
      
      
      return {
        success: true,
        objects: response.value.map(item => ({
          name: item.name,
          id: item.id,
          objectKey: item.id, 
          size: item.size || 0,
          isFolder: !!item.folder,
          lastModified: item.lastModifiedDateTime,
          created: item.createdDateTime,
          webUrl: item.webUrl
        })),
        nextLink: response['@odata.nextLink']
      };
    } catch (error) {
      console.error('[OneDrive] List objects error:', error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, driveId, itemId) => {
    try {
      const client = await getClient(config, connectionId);

      // Build API paths using drive ID
      let itemPath, contentPath;
      if (!driveId || driveId === 'root') {
        // Use default drive
        itemPath = `/me/drive/items/${itemId}`;
        contentPath = `/me/drive/items/${itemId}/content`;
      } else {
        // Use specific drive ID
        itemPath = `/drives/${driveId}/items/${itemId}`;
        contentPath = `/drives/${driveId}/items/${itemId}/content`;
      }

      console.log('[OneDrive] Download item path:', itemPath);

      // Get item metadata
      const item = await client.api(itemPath).get();

      if (item.folder) {
        return { success: false, message: 'Cannot download a folder' };
      }

      // Download content
      const response = await client
        .api(contentPath)
        .getStream();

      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      console.log('[OneDrive] Download complete:', item.name, buffer.length, 'bytes');

      return {
        success: true,
        data: buffer,
        name: item.name,
        size: item.size,
        mimeType: item.file?.mimeType
      };
    } catch (error) {
      console.error('[OneDrive] Download error:', error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, objectName, data, contentType) => {
    try {
      const client = await getClient(config, connectionId);

      // containerName is the drive ID from getContainers (e.g., '1d5b40836ef4a3ea')
      // objectName is the full path (e.g., 'folder/file.json' or 'file.json')

      let path;

      if (!containerName || containerName === 'root') {
        // Use default drive
        path = `/me/drive/root:/${objectName}:/content`;
      } else {
        // Use specific drive ID
        path = `/drives/${containerName}/root:/${objectName}:/content`;
      }

      console.log('[OneDrive] Upload path:', path);

      const response = await client
        .api(path)
        .putStream(data);

      console.log('[OneDrive] Upload response:', response.id);

      return {
        success: true,
        message: `Successfully uploaded ${objectName}`,
        itemId: response.id
      };
    } catch (error) {
      console.error('[OneDrive] Upload error:', error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, driveId, itemId) => {
    try {
      const client = await getClient(config, connectionId);

      // Build API path using drive ID
      let path;
      if (!driveId || driveId === 'root') {
        // Use default drive
        path = `/me/drive/items/${itemId}`;
      } else {
        // Use specific drive ID
        path = `/drives/${driveId}/items/${itemId}`;
      }

      console.log('[OneDrive] Delete item path:', path);

      await client.api(path).delete();

      return {
        success: true,
        message: `Successfully deleted item ${itemId}`
      };
    } catch (error) {
      console.error('[OneDrive] Delete error:', error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, driveId, itemId) => {
    try {
      const client = await getClient(config, connectionId);

      // Build API path using drive ID
      let path;
      if (!driveId || driveId === 'root') {
        // Use default drive
        path = `/me/drive/items/${itemId}`;
      } else {
        // Use specific drive ID
        path = `/drives/${driveId}/items/${itemId}`;
      }

      console.log('[OneDrive] Get metadata path:', path);

      const item = await client.api(path).get();

      return {
        success: true,
        metadata: {
          id: item.id,
          name: item.name,
          size: item.size || 0,
          isFolder: !!item.folder,
          lastModified: item.lastModifiedDateTime,
          created: item.createdDateTime,
          webUrl: item.webUrl,
          mimeType: item.file?.mimeType
        }
      };
    } catch (error) {
      console.error('[OneDrive] Get metadata error:', error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Close connection (cleanup client)
   */
  closeConnection: async (connectionId) => {
    if (onedriveClients.has(connectionId)) {
      onedriveClients.delete(connectionId);
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
        label: 'Application (client) ID',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        required: true,
        sensitive: true,
        helpText: 'Get this from Azure Portal App Registration'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'Client Secret',
        required: true,
        sensitive: true,
        helpText: 'Get this from Azure Portal App Registration > Certificates & secrets'
      },
      {
        name: 'tenantId',
        type: 'string',
        label: 'Tenant ID',
        placeholder: 'common',
        default: 'common',
        required: false,
        sensitive: false,
        helpText: 'Azure AD tenant ID (use "common" for multi-tenant apps)'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Azure App Registration'
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
