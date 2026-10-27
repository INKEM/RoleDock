import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { WorkspaceService, ServiceClient } from "../src/index.js";

const BRIDGE_SUBJECT = "desktop-event-bridge";

const services: { service: WorkspaceService; root: string }[] = [];
afterEach(async () => { for (const item of services.splice(0)) { await item.service.close(); rmSync(item.root, { recursive: true, force: true }); } });

async function setup(): Promise<{ owner: ServiceClient; root: string; adapter: MockHarnessAdapter; workspaceId: string }> {
  const root = mkdtempSync(join(tmpdir(), "rd-g3-"));
  const adapter = new MockHarnessAdapter();
  adapter.seedExternalSession("sess-fixture-original", BRIDGE_SUBJECT);
  const service = await WorkspaceService.start({ root, adapter, socketPath: join(root, "service.sock"), pollMs: 25 });
  services.push({ service, root });
  const owner = new ServiceClient(service.ownerCredential);
  await owner.call("roles.install", { source_path: resolve("examples/demo-team") });
  await owner.call("policy.grant", { role_id: "builder", capability: "documents.read" });
  const workspaceId = (await owner.call<{ workspace_id: string }>("workspace.info", {})).workspace_id;
  return { owner, root, adapter, workspaceId };
}

async function bridgeClient(owner: ServiceClient, ceiling: string[]): Promise<ServiceClient> {
  const credential = await owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: ceiling });
  return new ServiceClient(credential);
}

const EVENT = {
  host_session_id: "sess-fixture-original",
  connection_subject: BRIDGE_SUBJECT,
  event_ref: "gui-g3test",
  actor_id: "owner",
  role_id: "builder",
  capabilities: ["documents.read"],
  inherit: "initialize" as const,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  entry: "gui-confirm" as const,
  recorded_at: new Date().toISOString(),
};

