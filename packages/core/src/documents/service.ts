import { randomBytes } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";
import type { CandidateUpdate, DocumentVisibility, RoleDefinition } from "@roledock/protocol";
import { getHead, getRoleRow } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { bodyHash, putObject, readObject } from "../store/objects.js";
import {
  recordReadReceipt,
  requireRoleIdentity,
  resolveSessionIdentity,
} from "../sessions/internal.js";
import type { TrustedIdentity } from "../identity.js";

type SessionIdentity = TrustedIdentity & { kind: "primary" | "request" };

interface DocumentRegistryRow {
  workspace_id: string;
  role_id: string;
  document_key: string;
  latest_revision: number;
}

interface DocumentRevisionRow {
  workspace_id: string;
  role_id: string;
  document_key: string;
  revision: number;
  content_hash: string;
  visibility: DocumentVisibility;
  created_by_instance_id: string | null;
  created_at: string;
}

function getDocumentRow(
  store: WorkspaceStore,
  ownerRoleId: string,
  documentKey: string,
): DocumentRegistryRow | undefined {
  return store
    .prepare("SELECT * FROM documents WHERE role_id = ? AND document_key = ?")
    .get(ownerRoleId, documentKey) as DocumentRegistryRow | undefined;
}

function getRevisionRow(
  store: WorkspaceStore,
  ownerRoleId: string,
  documentKey: string,
  revision: number,
): DocumentRevisionRow | undefined {
  return store
    .prepare(
      "SELECT * FROM document_revisions WHERE role_id = ? AND document_key = ? AND revision = ?",
    )
    .get(ownerRoleId, documentKey, revision) as DocumentRevisionRow | undefined;
}

function declaredDocuments(
  store: WorkspaceStore,
  roleId: string,
): NonNullable<RoleDefinition["documents"]> {
  const role = getRoleRow(store, roleId);
  if (role === undefined) {
    throw new RoleDockError("NOT_FOUND", `Role "${roleId}" is not installed in this workspace.`, {
      details: { role_id: roleId },
    });
  }
  const definition = JSON.parse(role.definition_json) as RoleDefinition;
  return definition.documents ?? [];
}

/**
 * The visibility matrix (docs/spec/objects-and-state-machines.md §5):
 * private — owning instance only; role — owning role's primary sessions;
 * project/public — any active session in the workspace. Request-branch
 * sessions (kind="request") read only explicitly shared levels: identical
 * role_id alone never unlocks role or private material.
 */
export function canRead(
  identity: Pick<SessionIdentity, "kind" | "roleId" | "instanceId">,
  ownerRoleId: string,
  visibility: DocumentVisibility,
  createdByInstanceId: string | null,
): boolean {
  switch (visibility) {
    case "public":
    case "project":
      return true;
    case "role":
      return identity.kind === "primary" && identity.roleId === ownerRoleId;
    case "private":
      return (
        identity.kind === "primary" &&
        identity.roleId === ownerRoleId &&
        identity.instanceId === createdByInstanceId
      );
  }
}

function requireVisible(
  identity: SessionIdentity,
  ownerRoleId: string,
  visibility: DocumentVisibility,
  createdByInstanceId: string | null,
): void {
  if (!canRead(identity, ownerRoleId, visibility, createdByInstanceId)) {
    throw new RoleDockError(
      "PERMISSION_DENIED",
      `Document is not readable at visibility "${visibility}" by this session.`,
      {
        details: {
          visibility,
          reader_role_id: identity.roleId ?? null,
          session_kind: identity.kind,
        },
      },
    );
  }
}

// -- documents.list -----------------------------------------------------------

export interface DocumentListEntry {
  owner_role_id: string;
  document_key: string;
  title?: string;
  published: boolean;
  latest_revision?: number;
  latest_content_hash?: string;
  visibility?: DocumentVisibility;
  updated_at?: string;
}

