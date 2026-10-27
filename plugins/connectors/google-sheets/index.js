/**
 * Google Sheets Connector Plugin for Ternlux
 * OAuth2.0-based authentication for accessing Google Sheets
 */

const { OAuth2Client } = require('google-auth-library');
const { sheets: sheetsApi } = require('@googleapis/sheets');
const { drive: driveApi } = require('@googleapis/drive');
const axios = require('axios');
const { Parser } = require('@json2csv/plainjs');
const Papa = require('papaparse');

// OAuth client cache
const oauthClients = new Map();
const tokenRefreshCallbacks = new Map();

/**
 * Get or create OAuth2 client
 */
function getOAuthClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!oauthClients.has(key)) {
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

    oauthClients.set(key, oauth2Client);
  }

  return oauthClients.get(key);
}

/**
 * Refresh access token if expired
 */
async function refreshAccessTokenIfNeeded(oauth2Client, connectionId) {
  try {
    const tokens = oauth2Client.credentials;

    // Check if token is expired or about to expire (within 5 minutes)
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 5 * 60 * 1000) {
      console.log('[Google Sheets] Refreshing access token...');
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
    console.error('[Google Sheets] Token refresh error:', error.response?.data?.error_description || error.message);
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

/** A Google file id: opaque, no spaces, and long. A spreadsheet TITLE is not one. */
const looksLikeFileId = (v) => /^[A-Za-z0-9_-]{20,}$/.test(String(v || '').trim());

/**
 * The spreadsheet a container reference names.
 *
 * The picker records a file id, but a hand-written config (or an older one)
 * may carry the spreadsheet's title instead. A title is looked up, and — for a
 * write — created when nothing matches, which is what makes "output to an
 * existing sheet, or a new one if it isn't there" work from one field.
 */
async function resolveSpreadsheetId(drive, sheets, ref, { createIfMissing = false } = {}) {
  const name = String(ref || '').trim();
  if (!name) throw new Error('No spreadsheet was selected');
  if (looksLikeFileId(name)) return name;

  const escaped = name.replace(/'/g, "\\'");
  const found = await drive.files.list({
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  const hit = found.data.files?.[0];
  if (hit) return hit.id;

  if (!createIfMissing) {
    throw new Error(`Google Sheets spreadsheet "${name}" not found`);
  }
  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title: name } },
    fields: 'spreadsheetId',
  });
  return created.data.spreadsheetId;
}

/** A tab name as the user meant it — the picker appends a file extension. */
const tabNameOf = (objectName) => String(objectName || '')
  .split('/').pop()
  .replace(/\.(csv|json|xlsx?|tsv)$/i, '')
  .trim();

/**
 * Rows out of whatever the output node serialised.
 *
 * insertToConnection sends this connector JSON, but a config whose tab name
 * ends in .csv would have produced CSV, so both are accepted rather than
 * throwing on a leading `"S"`.
 */
function rowsFromPayload(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf-8') : (typeof data === 'string' ? data : null);
  if (text === null) return Array.isArray(data) ? data : [data];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    return parsed.data || [];
  }
}

