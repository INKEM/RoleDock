import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator } from "../src/index.js";
import { installRolePack } from "../src/testing.js";
import type { WorkspaceStore } from "../src/store/workspace.js";
import { coordinatorStore } from "../src/internal-store.js";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { isRoleDockError } from "@roledock/protocol";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-handoff-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  store: WorkspaceStore;
  adapter: MockHarnessAdapter;
  coordinator: Coordinator;
}

function setup(options: { adapter?: MockHarnessAdapter } = {}): Fixture {
  const root = makeRoot();
  const adapter = options.adapter ?? new MockHarnessAdapter();
  const coordinator = Coordinator.open({ root, adapter });
  const packDir = join(root, "pack");
  writePack({ dir: packDir, name: "handoff-pack", roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }] }] });
  installRolePack(coordinatorStore(coordinator), { sourcePath: packDir });
  grantFixtureCapabilities(coordinatorStore(coordinator));
  return { root, store: coordinatorStore(coordinator), adapter, coordinator };
}

function headOf(store: WorkspaceStore, roleId: string): { generation: number; current_instance_id: string | null; knowledge_revision: number } {
  return store.prepare("SELECT generation, current_instance_id, knowledge_revision FROM role_heads WHERE role_id = ?").get(roleId) as never;
}

describe("sessions.open — first and second creation", () => {
  it("initializes generation 1 without a handoff, then inherits as generation 2 with correct references", async () => {
    const workspace = setup();
    const { coordinator, store } = workspace;
    // Publish knowledge so the bundle has something to freeze.
    const first = await coordinator.openSession({ role_id: "keeper" });
    expect(first).toMatchObject({ role_id: "keeper", generation: 1, handoff: { performed: false } });
    expect(first.predecessor_instance_id).toBeUndefined();
    await coordinator.publishDocument({
      session_id: first.session_id,
      document_key: "state",
      body: "state v1",
      expected_revision: 0,
      expected_generation: 1,
    });
    const headBefore = headOf(store, "keeper");
    expect(headBefore.knowledge_revision).toBe(1);

    const second = await coordinator.openSession({ role_id: "keeper", inherit: "latest" });
    expect(second).toMatchObject({
      generation: 2,
      predecessor_instance_id: first.instance_id,
      handoff: { performed: true },
    });
    expect(second.handoff.reprepared).toBeUndefined();
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.instance_id).not.toBe(first.instance_id);

    // Knowledge references: the bundle froze the pre-handoff generation and
    // knowledge revision, and points at the prepared checkpoint.
    const bundle = store
      .prepare("SELECT * FROM bootstrap_bundles WHERE bundle_id = ?")
      .get(second.handoff.bundle_id ?? "") as {
      source_generation: number;
      source_knowledge_revision: number;
      checkpoint_id: string;
      contract_package_name: string;
      contract_package_version: string;
      state: string;
    };
    expect(bundle.source_generation).toBe(1);
    expect(bundle.source_knowledge_revision).toBe(1);
    expect(bundle.checkpoint_id).toBeTruthy();
    expect(bundle.state).toBe("activated");

    // Unique primary pointer: exactly one active instance.
    const instances = store
      .prepare("SELECT id, generation, state, predecessor_instance_id FROM agent_instances WHERE role_id = 'keeper' ORDER BY generation")
      .all() as Array<{ id: string; generation: number; state: string; predecessor_instance_id: string | null }>;
    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({ generation: 1, state: "superseded" });
    expect(instances[1]).toMatchObject({ generation: 2, state: "active", predecessor_instance_id: first.instance_id });
    const head = headOf(store, "keeper");
    expect(head).toMatchObject({ generation: 2, current_instance_id: second.instance_id });
    coordinator.close();
  });

  it("requires inherit=latest on an initialized role and rejects consultation sessions as primary", async () => {
    const workspace = setup();
    const { coordinator, store } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    try {
      await coordinator.openSession({ role_id: "keeper" });
      expect.unreachable("expected VALIDATION_FAILED");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("VALIDATION_FAILED");
    }
    // A consultation-kind session must never become a primary instance.
    store
      .prepare(
        "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, creation_key, created_at) VALUES ('sess-consult-1', 'request', 'test', 'active', 'keeper', NULL, NULL, '2026-10-13T00:00:00Z')",
      )
      .run();
    // The consultation session has no path into the handoff surface: prepare
    // requires a session bound to the current primary instance.
    try {
      await coordinator.prepareHandoff({ session_id: "sess-consult-1" });
      expect.unreachable("expected INVALID_STATE_TRANSITION");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("INVALID_STATE_TRANSITION");
    }
    // And the consultation session row never gains a primary binding.
    const consult = store
      .prepare("SELECT kind, state, instance_id FROM sessions WHERE id = 'sess-consult-1'")
      .get() as { kind: string; state: string; instance_id: string | null };
    expect(consult).toMatchObject({ kind: "request", instance_id: null });
    coordinator.close();
  });
});

