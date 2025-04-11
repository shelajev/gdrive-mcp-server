# Google Drive MCP Server

This server acts as a bridge between the Model Context Protocol (MCP) and Google Drive, allowing clients to interact with Google Drive files.

## Features

The server currently exposes the following MCP tools:

*   **`gdrive_search`**: Searches for files within your Google Drive based on a query string. Requires a `query` parameter. Optionally accepts an `access_token` parameter to use for the specific request. Returns a list of matching files including their ID, name, and MIME type.
*   **`gdrive_read_file`**: Reads the content of a specific file in Google Drive using its file ID. Requires a `file_id` parameter. Optionally accepts an `access_token` parameter to use for the specific request. It automatically handles exporting Google Workspace formats (Docs, Sheets, Slides) to common types (Markdown, CSV, text) and returns other file types as Base64 encoded strings.

## Authentication

The server requires Google OAuth 2.0 credentials to access the Google Drive API.

**Environment Variables:**

*   `GOOGLE_CLIENT_ID`: **Required**. Your Google Cloud OAuth Client ID.
*   `GOOGLE_CLIENT_SECRET`: **Required**. Your Google Cloud OAuth Client Secret.

These are used to initialize the Google API client library.

**Token Provisioning via `/auth` Endpoint:**

The server needs an access token (and optionally a refresh token) to make API calls. It *does not* perform the OAuth flow itself. Instead, it listens for tokens provided via a separate mechanism:

1.  An auxiliary HTTP server runs on port `8001` within the container.
2.  You need to send a `POST` request to the `/auth` endpoint on this port (`http://<container_ip_or_host>:8001/auth`).
3.  The request body **must** be a JSON string containing the access token and optionally the refresh token:
    ```json
    {"access_token": "YOUR_ACCESS_TOKEN", "refresh_token": "YOUR_REFRESH_TOKEN"}
    ```
    Or just the access token:
    ```json
    {"access_token": "YOUR_ACCESS_TOKEN"}
    ```
4.  Upon receiving a valid POST request, the server writes the JSON payload to `/tmp/auth_token.txt` inside the container.
5.  The main MCP server process (running on port `8000`) watches this file. When the file is updated, it reads the new tokens and updates the Google API client accordingly.

This mechanism allows for dynamic token updates without restarting the main server process. You are responsible for obtaining the OAuth tokens (e.g., through a separate authentication flow) and posting them to the `/auth` endpoint.

## Building

The `build.sh` script builds and pushes multi-platform Docker images (`linux/amd64`, `linux/arm64`) to a container registry.

```bash
./build.sh
```

This command builds the image defined in the `Dockerfile` and tags it as `olegselajev241/mcp-gdrive-sse:latest` (you might want to change this tag in the script) before pushing it.

## Running with Docker Compose

Here's an example `docker-compose.yml` snippet to run the server:

```yaml
services:
  mcp-gdrive-sse:
    image: olegselajev241/mcp-gdrive-sse:latest # Use the image built by build.sh or pull from registry
    ports:
      - "8000:8000" # MCP server port
      - "8001:8001" # Auth handler port
    environment:
      - GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID_HERE # Replace with your actual Client ID
      - GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET_HERE # Replace with your actual Client Secret
    # Add volume mounts or other configurations as needed, e.g., for persistent token storage if desired outside the container.
```

**Remember to replace the placeholder values for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with your actual credentials.** You will also need a separate process to obtain OAuth tokens and POST them to `http://localhost:8001/auth` after the container starts.

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

This server requires a Google OAuth 2.0 access token with the `https://www.googleapis.com/auth/drive.readonly` scope to interact with the Google Drive API. Authentication can be configured in the following ways (in order of precedence):

1.  **Token File (`/gdrive_current_token`)**: 
    - The server monitors the file `/gdrive_current_token` within its running environment (e.g., Docker container).
    - A third-party process can write the latest token information to this file.
    - The file content can be either:
        - **Plain text:** Just the access token string.
        - **JSON:** A JSON object like `{"access_token": "YOUR_ACCESS_TOKEN", "refresh_token": "OPTIONAL_REFRESH_TOKEN"}`.
    - The server reads this file on startup and watches it for changes. If the file is updated with a non-empty value, the server will use the new token(s), overriding any previous token.
    - If the file is empty or doesn't exist initially, the server proceeds to check other methods.

2.  **Environment Variable (Initial Authentication)**:
    - Set the `GOOGLE_CLIENT_ID` environment variable. This is **required** for the Google API client library to function correctly, even if providing tokens via other methods.
    - Optionally, you can set the `MCP_GDRIVE_OAUTH_TOKEN` environment variable when starting the server. This token will be used *only* if the token file is not present or empty on startup.
    - Example: `docker run ... -e GOOGLE_CLIENT_ID="your-client-id" -e MCP_GDRIVE_OAUTH_TOKEN="your-initial-oauth-token" ...`

**Note:** While multiple methods exist, the recommended approach for dynamic updates (e.g., in a containerized environment) is using the `/gdrive_current_token` file. Ensure the `GOOGLE_CLIENT_ID` environment variable is always set. The underlying Google API client library requires the OAuth client credentials (`gcp-oauth.keys.json` or just the Client ID via env var) for token management, even when the token itself is provided dynamically.

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

   // Search using a specific token for this request
   const resultWithToken = await gdrive_search({ 
     query: "sensitive project data",
     token: "specific-access-token-for-this-call"
   });
   ```

2. **Read file contents**:
   ```typescript
   // Read a specific file using its ID
   const contents = await gdrive_read_file({ file_id: "your-file-id" });

   // Read using a specific token for this request
   const contentsWithToken = await gdrive_read_file({ 
     file_id: "another-file-id",
     token: "specific-access-token-for-this-call"
   });
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