export function listDocuments(
  store: WorkspaceStore,
  input: { session_id: string; role_id?: string },
): { documents: DocumentListEntry[] } {
  const identity = resolveSessionIdentity(store, input.session_id);
  const ownerRoles =
    input.role_id !== undefined
      ? [input.role_id]
      : (store.prepare("SELECT role_id FROM roles ORDER BY role_id").all() as Array<{
          role_id: string;
        }>).map((row) => row.role_id);

  const documents: DocumentListEntry[] = [];
  for (const ownerRoleId of ownerRoles) {
    for (const declared of declaredDocuments(store, ownerRoleId)) {
      const registry = getDocumentRow(store, ownerRoleId, declared.key);
      if (registry === undefined || registry.latest_revision <= 0) {
        // Unpublished declared documents are visible to the owning role's
        // primary sessions only; nobody else learns they exist.
        if (identity.kind === "primary" && identity.roleId === ownerRoleId) {
          documents.push({
            owner_role_id: ownerRoleId,
            document_key: declared.key,
            title: declared.title,
            published: false,
          });
        }
        continue;
      }
      const latest = getRevisionRow(store, ownerRoleId, declared.key, registry.latest_revision);
      if (latest === undefined) {
        throw new RoleDockError("INTERNAL", "Document registry points at a missing revision.");
      }
      if (!canRead(identity, ownerRoleId, latest.visibility, latest.created_by_instance_id)) {
        continue;
      }
      documents.push({
        owner_role_id: ownerRoleId,
        document_key: declared.key,
        published: true,
        latest_revision: latest.revision,
        latest_content_hash: latest.content_hash,
        visibility: latest.visibility,
        updated_at: latest.created_at,
      });
    }
  }
  return { documents };
}

// -- documents.read -----------------------------------------------------------

export interface DocumentReadResult {
  owner_role_id: string;
  document_key: string;
  revision: number;
  content_hash: string;
  visibility: DocumentVisibility;
  created_at: string;
  created_by_instance_id: string | null;
  body: string;
  receipt_id: string;
}

export function readDocument(
  store: WorkspaceStore,
  input: { session_id: string; target_role_id?: string; document_key: string; revision?: number },
): DocumentReadResult {
  const identity = resolveSessionIdentity(store, input.session_id);
  const ownerRoleId = input.target_role_id ?? identity.roleId;
  if (ownerRoleId === undefined) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      "target_role_id is required when the calling session has no role binding.",
    );
  }
  const registry = getDocumentRow(store, ownerRoleId, input.document_key);
  if (registry === undefined || registry.latest_revision <= 0) {
    throw new RoleDockError(
      "NOT_FOUND",
      `No published document "${input.document_key}" for role "${ownerRoleId}".`,
      { details: { owner_role_id: ownerRoleId, document_key: input.document_key } },
    );
  }
  const revision = input.revision ?? registry.latest_revision;
  if (revision < 1 || revision > registry.latest_revision) {
    throw new RoleDockError(
      "NOT_FOUND",
      `Revision ${revision} of "${input.document_key}" does not exist (latest: ${registry.latest_revision}).`,
      { details: { revision, latest_revision: registry.latest_revision } },
    );
  }
  const revisionRow = getRevisionRow(store, ownerRoleId, input.document_key, revision);
  if (revisionRow === undefined) {
    throw new RoleDockError("INTERNAL", "Revision row missing for a published revision.");
  }
  requireVisible(identity, ownerRoleId, revisionRow.visibility, revisionRow.created_by_instance_id);

  const body = readObject(store, revisionRow.content_hash);
  if (bodyHash(body) !== revisionRow.content_hash) {
    throw new RoleDockError(
      "INTERNAL",
      "Stored document body does not match its content hash; the content store is corrupt.",
    );
  }
  const receipt = recordReadReceipt(store, {
    session_id: identity.sessionId,
    owner_role_id: ownerRoleId,
    document_key: input.document_key,
    revision,
    content_hash: revisionRow.content_hash,
  });

  return {
    owner_role_id: ownerRoleId,
    document_key: input.document_key,
    revision,
    content_hash: revisionRow.content_hash,
    visibility: revisionRow.visibility,
    created_at: revisionRow.created_at,
    created_by_instance_id: revisionRow.created_by_instance_id,
    body,
    receipt_id: receipt.receipt_id,
  };
}

// -- documents.publish ----------------------------------------------------------

export interface DocumentPublishResult {
  owner_role_id: string;
  document_key: string;
  revision: number;
  content_hash: string;
  visibility: DocumentVisibility;
  knowledge_revision: number;
  candidate_id?: string;
}