module.exports = {
  type: 'connector',
  id: 'google-sheets',
  name: 'Google Sheets',
  icon: './icon.svg',
  // A spreadsheet is browsed and written like cloud storage — pick the file,
  // then the tab inside it — not queried like an API. `storageType` is what
  // routes it to the cloud picker and the cloud output path.
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

      // Deliberately NO Drive listing scope. `drive.metadata.readonly` and
      // `drive.readonly` are both RESTRICTED by Google — publishing an app
      // that asks for either means annual third-party security assessment —
      // and neither is needed: the user picks a spreadsheet in Google's own
      // Picker, which grants this app access to that one file under
      // `drive.file`. Everything after the pick (tabs, values, writes) runs on
      // the `spreadsheets` scope, which is merely sensitive.
      const scopes = [
        'https://www.googleapis.com/auth/spreadsheets', // Read/write cell values (sensitive)
        'https://www.googleapis.com/auth/drive.file'    // Files this app creates or the user picks (non-sensitive)
      ];

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent', // Force consent screen to get refresh token
        state: config.state // CSRF protection token
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
      console.error('[Google Sheets] Token exchange error:', error.response?.data?.error_description || error.message);
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
      console.error('[Google Sheets] Token refresh error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Test connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token. Please complete OAuth authentication.'
        };
      }

      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      // Test by listing files
      const drive = driveApi({ version: 'v3', auth: oauth2Client });
      await drive.files.list({ pageSize: 1 });

      return {
        success: true,
        message: 'Connection successful'
      };
    } catch (error) {
      console.error('[Google Sheets] Test connection error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get list of spreadsheets (tables)
   */
  getTables: async (config, connectionId = null) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      const newTokens = await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      // Search for Google Sheets files
      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet'",
        fields: 'files(id, name, createdTime, modifiedTime)',
        pageSize: 100,
        orderBy: 'modifiedTime desc'
      });

      const spreadsheets = response.data.files || [];

      return {
        success: true,
        tables: spreadsheets.map(sheet => ({
          schema: 'google_sheets',
          name: sheet.id, // Use ID as the identifier for querying
          displayName: sheet.name, // Human-readable name for display
          type: 'spreadsheet',
          created: sheet.createdTime,
          modified: sheet.modifiedTime
        })),
        newTokens: newTokens.expiry_date !== oauth2Client.credentials.expiry_date ? {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
          expiryDate: newTokens.expiry_date
        } : null
      };
    } catch (error) {
      console.error('[Google Sheets] Get tables error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get sheet tabs and columns
   */
  getColumns: async (config, connectionId, schema, spreadsheetId) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // Get spreadsheet metadata to list all sheets
      const metadata = await sheets.spreadsheets.get({
        spreadsheetId
      });

      const sheetsList = metadata.data.sheets || [];

      // Get columns from the first sheet
      if (sheetsList.length > 0) {
        const firstSheetName = sheetsList[0].properties.title;

        // Get header row
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${firstSheetName}!1:1`
        });

        const headers = response.data.values ? response.data.values[0] : [];

        return {
          success: true,
          columns: headers.map((header, index) => ({
            name: header || `Column_${index + 1}`,
            type: 'TEXT', // Google Sheets doesn't have strict types
            nullable: true,
            isPrimary: false
          })),
          sheets: sheetsList.map(s => ({
            name: s.properties.title,
            index: s.properties.index,
            rowCount: s.properties.gridProperties.rowCount,
            columnCount: s.properties.gridProperties.columnCount
          }))
        };
      }

      return {
        success: true,
        columns: [],
        sheets: []
      };
    } catch (error) {
      console.error('[Google Sheets] Get columns error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get table schema (columns with inferred types and sample data)
   */
  getTableSchema: async (config, connectionId, spreadsheetId, sheetName = null, limit = 5) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // If no sheetName provided, get the first sheet
      let targetSheetName = sheetName;
      if (!targetSheetName) {
        const metadata = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetsList = metadata.data.sheets || [];
        targetSheetName = sheetsList.length > 0 ? sheetsList[0].properties.title : 'Sheet1';
      }

      // Fetch sample data (limit + header row)
      const range = `${targetSheetName}!A1:ZZ${limit + 1}`;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      const values = response.data.values || [];

      if (values.length === 0) {
        return {
          success: true,
          tableName: spreadsheetId,
          columns: [],
          sampleData: []
        };
      }

      // First row as headers
      const headers = values[0];
      const dataRows = values.slice(1);

      // Infer column types from sample data
      const inferType = (value) => {
        if (value === null || value === undefined || value === '') return 'TEXT';

        // Check if it's a number
        const num = Number(value);
        if (!isNaN(num) && value.toString().trim() !== '') {
          return Number.isInteger(num) ? 'INTEGER' : 'REAL';
        }

        // Check if it's a boolean
        const lowerVal = String(value).toLowerCase();
        if (lowerVal === 'true' || lowerVal === 'false') return 'BOOLEAN';

        // Check if it's a date (basic check)
        const dateVal = new Date(value);
        if (!isNaN(dateVal.getTime()) && value.toString().match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/)) {
          return 'DATE';
        }

        return 'TEXT';
      };

      // Build columns with inferred types
      const columns = headers.map((header, colIndex) => {
        const columnName = header || `Column_${colIndex + 1}`;

        // Sample values from this column (excluding empty values)
        const columnValues = dataRows
          .map(row => row[colIndex])
          .filter(val => val !== null && val !== undefined && val !== '');

        // Infer type from multiple samples
        const types = columnValues.slice(0, 10).map(inferType);

        // Pick most common type, default to TEXT
        const typeCounts = {};
        types.forEach(t => typeCounts[t] = (typeCounts[t] || 0) + 1);
        const inferredType = Object.keys(typeCounts).reduce((a, b) =>
          typeCounts[a] > typeCounts[b] ? a : b, 'TEXT'
        );

        return {
          name: columnName,
          type: inferredType,
          nullable: true,
          isPrimary: false
        };
      });

      // Convert data rows to objects and trim long text
      const sampleData = dataRows.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          const columnName = header || `Column_${index + 1}`;
          let value = row[index] || null;

          // Trim long text fields
          if (typeof value === 'string' && value.length > 100) {
            value = value.substring(0, 100) + '...';
          }

          obj[columnName] = value;
        });
        return obj;
      });

      return {
        success: true,
        tableName: spreadsheetId,
        columns,
        sampleData
      };
    } catch (error) {
      console.error('[Google Sheets] Get table schema error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Run query (fetch data from specific sheet and range)
   */
  runQuery: async (config, connectionId, query) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // Parse query - can be JSON string or object
      // Query object may contain fields for different database types
      // Pick only the fields relevant to Google Sheets: spreadsheetId, sheetName, range
      const queryObj = typeof query === 'string' ? JSON.parse(query) : query;
      const { spreadsheetId, range, sheetName } = queryObj;

      if (!spreadsheetId) {
        return {
          success: false,
          message: 'spreadsheetId is required for Google Sheets queries'
        };
      }

      // Default range if not specified
      const actualRange = range || `${sheetName || 'Sheet1'}!A1:ZZ`;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: actualRange
      });

      const values = response.data.values || [];

      if (values.length === 0) {
        return {
          success: true,
          rows: [],
          columns: [],
          rowCount: 0
        };
      }

      // First row as headers
      const headers = values[0];
      const dataRows = values.slice(1);

      // Convert to objects
      const rows = dataRows.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          obj[header || `Column_${index + 1}`] = row[index] || null;
        });
        return obj;
      });

      return {
        success: true,
        rows,
        columns: headers,
        rowCount: rows.length
      };
    } catch (error) {
      console.error('[Google Sheets] Run query error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Stream query results in batches
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      const queryObj = typeof query === 'string' ? JSON.parse(query) : query;
      const { spreadsheetId, range, sheetName } = queryObj;

      const actualRange = range || `${sheetName || 'Sheet1'}!A1:ZZ`;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: actualRange
      });

      const values = response.data.values || [];

      if (values.length === 0) {
        return { success: true, totalRows: 0 };
      }

      const headers = values[0];
      const dataRows = values.slice(1);

      // Process in batches
      for (let i = 0; i < dataRows.length; i += batchSize) {
        const batch = dataRows.slice(i, i + batchSize);
        const rows = batch.map(row => {
          const obj = {};
          headers.forEach((header, index) => {
            obj[header || `Column_${index + 1}`] = row[index] || null;
          });
          return obj;
        });

        await onBatch(rows, headers);
      }

      return {
        success: true,
        totalRows: dataRows.length
      };
    } catch (error) {
      console.error('[Google Sheets] Stream query error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Close connection
   */
  closeConnection: async (connectionId) => {
    if (oauthClients.has(connectionId)) {
      oauthClients.delete(connectionId);
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
   * Upload object (create new spreadsheet and write data)
   * This makes Google Sheets compatible with cloud storage output interface
   */
  /**
   * Containers = the spreadsheets this app can already see.
   *
   * Under `drive.file` that is only what the app created or the user has
   * picked before — deliberately, since listing everything in a person's Drive
   * needs a RESTRICTED scope. Discovery happens in Google's Picker instead
   * (GoogleSheetsPicker), which hands back a spreadsheet id this connector can
   * then work with; this method stays because the cloud-storage contract
   * requires it, and because a previously-picked sheet is worth offering.
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);
      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed = false",
        fields: 'files(id, name, modifiedTime)',
        pageSize: 200,
        orderBy: 'modifiedTime desc',
      });

      return {
        success: true,
        containers: (response.data.files || []).map((f) => ({
          name: f.name,
          id: f.id,
          description: 'Spreadsheet',
          lastModified: f.modifiedTime,
        })),
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Credentials for Google's own file Picker.
   *
   * The Picker is what makes `drive.file` enough: a file the user selects there
   * becomes accessible to this app without any account-wide Drive scope.
   */
  getPickerCredentials: async (config, connectionId) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);
      return {
        success: true,
        accessToken: oauth2Client.credentials?.access_token,
        apiKey: config.apiKey || null, // optional when using OAuth
        clientId: config.clientId,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Objects = the tabs of one spreadsheet.
   *
   * Named with a .csv suffix because that is what they become on the way out:
   * downloadObject serialises the tab as CSV, the file is saved locally, and
   * DuckDB reads it in place like any other cloud file. No SQLite import, and
   * a workflow run refreshes it through the same cloudSource path as S3.
   */
  listObjects: async (config, connectionId, containerName, prefix = '', pageSize = 1000, continuationToken = null, searchTerm = '') => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);
      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });
      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      const spreadsheetId = await resolveSpreadsheetId(drive, sheets, containerName);
      const metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties(title),sheets(properties(title,gridProperties(rowCount,columnCount)))',
      });

      const term = String(searchTerm || '').toLowerCase();
      const objects = (metadata.data.sheets || [])
        .map((sheet) => {
          const title = sheet.properties?.title || '';
          const grid = sheet.properties?.gridProperties || {};
          return {
            name: `${title}.csv`,
            objectKey: title,
            isFolder: false,
            size: 0,
            rowCount: grid.rowCount || 0,
            columnCount: grid.columnCount || 0,
            lastModified: null,
          };
        })
        .filter((o) => !term || o.objectKey.toLowerCase().includes(term));

      return {
        success: true,
        objects,
        // The spreadsheet's own name, so a caller that only had an id (someone
        // pasting a link) can show WHAT it just opened.
        containerName: metadata.data.properties?.title || spreadsheetId,
        spreadsheetId,
        isTruncated: false,
        nextContinuationToken: null,
        totalCount: objects.length,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * One tab, as CSV bytes.
   *
   * Returning a file rather than rows is what lets Sheets reuse the whole
   * cloud-storage pipeline: saved to disk, read in place by DuckDB, and
   * re-downloaded on every run.
   */
  downloadObject: async (config, connectionId, containerName, objectName) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);
      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });
      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      const spreadsheetId = await resolveSpreadsheetId(drive, sheets, containerName);
      const tab = tabNameOf(objectName);
      if (!tab) return { success: false, message: 'No sheet tab was selected' };

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tab.replace(/'/g, "''")}'!A1:ZZ`,
      });

      const values = response.data.values || [];
      if (values.length === 0) {
        return { success: true, data: Buffer.from('', 'utf-8'), contentType: 'text/csv', name: `${tab}.csv` };
      }

      // A blank or repeated header cell would otherwise collapse two columns
      // into one, so every column gets a distinct name before it becomes CSV.
      const seen = new Map();
      const headers = (values[0] || []).map((h, i) => {
        const base = String(h ?? '').trim() || `Column_${i + 1}`;
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base}_${count}`;
      });

      const rows = values.slice(1).map((row) => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
        return obj;
      });

      const csv = new Parser({ fields: headers }).parse(rows);
      return {
        success: true,
        data: Buffer.from(csv, 'utf-8'),
        contentType: 'text/csv',
        contentLength: Buffer.byteLength(csv),
        name: `${tab}.csv`,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Write rows into a tab of an existing spreadsheet.
   *
   * `containerName` is the spreadsheet (id, or a title to find/create) and
   * `objectName` is the TAB. A missing tab is added rather than failing, and a
   * missing spreadsheet is created — so "put this in the sheet I picked" and
   * "make me a new one" are the same call.
   *
   * An empty tab gets a header row and the data. A tab that already holds rows
   * is APPENDED to, with each row lined up under the header that is already
   * there — matching how an output node behaves against a database table, and
   * never silently discarding what a person has in the sheet.
   */
  uploadObject: async (config, connectionId, containerName, objectName, data, contentType, options = {}) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);
      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });
      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      const rows = rowsFromPayload(data);
      if (!Array.isArray(rows) || rows.length === 0) {
        return { success: false, message: 'Data must be a non-empty array of objects' };
      }

      const spreadsheetId = await resolveSpreadsheetId(drive, sheets, containerName, { createIfMissing: true });
      const tab = tabNameOf(objectName) || 'Sheet1';
      const quoted = `'${tab.replace(/'/g, "''")}'`;

      // Add the tab when the spreadsheet does not have it yet.
      const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties(title),sheets(properties(title))' });
      const existingTabs = (metadata.data.sheets || []).map((sh) => sh.properties?.title);
      if (!existingTabs.includes(tab)) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
        });
      }

      // Truncate: wipe the tab's contents so the rows below are all it holds.
      // The TAB survives (formatting, its position in the workbook, anything
      // pointing at it by name) — only the values go.
      if (options.writeMode === 'truncate') {
        await sheets.spreadsheets.values.clear({ spreadsheetId, range: quoted, requestBody: {} });
        console.log(`[Google Sheets] Cleared tab "${tab}" before loading`);
      }

      // What is already in the tab decides header-and-write vs append. After a
      // truncate there is nothing, so it always takes the header-and-write path.
      const current = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoted}!A1:ZZ1` });
      const existingHeaders = current.data.values?.[0] || [];
      const asCell = (v) => (v === null || v === undefined ? '' : String(v));

      if (existingHeaders.length === 0) {
        const headers = Object.keys(rows[0]);
        const values = [headers, ...rows.map((r) => headers.map((h) => asCell(r[h])))];
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${quoted}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values },
        });
        return {
          success: true,
          message: `${options.writeMode === 'truncate' ? 'Replaced' : 'Wrote'} ${rows.length} row(s) `
            + `in "${tab}" of "${metadata.data.properties?.title || spreadsheetId}"`,
          spreadsheetId,
          sheetName: tab,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
        };
      }

      // Existing header wins: a column the sheet does not have is left out
      // rather than shifting every later value into the wrong column.
      const values = rows.map((r) => existingHeaders.map((h) => asCell(r[h])));
      const missing = Object.keys(rows[0]).filter((k) => !existingHeaders.includes(k));
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${quoted}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });

      return {
        success: true,
        message: `Appended ${rows.length} row(s) to "${tab}" in "${metadata.data.properties?.title || spreadsheetId}"`
          + (missing.length ? ` (columns not in the sheet were skipped: ${missing.join(', ')})` : ''),
        spreadsheetId,
        sheetName: tab,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete a tab from a spreadsheet.
   *
   * Part of the cloud-storage contract (pluginManager.validateConnectorPlugin
   * requires it, and without it this connector was never registered at all —
   * every call came back "Storage connector not found"). Deleting an "object"
   * here means removing the tab, never the spreadsheet: a file the user picked
   * is not something a workflow should be able to destroy by name.
   */
  deleteObject: async (config, connectionId, containerName, objectName) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);
      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });
      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      const spreadsheetId = await resolveSpreadsheetId(drive, sheets, containerName);
      const tab = tabNameOf(objectName);
      if (!tab) return { success: false, message: 'No sheet tab was named' };

      const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
      const all = metadata.data.sheets || [];
      const target = all.find((sh) => sh.properties?.title === tab);
      if (!target) return { success: false, message: `Sheet tab "${tab}" not found` };
      if (all.length === 1) {
        return { success: false, message: `"${tab}" is the only tab in this spreadsheet and cannot be deleted` };
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ deleteSheet: { sheetId: target.properties.sheetId } }] },
      });

      return { success: true, message: `Deleted sheet tab "${tab}"` };
    } catch (error) {
      return { success: false, message: error.message };
    }
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
