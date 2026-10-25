import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WorkspaceService, ServiceClient } from "@roledock/service";
import type { ServiceCredential } from "@roledock/service";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import type { ExternalSession, RoleAuthorization } from "@roledock/protocol";

describe("official MCP SDK stdio and shared service", () => {
  it("two real MCP subprocesses use their issued session identity, consume authorizations, and cannot sign grants or impersonate another chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "rd-mcp-")), adapter = new MockHarnessAdapter();
    const service = await WorkspaceService.start({ root, adapter, socketPath: join(root, "service.sock") });
    const clients: Client[] = [];
    try {
      const owner = new ServiceClient(service.ownerCredential);
      await owner.call("roles.install", { source_path: resolve("examples/demo-team") });
      for (const role_id of ["builder", "reviewer"]) await owner.call("policy.grant", { role_id, capability: "documents.read" });
      const credentials: ServiceCredential[] = [], grants: RoleAuthorization[] = [];
      for (const [index, role] of ["builder", "reviewer"].entries()) {
        const host = `chat-${index}`; adapter.seedExternalSession(host, host);
        const trust = await owner.call<ServiceCredential>("connections.trust", { subject: host, capability_ceiling: ["documents.read"] });
        const enrolled = await new ServiceClient(trust).call<{ external_session: ExternalSession; credential: ServiceCredential }>("externalSessions.register", { host_session_id: host });
        credentials.push(enrolled.credential);
        adapter.seedHumanAuthorization({ workspace_id: service.workspaceId, host_session_id: host, connection_subject: host, event_ref: `event-${host}`, actor_id: "user", role_id: role, capabilities: ["documents.read"], inherit: "initialize", expires_at: new Date(Date.now() + 100000).toISOString() });
        grants.push(await new ServiceClient(trust).call<RoleAuthorization>("authorizations.recordHuman", { external_session_id: enrolled.external_session.external_session_id, event_ref: `event-${host}` }));
        const client = new Client({ name: `test-client-${index}`, version: "1.0.0" }); clients.push(client);
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("packages/mcp/dist/bin.js")], env: { ROLEDOCK_SERVICE_SOCKET: enrolled.credential.socket_path, ROLEDOCK_SESSION_TOKEN: enrolled.credential.token }, stderr: "pipe" }));
      }
      const [a, b] = clients;
      const tools = await a!.listTools();
      expect(tools.tools.map(item => item.name)).toContain("sessions.anchor"); expect(tools.tools).toHaveLength(14);
      expect(tools.tools.map(item => item.name)).not.toContain("authorizations.record"); expect(tools.tools.every(item => !Object.keys(item.inputSchema.properties ?? {}).includes("session_id"))).toBe(true);
      const available = await a!.callTool({ name: "authorizations.get", arguments: {} }); expect(JSON.stringify(available)).toContain(grants[0]!.authorization_id); expect(JSON.stringify(available)).not.toContain(grants[1]!.authorization_id);
      const cross = await b!.callTool({ name: "sessions.anchor", arguments: { authorization_id: grants[0]!.authorization_id, idempotency_key: "cross" } }); expect(cross.isError).toBe(true); expect(JSON.stringify(cross)).toContain("PERMISSION_DENIED");
      const signed = await a!.callTool({ name: "authorizations.record", arguments: {} }); expect(signed.isError).toBe(true);
      const impersonation = await a!.callTool({ name: "sessions.anchor", arguments: { authorization_id: grants[0]!.authorization_id, idempotency_key: "fake", session_id: "another-chat" } }); expect(impersonation.isError).toBe(true); expect(JSON.stringify(impersonation)).toContain("VALIDATION_FAILED");
      const results = await Promise.all(clients.map((client, index) => client.callTool({ name: "sessions.anchor", arguments: { authorization_id: grants[index]!.authorization_id, idempotency_key: "anchor" } })));
      expect(results.every(item => !item.isError)).toBe(true); expect(JSON.stringify(results)).toContain('active');
      const retry = await a!.callTool({ name: "sessions.anchor", arguments: { authorization_id: grants[0]!.authorization_id, idempotency_key: "anchor" } }); expect(retry).toEqual(results[0]);
      expect(adapter.peekExternal("chat-0").loads).toHaveLength(1); expect(adapter.peekExternal("chat-1").loads).toHaveLength(1);
      await owner.call("authorizations.revoke", { authorization_id: grants[0]!.authorization_id });
      const rejected = await a!.callTool({ name: "documents.list", arguments: {} }); expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).toContain("PERMISSION_DENIED");
    } finally { await Promise.allSettled(clients.map(client => client.close())); await service.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
