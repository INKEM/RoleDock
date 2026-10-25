import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { RoleDockError } from "@roledock/protocol";
import type { ZCodeToolCaller } from "./index.js";

/** Own only this connector process group; never touch an existing desktop. */
class ConnectorTransport implements Transport {
  #child: ChildProcessWithoutNullStreams | undefined;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  constructor(readonly command: string, readonly args: string[], readonly cwd: string) {}
  async start(): Promise<void> {
    const child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.#child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      if (Buffer.byteLength(line) > 1024 * 1024) { this.onerror?.(new Error("Connector response exceeded 1 MiB.")); void this.close(); return; }
      try { this.onmessage?.(JSON.parse(line) as JSONRPCMessage); } catch { this.onerror?.(new Error("Invalid connector JSON response.")); }
    });
    // Never relay connector stderr: account/bootstrap errors can contain credentials.
    child.stderr.resume();
    child.on("error", () => this.onerror?.(new Error("ZCode connector process failed.")));
    child.on("exit", () => { lines.close(); this.onclose?.(); });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#child?.stdin.writable) throw new Error("ZCode connector is disconnected.");
    await new Promise<void>((resolve,reject) => this.#child!.stdin.write(JSON.stringify(message)+"\n", error => error ? reject(error) : resolve()));
  }
  async close(): Promise<void> {
    const child = this.#child; this.#child = undefined;
    if (!child?.pid) return;
    try { if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* Already gone. */ }
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { try { if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already gone. */ } resolve(); }, 1000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
/** Explicit trusted connector command. This module never reads account files. */
export async function connectZCodeConnector(options: { command: string; args: string[]; cwd: string }): Promise<ZCodeToolCaller & { disconnect(): Promise<void>; server: { name: string; version: string } | undefined; tools: ReadonlySet<string> }> {
  const client = new Client({ name: "roledock-zcode-diagnostics", version: "0.1.0-alpha.0" });
  const transport = new ConnectorTransport(options.command, options.args, options.cwd);
  try { await client.connect(transport); } catch { await transport.close(); throw new RoleDockError("NOT_IMPLEMENTED", "Cannot connect to the configured ZCode MCP bridge."); }
  // docs/zcode-connector-tools.md §2: the listed tool names are the connector's
  // declared capability surface; adapters gate each tool on this set. A connector
  // that cannot list tools (or stalls) degrades to an empty set, which refuses
  // every gated tool — never a silent assumption of support.
  let tools: ReadonlySet<string> = new Set();
  try {
    const listing = await client.listTools({}, { timeout: 5000 });
    tools = new Set((listing.tools ?? []).map(item => item.name));
  } catch { /* Discovery stays empty; adapters must then refuse every gated tool. */ }
  return {
    tools,
    server: client.getServerVersion(),
    async call(name, input) {
      const result = await client.callTool({ name, arguments: input });
      if (result.isError) {
        const text = Array.isArray(result.content) && result.content[0]?.type === "text" && typeof result.content[0].text === "string" ? result.content[0].text : "connector reported an error without text";
        throw new RoleDockError("INTERNAL", "ZCode connector rejected the operation.", { details: { uncertain: true, connector_error: text.slice(0, 500) } });
      }
      if (!Array.isArray(result.content)) throw new RoleDockError("VALIDATION_FAILED", "No connector response content.");
      const content = result.content as { type: string; text?: string }[];
      if (content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") throw new RoleDockError("VALIDATION_FAILED", "Unexpected connector response shape.");
      try { return JSON.parse(content[0].text) as unknown; } catch { throw new RoleDockError("INTERNAL", "Connector reply was malformed or truncated.", { details: { uncertain: true } }); }
    },
    // Disconnecting owned transport processes is not closeSession/cancel evidence.
    async disconnect() { await client.close(); await transport.close(); },
  };
}
