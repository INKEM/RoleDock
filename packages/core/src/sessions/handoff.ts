import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { RoleDockError, validate } from "@roledock/protocol";
import type { BootstrapBundle } from "@roledock/protocol";
import { getHead, getPack, getRoleRow } from "../store/queries.js";
import { putObject, readObject, bodyHash } from "../store/objects.js";
import { roleMaterial, documentMaterial } from "./material.js";
import { requireCapability } from "../policy.js";
import { buildCheckpoint } from "../documents/checkpoint.js";
import type { WorkspaceStore } from "../store/workspace.js";
import type { AdapterSessionHandle, HarnessAdapter } from "../ports/adapter.js";
import { resolveSessionIdentity, requireRoleIdentity } from "./internal.js";

const MAX_REPREPARE_ATTEMPTS = 3;

export interface HandoffPreparation {
  bundle_id: string;
  role_id: string;
  source_generation: number;
  source_knowledge_revision: number;
  checkpoint_id: string;
  payload: string;
  payload_hash: string;
  creation_key: string;
}

export interface BundleRow {
  bundle_id: string;
  workspace_id: string;
  role_id: string;
  source_generation: number;
  source_knowledge_revision: number;
  checkpoint_id: string;
  checkpoint_hash: string;
  contract_package_name: string;
  contract_package_version: string;
  contract_content_hash: string;
  payload_hash: string;
  state: "prepared" | "provisioned" | "activated" | "abandoned";
  provisioned_host_session: string | null;
  creation_key: string | null;
}

function getBundleRow(store: WorkspaceStore, bundleId: string): BundleRow | undefined {
  return store.prepare("SELECT * FROM bootstrap_bundles WHERE bundle_id = ?").get(bundleId) as
    | BundleRow
    | undefined;
}

function getBundleByCreationKey(store: WorkspaceStore, creationKey: string): BundleRow | undefined {
  return store
    .prepare("SELECT * FROM bootstrap_bundles WHERE creation_key = ?")
    .get(creationKey) as BundleRow | undefined;
}

/** Rebuild a preparation handle from its persisted bundle row. */
export function rehydratePreparation(
  store: WorkspaceStore,
  bundleId: string,
  creationKey?: string,
): HandoffPreparation {
  const row = getBundleRow(store, bundleId);
  if (row === undefined) {
    throw new RoleDockError("NOT_FOUND", `Bundle "${bundleId}" does not exist.`, {
      details: { bundle_id: bundleId },
    });
  }
  let payload: string;
  try { payload = readObject(store, row.payload_hash); }
  catch { throw new RoleDockError("NOT_IMPLEMENTED", "Legacy bundle has no durable material payload; prepare again."); }
  if (bodyHash(payload) !== row.payload_hash) throw new RoleDockError("VALIDATION_FAILED", "Persisted bootstrap hash mismatch.");
  return {
    bundle_id: row.bundle_id,
    role_id: row.role_id,
    source_generation: row.source_generation,
    source_knowledge_revision: row.source_knowledge_revision,
    checkpoint_id: row.checkpoint_id,
    payload,
    payload_hash: row.payload_hash,
    creation_key: creationKey ?? row.creation_key ?? `provision-${row.bundle_id}`,
  };
}

export { getBundleByCreationKey };

function serialize(value: object): string {
  return JSON.stringify(value, null, 2);
}

/**
 * prepare: freeze the current generation and knowledge revision into an
 * immutable BootstrapBundle. The checkpoint captures exact document
 * revisions; the bundle freezes the role's registered pack contract, so a
 * successor session inherits the same responsibilities (no silent
 * re-contracting). Callable by the current primary instance's session.
 */
