/**
 * Slack Connector Plugin for Ternlux
 * OAuth2.0-based authentication for accessing Slack workspace
 * Supports reading messages from channels and sending messages
 */

const axios = require('axios');

// OAuth client cache
const tokenRefreshCallbacks = new Map();

/**
 * Refresh access token if needed
 */
async function refreshAccessTokenIfNeeded(config, connectionId) {
  try {
    // Slack OAuth tokens don't typically expire, but we can check if needed
    // If you implement token refresh, add logic here
    return config;
  } catch (error) {
    console.error('[Slack] Token refresh error:', error.response?.data?.error_description || error.message);
    throw error;
  }
}

/**
 * Register a callback to be called when token is refreshed
 */
function registerTokenRefreshCallback(connectionId, callback) {
  tokenRefreshCallbacks.set(connectionId, callback);
}

/**
 * Make authenticated request to Slack API
 */
async function makeSlackRequest(endpoint, accessToken, params = {}) {
  try {
    const response = await axios.get(`https://slack.com/api/${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params
    });

    if (!response.data.ok) {
      throw new Error(response.data.error || 'Slack API error');
    }

    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.error || error.message);
  }
}

/**
 * Post message to Slack API
 */
async function postSlackMessage(endpoint, accessToken, data) {
  try {
    const response = await axios.post(`https://slack.com/api/${endpoint}`, data, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.data.ok) {
      throw new Error(response.data.error || 'Slack API error');
    }

    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.error || error.message);
  }
}

