import { afterEach, describe, expect, it } from "vitest";
import { startDesktopServer, CONFIRM_ENTRY } from "../src/index.js";
import type { RpcClient } from "../src/index.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

const SESSION = { session: { external_session_id: "ext-demo", host_session_id: "sess_demo-1", connection_subject: "chat", created_at: "2026-10-24T00:00:00Z" }, active_authorization: null };
const ROLE = { role_id: "builder", title: "Builder", initialized: false, requested_capabilities: ["documents.read", "documents.propose"] };

function stubClient(calls: Array<{ operation: string; input: unknown }>, overrides: { alreadyAuthorized?: boolean } = {}): RpcClient {
  const sessions = structuredClone([overrides.alreadyAuthorized ? { ...SESSION, active_authorization: { authorization_id: "auth-x", role_id: "builder", expires_at: "2099-01-01T00:00:00Z", source: { kind: "human-event", event_ref: "e" } } } : SESSION]);
  return {
    async call<T = unknown>(operation: string, input?: unknown): Promise<T> {
      calls.push({ operation, input });
      if (operation === "externalSessions.list") return { external_sessions: sessions } as T;
      if (operation === "roles.list") return { roles: [ROLE] } as T;
      if (operation === "authorizations.submitHumanEvent") return { event_ref: (input as { event_ref: string }).event_ref, entry: (input as { entry: string }).entry } as T;
      throw new Error("unexpected " + operation);
    },
  };
}
const confirmBody = { external_session_id: "ext-demo", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_hours: 1 };

describe("G-min desktop confirmation surface", () => {
  it("serves the confirmation page without ever exposing the credential", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const server = await startDesktopServer({ client: stubClient(calls) }); servers.push(server);
    const page = await fetch(server.url);
    const html = await page.text();
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("gui-confirm");
    expect(html).toContain("sessions.anchor");
    expect(html).not.toContain("token");
    expect(calls).toHaveLength(0);
  });
  it("proxies the read view and role list, and confirms with gui-confirm provenance resolved server-side", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const server = await startDesktopServer({ client: stubClient(calls) }); servers.push(server);
    const sessions = (await (await fetch(`${server.url}api/sessions`)).json()) as { external_sessions: Array<{ session: { external_session_id: string }; active_authorization: unknown }> };
    expect(sessions.external_sessions[0]!.session.external_session_id).toBe("ext-demo");
    const roles = (await (await fetch(`${server.url}api/roles`)).json()) as { roles: Array<{ role_id: string }> };
    expect(roles.roles[0]!.role_id).toBe("builder");
    const confirm = await fetch(`${server.url}api/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirmBody) });
    const result = await confirm.json();
    expect(result).toMatchObject({ ok: true, entry: CONFIRM_ENTRY });
    const submitted = calls.find(item => item.operation === "authorizations.submitHumanEvent")!.input as Record<string, unknown>;
    expect(submitted).toMatchObject({ external_session_id: "ext-demo", host_session_id: "sess_demo-1", connection_subject: "chat", entry: "gui-confirm", actor_id: "owner", inherit: "initialize", role_id: "builder" });
    expect(String(submitted.event_ref)).toMatch(/^gui-[0-9a-f]{24}$/);
  });
  it("rejects double confirmation, unknown sessions and malformed confirmations without calling the write face", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const server = await startDesktopServer({ client: stubClient(calls, { alreadyAuthorized: true }) }); servers.push(server);
    const conflict = await fetch(`${server.url}api/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirmBody) });
    expect(conflict.status).toBe(400);
    const plain = await fetch(`${server.url}api/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...confirmBody, inherit: "latest" }) });
    expect(plain.status).toBe(400);
    const unknown = await fetch(`${server.url}api/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...confirmBody, external_session_id: "ext-other" }) });
    expect(unknown.status).toBe(400);
    const missing = await fetch(`${server.url}api/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...confirmBody, capabilities: [] }) });
    expect(missing.status).toBe(400);
    expect(calls.filter(item => item.operation === "authorizations.submitHumanEvent")).toHaveLength(0);
    const notFound = await fetch(`${server.url}api/nothing`);
    expect(notFound.status).toBe(404);
  });
});
