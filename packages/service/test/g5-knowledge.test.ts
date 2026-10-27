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
  const root = mkdtempSync(join(tmpdir(), "rd-g5-"));
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

async function sessionClient(ctx: Awaited<ReturnType<typeof setup>>): Promise<ServiceClient> {
  const bridge = new ServiceClient(await ctx.owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: BRIDGE_SUBJECT, capability_ceiling: ["documents.read"] }));
  const registered = await bridge.call<{ external_session: { external_session_id: string }; credential: { socket_path: string; token: string } }>("externalSessions.register", { host_session_id: "sess-fixture-original" });
  return new ServiceClient(registered.credential);
}

describe("G5 owner knowledge over the service control plane", () => {
  it("owner reads directory, revisions, candidates and checkpoints with boundary validation", async () => {
    const ctx = await setup();
    const directory = await ctx.owner.call<{ workspace_id: string; observed_at: string; items: Array<{ role_id: string; document_key: string; latest_revision: number; content_hash: string | null }> }>("documents.list", { limit: 100 });
    expect(directory.workspace_id).toBe(ctx.workspaceId);
    expect(directory.observed_at).toBeTruthy();
    expect(directory.items.length).toBeGreaterThanOrEqual(1);
    const state = directory.items.find(item => item.role_id === "builder" && item.document_key === "state")!;
    expect(state).toMatchObject({ latest_revision: 0, content_hash: null });

    const revisions = await ctx.owner.call<{ items: unknown[]; next_cursor: string | null }>("documents.listRevisions", { role_id: "builder", document_key: "state" });
    expect(revisions.items).toEqual([]);
    const checkpoints = await ctx.owner.call<{ items: unknown[] }>("checkpoints.list", {});
    expect(Array.isArray(checkpoints.items)).toBe(true);
    const candidates = await ctx.owner.call<{ items: unknown[] }>("documents.listCandidates", { source: "knowledge.import" });
    expect(candidates.items).toEqual([]);

    // Boundary discipline at the transport schema.
    await expect(ctx.owner.call("documents.list", { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("documents.listRevisions", { document_key: "state" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("documents.read", { role_id: "BAD" , document_key: "state" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("checkpoints.get", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ctx.owner.call("documents.read", { role_id: "builder", document_key: "state" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ctx.owner.call("checkpoints.get", { checkpoint_id: "ckpt-nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("faces are isolated: trusted principals never reach the owner knowledge views; session face keeps only its own document tools", async () => {
    const ctx = await setup();
    const session = await sessionClient(ctx);
    const bridge = new ServiceClient(await ctx.owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: "other-observer", capability_ceiling: [] }));
    // Trusted faces have no owner knowledge access at all.
    for (const [operation, input] of [
      ["documents.list", {}],
      ["documents.read", { role_id: "builder", document_key: "state" }],
      ["documents.listRevisions", { role_id: "builder", document_key: "state" }],
      ["documents.listCandidates", {}],
      ["checkpoints.list", {}],
      ["checkpoints.get", { checkpoint_id: "ckpt-x" }],
    ] as const) {
      await expect(bridge.call(operation, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    // The session face keeps its OWN documents.list/read tools; the owner-only
    // G5 views (revisions/candidates/checkpoints) are not session operations.
    for (const [operation, input] of [
      ["documents.listRevisions", { document_key: "state" }],
      ["documents.listCandidates", {}],
      ["checkpoints.list", {}],
      ["checkpoints.get", { checkpoint_id: "ckpt-x" }],
    ] as const) {
      await expect(session.call(operation, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });
});
