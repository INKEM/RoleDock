import { afterEach, describe, expect, it } from "vitest";
import { validate } from "@roledock/protocol";
import type { Checkpoint } from "@roledock/protocol";
import {
  buildCheckpoint,
  Coordinator,
  getLatestCheckpoint,
  installRolePack,
} from "../src/index.js";
import { coordinatorStore } from "../src/internal-store.js";
import { isRoleDockError } from "@roledock/protocol";
import { testingOpenPrimarySession } from "../src/testing.js";
import type { WorkspaceStore } from "../src/store/workspace.js";
import { writePack } from "../../../tests/helpers/packs.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_ROOTS: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-ckpt-"));
  TEMP_ROOTS.push(root);
  return root;
}
afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { coordinator: Coordinator; store: WorkspaceStore; root: string; session: ReturnType<typeof openWriter> } {
  const root = makeRoot();
  const coordinator = Coordinator.open({ root });
  const packDir = join(root, "pack");
  writePack({
    dir: packDir,
    name: "ckpt-pack",
    roles: [
      {
        id: "writer",
        docs: [
          { key: "state", visibility: "project" },
          { key: "journal", visibility: "role" },
          { key: "draft", visibility: "role" },
        ],
      },
    ],
  });
  const store = coordinatorStore(coordinator);
  installRolePack(store, { sourcePath: packDir });
  const session = testingOpenPrimarySession(coordinator, { role_id: "writer" });
  return { coordinator, store, root, session };
}

function openWriter(coordinator: Coordinator) {
  return testingOpenPrimarySession(coordinator, { role_id: "writer" });
}

describe("CheckpointBuilder", () => {
  it("snapshots exact published revisions and skips unpublished documents", async () => {
    const workspace = setup();
    const { coordinator, store, session } = workspace;
    await coordinator.publishDocument({
      session_id: session.session_id,
      document_key: "state",
      body: "state v1",
      expected_revision: 0,
      expected_generation: session.generation,
    });
    const journal = await coordinator.publishDocument({
      session_id: session.session_id,
      document_key: "journal",
      body: "journal v1",
      expected_revision: 0,
      expected_generation: session.generation,
    });
    // "draft" is declared but never published — it must not appear.

    const built = buildCheckpoint(store, {
      role_id: "writer",
      summary_body: "# Handoff\n\nEverything important.",
      todos: [{ description: "review journal", done: false }],
      sources: [{ kind: "document", document_key: "state", revision: 1 }],
      user_decision_refs: [{ summary: "User picked plan A", document_key: "state", revision: 1 }],
    });

    expect(built.document_snapshots).toEqual([
      { document_key: "journal", revision: 1, content_hash: journal.content_hash },
      { document_key: "state", revision: 1, content_hash: expect.any(String) },
    ]);
    expect(built.document_snapshots.some((snapshot) => snapshot.document_key === "draft")).toBe(false);
    expect(built).toMatchObject({
      role_id: "writer",
      generation: session.generation,
      knowledge_revision: 2,
      created_by_instance_id: session.instance_id,
    });
    expect(built.handoff_summary).toMatchObject({
      format: "markdown",
      body: "# Handoff\n\nEverything important.",
      content_hash: built.summary_content_hash,
    });
    expect(built.user_decision_refs).toEqual([
      { summary: "User picked plan A", document_key: "state", revision: 1 },
    ]);

    // The built checkpoint validates against the protocol schema (the test
    // handle carries the extra summary_content_hash convenience field).
    const { summary_content_hash: _summaryHash, ...asCheckpoint } = built;
    void _summaryHash;
    expect(validate<Checkpoint>("checkpoint", asCheckpoint).ok).toBe(true);

    const latest = getLatestCheckpoint(store, "writer");
    expect(latest?.checkpoint_id).toBe(built.checkpoint_id);
    expect(latest?.todos).toEqual([{ description: "review journal", done: false }]);
    coordinator.close();
  });

  it("captures the knowledge_revision at build time, not a stale view", async () => {
    const workspace = setup();
    const { coordinator, store, session } = workspace;
    await coordinator.publishDocument({
      session_id: session.session_id,
      document_key: "state",
      body: "v1",
      expected_revision: 0,
      expected_generation: session.generation,
    });
    const before = buildCheckpoint(store, { role_id: "writer", summary_body: "first" });
    expect(before.knowledge_revision).toBe(1);
    await coordinator.publishDocument({
      session_id: session.session_id,
      document_key: "state",
      body: "v2",
      expected_revision: 1,
      expected_generation: session.generation,
    });
    const after = buildCheckpoint(store, { role_id: "writer", summary_body: "second" });
    expect(after.knowledge_revision).toBe(2);
    // Snapshots reference the exact new revision, not the checkpoint-time mix.
    expect(after.document_snapshots).toEqual([
      { document_key: "state", revision: 2, content_hash: expect.any(String) },
    ]);
    coordinator.close();
  });

  it("rejects checkpoints for roles without a primary instance", () => {
    const workspace = setup();
    const { coordinator, store, root } = workspace;
    const packDir = join(root, "other-pack");
    writePack({ dir: packDir, name: "other-pack", roles: [{ id: "hermit", documents: false }] });
    installRolePack(store, { sourcePath: packDir });
    try {
      buildCheckpoint(store, { role_id: "hermit", summary_body: "x" });
      expect.unreachable("expected ROLE_UNINITIALIZED");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("ROLE_UNINITIALIZED");
    }
    coordinator.close();
  });
});
