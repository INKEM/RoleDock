import { requireCapability, requireSessionCapability } from "../policy.js";
import { roleMaterial, documentMaterial } from "../sessions/material.js";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";
import type { CollaborationRequest, DocumentVisibility, ErrorCode } from "@roledock/protocol";
import { getHead, getRoleRow } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { bodyHash, readObject } from "../store/objects.js";
import { listReceiptsForSession, requireRoleIdentity, resolveSessionIdentity } from "../sessions/internal.js";
import { asRecord, optionalString, requiredString } from "../parse.js";
import type { TrustedIdentity } from "../identity.js";
import { sweepAuthorizations } from "../sessions/authorization.js";

type SessionIdentity = TrustedIdentity & { kind: "primary" | "request" };

export interface RequestBudget {
  max_turns?: number;
  max_output_bytes?: number;
  deadline?: string;
}

/**
 * Flat mirror of the requests table row. CollaborationRequest fields are
 * rebuilt in toPublicRequest; the row itself carries the DB column shapes.
 */
export interface RequestRow {
  request_id: string;
  workspace_id: string;
  idempotency_key: string;
  idem_content_hash: string;
  initiating_session_id: string;
  initiating_instance_id: string;
  initiating_role_id: string;
  target_role_id: string;
  binding_instance_id: string;
  binding_generation: number;
  binding_knowledge_revision: number;
  binding_snapshot_json: string;
  binding_contract_version: string;
  budget_json: string;
  question: string;
  state: CollaborationRequest["state"];
  execution_uncertain: number;
  execution_phase: string;
  turns_reserved: number;
  turn_key: string | null;
  cleanup_pending: number;
  output_bytes_used: number;
  binding_material_json: string | null;
  capability_scope_json: string;
  result_artifact_id: string | null;
  result_content_hash: string | null;
  error_json: string | null;
  cleanup_error_json: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

function getRequestRow(store: WorkspaceStore, requestId: string): RequestRow | undefined {
  return store.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId) as
    | RequestRow
    | undefined;
}

function getRequestByIdempotencyKey(
  store: WorkspaceStore,
  idempotencyKey: string,
): RequestRow | undefined {
  return store
    .prepare("SELECT * FROM requests WHERE workspace_id = ? AND idempotency_key = ?")
    .get(store.workspaceId, idempotencyKey) as RequestRow | undefined;
}

/** Shareable = explicitly shared levels only; consultation branches read these. */
function shareableSnapshot(
  store: WorkspaceStore,
  roleId: string,
): Array<{ document_key: string; revision: number; content_hash: string }> {
  const rows = store
    .prepare(
      `SELECT dr.document_key, dr.revision, dr.content_hash, dr.visibility
       FROM document_revisions dr
       JOIN documents d ON d.role_id = dr.role_id AND d.document_key = dr.document_key AND d.latest_revision = dr.revision
       WHERE dr.role_id = ? ORDER BY dr.document_key`,
    )
    .all(roleId) as unknown as Array<{
    document_key: string;
    revision: number;
    content_hash: string;
    visibility: DocumentVisibility;
  }>;
  return rows
    .filter((row) => row.visibility === "project" || row.visibility === "public")
    .map((row) => ({ document_key: row.document_key, revision: row.revision, content_hash: row.content_hash }));
}

export function requestTempDir(store: WorkspaceStore, requestId: string): string {
  return `${store.root}/.roledock/requests/${requestId}`;
}

/** Lazily expire: any read-path check moves overdue non-terminal requests to expired. */
export function expireIfOverdue(store: WorkspaceStore, row: RequestRow): RequestRow {
  if (row.state !== "accepted" && row.state !== "queued" && row.state !== "running" && row.state !== "awaiting_input") {
    return row;
  }
  const budget = JSON.parse(row.budget_json) as RequestBudget;
  if (budget.deadline === undefined || Date.parse(budget.deadline) > Date.now()) return row;
  const now = new Date().toISOString();
  store
    .prepare("UPDATE requests SET state = 'expired', cleanup_pending = 1, terminal_at = ?, updated_at = ? WHERE request_id = ?")
    .run(now, now, row.request_id);
  return { ...row, state: "expired", terminal_at: now, updated_at: now };
}

