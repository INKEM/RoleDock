import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "../src/index.js";
import type { AnchorResult } from "../src/index.js";
import type { AnchorAttemptsPage, AnchorLoadsPage, RevokePreview, SessionBindingsPage } from "@roledock/protocol";
import { validate } from "@roledock/protocol";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { coordinatorStore } from "../src/internal-store.js";

const CAPS = ["documents.read", "documents.publish", "documents.propose", "requests.create", "requests.execute", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"];
const workspaces: { root: string; coordinator: Coordinator }[] = [];
afterEach(() => { for (const item of workspaces.splice(0)) { item.coordinator.close(); rmSync(item.root, { recursive: true, force: true }); } });
function barrier() {
  let enter!: () => void, finish!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), wait: new Promise<void>(resolve => { finish = resolve; }), enter: () => enter(), finish: () => finish() };
}
async function setup(adapter = new MockHarnessAdapter()) {
  const root = mkdtempSync(join(tmpdir(), "rd-g4-"));
  const coordinator = Coordinator.open({ root, adapter }); workspaces.push({ root, coordinator });
  await coordinator.installRolePack({ source_path: resolve("examples/demo-team") });
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  for (const role of ["builder", "reviewer"]) for (const cap of CAPS) admin.grant({ role_id: role, capability: cap });
  const authority = new ExternalSessionAuthority(coordinator, adapter);
  return { root, coordinator, authority, adapter, admin, store: coordinatorStore(coordinator) };
}
async function conversation(context: Awaited<ReturnType<typeof setup>>, host = "original-chat", role = "builder", inherit: "initialize" | "takeover" = "initialize", scope = CAPS) {
  context.adapter.seedExternalSession(host, host, ["PRIVATE-HISTORY-MARKER"]);
  const external = await context.authority.register({ host_session_id: host, connection_subject: host, capability_ceiling: CAPS });
  context.adapter.seedHumanAuthorization({ workspace_id: context.coordinator.workspaceId, host_session_id: host, connection_subject: host, event_ref: `human-${host}`, actor_id: "human-user", role_id: role, capabilities: scope, inherit, expires_at: new Date(Date.now() + 3600000).toISOString() });
  const auth = await context.authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: `human-${host}` });
  const connection = context.authority.connect(external.external_session_id, host);
  const anchor = (key = "anchor") => connection.call("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: key }) as Promise<AnchorResult>;
  return { external, auth, connection, anchor };
}

