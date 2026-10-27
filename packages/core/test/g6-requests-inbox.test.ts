import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, WorkspaceAdmin } from "../src/index.js";
import { listSessionInbox, installRolePack, testingOpenPrimarySession } from "../src/testing.js";
import type { OwnerCancelResult, OwnerCleanupPage, OwnerRequestDetail, OwnerRequestInboxPage } from "@roledock/protocol";
import { validate } from "@roledock/protocol";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { coordinatorStore } from "../src/internal-store.js";
import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";
import type { WorkspaceStore } from "../src/store/workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function barrier() {
  let enter!: () => void, finish!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), wait: new Promise<void>(resolve => { finish = resolve; }), enter: () => enter(), finish: () => finish() };
}
function setup(adapter: MockHarnessAdapter = new MockHarnessAdapter()) {
  const root = mkdtempSync(join(tmpdir(), "rd-g6-"));
  roots.push(root);
  const coordinator = Coordinator.open({ root, adapter });
  void installRolePack(coordinatorStore(coordinator), { sourcePath: resolve("examples/demo-team") });
  const store = coordinatorStore(coordinator);
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  const initiator = testingOpenPrimarySession(coordinator, { role_id: "builder" });
  const target = testingOpenPrimarySession(coordinator, { role_id: "reviewer" });
  grantFixtureCapabilities(store);
  return { coordinator, admin, store, root, adapter, initiator, target };
}

async function createRequest(ctx: ReturnType<typeof setup>, key: string, question = "consult"): Promise<{ request_id: string }> {
  return await ctx.coordinator.createRequest({ session_id: ctx.initiator.session_id, target_role_id: "reviewer", question, idempotency_key: key, read_exception_rationale: "No published target documents" }) as { request_id: string };
}

