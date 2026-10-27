# Google Sheets Connector for Ternlux

OAuth2.0-based connector for accessing Google Sheets data.

## Setup Instructions

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable Google Sheets API and Google Drive API

### 2. Create OAuth 2.0 Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Add authorized redirect URI: `http://localhost:3000/oauth/callback`
5. Copy the **Client ID** and **Client Secret**

### 3. Configure Connector in Ternlux

1. Add new connection in Ternlux
2. Select "Google Sheets" connector
3. Enter your Client ID and Client Secret
4. Click "Authorize" to complete OAuth flow
5. Grant permissions when prompted

## Required Scopes

- `https://www.googleapis.com/auth/spreadsheets.readonly` - Read spreadsheet data
- `https://www.googleapis.com/auth/drive.readonly` - List spreadsheets from Drive

## Features

- ✅ OAuth2.0 authentication with automatic token refresh
- ✅ List all accessible spreadsheets
- ✅ Read data from any sheet
- ✅ Support for multiple tabs/sheets
- ✅ Batch data streaming for large datasets
- ✅ Secure credential storage

## Query Format

Queries use JSON format:

```json
{
  "spreadsheetId": "1ABC...",
  "sheetName": "Sheet1",
  "range": "A1:Z1000"
}
```

## Notes

- Tokens are automatically refreshed when expired
- Use refresh_token for long-term access
- Always use HTTPS in production
