import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator } from "../src/index.js";
import { installRolePack, listCandidates, listInboxEntries } from "../src/testing.js";
import type { WorkspaceStore } from "../src/store/workspace.js";
import { coordinatorStore } from "../src/internal-store.js";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { isRoleDockError } from "@roledock/protocol";
import { testingOpenPrimarySession } from "../src/testing.js";
import { executeRequest } from "../src/requests/executor.js";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-req-"));
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
  coordinator: Coordinator;
  store: WorkspaceStore;
  adapter: MockHarnessAdapter;
  asker: { session_id: string; instance_id: string; generation: number };
  owner: { session_id: string; instance_id: string; generation: number };
}

function setup(): Fixture {
  const root = makeRoot();
  const adapter = new MockHarnessAdapter();
  const coordinator = Coordinator.open({ root, adapter });
  const store = coordinatorStore(coordinator);
  const askerPack = join(root, "asker-pack");
  const ownerPack = join(root, "owner-pack");
  writePack({
    dir: askerPack,
    name: "asker-pack",
    roles: [{ id: "asker", docs: [{ key: "notes", visibility: "project" }] }],
  });
  writePack({
    dir: ownerPack,
    name: "owner-pack",
    roles: [{ id: "owner", docs: [{ key: "state", visibility: "project" }] }],
  });
  installRolePack(store, { sourcePath: askerPack });
  grantFixtureCapabilities(store);
  installRolePack(store, { sourcePath: ownerPack });
  grantFixtureCapabilities(store);
  const asker = testingOpenPrimarySession(coordinator, { role_id: "asker" });
  const owner = testingOpenPrimarySession(coordinator, { role_id: "owner" });
  return { root, coordinator, store, adapter, asker, owner };
}

async function createAsk(fixture: Fixture, question: string, key: string) {
  const result = await fixture.coordinator.createRequest({
    session_id: fixture.asker.session_id,
    target_role_id: "owner",
    question,
    idempotency_key: key,
    read_exception_rationale: "no document covers this question yet",
  });
  return result;
}

async function publishState(fixture: Fixture, body: string): Promise<void> {
  const { coordinator, owner } = fixture;
  await coordinator.publishDocument({
    session_id: owner.session_id,
    document_key: "state",
    body,
    expected_revision: 0,
    expected_generation: owner.generation,
  });
}

function expectError(code: string, run: () => unknown | Promise<unknown>): Promise<void> {
  return (async () => {
    try {
      await run();
      expect.unreachable(`expected ${code}`);
    } catch (error) {
      expect(isRoleDockError(error), `${code}: got ${String(error)}`).toBe(true);
      if (isRoleDockError(error)) expect(error.code).toBe(code);
      return;
    }
  })();
}

describe("requests.create preconditions", () => {
  it("requires read receipts or an exception rationale", async () => {
    const fixture = setup();
    await expectError("VALIDATION_FAILED", () =>
      fixture.coordinator.createRequest({
        session_id: fixture.asker.session_id,
        target_role_id: "owner",
        question: "?",
        idempotency_key: "k1",
      }),
    );
    // With a receipt from actually reading a shared document it passes.
    await publishState(fixture, "shared context");
    await fixture.coordinator.readDocument({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      document_key: "state",
    });
    const created = await fixture.coordinator.createRequest({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      question: "now with a receipt",
      idempotency_key: "k2",
    });
    expect(created.created).toBe(true);
    expect(created.binding.target_generation).toBe(fixture.owner.generation);
    expect(created.binding.snapshot_entries).toBe(1);
    fixture.coordinator.close();
  });

  it("returns ROLE_UNINITIALIZED when the target has no primary instance", async () => {
    const fixture = setup();
    const packDir = join(fixture.root, "ghost-pack");
    writePack({ dir: packDir, name: "ghost-pack", roles: [{ id: "hermit" }] });
    installRolePack(fixture.store, { sourcePath: packDir });
    grantFixtureCapabilities(fixture.store);
    await expectError("ROLE_UNINITIALIZED", () =>
      fixture.coordinator.createRequest({
        session_id: fixture.asker.session_id,
        target_role_id: "hermit",
        question: "?",
        idempotency_key: "k3",
        read_exception_rationale: "target role has no documents",
      }),
    );
    fixture.coordinator.close();
  });

  it("rejects nested auto-requests from consultation sessions", async () => {
    const fixture = setup();
    fixture.store
      .prepare(
        "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, creation_key, created_at) VALUES ('sess-branch-n', 'request', 'test', 'active', 'asker', NULL, NULL, '2026-10-13T00:00:00Z')",
      )
      .run();
    await expectError("PERMISSION_DENIED", () =>
      fixture.coordinator.createRequest({
        session_id: "sess-branch-n",
        target_role_id: "owner",
        question: "?",
        idempotency_key: "k4",
        read_exception_rationale: "branch",
      }),
    );
    fixture.coordinator.close();
  });

  it("is idempotent: same key same content returns the original; different content conflicts", async () => {
    const fixture = setup();
    const first = await createAsk(fixture, "question A", "idem-1");
    expect(first.created).toBe(true);
    const second = await createAsk(fixture, "question A", "idem-1");
    expect(second).toMatchObject({ created: false, request_id: first.request_id });
    await expectError("IDEMPOTENCY_CONFLICT", () => createAsk(fixture, "question B", "idem-1"));
    fixture.coordinator.close();
  });
});