function requireParticipant(identity: SessionIdentity, row: RequestRow): void {
  const isInitiator =
    identity.sessionId === row.initiating_session_id ||
    (identity.instanceId !== undefined && identity.instanceId === row.initiating_instance_id);
  const isTargetOwner =
    identity.kind === "primary" && identity.roleId === row.target_role_id;
  if (!isInitiator && !isTargetOwner) {
    throw new RoleDockError(
      "PERMISSION_DENIED",
      "Only the initiating session or the target role's primary instance can access this request.",
      { details: { request_id: row.request_id } },
    );
  }
}

// -- requests.create -----------------------------------------------------------

export interface CreateRequestInput {
  session_id: string;
  target_role_id: string;
  question: string;
  idempotency_key: string;
  budget?: { max_turns?: number; max_output_bytes?: number; deadline?: string };
  read_exception_rationale?: string;
  workspace_id?: string;
}

export interface CreateRequestResult {
  request_id: string;
  state: "accepted";
  binding: {
    target_generation: number;
    knowledge_revision: number;
    target_instance_id: string;
    contract_version: string;
    snapshot_entries: number;
  };
  created: boolean;
}

function canonicalRequestContent(input: CreateRequestInput): string {
  return JSON.stringify({
    target_role_id: input.target_role_id,
    question: input.question,
    budget: input.budget ?? {},
    read_exception_rationale: input.read_exception_rationale ?? null,
  });
}

