#!/usr/bin/env node

import { authenticate } from "@google-cloud/local-auth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesRequest,
  ReadResourceRequest,
  CallToolRequest,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';

// Variable to hold the current OAuth token
let currentAuthToken: string | null = null;
// Global variable to hold the configured OAuth client
let googleAuthClient: OAuth2Client | null = null; // Use OAuth2Client type consistently
const TOKEN_FILE_PATH = "/tmp/auth_token.txt"; // Path inside the container

// Function to initialize the client (call this once at startup using env vars as defaults)
function initializeGoogleAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  console.log("Attempting to initialize Google OAuth client...");

  if (!clientId) {
    console.warn("GOOGLE_CLIENT_ID environment variable not set. Cannot initialize OAuth client properly. API calls may fail.");
    // Proceeding without client init, relying on token tool call, but it will likely fail 401
    return;
  }

  if (!clientSecret) {
    console.warn("GOOGLE_CLIENT_SECRET environment variable not set. Cannot initialize OAuth client properly. API calls may fail.");
    // Proceeding without client init, relying on token tool call, but it will likely fail 401
    return;
  }

  // Initialize the OAuth2 client with credentials - only clientId is needed now
  googleAuthClient = new google.auth.OAuth2(
    clientId,
    clientSecret, // No client secret needed
    undefined // No redirect URI needed
  );

  // Set this client globally for googleapis to use
  google.options({ auth: googleAuthClient });
  console.log(`Google OAuth client initialized with Client ID: ${clientId}.`);
}

// Function to update tokens on the pre-initialized client
function updateTokensOnClient(accessToken: string, refreshToken?: string) {
  if (!googleAuthClient) {
    // This happens if GOOGLE_CLIENT_ID was missing at startup
    console.error("OAuth client was not initialized (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in env vars?). Cannot set tokens.");
    throw new Error("OAuth client is not configured. Ensure GOOGLE_CLIENT_ID & GOOGLE_CLIENT_ID env var is set.");
  }

  console.log("Attempting to update tokens on OAuth client...");
  currentAuthToken = accessToken; // Keep track of current access token if needed

  const credentials: { access_token: string; refresh_token?: string } = { access_token: accessToken };
  if (refreshToken) {
    credentials.refresh_token = refreshToken;
  }

  try {
    // Set the credentials on the existing, configured client instance
    googleAuthClient.setCredentials(credentials);
    console.log(`Tokens set on the initialized OAuth client. Refresh token was ${refreshToken ? 'provided' : 'not provided'}.`);
  } catch (error) {
    console.error("Error setting credentials on OAuth client:", error);
    // Re-throw or handle as appropriate, might indicate an issue with the tokens themselves
    throw new Error(`Failed to set tokens on OAuth client: ${error instanceof Error ? error.message : String(error)}`);
  }
  // No need to call google.options again, it uses the client instance set at initialization
}

// Function to read the token file and update the client
function readAndUpdateTokenFromFile() {
  console.log(`Checking for token file at ${TOKEN_FILE_PATH}...`);
  if (!fs.existsSync(TOKEN_FILE_PATH)) {
    console.log(`Token file ${TOKEN_FILE_PATH} does not exist. Skipping initial read.`);
    return;
  }

  try {
    console.log(`Reading token file: ${TOKEN_FILE_PATH}`);
    const fileContent = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
    if (fileContent) {
      try {
        // Attempt to parse as JSON first (might contain refresh token)
        console.log("Attempting to parse token file as JSON...");
        const tokenData = JSON.parse(fileContent);
        if (tokenData.access_token) {
          console.log("Found access_token in JSON. Updating client...");
          updateTokensOnClient(tokenData.access_token, tokenData.refresh_token);
          console.log(`Successfully updated tokens from ${TOKEN_FILE_PATH} (JSON format).`);
        } else {
           console.warn(`Token file ${TOKEN_FILE_PATH} contained JSON, but no access_token field.`);
        }
      } catch (jsonError) {
        // If not valid JSON, assume it's just the access token string
        console.log("Token file not valid JSON, assuming plain text access token. Updating client...");
        updateTokensOnClient(fileContent);
        console.log(`Successfully updated access token from ${TOKEN_FILE_PATH} (plain text format).`);
      }
    } else {
       console.log(`Token file ${TOKEN_FILE_PATH} is empty. No token update.`);
    }
  } catch (error) {
    console.error(`Error reading or processing token file ${TOKEN_FILE_PATH}:`, error);
  }
}

