# Slack Connector Plugin

This plugin enables Ternlux to connect to Slack workspaces, allowing you to:
- **Read messages** from channels, direct messages, and threads (Data Source)
- **Send messages** to channels and users (Output)

## Setup Instructions

### 1. Create a Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. Enter an app name (e.g., "Ternlux Integration")
5. Select your workspace

### 2. Configure OAuth & Permissions

1. In your app settings, go to **OAuth & Permissions**
2. Under **Redirect URLs**, add: `http://localhost:3000/oauth/callback`
3. Under **Scopes**, add the following **Bot Token Scopes**:
   - `channels:read` - List public channels
   - `channels:history` - Read messages from public channels
   - `chat:write` - Send messages
   - `users:read` - Read user information
   - `groups:read` - List private channels
   - `groups:history` - Read messages from private channels
   - `im:read` - List direct messages
   - `im:history` - Read direct messages
   - `mpim:read` - List group direct messages
   - `mpim:history` - Read group direct messages

### 3. Get Your Credentials

1. Go to **Basic Information** in your app settings
2. Under **App Credentials**, copy:
   - **Client ID**
   - **Client Secret**

### 4. Install the App to Your Workspace

1. Go to **OAuth & Permissions**
2. Click **Install to Workspace**
3. Authorize the app

### 5. Configure in Ternlux

1. In Ternlux, go to **Connections** tab
2. Click **New Connection**
3. Select **Slack**
4. Enter your **Client ID** and **Client Secret**
5. Click **Authorize** to connect
6. You'll be redirected to Slack to authorize the app
7. After authorization, you'll be redirected back to Ternlux

## Usage

### As a Data Source

1. Create a new workflow
2. Add a **Data Source** node
3. Select your Slack connection
4. Choose a channel to read messages from
5. Messages will be available with the following fields:
   - `ts` - Message timestamp (unique ID)
   - `user` - User ID who sent the message
   - `text` - Message text
   - `type` - Message type
   - `subtype` - Message subtype (if any)
   - `thread_ts` - Thread timestamp (if message is in a thread)
   - `reply_count` - Number of replies
   - `reactions` - Reactions (JSON)
   - `files` - Attached files (JSON)
   - `created_at` - Message creation date

### As an Output

1. Add an **Output** node to your workflow
2. Select **Slack** as the output destination
3. Configure:
   - **Channel ID or Name** - Where to send messages
   - **Message Format** - Single message or array of messages

Message format examples:
```json
// Single message
{
  "text": "Hello from Ternlux!",
  "thread_ts": "1234567890.123456"  // Optional: reply in thread
}

// Multiple messages
[
  { "text": "First message" },
  { "text": "Second message" },
  { "text": "Third message" }
]
```

## Features

- ✅ OAuth 2.0 authentication
- ✅ Read messages from public/private channels
- ✅ Read direct messages
- ✅ Send messages to channels
- ✅ Thread support
- ✅ Pagination for large message histories
- ✅ Stream large datasets

## Limitations

- Maximum 1000 messages per query (Slack API limit)
- Rate limits apply based on your Slack workspace tier
- Archived channels are excluded by default

## Troubleshooting

### "No access token" error
Make sure you've completed the OAuth flow and authorized the app.

### "Channel not found" error
Ensure the bot is added to the channel. In Slack, type `/invite @YourBotName` in the channel.

### Rate limit errors
Slack has rate limits. If you hit them, wait a few minutes and try again.

## Support

For issues or questions:
- Check [Slack API Documentation](https://api.slack.com/docs)
- Review Slack app permissions
- Ensure bot is invited to channels you want to access