describe("handoff failure and recovery modes", () => {
  it("re-prepares when knowledge changes during preparation", async () => {
    const workspace = setup();
    const { coordinator, store, adapter } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    await coordinator.publishDocument({
      session_id: first.session_id,
      document_key: "state",
      body: "v1",
      expected_revision: 0,
      expected_generation: 1,
    });

    // Prepare manually, then drift knowledge, then let the orchestration
    // path re-prepare automatically.
    const stale = await coordinator.prepareHandoff({ session_id: first.session_id });
    await coordinator.publishDocument({
      session_id: first.session_id,
      document_key: "state",
      body: "v2",
      expected_revision: 1,
      expected_generation: 1,
    });

    const opened = await coordinator.openSession({ role_id: "keeper", inherit: "latest" });
    expect(opened.generation).toBe(2);
    expect(opened.handoff.performed).toBe(true);
    // The orchestration prepared a fresh bundle (different from the stale one).
    expect(opened.handoff.bundle_id).not.toBe(stale.bundle_id);
    const bundle = store
      .prepare("SELECT source_knowledge_revision, state FROM bootstrap_bundles WHERE bundle_id = ?")
      .get(opened.handoff.bundle_id ?? "") as { source_knowledge_revision: number; state: string };
    expect(bundle.source_knowledge_revision).toBe(2);
    expect(bundle.state).toBe("activated");
    // The stale bundle was never provisioned; the orchestration's fresh one
    // carries the new knowledge revision.
    const staleRow = store
      .prepare("SELECT state FROM bootstrap_bundles WHERE bundle_id = ?")
      .get(stale.bundle_id) as { state: string };
    expect(staleRow.state).toBe("prepared");
    const bundleCount = store
      .prepare("SELECT count(*) AS n FROM bootstrap_bundles WHERE role_id = 'keeper'")
      .get() as { n: number };
    expect(bundleCount.n).toBe(2); // stale + fresh
    coordinator.close();
  });

  it("keeps the old primary pointer when the adapter fails to create the host", async () => {
    class FailingSuccessor extends MockHarnessAdapter {
      override async createSession(input: Parameters<MockHarnessAdapter["createSession"]>[0]) {
        if (input.creation_key.startsWith("provision-")) throw new (await import("@roledock/protocol")).RoleDockError("INTERNAL", "hard create failure");
        return super.createSession(input);
      }
    }
    const workspace = setup({ adapter: new FailingSuccessor() });
    const { coordinator, store } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    await coordinator.publishDocument({
      session_id: first.session_id,
      document_key: "state",
      body: "v1",
      expected_revision: 0,
      expected_generation: 1,
    });
    try {
      await coordinator.openSession({ role_id: "keeper", inherit: "latest" });
      expect.unreachable("expected INTERNAL from adapter failure");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("INTERNAL");
      if (isRoleDockError(error)) {
        expect((error.details as { stage?: string }).stage).toBe("provision");
      }
    }
    // Old primary pointer untouched.
    const head = headOf(store, "keeper");
    expect(head).toMatchObject({ generation: 1, current_instance_id: first.instance_id });
    const bundle = store
      .prepare("SELECT state FROM bootstrap_bundles ORDER BY created_at DESC LIMIT 1")
      .get() as { state: string };
    expect(bundle.state).toBe("abandoned");
    coordinator.close();
  });

  it("does not blindly recreate sessions on uncertain creation; recovery honors capability", async () => {
    // Without a creation-key lookup: the uncertain session is recorded and
    // the structured error explains recovery; retries create nothing new.
    class UncertainSuccessor extends MockHarnessAdapter {
      override async createSession(input: Parameters<MockHarnessAdapter["createSession"]>[0]) {
        const handle = await super.createSession(input);
        if (input.creation_key.startsWith("provision-")) throw new (await import("@roledock/protocol")).RoleDockError("INTERNAL", "lost create ack", { details: { uncertain: true } });
        return handle;
      }
    }
    const noLookup = new UncertainSuccessor({ optional: { lookup_session_by_creation_key: false } });
    const workspace = setup({ adapter: noLookup });
    const { coordinator, store } = workspace;
    await coordinator.openSession({ role_id: "keeper" });
    try {
      await coordinator.openSession({ role_id: "keeper", inherit: "latest", creation_key: "open-1" });
      expect.unreachable("expected ADAPTER_CAPABILITY_MISSING");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("ADAPTER_CAPABILITY_MISSING");
      if (isRoleDockError(error)) {
        expect((error.details as { execution_uncertain?: boolean }).execution_uncertain).toBe(true);
      }
    }
    const sessions = store
      .prepare("SELECT id, state FROM sessions WHERE open_key = 'open-1'")
      .all() as Array<{ id: string; state: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe("uncertain");
    // A retry reconciles by creation key and still cannot confirm the host:
    // no duplicate session appears.
    try {
      await coordinator.openSession({ role_id: "keeper", inherit: "latest", creation_key: "open-1" });
      expect.unreachable("expected ADAPTER_CAPABILITY_MISSING again");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("ADAPTER_CAPABILITY_MISSING");
    }
    const afterRetry = store
      .prepare("SELECT count(*) AS n FROM sessions WHERE open_key = 'open-1'")
      .get() as { n: number };
    expect(afterRetry.n).toBe(1);
    coordinator.close();

    // With lookup capability: the uncertain outcome is recovered inline from
    // the creation key — the handoff completes with exactly one host session.
    const recovering = new MockHarnessAdapter({ uncertainCreateTimes: 1 });
    const root2 = makeRoot();
    const coordinator2 = Coordinator.open({ root: root2, adapter: recovering });
    const packDir = join(root2, "pack");
    writePack({ dir: packDir, name: "handoff-pack", roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }] }] });
    installRolePack(coordinatorStore(coordinator2), { sourcePath: packDir });
  grantFixtureCapabilities(coordinatorStore(coordinator2));
    await coordinator2.openSession({ role_id: "keeper" });
    const opened = await coordinator2.openSession({ role_id: "keeper", inherit: "latest", creation_key: "open-2" });
    expect(opened).toMatchObject({ generation: 2, handoff: { performed: true } });
    const hostSessions = coordinatorStore(coordinator2)
      .prepare("SELECT count(*) AS n FROM sessions WHERE open_key = 'open-2'")
      .get() as { n: number };
    expect(hostSessions.n).toBe(1);
    // Same key again: idempotent — the original session comes back.
    const again = await coordinator2.openSession({ role_id: "keeper", inherit: "latest", creation_key: "open-2" });
    expect(again.session_id).toBe(opened.session_id);
    coordinator2.close();
  });

  it("is idempotent on the same creation key for the initialize path", async () => {
    const workspace = setup();
    const { coordinator } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper", creation_key: "init-1" });
    const again = await coordinator.openSession({ role_id: "keeper", creation_key: "init-1" });
    expect(again.session_id).toBe(first.session_id);
    expect(again.instance_id).toBe(first.instance_id);
    coordinator.close();
  });
});