// Function to watch the token file for changes
function watchTokenFile() {
  // Ensure the directory exists if it doesn't (relevant if path involves dirs)
  // For /gdrive_current_token, the root directory '/' always exists in Linux/Docker.
  
  // Initial read attempt when starting the watcher
  readAndUpdateTokenFromFile(); 

  try {
    fs.watch(TOKEN_FILE_PATH, (eventType, filename) => {
      if (filename && (eventType === 'change' || eventType === 'rename')) {
        console.log(`Token file ${TOKEN_FILE_PATH} changed (${eventType}). Re-reading.`);
        readAndUpdateTokenFromFile();
      }
    });
    console.log(`Watching token file ${TOKEN_FILE_PATH} for changes.`);
  } catch (error) {
     // This might happen if the file doesn't exist initially and watch fails depending on the OS
    console.error(`Error setting up watch on ${TOKEN_FILE_PATH}:`, error);
    // Attempt to set up watch again later? For now, just log.
    // Consider trying to watch the directory if watching the file directly fails robustly.
    // fs.watch(path.dirname(TOKEN_FILE_PATH), ...) might be an alternative.
  }
}

const drive = google.drive("v3");

const server = new Server(
  {
    name: "gdrive",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async (request: ListResourcesRequest) => {
  const pageSize = 10;
  const params: any = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  const res = await drive.files.list(params);
  const files = res.data.files!;

  return {
    resources: files.map((file: drive_v3.Schema$File) => ({
      uri: `gdrive:///${file.id}`,
      mimeType: file.mimeType,
      name: file.name,
    })),
    nextCursor: res.data.nextPageToken,
  };
});

async function readFileContent(fileId: string, authClientOverride?: OAuth2Client) {
  console.log(`[readFileContent] Attempting to read file ID: ${fileId}`);
  const driveClient = authClientOverride ? google.drive({ version: 'v3', auth: authClientOverride }) : drive;

  try {
    // First get file metadata to check mime type
    console.log(`[readFileContent] Getting metadata for file ID: ${fileId}`);
    const file = await driveClient.files.get({
      fileId,
      fields: "mimeType",
    });
    console.log(`[readFileContent] Got metadata for file ID: ${fileId}, mimeType: ${file.data.mimeType}`);

    // For Google Docs/Sheets/etc we need to export
    if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
      let exportMimeType: string;
      switch (file.data.mimeType) {
        case "application/vnd.google-apps.document":
          exportMimeType = "text/markdown";
          break;
        case "application/vnd.google-apps.spreadsheet":
          exportMimeType = "text/csv";
          break;
        case "application/vnd.google-apps.presentation":
          exportMimeType = "text/plain";
          break;
        case "application/vnd.google-apps.drawing":
          exportMimeType = "image/png";
          break;
        default:
          exportMimeType = "text/plain";
      }
      console.log(`[readFileContent] Exporting Google Doc ${fileId} as ${exportMimeType}`);
      const res = await driveClient.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );
      console.log(`[readFileContent] Successfully exported ${fileId}`);

      return {
        mimeType: exportMimeType,
        content: res.data,
      };
    }

    // For regular files download content
    console.log(`[readFileContent] Downloading content for regular file ID: ${fileId}`);
    const res = await driveClient.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    console.log(`[readFileContent] Successfully downloaded content for ${fileId}`);
    const mimeType = file.data.mimeType || "application/octet-stream";
    
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      return {
        mimeType: mimeType,
        content: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
      };
    } else {
      return {
        mimeType: mimeType,
        content: Buffer.from(res.data as ArrayBuffer).toString("base64"),
      };
    }
  } catch (error: any) {
    console.error(`[readFileContent] Error processing file ID ${fileId}:`, error.message);
    // Log specific Google API errors if available
    if (error.errors) {
        console.error('[readFileContent] Google API Error Details:', JSON.stringify(error.errors, null, 2));
    }
     console.error('[readFileContent] Full Error Object:', error);
    throw error;
  }
}