export function createRequest(store: WorkspaceStore, input: CreateRequestInput): CreateRequestResult {
  // New requests distinguish an expired/released target from a serviceable
  // primary even before the shared service's next maintenance tick.
  sweepAuthorizations(store);
  if (input.workspace_id !== undefined && input.workspace_id !== store.workspaceId) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Workspace id mismatch: this coordinator operates on ${store.workspaceId}, not ${input.workspace_id}.`,
      { details: { expected: store.workspaceId, provided: input.workspace_id } },
    );
  }
  const sessionIdentity = resolveSessionIdentity(store, input.session_id);
  requireSessionCapability(store, sessionIdentity, "requests.create");
  requireCapability(store, input.target_role_id, "requests.execute");
  requireCapability(store, input.target_role_id, "documents.read");
  // Prototype rejects nested auto-requests: consultation branches cannot create.
  if (sessionIdentity.kind !== "primary") {
    throw new RoleDockError(
      "PERMISSION_DENIED",
      "Nested auto-requests are rejected in the prototype: consultation branches cannot create requests.",
      { details: { session_id: sessionIdentity.sessionId, kind: sessionIdentity.kind } },
    );
  }
  const identity = requireRoleIdentity(sessionIdentity);
  if (input.question.trim().length === 0) {
    throw new RoleDockError("VALIDATION_FAILED", "Request question must not be empty.");
  }
  const budget = input.budget ?? {};
  if (budget.max_turns !== undefined && (!Number.isInteger(budget.max_turns) || budget.max_turns < 1)) {
    throw new RoleDockError("VALIDATION_FAILED", "budget.max_turns must be at least 1.");
  }
  if (budget.max_output_bytes !== undefined && (!Number.isInteger(budget.max_output_bytes) || budget.max_output_bytes < 0)) throw new RoleDockError("VALIDATION_FAILED", "Invalid output budget.");
  if (budget.deadline !== undefined && (!Number.isFinite(Date.parse(budget.deadline)) || Date.parse(budget.deadline) <= Date.now())) {
    throw new RoleDockError("VALIDATION_FAILED", "budget.deadline must be in the future.");
  }

  const now = new Date().toISOString();
  const contentHash = createHash("sha256").update(canonicalRequestContent(input), "utf8").digest("hex");

  // Idempotent creation: same key + same content returns the original.
  const existing = getRequestByIdempotencyKey(store, input.idempotency_key);
  if (existing !== undefined) {
    if (existing.initiating_session_id !== identity.sessionId) throw new RoleDockError("PERMISSION_DENIED", "Idempotency key belongs to another initiating session.");
    if (existing.idem_content_hash === contentHash) {
      return {
        request_id: existing.request_id,
        state: "accepted",
        binding: {
          target_generation: existing.binding_generation,
          knowledge_revision: existing.binding_knowledge_revision,
          target_instance_id: existing.binding_instance_id,
          contract_version: existing.binding_contract_version,
          snapshot_entries: JSON.parse(existing.binding_snapshot_json).length,
        },
        created: false,
      };
    }
    throw new RoleDockError(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key "${input.idempotency_key}" was already used with different content.`,
      {
        details: {
          idempotency_key: input.idempotency_key,
          request_id: existing.request_id,
        },
      },
    );
  }

  // Precondition material: this session's true read receipts, or an explicit
  // verifiable exception. Receipts are never taken from request input.
  const receipts = store.prepare(`SELECT rr.receipt_id FROM read_receipts rr
    JOIN document_revisions dr ON dr.role_id = rr.owner_role_id AND dr.document_key = rr.document_key
      AND dr.revision = rr.revision AND dr.content_hash = rr.content_hash AND dr.workspace_id = rr.workspace_id
    WHERE rr.session_id = ? AND rr.reader_role_id = ? AND rr.instance_id = ? AND rr.owner_role_id = ?`)
    .all(input.session_id, identity.roleId, identity.instanceId, input.target_role_id);
  if (receipts.length === 0 && (input.read_exception_rationale === undefined || input.read_exception_rationale.trim().length === 0)) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      "Request creation requires this session's read receipts or a read_exception_rationale (information-gap exception).",
      { details: { session_id: input.session_id, receipts: 0 } },
    );
  }

  return store.tx(() => {
    const targetRole = getRoleRow(store, input.target_role_id);
    if (targetRole === undefined) {
      throw new RoleDockError("NOT_FOUND", `Role "${input.target_role_id}" is not installed in this workspace.`, {
        details: { target_role_id: input.target_role_id },
      });
    }
    const head = getHead(store, input.target_role_id);
    if (head === undefined || head.generation === 0 || head.current_instance_id === null) {
      throw new RoleDockError(
        "ROLE_UNINITIALIZED",
        `Target role "${input.target_role_id}" has no primary instance; open the role first.`,
        { details: { target_role_id: input.target_role_id } },
      );
    }

    // Receive-time binding: fixed here, never migrated afterwards.
    const snapshot = shareableSnapshot(store, input.target_role_id);
    const requestId = `req-${randomBytes(5).toString("hex")}`;
    store
      .prepare(
        `INSERT INTO requests (request_id, workspace_id, idempotency_key, idem_content_hash, initiating_session_id, initiating_instance_id, initiating_role_id, target_role_id, binding_instance_id, binding_generation, binding_knowledge_revision, binding_snapshot_json, binding_contract_version, budget_json, question, state, execution_uncertain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?)`,
      )
      .run(
        requestId,
        store.workspaceId,
        input.idempotency_key,
        contentHash,
        identity.sessionId,
        identity.instanceId,
        identity.roleId,
        input.target_role_id,
        head.current_instance_id ?? "",
        head.generation,
        head.knowledge_revision,
        JSON.stringify(snapshot),
        targetRole.pack_version,
        JSON.stringify(budget),
        input.question,
        now,
        now,
      );
    const scope = ["documents.read", "documents.propose"].filter((capability) =>
      store.getConfig().policy.grants[input.target_role_id]?.includes(capability));
    const initiatingBinding = store.prepare("SELECT authorization_id FROM session_bindings WHERE session_id = ?").get(identity.sessionId) as { authorization_id: string } | undefined;
    const targetBinding = store.prepare("SELECT authorization_id, session_id FROM session_bindings WHERE instance_id = ?").get(head.current_instance_id) as { authorization_id: string; session_id: string } | undefined;
    if (targetBinding) {
      const targetIdentity = resolveSessionIdentity(store, targetBinding.session_id);
      requireSessionCapability(store, targetIdentity, "requests.execute");
      requireSessionCapability(store, targetIdentity, "documents.read");
      const loaded = store.prepare("SELECT capability_scope_json FROM sessions WHERE id = ?").get(targetBinding.session_id) as { capability_scope_json: string };
      const allowed = JSON.parse(loaded.capability_scope_json) as string[];
      for (let i = scope.length - 1; i >= 0; i--) if (!allowed.includes(scope[i]!)) scope.splice(i, 1);
    }
    store.prepare("UPDATE requests SET initiating_authorization_id = ?, target_authorization_id = ? WHERE request_id = ?")
      .run(initiatingBinding?.authorization_id ?? null, targetBinding?.authorization_id ?? null, requestId);
    const material = { role: roleMaterial(store, input.target_role_id), documents: documentMaterial(store, input.target_role_id, snapshot, true) };
    store.prepare("UPDATE requests SET binding_material_json = ?, capability_scope_json = ? WHERE request_id = ?")
      .run(JSON.stringify(material), JSON.stringify(scope), requestId);
    // Pending execution event: the outbox bridges to the (external) executor.
    store
      .prepare(
        "INSERT INTO outbox_events (id, workspace_id, kind, payload_json, state, created_at) VALUES (?, ?, 'request.execute', ?, 'pending', ?)",
      )
      .run(`evt-${requestId}`, store.workspaceId, JSON.stringify({ request_id: requestId }), now);

    return {
      request_id: requestId,
      state: "accepted" as const,
      binding: {
        target_generation: head.generation,
        knowledge_revision: head.knowledge_revision,
        target_instance_id: head.current_instance_id ?? "",
        contract_version: targetRole.pack_version,
        snapshot_entries: snapshot.length,
      },
      created: true,
    };
  });
}

