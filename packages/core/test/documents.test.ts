import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, IMPLEMENTED_OPERATIONS, coordinatorOperations } from "../src/index.js";
import { installRolePack, listCandidates } from "../src/testing.js";
import { isRoleDockError } from "@roledock/protocol";
import { coordinatorStore } from "../src/internal-store.js";
import type { WorkspaceStore } from "../src/store/workspace.js";
import { recordReadReceipt } from "../src/sessions/internal.js";
import { testingOpenPrimarySession } from "../src/testing.js";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-docs-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface Workspace {
  root: string;
  coordinator: Coordinator;
  writer: { session_id: string; instance_id: string; generation: number };
  reader: { session_id: string; instance_id: string; generation: number };
  store: WorkspaceStore;
}

/**
 * Writer role carries one document per visibility level; reader is a second
 * role for cross-role checks.
 */
function setup(): Workspace {
  const root = makeRoot();
  const coordinator = Coordinator.open({ root });
  const writerPack = join(root, "writer-pack");
  const readerPack = join(root, "reader-pack");
  writePack({
    dir: writerPack,
    name: "writer-pack",
    roles: [
      {
        id: "writer",
        docs: [
          { key: "notes", visibility: "private" },
          { key: "journal", visibility: "role" },
          { key: "state", visibility: "project" },
          { key: "blog", visibility: "public" },
        ],
      },
    ],
  });
  writePack({ dir: readerPack, name: "reader-pack", roles: [{ id: "reader" }] });
  const store = coordinatorStore(coordinator);
  installRolePack(store, { sourcePath: writerPack });
  grantFixtureCapabilities(store);
  installRolePack(store, { sourcePath: readerPack });
  grantFixtureCapabilities(store);
  const writer = testingOpenPrimarySession(coordinator, { role_id: "writer" });
  const reader = testingOpenPrimarySession(coordinator, { role_id: "reader" });
  return { root, coordinator, writer, reader, store };
}

async function publishAll(workspace: Workspace): Promise<void> {
  const { coordinator, writer } = workspace;
  for (const [key, body] of [
    ["notes", "private body"],
    ["journal", "role body"],
    ["state", "project body"],
    ["blog", "public body"],
  ] as const) {
    await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: key,
      body,
      expected_revision: 0,
      expected_generation: writer.generation,
    });
  }
}

async function expectError(code: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(isRoleDockError(error), `${code}: got ${String(error)}`).toBe(true);
    if (isRoleDockError(error)) expect(error.code).toBe(code);
    return;
  }
}

describe("documents.publish", () => {
  it("publishes v1, bumps knowledge_revision, and keeps history immutable", async () => {
    const workspace = setup();
    const { coordinator, writer } = workspace;
    const first = await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: "state",
      body: "state v1",
      expected_revision: 0,
      expected_generation: writer.generation,
    });
    expect(first).toMatchObject({
      owner_role_id: "writer",
      document_key: "state",
      revision: 1,
      visibility: "project",
      knowledge_revision: 1,
    });
    const second = await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: "state",
      body: "state v2",
      expected_revision: 1,
      expected_generation: writer.generation,
    });
    expect(second.revision).toBe(2);
    expect(second.knowledge_revision).toBe(2);

    // Old revisions remain readable and unchanged (immutable history).
    const v1 = await coordinator.readDocument({
      session_id: writer.session_id,
      document_key: "state",
      revision: 1,
    });
    expect(v1.body).toBe("state v1");
    expect(v1.content_hash).toBe(first.content_hash);
    coordinator.close();
  });

  it("rejects a stale expected_revision with REVISION_CONFLICT; loser content survives as a candidate", async () => {
    const workspace = setup();
    const { coordinator, writer } = workspace;
    await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: "state",
      body: "winner",
      expected_revision: 0,
      expected_generation: writer.generation,
    });
    // A second in-flight publish against the same baseline loses:
    try {
      await coordinator.publishDocument({
        session_id: writer.session_id,
        document_key: "state",
        body: "loser content that must not vanish",
        expected_revision: 0,
        expected_generation: writer.generation,
      });
      expect.unreachable("expected REVISION_CONFLICT");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("REVISION_CONFLICT");
      if (isRoleDockError(error)) {
        expect((error.details as { current_revision?: number }).current_revision).toBe(1);
      }
    }
    // The loser re-submits through propose; the content is kept, not merged.
    const proposal = await coordinator.proposeDocumentUpdate({
      session_id: writer.session_id,
      target_role_id: "writer",
      document_key: "state",
      body: "loser content that must not vanish",
      note: "resubmitted after conflict",
    });
    const open = listCandidates(workspace.store, { state: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]?.candidate_id).toBe(proposal.candidate_id);
    expect(open[0]?.baseline_revision).toBe(1);
    coordinator.close();
  });

  it("rejects wrong expected_generation with GENERATION_CONFLICT", async () => {
    const workspace = setup();
    const { coordinator, writer } = workspace;
    await expectError("GENERATION_CONFLICT", () =>
      coordinator.publishDocument({
        session_id: writer.session_id,
        document_key: "state",
        body: "x",
        expected_revision: 0,
        expected_generation: writer.generation + 5,
      }),
    );
    coordinator.close();
  });

  it("rejects an old-generation session with INVALID_STATE_TRANSITION", async () => {
    const workspace = setup();
    const { coordinator, writer } = workspace;
    // Fixture bump: writer advances to generation 2; the old session's
    // instance is retired as predecessor.
    const next = testingOpenPrimarySession(coordinator, { role_id: "writer" });
    expect(next.generation).toBe(2);
    await expectError("INVALID_STATE_TRANSITION", () =>
      coordinator.publishDocument({
        session_id: writer.session_id,
        document_key: "state",
        body: "from the past",
        expected_revision: 0,
        expected_generation: writer.generation,
      }),
    );
    coordinator.close();
  });

  it("rejects non-owner publishes and undeclared document keys", async () => {
    const workspace = setup();
    const { coordinator, reader, writer } = workspace;
    // Owner comes from the session binding: the reader session cannot publish
    // under writer's documents (key not declared for reader's role).
    await expectError("VALIDATION_FAILED", () =>
      coordinator.publishDocument({
        session_id: reader.session_id,
        document_key: "state",
        body: "x",
        expected_revision: 0,
        expected_generation: reader.generation,
      }),
    );
    await expectError("VALIDATION_FAILED", () =>
      coordinator.publishDocument({
        session_id: writer.session_id,
        document_key: "not-declared",
        body: "x",
        expected_revision: 0,
        expected_generation: writer.generation,
      }),
    );
    coordinator.close();
  });
});