describe("G6 owner request views and management cancellation (Mock)", () => {
  it("§6 matrix: accepted/queued/awaiting_input cancel; running refuses without adapter capability; terminal refuses with a new key", async () => {
    const ctx = setup();
    const request = await createRequest(ctx, "r1");
    const cancel1 = ctx.admin.cancelRequestByOwner({ request_id: request.request_id, reason: "owner decision", idempotency_key: "gui-k1" }, false) as OwnerCancelResult;
    expect(validate("owner-cancel-result", cancel1).ok).toBe(true);
    expect(cancel1).toMatchObject({ request_id: request.request_id, state: "cancelled", idempotent_replay: false });
    expect(ctx.store.prepare("SELECT cleanup_pending, state FROM requests WHERE request_id = ?").get(request.request_id)).toMatchObject({ cleanup_pending: 1, state: "cancelled" });
    // Independent audit trail exists (admin.events metadata view).
    expect(ctx.store.prepare("SELECT kind, state FROM outbox_events WHERE kind = 'owner.request.cancel'").get()).toMatchObject({ kind: "owner.request.cancel", state: "done" });

    // Same key replay: first result, no second state change.
    const replay = ctx.admin.cancelRequestByOwner({ request_id: request.request_id, reason: "owner decision", idempotency_key: "gui-k1" }, false) as OwnerCancelResult;
    expect(replay).toMatchObject({ state: "cancelled", idempotent_replay: true });
    // Same key, different input: conflict.
    expect(() => ctx.admin.cancelRequestByOwner({ request_id: request.request_id, reason: "changed reason", idempotency_key: "gui-k1" }, false)).toThrowError(/IDEMPOTENCY_CONFLICT|cancel key has different input/);
    // Different key against a terminal request: refused.
    expect(() => ctx.admin.cancelRequestByOwner({ request_id: request.request_id, reason: "again" }, false)).toThrowError(/REQUEST_NOT_TERMINABLE|terminal request cannot be cancelled/);

    // Running without the adapter cancel capability: refused, state unchanged.
    const gate = barrier();
    class Held extends MockHarnessAdapter {
      override async runTurn(handle: Parameters<MockHarnessAdapter["runTurn"]>[0], input: Parameters<MockHarnessAdapter["runTurn"]>[1]) { const ack = await super.runTurn(handle, input); gate.enter(); await gate.wait; return ack; }
    }
    const held = setup(new Held());
    const running = await createRequest(held, "r2");
    const tick = held.coordinator === undefined ? undefined : undefined;
    void tick;
    const execution = (held.admin as unknown as { store: WorkspaceStore }) && undefined;
    void execution;
    // Drive execution through the public executor path used by the service worker.
    const { executeRequest } = await import("../src/testing.js");
    const runningPromise = executeRequest(held.store, held.adapter, running.request_id);
    await gate.entered;
    expect(() => held.admin.cancelRequestByOwner({ request_id: running.request_id, reason: "no capability" }, false)).toThrowError(/REQUEST_NOT_TERMINABLE|did not declare the cancel capability/);
    expect(held.store.prepare("SELECT state FROM requests WHERE request_id = ?").get(running.request_id)).toMatchObject({ state: "running" });
    // With the capability declared, a running request is cancellable.
    const cancelled = held.admin.cancelRequestByOwner({ request_id: running.request_id, reason: "with capability", idempotency_key: "gui-k2" }, true) as OwnerCancelResult;
    expect(cancelled).toMatchObject({ state: "cancelled", idempotent_replay: false });
    gate.finish(); await runningPromise;
  });

  it("owner views: usage is unknown before execution starts; detail carries the full question; artifact bytes verify", async () => {
    const ctx = setup();
    const request = await createRequest(ctx, "r1", "long question needing the real answer");
    const before = ctx.admin.requestInbox({}) as OwnerRequestInboxPage;
    expect(validate("owner-requests", before).ok).toBe(true);
    const summary = before.items.find(item => item.request_id === request.request_id)!;
    expect(summary).toMatchObject({ state: expect.stringMatching(/^(accepted|queued)$/), cleanup_pending: false, execution_uncertain: false });
    expect(summary.usage).toEqual({ output_bytes: null, turns_reserved: null });
    expect(summary.question_preview).toBe("long question needing the real answer");

    // Complete it through the public executor path (mock turn completes immediately).
    const { executeRequest } = await import("../src/testing.js");
    await executeRequest(ctx.store, ctx.adapter, request.request_id);
    const detail = ctx.admin.requestGet({ request_id: request.request_id }) as OwnerRequestDetail;
    expect(validate("owner-request-detail", detail).ok).toBe(true);
    expect(detail).toMatchObject({ state: "completed", idempotency_key: "r1" });
    expect(detail.usage!.output_bytes).toBeGreaterThan(0);
    expect(detail.result).toMatchObject({ artifact_id: expect.stringMatching(/^art-/) });

    const artifact = ctx.admin.artifactRead({ artifact_id: detail.result!.artifact_id });
    expect(validate("owner-artifact", artifact).ok).toBe(true);
    expect(artifact.request_id).toBe(request.request_id);
    expect(artifact.producing_role_id).toBe("reviewer");
    expect(artifact.body.length).toBeGreaterThan(0);

    // Filters and NOT_FOUND discipline.
    expect((ctx.admin.requestInbox({ state: "failed" }) as OwnerRequestInboxPage).items).toHaveLength(0);
    expect((ctx.admin.requestInbox({ target_role_id: "builder" }) as OwnerRequestInboxPage).items).toHaveLength(0);
    expect(() => ctx.admin.requestGet({ request_id: "req-missing" })).toThrowError(/does not exist/);
    expect(() => ctx.admin.artifactRead({ artifact_id: "art-missing" })).toThrowError(/does not exist/);
  });

  it("cleanup view distinguishes reclamation failure from completion without changing the terminal state", async () => {
    const gate = barrier();
    class Held extends MockHarnessAdapter {
      override async runTurn(handle: Parameters<MockHarnessAdapter["runTurn"]>[0], input: Parameters<MockHarnessAdapter["runTurn"]>[1]) { const ack = await super.runTurn(handle, input); gate.enter(); await gate.wait; return ack; }
      override async closeSession(): Promise<void> { throw new Error("fixture close failure"); }
    }
    const ctx = setup(new Held());
    const request = await createRequest(ctx, "r1");
    const { executeRequest } = await import("../src/testing.js");
    const execution = executeRequest(ctx.store, ctx.adapter, request.request_id);
    await gate.entered;
    // Running + adapter cancel capability declared → cancellable per §6; the
    // subsequent reclamation fails (closeSession throws) and must be recorded
    // without changing the terminal state.
    ctx.admin.cancelRequestByOwner({ request_id: request.request_id, reason: "withdraw" }, true);
    // The mock adapter does not declare cancel: the branch keeps running until
    // the turn returns, then reclamation runs and FAILS (closeSession throws).
    gate.finish(); await execution;
    const page = ctx.admin.cleanupList({ pending_only: true }) as OwnerCleanupPage;
    expect(validate("owner-cleanup", page).ok).toBe(true);
    const entry = page.items.find(item => item.request_id === request.request_id)!;
    expect(entry).toMatchObject({ state: "cancelled", cleanup_pending: true });
    expect(entry.cleanup_error).toMatchObject({ code: "INTERNAL", message: "fixture close failure" });
    // Terminal state unchanged by the failed reclamation.
    expect(ctx.store.prepare("SELECT state FROM requests WHERE request_id = ?").get(request.request_id)).toMatchObject({ state: "cancelled" });
  });

  it("inbox.list is fixed to the calling session's own role; other roles see nothing", async () => {
    const ctx = setup();
    const request = await createRequest(ctx, "r1");
    const { executeRequest } = await import("../src/testing.js");
    await executeRequest(ctx.store, ctx.adapter, request.request_id);
    const targetInbox = listSessionInbox(ctx.store, { session_id: ctx.target.session_id });
    expect(targetInbox.entries.length).toBeGreaterThanOrEqual(1);
    expect(targetInbox.entries[0]).toMatchObject({ owner_role_id: "reviewer", request_id: request.request_id, state: "unread", request_state: "completed" });
    const initiatorInbox = listSessionInbox(ctx.store, { session_id: ctx.initiator.session_id });
    expect(initiatorInbox.entries).toHaveLength(0);
  });
});