// -- requests.get ---------------------------------------------------------------

export function getRequest(
  store: WorkspaceStore,
  input: { session_id: string; request_id: string },
): CollaborationRequest & { question: string; budget: RequestBudget } {
  const identity = resolveSessionIdentity(store, input.session_id);
  requireSessionCapability(store, identity, "requests.read");
  const row = getRequestRow(store, input.request_id);
  if (row === undefined) {
    throw new RoleDockError("NOT_FOUND", `Request "${input.request_id}" does not exist.`, {
      details: { request_id: input.request_id },
    });
  }
  requireParticipant(identity, row);
  const current = expireIfOverdue(store, row);
  return toPublicRequest(current);
}

function toPublicRequest(row: RequestRow): CollaborationRequest & { question: string; budget: RequestBudget } {
  return {
    request_id: row.request_id,
    workspace_id: row.workspace_id,
    idempotency_key: row.idempotency_key,
    initiating: {
      session_id: row.initiating_session_id,
      instance_id: row.initiating_instance_id,
      role_id: row.initiating_role_id,
    },
    target_role_id: row.target_role_id,
    binding: {
      target_generation: row.binding_generation,
      knowledge_revision: row.binding_knowledge_revision,
    },
    budget: JSON.parse(row.budget_json) as RequestBudget,
    state: row.state as CollaborationRequest["state"],
    ...(row.execution_uncertain === 1 ? { execution_uncertain: true } : {}),
    ...(row.result_artifact_id !== null && row.result_artifact_id !== undefined
      ? {
          result: {
            artifact_id: row.result_artifact_id,
            content_hash: row.result_content_hash ?? "",
          },
        }
      : {}),
    ...(row.error_json !== null && row.error_json !== undefined
      ? { error: JSON.parse(row.error_json) as { code: ErrorCode; message: string } }
      : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.terminal_at !== null && row.terminal_at !== undefined ? { terminal_at: row.terminal_at } : {}),
    question: row.question,
  };
}

// -- requests.reply ----------------------------------------------------------------

