#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ServiceClient } from "@roledock/service";
import { createSessionMcpServer } from "./index.js";

const socketPath = process.env.ROLEDOCK_SERVICE_SOCKET;
const token = process.env.ROLEDOCK_SESSION_TOKEN;
if (!socketPath || !token) {
  console.error("RoleDock MCP requires a trusted controller-issued ROLEDOCK_SERVICE_SOCKET and ROLEDOCK_SESSION_TOKEN; MCP cannot infer current chat identity or human authorization."); process.exitCode = 2;
} else {
  try {
    const client = new ServiceClient({ socket_path: socketPath, token });
    const server = createSessionMcpServer(client);
    await server.connect(new StdioServerTransport());
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
