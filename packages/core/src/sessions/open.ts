import { randomBytes } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";
import type { HarnessAdapter } from "../ports/adapter.js";
import { getHead, getRoleRow } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";
import {
  abandonProvisioned,
  activateHandoff,
  prepareHandoff,
  provisionHandoff,
  rehydratePreparation,
} from "./handoff.js";
import { resolveSessionIdentity } from "./internal.js";

export interface OpenSessionInput {
  role_id: string;
  /** Required for an initialized role: the only way to become the successor. */
  inherit?: "latest";
  creation_key?: string;
  workspace_id?: string;
}

export interface OpenSessionResult {
  session_id: string;
  instance_id: string;
  role_id: string;
  generation: number;
  predecessor_instance_id?: string;
  handoff: {
    performed: boolean;
    bundle_id?: string;
    checkpoint_id?: string;
    reprepared?: boolean;
  };
}

function createPrimarySessionRow(
  store: WorkspaceStore,
  roleId: string,
  instanceId: string,
  creationKey: string | null,
): string {
  const sessionId = `sess-${randomBytes(4).toString("hex")}`;
  store
    .prepare(
      "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, host_session_ref, creation_key, created_at) VALUES (?, 'primary', ?, 'active', ?, ?, NULL, ?, ?)",
    )
    .run(sessionId, "core", roleId, instanceId, creationKey, new Date().toISOString());
  return sessionId;
}

/**
 * sessions.open: the first primary session of a role initializes generation
 * 1; on an initialized role, inherit="latest" runs the full
 * prepare→provision→activate handoff and makes the new session the unique
 * successor. Knowledge drift during preparation re-prepares automatically;
 * a moved primary pointer (a concurrent successor won) fails with
 * GENERATION_CONFLICT and never re-prepares over it.
 */
export async function openSession(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  if (input.workspace_id !== undefined && input.workspace_id !== store.workspaceId) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Workspace id mismatch: this coordinator operates on ${store.workspaceId}, not ${input.workspace_id}.`,
      { details: { expected: store.workspaceId, provided: input.workspace_id } },
    );
  }
  const roleId = input.role_id;
  if (getRoleRow(store, roleId) === undefined) {
    throw new RoleDockError("NOT_FOUND", `Role "${roleId}" is not installed in this workspace.`, {
      details: { role_id: roleId },
    });
  }

  // Idempotent creation: same key returns the original session.
  if (input.creation_key !== undefined) {
    const existing = store
      .prepare("SELECT id, state, role_id, instance_id FROM sessions WHERE creation_key = ?")
      .get(input.creation_key) as
      | { id: string; state: string; role_id: string | null; instance_id: string | null }
      | undefined;
    if (existing !== undefined && existing.state === "active") {
      if (existing.role_id !== roleId) {
        throw new RoleDockError(
          "IDEMPOTENCY_CONFLICT",
          `Creation key "${input.creation_key}" was already used for role "${existing.role_id}" with different content.`,
          { details: { creation_key: input.creation_key, existing_role_id: existing.role_id } },
        );
      }
      const head = getHead(store, roleId);
      return {
        session_id: existing.id,
        instance_id: existing.instance_id ?? "",
        role_id: roleId,
        generation: head?.generation ?? 0,
        handoff: { performed: false, reprepared: undefined },
      };
    }
  }

  const head = getHead(store, roleId);
  if (head === undefined || head.generation === 0) {
    // First open auto-initializes the primary instance (spec §2).
    const now = new Date().toISOString();
    const instanceId = `inst-${randomBytes(4).toString("hex")}`;
    const sessionId = `sess-${randomBytes(4).toString("hex")}`;
    store.tx(() => {
      store
        .prepare(
          "INSERT INTO agent_instances (id, role_id, generation, predecessor_instance_id, state, created_at) VALUES (?, ?, 1, NULL, 'active', ?)",
        )
        .run(instanceId, roleId, now);
      store
        .prepare("UPDATE role_heads SET generation = 1, current_instance_id = ?, updated_at = ? WHERE role_id = ?")
        .run(instanceId, now, roleId);
      store
        .prepare(
          "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, host_session_ref, creation_key, created_at) VALUES (?, 'primary', 'core', 'active', ?, ?, NULL, ?, ?)",
        )
        .run(sessionId, roleId, instanceId, input.creation_key ?? null, now);
    });
    return {
      session_id: sessionId,
      instance_id: instanceId,
      role_id: roleId,
      generation: 1,
      handoff: { performed: false },
    };
  }

  if (input.inherit !== "latest") {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Role "${roleId}" already has a primary instance (generation ${head.generation}). Pass inherit="latest" to run the handoff and become the successor.`,
      { details: { role_id: roleId, current_generation: head.generation, inherit: input.inherit ?? null } },
    );
  }

  // Recovery first: an earlier attempt under the same creation key may have
  // left an uncertain/provisioning session. Finish THAT handoff instead of
  // preparing a duplicate bundle.
  if (input.creation_key !== undefined) {
    const interrupted = store
      .prepare(
        "SELECT bundle_id FROM bootstrap_bundles WHERE creation_key = ? AND state IN ('prepared', 'provisioned')",
      )
      .get(input.creation_key) as { bundle_id: string } | undefined;
    if (interrupted !== undefined) {
      const prep = rehydratePreparation(store, interrupted.bundle_id, input.creation_key);
      const provisioned = await provisionHandoff(store, adapter, prep);
      const activation = activateHandoff(store, { bundle_id: prep.bundle_id });
      return {
        session_id: provisioned.session_id,
        instance_id: activation.instance_id,
        role_id: activation.role_id,
        generation: activation.generation,
        predecessor_instance_id: activation.predecessor_instance_id,
        handoff: {
          performed: true,
          bundle_id: prep.bundle_id,
          checkpoint_id: prep.checkpoint_id,
          reprepared: true,
        },
      };
    }
  }

  let reprepared = false;
  let lastPrep = prepareHandoff(store, { role_id: roleId });
  if (input.creation_key !== undefined) {
    // Stable provision key: retries of the same open reconcile by it.
    lastPrep = { ...lastPrep, creation_key: input.creation_key };
    store.prepare("UPDATE bootstrap_bundles SET creation_key = ? WHERE bundle_id = ?").run(
      input.creation_key,
      lastPrep.bundle_id,
    );
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const provisioned = await provisionHandoff(store, adapter, lastPrep);
    try {
      const activation = activateHandoff(store, { bundle_id: lastPrep.bundle_id });
      return {
        session_id: provisioned.session_id,
        instance_id: activation.instance_id,
        role_id: activation.role_id,
        generation: activation.generation,
        predecessor_instance_id: activation.predecessor_instance_id,
        handoff: {
          performed: true,
          bundle_id: lastPrep.bundle_id,
          checkpoint_id: lastPrep.checkpoint_id,
          ...(reprepared ? { reprepared: true } : {}),
        },
      };
    } catch (error) {
      const isKnowledgeDrift = error instanceof RoleDockError && error.code === "REVISION_CONFLICT";
      if (!isKnowledgeDrift || attempt === MAX_ATTEMPTS) {
        // GENERATION_CONFLICT (a concurrent successor won), validation and
        // internal errors all propagate; no re-prepare over a moved pointer.
        await abandonProvisioned(store, adapter, lastPrep.bundle_id);
        throw error;
      }
      // Knowledge changed during preparation: start over from the current
      // knowledge state; the stale provisioned host session is abandoned.
      reprepared = true;
      await abandonProvisioned(store, adapter, lastPrep.bundle_id);
      lastPrep = prepareHandoff(store, { role_id: roleId });
    }
  }
  throw new RoleDockError("INTERNAL", "Handoff orchestration exited its retry loop.");
}

