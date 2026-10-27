/**
 * Google Drive Storage Connector Plugin for Ternlux
 * Handles all Google Drive storage operations
 */

const { OAuth2Client } = require('google-auth-library');
const { drive: driveApi } = require('@googleapis/drive');
const { Readable } = require('stream');

// Google Drive client cache
const driveClients = new Map();
const tokenRefreshCallbacks = new Map();

/**
 * Get or create Google Drive client with OAuth2 credentials
 */
function getOAuthClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!driveClients.has(key)) {
    const oauth2Client = new OAuth2Client(
      config.clientId,
      config.clientSecret,
      config.redirectUri || 'http://localhost:3000/oauth/callback'
    );

    // Set credentials if tokens exist
    if (config.accessToken) {
      oauth2Client.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
        scope: config.scope,
        token_type: 'Bearer',
        expiry_date: config.expiryDate
      });
    }

    const drive = driveApi({ version: 'v3', auth: oauth2Client });
    driveClients.set(key, drive);
  }

  return driveClients.get(key);
}

/**
 * Legacy get client for backwards compatibility
 */
function getClient(config, connectionId) {
  // If OAuth credentials exist, use OAuth client
  if (config.clientId || config.accessToken) {
    return getOAuthClient(config, connectionId);
  }

  // Fallback to legacy credentials
  const key = connectionId || JSON.stringify(config);

  if (!driveClients.has(key)) {
    const auth = new OAuth2Client();

    if (config.credentials) {
      const creds = typeof config.credentials === 'string'
        ? JSON.parse(config.credentials)
        : config.credentials;
      auth.setCredentials(creds);
    }

    const drive = driveApi({ version: 'v3', auth });
    driveClients.set(key, drive);
  }

  return driveClients.get(key);
}

/**
 * Refresh access token if expired
 */
async function refreshAccessTokenIfNeeded(oauth2Client, connectionId) {
  try {
    const tokens = oauth2Client.credentials;

    // Check if token is expired or about to expire (within 5 minutes)
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 5 * 60 * 1000) {
      console.log('[Google Drive] Refreshing access token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Trigger callback to update connection in database if registered
      if (connectionId && tokenRefreshCallbacks.has(connectionId)) {
        const callback = tokenRefreshCallbacks.get(connectionId);
        await callback({
          accessToken: credentials.access_token,
          refreshToken: credentials.refresh_token,
          expiryDate: credentials.expiry_date,
          tokenType: credentials.token_type,
          scope: credentials.scope
        });
      }

      return credentials;
    }

    return tokens;
  } catch (error) {
    console.error('[Google Drive] Token refresh error:', error.response?.data?.error_description || error.message);
    throw error;
  }
}

/**
 * Register a callback to be called when token is refreshed
 * This allows the main app to update the connection config
 */
function registerTokenRefreshCallback(connectionId, callback) {
  tokenRefreshCallbacks.set(connectionId, callback);
}

/** A Drive id: opaque, no spaces or slashes, and long. "My Drive" is not one. */
const looksLikeDriveId = (v) => /^[A-Za-z0-9_-]{11,}$/.test(String(v || ''));

/**
 * The folder id to write into, from whatever the caller recorded.
 *
 * `container` is 'root', a shared drive id, a folder id, or a DISPLAY NAME —
 * the picker used to store "My Drive", which is what Drive rejected with
 * `File not found: My Drive`. `segments` are folder names between the
 * container and the file, which only a path-shaped object name carries.
 *
 * A folder in `segments` that does not exist yet is created, the way S3, GCS,
 * Dropbox and OneDrive all accept `e2e/stores.csv` into an empty bucket — the
 * picker lets the user type that path, so it has to be writable. It is never a
 * silent write to the parent instead. An unresolvable CONTAINER is still an
 * error: that is a destination the user picked, not one they asked us to make.
 */