export function replyToRequest(
  store: WorkspaceStore,
  input: { session_id: string; request_id: string; body: string },
): CollaborationRequest & { question: string; budget: RequestBudget } {
  const identity = resolveSessionIdentity(store, input.session_id);
  requireSessionCapability(store, identity, "requests.reply");
  if (input.body.trim().length === 0) {
    throw new RoleDockError("VALIDATION_FAILED", "Reply body must not be empty.");
  }
  const expiring = getRequestRow(store, input.request_id);
  if (expiring?.initiating_session_id === identity.sessionId) expireIfOverdue(store, expiring);
  return store.tx(() => {
    const row = getRequestRow(store, input.request_id);
    if (row === undefined) {
      throw new RoleDockError("NOT_FOUND", `Request "${input.request_id}" does not exist.`);
    }
    // Only the initiator supplies input to their own request.
    if (identity.sessionId !== row.initiating_session_id) {
      throw new RoleDockError(
        "PERMISSION_DENIED",
        "Only the initiating session can reply to a request.",
        { details: { request_id: row.request_id } },
      );
    }
    const current = expireIfOverdue(store, row);
    if (current.state !== "awaiting_input") {
      throw new RoleDockError(
        "INVALID_STATE_TRANSITION",
        `Request is ${current.state}; replies are accepted only in awaiting_input.`,
        { details: { state: current.state } },
      );
    }
    const now = new Date().toISOString();
    store
      .prepare("UPDATE requests SET state = 'queued', question = ?, updated_at = ? WHERE request_id = ?")
      .run(`${current.question}\n\n[initiator input] ${input.body}`, now, row.request_id);
    store
      .prepare(
        "INSERT INTO outbox_events (id, workspace_id, kind, payload_json, state, created_at) VALUES (?, ?, 'request.execute', ?, 'pending', ?)",
      )
      .run(`evt-${row.request_id}-r${randomBytes(2).toString("hex")}`, store.workspaceId, JSON.stringify({ request_id: row.request_id }), now);
    const updated = getRequestRow(store, row.request_id) ?? current;
    return toPublicRequest({ ...updated, state: "queued" });
  });
}

// -- requests.cancel -----------------------------------------------------------------

const CANCELLABLE_STATES = new Set(["accepted", "queued", "awaiting_input"]);

export function cancelRequest(
  store: WorkspaceStore,
  adapterCancelDeclared: boolean,
  input: { session_id: string; request_id: string },
): CollaborationRequest & { question: string; budget: RequestBudget } {
  const identity = resolveSessionIdentity(store, input.session_id);
  requireSessionCapability(store, identity, "requests.cancel");
  const expiring = getRequestRow(store, input.request_id);
  if (expiring?.initiating_session_id === identity.sessionId) expireIfOverdue(store, expiring);
  return store.tx(() => {
    const row = getRequestRow(store, input.request_id);
    if (row === undefined) {
      throw new RoleDockError("NOT_FOUND", `Request "${input.request_id}" does not exist.`);
    }
    if (identity.sessionId !== row.initiating_session_id) {
      throw new RoleDockError(
        "PERMISSION_DENIED",
        "Only the initiating session can cancel a request.",
        { details: { request_id: row.request_id } },
      );
    }
    const current = expireIfOverdue(store, row);
    if (current.state === "running") {
      if (!adapterCancelDeclared) {
        throw new RoleDockError(
          "REQUEST_NOT_TERMINABLE",
          "Request is running and the adapter did not declare the cancel capability.",
          { details: { request_id: row.request_id, state: current.state } },
        );
      }
      // Negotiated cancellation: the caller coordinates with the adapter; the
      // core records the terminal transition when the cancel is accepted.
    } else if (!CANCELLABLE_STATES.has(current.state)) {
      throw new RoleDockError(
        "REQUEST_NOT_TERMINABLE",
        `Request is ${current.state}; it can no longer be cancelled.`,
        { details: { request_id: row.request_id, state: current.state } },
      );
    }
    const now = new Date().toISOString();
    store
      .prepare("UPDATE requests SET state = 'cancelled', terminal_at = ?, updated_at = ?, cleanup_pending = 1 WHERE request_id = ?")
      .run(now, now, row.request_id);
    const updated = getRequestRow(store, row.request_id) ?? current;
    return toPublicRequest(updated);
  });
}

// -- inbox.list (G6, session face) ---------------------------------------------

export interface SessionInboxEntry {
  entry_id: string;
  owner_role_id: string;
  request_id: string;
  artifact_id: string;
  content_hash: string;
  summary: string | null;
  state: "unread" | "read";
  delivered_at: string;
  read_at: string | null;
  request_state: CollaborationRequest["state"] | null;
}

