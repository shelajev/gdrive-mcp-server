# Google Drive MCP Server

A powerful Model Context Protocol (MCP) server that provides seamless integration with Google Drive, allowing AI models to search, list, and read files from Google Drive.

## 🚀 Features

### Tools

#### 1. `gdrive_search`
Search for files in your Google Drive with powerful full-text search capabilities.
- **Input**: 
  ```json
  {
    "query": "string (your search query)"
  }
  ```
- **Output**: List of files with:
  - File name
  - MIME type
  - File ID
  - Last modified time
  - File size

#### 2. `gdrive_read_file`
Read file contents directly using a Google Drive file ID.
- **Input**:
  ```json
  {
    "file_id": "string (Google Drive file ID)"
  }
  ```
- **Output**: File contents with appropriate format conversion

#### 3. `gdrive_set_oauth_token`
Set the Google Drive OAuth token used for authenticating subsequent API calls.
- **Input**:
  ```json
  {
    "oauth_token": "string (Google OAuth access token)"
  }
  ```
- **Output**: Confirmation message.

### Automatic File Format Handling

The server intelligently handles different Google Workspace file types:
- 📝 Google Docs → Markdown
- 📊 Google Sheets → CSV
- 📊 Google Presentations → Plain text
- 🎨 Google Drawings → PNG
- 📄 Text/JSON files → UTF-8 text
- 📦 Other files → Base64 encoded

## 🛠️ Getting Started

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn
- A Google Cloud Project
- A Google Workspace or personal Google account

### Detailed Google Cloud Setup

1. **Create a Google Cloud Project**
   - Visit the [Google Cloud Console](https://console.cloud.google.com/projectcreate)
   - Click "New Project"
   - Enter a project name (e.g., "MCP GDrive Server")
   - Click "Create"
   - Wait for the project to be created and select it

2. **Enable the Google Drive API**
   - Go to the [API Library](https://console.cloud.google.com/apis/library)
   - Search for "Google Drive API"
   - Click on "Google Drive API"
   - Click "Enable"
   - Wait for the API to be enabled

3. **Configure OAuth Consent Screen**
   - Navigate to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
   - Select User Type:
     - "Internal" if you're using Google Workspace
     - "External" for personal Google accounts
   - Click "Create"
   - Fill in the required fields:
     - App name: "MCP GDrive Server"
     - User support email: your email
     - Developer contact email: your email
   - Click "Save and Continue"
   - On the "Scopes" page:
     - Click "Add or Remove Scopes"
     - Add `https://www.googleapis.com/auth/drive.readonly`
     - Click "Update"
   - Click "Save and Continue"
   - Review the summary and click "Back to Dashboard"

4. **Create OAuth Client ID**
   - Go to [Credentials](https://console.cloud.google.com/apis/credentials)
   - Click "Create Credentials" at the top
   - Select "OAuth client ID"
   - Choose Application type: "Desktop app"
   - Name: "MCP GDrive Server Desktop Client"
   - Click "Create"
   - In the popup:
     - Click "Download JSON"
     - Save the file
     - Click "OK"

5. **Set Up Credentials in Project**
   ```bash
   # Create credentials directory
   mkdir credentials
   
   # Move and rename the downloaded JSON file
   mv path/to/downloaded/client_secret_*.json credentials/gcp-oauth.keys.json
   ```

### Installation

```bash
# Clone the repository
git clone https://github.com/felores/gdrive-mcp-server.git
cd gdrive-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

### Authentication

This server requires a Google OAuth 2.0 access token with the `https://www.googleapis.com/auth/drive.readonly` scope to interact with the Google Drive API. Authentication can be configured in two ways:

1.  **Environment Variable (Initial Authentication)**:
    - Set the `MCP_GDRIVE_OAUTH_TOKEN` environment variable when starting the server.
    - The server will use this token for initial authentication.
    - Example: `MCP_GDRIVE_OAUTH_TOKEN="your-oauth-token" node dist/index.js`

2.  **MCP Tool (`gdrive_set_oauth_token`)**: 
    - Use the `gdrive_set_oauth_token` tool provided by this server to set or update the OAuth token dynamically at runtime.
    - This method is useful if the token needs to be refreshed or provided by a client application after the server has started.
    - The token set via this tool will override any token provided via the environment variable.

**Note:** You still need to set up Google Cloud OAuth credentials (`credentials/gcp-oauth.keys.json`) as described in the "Detailed Google Cloud Setup" section, as these are required by the underlying Google API client library, even when providing the token directly.

## 🔧 Usage

### As a Command Line Tool

```bash
# Start the server
node dist/index.js
```

### Integration with Desktop App

Add this configuration to your app's server settings:

```json
{
  "mcpServers": {
    "gdrive": {
      "command": "node",
      "args": ["path/to/gdrive-mcp-server/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "path/to/gdrive-mcp-server/credentials/gcp-oauth.keys.json",
        "MCP_GDRIVE_OAUTH_TOKEN": "your-initial-oauth-token" // Optional: Provide initial token here
      }
    }
  }
}
```

Replace `path/to/gdrive-mcp-server` with the actual path to your installation directory.

### Example Usage

1. **Search for files**:
   ```typescript
   // Search for documents containing "quarterly report"
   const result = await gdrive_search({ query: "quarterly report" });
   ```

2. **Read file contents**:
   ```typescript
   // Read a specific file using its ID
   const contents = await gdrive_read_file({ file_id: "your-file-id" });
   ```

## 🔒 Security

- The OAuth client secret (`gcp-oauth.keys.json`) is stored locally.
- The OAuth access token is handled in memory and can be provided via an environment variable or a secure MCP tool call. Avoid logging the token or exposing it unnecessarily.
- Read-only access to Google Drive

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

This MCP server is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## 🔍 Troubleshooting

If you encounter issues:
1. Verify your Google Cloud Project setup
2. Ensure all required OAuth scopes are enabled
3. Check that credentials are properly placed in the `credentials` directory
4. Verify file permissions and access rights in Google Drive

## 📚 Additional Resources

- [Google Drive API Documentation](https://developers.google.com/drive/api/v3/reference)
- [OAuth 2.0 for Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