async function resolveFolderId(drive, container, segments = []) {
  let parent = 'root';
  const ref = String(container || '').trim();

  if (ref && ref !== 'root' && ref.toLowerCase() !== 'my drive') {
    if (looksLikeDriveId(ref)) {
      parent = ref;
    } else {
      // A shared drive named by the picker rather than identified.
      const drives = await drive.drives.list({ pageSize: 100 }).catch(() => null);
      const match = (drives?.data?.drives || []).find((d) => d.name === ref);
      if (!match) {
        throw new Error(
          `Google Drive folder "${ref}" could not be resolved. Re-select the destination in the output node.`,
        );
      }
      parent = match.id;
    }
  }

  for (const folder of segments) {
    const found = (await listChildren(drive, parent, folder, { folders: true }))[0];
    if (found) {
      parent = found.id;
      continue;
    }
    const created = await drive.files.create({
      requestBody: { name: folder, mimeType: FOLDER_MIME, parents: [parent] },
      fields: 'id',
    });
    parent = created.data.id;
  }

  return parent;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Non-trashed children of `parent` called `name`, oldest first — folders only,
 * or files only. Drive allows any number of same-named siblings, so this is a
 * list rather than a lookup.
 */
async function listChildren(drive, parent, name, { folders }) {
  const escaped = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and '${parent}' in parents `
      + `and mimeType ${folders ? '=' : '!='} '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'createdTime',
    pageSize: 100,
  });
  return res.data.files || [];
}

