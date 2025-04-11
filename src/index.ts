#!/usr/bin/env node

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
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET; // Read the client secret

  if (!clientId) {
    console.warn("GOOGLE_CLIENT_ID environment variable not set. Cannot initialize OAuth client properly. API calls may fail.");
    // Proceeding without client init, relying on token tool call, but it will likely fail 401
    return;
  }
  if (!clientSecret) {
    console.warn("GOOGLE_CLIENT_SECRET environment variable not set. Using client ID only for initialization.");
    // Initialize without secret, might limit certain OAuth flows but should work for provided tokens
  }

  // Initialize the OAuth2 client with credentials
  googleAuthClient = new google.auth.OAuth2(
    clientId,
    clientSecret, // Pass the client secret (or undefined if not set)
    undefined // No redirect URI needed
  );

  // Set this client globally for googleapis to use
  google.options({ auth: googleAuthClient });
  console.log(`Google OAuth client initialized with Client ID ${clientSecret ? 'and Client Secret' : '(Client Secret not provided)'}.`);
}

// Function to update tokens on the pre-initialized client
function updateTokensOnClient(accessToken: string, refreshToken?: string) {
  if (!googleAuthClient) {
    // This happens if GOOGLE_CLIENT_ID was missing at startup
    console.error("OAuth client was not initialized (missing GOOGLE_CLIENT_ID in env vars?). Cannot set tokens.");
    throw new Error("OAuth client is not configured. Ensure GOOGLE_CLIENT_ID env var is set.");
  }

  currentAuthToken = accessToken; // Keep track of current access token if needed

  const credentials: { access_token: string; refresh_token?: string } = { access_token: accessToken };
  if (refreshToken) {
    credentials.refresh_token = refreshToken;
  }

  try {
    // Set the credentials on the existing, configured client instance
    googleAuthClient.setCredentials(credentials);
    console.log(`Tokens set on the initialized OAuth client via updateTokensOnClient. Refresh token was ${refreshToken ? 'provided' : 'not provided'}.`);
  } catch (error) {
    console.error("Error setting credentials on OAuth client:", error);
    // Re-throw or handle as appropriate, might indicate an issue with the tokens themselves
    throw new Error(`Failed to set tokens on OAuth client: ${error instanceof Error ? error.message : String(error)}`);
  }
  // No need to call google.options again, it uses the client instance set at initialization
}

// Function to read the token file and update the client
function readAndUpdateTokenFromFile() {
  if (!fs.existsSync(TOKEN_FILE_PATH)) {
    // console.log(`Token file ${TOKEN_FILE_PATH} does not exist. Skipping initial read.`);
    return; 
  }

  try {
    const fileContent = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
    if (fileContent) {
      try {
        // Attempt to parse as JSON first (might contain refresh token)
        const tokenData = JSON.parse(fileContent);
        if (tokenData.access_token) {
          updateTokensOnClient(tokenData.access_token, tokenData.refresh_token);
          console.log(`Successfully updated tokens from ${TOKEN_FILE_PATH} (JSON format).`);
        } else {
           console.warn(`Token file ${TOKEN_FILE_PATH} contained JSON, but no access_token field.`);
        }
      } catch (jsonError) {
        // If not valid JSON, assume it's just the access token string
        updateTokensOnClient(fileContent);
        console.log(`Successfully updated access token from ${TOKEN_FILE_PATH} (plain text format).`);
      }
    } else {
       // console.log(`Token file ${TOKEN_FILE_PATH} is empty. No token update.`);
    }
  } catch (error) {
    console.error(`Error reading or processing token file ${TOKEN_FILE_PATH}:`, error);
  }
}

// Function to watch the token file for changes
function watchTokenFile() {
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
    console.error(`Error setting up watch on ${TOKEN_FILE_PATH}:`, error);
    // Consider alternative watching strategies if initial watch fails
  }
}

// Initialize the global drive client instance
const drive = google.drive("v3");

// Initialize the MCP server
const server = new Server(
  {
    name: "gdrive",
    version: "0.1.0", // Consider updating version if making significant changes
  },
  {
    capabilities: {
      resources: {}, // Assuming no resource listing/reading via core MCP resource methods needed
      tools: {},     // Tool capabilities are listed via ListTools
    },
  },
);