/**
 * The calling session's OWN inbox (fixed to its binding role) — the merge
 * point for delegated results. Read-only; entries never inject into any
 * user-facing main conversation, and other roles' inboxes are invisible.
 */
export function listSessionInbox(
  store: WorkspaceStore,
  input: { session_id: string; unread_only?: boolean },
): { entries: SessionInboxEntry[] } {
  const identity = resolveSessionIdentity(store, input.session_id);
  requireSessionCapability(store, identity, "requests.read");
  const ownerRoleId = requireRoleIdentity(identity).roleId;
  const rows = store.prepare("SELECT * FROM request_inbox WHERE owner_role_id = ? ORDER BY delivered_at, entry_id")
    .all(ownerRoleId) as unknown as Array<{
    entry_id: string; owner_role_id: string; request_id: string; artifact_id: string;
    content_hash: string; summary: string | null; state: string; delivered_at: string; read_at: string | null;
  }>;
  const entries = rows
    .filter(row => !input.unread_only || row.state === "unread")
    .map(row => {
      let requestState: CollaborationRequest["state"] | null = null;
      const request = getRequestRow(store, row.request_id);
      if (request) requestState = expireIfOverdue(store, request).state;
      return { ...row, state: row.state as SessionInboxEntry["state"], request_state: requestState };
    });
  return { entries };
}

// -- requests.cancelByOwner (G6, desktop-gui-contract §6) ----------------------

export interface OwnerCancelOutcome {
  request_id: string;
  state: CollaborationRequest["state"];
  idempotent_replay: boolean;
}

/**
 * Owner management cancellation: the §6 state matrix with an INDEPENDENT
 * owner principal (never the initiating session identity) and an independent
 * audit event. Idempotency per §5: a same-key replay returns the FIRST
 * result (idempotent_replay) without a second state change; a same key with
 * different input is IDEMPOTENCY_CONFLICT; a different key against a
 * terminal request is refused — terminal states are never re-cancelled.
 */
export function cancelByOwner(
  store: WorkspaceStore,
  adapterCancelDeclared: boolean,
  input: { request_id: string; reason: string; idempotency_key?: string },
): OwnerCancelOutcome {
  const inputHash = bodyHash(JSON.stringify({ request_id: input.request_id, reason: input.reason }));
  const idemKey = input.idempotency_key;
  return store.tx(() => {
    if (idemKey !== undefined) {
      const prior = store.prepare("SELECT content_hash, target_id FROM idempotency_keys WHERE workspace_id = ? AND idem_key = ?")
        .get(store.workspaceId, idemKey) as { content_hash: string; target_id: string } | undefined;
      if (prior) {
        if (prior.content_hash !== inputHash || prior.target_id !== input.request_id) {
          throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Owner cancel key has different input.", { details: { idempotency_key: idemKey } });
        }
        const replayed = getRequestRow(store, prior.target_id);
        if (replayed === undefined) throw new RoleDockError("INTERNAL", "Idempotent cancel key references a missing request.");
        return { request_id: prior.target_id, state: expireIfOverdue(store, replayed).state, idempotent_replay: true };
      }
    }
    const row = getRequestRow(store, input.request_id);
    if (row === undefined) {
      throw new RoleDockError("NOT_FOUND", `Request "${input.request_id}" does not exist.`, { details: { request_id: input.request_id } });
    }
    const current = expireIfOverdue(store, row);
    if (current.state === "running") {
      if (!adapterCancelDeclared) {
        throw new RoleDockError(
          "REQUEST_NOT_TERMINABLE",
          "Request is running and the adapter did not declare the cancel capability; it keeps running.",
          { details: { request_id: current.request_id, state: current.state } },
        );
      }
    } else if (!CANCELLABLE_STATES.has(current.state)) {
      throw new RoleDockError(
        "REQUEST_NOT_TERMINABLE",
        `Request is ${current.state}; a terminal request cannot be cancelled again (a new intent needs a new request).`,
        { details: { request_id: current.request_id, state: current.state } },
      );
    }
    const now = new Date().toISOString();
    store
      .prepare("UPDATE requests SET state = 'cancelled', terminal_at = ?, updated_at = ?, cleanup_pending = 1 WHERE request_id = ?")
      .run(now, now, current.request_id);
    if (idemKey !== undefined) {
      store.prepare("INSERT INTO idempotency_keys (workspace_id, idem_key, content_hash, target_kind, target_id, created_at) VALUES (?, ?, ?, 'request.cancel', ?, ?)")
        .run(store.workspaceId, idemKey, inputHash, current.request_id, now);
    }
    // Independent owner audit trail (visible via admin.events metadata view).
    store.prepare("INSERT INTO outbox_events (id, workspace_id, kind, payload_json, state, created_at) VALUES (?, ?, 'owner.request.cancel', ?, 'done', ?)")
      .run(`evt-owner-cancel-${randomBytes(4).toString("hex")}`, store.workspaceId, JSON.stringify({ request_id: current.request_id, reason: input.reason, actor: "owner" }), now);
    return { request_id: current.request_id, state: "cancelled" as const, idempotent_replay: false };
  });
}