server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
  const fileId = request.params.uri.replace("gdrive:///", "");
  const result = await readFileContent(fileId);
  
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: result.mimeType,
        text: result.content,
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "gdrive_search",
        description: "Search for files specifically in your Google Drive account",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "gdrive_read_file",
        description: "Read a file from Google Drive using its Google Drive file ID",
        inputSchema: {
          type: "object",
          properties: {
            file_id: {
              type: "string",
              description: "The ID of the file to read",
            },
          },
          required: ["file_id"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  // Function to create a temporary client for a specific request
  const createTemporaryClient = (accessToken: string): OAuth2Client | null => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      console.error("Cannot create temporary client: GOOGLE_CLIENT_ID missing.");
      return null;
    }
    const tempClient = new google.auth.OAuth2(clientId);
    tempClient.setCredentials({ access_token: accessToken });
    return tempClient;
  };

  if (request.params.name === "gdrive_search") {
    const args = request.params.arguments as { query: string };
    const userQuery = args.query;
    console.log(`[ToolCall] Received gdrive_search request with query: "${userQuery}"`);

    const driveClient = drive; // Always use the globally configured client

    const escapedQuery = userQuery.replace(/\\\\/g, "\\\\").replace(/'/g, "\\'");
    const formattedQuery = `fullText contains '${escapedQuery}'`;
    console.log(`[ToolCall] Executing Drive API files.list with query: "${formattedQuery}"`);

    try {
      const res = await driveClient.files.list({
        q: formattedQuery,
        pageSize: 10,
        fields: "files(id, name, mimeType, modifiedTime, size)",
      });
      console.log(`[ToolCall] Drive API files.list successful. Found ${res.data.files?.length ?? 0} files.`);

      const fileList = res.data.files
        ?.map((file: any) => `${file.name} (${file.mimeType}) - ID: ${file.id}`)
        .join("\\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${res.data.files?.length ?? 0} files:\\n${fileList}`,
          },
        ],
        isError: false,
      };
    } catch (error: any) {
        console.error(`[ToolCall] Error executing Drive API files.list for query "${formattedQuery}":`, error.message);
         if (error.errors) {
            console.error('[ToolCall] Google API Error Details:', JSON.stringify(error.errors, null, 2));
         }
         console.error('[ToolCall] Full Error Object:', error);
        // Return an error response to the MCP client
        return {
            content: [ { type: "text", text: `Error searching files: ${error.message}` } ],
            isError: true,
        };
    }
  } else if (request.params.name === "gdrive_read_file") {
    const args = request.params.arguments as { file_id: string };
    const fileId = args.file_id;
     console.log(`[ToolCall] Received gdrive_read_file request for file ID: ${fileId}`);

    if (!fileId) {
      console.error("[ToolCall] Invalid parameters: File ID is required for gdrive_read_file.");
      throw new McpError(ErrorCode.InvalidParams, "File ID is required");
    }

    try {
      // Always use the globally configured client
      console.log(`[ToolCall] Calling readFileContent for file ID: ${fileId}`);
      const result = await readFileContent(fileId);
       console.log(`[ToolCall] readFileContent successful for file ID: ${fileId}. MimeType: ${result.mimeType}`);
      return {
        content: [
          {
            type: "text",
            text: result.content,
          },
        ],
        isError: false,
      };
    } catch (error: any) {
       // readFileContent already logs the detailed error
       console.error(`[ToolCall] Error in gdrive_read_file handler for file ID ${fileId}:`, error.message);
      return {
        content: [
          {
            type: "text",
            text: `Error reading file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
  console.error(`[ToolCall] Unknown tool name requested: ${request.params.name}`);
  throw new Error("Tool not found");
});

async function loadCredentialsAndRunServer() {
  initializeGoogleAuthClient(); // Initialize the client first using env vars (if available) as a default

  // Attempt to read and watch the token file AFTER initializing the client
  watchTokenFile();

  // Don't attempt to set tokens from env vars here, as we need the full context (including refresh token)
  // which is expected to come from the tool call.
  if (!googleAuthClient) {
    console.warn("Initial OAuth client could not be initialized from env vars (missing GOOGLE_CLIENT_ID?). Waiting for tokens via tool call, but API calls will fail until client is configured and tokens are set.");
  } else {
    console.log("OAuth client initialized from environment variables. Waiting for tokens via tool call.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

loadCredentialsAndRunServer().catch((error) => {
  process.stderr.write(`Error: ${error}\n`);
  process.exit(1);
});
