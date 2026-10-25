import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator, loadRolePack } from "../src/index.js";
import * as production from "../src/index.js";
import { coordinatorStore } from "../src/internal-store.js";
import { buildCheckpoint, getLatestCheckpoint } from "../src/documents/checkpoint.js";
import { executeRequest } from "../src/requests/executor.js";
import { prepareHandoff, provisionHandoff, activateHandoff, rehydratePreparation } from "../src/sessions/handoff.js";
import { publishDocument } from "../src/documents/service.js";
import { bodyHash, readObject } from "../src/store/objects.js";
import { testingOpenPrimarySession } from "../src/testing.js";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import type { AdapterSessionHandle, AdapterSessionResult, CreateSessionInput, TurnInput } from "../src/ports/adapter.js";
import { writePack } from "../../../tests/helpers/packs.js";
import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";

const roots: string[] = [];
const handles: Coordinator[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "rd-rework-")); roots.push(path); return path; }
afterEach(() => { for (const c of handles.splice(0)) { try { c.close(); } catch {} } for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function pack(path: string) {
  writePack({ dir: path, name: "rework-pack", roles: [
    { id: "alpha", docs: [{ key: "state", visibility: "project" }, { key: "secret", visibility: "private" }, { key: "local", visibility: "role" }] },
    { id: "beta", docs: [{ key: "notes", visibility: "project" }] },
  ] });
  writeFileSync(join(path, "roles/alpha.md"), "UNIQUE-ROLE-INSTRUCTION");
}
async function fixture(adapter = new MockHarnessAdapter(), granted = true) {
  const path = root(); const source = join(path, "pack"); pack(source);
  const c = Coordinator.open({ root: path, adapter }); handles.push(c);
  await c.installRolePack({ source_path: source }); const store = coordinatorStore(c);
  if (granted) grantFixtureCapabilities(store);
  const alpha = await c.openSession({ role_id: "alpha", creation_key: "first-alpha" });
  const beta = await c.openSession({ role_id: "beta", creation_key: "first-beta" });
  return { c, store, path, adapter, alpha, beta };
}
type F = Awaited<ReturnType<typeof fixture>>;
function grant(f: F, role: string, caps: string[]) { const config = f.store.getConfig(); config.policy.grants[role] = caps; f.store.setConfig(config); }
function counts(f: F) { return ["document_revisions", "candidate_updates", "read_receipts", "request_artifacts", "request_inbox"].map((table) => (f.store.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n); }
function publish(f: F, body: string, revision = 0, key = "state") { return f.c.publishDocument({ session_id: f.alpha.session_id, document_key: key, body, expected_revision: revision, expected_generation: 1 }); }
function ask(f: F, key = "ask", budget?: object) { return f.c.createRequest({ session_id: f.beta.session_id, target_role_id: "alpha", question: `question:${key}`, idempotency_key: key, read_exception_rationale: "information gap", ...(budget ? { budget } : {}) }); }
function host(f: F, key: string) { return (f.store.prepare("SELECT host_session_ref FROM sessions WHERE creation_key = ? OR open_key = ?").get(key, key) as { host_session_ref: string }).host_session_ref; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

describe("R09 native resume handle", () => {
  it("passes the persisted host creation key for initial and successor sessions", async () => {
    class KeyCheckingAdapter extends MockHarnessAdapter {
      readonly createdKeys = new Map<string, string>();
      override async createSession(input: CreateSessionInput) {
        const handle = await super.createSession(input);
        this.createdKeys.set(handle.host_session_id, input.creation_key);
        return handle;
      }
      override async nativeResume(handle: AdapterSessionHandle) {
        expect(handle.creation_key).toBe(this.createdKeys.get(handle.host_session_id));
        return super.nativeResume(handle);
      }
    }
    const f = await fixture(new KeyCheckingAdapter());
    expect((await f.c.resumeSession({ session_id: f.alpha.session_id })).resumed).toBe(true);
    const successor = await f.c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "resume-successor" });
    expect((await f.c.resumeSession({ session_id: successor.session_id })).resumed).toBe(true);
    expect((await f.c.resolveRole({ role_id: "alpha" })).generation).toBe(2);
  });
});

 describe("R01 reference closure", () => {
  it.each(["ftp://remote/a.json", "//remote/a.json", "file:///tmp/a.json", "../outside.json", "%2e%2e/outside.json", "/tmp/a.json", "missing.json"])("rejects %s", (reference) => {
    const path = root(); pack(path); mkdirSync(join(path, "schemas"));
    const manifest = JSON.parse(readFileSync(join(path, "rolepack.json"), "utf8"));
    manifest.roles[0].output_schemas = [{ key: "answer", schema: "schemas/top.json" }];
    writeFileSync(join(path, "rolepack.json"), JSON.stringify(manifest));
    writeFileSync(join(path, "schemas/top.json"), JSON.stringify({ $ref: reference }));
    expect(() => loadRolePack(path)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
  it("rejects remote next-level refs, directory templates and escaping schema symlinks; accepts recursive local files", () => {
    const path = root(); pack(path); mkdirSync(join(path, "schemas"));
    const manifest = JSON.parse(readFileSync(join(path, "rolepack.json"), "utf8"));
    manifest.roles[0].output_schemas = [{ key: "answer", schema: "schemas/top.json" }];
    writeFileSync(join(path, "rolepack.json"), JSON.stringify(manifest));
    writeFileSync(join(path, "schemas/top.json"), '{"$ref":"child.json#/$defs/node"}');
    writeFileSync(join(path, "schemas/child.json"), '{"$defs":{"node":{"$ref":"https://remote/a"}}}');
    expect(() => loadRolePack(path)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    writeFileSync(join(path, "schemas/child.json"), '{"$defs":{"node":{"$ref":"top.json"}}}');
    expect(loadRolePack(path).manifest.name).toBe("rework-pack");
    manifest.roles[0].documents[0].template = "schemas";
    writeFileSync(join(path, "rolepack.json"), JSON.stringify(manifest));
    expect(() => loadRolePack(path)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    manifest.roles[0].documents[0].template = "templates/alpha-state.md";
    writeFileSync(join(path, "rolepack.json"), JSON.stringify(manifest));
    rmSync(join(path, "schemas/child.json"));
    const outside = join(root(), "external.json"); writeFileSync(outside, '{}'); symlinkSync(outside, join(path, "schemas/child.json"));
    expect(() => loadRolePack(path)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("R02/R03 actual policy and production boundary", () => {
  it("denies no-grant and revoked actions without revisions, candidates or receipts, including direct service", async () => {
    const f = await fixture(undefined, false); const before = counts(f);
    const actions = [() => publish(f, "denied"), () => f.c.listDocuments({ session_id: f.alpha.session_id }),
      () => f.c.readDocument({ session_id: f.alpha.session_id, document_key: "state" }),
      () => f.c.proposeDocumentUpdate({ session_id: f.alpha.session_id, target_role_id: "alpha", document_key: "state", body: "denied", baseline_revision: 0 })];
    for (const action of actions) await expect(action()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(() => publishDocument(f.store, { session_id: f.alpha.session_id, document_key: "state", body: "denied", expected_revision: 0, expected_generation: 1 })).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(counts(f)).toEqual(before);
    grantFixtureCapabilities(f.store); await publish(f, "allowed");
    grant(f, "alpha", []); const after = counts(f);
    for (const action of actions) await expect(action()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(counts(f)).toEqual(after);
  });
  it("exposes no store, fixture appointment, receipt signer or low-level mutations in production", async () => {
    for (const name of ["WorkspaceStore", "openPrimarySession", "recordReadReceipt", "publishDocument", "activateHandoff", "executeRequest", "putObject"]) expect(production).not.toHaveProperty(name);
    const f = await fixture(); expect(f.c).not.toHaveProperty("store");
    const privatePath = "@roledock/core/dist/sessions/internal.js";
    await expect(import(privatePath)).rejects.toThrow();
  });
  it("ignores forged, unrelated and nonexistent-version receipts; real target reads work", async () => {
    const f = await fixture(); await publish(f, "real");
    f.store.prepare("INSERT INTO read_receipts VALUES ('forged', ?, ?, ?, 'beta', 'alpha', 'state', 999, ?, ?)")
      .run(f.c.workspaceId, f.beta.session_id, f.beta.instance_id, bodyHash("real"), new Date().toISOString());
    const input = { session_id: f.beta.session_id, target_role_id: "alpha", question: "q", idempotency_key: "receipts" };
    await expect(f.c.createRequest(input)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await f.c.publishDocument({ session_id: f.beta.session_id, document_key: "notes", body: "unrelated", expected_revision: 0, expected_generation: 1 });
    await f.c.readDocument({ session_id: f.beta.session_id, document_key: "notes" });
    await expect(f.c.createRequest(input)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await f.c.readDocument({ session_id: f.beta.session_id, target_role_id: "alpha", document_key: "state" });
    expect((await f.c.createRequest(input)).created).toBe(true);
  });
});

describe("R04/R05 knowledge boundaries", () => {
  it("preserves stale proposal baseline and content; adoption conflicts", async () => {
    const f = await fixture(); await publish(f, "v1"); await publish(f, "v2", 1);
    const proposal = await f.c.proposeDocumentUpdate({ session_id: f.beta.session_id, target_role_id: "alpha", document_key: "state", body: "EDIT-OF-V1", baseline_revision: 1 });
    expect(proposal.baseline_revision).toBe(1);
    await expect(f.c.publishDocument({ session_id: f.alpha.session_id, document_key: "state", body: "unused", expected_revision: 2, expected_generation: 1, candidate_id: proposal.candidate_id })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(readObject(f.store, proposal.proposed_body_hash)).toBe("EDIT-OF-V1");
    expect((f.store.prepare("SELECT state FROM candidate_updates WHERE candidate_id = ?").get(proposal.candidate_id) as { state: string }).state).toBe("open");
  });
  it.each(["traversal", "absolute", "symlink", "checkpoint"])("rejects %s import before database changes", async (kind) => {
    const f = await fixture(); await publish(f, "SENTINEL"); buildCheckpoint(f.store, { role_id: "alpha", summary_body: "SENTINEL" }); const exported = await f.c.exportKnowledge({ scope: "workspace" });
    const file = join(exported.bundle_dir, "manifest.json"); const manifest = JSON.parse(readFileSync(file, "utf8"));
    const sentinel = join(root(), "sentinel.md"); writeFileSync(sentinel, "SENTINEL");
    if (kind === "checkpoint") {
      manifest.checkpoints[0].file = "../outside.json"; manifest.checkpoints[0].content_hash = bodyHash("SENTINEL");
      writeFileSync(join(exported.bundle_dir, "../outside.json"), "SENTINEL");
    } else {
      manifest.entries[0].content_hash = bodyHash("SENTINEL");
      if (kind === "absolute") manifest.entries[0].file = sentinel;
      if (kind === "traversal") { manifest.entries[0].file = "../outside.md"; writeFileSync(join(exported.bundle_dir, "../outside.md"), "SENTINEL"); }
      if (kind === "symlink") { symlinkSync(sentinel, join(exported.bundle_dir, "escape.md")); manifest.entries[0].file = "escape.md"; }
    }
    writeFileSync(file, JSON.stringify(manifest)); const before = counts(f);
    await expect(f.c.importKnowledge({ bundle_dir: exported.bundle_dir })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(counts(f)).toEqual(before);
  });
});

describe("R06–R09 fixed knowledge, host loading and recovery", () => {
  it("loads role material on first open, inherits committed summary and bodies, rejects stale summary bundle", async () => {
    const f = await fixture(); const firstHost = host(f, "first-alpha");
    expect(f.adapter.peek(firstHost).bootstrap?.payload).toContain("UNIQUE-ROLE-INSTRUCTION");
    await publish(f, "UNIQUE-KNOWLEDGE"); await publish(f, "PRIVATE-SECRET", 0, "secret");
    const one = buildCheckpoint(f.store, { role_id: "alpha", summary_body: "SUMMARY-ONE", todos: [{ description: "TODO-ONE", done: false }] });
    const prep = prepareHandoff(f.store, { session_id: f.alpha.session_id });
    expect(getLatestCheckpoint(f.store, "alpha")?.knowledge_revision).toBe(one.knowledge_revision);
    const two = buildCheckpoint(f.store, { role_id: "alpha", summary_body: "SUMMARY-TWO" });
    expect(two.knowledge_revision).toBe(one.knowledge_revision + 1);
    await provisionHandoff(f.store, f.adapter, prep);
    expect(() => activateHandoff(f.store, { bundle_id: prep.bundle_id })).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    const second = await f.c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "second-alpha" });
    const payload = f.adapter.peek(host(f, "second-alpha")).bootstrap!.payload;
    expect(payload).toContain("UNIQUE-ROLE-INSTRUCTION"); expect(payload).toContain("UNIQUE-KNOWLEDGE");
    expect(payload).toContain("SUMMARY-TWO"); expect(payload).toContain("TODO-ONE"); expect(payload).not.toContain("PRIVATE-SECRET");
    expect(f.adapter.peek(firstHost).transcript).toEqual([]); expect(second.generation).toBe(2);
    const replay = await f.c.openSession({ role_id: "alpha", creation_key: "first-alpha" });
    expect(replay).toMatchObject({ session_id: f.alpha.session_id, generation: 1, instance_state: "superseded" });
    const resumed = await f.c.resumeSession({ session_id: f.alpha.session_id }); expect(resumed).toMatchObject({ generation: 1, resumed: true, method: "native" });
    const local = testingOpenPrimarySession(f.c, { role_id: "beta" });
    expect(await f.c.resumeSession({ session_id: local.session_id })).toMatchObject({ resumed: false, method: null, generation: 2 });
  });
  it.each([false, true])("recovers persisted provisioning before/after external create (%s) with immutable payload", async (created) => {
    const f = await fixture(); await publish(f, "RECOVER-KNOWLEDGE");
    const prep = prepareHandoff(f.store, { session_id: f.alpha.session_id });
    f.store.prepare("UPDATE bootstrap_bundles SET creation_key = 'recover-key' WHERE bundle_id = ?").run(prep.bundle_id);
    f.store.prepare("INSERT INTO sessions (id, kind, adapter, state, creation_key, created_at) VALUES ('recover-session', 'primary', 'mock', 'provisioning', 'recover-key', ?)").run(new Date().toISOString());
    if (created) await f.adapter.createSession({ creation_key: "recover-key", bootstrap: { bundle_id: prep.bundle_id, role_id: "alpha", payload: prep.payload, content_hash: prep.payload_hash } });
    f.c.close(); const c = Coordinator.open({ root: f.path, adapter: f.adapter }); handles.push(c);
    const restored = rehydratePreparation(coordinatorStore(c), prep.bundle_id);
    expect(restored.payload).toBe(prep.payload); expect(bodyHash(restored.payload)).toBe(restored.payload_hash);
    const successor = await c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "recover-key" });
    expect(successor.generation).toBe(2);
    expect(f.adapter.peek((await f.adapter.lookupSessionByCreationKey("recover-key"))!.host_session_id).bootstrap?.payload).toContain("RECOVER-KNOWLEDGE");
    expect((coordinatorStore(c).prepare("SELECT count(*) AS n FROM sessions WHERE creation_key = 'recover-key'").get() as { n: number }).n).toBe(1);
  });
  it("freezes request bodies on receipt and loads only shareable knowledge with a limited scope", async () => {
    const f = await fixture(); await publish(f, "RECEIVED-V1"); await publish(f, "SECRET", 0, "secret"); await publish(f, "ROLE-ONLY", 0, "local");
    const request = await ask(f); await publish(f, "LATER-V2", 1);
    const result = await executeRequest(f.store, f.adapter, request.request_id);
    const loaded = f.adapter.peek(host(f, `request-${request.request_id}`));
    expect(loaded.bootstrap?.payload).toContain("RECEIVED-V1"); expect(loaded.bootstrap?.payload).not.toContain("LATER-V2");
    expect(loaded.bootstrap?.payload).not.toContain("SECRET"); expect(loaded.bootstrap?.payload).not.toContain("ROLE-ONLY");
    expect(loaded.capabilityScope).toEqual(["documents.read", "documents.propose"]);
    expect(result.state).toBe("completed"); expect(loaded.closed).toBe(true);
  });
});

class BarrierAdapter extends MockHarnessAdapter {
  entered = deferred(); release = deferred();
  override async getResult(handle: AdapterSessionHandle): Promise<AdapterSessionResult> {
    const result = await super.getResult(handle);
    this.entered.resolve(); await this.release.promise; return result;
  }
}
describe("R10–R14 execution boundaries", () => {
  it.each(["context", "temp_writes", "results", "capability_scope"] as const)("rejects missing %s isolation before host spending", async (scope) => {
    const adapter = new MockHarnessAdapter({ isolation: { [scope]: false } });
    const f = await fixture(adapter); const request = await ask(f);
    await expect(executeRequest(f.store, adapter, request.request_id)).rejects.toMatchObject({ code: "ADAPTER_CAPABILITY_MISSING" });
    expect(await adapter.lookupSessionByCreationKey(`request-${request.request_id}`)).toBeNull(); expect(counts(f).slice(3)).toEqual([0, 0]);
  });
  it("checks policy at creation, execution and post-await commit", async () => {
    const f = await fixture(); grant(f, "beta", []);
    await expect(ask(f)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    grantFixtureCapabilities(f.store); const request = await ask(f); grant(f, "alpha", []);
    await expect(executeRequest(f.store, f.adapter, request.request_id)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await f.adapter.lookupSessionByCreationKey(`request-${request.request_id}`)).toBeNull();
    const barrier = new BarrierAdapter(); const f2 = await fixture(barrier); const req2 = await ask(f2);
    const executing = executeRequest(f2.store, barrier, req2.request_id); await barrier.entered.promise;
    grant(f2, "alpha", []); barrier.release.resolve(); await expect(executing).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(counts(f2).slice(3)).toEqual([0, 0]); expect(barrier.peek(host(f2, `request-${req2.request_id}`)).closed).toBe(true);
  });
  it.each(["needs_input", "completed", "budget"])("cancellation during %s response never revives terminal state", async (kind) => {
    const adapter = new BarrierAdapter(kind === "needs_input" ? { needsInputAfterTurns: 1 } : {});
    const f = await fixture(adapter); const req = await ask(f, kind, kind === "budget" ? { max_output_bytes: 0 } : undefined);
    const executing = executeRequest(f.store, adapter, req.request_id); await adapter.entered.promise;
    expect((await f.c.cancelRequest({ session_id: f.beta.session_id, request_id: req.request_id })).state).toBe("cancelled");
    adapter.release.resolve(); expect((await executing).state).toBe("cancelled");
    expect((await f.c.getRequest({ session_id: f.beta.session_id, request_id: req.request_id })).state).toBe("cancelled");
    expect(counts(f).slice(3)).toEqual([0, 0]); expect(adapter.peek(host(f, `request-${req.request_id}`)).closed).toBe(true);
  });
  it.each([false, true])("deadline crossed during result retrieval prevents completion/needs_input (%s)", async (input) => {
    const adapter = new BarrierAdapter(input ? { needsInputAfterTurns: 1 } : {}); const f = await fixture(adapter);
    const deadline = new Date(Date.now() + 3000).toISOString(); const req = await ask(f, "deadline", { deadline });
    const executing = executeRequest(f.store, adapter, req.request_id); await adapter.entered.promise;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now() + 25)));
    adapter.release.resolve(); expect((await executing).state).toBe("expired"); expect(counts(f).slice(3)).toEqual([0, 0]);
    expect(adapter.peek(host(f, `request-${req.request_id}`)).closed).toBe(true);
  });
  it("reserves turns before spending and registers actual host answer hash", async () => {
    const adapter = new MockHarnessAdapter({ needsInputAfterTurns: 1 }); const f = await fixture(adapter);
    const request = await ask(f, "budget", { max_turns: 1 });
    expect((await executeRequest(f.store, adapter, request.request_id)).state).toBe("awaiting_input");
    await f.c.replyToRequest({ session_id: f.beta.session_id, request_id: request.request_id, body: "clarification" });
    const loaded = adapter.peek(host(f, `request-${request.request_id}`)); expect(loaded.transcript).toHaveLength(1); expect(loaded.closed).toBe(true);
    expect((await f.c.getRequest({ session_id: f.beta.session_id, request_id: request.request_id })).state).toBe("failed");
    const f2 = await fixture(); const req2 = await ask(f2); const outcome = await executeRequest(f2.store, f2.adapter, req2.request_id);
    const artifact = await f2.c.readArtifact({ session_id: f2.beta.session_id, artifact_id: outcome.artifact_id });
    expect(artifact.body).toBe("ack:1"); expect(artifact.content_hash).toBe(bodyHash(artifact.body));
  });
  it("leaves running host results pending and retries terminal cleanup without rerunning", async () => {
    class AsyncAdapter extends MockHarnessAdapter {
      finished = false; closes = 0;
      override async getResult(h: AdapterSessionHandle) { const result = await super.getResult(h); return { ...result, state: this.finished ? "idle" as const : "running" as const, completed: this.finished }; }
      override async closeSession(h: AdapterSessionHandle) { this.closes++; if (this.closes === 1) throw new Error("temporary close failure"); await super.closeSession(h); }
    }
    const adapter = new AsyncAdapter(); const f = await fixture(adapter); const req = await ask(f);
    expect((await executeRequest(f.store, adapter, req.request_id)).state).toBe("running"); expect(counts(f).slice(3)).toEqual([0, 0]);
    adapter.finished = true; expect((await executeRequest(f.store, adapter, req.request_id)).state).toBe("completed");
    expect((f.store.prepare("SELECT cleanup_pending FROM requests WHERE request_id = ?").get(req.request_id) as { cleanup_pending: number }).cleanup_pending).toBe(1);
    await executeRequest(f.store, adapter, req.request_id); expect(adapter.closes).toBe(2);
    const loaded = adapter.peek(host(f, `request-${req.request_id}`)); expect(loaded.closed).toBe(true); expect(loaded.transcript).toHaveLength(1);
    expect(counts(f).slice(3)).toEqual([1, 1]);
  });
  it("reconciles a lost turn ack across coordinator restart without replaying side effects", async () => {
    class LostAck extends MockHarnessAdapter {
      once = true;
      override async runTurn(h: AdapterSessionHandle, turn: TurnInput) { const result = await super.runTurn(h, turn); if (this.once) { this.once = false; throw new Error("ack lost after side effect"); } return result; }
    }
    const adapter = new LostAck(); const f = await fixture(adapter); const request = await ask(f);
    await expect(executeRequest(f.store, adapter, request.request_id)).rejects.toThrow("ack lost");
    expect(await f.c.getRequest({ session_id: f.beta.session_id, request_id: request.request_id })).toMatchObject({ state: "running", execution_uncertain: true });
    f.c.close(); const c = Coordinator.open({ root: f.path, adapter }); handles.push(c);
    expect((await executeRequest(coordinatorStore(c), adapter, request.request_id)).state).toBe("completed");
    const loaded = adapter.peek(host({ ...f, store: coordinatorStore(c) }, `request-${request.request_id}`)); expect(loaded.transcript).toHaveLength(1);
  });
  it("uses bound lookup for uncertain creates and preserves explicit uncertainty without lookup", async () => {
    class UncertainRequest extends MockHarnessAdapter {
      override async createSession(input: CreateSessionInput) {
        const handle = await super.createSession(input);
        if (input.creation_key.startsWith("request-")) {
          const { RoleDockError } = await import("@roledock/protocol");
          throw new RoleDockError("INTERNAL", "create ack lost", { details: { uncertain: true } });
        }
        return handle;
      }
    }
    const adapter = new UncertainRequest(); const f = await fixture(adapter); const req = await ask(f);
    expect((await executeRequest(f.store, adapter, req.request_id)).state).toBe("completed");
    const noLookup = new UncertainRequest({ optional: { lookup_session_by_creation_key: false } }); const f2 = await fixture(noLookup); const req2 = await ask(f2);
    await expect(executeRequest(f2.store, noLookup, req2.request_id)).rejects.toThrow("ack lost");
    expect(await f2.c.getRequest({ session_id: f2.beta.session_id, request_id: req2.request_id })).toMatchObject({ state: "running", execution_uncertain: true });
    await expect(executeRequest(f2.store, noLookup, req2.request_id)).rejects.toMatchObject({ code: "ADAPTER_CAPABILITY_MISSING" });
    expect(noLookup.peek(host(f2, "first-alpha")).transcript).toEqual([]);
  });
  it("proves ten overlapping independent requests and overlapping duplicate deliveries", async () => {
    class Overlap extends MockHarnessAdapter {
      allEntered = deferred(); release = deferred(); count = 0; creates = 0;
      private inputs = new Map<string, CreateSessionInput>();
      override async createSession(input: CreateSessionInput) { const h = await super.createSession(input); this.inputs.set(h.host_session_id, input); if (input.creation_key.startsWith("request-")) this.creates++; return h; }
      override async runTurn(h: AdapterSessionHandle, turn: TurnInput) {
        const input = this.inputs.get(h.host_session_id)!; writeFileSync(join(input.temp_dir!, "marker"), turn.message);
        this.count++; if (this.count === 10) this.allEntered.resolve(); await this.release.promise;
        return super.runTurn(h, turn);
      }
    }
    const adapter = new Overlap(); const f = await fixture(adapter);
    const reqs = []; for (let i = 0; i < 10; i++) reqs.push(await ask(f, `overlap-${i}`));
    const operations = reqs.map((req) => executeRequest(f.store, adapter, req.request_id));
    const duplicate = executeRequest(f.store, adapter, reqs[0]!.request_id);
    await adapter.allEntered.promise; expect(adapter.count).toBe(10); expect(adapter.creates).toBe(10);
    for (const req of reqs) {
      const loaded = adapter.peek(host(f, `request-${req.request_id}`));
      const input = JSON.parse(loaded.bootstrap!.payload) as { question: string };
      expect(readFileSync(join(loaded.tempDir!, "marker"), "utf8")).toBe(input.question);
    }
    adapter.release.resolve(); const results = await Promise.all(operations); expect(await duplicate).toEqual(results[0]);
    expect(results.every((result) => result.state === "completed")).toBe(true);
    expect(new Set(results.map((result) => result.artifact_id)).size).toBe(10); expect(counts(f).slice(3)).toEqual([10, 10]);
    const hostIds = reqs.map((req) => host(f, `request-${req.request_id}`)); expect(new Set(hostIds).size).toBe(10);
    for (let i = 0; i < 10; i++) {
      const loaded = adapter.peek(hostIds[i]!); expect(loaded.transcript).toEqual([`question:overlap-${i}`]);
      expect(loaded.capabilityScope).toEqual(["documents.read", "documents.propose"]); expect(loaded.closed).toBe(true);
    }
    expect(adapter.peek(host(f, "first-alpha")).transcript).toEqual([]); expect(adapter.peek(host(f, "first-beta")).transcript).toEqual([]);
  });
});

describe("additional independent-review counterexamples", () => {
  it.each([false, true])("reclaims cancelled waiting hosts after cancel failure, preserving retry when close also fails (%s)", async (closeFails) => {
    class CancelFailure extends MockHarnessAdapter {
      closes = 0;
      override async cancel() { throw new Error("cancel transport failure"); }
      override async closeSession(handle: AdapterSessionHandle) {
        this.closes++;
        if (closeFails && this.closes === 1) throw new Error("close transport failure");
        return super.closeSession(handle);
      }
    }
    const adapter = new CancelFailure({ needsInputAfterTurns: 1 }); const f = await fixture(adapter); const req = await ask(f);
    expect((await executeRequest(f.store, adapter, req.request_id)).state).toBe("awaiting_input");
    expect((await f.c.cancelRequest({ session_id: f.beta.session_id, request_id: req.request_id })).state).toBe("cancelled");
    const pending = () => (f.store.prepare("SELECT cleanup_pending FROM requests WHERE request_id = ?").get(req.request_id) as { cleanup_pending: number }).cleanup_pending;
    expect(pending()).toBe(closeFails ? 1 : 0);
    expect(adapter.peek(host(f, `request-${req.request_id}`)).closed).toBe(!closeFails);
    expect((await executeRequest(f.store, adapter, req.request_id)).state).toBe("cancelled");
    expect(pending()).toBe(0);
    expect(adapter.peek(host(f, `request-${req.request_id}`))).toMatchObject({ closed: true, transcript: [`question:ask`] });
    expect(counts(f).slice(3)).toEqual([0, 0]);
  });
  it("keeps branch listing and proposal baseline fixed after a newer publish", async () => {
    const adapter = new MockHarnessAdapter({ needsInputAfterTurns: 1 }); const f = await fixture(adapter);
    await publish(f, "V1"); const req = await ask(f); await executeRequest(f.store, adapter, req.request_id); await publish(f, "V2", 1);
    const branch = (f.store.prepare("SELECT id FROM sessions WHERE creation_key = ?").get(`request-${req.request_id}`) as { id: string }).id;
    expect((await f.c.listDocuments({ session_id: branch })).documents).toMatchObject([{ document_key: "state", latest_revision: 1 }]);
    expect((await f.c.readDocument({ session_id: branch, document_key: "state" })).body).toBe("V1");
    const proposal = await f.c.proposeDocumentUpdate({ session_id: branch, target_role_id: "alpha", document_key: "state", body: "EDIT-OF-V1" });
    expect(proposal.baseline_revision).toBe(1);
    await expect(f.c.proposeDocumentUpdate({ session_id: branch, target_role_id: "alpha", document_key: "state", body: "EDIT-OF-V1", baseline_revision: 2 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(f.c.publishDocument({ session_id: f.alpha.session_id, document_key: "state", body: "ignored", expected_revision: 2, expected_generation: 1, candidate_id: proposal.candidate_id })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await f.c.listDocuments({ session_id: branch, role_id: "beta" })).documents).toEqual([]);
  });
  it.each(["refused", "missing-body"])("records %s as a known failure and closes host", async (kind) => {
    class InvalidResult extends MockHarnessAdapter {
      override async runTurn(h: AdapterSessionHandle, turn: TurnInput) {
        if (kind === "refused") return { host_session_id: h.host_session_id, accepted: false };
        return super.runTurn(h, turn);
      }
      override async getResult(h: AdapterSessionHandle) { const result = await super.getResult(h); return { ...result, body: undefined }; }
    }
    const adapter = new InvalidResult(); const f = await fixture(adapter); const req = await ask(f);
    await expect(executeRequest(f.store, adapter, req.request_id)).rejects.toMatchObject({ code: kind === "refused" ? "INVALID_STATE_TRANSITION" : "NOT_IMPLEMENTED" });
    expect(await f.c.getRequest({ session_id: f.beta.session_id, request_id: req.request_id })).toMatchObject({ state: "failed" });
    expect(adapter.peek(host(f, `request-${req.request_id}`)).closed).toBe(true); expect(counts(f).slice(3)).toEqual([0, 0]);
  });
  it("lazy expiry of a waiting request also reclaims its host", async () => {
    const adapter = new MockHarnessAdapter({ needsInputAfterTurns: 1 }); const f = await fixture(adapter);
    const deadline = new Date(Date.now() + 3000).toISOString(); const req = await ask(f, "lazy-expiry", { deadline });
    expect((await executeRequest(f.store, adapter, req.request_id)).state).toBe("awaiting_input");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now() + 25)));
    expect((await f.c.getRequest({ session_id: f.beta.session_id, request_id: req.request_id })).state).toBe("expired");
    expect(adapter.peek(host(f, `request-${req.request_id}`)).closed).toBe(true);
    expect((f.store.prepare("SELECT cleanup_pending FROM requests WHERE request_id = ?").get(req.request_id) as { cleanup_pending: number }).cleanup_pending).toBe(0);
  });
  it("keeps logical open idempotency when knowledge drifts during host creation", async () => {
    class Drift extends MockHarnessAdapter {
      callback: (() => Promise<void>) | undefined;
      override async createSession(input: CreateSessionInput) { const h = await super.createSession(input); if (input.creation_key.startsWith("provision-") && this.callback) { const callback = this.callback; this.callback = undefined; await callback(); } return h; }
    }
    const adapter = new Drift(); const f = await fixture(adapter); await publish(f, "V1"); adapter.callback = () => publish(f, "V2", 1).then(() => undefined);
    const next = await f.c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "drifting-open" });
    expect(next).toMatchObject({ generation: 2, handoff: { reprepared: true } });
    const replay = await f.c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "drifting-open" });
    expect(replay.session_id).toBe(next.session_id); expect(replay.generation).toBe(2);
    expect(adapter.peek(host(f, "drifting-open")).bootstrap?.payload).toContain("V2");
  });
  it("does not reuse another initiator's request idempotency key", async () => {
    const f = await fixture(); const input = { target_role_id: "alpha", question: "same", idempotency_key: "shared-key", read_exception_rationale: "gap" };
    await f.c.createRequest({ ...input, session_id: f.beta.session_id });
    await expect(f.c.createRequest({ ...input, session_id: f.alpha.session_id })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

it("user session keys cannot collide with internal request hosts or inject primary history", async () => {
  const f = await fixture(); const req = await ask(f);
  const source = join(f.path, "third-pack"); writePack({ dir: source, name: "third-pack", roles: [{ id: "gamma" }] });
  await f.c.installRolePack({ source_path: source }); grantFixtureCapabilities(f.store);
  const third = await f.c.openSession({ role_id: "gamma", creation_key: `request-${req.request_id}` });
  const thirdHost = (f.store.prepare("SELECT host_session_ref FROM sessions WHERE id = ?").get(third.session_id) as { host_session_ref: string }).host_session_ref;
  expect((await executeRequest(f.store, f.adapter, req.request_id)).state).toBe("completed");
  expect(f.adapter.peek(thirdHost)).toMatchObject({ transcript: [], closed: false });
  const consultation = f.store.prepare("SELECT kind, role_id FROM sessions WHERE creation_key = ?").get(`request-${req.request_id}`);
  expect(consultation).toMatchObject({ kind: "request", role_id: "alpha" });
});

it("cancelling a migrated legacy key collision cannot cancel or close a primary host", async () => {
  class CountingCancel extends MockHarnessAdapter {
    cancellations = 0;
    override async cancel(handle: AdapterSessionHandle) { this.cancellations++; return super.cancel(handle); }
  }
  const adapter = new CountingCancel(); const f = await fixture(adapter); const req = await ask(f);
  const primaryHost = host(f, "first-alpha");
  // Pre-migration callers could choose a host creation key directly. Model
  // that legacy binding, without sending request material to the main host.
  f.store.prepare("UPDATE sessions SET creation_key = ?, open_key = NULL WHERE id = ?").run(`request-${req.request_id}`, f.alpha.session_id);
  f.store.prepare("UPDATE requests SET state = 'running' WHERE request_id = ?").run(req.request_id);
  expect((await f.c.cancelRequest({ session_id: f.beta.session_id, request_id: req.request_id })).state).toBe("cancelled");
  expect(f.adapter.peek(primaryHost)).toMatchObject({ transcript: [], closed: false });
  expect(adapter.cancellations).toBe(0);
  expect((f.store.prepare("SELECT cleanup_pending FROM requests WHERE request_id = ?").get(req.request_id) as { cleanup_pending: number }).cleanup_pending).toBe(1);
});
