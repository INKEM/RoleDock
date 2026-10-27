import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { RoleDockError } from "@roledock/protocol";
import type { CollaborationRequest, ErrorCode } from "@roledock/protocol";
import { putObject, bodyHash } from "../store/objects.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { isFullAccess } from "../ports/adapter.js";
import type { AdapterSessionHandle, HarnessAdapter } from "../ports/adapter.js";
import { requireCapability } from "../policy.js";
import { expireIfOverdue, requestTempDir } from "./service.js";
import type { RequestBudget, RequestRow } from "./service.js";
import { requireDelegatedAuthorizations } from "../sessions/authorization.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const inFlight = new WeakMap<WorkspaceStore, Map<string, Promise<ExecutionResult>>>();
function getRow(store: WorkspaceStore, id: string): RequestRow {
  const row = store.prepare("SELECT * FROM requests WHERE request_id = ?").get(id) as RequestRow | undefined;
  if (!row) throw new RoleDockError("NOT_FOUND", `Request ${id} does not exist.`);
  return row;
}
export interface ExecutionResult { request_id: string; state: CollaborationRequest["state"]; artifact_id?: string }
function status(row: RequestRow): ExecutionResult {
  return { request_id: row.request_id, state: row.state, ...(row.result_artifact_id ? { artifact_id: row.result_artifact_id } : {}) };
}
function authorization(store: WorkspaceStore, row: RequestRow, adapter: HarnessAdapter): void {
  requireDelegatedAuthorizations(store, row.request_id);
  requireCapability(store, row.initiating_role_id, "requests.create");
  requireCapability(store, row.target_role_id, "requests.execute");
  requireCapability(store, row.target_role_id, "documents.read");
  const initiator = store.prepare("SELECT state FROM sessions WHERE id = ?").get(row.initiating_session_id) as { state: string } | undefined;
  if (initiator?.state !== "active") throw new RoleDockError("PERMISSION_DENIED", "Request initiator is no longer active.");
  if (!isFullAccess(adapter.getCapabilities())) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Independent requests require all four isolation scopes.");
  const scope = JSON.parse(row.capability_scope_json) as string[];
  for (const capability of scope) requireCapability(store, row.target_role_id, capability);
}
/** Every post-await transition re-reads terminal state, expiry and live policy. */
function current(store: WorkspaceStore, id: string, adapter: HarnessAdapter): RequestRow {
  const row = expireIfOverdue(store, getRow(store, id));
  if (!TERMINAL.has(row.state)) authorization(store, row, adapter);
  return row;
}
function fail(store: WorkspaceStore, id: string, code: ErrorCode, message: string, preserveUncertain = false): void {
  store.tx(() => {
    const row = expireIfOverdue(store, getRow(store, id));
    if (TERMINAL.has(row.state)) return;
    const now = new Date().toISOString();
    store.prepare("UPDATE requests SET state = 'failed', error_json = ?, terminal_at = ?, updated_at = ?, cleanup_pending = 1, execution_uncertain = ? WHERE request_id = ?")
      .run(JSON.stringify({ code, message }), now, now, preserveUncertain ? row.execution_uncertain : 0, id);
  });
}
export async function cleanupRequest(store: WorkspaceStore, adapter: HarnessAdapter, id: string): Promise<void> {
  rmSync(join(requestTempDir(store, id), "tmp"), { recursive: true, force: true });
  const session = store.prepare("SELECT id, state, host_session_ref, creation_key, kind, role_id FROM sessions WHERE creation_key = ?").get(`request-${id}`) as { id: string; state: string; host_session_ref: string | null; creation_key: string; kind: string; role_id: string | null } | undefined;
  if (session && (session.kind !== "request" || session.role_id !== getRow(store, id).target_role_id)) {
    store.prepare("UPDATE requests SET cleanup_pending = 1, cleanup_error_json = ? WHERE request_id = ?")
      .run(JSON.stringify({ code: "INTERNAL", message: "Request branch session collides with another session; reclamation refused." }), id);
    return;
  }
  if (!session || session.state === "closed") {
    store.prepare("UPDATE requests SET cleanup_pending = 0, cleanup_error_json = NULL WHERE request_id = ?").run(id);
    return;
  }
  store.prepare("UPDATE requests SET cleanup_pending = 1 WHERE request_id = ?").run(id);
  try {
    let handle: AdapterSessionHandle | null = session.host_session_ref ? {
      adapter: adapter.getCapabilities().adapter, host_session_id: session.host_session_ref, creation_key: session.creation_key,
    } : null;
    if (!handle) {
      if (!adapter.getCapabilities().optional.lookup_session_by_creation_key || !adapter.lookupSessionByCreationKey) return;
      handle = await adapter.lookupSessionByCreationKey(session.creation_key);
    }
    if (handle) await adapter.closeSession(handle);
    store.tx(() => {
      store.prepare("UPDATE sessions SET state = 'closed' WHERE id = ?").run(session.id);
      store.prepare("UPDATE requests SET cleanup_pending = 0, cleanup_error_json = NULL WHERE request_id = ?").run(id);
    });
  } catch (error) {
    // G6 (requests.listCleanup): a reclamation FAILURE is recorded and
    // distinguishable from completion; the terminal state never changes and
    // the durable cleanup_pending=1 is retried by redelivery, including
    // after restart.
    store.prepare("UPDATE requests SET cleanup_error_json = ? WHERE request_id = ?")
      .run(JSON.stringify({ code: "INTERNAL", message: (error instanceof Error ? error.message : String(error)).slice(0, 300) }), id);
  }
}
async function secureSession(store: WorkspaceStore, adapter: HarnessAdapter, row: RequestRow): Promise<AdapterSessionHandle> {
  const key = `request-${row.request_id}`;
  let session = store.prepare("SELECT * FROM sessions WHERE creation_key = ?").get(key) as { id: string; state: string; host_session_ref: string | null; bootstrap_payload: string; kind: string; role_id: string | null } | undefined;
  if (session && (session.kind !== "request" || session.role_id !== row.target_role_id)) throw new RoleDockError("VALIDATION_FAILED", "Host creation key collides with another session binding.");
  const recovery = session !== undefined;
  if (!session) {
    if (!row.binding_material_json) throw new RoleDockError("NOT_IMPLEMENTED", "Legacy request lacks frozen materials; recreate the request.");
    const id = `sess-${randomBytes(5).toString("hex")}`;
    const payload = JSON.stringify({ request_id: row.request_id, question: row.question, target_role_id: row.target_role_id,
      generation: row.binding_generation, knowledge_revision: row.binding_knowledge_revision,
      materials: JSON.parse(row.binding_material_json) });
    store.prepare("INSERT INTO sessions (id, kind, adapter, state, role_id, creation_key, created_at, bootstrap_payload, capability_scope_json) VALUES (?, 'request', ?, 'provisioning', ?, ?, ?, ?, ?)")
      .run(id, adapter.getCapabilities().adapter, row.target_role_id, key, new Date().toISOString(), payload, row.capability_scope_json);
    session = { id, state: "provisioning", host_session_ref: null, bootstrap_payload: payload, kind: "request", role_id: row.target_role_id };
  }
  if (session.host_session_ref) return { adapter: adapter.getCapabilities().adapter, host_session_id: session.host_session_ref, creation_key: key };
  let handle: AdapterSessionHandle | null = null;
  if (recovery) {
    if (!adapter.getCapabilities().optional.lookup_session_by_creation_key || !adapter.lookupSessionByCreationKey) {
      throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Creation outcome requires reconciliation.", { details: { uncertain: true } });
    }
    handle = await adapter.lookupSessionByCreationKey(key);
    if (TERMINAL.has(current(store, row.request_id, adapter).state)) {
      if (handle) store.prepare("UPDATE sessions SET host_session_ref = ? WHERE id = ?").run(handle.host_session_id, session.id);
      throw new RoleDockError("INVALID_STATE_TRANSITION", "Request terminated during reconciliation.");
    }
  }
  if (!handle) {
    try {
      handle = await adapter.createSession({ creation_key: key,
        bootstrap: { bundle_id: key, role_id: row.target_role_id, payload: session.bootstrap_payload, content_hash: bodyHash(session.bootstrap_payload) },
        capability_scope: JSON.parse(row.capability_scope_json), temp_dir: join(requestTempDir(store, row.request_id), "tmp") });
    } catch (error) {
      store.prepare("UPDATE sessions SET state = 'uncertain' WHERE id = ?").run(session.id);
      if (adapter.getCapabilities().optional.lookup_session_by_creation_key && adapter.lookupSessionByCreationKey) handle = await adapter.lookupSessionByCreationKey(key);
      if (!handle) throw error;
    }
  }
  store.prepare("UPDATE sessions SET state = 'active', host_session_ref = ? WHERE id = ?").run(handle.host_session_id, session.id);
  return handle;
}
async function execute(store: WorkspaceStore, adapter: HarnessAdapter, id: string): Promise<ExecutionResult> {
  let row = getRow(store, id);
  row = expireIfOverdue(store, row);
  if (TERMINAL.has(row.state)) { await cleanupRequest(store, adapter, id); return status(getRow(store, id)); }
  if (row.state === "awaiting_input") return status(row);
  try {
    row = store.tx(() => {
      const checked = current(store, id, adapter);
      if (TERMINAL.has(checked.state)) return checked;
      if (checked.state === "accepted" || checked.state === "queued") {
        store.prepare("UPDATE requests SET state = 'running', execution_phase = 'creating', execution_uncertain = 1 WHERE request_id = ?").run(id);
      }
      return getRow(store, id);
    });
    if (TERMINAL.has(row.state)) return status(row);
    const dir = requestTempDir(store, id);
    mkdirSync(join(dir, "tmp"), { recursive: true });
    writeFileSync(join(dir, "question.md"), row.question, "utf8");
    const handle = await secureSession(store, adapter, row);
    if (getRow(store, id).execution_phase === "creating") store.prepare("UPDATE requests SET execution_uncertain = 0 WHERE request_id = ?").run(id);
    row = store.tx(() => current(store, id, adapter));
    if (TERMINAL.has(row.state)) return status(row);
    const budget = JSON.parse(row.budget_json) as RequestBudget;
    if (row.execution_phase === "creating") {
      row = store.tx(() => {
        const checked = current(store, id, adapter);
        if (TERMINAL.has(checked.state)) return checked;
        if (budget.max_turns !== undefined && checked.turns_reserved >= budget.max_turns) {
          throw new RoleDockError("PERMISSION_DENIED", "Request turn budget exhausted before execution.");
        }
        const key = `${id}:turn:${checked.turns_reserved + 1}`;
        store.prepare("UPDATE requests SET turns_reserved = turns_reserved + 1, turn_key = ?, execution_phase = 'turn-intent', execution_uncertain = 1 WHERE request_id = ?").run(key, id);
        return getRow(store, id);
      });
      if (TERMINAL.has(row.state)) return status(row);
      const turn = await adapter.runTurn(handle, { message: row.question, execution_key: row.turn_key!, budget });
      store.prepare("UPDATE requests SET execution_uncertain = 0, execution_phase = 'result' WHERE request_id = ?").run(id);
      row = store.tx(() => current(store, id, adapter));
      if (TERMINAL.has(row.state)) return status(row);
      if (!turn.accepted) throw new RoleDockError("INVALID_STATE_TRANSITION", "Host refused the request turn.");
      store.prepare("UPDATE requests SET execution_phase = 'result', execution_uncertain = 0 WHERE request_id = ?").run(id);
    }
    // A persisted turn-intent is only queried, never resent after a lost ack.
    const result = await adapter.getResult(handle);
    return store.tx(() => {
      const checked = current(store, id, adapter);
      if (TERMINAL.has(checked.state)) return status(checked);
      if (result.execution_key !== checked.turn_key) {
        store.prepare("UPDATE requests SET execution_uncertain = 1 WHERE request_id = ?").run(id);
        return status(getRow(store, id));
      }
      store.prepare("UPDATE requests SET execution_uncertain = 0, execution_phase = 'result' WHERE request_id = ?").run(id);
      const bytes = result.body === undefined ? result.output_bytes ?? 0 : Math.max(Buffer.byteLength(result.body, "utf8"), result.output_bytes ?? 0);
      if (budget.max_output_bytes !== undefined && checked.output_bytes_used + bytes > budget.max_output_bytes) {
        throw new RoleDockError("PERMISSION_DENIED", "Request output budget exhausted.");
      }
      if (result.needs_input) {
        store.prepare("UPDATE requests SET state = 'awaiting_input', execution_phase = 'waiting', output_bytes_used = output_bytes_used + ? WHERE request_id = ?").run(bytes, id);
        return status(getRow(store, id));
      }
      if (result.state === "running" || !result.completed) return status(getRow(store, id));
      if (typeof result.body !== "string") throw new RoleDockError("NOT_IMPLEMENTED", "Host completion has no readable answer material.");
      const hash = putObject(store, result.body);
      const artifactId = `art-${randomBytes(5).toString("hex")}`;
      const now = new Date().toISOString();
      store.prepare("INSERT INTO request_artifacts (artifact_id, workspace_id, request_id, producing_role_id, content_hash, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(artifactId, store.workspaceId, id, checked.target_role_id, hash, `Result ${id}`, now);
      store.prepare("INSERT INTO request_inbox (entry_id, workspace_id, owner_role_id, request_id, artifact_id, content_hash, summary, state, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?)").run(`inbox-${id}`, store.workspaceId, checked.target_role_id, id, artifactId, hash, `Result ${id}`, now);
      store.prepare("UPDATE requests SET state = 'completed', execution_phase = 'done', result_artifact_id = ?, result_content_hash = ?, terminal_at = ?, updated_at = ?, output_bytes_used = output_bytes_used + ?, cleanup_pending = 1, error_json = NULL WHERE request_id = ?").run(artifactId, hash, now, now, bytes, id);
      return status(getRow(store, id));
    });
  } catch (error) {
    const row = expireIfOverdue(store, getRow(store, id));
    if (TERMINAL.has(row.state)) return status(row);
    const declaredUncertain = error instanceof RoleDockError && (error.details as { uncertain?: boolean } | undefined)?.uncertain === true;
    const uncertain = declaredUncertain || ((row.execution_phase === "turn-intent" || row.execution_phase === "result" || row.execution_phase === "creating") &&
      (!(error instanceof RoleDockError) || error.code === "INTERNAL"));
    if (uncertain && !(error instanceof RoleDockError && (error.code === "PERMISSION_DENIED" || (error.code === "ADAPTER_CAPABILITY_MISSING" && (error.details as { uncertain?: boolean } | undefined)?.uncertain !== true)))) {
      store.prepare("UPDATE requests SET execution_uncertain = 1, error_json = ? WHERE request_id = ?").run(JSON.stringify({ code: "INTERNAL", message: "External action needs reconciliation." }), id);
    } else fail(store, id, error instanceof RoleDockError ? error.code : "INTERNAL", (error as Error).message,
      row.execution_phase === "turn-intent" && error instanceof RoleDockError && error.code === "PERMISSION_DENIED");
    throw error;
  } finally {
    if (TERMINAL.has(getRow(store, id).state)) await cleanupRequest(store, adapter, id);
  }
}
/** Coalesce live duplicate deliveries; durable phase is claimed before any host action. */
export async function executeRequest(store: WorkspaceStore, adapter: HarnessAdapter, requestId: string): Promise<ExecutionResult> {
  const active = inFlight.get(store) ?? new Map();
  inFlight.set(store, active);
  const existing = active.get(requestId);
  if (existing) return existing;
  const promise = execute(store, adapter, requestId);
  active.set(requestId, promise);
  try { return await promise; } finally { active.delete(requestId); }
}
export async function cancelRunningRequest(store: WorkspaceStore, adapter: HarnessAdapter, requestId: string): Promise<void> {
  const request = getRow(store, requestId);
  const row = store.prepare("SELECT host_session_ref, kind, role_id FROM sessions WHERE creation_key = ?").get(`request-${requestId}`) as { host_session_ref: string | null; kind: string; role_id: string | null } | undefined;
  try {
    if (row?.kind === "request" && row.role_id === request.target_role_id && row.host_session_ref && adapter.getCapabilities().optional.cancel && adapter.cancel) {
      await adapter.cancel({ adapter: adapter.getCapabilities().adapter, host_session_id: row.host_session_ref, creation_key: `request-${requestId}` });
    }
  } finally {
    await cleanupRequest(store, adapter, requestId);
  }
}
export function rejectLateCompletion(store: WorkspaceStore, requestId: string): never {
  const row = getRow(store, requestId);
  throw new RoleDockError("INVALID_STATE_TRANSITION", `Request is ${row.state}; external late completion is rejected.`);
}