describe("concurrent activation and successor rights", () => {
  it("lets exactly one activation win; the loser gets GENERATION_CONFLICT and cannot publish", async () => {
    const workspace = setup();
    const { coordinator, store } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    await coordinator.publishDocument({
      session_id: first.session_id,
      document_key: "state",
      body: "v1",
      expected_revision: 0,
      expected_generation: 1,
    });

    // Two successors prepare against the same head.
    const bundleA = await coordinator.prepareHandoff({ session_id: first.session_id });
    const bundleB = await coordinator.prepareHandoff({ session_id: first.session_id });
    const { provisionHandoff } = await import("../src/sessions/handoff.js");
    const adapter = workspace.adapter;
    const toPrep = (bundle: Awaited<ReturnType<typeof coordinator.prepareHandoff>>) => ({
      bundle_id: bundle.bundle_id,
      role_id: bundle.role_id,
      source_generation: bundle.source_generation,
      source_knowledge_revision: bundle.source_knowledge_revision,
      checkpoint_id: bundle.checkpoint_id,
      payload: bundle.payload,
      payload_hash: bundle.payload_hash,
      creation_key: `provision-${bundle.bundle_id}`,
    });
    await provisionHandoff(store, adapter, toPrep(bundleA));
    await provisionHandoff(store, adapter, toPrep(bundleB));

    // Successor B activates first and wins.
    const winner = await coordinator.activateHandoff({ bundle_id: bundleB.bundle_id });
    expect(winner.generation).toBe(2);
    // Successor A's activation fails: the pointer moved.
    try {
      await coordinator.activateHandoff({ bundle_id: bundleA.bundle_id });
      expect.unreachable("expected GENERATION_CONFLICT");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("GENERATION_CONFLICT");
    }

    // The old instance (predecessor) can no longer publish.
    try {
      await coordinator.publishDocument({
        session_id: first.session_id,
        document_key: "state",
        body: "from the superseded instance",
        expected_revision: 1,
        expected_generation: 1,
      });
      expect.unreachable("expected INVALID_STATE_TRANSITION");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("INVALID_STATE_TRANSITION");
    }

    // Exactly one generation-2 instance exists.
    const gen2 = store
      .prepare("SELECT count(*) AS n FROM agent_instances WHERE role_id = 'keeper' AND generation = 2")
      .get() as { n: number };
    expect(gen2.n).toBe(1);
    coordinator.close();
  });

  it("keeps predecessor sessions and host transcripts unpolluted by the handoff", async () => {
    const workspace = setup();
    const { coordinator, store, adapter } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    // Give the predecessor a live host session and a user turn.
    const host = await adapter.createSession({ creation_key: "user-host-1" });
    await adapter.runTurn(host, { message: "user's own work — must not receive handoff instructions" });
    store
      .prepare("UPDATE sessions SET host_session_ref = ? WHERE id = ?")
      .run(host.host_session_id, first.session_id);

    const before = adapter.peek(host.host_session_id);
    expect(before.transcript).toHaveLength(1);

    await coordinator.openSession({ role_id: "keeper", inherit: "latest" });
    // The old session's row and host transcript are exactly as before: the
    // core never injects handoff instructions into a predecessor session.
    const after = adapter.peek(host.host_session_id);
    expect(after.transcript).toEqual(before.transcript);
    const oldSession = store
      .prepare("SELECT state, role_id, instance_id FROM sessions WHERE id = ?")
      .get(first.session_id) as { state: string; role_id: string; instance_id: string };
    expect(oldSession).toMatchObject({ state: "active", role_id: "keeper", instance_id: first.instance_id });
    // And the successor's host received the bootstrap, not the old chat.
    const successorHost = store
      .prepare("SELECT host_session_ref FROM sessions WHERE state = 'active' AND instance_id = ?")
      .get((headOf(store, "keeper").current_instance_id ?? "")) as { host_session_ref: string | null };
    const successorPeek = adapter.peek(successorHost.host_session_ref ?? "");
    expect(successorPeek.bootstrap?.role_id).toBe("keeper");
    expect(successorPeek.transcript).toHaveLength(0);
  });
});

