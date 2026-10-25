import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "../src/index.js";
import type { AnchorResult, ExternalMaterialLoad, ExternalLoadLookup } from "../src/index.js";
import type { AnchorConfirmation, ExternalSession, RoleAuthorization, SessionBinding } from "@roledock/protocol";
import { RoleDockError, validate } from "@roledock/protocol";
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
  const root = mkdtempSync(join(tmpdir(), "rd-anchor-"));
  const coordinator = Coordinator.open({ root, adapter }); workspaces.push({ root, coordinator });
  await coordinator.installRolePack({ source_path: resolve("examples/demo-team") });
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  for (const role of ["builder", "reviewer"]) for (const cap of CAPS) admin.grant({ role_id: role, capability: cap });
  const authority = new ExternalSessionAuthority(coordinator, adapter);
  return { root, coordinator, authority, adapter, admin, store: coordinatorStore(coordinator) };
}
async function conversation(context: Awaited<ReturnType<typeof setup>>, host = "original-chat", role = "builder", inherit: "initialize" | "takeover" = "initialize", expiresAt = new Date(Date.now() + 3600000).toISOString(), scope = CAPS) {
  context.adapter.seedExternalSession(host, host, ["PRIVATE-HISTORY-MARKER"]);
  const external = await context.authority.register({ host_session_id: host, connection_subject: host, capability_ceiling: CAPS });
  context.adapter.seedHumanAuthorization({ workspace_id: context.coordinator.workspaceId, host_session_id: host, connection_subject: host, event_ref: `human-${host}`, actor_id: "human-user", role_id: role, capabilities: scope, inherit, expires_at: expiresAt });
  const auth = await context.authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: `human-${host}` });
  const connection = context.authority.connect(external.external_session_id, host);
  const anchor = (key = "anchor") => connection.call("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: key }) as Promise<AnchorResult>;
  return { external, auth, connection, anchor };
}
function head(context: Awaited<ReturnType<typeof setup>>, role = "builder") { return context.store.prepare("SELECT * FROM role_heads WHERE role_id = ?").get(role) as { generation: number; knowledge_revision: number; current_instance_id: string | null }; }