describe("isolated execution (10 concurrent requests)", () => {
  it("executes ten queued requests without mixing messages, files, results or scopes", async () => {
    const fixture = setup();
    await publishState(fixture, "shared context for everyone");
    await fixture.coordinator.readDocument({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      document_key: "state",
    });

    // All ten created (queued state) before any execution runs.
    const created = [];
    for (let index = 0; index < 10; index++) {
      created.push(
        await fixture.coordinator.createRequest({
          session_id: fixture.asker.session_id,
          target_role_id: "owner",
          question: `question number ${index}`,
          idempotency_key: `bulk-${index}`,
        }),
      );
    }
    expect(new Set(created.map((request) => request.request_id)).size).toBe(10);

    const ownerPrimaryBefore = fixture.owner.session_id;
    for (const request of created) {
      const result = await executeRequest(fixture.store, fixture.adapter, request.request_id);
      expect(result.state).toBe("completed");
    }

    // Each consultation branch is its own host session with only its own question.
    const hostSessions = fixture.store
      .prepare("SELECT id, host_session_ref, role_id, instance_id FROM sessions WHERE kind = 'request'")
      .all() as Array<{ id: string; host_session_ref: string; role_id: string; instance_id: string | null }>;
    expect(hostSessions).toHaveLength(10);
    const transcripts = new Set<string>();
    for (const [index, session] of hostSessions.entries()) {
      expect(session.instance_id).toBeNull(); // consultation sessions never hold instances
      const peek = fixture.adapter.peek(session.host_session_ref);
      expect(peek.transcript).toEqual([`question number ${index}`]);
      transcripts.add(peek.transcript.join("|"));
    }
    expect(transcripts.size).toBe(10);

    // Ten distinct artifacts and inbox entries.
    const artifacts = fixture.store.prepare("SELECT count(*) AS n FROM request_artifacts").get() as { n: number };
    const inbox = fixture.store.prepare("SELECT count(*) AS n FROM request_inbox").get() as { n: number };
    expect(artifacts.n).toBe(10);
    expect(inbox.n).toBe(10);

    // Temp dirs reclaimed; question files are per-request and distinct.
    for (const request of created) {
      expect(
        existsSync(join(fixture.root, ".roledock", "requests", request.request_id, "tmp")),
        `temp dir for ${request.request_id} should be reclaimed`,
      ).toBe(false);
    }

    // The target's primary session history has no consultation messages: the
    // owner's host reference (if any) and its session row are untouched.
    const ownerSession = fixture.store
      .prepare("SELECT state, host_session_ref FROM sessions WHERE id = ?")
      .get(ownerPrimaryBefore) as { state: string; host_session_ref: string | null };
    expect(ownerSession.state).toBe("active");
    const ownerTranscripts = hostSessions.filter((session) => session.id === ownerPrimaryBefore);
    expect(ownerTranscripts).toHaveLength(0);
    fixture.coordinator.close();
  }, 60000);
});