// Mock mechanics only — these views read the same store the real adapters write.
describe("G4 owner observability views (Mock)", () => {
  it("bindings/attempts/loads expose the anchored chain with timestamps and listing never writes", async () => {
    const context = await setup(), actor = await conversation(context);
    const result = await actor.anchor();
    expect(result.binding?.generation).toBe(1);

    const bindings = context.authority.listBindings({}) as SessionBindingsPage;
    expect(validate("session-bindings", bindings).ok).toBe(true);
    expect(bindings.items).toHaveLength(1);
    const view = bindings.items[0]!;
    expect(view).toMatchObject({
      external_session_id: actor.external.external_session_id, host_session_id: "original-chat",
      role_id: "builder", generation: 1, state: "active", effective_state: "active",
      predecessor_instance_id: null, state_changed_at: view.created_at,
    });
    expect(view.capabilities).toEqual(["artifacts.read", "documents.propose", "documents.publish", "documents.read", "requests.cancel", "requests.create", "requests.execute", "requests.read", "requests.reply"]);
    expect(view.authorization).toMatchObject({ authorization_id: actor.auth.authorization_id, revoked_at: null, source: { kind: "human-event", actor_id: "human-user" }, source_knowledge_revision: 0 });
    expect(view.checkpoint_id).toBeNull(); // no checkpoint existed when materials were built

    const attempts = context.authority.listAttempts({}) as AnchorAttemptsPage;
    expect(validate("anchor-attempts", attempts).ok).toBe(true);
    expect(attempts.items).toHaveLength(1);
    expect(attempts.items[0]).toMatchObject({ attempt_id: result.attempt.attempt_id, state: "active", error: null, source_generation: 0, source_knowledge_revision: 0 });
    // The four confirmation judges are visible; secret-adjacent fields are not.
    expect(attempts.items[0]!.confirmation).toEqual({ host_session_id: "original-chat", load_key: result.attempt.load_key, content_hash: result.attempt.bundle_hash, load_version: 1 });
    expect(JSON.stringify(attempts.items[0])).not.toContain("idempotency_key");
    expect(JSON.stringify(attempts.items[0])).not.toContain("input_hash");

    const loads = context.authority.listLoads({}) as AnchorLoadsPage;
    expect(validate("anchor-loads", loads).ok).toBe(true);
    expect(loads.items).toHaveLength(1);
    expect(loads.items[0]).toMatchObject({ load_key: result.attempt.load_key, load_version: 1, confirmed_at: expect.any(String), prepared_at: expect.any(String) });

    // Projection only: listing leaves stored state untouched.
    const before = context.store.prepare("SELECT external_session_id, state FROM session_bindings").all();
    const attemptsBefore = context.store.prepare("SELECT attempt_id, state FROM anchor_attempts").all();
    context.authority.listBindings({}); context.authority.listAttempts({}); context.authority.listLoads({});
    expect(context.store.prepare("SELECT external_session_id, state FROM session_bindings").all()).toEqual(before);
    expect(context.store.prepare("SELECT attempt_id, state FROM anchor_attempts").all()).toEqual(attemptsBefore);

    // Filter + cursor pagination per contract §2.1. A second binding comes
    // from a reviewer conversation (initialize is legal — reviewer has no knowledge).
    const filtered = context.authority.listBindings({ external_session_id: actor.external.external_session_id }) as SessionBindingsPage;
    expect(filtered.items).toHaveLength(1);
    expect((context.authority.listBindings({ external_session_id: "ext-missing" }) as SessionBindingsPage).items).toHaveLength(0);
    const second = await conversation(context, "second-chat", "reviewer");
    await second.anchor();
    const page1 = context.authority.listBindings({ limit: 1 }) as SessionBindingsPage;
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = context.authority.listBindings({ limit: 1, cursor: page1.next_cursor! }) as SessionBindingsPage;
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.external_session_id).not.toBe(page1.items[0]!.external_session_id);
  });

  it("takeover timeline shows predecessor and superseded state; re-registration never bumps the generation", async () => {
    const context = await setup();
    const first = await conversation(context);
    const firstResult = await first.anchor();
    const successor = await conversation(context, "successor-chat", "builder", "takeover");
    const secondResult = await successor.anchor();
    expect(secondResult.binding?.generation).toBe(2);

    const bindings = context.authority.listBindings({}) as SessionBindingsPage;
    const old = bindings.items.find(row => row.generation === 1)!;
    const current = bindings.items.find(row => row.generation === 2)!;
    expect(old.state).toBe("superseded");
    expect(old.effective_state).toBe("superseded");
    expect(current.effective_state).toBe("active");
    expect(current.predecessor_instance_id).toBe(firstResult.binding!.instance_id);
    expect(current.instance_id).not.toBe(old.instance_id);
    expect(current.authorization?.source_knowledge_revision).toBe(old.authorization?.source_knowledge_revision);

    // Service restart scenario: re-registering the same host is idempotent and
    // the binding history — including the generation — is untouched.
    const again = await context.authority.register({ host_session_id: "successor-chat", connection_subject: "successor-chat", capability_ceiling: CAPS });
    expect(again.external_session_id).toBe(successor.external.external_session_id);
    const restored = context.authority.listBindings({ external_session_id: successor.external.external_session_id }) as SessionBindingsPage;
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]).toMatchObject({ generation: 2, state: "active" });
  });

  it("revokePreview mirrors the revocation impact and stays read-only; revoke withdraws a running task with uncertain/cleanup flags", async () => {
    const gate = barrier();
    class Held extends MockHarnessAdapter {
      override async runTurn(handle: Parameters<MockHarnessAdapter["runTurn"]>[0], input: Parameters<MockHarnessAdapter["runTurn"]>[1]) { const ack = await super.runTurn(handle, input); gate.enter(); await gate.wait; return ack; }
      override async closeSession(): Promise<void> { throw new Error("fixture close failure"); }
    }
    const context = await setup(new Held()), actor = await conversation(context), target = await conversation(context, "target", "reviewer");
    await actor.anchor(); await target.anchor();
    await target.connection.call("documents.publish", { document_key: "reviews", body: "target snapshot", expected_revision: 0, expected_generation: 1 });
    await actor.connection.call("documents.read", { target_role_id: "reviewer", document_key: "reviews" });
    const request = await actor.connection.call("requests.create", { target_role_id: "reviewer", question: "consult", idempotency_key: "request" }) as { request_id: string };
    const running = context.authority.tick();
    await gate.entered; // the delegated task is now running in its isolated branch

    const preview = context.authority.revokePreview({ authorization_id: actor.auth.authorization_id }) as RevokePreview;
    expect(validate("revoke-preview", preview).ok).toBe(true);
    expect(preview.authorization).toMatchObject({ authorization_id: actor.auth.authorization_id, role_id: "builder", revoked_at: null });
    expect(preview.bindings).toHaveLength(1);
    expect(preview.bindings[0]).toMatchObject({ external_session_id: actor.external.external_session_id, generation: 1, state: "active" });
    expect(preview.requests).toHaveLength(1);
    // The mock turn has returned but the executor has not confirmed completion,
    // so the request is honestly running + execution-uncertain — displayed, not hidden.
    expect(preview.requests[0]).toMatchObject({ request_id: request.request_id, state: "running", execution_uncertain: true, cleanup_pending: false, target_role_id: "reviewer", question: "consult" });

    // The preview is a read: nothing moved.
    expect(context.store.prepare("SELECT state FROM requests WHERE request_id = ?").get(request.request_id)).toMatchObject({ state: "running" });
    expect(context.store.prepare("SELECT state FROM session_bindings WHERE external_session_id = ?").get(actor.external.external_session_id)).toMatchObject({ state: "active" });

    await context.authority.revoke({ authorization_id: actor.auth.authorization_id });
    // Revocation took effect inside RoleDock; the external branch close FAILED,
    // so cleanup stays pending and the run is execution-uncertain — displayed,
    // never folded into "revoked".
    expect(context.store.prepare("SELECT state, cleanup_pending, execution_uncertain FROM requests WHERE request_id = ?").get(request.request_id))
      .toMatchObject({ state: "failed", cleanup_pending: 1, execution_uncertain: 1 });
    expect(context.store.prepare("SELECT state FROM session_bindings WHERE external_session_id = ?").get(actor.external.external_session_id)).toMatchObject({ state: "revoked" });

    const after = context.authority.revokePreview({ authorization_id: actor.auth.authorization_id }) as RevokePreview;
    expect(after.authorization.revoked_at).toBeTruthy();
    expect(after.bindings).toHaveLength(0);
    expect(after.requests).toHaveLength(0); // terminal requests drop out of the preview
    gate.finish(); await running;
  });

  it("failed attempts expose the error-message layer; load-incapable adapters never activate", async () => {
    const context = await setup(new MockHarnessAdapter({ external: { load_materials: false } }));
    const actor = await conversation(context);
    const failed = await actor.anchor();
    expect(failed.attempt.state).toBe("failed");

    const attempts = context.authority.listAttempts({ external_session_id: actor.external.external_session_id }) as AnchorAttemptsPage;
    const view = attempts.items[0]!;
    expect(view.state).toBe("failed");
    expect(view.error).toMatchObject({ code: "ADAPTER_CAPABILITY_MISSING" });
    expect(view.error?.message).toBeTruthy();
    expect(view.confirmation).toBeNull();
    expect((context.authority.listBindings({}) as SessionBindingsPage).items).toHaveLength(0);
  });
});
