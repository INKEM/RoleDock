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
  const root = mkdtempSync(join(tmpdir(), "rd-g4-"));
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
  event_ref: "gui-g4test",
  actor_id: "owner",
  role_id: "builder",
  capabilities: ["documents.read"],
  inherit: "initialize" as const,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  entry: "gui-confirm" as const,
  recorded_at: new Date().toISOString(),
};

/** Register, confirm, advance and anchor one conversation; returns its ids. */
async function anchoredConversation(ctx: Awaited<ReturnType<typeof setup>>): Promise<{ externalId: string; authorizationId: string; session: ServiceClient }> {
  const bridge = await bridgeClient(ctx.owner, ["documents.read"]);
  const registered = await bridge.call<{ external_session: { external_session_id: string }; credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: "sess-fixture-original" });
  await ctx.owner.call("authorizations.submitHumanEvent", { ...EVENT, external_session_id: registered.external_session.external_session_id });
  ctx.adapter.seedHumanAuthorization({ workspace_id: ctx.workspaceId, host_session_id: EVENT.host_session_id, connection_subject: EVENT.connection_subject, event_ref: EVENT.event_ref, actor_id: EVENT.actor_id, role_id: EVENT.role_id, capabilities: [...EVENT.capabilities], inherit: EVENT.inherit, expires_at: EVENT.expires_at });
  const auth = await bridge.call<{ authorization_id: string }>("authorizations.recordHuman", { external_session_id: registered.external_session.external_session_id, event_ref: EVENT.event_ref });
  const session = new ServiceClient(registered.credential);
  const anchor = await session.call<{ attempt: { state: string } }>("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: "g4-service" });
  expect(anchor.attempt.state).toBe("active");
  return { externalId: registered.external_session.external_session_id, authorizationId: auth.authorization_id, session };
}

describe("G4 owner observability over the service control plane", () => {
  it("owner reads bindings/attempts/loads with observed_at; projections validate at the transport boundary", async () => {
    const ctx = await setup();
    const { externalId, authorizationId } = await anchoredConversation(ctx);
    for (const [operation, schemaItem] of [["sessions.listBindings", "session-bindings"], ["sessions.listAttempts", "anchor-attempts"], ["sessions.listLoads", "anchor-loads"]] as const) {
      const page = await ctx.owner.call<{ workspace_id: string; observed_at: string; items: unknown[]; next_cursor: string | null }>(operation, {});
      expect(page.workspace_id).toBe(ctx.workspaceId);
      expect(page.observed_at).toBeTruthy();
      expect(Array.isArray(page.items)).toBe(true);
      expect((page.items as unknown[]).length).toBeGreaterThanOrEqual(1);
      void schemaItem;
    }
    const bindings = await ctx.owner.call<{ items: Array<{ external_session_id: string; generation: number; state: string; effective_state: string; authorization: { authorization_id: string } | null }> }>("sessions.listBindings", { external_session_id: externalId });
    expect(bindings.items).toHaveLength(1);
    expect(bindings.items[0]).toMatchObject({ generation: 1, state: "active", effective_state: "active", authorization: { authorization_id: authorizationId } });
    const attempts = await ctx.owner.call<{ items: Array<{ state: string; confirmation: { load_version: number } | null; error: unknown }> }>("sessions.listAttempts", { external_session_id: externalId });
    expect(attempts.items[0]).toMatchObject({ state: "active", confirmation: { load_version: 1 } });
    const loads = await ctx.owner.call<{ items: Array<{ load_version: number | null; confirmed_at: string | null }> }>("sessions.listLoads", {});
    expect(loads.items[0]).toMatchObject({ load_version: 1 });

    // Contract pagination discipline at the boundary.
    await expect(ctx.owner.call("sessions.listBindings", { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("sessions.listAttempts", { limit: 201 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("sessions.listLoads", { cursor: 42 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("sessions.listBindings", { external_session_id: "BAD_ID" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("revokePreview is owner-only, read-only, and the revoke is the separate write", async () => {
    const ctx = await setup();
    const { externalId, authorizationId, session } = await anchoredConversation(ctx);
    const preview = await ctx.owner.call<{ authorization: { authorization_id: string; revoked_at: string | null }; bindings: unknown[]; requests: unknown[] }>("authorizations.revokePreview", { authorization_id: authorizationId });
    expect(preview.authorization).toMatchObject({ authorization_id: authorizationId, revoked_at: null });
    expect(preview.bindings).toHaveLength(1);
    expect(preview.requests).toHaveLength(0);
    // Preview left everything live; the session still works.
    expect(await session.call<{ binding: { state: string } }>("sessions.binding", {})).toMatchObject({ binding: { state: "active" } });
    await expect(ctx.owner.call("authorizations.revokePreview", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("authorizations.revokePreview", { authorization_id: "auth-missing" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await ctx.owner.call("authorizations.revoke", { authorization_id: authorizationId });
    const after = await ctx.owner.call<{ items: Array<{ state: string; effective_state: string }> }>("sessions.listBindings", { external_session_id: externalId });
    expect(after.items[0]).toMatchObject({ state: "revoked", effective_state: "revoked" });
    const postPreview = await ctx.owner.call<{ bindings: unknown[] }>("authorizations.revokePreview", { authorization_id: authorizationId });
    expect(postPreview.bindings).toHaveLength(0);
  });

  it("faces are isolated: session and trusted principals cannot read the G4 owner views", async () => {
    const ctx = await setup();
    const { session } = await anchoredConversation(ctx);
    const bridge = await bridgeClient(ctx.owner, ["documents.read"]);
    for (const operation of ["sessions.listBindings", "sessions.listAttempts", "sessions.listLoads", "authorizations.revokePreview"]) {
      await expect(session.call(operation, operation === "authorizations.revokePreview" ? { authorization_id: "auth-x" } : {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(bridge.call(operation, operation === "authorizations.revokePreview" ? { authorization_id: "auth-x" } : {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });
});