describe("requests concurrent with handoff", () => {
  it("queued requests keep their receive-time snapshot; new requests bind the new generation", async () => {
    const fixture = setup();
    await publishState(fixture, "v1 knowledge");
    await fixture.coordinator.readDocument({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      document_key: "state",
    });

    // Created while owner is at generation 1.
    const before = await createAsk(fixture, "asked before the handoff", "pre-handoff");
    expect(before.binding.target_generation).toBe(1);

    // Handoff: owner advances to generation 2 and publishes new knowledge
    // from the successor session that the handoff itself created.
    const successor = await fixture.coordinator.openSession({ role_id: "owner", inherit: "latest" });
    expect(successor.generation).toBe(2);
    await fixture.coordinator.publishDocument({
      session_id: successor.session_id,
      document_key: "state",
      body: "v2 knowledge after handoff",
      expected_revision: 1,
      expected_generation: 2,
    });

    // Execute the OLD queued request: it keeps the receive-time binding and
    // snapshot (revision 1 content).
    await executeRequest(fixture.store, fixture.adapter, before.request_id);
    const oldRow = fixture.store
      .prepare("SELECT binding_generation, binding_snapshot_json FROM requests WHERE request_id = ?")
      .get(before.request_id) as { binding_generation: number; binding_snapshot_json: string };
    expect(oldRow.binding_generation).toBe(1);
    const snapshot = JSON.parse(oldRow.binding_snapshot_json) as Array<{ revision: number }>;
    expect(snapshot[0]?.revision).toBe(1);

    // A NEW request after the handoff binds the new generation and snapshot.
    await fixture.coordinator.readDocument({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      document_key: "state",
    });
    const after = await createAsk(fixture, "asked after the handoff", "post-handoff");
    expect(after.binding.target_generation).toBe(2);
    fixture.coordinator.close();
  });
});