module.exports = {
  type: 'connector',
  id: 'google-drive',
  name: 'Google Drive',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );

      const scopes = [
        'https://www.googleapis.com/auth/drive.file', // Non-sensitive: files this app creates or the user picks
        // Both of the below are RESTRICTED scopes in Google's classification
        // (publishing an app that requests either requires an annual
        // third-party security assessment). They are what lets the in-app
        // browser list a whole Drive; the Sheets connector avoids them by
        // going through Google's Picker instead — see GoogleSheetsPicker.
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.metadata.readonly'
      ];

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent',
        state: config.state
      });

      return {
        success: true,
        authUrl,
        scopes
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
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );
      // console.log('oauth2Client: ', oauth2Client)
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
      console.error('[Google Drive] Token exchange error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Refresh access token using refresh token
   */
  refreshAccessToken: async (config) => {
    try {
      if (!config.refreshToken) {
        return {
          success: false,
          message: 'No refresh token available'
        };
      }

      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );

      oauth2Client.setCredentials({
        refresh_token: config.refreshToken
      });

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
      console.error('[Google Drive] Token refresh error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Test Google Drive connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const drive = getClient(config, connectionId);

      // Get about info to verify credentials
      await drive.about.get({ fields: 'user' });

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (returns root and shared drives)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const drive = getClient(config, connectionId);
      const containers = [
        {
          name: 'My Drive',
          id: 'root',
          description: 'Personal Google Drive'
        }
      ];

      // Try to get shared drives
      try {
        const sharedDrives = await drive.drives.list({
          pageSize: 100
        });

        if (sharedDrives.data.drives) {
          sharedDrives.data.drives.forEach(d => {
            containers.push({
              name: d.name,
              id: d.id,
              description: 'Shared Drive'
            });
          });
        }
      } catch (e) {
        // Shared drives may not be available
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
   * List objects in a folder
   */
  listObjects: async (config, connectionId, containerName, folderId = 'root', pageSize = 1000) => {
    try {
      const drive = getClient(config, connectionId);

      const query = folderId === 'root' || !folderId
        ? `'root' in parents and trashed = false`
        : `'${folderId}' in parents and trashed = false`;

      const response = await drive.files.list({
        q: query,
        pageSize: Math.min(pageSize, 1000),
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners)',
        orderBy: 'name'
      });

      return {
        success: true,
        objects: response.data.files.map(file => ({
          name: file.name,
          id: file.id,
          objectKey: file.id, // Use ID for downloading
          mimeType: file.mimeType,
          size: file.size ? parseInt(file.size) : 0,
          isFolder: file.mimeType === 'application/vnd.google-apps.folder',
          lastModified: file.modifiedTime,
          created: file.createdTime
        })),
        nextPageToken: response.data.nextPageToken
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, containerName, fileId) => {
    try {
      const drive = getClient(config, connectionId);
      // Get file metadata first
      const metadata = await drive.files.get({
        fileId,
        fields: 'name, mimeType, size'
      });
      // console.log('fileId: ', metadata, fileId)

      // Download file
      const response = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );

      return {
        success: true,
        data: Buffer.from(response.data),
        name: metadata.data.name,
        mimeType: metadata.data.mimeType,
        size: metadata.data.size
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Export Google Workspace file (Sheets, Docs, etc.)
   */
  exportObject: async (config, connectionId, fileId, mimeType) => {
    try {
      const drive = getClient(config, connectionId);

      // Get file metadata first
      const metadata = await drive.files.get({
        fileId,
        fields: 'name, mimeType'
      });

      // Export the file
      const response = await drive.files.export(
        { fileId, mimeType },
        { responseType: 'arraybuffer' }
      );

      return {
        success: true,
        data: Buffer.from(response.data),
        name: metadata.data.name,
        mimeType: mimeType,
        originalMimeType: metadata.data.mimeType
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, fileName, data, contentType) => {
    try {
      const drive = getClient(config, connectionId);

      // Drive has no path syntax: a file is placed by naming its PARENT'S ID.
      // What arrives here is whatever the picker recorded — 'root', a shared
      // drive id, a folder id, or (before this was understood) the display name
      // "My Drive", which the API reported as `File not found: My Drive`. And
      // `fileName` may still carry folders ("Reports/data.csv"), which Drive
      // would take literally as a file called "Reports/data.csv".
      //
      // Both are resolved to real ids here, so a config written either way
      // lands where the user meant.
      const segments = String(fileName || '').split('/').filter(Boolean);
      const name = segments.pop();
      if (!name) return { success: false, message: 'No file name to upload to' };

      const folderId = await resolveFolderId(drive, containerName, segments);

      // Convert Buffer to readable stream if needed
      const bodyStream = Buffer.isBuffer(data) ? Readable.from(data) : data;

      const media = {
        mimeType: contentType || 'application/octet-stream',
        body: bodyStream
      };

      // Drive happily keeps two files with one name in one folder, so a plain
      // create on every run piled up copies. An output replaces its object
      // everywhere else; here that means writing a new revision of the file
      // already at this path, which keeps its id, sharing and link.
      const existing = (await listChildren(drive, folderId, name, { folders: false }))[0];
      const response = existing
        ? await drive.files.update({ fileId: existing.id, media, fields: 'id, name' })
        : await drive.files.create({
          requestBody: { name, parents: [folderId] },
          media,
          fields: 'id, name'
        });

      return {
        success: true,
        message: `Successfully uploaded ${name}`,
        fileId: response.data.id
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, containerName, fileId) => {
    try {
      const drive = getClient(config, connectionId);

      await drive.files.delete({ fileId });

      return {
        success: true,
        message: `Successfully deleted file ${fileId}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, containerName, fileId) => {
    try {
      const drive = getClient(config, connectionId);

      const response = await drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size, modifiedTime, createdTime, owners, parents'
      });

      return {
        success: true,
        metadata: {
          id: response.data.id,
          name: response.data.name,
          mimeType: response.data.mimeType,
          size: response.data.size ? parseInt(response.data.size) : 0,
          isFolder: response.data.mimeType === 'application/vnd.google-apps.folder',
          lastModified: response.data.modifiedTime,
          created: response.data.createdTime,
          parents: response.data.parents
        }
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get credentials for Google Picker
   * Returns access token and optional API key for frontend Picker integration
   */
  getPickerCredentials: async (config, connectionId) => {
    try {
      // Create OAuth2 client directly (don't use getOAuthClient which returns Drive client)
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );

      // Set credentials if tokens exist
      if (config.accessToken) {
        oauth2Client.setCredentials({
          access_token: config.accessToken,
          refresh_token: config.refreshToken,
          scope: config.scope,
          token_type: 'Bearer',
          expiry_date: config.expiryDate
        });
      }

      // Refresh token if needed
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const credentials = oauth2Client.credentials;

      return {
        success: true,
        accessToken: credentials.access_token,
        apiKey: config.apiKey || null, // API key is optional when using OAuth
        clientId: config.clientId
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Close connection (cleanup client)
   */
  closeConnection: async (connectionId) => {
    if (driveClients.has(connectionId)) {
      driveClients.delete(connectionId);
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
      // {
      //   name: 'apiKey',
      //   type: 'string',
      //   label: 'Google API Key',
      //   placeholder: 'AIza...',
      //   required: true,
      //   sensitive: true,
      //   helpText: 'Required for Google Picker file selection. Get from Google Cloud Console: Go to APIs & Services > Credentials > Create Credentials > API Key. Enable Google Picker API for your project.'
      // },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Google Cloud Console'
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
