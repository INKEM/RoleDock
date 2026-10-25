import { createHash, randomBytes } from "node:crypto";
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
import { roleMaterial } from "./material.js";
import { bodyHash } from "../store/objects.js";
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
  session_state?: string;
  instance_state?: string;
  handoff: {
    performed: boolean;
    bundle_id?: string;
    checkpoint_id?: string;
    reprepared?: boolean;
  };
}

/**
 * sessions.open: the first primary session of a role initializes generation
 * 1; on an initialized role, inherit="latest" runs the full
 * prepare→provision→activate handoff and makes the new session the unique
 * successor. Knowledge drift during preparation re-prepares automatically;
 * a moved primary pointer (a concurrent successor won) fails with
 * GENERATION_CONFLICT and never re-prepares over it.
 */
async function openSessionImpl(
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

  const inputHash = bodyHash(JSON.stringify({ role_id: roleId, inherit: input.inherit ?? null }));
  const existing = store.prepare("SELECT * FROM sessions WHERE open_key = ? OR (creation_key = ? AND kind = 'primary' AND open_key IS NULL)").get(input.creation_key!, input.creation_key!) as {
    id: string; role_id: string | null; instance_id: string | null; state: string; creation_key: string;
    open_input_hash: string | null; bootstrap_payload: string | null; host_session_ref: string | null;
  } | undefined;
  if (existing?.open_input_hash && existing.open_input_hash !== inputHash) {
    throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Creation key was used with different session input.");
  }
  if (existing && existing.state === "active" && existing.instance_id) {
    if (existing.role_id !== roleId) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Creation key belongs to a different role.");
    const instance = store.prepare("SELECT generation, state, predecessor_instance_id FROM agent_instances WHERE id = ?").get(existing.instance_id) as { generation: number; state: string; predecessor_instance_id: string | null };
    return { session_id: existing.id, instance_id: existing.instance_id, role_id: roleId,
      generation: instance.generation, session_state: existing.state, instance_state: instance.state,
      ...(instance.predecessor_instance_id ? { predecessor_instance_id: instance.predecessor_instance_id } : {}), handoff: { performed: false } };
  }

  const head = getHead(store, roleId);
  if (head === undefined || head.generation === 0) {
    const sessionId = existing?.id ?? `sess-${randomBytes(4).toString("hex")}`;
    const hostKey = existing?.creation_key ?? `initial-${sessionId}`;
    const payload = existing?.bootstrap_payload ?? JSON.stringify({ protocol_version: "0.1", role_id: roleId, materials: { role: roleMaterial(store, roleId), documents: [] } });
    if (!existing) store.prepare("INSERT INTO sessions (id, kind, adapter, state, role_id, creation_key, created_at, bootstrap_payload, open_input_hash, open_key) VALUES (?, 'primary', ?, 'provisioning', ?, ?, ?, ?, ?, ?)")
      .run(sessionId, adapter.getCapabilities().adapter, roleId, hostKey, new Date().toISOString(), payload, inputHash, input.creation_key!);
    let handle;
    try {
      if (existing) {
        if (!adapter.getCapabilities().optional.lookup_session_by_creation_key || !adapter.lookupSessionByCreationKey) {
          throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Initial creation is pending reconciliation.", { details: { execution_uncertain: true } });
        }
        handle = await adapter.lookupSessionByCreationKey(hostKey);
      }
      if (!handle) handle = await adapter.createSession({ creation_key: hostKey, bootstrap: { bundle_id: `initial-${sessionId}`, role_id: roleId, payload, content_hash: bodyHash(payload) } });
    } catch (error) {
      store.prepare("UPDATE sessions SET state = 'uncertain' WHERE id = ?").run(sessionId);
      if (adapter.getCapabilities().optional.lookup_session_by_creation_key && adapter.lookupSessionByCreationKey) {
        handle = await adapter.lookupSessionByCreationKey(hostKey);
      }
      if (!handle) throw error;
    }
    const instanceId = `inst-${randomBytes(4).toString("hex")}`;
    try {
      return store.tx(() => {
        const current = getHead(store, roleId)!;
        if (current.generation !== 0) throw new RoleDockError("GENERATION_CONFLICT", "Another first session activated.");
        const now = new Date().toISOString();
        store.prepare("INSERT INTO agent_instances (id, role_id, generation, state, created_at) VALUES (?, ?, 1, 'active', ?)").run(instanceId, roleId, now);
        store.prepare("UPDATE role_heads SET generation = 1, current_instance_id = ?, updated_at = ? WHERE role_id = ?").run(instanceId, now, roleId);
        store.prepare("UPDATE sessions SET state = 'active', instance_id = ?, host_session_ref = ? WHERE id = ?").run(instanceId, handle.host_session_id, sessionId);
        return { session_id: sessionId, instance_id: instanceId, role_id: roleId, generation: 1, handoff: { performed: false } };
      });
    } catch (error) {
      await adapter.closeSession(handle);
      store.prepare("UPDATE sessions SET state = 'abandoned' WHERE id = ?").run(sessionId);
      throw error;
    }
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
        "SELECT bundle_id, role_id, open_input_hash FROM bootstrap_bundles WHERE (open_key = ? OR creation_key = ?) AND state IN ('prepared', 'provisioned')",
      )
      .get(input.creation_key, input.creation_key) as { bundle_id: string; role_id: string; open_input_hash: string | null } | undefined;
    if (interrupted !== undefined) {
      if (interrupted.role_id !== roleId || (interrupted.open_input_hash && interrupted.open_input_hash !== inputHash)) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Pending creation key has different input.");
      const prep = rehydratePreparation(store, interrupted.bundle_id);
      const provisioned = await provisionHandoff(store, adapter, prep);
      store.prepare("UPDATE sessions SET open_input_hash = ? WHERE id = ?").run(inputHash, provisioned.session_id);
      try {
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
      } catch (error) {
        await abandonProvisioned(store, adapter, prep.bundle_id);
        store.tx(() => {
          store.prepare("UPDATE bootstrap_bundles SET open_key = NULL WHERE bundle_id = ?").run(prep.bundle_id);
          store.prepare("UPDATE sessions SET open_key = NULL WHERE id = ?").run(provisioned.session_id);
        });
        if (!(error instanceof RoleDockError) || error.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  let reprepared = false;
  let lastPrep = prepareHandoff(store, { role_id: roleId });
  // Logical open keys remain stable; each host attempt has its own creation key.
  store.prepare("UPDATE bootstrap_bundles SET open_key = ?, open_input_hash = ? WHERE bundle_id = ?").run(input.creation_key!, inputHash, lastPrep.bundle_id);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const provisioned = await provisionHandoff(store, adapter, lastPrep);
    try {
      store.prepare("UPDATE sessions SET open_input_hash = ? WHERE id = ?").run(inputHash, provisioned.session_id);
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
      store.tx(() => {
        store.prepare("UPDATE bootstrap_bundles SET open_key = NULL WHERE bundle_id = ?").run(lastPrep.bundle_id);
        store.prepare("UPDATE sessions SET open_key = NULL WHERE id = ?").run(provisioned.session_id);
      });
      lastPrep = prepareHandoff(store, { role_id: roleId });
      store.prepare("UPDATE bootstrap_bundles SET open_key = ?, open_input_hash = ? WHERE bundle_id = ?").run(input.creation_key!, inputHash, lastPrep.bundle_id);
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
  const instance = store.prepare("SELECT generation FROM agent_instances WHERE id = ?").get(identity.instanceId ?? "") as { generation: number } | undefined;
  const capabilities = adapter.getCapabilities();
  if (capabilities.optional.native_resume === true && adapter.nativeResume !== undefined) {
    const hostRef = store
      .prepare("SELECT host_session_ref, creation_key FROM sessions WHERE id = ?")
      .get(input.session_id) as { host_session_ref: string | null; creation_key: string } | undefined;
    if (hostRef?.host_session_ref !== null && hostRef?.host_session_ref !== undefined) {
      try {
        await adapter.nativeResume({
          adapter: capabilities.adapter,
          host_session_id: hostRef.host_session_ref,
          creation_key: hostRef.creation_key,
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
          generation: instance?.generation ?? 0,
          resumed: false,
          method: null,
          alternative:
            "open a new primary session with inherit=latest for semantic inheritance",
        };
      }
    }
    if (hostRef?.host_session_ref) return {
      session_id: identity.sessionId,
      role_id: identity.roleId ?? null,
      instance_id: identity.instanceId ?? null,
      generation: instance?.generation ?? 0,
      resumed: true,
      method: "native",
    };
  }
  return {
    session_id: identity.sessionId,
    role_id: identity.roleId ?? null,
    instance_id: identity.instanceId ?? null,
    generation: instance?.generation ?? 0,
    resumed: false,
    method: null,
    alternative:
      "open a new primary session with inherit=latest for semantic inheritance",
  };
}

const opens = new WeakMap<WorkspaceStore, Map<string, { hash: string; promise: Promise<OpenSessionResult> }>>();
export async function openSession(store: WorkspaceStore, adapter: HarnessAdapter, input: OpenSessionInput): Promise<OpenSessionResult> {
  const key = input.creation_key ?? `open-${randomBytes(8).toString("hex")}`;
  const hash = bodyHash(JSON.stringify(input));
  const active = opens.get(store) ?? new Map();
  opens.set(store, active);
  const existing = active.get(key);
  if (existing) {
    if (existing.hash !== hash) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Concurrent open input differs.");
    return existing.promise;
  }
  const promise = openSessionImpl(store, adapter, { ...input, creation_key: key });
  active.set(key, { hash, promise });
  try { return await promise; } finally { active.delete(key); }
}