export function publishDocument(
  store: WorkspaceStore,
  input: {
    session_id: string;
    document_key: string;
    body: string;
    expected_revision: number;
    expected_generation: number;
    candidate_id?: string;
  },
): DocumentPublishResult {
  const identity = requireRoleIdentity(resolveSessionIdentity(store, input.session_id));
  const ownerRoleId = identity.roleId;
  const now = new Date().toISOString();

  return store.tx(() => {
    const head = getHead(store, ownerRoleId);
    if (head === undefined) {
      throw new RoleDockError("ROLE_UNINITIALIZED", `Role "${ownerRoleId}" has no primary pointer.`);
    }
    // Old-generation publish: the session's instance is not the current
    // primary (retired by a later fixture bump or, in P3, a handoff).
    if (head.current_instance_id !== identity.instanceId) {
      throw new RoleDockError(
        "INVALID_STATE_TRANSITION",
        `Publishing requires the current primary instance; instance "${identity.instanceId}" is not primary for role "${ownerRoleId}".`,
        {
          details: {
            current_instance_id: head.current_instance_id,
            session_instance_id: identity.instanceId,
          },
        },
      );
    }
    if (input.expected_generation !== head.generation) {
      throw new RoleDockError(
        "GENERATION_CONFLICT",
        `expected_generation ${input.expected_generation} does not match the current generation ${head.generation}.`,
        {
          details: {
            current_generation: head.generation,
            expected_generation: input.expected_generation,
          },
        },
      );
    }

    // The document key must be declared by the owning role's pack.
    const declaration = declaredDocuments(store, ownerRoleId).find(
      (document) => document.key === input.document_key,
    );
    if (declaration === undefined) {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Document key "${input.document_key}" is not declared by role "${ownerRoleId}".`,
        { details: { document_key: input.document_key } },
      );
    }

    const registry = getDocumentRow(store, ownerRoleId, input.document_key);
    const latestRevision = registry?.latest_revision ?? 0;
    if (input.expected_revision !== latestRevision) {
      // Stale baseline: the concurrent winner keeps the revision; the loser's
      // content survives by re-submitting through documents.propose.
      throw new RoleDockError(
        "REVISION_CONFLICT",
        `expected_revision ${input.expected_revision} does not match current revision ${latestRevision}.`,
        {
          details: {
            current_revision: latestRevision,
            expected_revision: input.expected_revision,
            document_key: input.document_key,
          },
        },
      );
    }

    let body = input.body;
    let candidateId: string | undefined;
    if (input.candidate_id !== undefined) {
      // Adoption re-validates the candidate against the current baseline.
      const candidate = store
        .prepare("SELECT * FROM candidate_updates WHERE candidate_id = ?")
        .get(input.candidate_id) as CandidateUpdate | undefined;
      if (candidate === undefined) {
        throw new RoleDockError("NOT_FOUND", `Candidate "${input.candidate_id}" does not exist.`, {
          details: { candidate_id: input.candidate_id },
        });
      }
      if (
        candidate.target_role_id !== ownerRoleId ||
        candidate.document_key !== input.document_key ||
        candidate.state !== "open"
      ) {
        throw new RoleDockError(
          "VALIDATION_FAILED",
          `Candidate "${input.candidate_id}" does not target this document or is not open.`,
          { details: { candidate_id: input.candidate_id, state: candidate.state } },
        );
      }
      if (candidate.baseline_revision !== latestRevision) {
        throw new RoleDockError(
          "REVISION_CONFLICT",
          `Candidate baseline ${candidate.baseline_revision} is stale; current revision is ${latestRevision}. The candidate content is preserved.`,
          {
            details: {
              candidate_id: input.candidate_id,
              current_revision: latestRevision,
              candidate_baseline: candidate.baseline_revision,
            },
          },
        );
      }
      body = readObject(store, candidate.proposed_body_hash);
      candidateId = candidate.candidate_id;
    }

    const revision = latestRevision + 1;
    const contentHash = putObject(store, body);
    store
      .prepare(
        `INSERT INTO document_revisions (workspace_id, role_id, document_key, revision, content_hash, visibility, created_by_instance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        store.workspaceId,
        ownerRoleId,
        input.document_key,
        revision,
        contentHash,
        declaration.visibility,
        identity.instanceId,
        now,
      );
    if (registry === undefined) {
      store
        .prepare("INSERT INTO documents (workspace_id, role_id, document_key, latest_revision) VALUES (?, ?, ?, ?)")
        .run(store.workspaceId, ownerRoleId, input.document_key, revision);
    } else {
      store
        .prepare("UPDATE documents SET latest_revision = ? WHERE role_id = ? AND document_key = ?")
        .run(revision, ownerRoleId, input.document_key);
    }
    // Every related knowledge publish bumps the role's knowledge version.
    const knowledgeRevision = head.knowledge_revision + 1;
    store
      .prepare("UPDATE role_heads SET knowledge_revision = ?, updated_at = ? WHERE role_id = ?")
      .run(knowledgeRevision, now, ownerRoleId);

    if (candidateId !== undefined) {
      store
        .prepare(
          "UPDATE candidate_updates SET state = 'adopted', adopted_revision = ?, resolved_at = ? WHERE candidate_id = ?",
        )
        .run(revision, now, candidateId);
    }

    return {
      owner_role_id: ownerRoleId,
      document_key: input.document_key,
      revision,
      content_hash: contentHash,
      visibility: declaration.visibility,
      knowledge_revision: knowledgeRevision,
      ...(candidateId !== undefined ? { candidate_id: candidateId } : {}),
    };
  });
}

// -- documents.propose ----------------------------------------------------------

export interface CandidateProposalResult {
  candidate_id: string;
  target_role_id: string;
  document_key: string;
  baseline_revision: number;
  proposed_body_hash: string;
  source: CandidateUpdate["source"];
  state: CandidateUpdate["state"];
  created_at: string;
}

export function proposeDocumentUpdate(
  store: WorkspaceStore,
  input: {
    session_id: string;
    target_role_id: string;
    document_key: string;
    body: string;
    note?: string;
  },
): CandidateProposalResult {
  const identity = requireRoleIdentity(resolveSessionIdentity(store, input.session_id));
  const now = new Date().toISOString();

  return store.tx(() => {
    const registry = getDocumentRow(store, input.target_role_id, input.document_key);
    const latestRevision = registry?.latest_revision ?? 0;
    if (latestRevision > 0) {
      // Proposers must be able to see what they propose against.
      const latest = getRevisionRow(store, input.target_role_id, input.document_key, latestRevision);
      if (latest === undefined) {
        throw new RoleDockError("INTERNAL", "Document registry points at a missing revision.");
      }
      requireVisible(identity, input.target_role_id, latest.visibility, latest.created_by_instance_id);
    } else if (identity.roleId !== input.target_role_id) {
      throw new RoleDockError(
        "PERMISSION_DENIED",
        `No published document "${input.document_key}" for role "${input.target_role_id}"; only the owning role can hold candidates for it.`,
        { details: { target_role_id: input.target_role_id, document_key: input.document_key } },
      );
    }

    const candidate: CandidateUpdate = {
      candidate_id: `cand-${randomBytes(5).toString("hex")}`,
      workspace_id: store.workspaceId,
      target_role_id: input.target_role_id,
      document_key: input.document_key,
      baseline_revision: latestRevision,
      proposed_body_hash: putObject(store, input.body),
      ...(input.note !== undefined ? { note: input.note } : {}),
      proposed_by_session_id: identity.sessionId,
      proposed_by_role_id: identity.roleId,
      source: "documents.propose",
      state: "open",
      created_at: now,
    };
    store
      .prepare(
        `INSERT INTO candidate_updates (candidate_id, workspace_id, target_role_id, document_key, baseline_revision, proposed_body_hash, note, proposed_by_session_id, proposed_by_role_id, source, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        candidate.candidate_id,
        candidate.workspace_id,
        candidate.target_role_id,
        candidate.document_key,
        candidate.baseline_revision,
        candidate.proposed_body_hash,
        candidate.note ?? null,
        candidate.proposed_by_session_id,
        candidate.proposed_by_role_id,
        candidate.source,
        candidate.created_at,
      );
    return {
      candidate_id: candidate.candidate_id,
      target_role_id: candidate.target_role_id,
      document_key: candidate.document_key,
      baseline_revision: candidate.baseline_revision,
      proposed_body_hash: candidate.proposed_body_hash,
      source: candidate.source,
      state: candidate.state,
      created_at: candidate.created_at,
    };
  });
}

export function listCandidates(
  store: WorkspaceStore,
  filter: { target_role_id?: string; state?: CandidateUpdate["state"] } = {},
): CandidateUpdate[] {
  const rows = store
    .prepare("SELECT * FROM candidate_updates ORDER BY created_at")
    .all() as unknown as CandidateUpdate[];
  return rows.filter(
    (candidate) =>
      (filter.target_role_id === undefined || candidate.target_role_id === filter.target_role_id) &&
      (filter.state === undefined || candidate.state === filter.state),
  );
}