// Handler for ListResources (Optional - can be empty if tools are preferred)
server.setRequestHandler(ListResourcesRequestSchema, async (request: ListResourcesRequest) => {
  console.log("ListResourcesRequest received:", JSON.stringify(request.params));
  // Basic implementation - consider pagination and filtering if used
  const pageSize = 10;
  const params: drive_v3.Params$Resource$Files$List = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  try {
    const driveClient = googleAuthClient ? google.drive({ version: 'v3', auth: googleAuthClient }) : drive;
    const res = await driveClient.files.list(params);
    const files = res.data.files || [];

    console.log(`ListResources returning ${files.length} files.`);
    return {
      resources: files.map((file: drive_v3.Schema$File) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType ?? undefined,
        name: file.name ?? undefined,
      })),
      nextCursor: res.data.nextPageToken ?? undefined,
    };
  } catch (error: any) {
     console.error("Error in ListResources handler:", error);
     throw new McpError(ErrorCode.InternalError, `Error listing Google Drive files: ${error.message}`);
  }
});

// Helper function to read file content (handles exports for Google Docs etc.)
async function readFileContent(fileId: string, authClientOverride?: OAuth2Client): Promise<{ mimeType: string; content: any }> {
  console.log(`readFileContent called for fileId: ${fileId}`);
  const driveClient = authClientOverride ? google.drive({ version: 'v3', auth: authClientOverride }) : google.drive({ version: 'v3', auth: googleAuthClient ?? undefined });

  if (!driveClient.context._options.auth) {
     console.error("readFileContent: No auth client available (initial client failed or token not set?).");
     throw new Error("Authentication is not configured.");
  }

  // Get file metadata first
  console.log("Fetching file metadata...");
  const fileMetadata = await driveClient.files.get({
    fileId,
    fields: "id, name, mimeType",
  });
  const mimeType = fileMetadata.data.mimeType;
  console.log(`File metadata: ID=${fileMetadata.data.id}, Name=${fileMetadata.data.name}, MimeType=${mimeType}`);

  // Handle Google Workspace file exports
  if (mimeType?.startsWith("application/vnd.google-apps")) {
    let exportMimeType: string;
    switch (mimeType) {
      case "application/vnd.google-apps.document": exportMimeType = "text/markdown"; break;
      case "application/vnd.google-apps.spreadsheet": exportMimeType = "text/csv"; break;
      case "application/vnd.google-apps.presentation": exportMimeType = "text/plain"; break;
      case "application/vnd.google-apps.drawing": exportMimeType = "image/png"; break; // Consider base64 for images?
      default: exportMimeType = "text/plain"; // Fallback export type
    }
    console.log(`Exporting Google Workspace file as ${exportMimeType}...`);
    const exportRes = await driveClient.files.export(
      { fileId, mimeType: exportMimeType },
      // Response type depends on exportMimeType - text for text/*, arraybuffer otherwise?
      // Google API client library might handle this automatically based on mimeType
      { responseType: exportMimeType.startsWith('image/') ? 'arraybuffer' : 'text' } 
    );
    console.log(`Export successful. Returning content with MIME type ${exportMimeType}.`);
    // Handle potential binary content from export (e.g., PNG)
     if (exportMimeType.startsWith('image/')) {
       return { mimeType: exportMimeType, content: Buffer.from(exportRes.data as ArrayBuffer).toString("base64") };
     } else {
       return { mimeType: exportMimeType, content: exportRes.data };
     }
  } else {
    // Handle regular file downloads
    console.log("Downloading regular file content...");
    const downloadRes = await driveClient.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }, // Always get arraybuffer for consistent handling
    );
    const actualMimeType = mimeType || "application/octet-stream"; // Use fetched mimeType or default
    console.log(`Download successful. Actual MIME type: ${actualMimeType}.`);

    const buffer = Buffer.from(downloadRes.data as ArrayBuffer);
    // Decode as text if known text type, otherwise base64
    if (actualMimeType.startsWith("text/") || actualMimeType === "application/json") {
      console.log("Decoding content as UTF-8 text.");
      return {
        mimeType: actualMimeType,
        content: buffer.toString("utf-8"),
      };
    } else {
      console.log("Encoding content as base64.");
      return {
        mimeType: actualMimeType,
        content: buffer.toString("base64"),
      };
    }
  }
}


