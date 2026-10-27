import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, writeFileSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import type { ServiceCredential } from "@roledock/service";

/**
 * G3 (ADR-0014 §9.2): the registered external session's MCP credential is
 * handed to the session's tool launcher through a 0600 env file the user
 * points ROLEDOCK_CREDENTIAL_FILE at. Same trust tier and file discipline
 * as the service's owner-connection file: owned regular file, O_NOFOLLOW,
 * atomic rename, never readable wider than the user.
 */
export function mcpSessionEnvPath(workspaceDir: string): string {
  return join(workspaceDir, ".roledock", "mcp-session.env");
}

export function writeMcpSessionEnvFile(workspaceDir: string, credential: ServiceCredential): string {
  const target = mcpSessionEnvPath(workspaceDir);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const body = `ROLEDOCK_SERVICE_SOCKET=${credential.socket_path}\nROLEDOCK_SESSION_TOKEN=${credential.token}\n`;
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(descriptor, 0o600); writeFileSync(descriptor, body); } finally { closeSync(descriptor); }
  renameSync(temp, target);
  return target;
}