export function prepareHandoff(
  store: WorkspaceStore,
  input: { role_id?: string; session_id?: string },
): HandoffPreparation {
  const sessionIdentity = input.session_id !== undefined ? resolveSessionIdentity(store, input.session_id) : undefined;
  const roleId = input.role_id ?? sessionIdentity?.roleId;
  if (roleId === undefined) {
    throw new RoleDockError("VALIDATION_FAILED", "role_id is required when the session has no role binding.");
  }
  const head = getHead(store, roleId);
  if (head === undefined || head.generation === 0) {
    throw new RoleDockError(
      "ROLE_UNINITIALIZED",
      `Role "${roleId}" has no primary instance to hand off from.`,
      { details: { role_id: roleId } },
    );
  }
  if (sessionIdentity !== undefined) {
    // Public entry: the caller must be a primary session of the current
    // instance. Consultation-kind sessions never authorize a handoff.
    const identity = sessionIdentity;
    if (
      identity.kind !== "primary" ||
      identity.instanceId === undefined ||
      identity.roleId !== roleId ||
      head.current_instance_id !== identity.instanceId
    ) {
      throw new RoleDockError(
        "INVALID_STATE_TRANSITION",
        "Only a primary session of the current instance may prepare a handoff; consultation sessions never become primary.",
        {
          details: {
            current_instance_id: head.current_instance_id,
            session_instance_id: identity.instanceId ?? null,
            session_kind: identity.kind,
          },
        },
      );
    }
  }
  // Without a session id, authority is the coordinator itself (orchestration
  // path of sessions.open); activation still compare-and-swaps the pointer.

  // Freeze knowledge first (own transaction inside buildCheckpoint): the
  // checkpoint pins exact document revisions; activate later verifies the
  // pair (generation, knowledge_revision) is still current.
  requireCapability(store, roleId, "documents.read");
  const { summary_content_hash: _summaryHash, ...checkpoint } = buildCheckpoint(store, { role_id: roleId, shareable_only: true });
  const checkpointHash = createHash("sha256")
    .update(serialize(checkpoint), "utf8")
    .digest("hex");

  const role = getRoleRow(store, roleId);
  if (role === undefined) {
    throw new RoleDockError("INTERNAL", "Role row vanished during prepare.");
  }
  const pack = getPack(store, role.pack_name, role.pack_version);
  if (pack === undefined) {
    throw new RoleDockError("INTERNAL", `Role ${roleId} references a missing pack.`);
  }

  const bundleId = `bundle-${randomBytes(5).toString("hex")}`;
  const bundle: BootstrapBundle = {
    bundle_id: bundleId,
    protocol_version: "0.1",
    workspace_id: store.workspaceId,
    role_id: roleId,
    source_generation: checkpoint.generation,
    source_knowledge_revision: checkpoint.knowledge_revision,
    role_contract: {
      package_name: pack.name,
      package_version: pack.version,
      content_hash: pack.content_hash,
    },
    checkpoint: { checkpoint_id: checkpoint.checkpoint_id, content_hash: checkpointHash },
    created_by_instance_id: head.current_instance_id ?? "",
    created_at: new Date().toISOString(),
  };
  bundle.materials = { role: roleMaterial(store, roleId), checkpoint, documents: documentMaterial(store, roleId, checkpoint.document_snapshots, false) };
  const checked = validate<BootstrapBundle>("bootstrap-bundle", bundle);
  if (!checked.ok) throw new RoleDockError("VALIDATION_FAILED", "Invalid bootstrap material contract.", { details: { errors: checked.errors } });
  const payload = serialize(bundle);
  const payloadHash = putObject(store, payload);
  const creationKey = `provision-${bundleId}`;

  store.tx(() => {
    store
      .prepare(
        `INSERT INTO bootstrap_bundles (bundle_id, workspace_id, role_id, source_generation, source_knowledge_revision, checkpoint_id, checkpoint_hash, contract_package_name, contract_package_version, contract_content_hash, payload_hash, state, creation_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(
        bundle.bundle_id,
        bundle.workspace_id,
        bundle.role_id,
        bundle.source_generation,
        bundle.source_knowledge_revision,
        checkpoint.checkpoint_id,
        checkpointHash,
        pack.name,
        pack.version,
        pack.content_hash,
        payloadHash,
        creationKey,
        bundle.created_at,
      );
  });

  return {
    bundle_id: bundleId,
    role_id: roleId,
    source_generation: bundle.source_generation,
    source_knowledge_revision: bundle.source_knowledge_revision,
    checkpoint_id: checkpoint.checkpoint_id,
    payload,
    payload_hash: payloadHash,
    creation_key: creationKey,
  };
}

function isUncertainAdapterError(error: unknown): boolean {
  return (
    error instanceof RoleDockError &&
    error.details !== undefined &&
    (error.details as { uncertain?: unknown }).uncertain === true
  );
}

function insertProvisioningSession(
  store: WorkspaceStore,
  adapterName: string,
  creationKey: string,
  hostSessionRef: string | null,
  state: "provisioning" | "uncertain",
): string {
  const sessionId = `sess-${randomBytes(4).toString("hex")}`;
  store.tx(() => {
    store
      .prepare(
        "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, host_session_ref, creation_key, created_at) VALUES (?, 'primary', ?, ?, NULL, NULL, ?, ?, ?)",
      )
      .run(sessionId, adapterName, state, hostSessionRef, creationKey, new Date().toISOString());
  });
  return sessionId;
}

/**
 * provision: create the successor host session and have the adapter confirm
 * the BootstrapBundle load (hash verified host-side). Recovery: the sessions
 * row is recorded before the host call with the bundle's creation key, so a
 * crash or uncertain outcome is resolved by lookup — never by blindly
 * creating another session.
 */
async function provisionHandoffImpl(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  prep: HandoffPreparation,
): Promise<{ session_id: string; host_session_id: string }> {
  prep = rehydratePreparation(store, prep.bundle_id);
  const bundle = getBundleRow(store, prep.bundle_id);
  if (bundle === undefined) {
    throw new RoleDockError("NOT_FOUND", `Bundle "${prep.bundle_id}" does not exist.`);
  }
  if (bundle.state !== "prepared" && bundle.state !== "provisioned") {
    throw new RoleDockError(
      "INVALID_STATE_TRANSITION",
      `Bundle "${prep.bundle_id}" is ${bundle.state}; only a prepared bundle can be provisioned.`,
      { details: { state: bundle.state } },
    );
  }

  // Crash/uncertainty recovery: a sessions row with this creation key means a
  // previous attempt may have created the host session already.
  const existing = store
    .prepare("SELECT id, state FROM sessions WHERE creation_key = ?")
    .get(prep.creation_key) as { id: string; state: string } | undefined;
  if (existing !== undefined && (existing.state === "uncertain" || existing.state === "provisioning")) {
    const handle = await recoverOrCreateHost(store, adapter, prep, existing.id);
    return { session_id: existing.id, host_session_id: handle.host_session_id };
  }

  const sessionId = insertProvisioningSession(
    store,
    adapter.getCapabilities().adapter,
    prep.creation_key,
    null,
    "provisioning",
  );
  const logical = store.prepare("SELECT open_key, open_input_hash FROM bootstrap_bundles WHERE bundle_id = ?").get(prep.bundle_id) as { open_key: string | null; open_input_hash: string | null };
  store.prepare("UPDATE sessions SET open_key = ?, open_input_hash = ? WHERE id = ?").run(logical.open_key, logical.open_input_hash, sessionId);
  const handle = await createHostOrFail(store, adapter, prep, sessionId);
  markProvisioned(store, prep.bundle_id, sessionId, handle.host_session_id);
  return { session_id: sessionId, host_session_id: handle.host_session_id };
}

async function recoverOrCreateHost(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  prep: HandoffPreparation,
  sessionId: string,
): Promise<AdapterSessionHandle> {
  const canLookup =
    adapter.getCapabilities().optional.lookup_session_by_creation_key === true &&
    adapter.lookupSessionByCreationKey !== undefined;
  if (canLookup) {
    const handle = await adapter.lookupSessionByCreationKey!(prep.creation_key);
    if (handle !== null) {
      markProvisioned(store, prep.bundle_id, sessionId, handle.host_session_id);
      return handle;
    }
    // Host was never created: safe to create now under the same key.
    try {
      const handle = await adapter.createSession({
        creation_key: prep.creation_key,
        bootstrap: {
          bundle_id: prep.bundle_id,
          role_id: prep.role_id,
          content_hash: prep.payload_hash,
          payload: prep.payload,
        },
      });
      markProvisioned(store, prep.bundle_id, sessionId, handle.host_session_id);
      return handle;
    } catch (error) {
      if (!isUncertainAdapterError(error)) throw error;
      // fell through to the structured error below
    }
  }
  throw new RoleDockError(
    "ADAPTER_CAPABILITY_MISSING",
    `Host creation for bundle "${prep.bundle_id}" is uncertain (a host session may exist) and the adapter cannot look sessions up by creation key. The uncertain session is recorded for recovery; retrying with the same creation key will not create a duplicate.`,
    {
      details: {
        bundle_id: prep.bundle_id,
        session_id: sessionId,
        creation_key: prep.creation_key,
        execution_uncertain: true,
      },
    },
  );
}

function markProvisioned(
  store: WorkspaceStore,
  bundleId: string,
  sessionId: string,
  hostSessionId: string,
): void {
  store.tx(() => {
    store
      .prepare(
        "UPDATE bootstrap_bundles SET state = 'provisioned', provisioned_host_session = ? WHERE bundle_id = ?",
      )
      .run(hostSessionId, bundleId);
    store
      .prepare("UPDATE sessions SET state = 'provisioning', host_session_ref = ? WHERE id = ?")
      .run(hostSessionId, sessionId);
  });
}

async function createHostOrFail(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  prep: HandoffPreparation,
  sessionId: string,
): Promise<AdapterSessionHandle> {
  try {
    return await adapter.createSession({
      creation_key: prep.creation_key,
      bootstrap: {
        bundle_id: prep.bundle_id,
        role_id: prep.role_id,
        content_hash: prep.payload_hash,
        payload: prep.payload,
      },
    });
  } catch (error) {
    if (isUncertainAdapterError(error)) {
      store.prepare("UPDATE sessions SET state = 'uncertain' WHERE id = ?").run(sessionId);
      return recoverOrCreateHost(store, adapter, prep, sessionId);
    }
    // Hard failure before any host-side effect: abandon bundle and session.
    store.tx(() => {
      store.prepare("UPDATE bootstrap_bundles SET state = 'abandoned' WHERE bundle_id = ?").run(prep.bundle_id);
      store.prepare("UPDATE sessions SET state = 'failed' WHERE id = ?").run(sessionId);
    });
    throw new RoleDockError(
      "INTERNAL",
      `Host session creation failed during provision: ${(error as Error).message}`,
      {
        details: {
          stage: "provision",
          bundle_id: prep.bundle_id,
          adapter: adapter.getCapabilities().adapter,
        },
      },
    );
  }
}

export interface ActivationResult {
  session_id: string;
  instance_id: string;
  role_id: string;
  generation: number;
  predecessor_instance_id: string;
}

/**
 * activate: single-transaction compare-and-swap on the primary pointer. The
 * bundle's frozen (generation, knowledge_revision) pair must still be
 * current: generation moved → GENERATION_CONFLICT (a concurrent successor
 * won), knowledge moved → REVISION_CONFLICT (caller must re-prepare). On
 * success the predecessor instance becomes superseded and immediately loses
 * formal publish rights.
 */
export function activateHandoff(
  store: WorkspaceStore,
  input: { bundle_id: string },
): ActivationResult {
  return store.tx(() => {
    const bundle = getBundleRow(store, input.bundle_id);
    if (bundle === undefined) {
      throw new RoleDockError("NOT_FOUND", `Bundle "${input.bundle_id}" does not exist.`);
    }
    if (bundle.state !== "provisioned") {
      throw new RoleDockError(
        "INVALID_STATE_TRANSITION",
        `Bundle "${input.bundle_id}" is ${bundle.state}; only a provisioned bundle can be activated.`,
        { details: { state: bundle.state } },
      );
    }
    requireCapability(store, bundle.role_id, "documents.read");
    const head = getHead(store, bundle.role_id);
    if (head === undefined) {
      throw new RoleDockError("INTERNAL", "Role head vanished before activation.");
    }
    if (head.generation !== bundle.source_generation) {
      throw new RoleDockError(
        "GENERATION_CONFLICT",
        `Primary pointer moved concurrently: bundle expects generation ${bundle.source_generation}, current is ${head.generation}. Exactly one activation wins.`,
        {
          details: {
            current_generation: head.generation,
            bundle_source_generation: bundle.source_generation,
            bundle_id: bundle.bundle_id,
          },
        },
      );
    }
    if (head.knowledge_revision !== bundle.source_knowledge_revision) {
      throw new RoleDockError(
        "REVISION_CONFLICT",
        `Knowledge changed during preparation: bundle expects knowledge_revision ${bundle.source_knowledge_revision}, current is ${head.knowledge_revision}. Re-prepare the handoff.`,
        {
          details: {
            current_knowledge_revision: head.knowledge_revision,
            bundle_source_knowledge_revision: bundle.source_knowledge_revision,
            bundle_id: bundle.bundle_id,
          },
        },
      );
    }

    const now = new Date().toISOString();
    const instanceId = `inst-${randomBytes(4).toString("hex")}`;
    const generation = head.generation + 1;
    store
      .prepare(
        "INSERT INTO agent_instances (id, role_id, generation, predecessor_instance_id, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      )
      .run(instanceId, bundle.role_id, generation, head.current_instance_id, now);
    if (head.current_instance_id !== null) {
      store
        .prepare("UPDATE agent_instances SET state = 'superseded' WHERE id = ?")
        .run(head.current_instance_id);
    }
    store
      .prepare(
        "UPDATE role_heads SET generation = ?, current_instance_id = ?, updated_at = ? WHERE role_id = ?",
      )
      .run(generation, instanceId, now, bundle.role_id);
    store
      .prepare("UPDATE bootstrap_bundles SET state = 'activated', activated_at = ? WHERE bundle_id = ?")
      .run(now, bundle.bundle_id);
    if (bundle.provisioned_host_session !== null) {
      store
        .prepare(
          "UPDATE sessions SET state = 'active', role_id = ?, instance_id = ? WHERE host_session_ref = ? AND state = 'provisioning'",
        )
        .run(bundle.role_id, instanceId, bundle.provisioned_host_session);
    }

    return {
      session_id: bundle.provisioned_host_session ?? "",
      instance_id: instanceId,
      role_id: bundle.role_id,
      generation,
      predecessor_instance_id: head.current_instance_id ?? "",
    };
  });
}

/** Abandon a provisioned (or uncertain) attempt and close its host session. */
export async function abandonProvisioned(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  bundleId: string,
): Promise<void> {
  const bundle = getBundleRow(store, bundleId);
  if (bundle === undefined || bundle.state !== "provisioned") return;
  store.tx(() => {
    store.prepare("UPDATE bootstrap_bundles SET state = 'abandoned' WHERE bundle_id = ?").run(bundleId);
    if (bundle.provisioned_host_session !== null) {
      store
        .prepare("UPDATE sessions SET state = 'abandoned' WHERE host_session_ref = ? AND state = 'provisioning'")
        .run(bundle.provisioned_host_session);
    }
  });
  if (bundle.provisioned_host_session !== null) {
    await adapter
      .closeSession({
        adapter: adapter.getCapabilities().adapter,
        host_session_id: bundle.provisioned_host_session,
        creation_key: bundle.creation_key ?? "",
      })
      .catch(() => {
        // Best-effort host cleanup; the authoritative state is the DB.
      });
  }
}

const provisioning = new WeakMap<WorkspaceStore, Map<string, Promise<{ session_id: string; host_session_id: string }>>>();
export async function provisionHandoff(store: WorkspaceStore, adapter: HarnessAdapter, prep: HandoffPreparation): Promise<{ session_id: string; host_session_id: string }> {
  const active = provisioning.get(store) ?? new Map();
  provisioning.set(store, active);
  const pending = active.get(prep.bundle_id);
  if (pending) return pending;
  const promise = provisionHandoffImpl(store, adapter, prep);
  active.set(prep.bundle_id, promise);
  try { return await promise; } finally { active.delete(prep.bundle_id); }
}