const MAX_ATTEMPTS = 3;

export interface ResumeSessionResult {
  session_id: string;
  role_id: string | null;
  instance_id: string | null;
  generation: number;
  resumed: boolean;
  method: "native" | null;
  alternative?: "open a new primary session with inherit=latest for semantic inheritance";
}

/**
 * sessions.resume: continuing an existing session. It only performs a native
 * host resume when the adapter declares that capability, and it NEVER
 * advances the generation or touches the primary pointer. Without native
 * resume the caller is pointed at semantic inheritance (sessions.open with
 * inherit=latest).
 */
export async function resumeSession(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  input: { session_id: string; workspace_id?: string },
): Promise<ResumeSessionResult> {
  if (input.workspace_id !== undefined && input.workspace_id !== store.workspaceId) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Workspace id mismatch: this coordinator operates on ${store.workspaceId}, not ${input.workspace_id}.`,
      { details: { expected: store.workspaceId, provided: input.workspace_id } },
    );
  }
  const identity = resolveSessionIdentity(store, input.session_id);
  const head = identity.roleId !== undefined ? getHead(store, identity.roleId) : undefined;
  const capabilities = adapter.getCapabilities();
  if (capabilities.optional.native_resume === true && adapter.nativeResume !== undefined) {
    const hostRef = store
      .prepare("SELECT host_session_ref FROM sessions WHERE id = ?")
      .get(input.session_id) as { host_session_ref: string | null } | undefined;
    if (hostRef?.host_session_ref !== null && hostRef?.host_session_ref !== undefined) {
      try {
        await adapter.nativeResume({
          adapter: capabilities.adapter,
          host_session_id: hostRef.host_session_ref,
          creation_key: input.session_id,
        });
      } catch (error) {
        if (!(error instanceof RoleDockError) || error.code !== "NOT_FOUND") throw error;
        // This adapter instance does not hold the host session (e.g. an
        // in-memory mock across process boundaries): native resume did not
        // happen, so report it honestly instead of claiming success.
        return {
          session_id: identity.sessionId,
          role_id: identity.roleId ?? null,
          instance_id: identity.instanceId ?? null,
          generation: head?.generation ?? 0,
          resumed: false,
          method: null,
          alternative:
            "open a new primary session with inherit=latest for semantic inheritance",
        };
      }
    }
    return {
      session_id: identity.sessionId,
      role_id: identity.roleId ?? null,
      instance_id: identity.instanceId ?? null,
      generation: head?.generation ?? 0,
      resumed: true,
      method: "native",
    };
  }
  return {
    session_id: identity.sessionId,
    role_id: identity.roleId ?? null,
    instance_id: identity.instanceId ?? null,
    generation: head?.generation ?? 0,
    resumed: false,
    method: null,
    alternative:
      "open a new primary session with inherit=latest for semantic inheritance",
  };
}
