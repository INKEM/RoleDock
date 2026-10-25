import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator } from "@roledock/core";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import type { ExternalMaterialLoad } from "@roledock/core";
import type { ExternalSession, RoleAuthorization, SessionBinding } from "@roledock/protocol";
import { WorkspaceService, ServiceClient } from "../src/index.js";
import type { ServiceCredential } from "../src/index.js";

const CAPS = ["documents.read", "documents.publish", "documents.propose", "requests.create", "requests.execute", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"];
const services: { service: WorkspaceService; root: string }[] = [];
afterEach(async () => { for (const item of services.splice(0)) { await item.service.close(); rmSync(item.root, { recursive: true, force: true }); } });
async function setup(adapter = new MockHarnessAdapter()) {
  const root = mkdtempSync(join(tmpdir(), "rd-svc-")), socketPath = join(root, "service.sock");
  const service = await WorkspaceService.start({ root, adapter, socketPath, pollMs: 25 }); services.push({ service, root });
  const owner = new ServiceClient(service.ownerCredential);
  await owner.call("roles.install", { source_path: resolve("examples/demo-team") });
  for (const role of ["builder", "reviewer"]) for (const capability of CAPS) await owner.call("policy.grant", { role_id: role, capability });
  return { root, socketPath, adapter, service, owner };
}
async function register(context: Awaited<ReturnType<typeof setup>>, host: string, role: string) {
  context.adapter.seedExternalSession(host, host, ["PRIVATE-CHAT"]);
  const credential = await context.owner.call<ServiceCredential>("connections.trust", { subject: host, capability_ceiling: CAPS });
  const trusted = new ServiceClient(credential);
  const enrolled = await trusted.call<{ external_session: ExternalSession; credential: ServiceCredential }>("externalSessions.register", { host_session_id: host });
  context.adapter.seedHumanAuthorization({ workspace_id: context.service.workspaceId, host_session_id: host, connection_subject: host, event_ref: `event-${host}`, actor_id: "person", role_id: role, capabilities: CAPS, inherit: "initialize", expires_at: new Date(Date.now() + 600000).toISOString() });
  const auth = await trusted.call<RoleAuthorization>("authorizations.recordHuman", { external_session_id: enrolled.external_session.external_session_id, event_ref: `event-${host}` });
  const agent = new ServiceClient(enrolled.credential);
  return { trusted, agent, auth, external: enrolled.external_session, credential: enrolled.credential };
}
async function waitFor<T>(read: () => Promise<T>, accept: (result: T) => boolean): Promise<T> {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const result = await read(); if (accept(result)) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Timed out waiting for actual service state.");
}

describe("shared writer and authenticated Unix socket connections", () => {
  it("owner/trusted/two Agent clients share one writer while each has a separate authority boundary", async () => {
    const context = await setup(), a = await register(context, "chat-a", "builder"), b = await register(context, "chat-b", "reviewer");
    expect(statSync(context.socketPath).mode & 0o777).toBe(0o600);
    expect(() => Coordinator.open({ root: context.root })).toThrowError(/already holds/);
    const observer = new ServiceClient({ socket_path: context.socketPath, token: "not-a-token" });
    await expect(observer.call("roles.list")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    for (const operation of ["roles.install", "policy.grant", "connections.trust", "authorizations.recordOwner", "authorizations.recordHuman", "externalSessions.register", "sessions.open", "knowledge.export", "testingOpenPrimarySession"]) await expect(a.agent.call(operation, {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(a.trusted.call("policy.grant", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(a.trusted.call("authorizations.recordHuman", { external_session_id: b.external.external_session_id, event_ref: "event-chat-b" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(a.trusted.call("externalSessions.register", { host_session_id: "chat-a", connection_subject: "chat-b" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const grants = await a.agent.call<{ authorizations: RoleAuthorization[] }>("authorizations.get"); expect(grants.authorizations.map(item => item.authorization_id)).toEqual([a.auth.authorization_id]);
    await expect(b.agent.call("sessions.anchor", { authorization_id: a.auth.authorization_id, idempotency_key: "stolen" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const results = await Promise.all([a.agent.call<{ binding: SessionBinding }>("sessions.anchor", { authorization_id: a.auth.authorization_id, idempotency_key: "a" }), b.agent.call<{ binding: SessionBinding }>("sessions.anchor", { authorization_id: b.auth.authorization_id, idempotency_key: "b" })]);
    expect(results.map(item => item.binding.generation)).toEqual([1, 1]);
    await expect(a.agent.call("documents.publish", { session_id: results[1]!.binding.session_id, document_key: "state", body: "spoof", expected_revision: 0, expected_generation: 1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await a.agent.call("documents.publish", { document_key: "state", body: "SERVICE-BOUND-BODY", expected_revision: 0, expected_generation: 1 });
    const read = await b.agent.call<{ body: string }>("documents.read", { target_role_id: "builder", document_key: "state" }); expect(read.body).toBe("SERVICE-BOUND-BODY");
    expect(context.adapter.peekExternal("chat-a").history).toEqual(["PRIVATE-CHAT"]);
    await context.owner.call("authorizations.revoke", { authorization_id: a.auth.authorization_id });
    expect((await a.agent.call<{ binding: SessionBinding }>("sessions.binding")).binding.state).toBe("revoked");
    await expect(a.agent.call("documents.list")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("the service consumes outbox, commits the actual fixture answer and never injects it into the original conversations", async () => {
    const context = await setup(), a = await register(context, "chat-a", "builder"), b = await register(context, "chat-b", "reviewer");
    for (const actor of [a, b]) await actor.agent.call("sessions.anchor", { authorization_id: actor.auth.authorization_id, idempotency_key: "anchor" });
    const created = await a.agent.call<{ request_id: string }>("requests.create", { target_role_id: "reviewer", question: "Consultation only", idempotency_key: "consultation", read_exception_rationale: "Target has no documents yet" });
    const completed = await waitFor(() => a.agent.call<{ state: string; result?: { artifact_id: string } }>("requests.get", { request_id: created.request_id }), item => item.state === "completed");
    const artifact = await a.agent.call<{ body: string; content_hash: string }>("artifacts.read", { artifact_id: completed.result!.artifact_id });
    expect(artifact.body).toBe("ack:1"); expect(artifact.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(context.adapter.peekExternal("chat-a").history).toEqual(["PRIVATE-CHAT"]); expect(context.adapter.peekExternal("chat-b").history).toEqual(["PRIVATE-CHAT"]);
    const events = await context.owner.call<{ events: { state: string }[] }>("admin.events"); expect(events.events.some(item => item.state === "done")).toBe(true);
  });
  it("a pending external load cannot become active after session release", async () => {
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
    class Held extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad) { const ack = await super.loadExternalMaterials(input); entered(); await held; return ack; } }
    const context = await setup(new Held()), a = await register(context, "chat", "builder");
    const pending = a.agent.call<{ attempt: { state: string }; binding: null }>("sessions.anchor", { authorization_id: a.auth.authorization_id, idempotency_key: "pending" }); await ready;
    await a.agent.call("sessions.release"); finish();
    const result = await pending; expect(result.attempt.state).toBe("failed"); expect(result.binding).toBeNull();
  });
  it("expired target grants are withdrawn and cancelled while an external turn is still awaiting acknowledgment", async () => {
    let enter!: () => void, finish!: () => void, cancellations = 0;
    const ready = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
    class Held extends MockHarnessAdapter {
      override async runTurn(handle: Parameters<MockHarnessAdapter["runTurn"]>[0], input: Parameters<MockHarnessAdapter["runTurn"]>[1]) { const ack = await super.runTurn(handle, input); enter(); await held; return ack; }
      override async cancel(handle: Parameters<MockHarnessAdapter["cancel"]>[0]) { cancellations++; await super.cancel(handle); }
    }
    const context = await setup(new Held()), a = await register(context, "initiator", "builder"), b = await register(context, "expiring-target", "reviewer");
    const expiring = await context.owner.call<RoleAuthorization>("authorizations.recordOwner", { external_session_id: b.external.external_session_id, event_ref: "short-expiry", actor_id: "owner", role_id: "reviewer", capabilities: CAPS, inherit: "initialize", expires_at: new Date(Date.now() + 8000).toISOString() });
    await a.agent.call("sessions.anchor", { authorization_id: a.auth.authorization_id, idempotency_key: "a" }); await b.agent.call("sessions.anchor", { authorization_id: expiring.authorization_id, idempotency_key: "b" });
    const request = await a.agent.call<{ request_id: string }>("requests.create", { target_role_id: "reviewer", question: "q", idempotency_key: "expires", read_exception_rationale: "No target documents" });
    try {
      await ready; await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiring.expires_at) - Date.now()) + 300));
      const result = await waitFor(() => a.agent.call<{ state: string }>("requests.get", { request_id: request.request_id }), item => item.state === "failed");
      expect(result.state).toBe("failed"); expect(cancellations).toBeGreaterThan(0);
      expect((await b.agent.call<{ binding: SessionBinding }>("sessions.binding")).binding.state).toBe("expired");
    } finally { finish(); }
  });
  it("restarting the service invalidates old connection tokens while persistent binding can be restored through newly authenticated enrollment", async () => {
    const context = await setup(), actor = await register(context, "chat", "builder");
    const result = await actor.agent.call<{ binding: SessionBinding }>("sessions.anchor", { authorization_id: actor.auth.authorization_id, idempotency_key: "anchor" });
    await context.service.close(); services.splice(services.findIndex(item => item.service === context.service), 1);
    const restarted = await WorkspaceService.start({ root: context.root, adapter: context.adapter, socketPath: context.socketPath }); services.push({ service: restarted, root: context.root });
    await expect(actor.agent.call("sessions.binding")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const owner = new ServiceClient(restarted.ownerCredential), trust = await owner.call<ServiceCredential>("connections.trust", { subject: "chat", capability_ceiling: CAPS });
    const enrolled = await new ServiceClient(trust).call<{ credential: ServiceCredential }>("externalSessions.register", { host_session_id: "chat" });
    expect((await new ServiceClient(enrolled.credential).call<{ binding: SessionBinding }>("sessions.binding")).binding).toEqual(result.binding);
    expect(context.adapter.peekExternal("chat").loads).toHaveLength(1);
  });
});

describe("B2 trusted-entry human event write face (owner only)", () => {
  it("owner submits a verbatim event for a registered session; trusted channel and contract violations are refused", async () => {
    const context = await setup();
    context.adapter.seedExternalSession("chat", "chat");
    const credential = await context.owner.call<ServiceCredential>("connections.trust", { subject: "chat", capability_ceiling: CAPS });
    const trusted = new ServiceClient(credential);
    const enrolled = await trusted.call<{ external_session: ExternalSession }>("externalSessions.register", { host_session_id: "chat" });
    const input = { external_session_id: enrolled.external_session.external_session_id, host_session_id: "chat", connection_subject: "chat", event_ref: "confirm-001", actor_id: "human-user", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_at: new Date(Date.now() + 600000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString() };
    const record = await context.owner.call<{ entry: string; event_ref: string; workspace_id: string }>("authorizations.submitHumanEvent", input);
    expect(record).toMatchObject({ entry: "cli-console", event_ref: "confirm-001" });
    expect((await context.owner.call<{ entry: string }>("authorizations.submitHumanEvent", input)).entry).toBe("cli-console");
    await expect(context.owner.call("authorizations.submitHumanEvent", { ...input, host_session_id: "other" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(context.owner.call("authorizations.submitHumanEvent", { ...input, event_ref: "confirm-002", entry: "chat-message" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(trusted.call("authorizations.submitHumanEvent", input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(new ServiceClient({ socket_path: context.socketPath, token: "nope" }).call("authorizations.submitHumanEvent", input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("G-min owner confirmation surface over the service", () => {
  it("lists sessions with live authorization summaries on the owner face only", async () => {
    const context = await setup();
    context.adapter.seedExternalSession("chat", "chat");
    const credential = await context.owner.call<ServiceCredential>("connections.trust", { subject: "chat", capability_ceiling: CAPS });
    const trusted = new ServiceClient(credential);
    const enrolled = await trusted.call<{ external_session: ExternalSession; credential: ServiceCredential }>("externalSessions.register", { host_session_id: "chat" });
    const listed = await context.owner.call<Array<{ session: { external_session_id: string }; active_authorization: object | null }>>("externalSessions.list", {});
    expect(listed).toHaveLength(1);
    expect(listed[0]!.session.external_session_id).toBe(enrolled.external_session.external_session_id);
    expect(listed[0]!.active_authorization).toBeNull();
    await expect(trusted.call("externalSessions.list", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