describe("documents.read and visibility", () => {
  it("enforces the visibility matrix across roles and session kinds", async () => {
    const workspace = setup();
    await publishAll(workspace);
    const { coordinator, writer, reader, store } = workspace;

    // Reader (other role, primary session): project and public only.
    expect(
      (
        await coordinator.readDocument({
          session_id: reader.session_id,
          target_role_id: "writer",
          document_key: "state",
        })
      ).body,
    ).toBe("project body");
    expect(
      (
        await coordinator.readDocument({
          session_id: reader.session_id,
          target_role_id: "writer",
          document_key: "blog",
        })
      ).body,
    ).toBe("public body");
    await expectError("PERMISSION_DENIED", () =>
      coordinator.readDocument({ session_id: reader.session_id, target_role_id: "writer", document_key: "journal" }),
    );
    await expectError("PERMISSION_DENIED", () =>
      coordinator.readDocument({ session_id: reader.session_id, target_role_id: "writer", document_key: "notes" }),
    );

    // Writer (owning role, primary session): role and private readable.
    expect((await coordinator.readDocument({ session_id: writer.session_id, document_key: "journal" })).body).toBe(
      "role body",
    );
    expect((await coordinator.readDocument({ session_id: writer.session_id, document_key: "notes" })).body).toBe(
      "private body",
    );

    // A consultation branch of the SAME role reads only explicitly shared
    // knowledge: identical role_id never unlocks role or private material.
    store
      .prepare(
        "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, creation_key, created_at) VALUES ('sess-branch-1', 'request', 'test', 'active', 'writer', NULL, NULL, '2026-10-13T00:00:00Z')",
      )
      .run();
    const received = await coordinator.createRequest({ session_id: reader.session_id, target_role_id: "writer", question: "visibility", idempotency_key: "visibility", read_exception_rationale: "gap" });
    store.prepare("UPDATE sessions SET capability_scope_json = ?, creation_key = ? WHERE id = 'sess-branch-1'").run(JSON.stringify(["documents.read"]), `request-${received.request_id}`);
    expect(
      (
        await coordinator.readDocument({
          session_id: "sess-branch-1",
          target_role_id: "writer",
          document_key: "state",
        })
      ).body,
    ).toBe("project body");
    await expectError("PERMISSION_DENIED", () =>
      coordinator.readDocument({ session_id: "sess-branch-1", target_role_id: "writer", document_key: "journal" }),
    );
    await expectError("PERMISSION_DENIED", () =>
      coordinator.readDocument({ session_id: "sess-branch-1", target_role_id: "writer", document_key: "notes" }),
    );
    coordinator.close();
  });

  it("records read receipts bound to the true calling session; forgery fails", async () => {
    const workspace = setup();
    await publishAll(workspace);
    const { coordinator, writer, reader, store } = workspace;
    const read = await coordinator.readDocument({
      session_id: reader.session_id,
      target_role_id: "writer",
      document_key: "state",
    });
    const receipts = listReceipts(store, reader.session_id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      session_id: reader.session_id,
      reader_role_id: "reader",
      instance_id: reader.instance_id,
      owner_role_id: "writer",
      document_key: "state",
      revision: read.revision,
      content_hash: read.content_hash,
    });
    // The writer's session gains nothing from the reader's call.
    expect(listReceipts(store, writer.session_id)).toHaveLength(0);

    // Forging a receipt under an unknown session identity fails.
    await expectError("VALIDATION_FAILED", () =>
      recordReadReceipt(store, {
        session_id: "sess-nonexistent",
        owner_role_id: "writer",
        document_key: "state",
        revision: 1,
        content_hash: read.content_hash,
      }),
    );
    coordinator.close();
  });

  it("filters documents.list by calling identity", async () => {
    const workspace = setup();
    await publishAll(workspace);
    const { coordinator, writer, reader } = workspace;
    const asReader = await coordinator.listDocuments({ session_id: reader.session_id });
    const readerKeys = asReader.documents.map((document) => `${document.owner_role_id}/${document.document_key}`);
    expect(readerKeys).toContain("writer/state");
    expect(readerKeys).toContain("writer/blog");
    expect(readerKeys).not.toContain("writer/journal");
    expect(readerKeys).not.toContain("writer/notes");
    expect(readerKeys).toContain("reader/notes");

    const asWriter = await coordinator.listDocuments({ session_id: writer.session_id });
    const writerKeys = asWriter.documents.map((document) => `${document.owner_role_id}/${document.document_key}`);
    expect(writerKeys).toContain("writer/notes");
    expect(writerKeys).toContain("writer/journal");
    coordinator.close();
  });
});