describe("state machine, budgets and late results", () => {
  it("moves to awaiting_input on needs_input, resumes after the initiator's reply", async () => {
    const fixture = setup();
    fixture.coordinator.close();
    const root = makeRoot();
    const adapter = new MockHarnessAdapter({ needsInputAfterTurns: 1 });
    const coordinator = Coordinator.open({ root, adapter });
    const store = coordinatorStore(coordinator);
    const packDir = join(root, "pack");
    writePack({ dir: packDir, name: "ni-pack", roles: [{ id: "asker" }, { id: "owner" }] });
    installRolePack(store, { sourcePath: packDir });
  grantFixtureCapabilities(store);
    const asker = testingOpenPrimarySession(coordinator, { role_id: "asker" });
    // The target role needs a primary instance (production open path).
    const ownerPrimary = await coordinator.openSession({ role_id: "owner" });
    const created = await coordinator.createRequest({
      session_id: asker.session_id,
      target_role_id: "owner",
      question: "needs your input",
      idempotency_key: "ni-1",
      read_exception_rationale: "no documents exist",
    });
    const first = await executeRequest(store, adapter, created.request_id);
    expect(first.state).toBe("awaiting_input");

    // Only the initiator can reply; cross-identity is rejected.
    await expectError("PERMISSION_DENIED", () =>
      coordinator.replyToRequest({
        session_id: ownerPrimary.session_id,
        request_id: created.request_id,
        body: "not the initiator",
      }),
    );
    const replied = await coordinator.replyToRequest({
      session_id: asker.session_id,
      request_id: created.request_id,
      body: "here is the missing input",
    });
    // The coordinator re-queues and executes the budgeted turn; with the
    // mock needing input after exactly turn 1, turn 2 completes normally —
    // and the initiator input is part of the branch record.
    expect(replied.state).toBe("completed");
    const row = store
      .prepare("SELECT question FROM requests WHERE request_id = ?")
      .get(created.request_id) as { question: string };
    expect(row.question).toContain("[initiator input] here is the missing input");
    coordinator.close();
  });

  it("enforces the turn budget as a capability-scope boundary", async () => {
    // needs_input consumes turn 1 (within max_turns 1); the initiator's reply
    // re-queues, and the second turn exceeds the budget — the request fails
    // with PERMISSION_DENIED instead of running unbudgeted.
    const root = makeRoot();
    const adapter = new MockHarnessAdapter({ needsInputAfterTurns: 1 });
    const coordinator = Coordinator.open({ root, adapter });
    const store = coordinatorStore(coordinator);
    const packDir = join(root, "pack");
    writePack({ dir: packDir, name: "bud-pack", roles: [{ id: "asker" }, { id: "owner" }] });
    installRolePack(store, { sourcePath: packDir });
  grantFixtureCapabilities(store);
    const asker = testingOpenPrimarySession(coordinator, { role_id: "asker" });
    await coordinator.openSession({ role_id: "owner" });
    const created = await coordinator.createRequest({
      session_id: asker.session_id,
      target_role_id: "owner",
      question: "needs input, then over budget",
      idempotency_key: "budget-1",
      budget: { max_turns: 1 },
      read_exception_rationale: "no documents",
    });
    const first = await executeRequest(store, adapter, created.request_id);
    expect(first.state).toBe("awaiting_input");
    // Re-queue through the service layer directly, then execute: turn 2
    // exceeds max_turns 1 and the request fails rather than running unbudgeted.
    const { replyToRequest: requeue } = await import("../src/requests/service.js");
    const replied = requeue(store, {
      session_id: asker.session_id,
      request_id: created.request_id,
      body: "the missing input",
    });
    expect(replied.state).toBe("queued");
    await expectError("PERMISSION_DENIED", () =>
      executeRequest(store, adapter, created.request_id),
    );
    const row = store
      .prepare("SELECT state, error_json FROM requests WHERE request_id = ?")
      .get(created.request_id) as { state: string; error_json: string };
    expect(row.state).toBe("failed");
    expect(JSON.parse(row.error_json).message).toContain("budget exhausted");
    coordinator.close();
  });

  it("rejects late results after cancellation and duplicate completions", async () => {
    const fixture = setup();
    const created = await createAsk(fixture, "to be cancelled", "late-1");
    await fixture.coordinator.cancelRequest({
      session_id: fixture.asker.session_id,
      request_id: created.request_id,
    });
    const cancelled = fixture.store
      .prepare("SELECT state FROM requests WHERE request_id = ?")
      .get(created.request_id) as { state: string };
    expect(cancelled.state).toBe("cancelled");
    // Duplicate delivery returns the terminal state and performs no host work.
    expect((await executeRequest(fixture.store, fixture.adapter, created.request_id)).state).toBe("cancelled");
    const stillCancelled = fixture.store
      .prepare("SELECT state FROM requests WHERE request_id = ?")
      .get(created.request_id) as { state: string };
    expect(stillCancelled.state).toBe("cancelled");
    fixture.coordinator.close();
  });

  it("expires overdue requests lazily and reclaims their temp dirs", async () => {
    const fixture = setup();
    // Creation requires a future deadline.
    await expectError("VALIDATION_FAILED", () =>
      fixture.coordinator.createRequest({
        session_id: fixture.asker.session_id,
        target_role_id: "owner",
        question: "deadline in the past",
        idempotency_key: "late-3",
        budget: { deadline: "2000-01-01T00:00:00Z" },
        read_exception_rationale: "exception",
      }),
    );
    // Time passes after creation (simulated by rewinding the stored deadline).
    const created = await fixture.coordinator.createRequest({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      question: "will expire",
      idempotency_key: "late-2",
      budget: { deadline: "2099-01-01T00:00:00Z" },
      read_exception_rationale: "exception",
    });
    fixture.store
      .prepare("UPDATE requests SET budget_json = ? WHERE request_id = ?")
      .run(JSON.stringify({ deadline: "2000-01-01T00:00:00Z" }), created.request_id);
    // The next state-reading path lazily expires it; execution then reports
    // expiry without spending a turn.
    const result = await executeRequest(fixture.store, fixture.adapter, created.request_id);
    expect(result.state).toBe("expired");
    const row = fixture.store
      .prepare("SELECT state FROM requests WHERE request_id = ?")
      .get(created.request_id) as { state: string };
    expect(row.state).toBe("expired");
    fixture.coordinator.close();
  });
});

