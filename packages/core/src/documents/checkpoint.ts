import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { RoleDockError, validate } from "@roledock/protocol";
import type { Checkpoint, CheckpointSource, CheckpointTodo, UserDecisionRef } from "@roledock/protocol";
import { getHead } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";

export interface BuildCheckpointInput {
  role_id: string;
  /** Handoff summary text, supplied by the caller; P2 has no model summary service. */
  summary_body: string;
  user_decision_refs?: UserDecisionRef[];
  todos?: CheckpointTodo[];
  sources?: CheckpointSource[];
  workspace_id?: string;
}

export interface BuiltCheckpoint extends Checkpoint {
  summary_content_hash: string;
}

/**
 * Build and persist a role checkpoint (docs/spec/objects-and-state-machines.md).
 *
 * Snapshots reference exactly the persisted revisions of the role's published
 * documents — never unpublished or in-memory content, so a restored session
 * never mistakes unpersisted material for recovered fact. The caller-supplied
 * summary is stored with its own hash and timestamp; the framework does not
 * claim the summary is lossless.
 */
export function buildCheckpoint(store: WorkspaceStore, input: BuildCheckpointInput): BuiltCheckpoint {
  if (input.workspace_id !== undefined && input.workspace_id !== store.workspaceId) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Workspace id mismatch: this handle operates on ${store.workspaceId}, not ${input.workspace_id}.`,
      { details: { expected: store.workspaceId, provided: input.workspace_id } },
    );
  }
  const now = new Date().toISOString();

  return store.tx(() => {
    const head = getHead(store, input.role_id);
    if (head === undefined || head.generation === 0) {
      throw new RoleDockError(
        "ROLE_UNINITIALIZED",
        `Role "${input.role_id}" has no primary instance; open the role before building a checkpoint.`,
        { details: { role_id: input.role_id } },
      );
    }
    if (head.current_instance_id === null) {
      throw new RoleDockError("INTERNAL", "Initialized role head without a current instance.");
    }

    // Snapshots over persisted revisions only: published documents of this
    // role, each at its exact current revision and content hash.
    const registryRows = store
      .prepare("SELECT document_key, latest_revision FROM documents WHERE role_id = ? ORDER BY document_key")
      .all(input.role_id) as Array<{ document_key: string; latest_revision: number }>;
    const documentSnapshots = registryRows
      .filter((row) => row.latest_revision > 0)
      .map((row) => {
        const revision = store
          .prepare(
            "SELECT content_hash FROM document_revisions WHERE role_id = ? AND document_key = ? AND revision = ?",
          )
          .get(input.role_id, row.document_key, row.latest_revision) as
          | { content_hash: string }
          | undefined;
        if (revision === undefined) {
          throw new RoleDockError("INTERNAL", "Document registry points at a missing revision.");
        }
        return {
          document_key: row.document_key,
          revision: row.latest_revision,
          content_hash: revision.content_hash,
        };
      });

    const summaryContentHash = createHash("sha256").update(input.summary_body, "utf8").digest("hex");
    const checkpoint: Checkpoint = {
      checkpoint_id: `ckpt-${randomBytes(5).toString("hex")}`,
      workspace_id: store.workspaceId,
      role_id: input.role_id,
      generation: head.generation,
      knowledge_revision: head.knowledge_revision,
      document_snapshots: documentSnapshots,
      handoff_summary: {
        format: "markdown",
        body: input.summary_body,
        content_hash: summaryContentHash,
      },
      ...(input.user_decision_refs !== undefined && input.user_decision_refs.length > 0
        ? { user_decision_refs: input.user_decision_refs }
        : {}),
      todos: input.todos ?? [],
      sources: input.sources ?? [],
      created_by_instance_id: head.current_instance_id,
      created_at: now,
    };
    const validated = validate<Checkpoint>("checkpoint", checkpoint);
    if (!validated.ok) {
      throw new RoleDockError("INTERNAL", "Built checkpoint failed protocol validation.", {
        details: { errors: validated.errors },
      });
    }

    store
      .prepare(
        `INSERT INTO checkpoints (checkpoint_id, workspace_id, role_id, generation, knowledge_revision, document_snapshots_json, handoff_summary_json, user_decision_refs_json, todos_json, sources_json, created_by_instance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.checkpoint_id,
        checkpoint.workspace_id,
        checkpoint.role_id,
        checkpoint.generation,
        checkpoint.knowledge_revision,
        JSON.stringify(checkpoint.document_snapshots),
        JSON.stringify(checkpoint.handoff_summary),
        checkpoint.user_decision_refs !== undefined ? JSON.stringify(checkpoint.user_decision_refs) : null,
        JSON.stringify(checkpoint.todos),
        JSON.stringify(checkpoint.sources),
        checkpoint.created_by_instance_id,
        checkpoint.created_at,
      );

    return { ...checkpoint, summary_content_hash: summaryContentHash };
  });
}

export function getLatestCheckpoint(store: WorkspaceStore, roleId: string): Checkpoint | undefined {
  const row = store
    .prepare(
      "SELECT * FROM checkpoints WHERE role_id = ? ORDER BY created_at DESC, checkpoint_id DESC LIMIT 1",
    )
    .get(roleId) as
    | {
        checkpoint_id: string;
        workspace_id: string;
        role_id: string;
        generation: number;
        knowledge_revision: number;
        document_snapshots_json: string;
        handoff_summary_json: string;
        user_decision_refs_json: string | null;
        todos_json: string;
        sources_json: string;
        created_by_instance_id: string;
        created_at: string;
      }
    | undefined;
  if (row === undefined) return undefined;
  const checkpoint: Checkpoint = {
    checkpoint_id: row.checkpoint_id,
    workspace_id: row.workspace_id,
    role_id: row.role_id,
    generation: row.generation,
    knowledge_revision: row.knowledge_revision,
    document_snapshots: JSON.parse(row.document_snapshots_json),
    handoff_summary: JSON.parse(row.handoff_summary_json),
    ...(row.user_decision_refs_json !== null
      ? { user_decision_refs: JSON.parse(row.user_decision_refs_json) }
      : {}),
    todos: JSON.parse(row.todos_json),
    sources: JSON.parse(row.sources_json),
    created_by_instance_id: row.created_by_instance_id,
    created_at: row.created_at,
  };
  return checkpoint;
}