// Handler for ReadResource (Optional - can be empty if tools are preferred)
server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
  const fileUri = request.params.uri;
  console.log(`ReadResourceRequest received for URI: ${fileUri}`);
  if (!fileUri.startsWith("gdrive:///")) {
     throw new McpError(ErrorCode.InvalidParams, `Invalid URI format: ${fileUri}. Expected gdrive:///fileId`);
  }
  const fileId = fileUri.replace("gdrive:///", "");

  try {
    const result = await readFileContent(fileId); // Use the helper function
    console.log(`ReadResource successful for ${fileUri}. Returning content.`);
    return {
      contents: [
        {
          uri: fileUri,
          mimeType: result.mimeType,
          text: result.content, // Assuming content is always string/base64 string
        },
      ],
    };
  } catch (error: any) {
     console.error(`Error in ReadResource handler for ${fileUri}:`, error);
     // Rethrow as McpError for proper error propagation
     if (error instanceof McpError) throw error;
     throw new McpError(ErrorCode.InternalError, `Error reading file ${fileId}: ${error.message}`);
  }
});

// Handler for ListTools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log("ListToolsRequest received.");
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
              description: "Search query (e.g., 'report Q3', 'name contains budget')",
            },
            token: {
              type: "string",
              description: "Optional OAuth access token to use for this specific search.",
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
              description: "The ID of the file to read (obtainable from gdrive_search)",
            },
            token: {
              type: "string",
              description: "Optional OAuth access token to use for this specific read.",
            },
          },
          required: ["file_id"],
        },
      },
    ],
  };
});