module.exports = {
  type: 'connector',
  id: 'slack',
  name: 'Slack',
  icon: './icon.svg',
  dbCategory: 'API',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const scopes = [
        'channels:read',      // List public channels
        'channels:history',   // Read messages from public channels
        'chat:write',         // Send messages
        'users:read',         // Read user information
        'groups:read',        // List private channels
        'groups:history',     // Read messages from private channels
        'im:read',            // List direct messages
        'im:history',         // Read direct messages
        'mpim:read',          // List group direct messages
        'mpim:history'        // Read group direct messages
      ];

      const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${config.clientId}&scope=${scopes.join(',')}&redirect_uri=${encodeURIComponent(config.redirectUri || 'http://localhost:3000/oauth/callback')}&state=${config.state || ''}`;

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
      const response = await axios.post('https://slack.com/api/oauth.v2.access', null, {
        params: {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: code,
          redirect_uri: config.redirectUri || 'http://localhost:3000/oauth/callback'
        }
      });

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to exchange code for tokens');
      }

      return {
        success: true,
        tokens: {
          accessToken: response.data.access_token,
          tokenType: response.data.token_type,
          scope: response.data.scope,
          botUserId: response.data.bot_user_id,
          teamId: response.data.team.id,
          teamName: response.data.team.name
        }
      };
    } catch (error) {
      console.error('[Slack] Token exchange error:', error.response?.data?.error_description || error.message);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Refresh access token (Slack tokens don't typically expire)
   */
  refreshAccessToken: async (config) => {
    // Slack OAuth tokens don't expire by default
    // If using rotating tokens, implement refresh logic here
    return {
      success: true,
      tokens: {
        accessToken: config.accessToken,
        tokenType: config.tokenType,
        scope: config.scope
      }
    };
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

      // Test by getting auth info
      const data = await makeSlackRequest('auth.test', config.accessToken);

      return {
        success: true,
        message: `Connected to ${data.team} workspace as ${data.user}`
      };
    } catch (error) {
      console.error('[Slack] Test connection error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get list of channels (tables)
   */
  getTables: async (config, connectionId = null) => {
    try {
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token available'
        };
      }

      const channels = [];

      // Get public channels
      const publicChannels = await makeSlackRequest('conversations.list', config.accessToken, {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000
      });

      if (publicChannels.channels) {
        channels.push(...publicChannels.channels.map(ch => ({
          schema: 'slack_channels',
          name: ch.id,
          displayName: `#${ch.name}`,
          type: ch.is_private ? 'private_channel' : 'public_channel',
          created: new Date(ch.created * 1000).toISOString(),
          memberCount: ch.num_members
        })));
      }

      // Get direct messages
      const dms = await makeSlackRequest('conversations.list', config.accessToken, {
        types: 'im',
        exclude_archived: true,
        limit: 1000
      });

      if (dms.channels) {
        channels.push(...dms.channels.map(ch => ({
          schema: 'slack_dms',
          name: ch.id,
          displayName: 'Direct Message',
          type: 'im',
          created: new Date(ch.created * 1000).toISOString()
        })));
      }

      return {
        success: true,
        tables: channels
      };
    } catch (error) {
      console.error('[Slack] Get tables error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get message structure (columns)
   */
  getColumns: async (config, connectionId, schema, channelId) => {
    try {
      // Slack messages have a consistent structure
      return {
        success: true,
        columns: [
          { name: 'ts', type: 'TEXT', nullable: false, isPrimary: true },
          { name: 'user', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'text', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'type', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'subtype', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'thread_ts', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'reply_count', type: 'INTEGER', nullable: true, isPrimary: false },
          { name: 'reactions', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'files', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'created_at', type: 'TEXT', nullable: true, isPrimary: false }
        ]
      };
    } catch (error) {
      console.error('[Slack] Get columns error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get table schema with sample messages
   */
  getTableSchema: async (config, connectionId, channelId, sheetName = null, limit = 5) => {
    try {
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token available'
        };
      }

      // Fetch sample messages
      const response = await makeSlackRequest('conversations.history', config.accessToken, {
        channel: channelId,
        limit: limit
      });

      const messages = response.messages || [];

      // Transform messages to sample data
      const sampleData = messages.map(msg => ({
        ts: msg.ts,
        user: msg.user || null,
        text: msg.text ? (msg.text.length > 100 ? msg.text.substring(0, 100) + '...' : msg.text) : null,
        type: msg.type,
        subtype: msg.subtype || null,
        thread_ts: msg.thread_ts || null,
        reply_count: msg.reply_count || 0,
        reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
        files: msg.files ? JSON.stringify(msg.files) : null,
        created_at: new Date(parseFloat(msg.ts) * 1000).toISOString()
      }));

      return {
        success: true,
        tableName: channelId,
        columns: [
          { name: 'ts', type: 'TEXT', nullable: false, isPrimary: true },
          { name: 'user', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'text', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'type', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'subtype', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'thread_ts', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'reply_count', type: 'INTEGER', nullable: true, isPrimary: false },
          { name: 'reactions', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'files', type: 'TEXT', nullable: true, isPrimary: false },
          { name: 'created_at', type: 'TEXT', nullable: true, isPrimary: false }
        ],
        sampleData
      };
    } catch (error) {
      console.error('[Slack] Get table schema error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Run query (fetch messages from channel)
   */
  runQuery: async (config, connectionId, query) => {
    try {
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token available'
        };
      }

      // Parse query - can be JSON string or object
      const queryObj = typeof query === 'string' ? JSON.parse(query) : query;
      const { channelId, limit = 100, oldest, latest } = queryObj;

      if (!channelId) {
        return {
          success: false,
          message: 'channelId is required for Slack queries'
        };
      }

      const params = {
        channel: channelId,
        limit: Math.min(limit, 1000) // Slack API max is 1000
      };

      if (oldest) params.oldest = oldest;
      if (latest) params.latest = latest;

      const response = await makeSlackRequest('conversations.history', config.accessToken, params);

      const messages = response.messages || [];

      // Transform messages to row format
      const rows = messages.map(msg => ({
        ts: msg.ts,
        user: msg.user || null,
        text: msg.text || null,
        type: msg.type,
        subtype: msg.subtype || null,
        thread_ts: msg.thread_ts || null,
        reply_count: msg.reply_count || 0,
        reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
        files: msg.files ? JSON.stringify(msg.files) : null,
        created_at: new Date(parseFloat(msg.ts) * 1000).toISOString()
      }));

      return {
        success: true,
        rows,
        columns: ['ts', 'user', 'text', 'type', 'subtype', 'thread_ts', 'reply_count', 'reactions', 'files', 'created_at'],
        rowCount: rows.length
      };
    } catch (error) {
      console.error('[Slack] Run query error:', error);
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
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token available'
        };
      }

      const queryObj = typeof query === 'string' ? JSON.parse(query) : query;
      const { channelId, limit } = queryObj;

      let cursor = null;
      let totalRows = 0;
      const maxLimit = limit || 10000;

      while (totalRows < maxLimit) {
        const params = {
          channel: channelId,
          limit: Math.min(batchSize, maxLimit - totalRows)
        };

        if (cursor) params.cursor = cursor;

        const response = await makeSlackRequest('conversations.history', config.accessToken, params);
        const messages = response.messages || [];

        if (messages.length === 0) break;

        const rows = messages.map(msg => ({
          ts: msg.ts,
          user: msg.user || null,
          text: msg.text || null,
          type: msg.type,
          subtype: msg.subtype || null,
          thread_ts: msg.thread_ts || null,
          reply_count: msg.reply_count || 0,
          reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
          files: msg.files ? JSON.stringify(msg.files) : null,
          created_at: new Date(parseFloat(msg.ts) * 1000).toISOString()
        }));

        await onBatch(rows, ['ts', 'user', 'text', 'type', 'subtype', 'thread_ts', 'reply_count', 'reactions', 'files', 'created_at']);

        totalRows += rows.length;

        if (!response.has_more) break;
        cursor = response.response_metadata?.next_cursor;
        if (!cursor) break;
      }

      return {
        success: true,
        totalRows
      };
    } catch (error) {
      console.error('[Slack] Stream query error:', error);
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
   * Upload object (send messages to Slack channel)
   * This makes Slack compatible with output interface
   */
  uploadObject: async (config, connectionId, containerName, fileName, data, contentType) => {
    try {
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token available'
        };
      }

      // Parse data from Buffer if needed
      let messageData;
      if (Buffer.isBuffer(data)) {
        const dataString = data.toString('utf-8');
        messageData = JSON.parse(dataString);
      } else if (typeof data === 'string') {
        messageData = JSON.parse(data);
      } else {
        messageData = data;
      }

      // containerName is the channel ID or name
      const channelId = containerName;

      // If messageData is an array, send each message
      if (Array.isArray(messageData)) {
        const results = [];

        for (const message of messageData) {
          const messageText = typeof message === 'string' ? message : (message.text || JSON.stringify(message));

          const result = await postSlackMessage('chat.postMessage', config.accessToken, {
            channel: channelId,
            text: messageText,
            thread_ts: message.thread_ts || undefined,
            reply_broadcast: message.reply_broadcast || false
          });

          results.push(result);
        }

        return {
          success: true,
          message: `Successfully sent ${results.length} message(s) to channel`,
          messageCount: results.length
        };
      } else {
        // Single message
        const messageText = typeof messageData === 'string' ? messageData : (messageData.text || JSON.stringify(messageData));

        const result = await postSlackMessage('chat.postMessage', config.accessToken, {
          channel: channelId,
          text: messageText,
          thread_ts: messageData.thread_ts || undefined,
          reply_broadcast: messageData.reply_broadcast || false
        });

        return {
          success: true,
          message: 'Message sent successfully',
          timestamp: result.ts,
          channel: result.channel
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
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
        placeholder: 'xxxxxxxxxxxx.xxxxxxxxxxxx',
        required: true,
        sensitive: true,
        helpText: 'Get this from Slack App settings'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'OAuth Client Secret',
        required: true,
        sensitive: true,
        helpText: 'Get this from Slack App settings'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Slack App settings'
      },
      {
        name: 'accessToken',
        type: 'hidden',
        label: 'Access Token',
        required: false,
        sensitive: true
      },
      {
        name: 'botUserId',
        type: 'hidden',
        label: 'Bot User ID',
        required: false,
        sensitive: false
      },
      {
        name: 'teamId',
        type: 'hidden',
        label: 'Team ID',
        required: false,
        sensitive: false
      },
      {
        name: 'teamName',
        type: 'hidden',
        label: 'Team Name',
        required: false,
        sensitive: false
      }
    ]
  },

  /**
   * Plugin metadata
   */
  metadata: {
    displayName: 'Slack',
    description: 'Connect to Slack to read messages from channels and send messages',
    version: '1.0.0',
    author: 'Ternlux',
    capabilities: ['read', 'write'],
    documentationUrl: 'https://api.slack.com/docs'
  }
};