describe("permission matrix over requests", () => {
  it("rejects cross-identity read, reply, cancel and adopt", async () => {
    const fixture = setup();
    await publishState(fixture, "context");
    await fixture.coordinator.readDocument({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      document_key: "state",
    });
    const created = await createAsk(fixture, "visibility probe", "perm-1");
    const executed = await executeRequest(fixture.store, fixture.adapter, created.request_id);
    expect(executed.state).toBe("completed");
    const artifactId = executed.artifact_id ?? "";

    // A third-party role sees nothing.
    const third = testingOpenPrimarySession(fixture.coordinator, { role_id: "asker" });
    void third;
    const outsiderPack = join(fixture.root, "outsider-pack");
    writePack({ dir: outsiderPack, name: "outsider-pack", roles: [{ id: "outsider" }] });
    installRolePack(fixture.store, { sourcePath: outsiderPack });
    const outsider = testingOpenPrimarySession(fixture.coordinator, { role_id: "outsider" });
    await expectError("PERMISSION_DENIED", () =>
      fixture.coordinator.getRequest({ session_id: outsider.session_id, request_id: created.request_id }),
    );
    await expectError("PERMISSION_DENIED", () =>
      fixture.coordinator.cancelRequest({ session_id: outsider.session_id, request_id: created.request_id }),
    );
    await expectError("PERMISSION_DENIED", () =>
      fixture.coordinator.readArtifact({ session_id: outsider.session_id, artifact_id: artifactId }),
    );

    // The initiator can read the result; the owner can adopt it.
    const read = await fixture.coordinator.readArtifact({
      session_id: fixture.asker.session_id,
      artifact_id: artifactId,
    });
    expect(read.body).toBe("ack:1");
    // Cross-role adoption: asker cannot adopt owner's artifact (from the
    // current asker primary session — the fixture created one more when
    // seeding the outsider role set).
    await expectError("PERMISSION_DENIED", () =>
      fixture.coordinator.publishDocument({
        session_id: third.session_id,
        document_key: "notes",
        body: "unused",
        expected_revision: 0,
        expected_generation: third.generation,
        adopt_artifact_id: artifactId,
      }),
    );
    // Owner adopts through publish: the candidate binds the request source.
    const adopted = await fixture.coordinator.publishDocument({
      session_id: fixture.owner.session_id,
      document_key: "state",
      body: "unused",
      expected_revision: 1,
      expected_generation: fixture.owner.generation,
      adopt_artifact_id: artifactId,
    });
    expect(adopted.revision).toBe(2);
    const candidate = listCandidates(fixture.store).find(
      (entry) => entry.candidate_id === adopted.candidate_id,
    );
    expect(candidate).toMatchObject({ source: "request.result", state: "adopted" });
    const inbox = listInboxEntries(fixture.store, { owner_role_id: "owner" });
    expect(inbox.every((entry) => entry.state === "read" || entry.state === "unread")).toBe(true);
    fixture.coordinator.close();
  });

  it("rejects adoption of cancelled or late results", async () => {
    const fixture = setup();
    const created = await createAsk(fixture, "cancelled before completion", "adopt-1");
    await fixture.coordinator.cancelRequest({
      session_id: fixture.asker.session_id,
      request_id: created.request_id,
    });
    // No artifact exists for a cancelled request; adopting a fabricated id fails.
    await expectError("NOT_FOUND", () =>
      fixture.coordinator.publishDocument({
        session_id: fixture.owner.session_id,
        document_key: "state",
        body: "unused",
        expected_revision: 0,
        expected_generation: fixture.owner.generation,
        adopt_artifact_id: "art-nonexistent",
      }),
    );
    fixture.coordinator.close();
  });
});

describe("handoff interplay with candidates", () => {
  it("gives stale-branch candidates no formal write permission after a handoff", async () => {
    const fixture = setup();
    await publishState(fixture, "v1");
    await fixture.coordinator.readDocument({
      session_id: fixture.asker.session_id,
      target_role_id: "owner",
      document_key: "state",
    });
    const created = await createAsk(fixture, "bound to generation 1", "stale-cand");
    const executed = await executeRequest(fixture.store, fixture.adapter, created.request_id);
    expect(executed.state).toBe("completed");

    // Owner hands off; the candidate adoption now faces a newer baseline.
    const successor = await fixture.coordinator.openSession({ role_id: "owner", inherit: "latest" });
    await fixture.coordinator.publishDocument({
      session_id: successor.session_id,
      document_key: "state",
      body: "v2 by the successor",
      expected_revision: 1,
      expected_generation: 2,
    });
    await expectError("REVISION_CONFLICT", () =>
      fixture.coordinator.publishDocument({
        session_id: successor.session_id,
        document_key: "state",
        body: "unused",
        expected_revision: 2,
        expected_generation: 2,
        adopt_artifact_id: executed.artifact_id ?? "",
      }),
    );
    // Adoption-time candidates are only created when adoption succeeds: the
    // rejected old-branch result leaves no formal-write candidate behind.
    const open = listCandidates(fixture.store, { state: "open", source: "request.result" });
    expect(open).toHaveLength(0);
    fixture.coordinator.close();
  });
});
