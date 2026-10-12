import { randomBytes } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";
import { getHead, getRoleRow } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";
import type { TrustedIdentity } from "../identity.js";

export interface SessionRow {
  id: string;
  kind: "primary" | "request";
  adapter: string;
  state: string;
  role_id: string | null;
  instance_id: string | null;
  creation_key: string | null;
}

/**
 * Resolve the trusted identity of a calling session from the sessions table.
 * The session id is the only client-supplied part; role and instance come
 * from the stored binding, never from operation input.
 */
export function resolveSessionIdentity(store: WorkspaceStore, sessionId: string): TrustedIdentity & {
  kind: "primary" | "request";
} {
  const row = store.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | (SessionRow & { created_at: string })
    | undefined;
  if (row === undefined) {
    throw new RoleDockError("NOT_FOUND", `Session "${sessionId}" does not exist in this workspace.`, {
      details: { session_id: sessionId },
    });
  }
  if (row.state !== "active") {
    throw new RoleDockError(
      "INVALID_STATE_TRANSITION",
      `Session "${sessionId}" is ${row.state}; only active sessions can act.`,
      { details: { session_id: sessionId, state: row.state } },
    );
  }
  return {
    workspaceId: store.workspaceId,
    sessionId: row.id,
    instanceId: row.instance_id ?? undefined,
    roleId: row.role_id ?? undefined,
    kind: row.kind,
  };
}

export function requireRoleIdentity(
  identity: TrustedIdentity & { kind: "primary" | "request" },
): TrustedIdentity & { kind: "primary" | "request"; instanceId: string; roleId: string } {
  if (identity.roleId === undefined || identity.instanceId === undefined) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      "This operation requires a role-bound session; the calling session has no role binding.",
      { details: { session_id: identity.sessionId } },
    );
  }
  return identity as TrustedIdentity & { kind: "primary" | "request"; instanceId: string; roleId: string };
}

/**
 * Open a primary session for a role, initializing the first primary instance
 * when the role has none.
 *
 * Fixture-only shortcut (P2): on an already-initialized role this retires the
 * current instance and creates the next generation directly, without handoff
 * validation — that shortcut lets P2 tests build stale-generation scenarios.
 * The production path (P3, sessions.open) replaces it with the real
 * prepare/activate flow and is the only publicly reachable route.
 */
export function openPrimarySession(
  store: WorkspaceStore,
  input: { role_id: string; workspace_id?: string },
): { session_id: string; instance_id: string; role_id: string; generation: number } {
  if (input.workspace_id !== undefined && input.workspace_id !== store.workspaceId) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Workspace id mismatch: this handle operates on ${store.workspaceId}, not ${input.workspace_id}.`,
      { details: { expected: store.workspaceId, provided: input.workspace_id } },
    );
  }
  const roleId = input.role_id;
  const now = new Date().toISOString();
  return store.tx(() => {
    if (getRoleRow(store, roleId) === undefined) {
      throw new RoleDockError("NOT_FOUND", `Role "${roleId}" is not installed in this workspace.`, {
        details: { role_id: roleId },
      });
    }
    const head = getHead(store, roleId);
    if (head === undefined) {
      throw new RoleDockError("INTERNAL", `Role ${roleId} has no head row; installation is inconsistent.`);
    }

    let generation: number;
    let instanceId: string;
    if (head.generation === 0) {
      // First open auto-initializes the primary instance (spec §2).
      generation = 1;
      instanceId = `inst-${randomBytes(4).toString("hex")}`;
      store
        .prepare(
          "INSERT INTO agent_instances (id, role_id, generation, predecessor_instance_id, state, created_at) VALUES (?, ?, ?, NULL, 'active', ?)",
        )
        .run(instanceId, roleId, generation, now);
    } else {
      // Fixture-only generation bump: retire the current primary and start
      // the next generation. Not reachable from any public surface.
      generation = head.generation + 1;
      instanceId = `inst-${randomBytes(4).toString("hex")}`;
      if (head.current_instance_id !== null) {
        store
          .prepare("UPDATE agent_instances SET state = 'retired' WHERE id = ?")
          .run(head.current_instance_id);
      }
      store
        .prepare(
          "INSERT INTO agent_instances (id, role_id, generation, predecessor_instance_id, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        )
        .run(instanceId, roleId, generation, head.current_instance_id, now);
    }

    store
      .prepare(
        "UPDATE role_heads SET generation = ?, current_instance_id = ?, updated_at = ? WHERE role_id = ?",
      )
      .run(generation, instanceId, now, roleId);

    const sessionId = `sess-${randomBytes(4).toString("hex")}`;
    store
      .prepare(
        "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, creation_key, created_at) VALUES (?, 'primary', 'internal-fixture', 'active', ?, ?, NULL, ?)",
      )
      .run(sessionId, roleId, instanceId, now);

    return { session_id: sessionId, instance_id: instanceId, role_id: roleId, generation };
  });
}

export interface NewReadReceipt {
  receipt_id: string;
  session_id: string;
  instance_id: string | null;
  reader_role_id: string;
  owner_role_id: string;
  document_key: string;
  revision: number;
  content_hash: string;
  read_at: string;
}

/**
 * Persist a read receipt under the calling session's true binding. Called
 * only from documents.read; the session row is re-read so a caller cannot
 * attribute a receipt to another session's identity.
 */
export function recordReadReceipt(
  store: WorkspaceStore,
  input: {
    session_id: string;
    owner_role_id: string;
    document_key: string;
    revision: number;
    content_hash: string;
  },
): NewReadReceipt {
  const now = new Date().toISOString();
  return store.tx(() => {
    const session = store.prepare("SELECT * FROM sessions WHERE id = ?").get(input.session_id) as
      | (SessionRow & { created_at: string })
      | undefined;
    if (session === undefined || session.state !== "active") {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Cannot record a read receipt: session "${input.session_id}" is missing or not active.`,
        { details: { session_id: input.session_id } },
      );
    }
    if (session.role_id === null) {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        "Cannot record a read receipt for a session without a role binding.",
        { details: { session_id: input.session_id } },
      );
    }
    const receipt: NewReadReceipt = {
      receipt_id: `rcpt-${randomBytes(5).toString("hex")}`,
      session_id: session.id,
      instance_id: session.instance_id,
      reader_role_id: session.role_id,
      owner_role_id: input.owner_role_id,
      document_key: input.document_key,
      revision: input.revision,
      content_hash: input.content_hash,
      read_at: now,
    };
    store
      .prepare(
        `INSERT INTO read_receipts (receipt_id, workspace_id, session_id, instance_id, reader_role_id, owner_role_id, document_key, revision, content_hash, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        store.workspaceId,
        receipt.session_id,
        receipt.instance_id,
        receipt.reader_role_id,
        receipt.owner_role_id,
        receipt.document_key,
        receipt.revision,
        receipt.content_hash,
        receipt.read_at,
      );
    return receipt;
  });
}

export function listReceiptsForSession(store: WorkspaceStore, sessionId: string): NewReadReceipt[] {
  return store
    .prepare("SELECT * FROM read_receipts WHERE session_id = ? ORDER BY read_at")
    .all(sessionId) as unknown as NewReadReceipt[];
}
