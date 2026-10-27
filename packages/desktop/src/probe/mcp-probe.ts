import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpProbeResult {
  toolCount: number;
  toolNames: string[];
  authorizationsGetOk: boolean;
  detail: string;
}

/**
 * Verifies the session-MCP subprocess leg: the probe spawns the same MCP
 * stdio bundle a role session uses, with a credential issued through the
 * real owner → trusted → session chain, and performs the MCP handshake
 * (initialize → tools/list → one read-only call). No model task is sent.
 */
export async function probeMcpSubprocess(options: { nodePath: string; bundlePath: string; socketPath: string; sessionToken: string; log?: (event: string, detail?: string) => void }): Promise<McpProbeResult> {
  const log = options.log ?? (() => undefined);
  const transport = new StdioClientTransport({
    command: options.nodePath,
    args: [options.bundlePath],
    env: { ROLEDOCK_SERVICE_SOCKET: options.socketPath, ROLEDOCK_SESSION_TOKEN: options.sessionToken },
    stderr: "pipe",
  });
  const client = new Client({ name: "roledock-desktop-probe", version: "0.1.0-alpha.0" }, { capabilities: {} });
  try {
    log("mcp-spawning", options.bundlePath);
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools(undefined, { timeout: 10000 });
    const names = tools.tools.map(tool => tool.name);
    const call = await client.callTool({ name: "authorizations.get", arguments: {} }, undefined, { timeout: 10000 });
    const payload = JSON.parse((call.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "{}") as { ok?: boolean };
    log("mcp-handshake-ok", `tools=${names.length}`);
    return {
      toolCount: names.length,
      toolNames: names,
      authorizationsGetOk: payload.ok === true,
      detail: `initialize+listTools OK (${names.length} tools); authorizations.get ok=${payload.ok === true}`,
    };
  } finally {
    await client.close().catch(() => undefined);
    transport.close();
  }
}