describe("candidates", () => {
  it("adopts a candidate after re-validating its baseline; stale adoption keeps the candidate", async () => {
    const workspace = setup();
    const { coordinator, writer, reader } = workspace;
    await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: "state",
      body: "v1",
      expected_revision: 0,
      expected_generation: writer.generation,
    });
    const proposal = await coordinator.proposeDocumentUpdate({
      session_id: reader.session_id,
      target_role_id: "writer",
      document_key: "state",
      body: "reader's proposed text",
    });
    expect(proposal).toMatchObject({
      target_role_id: "writer",
      document_key: "state",
      baseline_revision: 1,
      source: "documents.propose",
      state: "open",
    });

    // Writer advances the document past the candidate's baseline.
    await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: "state",
      body: "v2",
      expected_revision: 1,
      expected_generation: writer.generation,
    });
    // Adoption re-checks the baseline and fails without losing the content.
    try {
      await coordinator.publishDocument({
        session_id: writer.session_id,
        document_key: "state",
        body: "ignored",
        expected_revision: 2,
        expected_generation: writer.generation,
        candidate_id: proposal.candidate_id,
      });
      expect.unreachable("expected REVISION_CONFLICT");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("REVISION_CONFLICT");
    }
    const stillOpen = listCandidates(workspace.store, { state: "open" });
    expect(stillOpen.map((candidate) => candidate.candidate_id)).toContain(proposal.candidate_id);

    // A fresh candidate against the current baseline adopts cleanly.
    const fresh = await coordinator.proposeDocumentUpdate({
      session_id: reader.session_id,
      target_role_id: "writer",
      document_key: "state",
      body: "reader's fresher text",
    });
    const adopted = await coordinator.publishDocument({
      session_id: writer.session_id,
      document_key: "state",
      body: "unused",
      expected_revision: 2,
      expected_generation: writer.generation,
      candidate_id: fresh.candidate_id,
    });
    expect(adopted.revision).toBe(3);
    expect(adopted.candidate_id).toBe(fresh.candidate_id);
    const read = await coordinator.readDocument({
      session_id: reader.session_id,
      target_role_id: "writer",
      document_key: "state",
    });
    expect(read.body).toBe("reader's fresher text");
    const adoptedCandidate = listCandidates(workspace.store).find(
      (candidate) => candidate.candidate_id === fresh.candidate_id,
    );
    expect(adoptedCandidate).toMatchObject({ state: "adopted", adopted_revision: 3 });
    coordinator.close();
  });

  it("proposing on an unpublished foreign document is denied", async () => {
    const workspace = setup();
    const { coordinator, reader } = workspace;
    await expectError("PERMISSION_DENIED", () =>
      coordinator.proposeDocumentUpdate({
        session_id: reader.session_id,
        target_role_id: "writer",
        document_key: "journal",
        body: "x",
      }),
    );
    coordinator.close();
  });
});

describe("testing fixture boundary", () => {
  it("is not reachable from the SDK operation surface or the coordinator object", () => {
    expect(coordinatorOperations().some((name) => name.toLowerCase().includes("testing"))).toBe(false);
    expect(IMPLEMENTED_OPERATIONS.some((name) => name.toLowerCase().includes("testing"))).toBe(false);
    const coordinator = Coordinator.open({ root: makeRoot() });
    try {
      expect((coordinator as unknown as Record<string, unknown>).testingOpenPrimarySession).toBeUndefined();
      expect(
        Object.getOwnPropertyNames(Object.getPrototypeOf(coordinator)).some((name) =>
          name.toLowerCase().includes("testing"),
        ),
      ).toBe(false);
    } finally {
      coordinator.close();
    }
  });
});

function listReceipts(store: WorkspaceStore, sessionId: string) {
  const rows = store.prepare("SELECT * FROM read_receipts WHERE session_id = ?").all(sessionId) as Array<{
    receipt_id: string;
    session_id: string;
    instance_id: string | null;
    reader_role_id: string;
    owner_role_id: string;
    document_key: string;
    revision: number;
    content_hash: string;
  }>;
  return rows;
}
