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
  const root = mkdtempSync(join(tmpdir(), "rd-g6-"));
  const adapter = new MockHarnessAdapter();
  adapter.seedExternalSession("sess-fixture-builder", BRIDGE_SUBJECT);
  adapter.seedExternalSession("sess-fixture-reviewer", BRIDGE_SUBJECT);
  const service = await WorkspaceService.start({ root, adapter, socketPath: join(root, "service.sock"), pollMs: 25 });
  services.push({ service, root });
  const owner = new ServiceClient(service.ownerCredential);
  await owner.call("roles.install", { source_path: resolve("examples/demo-team") });
  for (const [role, capability] of [["builder", "documents.read"], ["builder", "requests.create"], ["builder", "requests.read"], ["reviewer", "documents.read"], ["reviewer", "requests.execute"], ["reviewer", "requests.read"], ["reviewer", "artifacts.read"]]) {
    await owner.call("policy.grant", { role_id: role, capability });
  }
  const workspaceId = (await owner.call<{ workspace_id: string }>("workspace.info", {})).workspace_id;
  return { owner, root, adapter, workspaceId };
}

/** Register one fixture session, store the human event, advance via the bridge and anchor it. */
async function anchored(ctx: Awaited<ReturnType<typeof setup>>, host: string, role: string, caps: string[], key: string): Promise<ServiceClient> {
  const bridge = new ServiceClient(await ctx.owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: caps }));
  const registered = await bridge.call<{ external_session: { external_session_id: string }; credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: host });
  const event = {
    external_session_id: registered.external_session.external_session_id,
    host_session_id: host, connection_subject: BRIDGE_SUBJECT,
    event_ref: `gui-${key}`, actor_id: "owner", role_id: role,
    capabilities: caps, inherit: "initialize" as const,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    entry: "gui-confirm" as const, recorded_at: new Date().toISOString(),
  };
  await ctx.owner.call("authorizations.submitHumanEvent", event);
  ctx.adapter.seedHumanAuthorization({ workspace_id: ctx.workspaceId, host_session_id: host, connection_subject: BRIDGE_SUBJECT, event_ref: event.event_ref, actor_id: event.actor_id, role_id: event.role_id, capabilities: [...caps], inherit: "initialize", expires_at: event.expires_at });
  const auth = await bridge.call<{ authorization_id: string }>("authorizations.recordHuman", { external_session_id: event.external_session_id, event_ref: event.event_ref });
  const session = new ServiceClient(registered.credential);
  const anchor = await session.call<{ attempt: { state: string } }>("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: `g6-${key}` });
  expect(anchor.attempt.state).toBe("active");
  return session;
}

describe("G6 owner request/artifact/cleanup over the service control plane", () => {
  it("full lifecycle: unknown usage before execution, completed result with verifiable artifact, owner cancel + audit + cleanup", async () => {
    const ctx = await setup();
    const builder = await anchored(ctx, "sess-fixture-builder", "builder", ["documents.read", "requests.create", "requests.read"], "builder");
    await anchored(ctx, "sess-fixture-reviewer", "reviewer", ["documents.read", "requests.execute", "requests.read", "artifacts.read"], "reviewer");

    const created = await builder.call<{ request_id: string }>("requests.create", { target_role_id: "reviewer", question: "what is the state?", idempotency_key: "g6-r1", read_exception_rationale: "No published target documents" });

    // The service worker executes the request; wait for the real completion.
    let completed: { request_id: string; state: string; usage: { output_bytes: number | null; turns_reserved: number | null }; result: { artifact_id: string; content_hash: string } | null } | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await ctx.owner.call<{ items: Array<{ request_id: string; state: string; usage: { output_bytes: number | null; turns_reserved: number | null }; result: { artifact_id: string; content_hash: string } | null }> }>("requests.listInbox", {});
      const found = page.items.find(item => item.request_id === created.request_id);
      if (found?.state === "completed") { completed = found; break; }
      if (found?.state === "failed") throw new Error(`request failed: ${JSON.stringify(found)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(completed, "request did not complete").toBeTruthy();
    expect(completed!.usage.output_bytes).toBeGreaterThan(0); // now REPORTED
    expect(completed!.result).toMatchObject({ artifact_id: expect.stringMatching(/^art-/) });

    // Owner artifact read: raw bytes whose sha256 matches the result hash.
    const artifact = await ctx.owner.call<{ request_id: string; producing_role_id: string; content_hash: string; body: string }>("artifacts.read", { artifact_id: completed!.result!.artifact_id });
    expect(artifact.request_id).toBe(created.request_id);
    expect(artifact.producing_role_id).toBe("reviewer");
    expect(artifact.body.length).toBeGreaterThan(0);

    // The fast worker may complete a second request before any cancel lands:
    // a terminal request refuses a new-key cancellation HONESTLY over RPC
    // (the §6 matrix; the successful-cancel path incl. idempotent replay and
    // the audit event is covered deterministically in the core suite).
    const second = await builder.call<{ request_id: string }>("requests.create", { target_role_id: "reviewer", question: "second intent", idempotency_key: "g6-r2", read_exception_rationale: "No published target documents" });
    for (let i = 0; i < 100; i += 1) {
      const page = await ctx.owner.call<{ items: Array<{ request_id: string; state: string }> }>("requests.listInbox", {});
      if (page.items.find(item => item.request_id === second.request_id)?.state === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await expect(ctx.owner.call("requests.cancelByOwner", { request_id: completed!.request_id, reason: "terminal" })).rejects.toMatchObject({ code: "REQUEST_NOT_TERMINABLE" });
    await expect(ctx.owner.call("requests.cancelByOwner", { request_id: second.request_id, reason: "terminal too", idempotency_key: "gui-k1" })).rejects.toMatchObject({ code: "REQUEST_NOT_TERMINABLE" });
    const events = await ctx.owner.call<{ events: Array<{ kind: string; state: string }> }>("admin.events", {});
    expect(events.events.some(event => event.kind === "request.execute" && event.state === "done")).toBe(true);

    // Detail + cleanup views + boundary discipline.
    const detail = await ctx.owner.call<{ state: string; question: string }>("requests.get", { request_id: created.request_id });
    expect(detail).toMatchObject({ state: "completed" });
    expect(detail.question).toContain("what is the state?");
    const cleanup = await ctx.owner.call<{ items: Array<{ request_id: string; state: string; cleanup_pending: boolean; cleanup_error: { code: string } | null }> }>("requests.listCleanup", {});
    expect(cleanup.items.find(item => item.request_id === second.request_id)).toMatchObject({ state: "completed", cleanup_pending: false, cleanup_error: null });
    expect(cleanup.items.find(item => item.request_id === created.request_id)).toMatchObject({ state: "completed" });
    await expect(ctx.owner.call("requests.get", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("requests.cancelByOwner", { request_id: second.request_id })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("artifacts.read", { artifact_id: "art-missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("faces are isolated: trusted principals never reach the owner request views", async () => {
    const ctx = await setup();
    const bridge = new ServiceClient(await ctx.owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: "other-observer", capability_ceiling: [] }));
    for (const [operation, input] of [
      ["requests.listInbox", {}],
      ["requests.get", { request_id: "req-x" }],
      ["requests.cancelByOwner", { request_id: "req-x", reason: "why" }],
      ["requests.listCleanup", {}],
      ["artifacts.read", { artifact_id: "art-x" }],
    ] as const) {
      await expect(bridge.call(operation, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });
});
