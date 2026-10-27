import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validate } from "@roledock/protocol";
import type { KnowledgeExportManifest, OwnerCandidatesPage, OwnerCheckpointDetail, OwnerCheckpointListPage, OwnerDocumentListPage, OwnerDocumentRead, OwnerDocumentRevisionsPage } from "@roledock/protocol";
import { Coordinator, WorkspaceAdmin } from "../src/index.js";
import { buildCheckpoint, exportKnowledge, importKnowledge, installRolePack, testingOpenPrimarySession } from "../src/testing.js";
import { coordinatorStore } from "../src/internal-store.js";
import type { WorkspaceStore } from "../src/store/workspace.js";
import { writePack } from "../../../tests/helpers/packs.js";
import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function setup(prefix = "rd-g5-"): { coordinator: Coordinator; admin: WorkspaceAdmin; store: WorkspaceStore; root: string; session: ReturnType<typeof testingOpenPrimarySession> } {
  const root = makeRoot(prefix);
  const coordinator = Coordinator.open({ root });
  const packDir = join(root, "pack");
  writePack({
    dir: packDir,
    name: "g5-pack",
    roles: [
      {
        id: "writer",
        docs: [
          { key: "state", visibility: "project" },
          { key: "secrets", visibility: "role" },
          { key: "someday", visibility: "private" },
        ],
      },
    ],
  });
  const store = coordinatorStore(coordinator);
  installRolePack(store, { sourcePath: packDir });
  grantFixtureCapabilities(store);
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  const session = testingOpenPrimarySession(coordinator, { role_id: "writer" });
  return { coordinator, admin, store, root, session };
}

