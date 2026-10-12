import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { RoleDockError, validate } from "@roledock/protocol";
import type {
  CandidateUpdate,
  Checkpoint,
  KnowledgeExportCheckpoint,
  KnowledgeExportEntry,
  KnowledgeExportManifest,
  KnowledgeExportScope,
} from "@roledock/protocol";
import { getLatestCheckpoint } from "../documents/checkpoint.js";
import { getRoleRow } from "../store/queries.js";
import { objectPath, putObject } from "../store/objects.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { asRecord, optionalString } from "../parse.js";

// -- knowledge.export -----------------------------------------------------------

export interface ExportResult {
  export_id: string;
  scope: KnowledgeExportScope;
  bundle_dir: string;
  manifest: KnowledgeExportManifest;
  entry_count: number;
  checkpoint_count: number;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Export role knowledge as a Markdown + manifest bundle.
 *
 * scope "share" (default) carries only explicitly shared material — public
 * and project documents — and never checkpoints, credentials, private chats
 * or role-private material, so it is the pack a second adapter consumes.
 * scope "workspace" is the owner-local full export including checkpoints.
 * Hashes are recomputed while writing; the manifest is validated against the
 * protocol schema before the export succeeds.
 */
export function exportKnowledge(
  store: WorkspaceStore,
  input: { scope?: KnowledgeExportScope; role_id?: string },
): ExportResult {
  const scope = input.scope ?? "share";
  if (scope !== "share" && scope !== "workspace") {
    throw new RoleDockError("VALIDATION_FAILED", `Unknown export scope "${String(input.scope)}".`);
  }
  const now = new Date().toISOString();
  const exportId = `export-${randomBytes(4).toString("hex")}`;
  const bundleDir = join(store.root, ".roledock", "exports", exportId);
  mkdirSync(bundleDir, { recursive: true });

  const revisionRows = store
    .prepare(
      `SELECT dr.role_id, dr.document_key, dr.revision, dr.content_hash, dr.visibility, dr.created_by_instance_id, dr.created_at
       FROM document_revisions dr
       JOIN documents d ON d.role_id = dr.role_id AND d.document_key = dr.document_key AND d.latest_revision = dr.revision
       ORDER BY dr.role_id, dr.document_key`,
    )
    .all() as unknown as Array<{
    role_id: string;
    document_key: string;
    revision: number;
    content_hash: string;
    visibility: KnowledgeExportEntry["visibility"];
    created_by_instance_id: string | null;
    created_at: string;
  }>;

  const entries: KnowledgeExportEntry[] = [];
  for (const row of revisionRows) {
    if (input.role_id !== undefined && row.role_id !== input.role_id) continue;
    if (scope === "share" && (row.visibility === "private" || row.visibility === "role")) {
      continue;
    }
    const sourcePath = objectPath(store, row.content_hash);
    const file = join("documents", row.role_id, `${row.document_key}-r${row.revision}.md`);
    const targetPath = join(bundleDir, file);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    // Verify what we wrote: the bundle entry hash must match the stored
    // revision hash, recomputed from the copied file.
    const writtenHash = sha256File(targetPath);
    if (writtenHash !== row.content_hash) {
      throw new RoleDockError(
        "INTERNAL",
        `Export content hash mismatch for ${row.role_id}/${row.document_key}; aborting.`,
      );
    }
    entries.push({
      owner_role_id: row.role_id,
      document_key: row.document_key,
      revision: row.revision,
      content_hash: row.content_hash,
      visibility: row.visibility,
      created_by_instance_id: row.created_by_instance_id ?? "unknown",
      created_at: row.created_at,
      file,
    });
  }

  const manifest: KnowledgeExportManifest = {
    manifest_version: "0.1",
    source_workspace_id: store.workspaceId,
    scope,
    exported_at: now,
    content_hash_algorithm: "sha256",
    entries,
  };

  if (scope === "workspace") {
    const checkpoints: KnowledgeExportCheckpoint[] = [];
    const roleRows = store.prepare("SELECT role_id FROM roles ORDER BY role_id").all() as Array<{
      role_id: string;
    }>;
    for (const role of roleRows) {
      const checkpoint = getLatestCheckpoint(store, role.role_id);
      if (checkpoint === undefined) continue;
      const checkpointFile = join("checkpoints", `${checkpoint.role_id}-${checkpoint.checkpoint_id}.json`);
      const checkpointPath = join(bundleDir, checkpointFile);
      mkdirSync(dirname(checkpointPath), { recursive: true });
      writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
      checkpoints.push({
        checkpoint_id: checkpoint.checkpoint_id,
        role_id: checkpoint.role_id,
        generation: checkpoint.generation,
        knowledge_revision: checkpoint.knowledge_revision,
        content_hash: sha256File(checkpointPath),
        file: checkpointFile,
      });
    }
    if (checkpoints.length > 0) manifest.checkpoints = checkpoints;
  }

  const validated = validate<KnowledgeExportManifest>("knowledge-export", manifest);
  if (!validated.ok) {
    throw new RoleDockError("INTERNAL", "Export manifest failed protocol validation.", {
      details: { errors: validated.errors },
    });
  }
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return {
    export_id: exportId,
    scope,
    bundle_dir: bundleDir,
    manifest,
    entry_count: entries.length,
    checkpoint_count: manifest.checkpoints?.length ?? 0,
  };
}

// -- knowledge.import -------------------------------------------------------------

export interface ImportSkip {
  owner_role_id: string;
  document_key: string;
  reason: "role_not_installed" | "visibility_not_shareable" | "undeclared_document_key";
}

export interface ImportResult {
  source_workspace_id: string;
  created_candidates: Array<{
    candidate_id: string;
    target_role_id: string;
    document_key: string;
    baseline_revision: number;
  }>;
  skipped: ImportSkip[];
}

/**
 * Import a knowledge export bundle as candidate updates (ADR-0004: external
 * material merges through candidates, never by silent rewrite). Every body
 * file's SHA-256 is recomputed and compared to the manifest before any
 * database write; a tampered bundle fails with the database unchanged.
 * Entries that are not explicitly shareable (private/role) or whose role is
 * not installed in this workspace are skipped and reported.
 */
export function importKnowledge(store: WorkspaceStore, input: { bundle_dir: string }): ImportResult {
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(join(input.bundle_dir, "manifest.json"), "utf8");
  } catch {
    throw new RoleDockError("VALIDATION_FAILED", `Bundle manifest not found in ${input.bundle_dir}.`, {
      details: { bundle_dir: input.bundle_dir, issue: "missing manifest.json" },
    });
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new RoleDockError("VALIDATION_FAILED", `Bundle manifest is not valid JSON: ${(error as Error).message}`);
  }
  const validated = validate<KnowledgeExportManifest>("knowledge-export", manifest);
  if (!validated.ok) {
    throw new RoleDockError("VALIDATION_FAILED", "Bundle manifest failed protocol validation.", {
      details: { errors: validated.errors },
    });
  }
  const manifestData = validated.value;

