import { grantFixtureCapabilities } from "../../../tests/helpers/policy.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator } from "../src/index.js";
import { buildCheckpoint, exportKnowledge, importKnowledge, installRolePack, listCandidates } from "../src/testing.js";
import type { KnowledgeExportManifest } from "@roledock/protocol";
import { isRoleDockError, validate } from "@roledock/protocol";
import { coordinatorStore } from "../src/internal-store.js";
import { testingOpenPrimarySession } from "../src/testing.js";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];
function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `roledock-${prefix}-`));
  TEMP_ROOTS.push(root);
  return root;
}
afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface Source {
  root: string;
  coordinator: Coordinator;
  session: { session_id: string; instance_id: string; generation: number };
}

/** One role, one document per visibility level, all published. */
function makeSource(): Source {
  const root = makeRoot("src");
  const coordinator = Coordinator.open({ root });
  const packDir = join(root, "pack");
  writePack({
    dir: packDir,
    name: "src-pack",
    roles: [
      {
        id: "keeper",
        docs: [
          { key: "notes", visibility: "private" },
          { key: "journal", visibility: "role" },
          { key: "state", visibility: "project" },
          { key: "blog", visibility: "public" },
        ],
      },
    ],
  });
  const store = coordinatorStore(coordinator);
  installRolePack(store, { sourcePath: packDir });
  grantFixtureCapabilities(store);
  const session = testingOpenPrimarySession(coordinator, { role_id: "keeper" });
  for (const [key, body] of [
    ["notes", "private material"],
    ["journal", "role material"],
    ["state", "shared state v1"],
    ["blog", "public post v1"],
  ] as const) {
    void coordinator.publishDocument({
      session_id: session.session_id,
      document_key: key,
      body,
      expected_revision: 0,
      expected_generation: session.generation,
    });
  }
  return { root, coordinator, session };
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

describe("knowledge.export", () => {
  it("share scope carries only public and project documents, never checkpoints", () => {
    const source = makeSource();
    const result = exportKnowledge(coordinatorStore(source.coordinator), { scope: "share" });
    expect(result.entry_count).toBe(2);
    expect(result.checkpoint_count).toBe(0);
    const keys = result.manifest.entries.map((entry) => entry.document_key).sort();
    expect(keys).toEqual(["blog", "state"]);
    for (const entry of result.manifest.entries) {
      expect(["project", "public"]).toContain(entry.visibility);
      expect(existsSync(join(result.bundle_dir, entry.file))).toBe(true);
      // File hash matches the manifest entry.
      expect(
        createHash("sha256").update(readFileSync(join(result.bundle_dir, entry.file))).digest("hex"),
      ).toBe(entry.content_hash);
    }
    const manifestRaw = JSON.parse(readFileSync(join(result.bundle_dir, "manifest.json"), "utf8")) as KnowledgeExportManifest;
    expect(validate<KnowledgeExportManifest>("knowledge-export", manifestRaw).ok).toBe(true);
    source.coordinator.close();
  });

  it("workspace scope includes everything plus checkpoints", () => {
    const source = makeSource();
    const store = coordinatorStore(source.coordinator);
    // A checkpoint exists only in workspace scope exports.
    buildCheckpoint(store, { role_id: "keeper", summary_body: "handoff summary" });
    const result = exportKnowledge(store, { scope: "workspace" });
    expect(result.entry_count).toBe(4);
    expect(result.checkpoint_count).toBe(1);
    expect(result.manifest.checkpoints?.[0]?.role_id).toBe("keeper");
    source.coordinator.close();
  });

  it("can filter a single role", () => {
    const source = makeSource();
    const result = exportKnowledge(coordinatorStore(source.coordinator), { scope: "share", role_id: "nobody" });
    expect(result.entry_count).toBe(0);
    source.coordinator.close();
  });
});

describe("knowledge.import into another workspace (second adapter)", () => {
  it("round-trips shared documents as candidates with verified hashes", async () => {
    const source = makeSource();
    const bundle = exportKnowledge(coordinatorStore(source.coordinator), { scope: "share" });
    source.coordinator.close();

    // Target workspace: same pack installed, fresh state — "another adapter".
    const targetRoot = makeRoot("dst");
    const target = Coordinator.open({ root: targetRoot });
    const targetPack = join(targetRoot, "pack");
    writePack({ dir: targetPack, name: "src-pack", roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }, { key: "blog", visibility: "public" }] }] });
    installRolePack(coordinatorStore(target), { sourcePath: targetPack });
  grantFixtureCapabilities(coordinatorStore(target));

    const imported = await target.importKnowledge({ bundle_dir: bundle.bundle_dir });
    expect(imported.source_workspace_id).toMatch(/^ws-[0-9a-f]{8}$/);
    expect(imported.created_candidates).toHaveLength(2);
    expect(imported.skipped).toEqual([]);
    for (const candidate of imported.created_candidates) {
      expect(candidate.baseline_revision).toBe(1);
    }
    const candidates = listCandidates(coordinatorStore(target), { state: "open" });
    expect(candidates).toHaveLength(2);
    // Hashes survive the round trip.
    const stateCandidate = candidates.find((candidate) => candidate.document_key === "state");
    expect(stateCandidate?.proposed_body_hash).toBe(
      createHash("sha256").update("shared state v1", "utf8").digest("hex"),
    );

    // Adoption in the target workspace: candidate baseline matches (latest 0
    // for an unpublished doc is below baseline? baseline is 1, latest is 0 →
    // adoption requires candidate.baseline === latest → 1 !== 0 → conflict).
    // This is the designed behavior: imported material merges through the
    // owning role's adoption once its own document exists.
    target.close();
  });

  it("rejects tampered bundle files without touching the database", async () => {
    const source = makeSource();
    const bundle = exportKnowledge(coordinatorStore(source.coordinator), { scope: "share" });
    source.coordinator.close();

    const targetRoot = makeRoot("dst");
    const target = Coordinator.open({ root: targetRoot });
    const targetPack = join(targetRoot, "pack");
    writePack({ dir: targetPack, name: "src-pack", roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }] }] });
    installRolePack(coordinatorStore(target), { sourcePath: targetPack });
  grantFixtureCapabilities(coordinatorStore(target));

    const stateEntry = bundle.manifest.entries.find((entry) => entry.document_key === "state");
    writeFileSync(join(bundle.bundle_dir, stateEntry?.file ?? ""), "tampered content");

    await expectError("VALIDATION_FAILED", () => target.importKnowledge({ bundle_dir: bundle.bundle_dir }));
    // Database unchanged: no candidates were created.
    expect(listCandidates(coordinatorStore(target))).toHaveLength(0);
    target.close();
  });

  it("skips private/role entries even in a hand-edited bundle, and unknown roles", async () => {
    const source = makeSource();
    const bundle = exportKnowledge(coordinatorStore(source.coordinator), { scope: "share" });
    source.coordinator.close();

    // Hand-edit the manifest to smuggle a private entry and an unknown role.
    const manifestPath = join(bundle.bundle_dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as KnowledgeExportManifest;
    manifest.entries.push({
      owner_role_id: "keeper",
      document_key: "notes",
      revision: 1,
      content_hash: manifest.entries[0]?.content_hash ?? "",
      visibility: "private",
      created_by_instance_id: "inst-x",
      created_at: manifest.exported_at,
      file: manifest.entries[0]?.file ?? "",
    });
    manifest.entries.push({
      owner_role_id: "ghost",
      document_key: "state",
      revision: 1,
      content_hash: manifest.entries[0]?.content_hash ?? "",
      visibility: "project",
      created_by_instance_id: "inst-x",
      created_at: manifest.exported_at,
      file: manifest.entries[0]?.file ?? "",
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const targetRoot = makeRoot("dst");
    const target = Coordinator.open({ root: targetRoot });
    const targetPack = join(targetRoot, "pack");
    writePack({
      dir: targetPack,
      name: "src-pack",
      roles: [
        {
          id: "keeper",
          docs: [
            { key: "state", visibility: "project" },
            { key: "blog", visibility: "public" },
          ],
        },
      ],
    });
    installRolePack(coordinatorStore(target), { sourcePath: targetPack });
  grantFixtureCapabilities(coordinatorStore(target));

    const imported = await target.importKnowledge({ bundle_dir: bundle.bundle_dir });
    // Only the legitimate project/public entries become candidates; the
    // smuggled private entry is skipped, and ghost's role is not installed.
    expect(imported.created_candidates.map((candidate) => candidate.document_key).sort()).toEqual(["blog", "state"]);
    expect(imported.skipped).toEqual([
      { owner_role_id: "keeper", document_key: "notes", reason: "visibility_not_shareable" },
      { owner_role_id: "ghost", document_key: "state", reason: "role_not_installed" },
    ]);
    target.close();
  });

  it("keeps a stale-baseline candidate but its adoption conflicts", async () => {
    const source = makeSource();
    const bundle = exportKnowledge(coordinatorStore(source.coordinator), { scope: "share" });
    source.coordinator.close();

    const targetRoot = makeRoot("dst");
    const target = Coordinator.open({ root: targetRoot });
    const targetPack = join(targetRoot, "pack");
    writePack({ dir: targetPack, name: "src-pack", roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }] }] });
    installRolePack(coordinatorStore(target), { sourcePath: targetPack });
  grantFixtureCapabilities(coordinatorStore(target));
    const targetSession = testingOpenPrimarySession(target, { role_id: "keeper" });
    // Target advances its own state to revision 1 before importing.
    await target.publishDocument({
      session_id: targetSession.session_id,
      document_key: "state",
      body: "local v1",
      expected_revision: 0,
      expected_generation: targetSession.generation,
    });

    const imported = await target.importKnowledge({ bundle_dir: bundle.bundle_dir });
    const stateCandidate = imported.created_candidates.find((candidate) => candidate.document_key === "state");
    expect(stateCandidate?.baseline_revision).toBe(1);

    // Adoption re-validates the baseline: exported revision 1 equals local
    // latest 1, so this one actually adopts. Advance again to make it stale.
    await target.publishDocument({
      session_id: targetSession.session_id,
      document_key: "state",
      body: "local v2",
      expected_revision: 1,
      expected_generation: targetSession.generation,
    });
    await expectError("REVISION_CONFLICT", () =>
      target.publishDocument({
        session_id: targetSession.session_id,
        document_key: "state",
        body: "unused",
        expected_revision: 2,
        expected_generation: targetSession.generation,
        candidate_id: stateCandidate?.candidate_id ?? "missing",
      }),
    );
    // Candidate content preserved.
    const still = listCandidates(coordinatorStore(target), { state: "open" }).find(
      (candidate) => candidate.candidate_id === stateCandidate?.candidate_id,
    );
    expect(still).toBeDefined();
    target.close();
  });
});