// Handler for CallTool
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  console.log(`CallToolRequest received for tool: ${request.params.name}`);

  // Function to create a temporary client for a specific request using a provided token
  const createTemporaryClient = (accessToken: string): OAuth2Client | null => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET; // Use secret if available
    console.log("Creating temporary OAuth client for request.");
    if (!clientId) {
      console.error("Cannot create temporary client: GOOGLE_CLIENT_ID missing.");
      return null; // Indicate failure
    }
    try {
       const tempClient = new google.auth.OAuth2(clientId, clientSecret); // Use secret here too
       tempClient.setCredentials({ access_token: accessToken });
       console.log("Temporary client created successfully.");
       return tempClient;
    } catch (error) {
        console.error("Error creating temporary OAuth2 client:", error);
        return null; // Indicate failure
    }
  };

  // --- gdrive_search Tool Logic ---
  if (request.params.name === "gdrive_search") {
    console.log("Handling gdrive_search request:", JSON.stringify(request.params.arguments));
    const args = request.params.arguments as { query: string; token?: string };
    const userQuery = args.query;
    const temporaryToken = args.token;

    if (!userQuery) {
        console.error("gdrive_search: Missing required 'query' argument.");
        throw new McpError(ErrorCode.InvalidParams, "Missing required 'query' argument for gdrive_search");
    }

    let authClientOverride: OAuth2Client | undefined = undefined;
    let usingToken = "default client"; // For logging
    if (temporaryToken) {
      console.log("Attempting to use provided temporary token for search.");
      const tempClient = createTemporaryClient(temporaryToken);
      if (tempClient) {
        authClientOverride = tempClient;
        usingToken = "temporary token";
      } else {
        console.error("Failed to create temporary client for search despite token being provided.");
        // Return structured error instead of throwing?
        return {
           content: [{ type: "text", text: "Failed to use provided token: Could not create temporary client (check server logs)." }],
           isError: true,
           errorCode: ErrorCode.InternalError,
        };
      }
    } else {
       console.log("No temporary token provided for search, using default auth client.");
    }

    // Use the correct drive instance (global or temporary)
    // Ensure global client is initialized before using 'drive' directly
    const driveClient = authClientOverride 
        ? google.drive({ version: 'v3', auth: authClientOverride }) 
        : (googleAuthClient ? google.drive({ version: 'v3', auth: googleAuthClient }) : drive); // Fallback might be needed if googleAuthClient init failed
        
    if (!driveClient.context._options.auth && !authClientOverride) {
       console.error("gdrive_search: No auth client available (initial client failed or token not set/failed?).");
       return {
          content: [{ type: "text", text: "Authentication is not configured or token is invalid." }],
          isError: true,
          errorCode: ErrorCode.InternalError, // Or a more specific auth error?
       };
    }
        
    console.log(`Using Google Drive client authenticated with: ${usingToken}`);

    // Construct the search query for the API
    // Simple 'fullText contains' - more complex queries could be allowed
    const escapedQuery = userQuery.replace(/\\/g, "\\").replace(/'/g, "\\'");
    const formattedQuery = `fullText contains '${escapedQuery}' and trashed = false`; // Exclude trashed files
    console.log(`Formatted Google Drive API query: ${formattedQuery}`);

    try {
      console.log("Calling drive.files.list API...");
      const res = await driveClient.files.list({
        q: formattedQuery,
        pageSize: 10, // Keep page size reasonable
        fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)", // Add useful fields
      });
      console.log("Google Drive API response received:", JSON.stringify(res.data));

      const files = res.data.files || [];
      const fileListText = files
        .map((file: any) => 
          `- ${file.name || 'Untitled'} (${file.mimeType || 'unknown'}) - ID: ${file.id} - Modified: ${file.modifiedTime || 'N/A'} - Size: ${file.size || 'N/A'} - Link: ${file.webViewLink || 'N/A'}`
        )
        .join("\n");
        
      const resultText = `Found ${files.length} files matching '${userQuery}':\n${fileListText || '(No files found)'}`;
      console.log(`Returning search results: ${files.length} files found.`);
      return {
        content: [{ type: "text", text: resultText }],
        isError: false,
      };
    } catch (error: any) {
       console.error("Error calling Google Drive API for search:", error);
       // Return structured error
       return {
         content: [{
           type: "text",
           text: `Error searching Google Drive: ${error.message}` + (error.code ? ` (Code: ${error.code})` : ''),
         }],
         isError: true,
         errorCode: ErrorCode.InternalError, // Map Google API errors? 401 -> Auth error?
       };
    }
  }

  // --- gdrive_read_file Tool Logic ---
  if (request.params.name === "gdrive_read_file") {
    console.log("Handling gdrive_read_file request:", JSON.stringify(request.params.arguments));
    const args = request.params.arguments as { file_id: string; token?: string };
    const fileId = args.file_id;
    const temporaryToken = args.token;

    if (!fileId) {
      console.error("gdrive_read_file: Missing required 'file_id' argument.");
      throw new McpError(ErrorCode.InvalidParams, "Missing required 'file_id' argument for gdrive_read_file");
    }

    let authClientOverride: OAuth2Client | undefined = undefined;
    let usingToken = "default client"; // For logging
    if (temporaryToken) {
      console.log("Attempting to use provided temporary token for read.");
      const tempClient = createTemporaryClient(temporaryToken);
      if (tempClient) {
        authClientOverride = tempClient;
        usingToken = "temporary token";
      } else {
         console.error("Failed to create temporary client for read despite token being provided.");
         return {
           content: [{ type: "text", text: "Failed to use provided token: Could not create temporary client (check server logs)." }],
           isError: true,
           errorCode: ErrorCode.InternalError,
         };
      }
    } else {
      console.log("No temporary token provided for read, using default auth client.");
    }
    
    console.log(`Using Google Drive client authenticated with: ${usingToken} for reading file ID: ${fileId}`);

    try {
      // Pass the temporary client override if it exists to the helper
      const result = await readFileContent(fileId, authClientOverride); 
      console.log(`Read successful for file ID: ${fileId}. Returning content.`);
      return {
        content: [
          {
            type: "text", // Adjust type based on result.mimeType? Maybe later.
            mimeType: result.mimeType, // Include mimeType in response
            text: result.content,
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      console.error(`Error calling Google Drive API for read (fileId: ${fileId}):`, error);
      // Return structured error
      return {
        content: [
          {
            type: "text",
            text: `Error reading file ${fileId}: ${error.message}` + (error.code ? ` (Code: ${error.code})` : ''),
          },
        ],
        isError: true,
        errorCode: ErrorCode.InternalError, // Map Google API errors? 404 -> NotFound?
      };
    }
  }

  // --- Fallback for Unknown Tool ---
  console.error(`Unknown tool requested: ${request.params.name}`);
  throw new McpError(ErrorCode.MethodNotFound, `Tool '${request.params.name}' not found`);
});


// Main function to initialize and run the server
async function startServer() {
  console.log("Initializing Google Auth Client...");
  initializeGoogleAuthClient(); // Initialize the client first

  console.log("Setting up token file watcher...");
  watchTokenFile(); // Watch for token updates

  if (!googleAuthClient) {
    console.warn("Initial OAuth client could not be fully initialized (missing GOOGLE_CLIENT_ID or SECRET?). Waiting for tokens via file or tool call, but API calls might fail initially.");
  } else {
    console.log("OAuth client initialized. Server ready to connect.");
  }

  console.log("Connecting server transport...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("MCP server connected and running.");
}

// Start the server
startServer().catch(error => {
  console.error("Failed to start MCP server:", error);
  process.exit(1); // Exit if server fails to start
});