// Mock/fixture mechanics only; visibility semantics are the accepted core rules.
describe("G5 owner knowledge read models (Mock)", () => {
  it("directory lists declared documents with metadata only — no bodies anywhere", () => {
    const ctx = setup();
    const page = ctx.admin.documentList({}) as OwnerDocumentListPage;
    expect(validate("owner-documents", page).ok).toBe(true);
    const keys = page.items.map(item => `${item.role_id}/${item.document_key}`).sort();
    expect(keys).toEqual(["writer/secrets", "writer/someday", "writer/state"]);
    const unpublished = page.items.filter(item => item.latest_revision === 0);
    expect(unpublished).toHaveLength(3);
    expect(unpublished.every(item => item.content_hash === null && item.updated_at === null)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("body");
    // Role filter.
    expect((ctx.admin.documentList({ role_id: "writer" }) as OwnerDocumentListPage).items).toHaveLength(3);
    expect((ctx.admin.documentList({ role_id: "missing-role" }) as OwnerDocumentListPage).items).toHaveLength(0);
  });

  it("documentRead serves public/project bodies on demand and keeps private/role at metadata+hash", async () => {
    const ctx = setup();
    const { coordinator, session } = ctx;
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "state v1 body", expected_revision: 0, expected_generation: session.generation });
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "secrets", body: "role-only v1 body", expected_revision: 0, expected_generation: session.generation });

    const state = ctx.admin.documentRead({ role_id: "writer", document_key: "state" }) as OwnerDocumentRead;
    expect(validate("owner-document", state).ok).toBe(true);
    expect(state).toMatchObject({ body_included: true, revision: 1, visibility: "project" });
    expect(state.body).toBe("state v1 body");

    const secrets = ctx.admin.documentRead({ role_id: "writer", document_key: "secrets" }) as OwnerDocumentRead;
    expect(secrets.body_included).toBe(false);
    expect(secrets.body).toBeNull();
    expect(secrets.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(secrets)).not.toContain("role-only v1 body");

    // Metadata rows for a private read still exist (visibility + hash provenance).
    const directory = ctx.admin.documentList({ role_id: "writer" }) as OwnerDocumentListPage;
    expect(directory.items.find(item => item.document_key === "secrets")).toMatchObject({ latest_revision: 1, visibility: "role" });

    // Unknown document / revision boundaries.
    expect(() => ctx.admin.documentRead({ role_id: "writer", document_key: "absent" })).toThrowError(/No published document/);
    expect(() => ctx.admin.documentRead({ role_id: "writer", document_key: "state", revision: 99 })).toThrowError(/does not exist/);
  });

  it("revision history is immutable and paginated; bodies come only from documentRead", async () => {
    const ctx = setup();
    const { coordinator, session } = ctx;
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "v1", expected_revision: 0, expected_generation: session.generation });
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "v2", expected_revision: 1, expected_generation: session.generation });

    const page = ctx.admin.documentRevisions({ role_id: "writer", document_key: "state" }) as OwnerDocumentRevisionsPage;
    expect(validate("owner-document-revisions", page).ok).toBe(true);
    expect(page.items.map(item => item.revision)).toEqual([1, 2]);
    expect(page.items.every(item => /^[0-9a-f]{64}$/.test(item.content_hash))).toBe(true);
    expect(page.items[0]!.created_by_instance_id).toBe(session.instance_id);
    expect(JSON.stringify(page)).not.toContain("v1");

    const paged = ctx.admin.documentRevisions({ role_id: "writer", document_key: "state", limit: 1 }) as OwnerDocumentRevisionsPage;
    expect(paged.items).toHaveLength(1);
    expect(paged.next_cursor).toBeTruthy();
    const rest = ctx.admin.documentRevisions({ role_id: "writer", document_key: "state", limit: 1, cursor: paged.next_cursor! }) as OwnerDocumentRevisionsPage;
    expect(rest.items.map(item => item.revision)).toEqual([2]);
  });

  it("candidates expose full proposed bodies; stale baselines are marked, never merged or dropped", async () => {
    const ctx = setup();
    const { coordinator, session } = ctx;
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "baseline", expected_revision: 0, expected_generation: session.generation });
    const proposal = await coordinator.proposeDocumentUpdate({ session_id: session.session_id, target_role_id: "writer", document_key: "state", body: "proposed new text", note: "clarify" });

    const before = ctx.admin.candidateList({}) as OwnerCandidatesPage;
    expect(validate("owner-candidates", before).ok).toBe(true);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({ candidate_id: proposal.candidate_id, state: "open", source: "documents.propose", proposed_by_role_id: "writer", baseline_revision: 1, latest_revision: 1, baseline_conflicted: false, body_included: true });
    expect(before.items[0]!.body).toBe("proposed new text");

    // New publish moves the baseline; the candidate keeps its body and shows the conflict.
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "v2 by role", expected_revision: 1, expected_generation: session.generation });
    const after = ctx.admin.candidateList({ role_id: "writer" }) as OwnerCandidatesPage;
    expect(after.items[0]).toMatchObject({ baseline_revision: 1, latest_revision: 2, baseline_conflicted: true });
    expect(after.items[0]!.body).toBe("proposed new text");
    expect(after.items[0]!.state).toBe("open");

    // Source filter.
    expect((ctx.admin.candidateList({ source: "knowledge.import" }) as OwnerCandidatesPage).items).toHaveLength(0);
  });

  it("checkpoint summaries carry metadata + todo overview; detail carries the full handoff body", async () => {
    const ctx = setup();
    const { coordinator, session, store } = ctx;
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "v1", expected_revision: 0, expected_generation: session.generation });
    const built = buildCheckpoint(store, {
      role_id: "writer",
      summary_body: "# Handoff\n\nstate of the world",
      todos: [{ description: "re-read reviews", done: false }, { description: "archive old notes", done: true }],
      sources: [{ kind: "document", document_key: "state", revision: 1 }],
    });

    const list = ctx.admin.checkpointList({ role_id: "writer" }) as OwnerCheckpointListPage;
    expect(validate("owner-checkpoints", list).ok).toBe(true);
    expect(list.items).toHaveLength(1);
    const summary = list.items[0]!;
    expect(summary).toMatchObject({ checkpoint_id: built.checkpoint_id, role_id: "writer", generation: session.generation, todos_total: 2, todos_done: 1 });
    expect(summary.handoff_summary).toEqual({ format: "markdown", content_hash: built.summary_content_hash });
    expect(summary.todos_open).toEqual([{ description: "re-read reviews" }]);
    // The body never rides on the summary.
    expect(JSON.stringify(list)).not.toContain("state of the world");

    const detail = ctx.admin.checkpointGet({ checkpoint_id: built.checkpoint_id }) as OwnerCheckpointDetail;
    expect(validate("owner-checkpoint-detail", detail).ok).toBe(true);
    expect(detail.handoff_summary.body).toBe("# Handoff\n\nstate of the world");
    expect(detail.todos).toHaveLength(2);
    expect(detail.sources).toEqual([{ kind: "document", document_key: "state", revision: 1 }]);
    expect(() => ctx.admin.checkpointGet({ checkpoint_id: "ckpt-missing" })).toThrowError(/does not exist/);
  });

  it("export(share) excludes role-private material and carries no credentials; cross-workspace import creates candidates, never publications", async () => {
    const ctx = setup("rd-g5-src-");
    const { coordinator, session, store } = ctx;
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "state", body: "shareable v1", expected_revision: 0, expected_generation: session.generation });
    await coordinator.publishDocument({ session_id: session.session_id, document_key: "secrets", body: "private v1", expected_revision: 0, expected_generation: session.generation });
    const exported = exportKnowledge(store, { scope: "share" });
    const manifest = JSON.parse(await import("node:fs").then(fs => fs.readFileSync(exportKnowledgeManifestPath(exported.bundle_dir), "utf8"))) as KnowledgeExportManifest;
    const exportedKeys = manifest.entries.map(entry => `${entry.owner_role_id}/${entry.document_key}`);
    expect(exportedKeys).toContain("writer/state");
    expect(exportedKeys).not.toContain("writer/secrets");
    expect(JSON.stringify(manifest)).not.toContain("private v1");

    // Second workspace: same pack installed, nothing published.
    const target = setup("rd-g5-dst-");
    const before = (target.admin.documentList({}) as OwnerDocumentListPage).items.every(item => item.latest_revision === 0);
    expect(before).toBe(true);
    const imported = importKnowledge(target.store, { bundle_dir: exported.bundle_dir });
    expect(imported.created_candidates).toHaveLength(1);
    expect(imported.created_candidates[0]).toMatchObject({ target_role_id: "writer", document_key: "state", baseline_revision: 1 });

    // Imported material is a CANDIDATE with full body; nothing was published.
    const candidates = target.admin.candidateList({}) as OwnerCandidatesPage;
    expect(candidates.items).toHaveLength(1);
    expect(candidates.items[0]).toMatchObject({ source: "knowledge.import", state: "open", body_included: true });
    expect(candidates.items[0]!.body).toBe("shareable v1");
    expect((target.admin.documentList({}) as OwnerDocumentListPage).items.every(item => item.latest_revision === 0)).toBe(true);
    expect(target.store.prepare("SELECT COUNT(*) AS n FROM document_revisions").get()).toMatchObject({ n: 0 });
  });
});

function exportKnowledgeManifestPath(bundleDir: string): string {
  return join(bundleDir, "manifest.json");
}