// -- artifacts.read ---------------------------------------------------------------

export interface ArtifactReadResult {
  artifact_id: string;
  request_id: string;
  producing_role_id: string;
  content_hash: string;
  body: string;
  created_at: string;
}

export function readArtifact(
  store: WorkspaceStore,
  input: { session_id: string; artifact_id: string },
): ArtifactReadResult {
  const identity = resolveSessionIdentity(store, input.session_id);
  requireSessionCapability(store, identity, "artifacts.read");
  const artifact = store
    .prepare("SELECT * FROM request_artifacts WHERE artifact_id = ?")
    .get(input.artifact_id) as
    | { artifact_id: string; request_id: string; producing_role_id: string; content_hash: string; created_at: string }
    | undefined;
  if (artifact === undefined) {
    throw new RoleDockError("NOT_FOUND", `Artifact "${input.artifact_id}" does not exist.`, {
      details: { artifact_id: input.artifact_id },
    });
  }
  const row = getRequestRow(store, artifact.request_id);
  if (row === undefined) {
    throw new RoleDockError("INTERNAL", "Artifact references a missing request.");
  }
  requireParticipant(identity, row);
  const body = readObject(store, artifact.content_hash);
  if (bodyHash(body) !== artifact.content_hash) {
    throw new RoleDockError("INTERNAL", "Artifact body does not match its content hash.");
  }
  return {
    artifact_id: artifact.artifact_id,
    request_id: artifact.request_id,
    producing_role_id: artifact.producing_role_id,
    content_hash: artifact.content_hash,
    body,
    created_at: artifact.created_at,
  };
}

export function listInboxEntries(
  store: WorkspaceStore,
  filter: { owner_role_id?: string } = {},
): Array<{
  entry_id: string;
  owner_role_id: string;
  request_id: string;
  artifact_id: string;
  state: string;
  delivered_at: string;
}> {
  const rows = store
    .prepare("SELECT * FROM request_inbox ORDER BY delivered_at")
    .all() as unknown as Array<{
    entry_id: string;
    owner_role_id: string;
    request_id: string;
    artifact_id: string;
    state: string;
    delivered_at: string;
  }>;
  return rows.filter((row) => filter.owner_role_id === undefined || row.owner_role_id === filter.owner_role_id);
}

export function listRequests(
  store: WorkspaceStore,
  filter: { initiating_session_id?: string; target_role_id?: string; state?: string } = {},
): Array<ReturnType<typeof toPublicRequest>> {
  const rows = store.prepare("SELECT * FROM requests ORDER BY created_at").all() as unknown as RequestRow[];
  return rows
    .filter(
      (row) =>
        (filter.initiating_session_id === undefined || row.initiating_session_id === filter.initiating_session_id) &&
        (filter.target_role_id === undefined || row.target_role_id === filter.target_role_id) &&
        (filter.state === undefined || row.state === filter.state),
    )
    .map((row) => expireIfOverdue(store, row))
    .map((row) => toPublicRequest(row));
}
