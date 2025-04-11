# Google Drive MCP Server

This server acts as a bridge between the Model Context Protocol (MCP) and Google Drive, allowing clients to interact with Google Drive files.

## Features

The server currently exposes the following MCP tools:

*   **`gdrive_search`**: Searches for files within your Google Drive based on a query string. Requires a `query` parameter. Returns a list of matching files including their ID, name, and MIME type.
*   **`gdrive_read_file`**: Reads the content of a specific file in Google Drive using its file ID. Requires a `file_id` parameter. It automatically handles exporting Google Workspace formats (Docs, Sheets, Slides) to common types (Markdown, CSV, text) and returns other file types as Base64 encoded strings.

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
