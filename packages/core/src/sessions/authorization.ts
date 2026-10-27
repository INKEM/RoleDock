import { RoleDockError } from "@roledock/protocol";
import type { RoleAuthorization } from "@roledock/protocol";
import type { WorkspaceStore } from "../store/workspace.js";

export function authorizationRecord(store: WorkspaceStore, id: string): RoleAuthorization {
  const row = store.prepare("SELECT record_json, revoked_at FROM role_authorizations WHERE authorization_id = ?").get(id) as { record_json: string; revoked_at: string | null } | undefined;
  if (!row) throw new RoleDockError("PERMISSION_DENIED", "Authorization is unavailable to this connection.");
  return { ...JSON.parse(row.record_json) as RoleAuthorization, revoked_at: row.revoked_at };
}
export function assertLiveAuthorization(store: WorkspaceStore, id: string, capability?: string): RoleAuthorization {
  const auth = authorizationRecord(store, id);
  if (auth.revoked_at || Date.parse(auth.expires_at) <= Date.now()) throw new RoleDockError("PERMISSION_DENIED", "Authorization is revoked or expired.");
  if (capability && !auth.capabilities.includes(capability)) throw new RoleDockError("PERMISSION_DENIED", `Authorization denies ${capability}.`);
  return auth;
}
/** Called inside an existing transaction. Never reinstates a predecessor. */
export function invalidateBinding(store: WorkspaceStore, externalId: string, state: "released" | "revoked" | "expired"): void {
  const row = store.prepare("SELECT * FROM session_bindings WHERE external_session_id = ?").get(externalId) as { instance_id: string; session_id: string; authorization_id: string; role_id: string; state: string } | undefined;
  if (!row || !["active", "superseded"].includes(row.state)) return;
  const now = new Date().toISOString();
  store.prepare("UPDATE session_bindings SET state = ?, state_changed_at = ? WHERE external_session_id = ?").run(state, now, externalId);
  store.prepare("UPDATE sessions SET state = ? WHERE id = ?").run(state, row.session_id);
  store.prepare("UPDATE agent_instances SET state = 'retired' WHERE id = ?").run(row.instance_id);
  store.prepare("UPDATE role_heads SET current_instance_id = NULL, updated_at = ? WHERE role_id = ? AND current_instance_id = ?").run(now, row.role_id, row.instance_id);
  store.prepare(`UPDATE requests SET state = 'failed', error_json = ?, terminal_at = ?, updated_at = ?, cleanup_pending = 1,
    execution_uncertain = CASE WHEN state = 'running' THEN 1 ELSE execution_uncertain END
    WHERE (initiating_authorization_id = ? OR target_authorization_id = ?) AND state NOT IN ('completed','failed','cancelled','expired')`)
    .run(JSON.stringify({ code: "PERMISSION_DENIED", message: `Binding ${state}; delegated task authorization withdrawn.` }), now, now, row.authorization_id, row.authorization_id);
}
/** Owner/service maintenance; expiry remains enforced even if this has not run yet. */
export function sweepAuthorizations(store: WorkspaceStore): void {
  store.tx(() => {
    const rows = store.prepare("SELECT external_session_id, authorization_id FROM session_bindings WHERE state IN ('active','superseded')").all() as unknown as { external_session_id: string; authorization_id: string }[];
    for (const row of rows) {
      const auth = authorizationRecord(store, row.authorization_id);
      if (auth.revoked_at) invalidateBinding(store, row.external_session_id, "revoked");
      else if (Date.parse(auth.expires_at) <= Date.now()) invalidateBinding(store, row.external_session_id, "expired");
    }
  });
}
export function requireBindingCapability(store: WorkspaceStore, sessionId: string, capability?: string): void {
  const binding = store.prepare("SELECT authorization_id, state FROM session_bindings WHERE session_id = ?").get(sessionId) as { authorization_id: string; state: string } | undefined;
  if (!binding) return; // Legacy trusted local SDK sessions have their existing policy boundary.
  if (!["active", "superseded"].includes(binding.state)) throw new RoleDockError("PERMISSION_DENIED", "Session binding has been withdrawn.");
  assertLiveAuthorization(store, binding.authorization_id, capability);
}
export function requireDelegatedAuthorizations(store: WorkspaceStore, requestId: string): void {
  const row = store.prepare("SELECT state, initiating_authorization_id, target_authorization_id FROM requests WHERE request_id = ?").get(requestId) as { state: string; initiating_authorization_id: string | null; target_authorization_id: string | null };
  if (["completed", "failed", "cancelled", "expired"].includes(row.state)) throw new RoleDockError("PERMISSION_DENIED", "Terminal request branches have no task authority.");
  for (const id of [row.initiating_authorization_id, row.target_authorization_id]) {
    if (!id) continue;
    const binding = store.prepare("SELECT state FROM session_bindings WHERE authorization_id = ?").get(id) as { state: string } | undefined;
    if (!binding || !["active", "superseded"].includes(binding.state)) throw new RoleDockError("PERMISSION_DENIED", "Delegating binding is no longer authorized.");
  }
  if (row.initiating_authorization_id) assertLiveAuthorization(store, row.initiating_authorization_id, "requests.create");
  if (row.target_authorization_id) {
    assertLiveAuthorization(store, row.target_authorization_id, "requests.execute");
    assertLiveAuthorization(store, row.target_authorization_id, "documents.read");
  }
}