  // Verify every entry hash first: a tampered bundle must not touch the DB.
  for (const entry of manifestData.entries) {
    const filePath = join(input.bundle_dir, entry.file);
    let actual: string;
    try {
      actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    } catch {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Bundle entry missing: ${entry.file}`,
        { details: { file: entry.file, issue: "missing file" } },
      );
    }
    if (actual !== entry.content_hash) {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Bundle entry tampered: ${entry.file} content hash does not match the manifest.`,
        {
          details: {
            file: entry.file,
            expected_content_hash: entry.content_hash,
            actual_content_hash: actual,
            issue: "content hash mismatch",
          },
        },
      );
    }
  }
  for (const checkpoint of manifestData.checkpoints ?? []) {
    const filePath = join(input.bundle_dir, checkpoint.file);
    let actual: string;
    try {
      actual = sha256File(filePath);
    } catch {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Bundle checkpoint missing: ${checkpoint.file}`,
        { details: { file: checkpoint.file, issue: "missing file" } },
      );
    }
    if (actual !== checkpoint.content_hash) {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Bundle checkpoint tampered: ${checkpoint.file}`,
        { details: { file: checkpoint.file, issue: "content hash mismatch" } },
      );
    }
  }

  const now = new Date().toISOString();
  const created: ImportResult["created_candidates"] = [];
  const skipped: ImportSkip[] = [];

  return store.tx(() => {
    for (const entry of manifestData.entries) {
      // Only explicitly shareable material can enter another workspace.
      if (entry.visibility === "private" || entry.visibility === "role") {
        skipped.push({
          owner_role_id: entry.owner_role_id,
          document_key: entry.document_key,
          reason: "visibility_not_shareable",
        });
        continue;
      }
      if (getRoleRow(store, entry.owner_role_id) === undefined) {
        skipped.push({
          owner_role_id: entry.owner_role_id,
          document_key: entry.document_key,
          reason: "role_not_installed",
        });
        continue;
      }
      // The target document key must be declared by the installed pack.
      const role = getRoleRow(store, entry.owner_role_id);
      if (role === undefined) {
        skipped.push({
          owner_role_id: entry.owner_role_id,
          document_key: entry.document_key,
          reason: "role_not_installed",
        });
        continue;
      }
      const definition = JSON.parse(role.definition_json) as {
        documents?: Array<{ key: string }>;
      };
      if (!(definition.documents ?? []).some((document) => document.key === entry.document_key)) {
        skipped.push({
          owner_role_id: entry.owner_role_id,
          document_key: entry.document_key,
          reason: "undeclared_document_key",
        });
        continue;
      }

      const body = readFileSync(join(input.bundle_dir, entry.file), "utf8");
      // Store the verified body content-addressed; adoption reads it back.
      const proposedBodyHash = putObject(store, body);
      const candidate: CandidateUpdate = {
        candidate_id: `cand-${randomBytes(5).toString("hex")}`,
        workspace_id: store.workspaceId,
        target_role_id: entry.owner_role_id,
        document_key: entry.document_key,
        baseline_revision: entry.revision,
        proposed_body_hash: proposedBodyHash,
        proposed_by_session_id: `import-${manifestData.source_workspace_id}`,
        proposed_by_role_id: entry.owner_role_id,
        source: "knowledge.import",
        state: "open",
        created_at: now,
      };
      store
        .prepare(
          `INSERT INTO candidate_updates (candidate_id, workspace_id, target_role_id, document_key, baseline_revision, proposed_body_hash, proposed_by_session_id, proposed_by_role_id, source, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          candidate.candidate_id,
          candidate.workspace_id,
          candidate.target_role_id,
          candidate.document_key,
          candidate.baseline_revision,
          candidate.proposed_body_hash,
          candidate.proposed_by_session_id,
          candidate.proposed_by_role_id,
          candidate.source,
          candidate.created_at,
        );
      created.push({
        candidate_id: candidate.candidate_id,
        target_role_id: candidate.target_role_id,
        document_key: candidate.document_key,
        baseline_revision: candidate.baseline_revision,
      });
    }
    return { source_workspace_id: manifestData.source_workspace_id, created_candidates: created, skipped };
  });
}