describe("sessions.resume", () => {
  it("resumes natively without advancing the generation when the adapter declares it", async () => {
    const workspace = setup();
    const { coordinator, store } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    const resumed = await coordinator.resumeSession({ session_id: first.session_id });
    expect(resumed).toMatchObject({ resumed: true, method: "native", generation: 1, session_id: first.session_id });
    const head = headOf(store, "keeper");
    expect(head.generation).toBe(1);
    coordinator.close();
  });

  it("points at semantic inheritance when the adapter lacks native resume", async () => {
    const workspace = setup({ adapter: new MockHarnessAdapter({ optional: { native_resume: false } }) });
    const { coordinator, store } = workspace;
    const first = await coordinator.openSession({ role_id: "keeper" });
    const result = await coordinator.resumeSession({ session_id: first.session_id });
    expect(result).toMatchObject({
      resumed: false,
      method: null,
      generation: 1,
      alternative: "open a new primary session with inherit=latest for semantic inheritance",
    });
    const head = headOf(store, "keeper");
    expect(head.generation).toBe(1);
    coordinator.close();
  });

  it("rejects unknown sessions", async () => {
    const workspace = setup();
    const { coordinator } = workspace;
    try {
      await coordinator.resumeSession({ session_id: "sess-ghost" });
      expect.unreachable("expected NOT_FOUND");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("NOT_FOUND");
    }
    coordinator.close();
  });
});

describe("role contract freezing", () => {
  it("freezes the role's registered pack contract into the bundle", async () => {
    const workspace = setup();
    const { coordinator, store } = workspace;
    await coordinator.openSession({ role_id: "keeper" });
    const opened = await coordinator.openSession({ role_id: "keeper", inherit: "latest" });
    const bundle = store
      .prepare("SELECT contract_package_name, contract_package_version, contract_content_hash FROM bootstrap_bundles WHERE bundle_id = ?")
      .get(opened.handoff.bundle_id ?? "") as {
      contract_package_name: string;
      contract_package_version: string;
      contract_content_hash: string;
    };
    expect(bundle).toMatchObject({
      contract_package_name: "handoff-pack",
      contract_package_version: "0.1.0",
      contract_content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // Installing a different version does not move the role's registration
    // (P1 installer rejects role id collisions), so a successor's contract
    // stays the frozen one — old sessions never silently change duties.
    coordinator.close();
  });
});
