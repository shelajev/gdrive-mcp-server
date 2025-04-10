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

// Variable to hold the current OAuth token
let currentAuthToken: string | null = null;
// Global variable to hold the configured OAuth client
let googleAuthClient: OAuth2Client | null = null; // Use OAuth2Client type consistently

// Function to initialize the client (call this once at startup using env vars as defaults)
function initializeGoogleAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;


  if (!clientId) {
    console.warn("GOOGLE_CLIENT_ID environment variable not set. Cannot initialize OAuth client properly. API calls may fail.");
    // Proceeding without client init, relying on token tool call, but it will likely fail 401
    return;
  }

  // Initialize the OAuth2 client with credentials - only clientId is needed now
  googleAuthClient = new google.auth.OAuth2(
    clientId,
    undefined, // No client secret needed
    undefined // No redirect URI needed
  );

  // Set this client globally for googleapis to use
  google.options({ auth: googleAuthClient });
  console.log("Google OAuth client initialized with Client ID.");
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
    console.log(`Tokens set on the initialized OAuth client. Refresh token was ${refreshToken ? 'provided' : 'not provided'}.`);
  } catch (error) {
    console.error("Error setting credentials on OAuth client:", error);
    // Re-throw or handle as appropriate, might indicate an issue with the tokens themselves
    throw new Error(`Failed to set tokens on OAuth client: ${error instanceof Error ? error.message : String(error)}`);
  }
  // No need to call google.options again, it uses the client instance set at initialization
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

async function readFileContent(fileId: string) {
  // First get file metadata to check mime type
  const file = await drive.files.get({
    fileId,
    fields: "mimeType",
  });

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

    const res = await drive.files.export(
      { fileId, mimeType: exportMimeType },
      { responseType: "text" },
    );

    return {
      mimeType: exportMimeType,
      content: res.data,
    };
  }

  // For regular files download content
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
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
        description: "Search for files specifically in your Google Drive account (don't use exa nor brave to search for files)",
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
  if (request.params.name === "gdrive_search") {
    const userQuery = request.params.arguments?.query as string;
    const escapedQuery = userQuery.replace(/\\/g, "\\").replace(/'/g, "\'");
    const formattedQuery = `fullText contains '${escapedQuery}'`;
    
    const res = await drive.files.list({
      q: formattedQuery,
      pageSize: 10,
      fields: "files(id, name, mimeType, modifiedTime, size)",
    });
    
    const fileList = res.data.files
      ?.map((file: any) => `${file.name} (${file.mimeType}) - ID: ${file.id}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Found ${res.data.files?.length ?? 0} files:\n${fileList}`,
        },
      ],
      isError: false,
    };
  } else if (request.params.name === "gdrive_read_file") {
    const fileId = request.params.arguments?.file_id as string;
    if (!fileId) {
      throw new McpError(ErrorCode.InvalidParams, "File ID is required");
    }

    try {
      const result = await readFileContent(fileId);
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
  throw new Error("Tool not found");
});

async function loadCredentialsAndRunServer() {
  initializeGoogleAuthClient(); // Initialize the client first using env vars (if available) as a default

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