describe("G3 confirmation chain, pending bridge and discovery over the service control plane", () => {
  it("discover lists host candidates with registration markers (trusted only, read-only)", async () => {
    const { owner } = await setup();
    const bridge = await bridgeClient(owner, ["documents.read"]);
    const before = await bridge.call<{ adapter: string; items: Array<{ host_session_id: string; registered_external_session_id: string | null }> }>("externalSessions.discover", {});
    expect(before.adapter).toBe("mock");
    expect(before.items.map(item => item.host_session_id)).toContain("sess-fixture-original");
    expect(before.items.every(item => item.registered_external_session_id === null)).toBe(true);
    const registered = await bridge.call<{ external_session: { external_session_id: string } }>("externalSessions.register", { host_session_id: "sess-fixture-original" });
    const after = await bridge.call<{ items: Array<{ host_session_id: string; registered_external_session_id: string | null }> }>("externalSessions.discover", {});
    expect(after.items.find(item => item.host_session_id === "sess-fixture-original")?.registered_external_session_id).toBe(registered.external_session.external_session_id);
    await expect(bridge.call("externalSessions.discover", { subject: "x" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("pendingEvents is subject-bound; the bridge advances event→authorization idempotently; anchor activates the chain", async () => {
    const { owner, adapter, workspaceId } = await setup();
    const bridge = await bridgeClient(owner, ["documents.read"]);
    const registered = await bridge.call<{ external_session: { external_session_id: string }; credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: "sess-fixture-original" });
    const externalId = registered.external_session.external_session_id;

    // Owner writes the GUI-confirmed event; nothing is pending-proof yet.
    await owner.call("authorizations.submitHumanEvent", { ...EVENT, external_session_id: externalId });
    // The mock adapter is its own attester (fixture practice): seed the same
    // facts so recordHuman's adapter port finds the event, as the real ZCode
    // adapter would via the wired store source.
    adapter.seedHumanAuthorization({ workspace_id: workspaceId, host_session_id: EVENT.host_session_id, connection_subject: EVENT.connection_subject, event_ref: EVENT.event_ref, actor_id: EVENT.actor_id, role_id: EVENT.role_id, capabilities: [...EVENT.capabilities], inherit: EVENT.inherit, expires_at: EVENT.expires_at });
    const pending = await bridge.call<{ items: Array<{ external_session_id: string; event_ref: string; capabilities: string[] }> }>("authorizations.pendingEvents", {});
    expect(pending.items).toContainEqual(expect.objectContaining({ external_session_id: externalId, event_ref: EVENT.event_ref }));

    // Subject binding: another trusted principal sees none of it.
    const other = new ServiceClient(await owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: "other-observer", capability_ceiling: [] }));
    await expect(other.call<{ items: unknown[] }>("authorizations.pendingEvents", {})).resolves.toMatchObject({ items: [] });

    // Bridge advance: idempotent — the same event_ref returns the same authorization.
    const first = await bridge.call<{ authorization_id: string; source: { kind: string } }>("authorizations.recordHuman", { external_session_id: externalId, event_ref: EVENT.event_ref });
    const second = await bridge.call<{ authorization_id: string }>("authorizations.recordHuman", { external_session_id: externalId, event_ref: EVENT.event_ref });
    expect(first.authorization_id).toBe(second.authorization_id);
    expect(first.source.kind).toBe("human-event");
    await expect(bridge.call<{ items: unknown[] }>("authorizations.pendingEvents", {})).resolves.toMatchObject({ items: [] });

    // Agent side in the original session: explicit anchor over its own credential.
    const session = new ServiceClient(registered.credential);
    const offered = await session.call<{ authorizations: Array<{ authorization_id: string }> }>("authorizations.get", {});
    expect(offered.authorizations.map(auth => auth.authorization_id)).toContain(first.authorization_id);
    const anchor = await session.call<{ attempt: { state: string }; binding: { state: string; generation: number; role_id: string } | null }>("sessions.anchor", { authorization_id: first.authorization_id, idempotency_key: "g3-e2e" });
    expect(anchor.attempt.state).toBe("active");
    expect(anchor.binding).toMatchObject({ state: "active", generation: 1, role_id: "builder" });

    // Owner progress chain: event → authorization → attempt → binding.
    const page = await owner.call<{ workspace_id: string; observed_at: string; items: Array<{ external_session_id: string; events: Array<{ event_ref: string; authorization: { authorization_id: string; revoked_at: string | null } | null }>; anchor_attempt: { state: string; load: { content_hash: string } | null } | null; binding: { generation: number; state: string } | null }>; next_cursor: string | null }>("authorizations.confirmations", {});
    const entry = page.items.find(item => item.external_session_id === externalId)!;
    expect(entry.events).toHaveLength(1);
    expect(entry.events[0]!.authorization).toMatchObject({ authorization_id: first.authorization_id, revoked_at: null });
    expect(entry.anchor_attempt?.state).toBe("active");
    expect(entry.anchor_attempt?.load?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.binding).toMatchObject({ generation: 1, state: "active" });
    expect(page.observed_at).toBeTruthy();

    const filtered = await owner.call<{ items: Array<{ external_session_id: string }> }>("authorizations.confirmations", { external_session_id: externalId });
    expect(filtered.items).toHaveLength(1);
    const empty = await owner.call<{ items: unknown[] }>("authorizations.confirmations", { external_session_id: "ext-not-registered-x" });
    expect(empty.items).toHaveLength(0);
  });

  it("duplicate confirm intent stays one event and one authorization (stable action ID at the store)", async () => {
    const { owner, adapter, workspaceId } = await setup();
    const bridge = await bridgeClient(owner, ["documents.read"]);
    const registered = await bridge.call<{ external_session: { external_session_id: string } }>("externalSessions.register", { host_session_id: "sess-fixture-original" });
    const externalId = registered.external_session.external_session_id;
    const event = { ...EVENT, external_session_id: externalId };
    await owner.call("authorizations.submitHumanEvent", event);
    await owner.call("authorizations.submitHumanEvent", event);
    adapter.seedHumanAuthorization({ workspace_id: workspaceId, host_session_id: EVENT.host_session_id, connection_subject: EVENT.connection_subject, event_ref: EVENT.event_ref, actor_id: EVENT.actor_id, role_id: EVENT.role_id, capabilities: [...EVENT.capabilities], inherit: EVENT.inherit, expires_at: EVENT.expires_at });
    await bridge.call("authorizations.recordHuman", { external_session_id: externalId, event_ref: EVENT.event_ref });
    const page = await owner.call<{ items: Array<{ external_session_id: string; events: unknown[] }> }>("authorizations.confirmations", { external_session_id: externalId });
    expect(page.items[0]!.events).toHaveLength(1);
  });

  it("faces are isolated: session cannot touch bridge/owner projections; owner cannot read pending or discover", async () => {
    const { owner } = await setup();
    const bridge = await bridgeClient(owner, ["documents.read"]);
    const registered = await bridge.call<{ external_session: { external_session_id: string }; credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: "sess-fixture-original" });
    const session = new ServiceClient(registered.credential);
    await expect(session.call("authorizations.pendingEvents", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(session.call("externalSessions.discover", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(session.call("authorizations.confirmations", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(owner.call("authorizations.pendingEvents", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(owner.call("externalSessions.discover", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(bridge.call("authorizations.confirmations", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    // Boundary validation at the transport schema.
    await expect(bridge.call("authorizations.pendingEvents", { subject: "impersonate" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(owner.call("authorizations.confirmations", { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(owner.call("authorizations.confirmations", { limit: 201 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("confirmations pages by the contract cursor", async () => {
    const { owner } = await setup();
    const bridge = await bridgeClient(owner, ["documents.read"]);
    await bridge.call("externalSessions.register", { host_session_id: "sess-fixture-original" });
    const mockService = services[0]!.service;
    void mockService;
    const page1 = await owner.call<{ items: unknown[]; next_cursor: string | null }>("authorizations.confirmations", { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBeNull(); // only one registered session so far
  });
});
