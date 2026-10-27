#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ServiceClient } from "@roledock/service";
import type { ServiceCredential } from "@roledock/service";
import { createSessionMcpServer } from "./index.js";

/**
 * Credential sources, in priority order:
 * 1. ROLEDOCK_SERVICE_SOCKET + ROLEDOCK_SESSION_TOKEN (controller-issued env).
 * 2. ROLEDOCK_CREDENTIAL_FILE pointing at the desktop-registered session env
 *    file (ADR-0014 §9.2): owned regular file, 0600, `KEY=value` lines.
 * The file is re-read on every MCP start, so a desktop re-registration takes
 * effect for sessions launched afterwards without any config change.
 * MCP cannot infer current chat identity or human authorization by itself.
 */
function credentialFromEnvFile(path: string): ServiceCredential {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Session credential file must be an owned regular file.");
  if ((stat.mode & 0o077) !== 0) throw new Error("Session credential file must not be group/world readable (expected 0600).");
  let socketPath: string | undefined;
  let token: string | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^(ROLEDOCK_SERVICE_SOCKET|ROLEDOCK_SESSION_TOKEN)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === "ROLEDOCK_SERVICE_SOCKET") socketPath = match[2];
    else token = match[2];
  }
  if (!socketPath || !token) throw new Error("Session credential file lacks ROLEDOCK_SERVICE_SOCKET or ROLEDOCK_SESSION_TOKEN.");
  return { socket_path: socketPath, token };
}

let credential: ServiceCredential | undefined;
if (process.env.ROLEDOCK_SERVICE_SOCKET && process.env.ROLEDOCK_SESSION_TOKEN) {
  credential = { socket_path: process.env.ROLEDOCK_SERVICE_SOCKET, token: process.env.ROLEDOCK_SESSION_TOKEN };
} else if (process.env.ROLEDOCK_CREDENTIAL_FILE) {
  try { credential = credentialFromEnvFile(process.env.ROLEDOCK_CREDENTIAL_FILE); }
  catch (error) { console.error(`RoleDock session credential file is unusable: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
if (!credential) {
  console.error("RoleDock MCP requires a trusted controller-issued ROLEDOCK_SERVICE_SOCKET + ROLEDOCK_SESSION_TOKEN, or ROLEDOCK_CREDENTIAL_FILE pointing at the desktop-registered session credential file.");
  process.exitCode = 2;
} else {
  try {
    const client = new ServiceClient(credential);
    const server = createSessionMcpServer(client);
    await server.connect(new StdioServerTransport());
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