// These tests prove Mock state mechanics only, not a real host's human provenance.
describe("external connection and anchor authority (Mock)", () => {
  it("loads fixed instructions into the original conversation before activation; replay and binding restore keep one generation", async () => {
    const context = await setup(); const actor = await conversation(context);
    expect(validate("external-session", actor.external).ok).toBe(true);
    expect(validate("role-authorization", actor.auth).ok).toBe(true);
    expect(head(context).generation).toBe(0);
    const result = await actor.anchor();
    expect(result.attempt.state).toBe("active"); expect(result.binding?.generation).toBe(1);
    expect(validate("anchor-attempt", result.attempt).ok).toBe(true); expect(validate("session-binding", result.binding).ok).toBe(true);
    const loaded = context.adapter.peekExternal("original-chat");
    expect(loaded.loads).toHaveLength(1); expect(loaded.loads[0]?.host_session_id).toBe("original-chat");
    expect(loaded.loads[0]?.bootstrap.payload).toContain("instructions"); expect(loaded.loads[0]?.bootstrap.payload).not.toContain("PRIVATE-HISTORY-MARKER");
    expect(loaded.history).toEqual(["PRIVATE-HISTORY-MARKER"]);
    expect(await actor.anchor()).toEqual(result);
    const restored = context.authority.connect(actor.external.external_session_id, "original-chat");
    expect(await restored.call("sessions.binding")).toEqual({ binding: result.binding });
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toMatchObject({ n: 1 });
    expect(context.store.prepare("SELECT creation_key FROM sessions").get()).toMatchObject({ creation_key: null });
  });
  it("rejects identity spoofing, unknown grants, privileged tools and cross-conversation grant consumption with zero head changes", async () => {
    const context = await setup(), first = await conversation(context), second = await conversation(context, "chat-b");
    await expect(second.connection.call("sessions.anchor", { authorization_id: first.auth.authorization_id, idempotency_key: "cross" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(first.connection.call("sessions.anchor", { authorization_id: "auth-unknown", idempotency_key: "none" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    for (const operation of ["authorizations.record", "authorizations.revoke", "externalSessions.register", "sessions.open", "policy.grant", "knowledge.import", "testingOpenPrimarySession"]) await expect(first.connection.call(operation, {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(first.connection.call("sessions.anchor", { authorization_id: first.auth.authorization_id, idempotency_key: "spoof", role_id: "reviewer" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(first.connection.call("documents.read", { document_key: "state", session_id: "fake" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(() => context.authority.connect(first.external.external_session_id, "chat-b")).toThrow(RoleDockError);
    const other = await setup(); const foreign = await conversation(other, "other-workspace");
    await expect(first.connection.call("sessions.anchor", { authorization_id: foreign.auth.authorization_id, idempotency_key: "foreign" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(head(context).generation).toBe(0); expect(context.store.prepare("SELECT COUNT(*) AS n FROM anchor_attempts").get()).toMatchObject({ n: 0 });
  });
  it.each(["model", "tool", "document"] as const)("cannot derive authorization from %s text", async source => {
    const context = await setup(); context.adapter.seedExternalSession("chat", "subject");
    const ext = await context.authority.register({ host_session_id: "chat", connection_subject: "subject", capability_ceiling: CAPS });
    context.adapter.seedHumanAuthorization({ workspace_id: context.coordinator.workspaceId, host_session_id: "chat", connection_subject: "subject", event_ref: "quoted-user", actor_id: "human-user", role_id: "builder", capabilities: CAPS, inherit: "initialize", expires_at: new Date(Date.now() + 100000).toISOString() }, source);
    await expect(context.authority.recordHumanAuthorization({ external_session_id: ext.external_session_id, event_ref: "quoted-user" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM role_authorizations").get()).toMatchObject({ n: 0 });
  });
  it("keeps source replay's original baseline, denies ceiling escalation and same anchor key with different authorization", async () => {
    const context = await setup(), actor = await conversation(context);
    const secondAuth = context.authority.recordOwnerAuthorization({ external_session_id: actor.external.external_session_id, event_ref: "owner-selection", actor_id: "owner", role_id: "builder", capabilities: CAPS, inherit: "initialize", expires_at: new Date(Date.now() + 100000).toISOString() });
    await actor.anchor();
    expect(await context.authority.recordHumanAuthorization({ external_session_id: actor.external.external_session_id, event_ref: "human-original-chat" })).toEqual(actor.auth);
    await expect(actor.connection.call("sessions.anchor", { authorization_id: secondAuth.authorization_id, idempotency_key: "anchor" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    context.adapter.seedExternalSession("limited", "limited");
    const limited = await context.authority.register({ host_session_id: "limited", connection_subject: "limited", capability_ceiling: ["documents.read"] });
    expect(() => context.authority.recordOwnerAuthorization({ external_session_id: limited.external_session_id, event_ref: "escalate", actor_id: "owner", role_id: "reviewer", capabilities: CAPS, inherit: "initialize", expires_at: new Date(Date.now() + 100000).toISOString() })).toThrowError(/ceiling/);
    expect(head(context).generation).toBe(1);
  });
  it("human-event idempotency ignores object key order while detecting an actual changed grant", async () => {
    let reversed = false;
    class Reordered extends MockHarnessAdapter { override async readHumanAuthorization(host: string, ref: string) {
      const event = await super.readHumanAuthorization(host, ref); if (!event) return null;
      return reversed ? Object.fromEntries(Object.entries(event).reverse()) as unknown as typeof event : event;
    } }
    const context = await setup(new Reordered()), actor = await conversation(context); reversed = true;
    expect(await context.authority.recordHumanAuthorization({ external_session_id: actor.external.external_session_id, event_ref: "human-original-chat" })).toEqual(actor.auth);
    context.adapter.seedHumanAuthorization({ workspace_id: context.coordinator.workspaceId, host_session_id: "original-chat", connection_subject: "original-chat", event_ref: "human-original-chat", actor_id: "human-user", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_at: actor.auth.expires_at });
    await expect(context.authority.recordHumanAuthorization({ external_session_id: actor.external.external_session_id, event_ref: "human-original-chat" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM role_authorizations").get()).toMatchObject({ n: 1 });
  });
  it("two overlapping successors have one CAS winner and a replay never overwrites it", async () => {
    const gate = barrier(); let count = 0;
    class Concurrent extends MockHarnessAdapter {
      override async loadExternalMaterials(input: ExternalMaterialLoad): Promise<AnchorConfirmation> { const ack = await super.loadExternalMaterials(input); if (input.host_session_id !== "initial") { count++; if (count === 2) gate.enter(); await gate.wait; } return ack; }
    }
    const context = await setup(new Concurrent()), original = await conversation(context, "initial"); const initial = await original.anchor();
    const a = await conversation(context, "successor-a", "builder", "takeover"), b = await conversation(context, "successor-b", "builder", "takeover");
    const promises = [a.anchor(), b.anchor()]; await gate.entered;
    expect(head(context).current_instance_id).toBe(initial.binding!.instance_id); gate.finish();
    const outcomes = await Promise.all(promises);
    expect(outcomes.map(item => item.attempt.state).sort()).toEqual(["active", "failed"]);
    expect(outcomes.find(item => item.attempt.state === "failed")?.attempt.error?.code).toBe("GENERATION_CONFLICT");
    expect(head(context).generation).toBe(2);
    await expect(original.connection.call("documents.publish", { document_key: "state", body: "old", expected_revision: 0, expected_generation: 1 })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect((await original.connection.call("sessions.binding") as { binding: SessionBinding }).binding.state).toBe("superseded");
    await Promise.all([a.anchor(), b.anchor()]); expect(head(context).generation).toBe(2);
  });
  it("coalesces same-key overlap, detects different keys while loading, and does not activate a revoked grant", async () => {
    const gate = barrier();
    class Held extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad) { const ack = await super.loadExternalMaterials(input); gate.enter(); await gate.wait; return ack; } }
    const context = await setup(new Held()), actor = await conversation(context);
    const first = actor.anchor(), same = actor.anchor(); await gate.entered;
    await expect(actor.anchor("different")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await context.authority.revoke({ authorization_id: actor.auth.authorization_id }); gate.finish();
    const result = await first; expect(await same).toEqual(result); expect(result.attempt.state).toBe("failed"); expect(result.attempt.error?.code).toBe("PERMISSION_DENIED");
    expect(head(context).generation).toBe(0); expect(context.adapter.peekExternal("original-chat").loads).toHaveLength(1);
  });
  it("re-prepares changed knowledge, including actual new body, without widening the authorization generation", async () => {
    const gate = barrier(); let held = false;
    class Held extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad) { const ack = await super.loadExternalMaterials(input); if (input.host_session_id === "successor" && !held) { held = true; gate.enter(); await gate.wait; } return ack; } }
    const context = await setup(new Held()), original = await conversation(context, "initial"); await original.anchor();
    const successor = await conversation(context, "successor", "builder", "takeover"), pending = successor.anchor(); await gate.entered;
    await original.connection.call("documents.publish", { document_key: "state", body: "KNOWLEDGE-UPDATED-WHILE-LOADING", expected_revision: 0, expected_generation: 1 }); gate.finish();
    const result = await pending; expect(result.attempt.state).toBe("active"); expect(result.binding?.generation).toBe(2); expect(result.attempt.source_knowledge_revision).toBe(1);
    const loads = context.adapter.peekExternal("successor").loads; expect(loads).toHaveLength(2); expect(loads[1]!.bootstrap.payload).toContain("KNOWLEDGE-UPDATED-WHILE-LOADING"); expect(loads[0]!.load_key).not.toBe(loads[1]!.load_key);
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM anchor_loads WHERE attempt_id = ? AND confirmation_json IS NOT NULL").get(result.attempt.attempt_id)).toMatchObject({ n: 2 });
  });
  it("release plus knowledge drift cannot revive a failed anchor or reload a released successor", async () => {
    const gate = barrier();
    class Held extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad) { const ack = await super.loadExternalMaterials(input); if (input.host_session_id === "released-successor") { gate.enter(); await gate.wait; } return ack; } }
    const context = await setup(new Held()), original = await conversation(context, "original"); const first = await original.anchor();
    const successor = await conversation(context, "released-successor", "builder", "takeover"); const pending = successor.anchor(); await gate.entered;
    await successor.connection.call("sessions.release");
    await original.connection.call("documents.publish", { document_key: "state", body: "knowledge-after-release", expected_revision: 0, expected_generation: 1 });
    gate.finish(); const result = await pending;
    expect(result.attempt.state).toBe("failed"); expect(result.binding).toBeNull();
    expect(head(context)).toMatchObject({ generation: 1, current_instance_id: first.binding!.instance_id });
    expect(context.adapter.peekExternal("released-successor").loads).toHaveLength(1);
    expect((await successor.anchor()).attempt.state).toBe("failed");
  });
  it("restores uncertain material delivery after writer restart by querying the old key, without replaying the load", async () => {
    class LostAck extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad): Promise<AnchorConfirmation> { await super.loadExternalMaterials(input); throw new Error("lost acknowledgment"); } }
    const context = await setup(new LostAck()), actor = await conversation(context); const uncertain = await actor.anchor();
    expect(uncertain.attempt.state).toBe("uncertain"); expect(head(context).generation).toBe(0);
    context.coordinator.close(); const restored = Coordinator.open({ root: context.root, adapter: context.adapter }); workspaces.find(item => item.root === context.root)!.coordinator = restored;
    const authority = new ExternalSessionAuthority(restored, context.adapter), connection = authority.connect(actor.external.external_session_id, "original-chat");
    const result = await connection.call("sessions.reconcile", { attempt_id: uncertain.attempt.attempt_id }) as AnchorResult;
    expect(result.attempt.state).toBe("active"); expect(result.binding?.generation).toBe(1); expect(context.adapter.peekExternal("original-chat").loads).toHaveLength(1);
    expect((await connection.call("sessions.binding") as { binding: SessionBinding }).binding.generation).toBe(1);
  });
  it("does not blind-reload an unknown outcome and cannot activate a mismatched confirmation", async () => {
    class Unknown extends MockHarnessAdapter { override async loadExternalMaterials(_input: ExternalMaterialLoad): Promise<AnchorConfirmation> { throw new Error("unknown"); } override async lookupExternalLoad(): Promise<ExternalLoadLookup> { return { state: "unknown" }; } }
    const context = await setup(new Unknown()), actor = await conversation(context); const result = await actor.anchor();
    expect(result.attempt.state).toBe("uncertain"); expect((await actor.anchor()).attempt.state).toBe("uncertain"); expect(head(context).generation).toBe(0);
    class Mismatch extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad) { return { ...await super.loadExternalMaterials(input), host_session_id: "another-chat" }; } }
    const bad = await setup(new Mismatch()), badActor = await conversation(bad); expect((await badActor.anchor()).attempt.error?.code).toBe("VALIDATION_FAILED"); expect(head(bad).generation).toBe(0);
  });
  it("transient reconciliation errors preserve uncertainty and block a fresh key from replaying a material load", async () => {
    let loads = 0;
    class Lost extends MockHarnessAdapter {
      override async loadExternalMaterials(_input: ExternalMaterialLoad): Promise<AnchorConfirmation> { loads++; throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "uncertain external acknowledgment", { details: { uncertain: true } }); }
      override async lookupExternalLoad(): Promise<ExternalLoadLookup> { throw new Error("temporary lookup transport failure"); }
    }
    const context = await setup(new Lost()), actor = await conversation(context); const first = await actor.anchor();
    expect(first.attempt.state).toBe("uncertain"); expect((await actor.anchor()).attempt.state).toBe("uncertain");
    await expect(actor.anchor("new-key")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(loads).toBe(1); expect(head(context).generation).toBe(0);
  });
  it("enforces effective scopes and revocation on direct SDK operations as well as session tools", async () => {
    const context = await setup(), actor = await conversation(context, "reader-only", "builder", "initialize", undefined, ["documents.read"]), result = await actor.anchor();
    await expect(context.coordinator.publishDocument({ session_id: result.binding!.session_id, document_key: "state", body: "denied", expected_revision: 0, expected_generation: 1 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await context.authority.revoke({ authorization_id: actor.auth.authorization_id });
    expect((await actor.connection.call("sessions.binding") as { binding: SessionBinding }).binding.state).toBe("revoked"); expect(head(context).current_instance_id).toBeNull();
    await expect(context.coordinator.listDocuments({ session_id: result.binding!.session_id })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(head(context).generation).toBe(1);
  });
  it("release withdraws delegated task authority, retains snapshots, and new anchoring advances the released generation", async () => {
    const context = await setup(), actor = await conversation(context), target = await conversation(context, "target", "reviewer"); const original = await actor.anchor(); await target.anchor();
    const request = await actor.connection.call("requests.create", { target_role_id: "reviewer", question: "consult", idempotency_key: "request", read_exception_rationale: "No published target documents" }) as { request_id: string };
    const before = context.store.prepare("SELECT * FROM requests WHERE request_id = ?").get(request.request_id)!;
    await actor.connection.call("sessions.release");
    const after = context.store.prepare("SELECT * FROM requests WHERE request_id = ?").get(request.request_id)!;
    expect(after.state).toBe("failed"); expect(after.binding_generation).toBe(before.binding_generation); expect(after.binding_snapshot_json).toBe(before.binding_snapshot_json);
    expect((await actor.connection.call("sessions.binding") as { binding: SessionBinding }).binding.state).toBe("released");
    expect(head(context)).toMatchObject({ generation: 1, current_instance_id: null });
    await expect(actor.anchor("again")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const successor = await conversation(context, "after-release", "builder", "takeover"); expect((await successor.anchor()).binding?.generation).toBe(2);
    await expect(context.coordinator.publishDocument({ session_id: original.binding!.session_id, document_key: "state", body: "late", expected_revision: 0, expected_generation: 1 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("withdrawing a running task denies branch candidates even when host close fails", async () => {
    const gate = barrier();
    class Held extends MockHarnessAdapter {
      override async runTurn(handle: Parameters<MockHarnessAdapter["runTurn"]>[0], input: Parameters<MockHarnessAdapter["runTurn"]>[1]) { const ack = await super.runTurn(handle, input); gate.enter(); await gate.wait; return ack; }
      override async closeSession(): Promise<void> { throw new Error("fixture close failure"); }
    }
    const context = await setup(new Held()), actor = await conversation(context), target = await conversation(context, "target", "reviewer"); await actor.anchor(); await target.anchor();
    await target.connection.call("documents.publish", { document_key: "reviews", body: "target snapshot", expected_revision: 0, expected_generation: 1 });
    await actor.connection.call("documents.read", { target_role_id: "reviewer", document_key: "reviews" });
    const request = await actor.connection.call("requests.create", { target_role_id: "reviewer", question: "q", idempotency_key: "blocked-task" }) as { request_id: string };
    const running = context.authority.tick(); await gate.entered; await actor.connection.call("sessions.release");
    const branch = context.store.prepare("SELECT id, state FROM sessions WHERE creation_key = ?").get(`request-${request.request_id}`) as { id: string; state: string };
    expect(branch.state).toBe("active"); expect(context.store.prepare("SELECT state, cleanup_pending FROM requests WHERE request_id = ?").get(request.request_id)).toMatchObject({ state: "failed", cleanup_pending: 1 });
    await expect(context.coordinator.proposeDocumentUpdate({ session_id: branch.id, target_role_id: "reviewer", document_key: "reviews", body: "late candidate", baseline_revision: 1 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    gate.finish(); await running;
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM candidate_updates").get()).toMatchObject({ n: 0 }); expect(context.store.prepare("SELECT COUNT(*) AS n FROM request_artifacts").get()).toMatchObject({ n: 0 });
  });
  it("expired grants cannot activate; expiry invalidates a live binding and prevents new requests to an unserved role", async () => {
    const gate = barrier(); class Held extends MockHarnessAdapter { override async loadExternalMaterials(input: ExternalMaterialLoad) { const ack = await super.loadExternalMaterials(input); if (input.host_session_id === "expiring") { gate.enter(); await gate.wait; } return ack; } }
    const context = await setup(new Held()), actor = await conversation(context, "expiring", "builder", "initialize", new Date(Date.now() + 5000).toISOString());
    const promise = actor.anchor(); await gate.entered; await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(actor.auth.expires_at) - Date.now()) + 100)); gate.finish(); expect((await promise).attempt.error?.code).toBe("PERMISSION_DENIED"); expect(head(context).generation).toBe(0);
    const active = await conversation(context, "active", "builder", "initialize", new Date(Date.now() + 5000).toISOString()); expect((await active.anchor()).attempt.state).toBe("active"); await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(active.auth.expires_at) - Date.now()) + 100));
    expect((await active.connection.call("sessions.binding") as { binding: SessionBinding }).binding.state).toBe("expired"); expect(head(context).current_instance_id).toBeNull();
    const initiator = await conversation(context, "initiator", "reviewer"); await initiator.anchor();
    await expect(initiator.connection.call("requests.create", { target_role_id: "builder", question: "q", idempotency_key: "no-head", read_exception_rationale: "No target documents" })).rejects.toMatchObject({ code: "ROLE_UNINITIALIZED" });
  });
  it("missing identity/load/reconcile capabilities are explicit and never produce an active binding", async () => {
    const noIdentity = await setup(new MockHarnessAdapter({ external: { current_session_identity: false } })); noIdentity.adapter.seedExternalSession("chat", "subject");
    await expect(noIdentity.authority.register({ host_session_id: "chat", connection_subject: "subject", capability_ceiling: CAPS })).rejects.toMatchObject({ code: "ADAPTER_CAPABILITY_MISSING" });
    const noLoad = await setup(new MockHarnessAdapter({ external: { load_materials: false } })), actor = await conversation(noLoad);
    expect((await actor.anchor()).attempt.error?.code).toBe("ADAPTER_CAPABILITY_MISSING"); expect(head(noLoad).generation).toBe(0);
  });
});
