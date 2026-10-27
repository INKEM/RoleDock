import { randomUUID } from "node:crypto";
import { RoleDockError, validate } from "@roledock/protocol";
import type { AnchorAttempt, AnchorConfirmation, AnchorAttemptView, AnchorAttemptsPage, AnchorLoadView, AnchorLoadsPage, AuthorizationConfirmationsPage, CollaborationRequestState, ConfirmationChainEntry, ConfirmationEventView, ExternalSession, HostSessionDiscovery, PendingHumanEventsPage, PendingHumanEventView, RevokePreview, RoleAuthorization, SessionBinding, SessionBindingView, SessionBindingsPage, SessionOperation, SchemaName } from "@roledock/protocol";
import type { Coordinator } from "../coordinator.js";
import { coordinatorStore } from "../internal-store.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { getHead, getPack, getRoleRow } from "../store/queries.js";
import { bodyHash, putObject, readObject } from "../store/objects.js";
import type { HarnessAdapter, HumanAuthorizationEvent, HumanAuthorizationEventRecord, HumanAuthorizationSource } from "../ports/adapter.js";
import { roleMaterial, documentMaterial } from "./material.js";
import { getLatestCheckpoint } from "../documents/checkpoint.js";
import { assertCapabilityName } from "../policy.js";
import { authorizationRecord, assertLiveAuthorization, invalidateBinding, sweepAuthorizations } from "./authorization.js";
import { cancelRunningRequest, cleanupRequest, executeRequest } from "../requests/executor.js";

const newId = (prefix: string) => `${prefix}-${randomUUID()}`;
function checked<T>(schema: SchemaName, value: unknown): T {
  const result = validate<T>(schema, value);
  if (!result.ok) throw new RoleDockError("VALIDATION_FAILED", `Invalid ${schema}.`, { details: { errors: result.errors } });
  return result.value;
}
function fields(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RoleDockError("VALIDATION_FAILED", "Expected an input object.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some(key => ![...required, ...optional].includes(key)) || required.some(key => record[key] === undefined)) throw new RoleDockError("VALIDATION_FAILED", "Missing or unknown input fields.");
  return record;
}
function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new RoleDockError("VALIDATION_FAILED", `Invalid ${key}.`);
  return value;
}
function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) throw new RoleDockError("VALIDATION_FAILED", "Capabilities must be unique strings.");
  for (const item of value as string[]) assertCapabilityName(item);
  return [...value as string[]].sort();
}
interface AttemptRow extends Omit<AnchorAttempt, "confirmation" | "error"> { confirmation_json: string | null; error_json: string | null }
interface EventRow {
  workspace_id: string; external_session_id: string; host_session_id: string; connection_subject: string;
  event_ref: string; actor_id: string; role_id: string; capabilities_json: string; inherit: string;
  expires_at: string; entry: string; recorded_at: string; input_hash: string;
}
function eventRecord(row: EventRow): HumanAuthorizationEventRecord {
  return { workspace_id: row.workspace_id, host_session_id: row.host_session_id, connection_subject: row.connection_subject,
    event_ref: row.event_ref, actor_id: row.actor_id, role_id: row.role_id, capabilities: JSON.parse(row.capabilities_json) as string[],
    inherit: row.inherit as HumanAuthorizationEventRecord["inherit"], expires_at: row.expires_at, entry: row.entry as HumanAuthorizationEventRecord["entry"], recorded_at: row.recorded_at };
}
/** Read view for adapters that attest human events; written only via submitHumanEvent. */
export function storeHumanAuthorizationSource(store: WorkspaceStore): HumanAuthorizationSource {
  return {
    async readEvent(hostSessionId: string, eventRef: string): Promise<HumanAuthorizationEventRecord | null> {
      const row = store.prepare("SELECT * FROM human_authorization_events WHERE workspace_id = ? AND host_session_id = ? AND event_ref = ?")
        .get(store.workspaceId, hostSessionId, eventRef) as EventRow | undefined;
      return row ? eventRecord(row) : null;
    },
  };
}
export interface AnchorResult { attempt: AnchorAttempt; binding: SessionBinding | null }

/** Trusted local owner/host control plane. Never register this class as Agent tools. */
export class ExternalSessionAuthority {
  readonly #store: WorkspaceStore;
  readonly #coordinator: Coordinator;
  readonly #adapter: HarnessAdapter;
  readonly #inFlight = new Map<string, Promise<AnchorResult>>();
  constructor(coordinator: Coordinator, adapter: HarnessAdapter) {
    this.#store = coordinatorStore(coordinator); this.#coordinator = coordinator; this.#adapter = adapter;
    // B2: adapters that attest human events read the owner-written store view.
    this.#adapter.useHumanAuthorizationSource?.(storeHumanAuthorizationSource(this.#store));
  }
  get workspaceId(): string { return this.#store.workspaceId; }
  /**
   * G-min: owner confirmation surface read view — registered sessions with
   * their live (unrevoked, unexpired) authorization summary. Read-only;
   * listing grants nothing.
   */
  listExternalSessions(): Array<{ session: ExternalSession; active_authorization: { authorization_id: string; role_id: string; expires_at: string; source: RoleAuthorization["source"] } | null }> {
    sweepAuthorizations(this.#store);
    return (this.#store.prepare("SELECT external_session_id FROM external_sessions ORDER BY created_at, external_session_id").all() as { external_session_id: string }[]).map(row => {
      const session = this.externalSession(row.external_session_id);
      const live = (this.#store.prepare("SELECT record_json, revoked_at FROM role_authorizations WHERE external_session_id = ?").all(row.external_session_id) as { record_json: string; revoked_at: string | null }[])
        .map(entry => ({ ...(JSON.parse(entry.record_json) as RoleAuthorization), revoked_at: entry.revoked_at }))
        .filter(auth => auth.revoked_at === null && Date.parse(auth.expires_at) > Date.now())
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const active = live[0];
      return { session, active_authorization: active ? { authorization_id: active.authorization_id, role_id: active.role_id, expires_at: active.expires_at, source: active.source } : null };
    });
  }
  /**
   * G3 (desktop-gui-contract §9, ADR-0014): owner read view of the
   * confirmation progress chain per registered external session. Projection
   * only — listing and paging never advance any state.
   */
  listConfirmations(input: unknown): AuthorizationConfirmationsPage {
    const data = fields(input, [], ["cursor", "limit", "external_session_id"]);
    const limit = data.limit === undefined ? 50 : data.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new RoleDockError("VALIDATION_FAILED", "limit must be an integer between 1 and 200.");
    if (data.external_session_id !== undefined && (typeof data.external_session_id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(data.external_session_id as string))) throw new RoleDockError("VALIDATION_FAILED", "Invalid external_session_id filter.");
    let cursor: { created_at: string; external_session_id: string } | null = null;
    if (data.cursor !== undefined && data.cursor !== null) {
      if (typeof data.cursor !== "string") throw new RoleDockError("VALIDATION_FAILED", "cursor must be a string.");
      try {
        const raw = JSON.parse(Buffer.from(data.cursor, "base64url").toString("utf8")) as { created_at?: unknown; external_session_id?: unknown };
        if (typeof raw.created_at !== "string" || typeof raw.external_session_id !== "string") throw new Error("bad cursor shape");
        cursor = { created_at: raw.created_at, external_session_id: raw.external_session_id };
      } catch { throw new RoleDockError("VALIDATION_FAILED", "cursor is not a valid confirmation page key."); }
    }
    sweepAuthorizations(this.#store);
    let rows = this.#store.prepare("SELECT external_session_id, host_session_id, connection_subject, created_at FROM external_sessions ORDER BY created_at, external_session_id").all() as unknown as { external_session_id: string; host_session_id: string; connection_subject: string; created_at: string }[];
    if (data.external_session_id !== undefined) rows = rows.filter(row => row.external_session_id === data.external_session_id);
    if (cursor) rows = rows.filter(row => row.created_at > cursor!.created_at || (row.created_at === cursor!.created_at && row.external_session_id > cursor!.external_session_id));
    const page = rows.slice(0, limit as number);
    const items = page.map(row => this.confirmationChain(row));
    const last = page.at(-1);
    const next = last && rows.length > page.length ? Buffer.from(JSON.stringify({ created_at: last.created_at, external_session_id: last.external_session_id }), "utf8").toString("base64url") : null;
    return { workspace_id: this.workspaceId, observed_at: new Date().toISOString(), items, next_cursor: next };
  }
  private confirmationChain(row: { external_session_id: string; host_session_id: string; connection_subject: string; created_at: string }): ConfirmationChainEntry {
    const events = (this.#store.prepare("SELECT * FROM human_authorization_events WHERE external_session_id = ? ORDER BY recorded_at, event_ref").all(row.external_session_id) as unknown as EventRow[]).map(entry => {
      const sourceKey = JSON.stringify([row.external_session_id, "human-event", entry.event_ref]);
      const prior = this.#store.prepare("SELECT authorization_id, record_json, revoked_at FROM role_authorizations WHERE source_key = ?").get(sourceKey) as { authorization_id: string; record_json: string; revoked_at: string | null } | undefined;
      const authorization = prior ? JSON.parse(prior.record_json) as RoleAuthorization : null;
      return {
        event_ref: entry.event_ref, actor_id: entry.actor_id, role_id: entry.role_id,
        capabilities: JSON.parse(entry.capabilities_json) as string[], inherit: entry.inherit as ConfirmationEventView["inherit"],
        expires_at: entry.expires_at, entry: entry.entry as ConfirmationEventView["entry"], recorded_at: entry.recorded_at,
        authorization: authorization ? { authorization_id: prior!.authorization_id, created_at: authorization.created_at, revoked_at: prior!.revoked_at, expected_generation: authorization.expected_generation } : null,
      };
    });
    const attemptRow = this.#store.prepare("SELECT * FROM anchor_attempts WHERE external_session_id = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1").get(row.external_session_id) as AttemptRow | undefined;
    const anchor_attempt = attemptRow ? {
      attempt_id: attemptRow.attempt_id, authorization_id: attemptRow.authorization_id, state: attemptRow.state, created_at: attemptRow.created_at,
      error: attemptRow.error_json ? JSON.parse(attemptRow.error_json) as { code: string; message: string } : null,
      load: attemptRow.confirmation_json ? JSON.parse(attemptRow.confirmation_json) as AnchorConfirmation : null,
    } : null;
    const bindingRow = this.#store.prepare("SELECT session_id, role_id, generation, state, created_at FROM session_bindings WHERE external_session_id = ?").get(row.external_session_id) as { session_id: string; role_id: string; generation: number; state: SessionBinding["state"]; created_at: string } | undefined;
    return {
      external_session_id: row.external_session_id, host_session_id: row.host_session_id, connection_subject: row.connection_subject, created_at: row.created_at,
      events, anchor_attempt,
      binding: bindingRow ? { session_id: bindingRow.session_id, role_id: bindingRow.role_id, generation: bindingRow.generation, state: bindingRow.state, created_at: bindingRow.created_at } : null,
    };
  }
  /**
   * G3 (ADR-0014 §9.3): trusted-face pending queue — stored human events with
   * no live authorization yet, for THIS connection subject's registered
   * sessions only. The subject comes from the trusted principal, never from
   * RPC input; ordinary sessions and owner connections have no such view.
   */
  listPendingHumanEvents(subject: string): PendingHumanEventsPage {
    sweepAuthorizations(this.#store);
    const sessions = this.#store.prepare("SELECT external_session_id FROM external_sessions WHERE connection_subject = ? ORDER BY created_at, external_session_id").all(subject) as unknown as { external_session_id: string }[];
    const items: PendingHumanEventView[] = [];
    for (const session of sessions) {
      const events = this.#store.prepare("SELECT external_session_id, host_session_id, event_ref, role_id, capabilities_json, inherit, expires_at, recorded_at FROM human_authorization_events WHERE external_session_id = ? ORDER BY recorded_at, event_ref").all(session.external_session_id) as unknown as { external_session_id: string; host_session_id: string; event_ref: string; role_id: string; capabilities_json: string; inherit: string; expires_at: string; recorded_at: string }[];
      for (const entry of events) {
        const sourceKey = JSON.stringify([session.external_session_id, "human-event", entry.event_ref]);
        const prior = this.#store.prepare("SELECT record_json, revoked_at FROM role_authorizations WHERE source_key = ?").get(sourceKey) as { record_json: string; revoked_at: string | null } | undefined;
        if (prior) {
          const authorization = JSON.parse(prior.record_json) as RoleAuthorization;
          if (prior.revoked_at === null && Date.parse(authorization.expires_at) > Date.now()) continue;
        }
        items.push({ external_session_id: session.external_session_id, host_session_id: entry.host_session_id, event_ref: entry.event_ref, role_id: entry.role_id, capabilities: JSON.parse(entry.capabilities_json) as string[], inherit: entry.inherit as PendingHumanEventView["inherit"], expires_at: entry.expires_at, recorded_at: entry.recorded_at });
      }
    }
    return { workspace_id: this.workspaceId, observed_at: new Date().toISOString(), items };
  }
  /** G3 (ADR-0014 §9.1): read-only host session discovery; never creates or attaches. */
  async discoverHostSessions(): Promise<HostSessionDiscovery> {
    if (!this.#adapter.listHostSessions) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Adapter does not declare host session discovery.");
    const adapterName = this.#adapter.getCapabilities().adapter;
    const candidates = await this.#adapter.listHostSessions();
    const items = candidates.map(candidate => {
      const registered = this.#store.prepare("SELECT external_session_id FROM external_sessions WHERE adapter = ? AND host_session_id = ?").get(adapterName, candidate.host_session_id) as { external_session_id: string } | undefined;
      return { ...candidate, registered_external_session_id: registered?.external_session_id ?? null };
    });
    return { workspace_id: this.workspaceId, observed_at: new Date().toISOString(), adapter: adapterName, items };
  }
  /** G4 (desktop-gui-contract §2.1/§2.3): shared validation for the owner
   * list views — limit bounds, opaque `created_at|id` cursor, optional
   * external-session filter. Cursors are decoded, never trusted. */
  private listInput(input: unknown): { limit: number; cursor: { created_at: string; id: string } | null; externalSessionId: string | undefined } {
    const data = fields(input, [], ["cursor", "limit", "external_session_id"]);
    const limit = data.limit === undefined ? 50 : data.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new RoleDockError("VALIDATION_FAILED", "limit must be an integer between 1 and 200.");
    if (data.external_session_id !== undefined && (typeof data.external_session_id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(data.external_session_id as string))) throw new RoleDockError("VALIDATION_FAILED", "Invalid external_session_id filter.");
    let cursor: { created_at: string; id: string } | null = null;
    if (data.cursor !== undefined && data.cursor !== null) {
      if (typeof data.cursor !== "string") throw new RoleDockError("VALIDATION_FAILED", "cursor must be a string.");
      try {
        const raw = JSON.parse(Buffer.from(data.cursor, "base64url").toString("utf8")) as { created_at?: unknown; id?: unknown };
        if (typeof raw.created_at !== "string" || typeof raw.id !== "string") throw new Error("bad cursor shape");
        cursor = { created_at: raw.created_at, id: raw.id };
      } catch { throw new RoleDockError("VALIDATION_FAILED", "cursor is not a valid page key."); }
    }
    return { limit: limit as number, cursor, externalSessionId: data.external_session_id as string | undefined };
  }
  private pageKey(value: { created_at: string; id: string }): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }
  /** G4 owner read view of session bindings: generation, predecessor, source
   * authorization, effective capabilities, checkpoint reference and state
   * timestamps. Projection only — the superseded display comparison never
   * writes; connection availability lives on the external session, never in
   * this state. */
  listBindings(input: unknown): SessionBindingsPage {
    const { limit, cursor, externalSessionId } = this.listInput(input);
    sweepAuthorizations(this.#store);
    let rows = this.#store.prepare(`SELECT b.external_session_id, b.session_id, b.instance_id, b.role_id, b.generation,
        b.authorization_id, b.state, b.created_at, b.state_changed_at, e.host_session_id, i.predecessor_instance_id
      FROM session_bindings b JOIN external_sessions e ON e.external_session_id = b.external_session_id
      JOIN agent_instances i ON i.id = b.instance_id
      ORDER BY b.created_at, b.external_session_id`).all() as {
      external_session_id: string; session_id: string; instance_id: string; role_id: string; generation: number;
      authorization_id: string; state: SessionBinding["state"]; created_at: string; state_changed_at: string | null;
      host_session_id: string; predecessor_instance_id: string | null;
    }[];
    if (externalSessionId !== undefined) rows = rows.filter(row => row.external_session_id === externalSessionId);
    if (cursor) rows = rows.filter(row => row.created_at > cursor!.created_at || (row.created_at === cursor!.created_at && row.external_session_id > cursor!.id));
    const page = rows.slice(0, limit);
    const items = page.map(row => this.bindingView(row));
    const last = page.at(-1);
    return { workspace_id: this.workspaceId, observed_at: new Date().toISOString(), items, next_cursor: last && rows.length > page.length ? this.pageKey({ created_at: last.created_at, id: last.external_session_id }) : null };
  }
  private bindingView(row: {
    external_session_id: string; session_id: string; instance_id: string; role_id: string; generation: number;
    authorization_id: string; state: SessionBinding["state"]; created_at: string; state_changed_at: string | null;
    host_session_id: string; predecessor_instance_id: string | null;
  }): SessionBindingView {
    const auth = authorizationRecord(this.#store, row.authorization_id);
    const head = getHead(this.#store, row.role_id);
    const effectiveState: SessionBinding["state"] = row.state === "active" && head?.current_instance_id !== row.instance_id ? "superseded" : row.state;
    let capabilities: string[] = [];
    let checkpointId: string | null = null;
    if (["active", "superseded"].includes(row.state)) {
      const loaded = this.#store.prepare("SELECT capability_scope_json, bootstrap_payload FROM sessions WHERE id = ?").get(row.session_id) as { capability_scope_json: string; bootstrap_payload: string | null } | undefined;
      const scope = loaded ? JSON.parse(loaded.capability_scope_json) as string[] : [];
      const allowed = this.#store.getConfig().policy.grants[row.role_id] ?? [];
      capabilities = scope.filter(cap => allowed.includes(cap) && auth.capabilities.includes(cap));
      try {
        const material = loaded?.bootstrap_payload ? JSON.parse(loaded.bootstrap_payload) as { materials?: { checkpoint?: { checkpoint_id?: unknown } | null } } : null;
        checkpointId = typeof material?.materials?.checkpoint?.checkpoint_id === "string" ? material!.materials!.checkpoint!.checkpoint_id as string : null;
      } catch { checkpointId = null; }
    }
    const activating = this.#store.prepare("SELECT source_knowledge_revision FROM anchor_attempts WHERE authorization_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1").get(row.authorization_id) as { source_knowledge_revision: number } | undefined;
    return {
      external_session_id: row.external_session_id, host_session_id: row.host_session_id, session_id: row.session_id,
      instance_id: row.instance_id, predecessor_instance_id: row.predecessor_instance_id, role_id: row.role_id,
      generation: row.generation, state: row.state, effective_state: effectiveState, capabilities,
      authorization: { authorization_id: auth.authorization_id, revoked_at: auth.revoked_at, expires_at: auth.expires_at, source: auth.source, source_knowledge_revision: activating?.source_knowledge_revision ?? null },
      checkpoint_id: checkpointId, created_at: row.created_at, state_changed_at: row.state_changed_at,
    };
  }
  /** G4 owner read view of anchor attempts: state, the four load-confirmation
   * judges, failure reason at the error-message layer. Projection only. */
  listAttempts(input: unknown): AnchorAttemptsPage {
    const { limit, cursor, externalSessionId } = this.listInput(input);
    let rows = this.#store.prepare(`SELECT a.attempt_id, a.external_session_id, a.authorization_id, a.bundle_hash, a.load_key,
        a.source_generation, a.source_knowledge_revision, a.state, a.confirmation_json, a.error_json, a.created_at, e.host_session_id
      FROM anchor_attempts a JOIN external_sessions e ON e.external_session_id = a.external_session_id
      ORDER BY a.created_at, a.attempt_id`).all() as {
      attempt_id: string; external_session_id: string; authorization_id: string; bundle_hash: string; load_key: string;
      source_generation: number; source_knowledge_revision: number; state: AnchorAttempt["state"];
      confirmation_json: string | null; error_json: string | null; created_at: string; host_session_id: string;
    }[];
    if (externalSessionId !== undefined) rows = rows.filter(row => row.external_session_id === externalSessionId);
    if (cursor) rows = rows.filter(row => row.created_at > cursor!.created_at || (row.created_at === cursor!.created_at && row.attempt_id > cursor!.id));
    const page = rows.slice(0, limit);
    const items: AnchorAttemptView[] = page.map(row => ({
      attempt_id: row.attempt_id, external_session_id: row.external_session_id, host_session_id: row.host_session_id,
      authorization_id: row.authorization_id, state: row.state, source_generation: row.source_generation,
      source_knowledge_revision: row.source_knowledge_revision, bundle_hash: row.bundle_hash, load_key: row.load_key,
      confirmation: row.confirmation_json ? JSON.parse(row.confirmation_json) as AnchorConfirmation : null,
      error: row.error_json ? JSON.parse(row.error_json) as { code: string; message: string } : null,
      created_at: row.created_at,
    }));
    const last = page.at(-1);
    return { workspace_id: this.workspaceId, observed_at: new Date().toISOString(), items, next_cursor: last && rows.length > page.length ? this.pageKey({ created_at: last.created_at, id: last.attempt_id }) : null };
  }
  /** G4 owner read view of material loads: load_key, material version and
   * confirmation time. Confirmation facts come from the stored host
   * confirmation; confirmed_at stays null for rows written before the column
   * existed. Projection only. */
  listLoads(input: unknown): AnchorLoadsPage {
    const { limit, cursor, externalSessionId } = this.listInput(input);
    let rows = this.#store.prepare(`SELECT l.load_key, l.attempt_id, l.bundle_hash, l.prepared_at, l.confirmed_at, l.confirmation_json, a.external_session_id
      FROM anchor_loads l JOIN anchor_attempts a ON a.attempt_id = l.attempt_id
      ORDER BY l.prepared_at, l.load_key`).all() as {
      load_key: string; attempt_id: string; bundle_hash: string; prepared_at: string;
      confirmed_at: string | null; confirmation_json: string | null; external_session_id: string;
    }[];
    if (externalSessionId !== undefined) rows = rows.filter(row => row.external_session_id === externalSessionId);
    if (cursor) rows = rows.filter(row => row.prepared_at > cursor!.created_at || (row.prepared_at === cursor!.created_at && row.load_key > cursor!.id));
    const page = rows.slice(0, limit);
    const items: AnchorLoadView[] = page.map(row => {
      const confirmation = row.confirmation_json ? JSON.parse(row.confirmation_json) as AnchorConfirmation : null;
      return {
        load_key: row.load_key, attempt_id: row.attempt_id, external_session_id: row.external_session_id,
        bundle_hash: row.bundle_hash, load_version: typeof confirmation?.load_version === "number" ? confirmation.load_version : null,
        prepared_at: row.prepared_at, confirmed_at: row.confirmed_at,
      };
    });
    const last = page.at(-1);
    return { workspace_id: this.workspaceId, observed_at: new Date().toISOString(), items, next_cursor: last && rows.length > page.length ? this.pageKey({ created_at: last.prepared_at, id: last.load_key }) : null };
  }
  /** G4 read-only impact preview for revoke: what would stop working right
   * now. The revoke stays the separate explicit owner write; the preview
   * never mutates (the sweep keeps expiry honest, as in the other owner
   * read views). Withdrawn-request semantics mirror invalidateBinding. */
  revokePreview(input: unknown): RevokePreview {
    const data = fields(input, ["authorization_id"]);
    const auth = authorizationRecord(this.#store, str(data, "authorization_id"));
    const external = this.externalSession(auth.external_session_id);
    sweepAuthorizations(this.#store);
    const bindings = (this.#store.prepare("SELECT external_session_id, session_id, role_id, generation, state FROM session_bindings WHERE authorization_id = ? AND state IN ('active','superseded')").all(auth.authorization_id) as {
      external_session_id: string; session_id: string; role_id: string; generation: number; state: SessionBinding["state"];
    }[]).map(row => ({ ...row }));
    const requests = (this.#store.prepare(`SELECT request_id, state, execution_uncertain, cleanup_pending, target_role_id, question FROM requests
      WHERE (initiating_authorization_id = ? OR target_authorization_id = ?) AND state NOT IN ('completed','failed','cancelled','expired')
      ORDER BY created_at, request_id`).all(auth.authorization_id, auth.authorization_id) as {
      request_id: string; state: CollaborationRequestState; execution_uncertain: number; cleanup_pending: number; target_role_id: string; question: string;
    }[]).map(row => ({
      request_id: row.request_id, state: row.state, execution_uncertain: row.execution_uncertain === 1,
      cleanup_pending: row.cleanup_pending === 1, target_role_id: row.target_role_id, question: row.question,
    }));
    return {
      workspace_id: this.workspaceId, observed_at: new Date().toISOString(),
      authorization: {
        authorization_id: auth.authorization_id, role_id: auth.role_id, external_session_id: auth.external_session_id,
        host_session_id: external.host_session_id, created_at: auth.created_at, expires_at: auth.expires_at, revoked_at: auth.revoked_at,
      },
      bindings, requests,
    };
  }
  externalSession(id: string): ExternalSession {
    const row = this.#store.prepare("SELECT * FROM external_sessions WHERE external_session_id = ?").get(id) as (Omit<ExternalSession, "capability_ceiling"> & { capability_ceiling_json: string }) | undefined;
    if (!row) throw new RoleDockError("PERMISSION_DENIED", "External session is unavailable.");
    const { capability_ceiling_json, ...data } = row;
    return checked("external-session", { ...data, capability_ceiling: JSON.parse(capability_ceiling_json) });
  }
  async register(input: unknown): Promise<ExternalSession> {
    checked("external-registration", input);
    const data = fields(input, ["host_session_id", "connection_subject", "capability_ceiling"]);
    const host = str(data, "host_session_id"), subject = str(data, "connection_subject"), ceiling = capabilities(data.capability_ceiling);
    const adapter = this.#adapter.getCapabilities();
    if (!adapter.external?.current_session_identity || !this.#adapter.verifyExternalSession) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Host cannot prove current external session identity.");
    if (!await this.#adapter.verifyExternalSession(host, subject)) throw new RoleDockError("PERMISSION_DENIED", "Unverified external session identity.");
    return this.#store.tx(() => {
      const existing = this.#store.prepare("SELECT external_session_id FROM external_sessions WHERE adapter = ? AND host_session_id = ?").get(adapter.adapter, host) as { external_session_id: string } | undefined;
      if (existing) {
        const prior = this.externalSession(existing.external_session_id);
        if (prior.connection_subject !== subject || JSON.stringify(prior.capability_ceiling) !== JSON.stringify(ceiling)) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "External session already registered with different connection or ceiling.");
        return prior;
      }
      const value = checked<ExternalSession>("external-session", { external_session_id: newId("ext"), workspace_id: this.workspaceId, adapter: adapter.adapter, host_session_id: host, connection_subject: subject, capability_ceiling: ceiling, state: "connected", created_at: new Date().toISOString() });
      this.#store.prepare("INSERT INTO external_sessions (external_session_id, workspace_id, adapter, host_session_id, connection_subject, capability_ceiling_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(value.external_session_id, value.workspace_id, value.adapter, host, subject, JSON.stringify(ceiling), value.state, value.created_at);
      return value;
    });
  }
  /** No raw text is accepted: the adapter verifies the original event reference. */
  async recordHumanAuthorization(input: unknown, connectionCeiling?: readonly string[]): Promise<RoleAuthorization> {
    checked("service-control-operation", { operation: "authorizations.recordHuman", input });
    const data = fields(input, ["external_session_id", "event_ref"]);
    const external = this.externalSession(str(data, "external_session_id"));
    if (!this.#adapter.getCapabilities().external?.human_authorization_events || !this.#adapter.readHumanAuthorization) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Host cannot attest human authorization events.");
    const event = await this.#adapter.readHumanAuthorization(external.host_session_id, str(data, "event_ref"));
    if (!event || event.host_session_id !== external.host_session_id || event.connection_subject !== external.connection_subject || event.workspace_id !== this.workspaceId || event.event_ref !== data.event_ref) throw new RoleDockError("PERMISSION_DENIED", "Event is not an applicable trusted human authorization.");
    if (connectionCeiling && capabilities(event.capabilities).some(cap => !connectionCeiling.includes(cap))) throw new RoleDockError("PERMISSION_DENIED", "Human event exceeds this trusted connection's owner ceiling.");
    return this.record(external, event, "human-event");
  }
  /**
   * B2 (ADR-0011): owner-face trusted writer for verbatim human confirmation
   * records (CLI console now, GUI confirm later). The event must match the
   * registered external session's identity; storage alone grants nothing —
   * recordHumanAuthorization still validates through the adapter port.
   * Idempotent on (workspace, external session, event_ref): same content
   * returns the stored record, changed content is a conflict.
   */
  submitHumanEvent(input: unknown): HumanAuthorizationEventRecord {
    checked("service-control-operation", { operation: "authorizations.submitHumanEvent", input });
    const data = fields(input, ["external_session_id", "host_session_id", "connection_subject", "event_ref", "actor_id", "role_id", "capabilities", "inherit", "expires_at", "entry", "recorded_at"]);
    const external = this.externalSession(str(data, "external_session_id"));
    if (external.host_session_id !== str(data, "host_session_id") || external.connection_subject !== str(data, "connection_subject")) {
      throw new RoleDockError("VALIDATION_FAILED", "Event does not match the registered external session identity.");
    }
    const value = checked<HumanAuthorizationEventRecord>("human-authorization-event", {
      workspace_id: this.workspaceId, host_session_id: external.host_session_id, connection_subject: external.connection_subject,
      event_ref: str(data, "event_ref"), actor_id: str(data, "actor_id"), role_id: str(data, "role_id"),
      capabilities: capabilities(data.capabilities), inherit: data.inherit, expires_at: str(data, "expires_at"),
      entry: data.entry, recorded_at: str(data, "recorded_at"),
    });
    // Idempotency covers the event facts only; entry/recorded_at are first-write
    // provenance, so a resubmission from any trusted entry replays the original.
    const hash = bodyHash(JSON.stringify({ workspace_id: value.workspace_id, host_session_id: value.host_session_id,
      connection_subject: value.connection_subject, event_ref: value.event_ref, actor_id: value.actor_id,
      role_id: value.role_id, capabilities: value.capabilities, inherit: value.inherit, expires_at: value.expires_at }));
    return this.#store.tx(() => {
      const prior = this.#store.prepare("SELECT input_hash FROM human_authorization_events WHERE workspace_id = ? AND external_session_id = ? AND event_ref = ?")
        .get(this.workspaceId, external.external_session_id, value.event_ref) as { input_hash: string } | undefined;
      if (prior) {
        if (prior.input_hash !== hash) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Human event reference has changed content.");
        return this.humanEvent(external.external_session_id, value.event_ref);
      }
      this.#store.prepare("INSERT INTO human_authorization_events (workspace_id, external_session_id, host_session_id, connection_subject, event_ref, actor_id, role_id, capabilities_json, inherit, expires_at, entry, recorded_at, input_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(value.workspace_id, external.external_session_id, value.host_session_id, value.connection_subject, value.event_ref, value.actor_id, value.role_id, JSON.stringify(value.capabilities), value.inherit, value.expires_at, value.entry, value.recorded_at, hash);
      return value;
    });
  }
  private humanEvent(externalSessionId: string, eventRef: string): HumanAuthorizationEventRecord {
    const row = this.#store.prepare("SELECT * FROM human_authorization_events WHERE workspace_id = ? AND external_session_id = ? AND event_ref = ?")
      .get(this.workspaceId, externalSessionId, eventRef) as EventRow | undefined;
    if (!row) throw new RoleDockError("NOT_FOUND", "Human authorization event is not stored.");
    return eventRecord(row);
  }
  /** Explicit owner selection is a documented fallback, not human-event proof. */
  recordOwnerAuthorization(input: unknown): RoleAuthorization {
    checked("service-control-operation", { operation: "authorizations.recordOwner", input });
    const data = fields(input, ["external_session_id", "event_ref", "actor_id", "role_id", "capabilities", "inherit", "expires_at"]);
    const external = this.externalSession(str(data, "external_session_id"));
    return this.record(external, { workspace_id: this.workspaceId, host_session_id: external.host_session_id, connection_subject: external.connection_subject, event_ref: str(data, "event_ref"), actor_id: str(data, "actor_id"), role_id: str(data, "role_id"), capabilities: capabilities(data.capabilities), inherit: data.inherit as HumanAuthorizationEvent["inherit"], expires_at: str(data, "expires_at") }, "owner-selection");
  }
  private record(external: ExternalSession, event: HumanAuthorizationEvent, kind: "human-event" | "owner-selection"): RoleAuthorization {
    const caps = capabilities(event.capabilities);
    if (caps.some(cap => !external.capability_ceiling.includes(cap))) throw new RoleDockError("PERMISSION_DENIED", "Authorization exceeds this connection's owner ceiling.");
    const hash = bodyHash(JSON.stringify({ workspace_id: event.workspace_id, host_session_id: event.host_session_id,
      connection_subject: event.connection_subject, event_ref: event.event_ref, actor_id: event.actor_id,
      role_id: event.role_id, capabilities: caps, inherit: event.inherit, expires_at: event.expires_at }));
    const sourceKey = JSON.stringify([external.external_session_id, kind, event.event_ref]);
    return this.#store.tx(() => {
      const prior = this.#store.prepare("SELECT authorization_id, input_hash FROM role_authorizations WHERE source_key = ?").get(sourceKey) as { authorization_id: string; input_hash: string } | undefined;
      if (prior) {
        if (prior.input_hash !== hash) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Authorization event reference has changed content.");
        return authorizationRecord(this.#store, prior.authorization_id);
      }
      const role = getRoleRow(this.#store, event.role_id);
      if (!role) throw new RoleDockError("NOT_FOUND", "Authorized role is not installed; resolve or install it first.");
      const pack = getPack(this.#store, role.pack_name, role.pack_version)!;
      const head = getHead(this.#store, event.role_id)!;
      if (head.generation > 0 && event.inherit !== "takeover") throw new RoleDockError("PERMISSION_DENIED", "Existing role knowledge requires explicit takeover intent.");
      if (!Number.isFinite(Date.parse(event.expires_at)) || Date.parse(event.expires_at) <= Date.now()) throw new RoleDockError("PERMISSION_DENIED", "Authorization must expire in the future.");
      const auth = checked<RoleAuthorization>("role-authorization", { authorization_id: newId("auth"), workspace_id: this.workspaceId, external_session_id: external.external_session_id, connection_subject: external.connection_subject, role_id: event.role_id, role_contract: { package_name: pack.name, package_version: pack.version, content_hash: pack.content_hash }, capabilities: caps, inherit: event.inherit, expected_generation: head.generation, expected_instance_id: head.current_instance_id, expires_at: event.expires_at, revoked_at: null, source: { kind, event_ref: event.event_ref, actor_id: event.actor_id }, created_at: new Date().toISOString() });
      this.#store.prepare("INSERT INTO role_authorizations (authorization_id, external_session_id, role_id, record_json, source_key, input_hash) VALUES (?, ?, ?, ?, ?, ?)").run(auth.authorization_id, external.external_session_id, auth.role_id, JSON.stringify(auth), sourceKey, hash);
      return auth;
    });
  }
  async revoke(input: unknown): Promise<RoleAuthorization> {
    checked("service-control-operation", { operation: "authorizations.revoke", input });
    const data = fields(input, ["authorization_id"]), id = str(data, "authorization_id");
    const auth = authorizationRecord(this.#store, id);
    this.#store.tx(() => {
      this.#store.prepare("UPDATE role_authorizations SET revoked_at = COALESCE(revoked_at, ?) WHERE authorization_id = ?").run(new Date().toISOString(), id);
      const binding = this.#store.prepare("SELECT external_session_id FROM session_bindings WHERE authorization_id = ?").get(id) as { external_session_id: string } | undefined;
      if (binding) invalidateBinding(this.#store, binding.external_session_id, "revoked");
    });
    await this.cleanupWithdrawnTasks();
    return authorizationRecord(this.#store, auth.authorization_id);
  }
  /** Called only after the service has authenticated a trusted host channel. */
  connect(externalId: string, subject: string): SessionConnection {
    const external = this.externalSession(externalId);
    if (external.connection_subject !== subject || external.state !== "connected") throw new RoleDockError("PERMISSION_DENIED", "Connection subject mismatch.");
    return new SessionConnection((operation, input) => this.sessionCall(externalId, operation, input));
  }
  private applicableAuthorization(externalId: string, id: string): RoleAuthorization {
    const auth = assertLiveAuthorization(this.#store, id);
    const external = this.externalSession(externalId);
    if (auth.external_session_id !== externalId || auth.connection_subject !== external.connection_subject || auth.workspace_id !== this.workspaceId) throw new RoleDockError("PERMISSION_DENIED", "Authorization belongs to a different connection.");
    const material = roleMaterial(this.#store, auth.role_id);
    if (material.content_hash !== auth.role_contract.content_hash || material.package_version !== auth.role_contract.package_version || material.package_name !== auth.role_contract.package_name) throw new RoleDockError("PERMISSION_DENIED", "Authorized role contract has changed.");
    return auth;
  }
  private binding(externalId: string): SessionBinding | null {
    sweepAuthorizations(this.#store);
    const row = this.#store.prepare("SELECT * FROM session_bindings WHERE external_session_id = ?").get(externalId) as (Omit<SessionBinding, "capabilities" | "source"> & { state_changed_at?: string | null }) | undefined;
    if (!row) return null;
    if (row.state === "active" && getHead(this.#store, row.role_id)?.current_instance_id !== row.instance_id) {
      this.#store.prepare("UPDATE session_bindings SET state = 'superseded', state_changed_at = ? WHERE external_session_id = ? AND state = 'active'").run(new Date().toISOString(), externalId);
      row.state = "superseded";
    }
    // state_changed_at is owner-observability only (G4); the session-face DTO predates it.
    const { state_changed_at: _stateChangedAt, ...wire } = row;
    const auth = authorizationRecord(this.#store, row.authorization_id);
    const loaded = this.#store.prepare("SELECT capability_scope_json FROM sessions WHERE id = ?").get(row.session_id) as { capability_scope_json: string };
    const scope = JSON.parse(loaded.capability_scope_json) as string[];
    const allowed = this.#store.getConfig().policy.grants[row.role_id] ?? [];
    return checked("session-binding", { ...wire, source: auth.source, capabilities: ["active", "superseded"].includes(row.state) ? scope.filter(cap => allowed.includes(cap) && auth.capabilities.includes(cap)) : [] });
  }
  private attempt(id: string, externalId: string): AnchorAttempt {
    const row = this.#store.prepare("SELECT * FROM anchor_attempts WHERE attempt_id = ? AND external_session_id = ?").get(id, externalId) as AttemptRow | undefined;
    if (!row) throw new RoleDockError("PERMISSION_DENIED", "Anchor attempt belongs to another connection or does not exist.");
    const { confirmation_json, error_json, ...rest } = row;
    return checked("anchor-attempt", { ...rest, confirmation: confirmation_json ? JSON.parse(confirmation_json) : null, error: error_json ? JSON.parse(error_json) : null });
  }
  private prepare(externalId: string, auth: RoleAuthorization): { hash: string; loadKey: string; generation: number; revision: number } {
    const head = getHead(this.#store, auth.role_id)!;
    if (head.generation !== auth.expected_generation || head.current_instance_id !== auth.expected_instance_id) throw new RoleDockError("GENERATION_CONFLICT", "Authorization's primary baseline moved; obtain a new explicit takeover authorization.");
    const grants = this.#store.getConfig().policy.grants[auth.role_id] ?? [];
    const scope = auth.capabilities.filter(cap => grants.includes(cap));
    if (!scope.includes("documents.read")) throw new RoleDockError("PERMISSION_DENIED", "Role knowledge load requires authorized documents.read.");
    const entries = this.#store.prepare(`SELECT d.document_key, d.latest_revision AS revision, dr.content_hash FROM documents d JOIN document_revisions dr
      ON dr.role_id = d.role_id AND dr.document_key = d.document_key AND dr.revision = d.latest_revision WHERE d.role_id = ? ORDER BY d.document_key`).all(auth.role_id) as unknown as { document_key: string; revision: number; content_hash: string }[];
    const documents = documentMaterial(this.#store, auth.role_id, entries, false);
    const prior = getLatestCheckpoint(this.#store, auth.role_id);
    const priorShared = prior ? documentMaterial(this.#store, auth.role_id, prior.document_snapshots, false) : [];
    const checkpoint = prior ? { ...prior, document_snapshots: prior.document_snapshots.filter(entry => priorShared.some(doc => doc.document_key === entry.document_key && doc.revision === entry.revision)) } : null;
    const payload = JSON.stringify(checked("anchor-material", { protocol_version: "0.1", workspace_id: this.workspaceId, role_id: auth.role_id, source_generation: head.generation, source_knowledge_revision: head.knowledge_revision, capability_scope: scope,
      materials: { role: roleMaterial(this.#store, auth.role_id), documents, checkpoint } }));
    return { hash: putObject(this.#store, payload), loadKey: newId("load"), generation: head.generation, revision: head.knowledge_revision };
  }
  private result(id: string, externalId: string): AnchorResult { return { attempt: this.attempt(id, externalId), binding: this.binding(externalId) }; }
  private async drive(id: string, externalId: string): Promise<AnchorResult> {
    let attempt = this.attempt(id, externalId);
    if (attempt.state === "active" || attempt.state === "failed") return this.result(id, externalId);
    try {
      for (let retry = 0; retry < 3; retry++) {
        const auth = this.applicableAuthorization(externalId, attempt.authorization_id);
        const external = this.externalSession(externalId);
        const caps = this.#adapter.getCapabilities().external;
        if (!caps?.load_materials || !this.#adapter.loadExternalMaterials) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Adapter cannot load materials into the existing external session.");
        let confirmation: AnchorConfirmation | undefined;
        if (attempt.state !== "prepared") {
          if (!caps.reconcile_load || !this.#adapter.lookupExternalLoad) {
            this.#store.prepare("UPDATE anchor_attempts SET state = 'uncertain' WHERE attempt_id = ?").run(id);
            return this.result(id, externalId);
          }
          const lookup = await this.#adapter.lookupExternalLoad(external.host_session_id, attempt.load_key);
          if (this.attempt(id, externalId).state === "failed") return this.result(id, externalId);
          this.applicableAuthorization(externalId, auth.authorization_id);
          if (lookup.state === "unknown") {
            this.#store.prepare("UPDATE anchor_attempts SET state = 'uncertain' WHERE attempt_id = ?").run(id);
            return this.result(id, externalId);
          }
          if (lookup.state === "loaded") confirmation = lookup.confirmation;
        }
        if (!confirmation) {
          const payload = readObject(this.#store, attempt.bundle_hash);
          if (bodyHash(payload) !== attempt.bundle_hash) throw new RoleDockError("VALIDATION_FAILED", "Persisted anchor material hash mismatch.");
          const material = JSON.parse(payload) as { capability_scope: string[] };
          this.applicableAuthorization(externalId, auth.authorization_id);
          this.#store.prepare("UPDATE anchor_attempts SET state = 'loading' WHERE attempt_id = ?").run(id);
          confirmation = await this.#adapter.loadExternalMaterials({ host_session_id: external.host_session_id, connection_subject: external.connection_subject, load_key: attempt.load_key,
            bootstrap: { bundle_id: id, role_id: auth.role_id, content_hash: attempt.bundle_hash, payload }, capability_scope: material.capability_scope });
        }
        if (this.attempt(id, externalId).state === "failed") return this.result(id, externalId);
        if (confirmation.host_session_id !== external.host_session_id || confirmation.load_key !== attempt.load_key || confirmation.content_hash !== attempt.bundle_hash || !Number.isInteger(confirmation.load_version) || confirmation.load_version < 1) throw new RoleDockError("VALIDATION_FAILED", "Host load confirmation does not match session, key, hash and version.");
        this.#store.prepare("UPDATE anchor_loads SET confirmation_json = ?, confirmed_at = ? WHERE load_key = ?").run(JSON.stringify(confirmation), new Date().toISOString(), attempt.load_key);
        this.#store.prepare("UPDATE anchor_attempts SET confirmation_json = ? WHERE attempt_id = ?").run(JSON.stringify(confirmation), id);
        const head = getHead(this.#store, auth.role_id)!;
        this.applicableAuthorization(externalId, auth.authorization_id);
        if (head.generation !== auth.expected_generation || head.current_instance_id !== auth.expected_instance_id) throw new RoleDockError("GENERATION_CONFLICT", "Another successor moved the authorized primary baseline.");
        if (head.knowledge_revision !== attempt.source_knowledge_revision) {
          if (retry === 2) throw new RoleDockError("REVISION_CONFLICT", "Knowledge keeps changing; retry with a new anchor key.");
          const prep = this.prepare(externalId, auth);
          const changed = this.#store.tx(() => {
            const changed = this.#store.prepare("UPDATE anchor_attempts SET state = 'prepared', bundle_hash = ?, load_key = ?, source_knowledge_revision = ?, confirmation_json = NULL WHERE attempt_id = ? AND state IN ('loading','uncertain','prepared')").run(prep.hash, prep.loadKey, prep.revision, id);
            if (changed.changes === 1) this.#store.prepare("INSERT INTO anchor_loads (load_key, attempt_id, bundle_hash, prepared_at) VALUES (?, ?, ?, ?)").run(prep.loadKey, id, prep.hash, new Date().toISOString());
            return changed;
          });
          if (changed.changes !== 1) return this.result(id, externalId);
          attempt = this.attempt(id, externalId);
          continue;
        }
        this.#store.tx(() => {
          if (this.attempt(id, externalId).state === "failed") throw new RoleDockError("INVALID_STATE_TRANSITION", "Anchor was released while materials were loading.");
          this.applicableAuthorization(externalId, auth.authorization_id);
          const current = getHead(this.#store, auth.role_id)!;
          if (current.generation !== auth.expected_generation || current.current_instance_id !== auth.expected_instance_id) throw new RoleDockError("GENERATION_CONFLICT", "Primary changed before activation.");
          if (current.knowledge_revision !== attempt.source_knowledge_revision) throw new RoleDockError("REVISION_CONFLICT", "Knowledge changed before activation.");
          if (this.#store.prepare("SELECT 1 FROM session_bindings WHERE external_session_id = ?").get(externalId)) throw new RoleDockError("INVALID_STATE_TRANSITION", "External session has already been bound.");
          const payload = readObject(this.#store, attempt.bundle_hash);
          const scope = (JSON.parse(payload) as { capability_scope: string[] }).capability_scope;
          if (scope.some(cap => !(this.#store.getConfig().policy.grants[auth.role_id] ?? []).includes(cap))) throw new RoleDockError("PERMISSION_DENIED", "Workspace policy narrowed during load.");
          const sessionId = newId("sess"), instanceId = newId("inst"), now = new Date().toISOString(), generation = current.generation + 1;
          if (current.current_instance_id) {
            this.#store.prepare("UPDATE agent_instances SET state = 'superseded' WHERE id = ?").run(current.current_instance_id);
            this.#store.prepare("UPDATE session_bindings SET state = 'superseded', state_changed_at = ? WHERE instance_id = ? AND state = 'active'").run(now, current.current_instance_id);
          }
          this.#store.prepare("INSERT INTO agent_instances (id, role_id, generation, predecessor_instance_id, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(instanceId, auth.role_id, generation, current.current_instance_id, now);
          this.#store.prepare("INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, host_session_ref, created_at, capability_scope_json, bootstrap_payload) VALUES (?, 'primary', ?, 'active', ?, ?, ?, ?, ?, ?)").run(sessionId, external.adapter, auth.role_id, instanceId, external.host_session_id, now, JSON.stringify(scope), payload);
          this.#store.prepare("INSERT INTO session_bindings (external_session_id, session_id, instance_id, role_id, generation, authorization_id, state, created_at, state_changed_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)").run(externalId, sessionId, instanceId, auth.role_id, generation, auth.authorization_id, now, now);
          const changed = this.#store.prepare("UPDATE role_heads SET current_instance_id = ?, generation = ?, updated_at = ? WHERE role_id = ? AND generation = ? AND knowledge_revision = ? AND current_instance_id IS ?").run(instanceId, generation, now, auth.role_id, current.generation, attempt.source_knowledge_revision, current.current_instance_id);
          if (changed.changes !== 1) throw new RoleDockError("GENERATION_CONFLICT", "Anchor CAS did not activate.");
          this.#store.prepare("UPDATE anchor_attempts SET state = 'active', error_json = NULL WHERE attempt_id = ?").run(id);
        });
        return this.result(id, externalId);
      }
      throw new RoleDockError("INTERNAL", "Anchor retry exhausted.");
    } catch (error) {
      if (this.attempt(id, externalId).state === "failed") return this.result(id, externalId);
      const code = error instanceof RoleDockError ? error.code : "INTERNAL";
      const declaredUncertain = error instanceof RoleDockError && error.details?.uncertain === true;
      const uncertain = (code === "INTERNAL" || declaredUncertain) && ["loading", "uncertain"].includes(this.attempt(id, externalId).state);
      this.#store.prepare("UPDATE anchor_attempts SET state = ?, error_json = ? WHERE attempt_id = ?").run(uncertain ? "uncertain" : "failed", JSON.stringify({ code, message: error instanceof Error ? error.message : "Anchor failed." }), id);
      return this.result(id, externalId);
    }
  }
  private async coalesce(id: string, externalId: string): Promise<AnchorResult> {
    const pending = this.#inFlight.get(id);
    if (pending) return pending;
    const promise = this.drive(id, externalId); this.#inFlight.set(id, promise);
    try { return await promise; } finally { this.#inFlight.delete(id); }
  }
  private async sessionCall(externalId: string, operation: string, input: unknown): Promise<unknown> {
    this.externalSession(externalId);
    if (["sessions.anchor", "sessions.binding", "sessions.reconcile", "sessions.release", "authorizations.get"].includes(operation)) {
      checked("session-operation", { operation, input });
      const data = input as Record<string, string>;
      if (operation === "authorizations.get") {
        const rows = this.#store.prepare("SELECT authorization_id FROM role_authorizations WHERE external_session_id = ?").all(externalId) as unknown as { authorization_id: string }[];
        return { authorizations: rows.map(row => authorizationRecord(this.#store, row.authorization_id)).filter(auth => !auth.revoked_at && Date.parse(auth.expires_at) > Date.now()) };
      }
      if (operation === "sessions.binding") return { binding: this.binding(externalId) };
      if (operation === "sessions.release") {
        this.#store.tx(() => {
          invalidateBinding(this.#store, externalId, "released");
          this.#store.prepare("UPDATE anchor_attempts SET state = 'failed', error_json = ? WHERE external_session_id = ? AND state IN ('prepared','loading','uncertain')")
            .run(JSON.stringify({ code: "INVALID_STATE_TRANSITION", message: "Pending anchor released." }), externalId);
        });
        await this.cleanupWithdrawnTasks(); return { binding: this.binding(externalId) };
      }
      if (operation === "sessions.reconcile") {
        this.attempt(data.attempt_id!, externalId); return this.coalesce(data.attempt_id!, externalId);
      }
      const authId = data.authorization_id!, key = data.idempotency_key!, hash = bodyHash(JSON.stringify({ authorization_id: authId }));
      const prior = this.#store.prepare("SELECT attempt_id, input_hash FROM anchor_attempts WHERE external_session_id = ? AND idempotency_key = ?").get(externalId, key) as { attempt_id: string; input_hash: string } | undefined;
      if (prior) {
        if (prior.input_hash !== hash) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Anchor key has different input.");
        return this.coalesce(prior.attempt_id, externalId);
      }
      const auth = this.applicableAuthorization(externalId, authId);
      if (this.#store.prepare("SELECT 1 FROM session_bindings WHERE external_session_id = ?").get(externalId)) throw new RoleDockError("INVALID_STATE_TRANSITION", "This external conversation already has a binding history; use a new conversation.");
      if (this.#store.prepare("SELECT 1 FROM anchor_attempts WHERE external_session_id = ? AND state IN ('prepared','loading','uncertain')").get(externalId)) throw new RoleDockError("INVALID_STATE_TRANSITION", "Reconcile the existing pending attempt first.");
      const prep = this.prepare(externalId, auth), id = newId("anchor");
      this.#store.tx(() => {
        const now = new Date().toISOString();
        this.#store.prepare("INSERT INTO anchor_attempts (attempt_id, external_session_id, authorization_id, idempotency_key, input_hash, bundle_hash, load_key, source_generation, source_knowledge_revision, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)").run(id, externalId, authId, key, hash, prep.hash, prep.loadKey, prep.generation, prep.revision, now);
        this.#store.prepare("INSERT INTO anchor_loads (load_key, attempt_id, bundle_hash, prepared_at) VALUES (?, ?, ?, ?)").run(prep.loadKey, id, prep.hash, now);
      });
      return this.coalesce(id, externalId);
    }
    const map: Record<string, { method: keyof Coordinator; required: string[]; optional?: string[] }> = {
      "documents.list": { method: "listDocuments", required: [], optional: ["role_id"] },
      "documents.read": { method: "readDocument", required: ["document_key"], optional: ["target_role_id", "revision"] },
      "documents.propose": { method: "proposeDocumentUpdate", required: ["target_role_id", "document_key", "body"], optional: ["note", "baseline_revision"] },
      "documents.publish": { method: "publishDocument", required: ["document_key", "body", "expected_revision", "expected_generation"], optional: ["candidate_id", "adopt_artifact_id"] },
      "requests.create": { method: "createRequest", required: ["target_role_id", "question", "idempotency_key"], optional: ["budget", "read_exception_rationale"] },
      "requests.get": { method: "getRequest", required: ["request_id"] },
      "requests.reply": { method: "replyToRequest", required: ["request_id", "body"] },
      "requests.cancel": { method: "cancelRequest", required: ["request_id"] },
      "artifacts.read": { method: "readArtifact", required: ["artifact_id"] },
    };
    const entry = map[operation];
    if (!entry) throw new RoleDockError("PERMISSION_DENIED", "Operation is not available on ordinary session connections.");
    const data = fields(input, entry.required, entry.optional);
    const binding = this.binding(externalId);
    if (!binding || !["active", "superseded"].includes(binding.state)) throw new RoleDockError("PERMISSION_DENIED", "No effective role binding on this connection.");
    const method = this.#coordinator[entry.method] as (input: unknown) => Promise<unknown>;
    return method.call(this.#coordinator, { ...data, session_id: binding.session_id });
  }
  private async cleanupWithdrawnTasks(): Promise<void> {
    const rows = this.#store.prepare("SELECT request_id FROM requests WHERE cleanup_pending = 1 AND state IN ('completed','failed','cancelled','expired')").all() as unknown as { request_id: string }[];
    await Promise.allSettled(rows.map(row => cancelRunningRequest(this.#store, this.#adapter, row.request_id)));
  }
  /** Synchronous expiry is independent of long-running host execution. */
  expireBindings(): void { sweepAuthorizations(this.#store); }
  /** Independent cleanup worker; ordinary tools never receive this control plane. */
  async maintain(): Promise<void> { await this.cleanupWithdrawnTasks(); }
  /** Trusted service worker; never exposed as a session operation. */
  async tick(): Promise<void> {
    sweepAuthorizations(this.#store);
    const rows = this.#store.prepare("SELECT request_id FROM requests WHERE state IN ('accepted','queued','running')").all() as unknown as { request_id: string }[];
    await Promise.allSettled(rows.map(async row => {
      const result = await executeRequest(this.#store, this.#adapter, row.request_id);
      if (["completed", "failed", "cancelled", "expired"].includes(result.state)) this.#store.prepare("UPDATE outbox_events SET state = ?, completed_at = ? WHERE id = ?").run(result.state === "completed" ? "done" : "failed", new Date().toISOString(), `evt-${row.request_id}`);
    }));
    this.#store.prepare(`UPDATE outbox_events SET state = CASE WHEN
      (SELECT state FROM requests WHERE ('evt-' || request_id) = outbox_events.id) = 'completed' THEN 'done' ELSE 'failed' END,
      completed_at = ? WHERE kind = 'request.execute' AND state = 'pending' AND id IN
      (SELECT 'evt-' || request_id FROM requests WHERE state IN ('completed','failed','cancelled','expired'))`).run(new Date().toISOString());
    const pending = this.#store.prepare("SELECT request_id FROM requests WHERE cleanup_pending = 1").all() as unknown as { request_id: string }[];
    await Promise.allSettled(pending.map(row => cleanupRequest(this.#store, this.#adapter, row.request_id)));
  }
}
/** The only ordinary Agent connection surface; no authority, adapter or store handle. */
export class SessionConnection {
  readonly #invoke: (operation: string, input: unknown) => Promise<unknown>;
  constructor(invoke: (operation: string, input: unknown) => Promise<unknown>) { this.#invoke = invoke; }
  call(operation: SessionOperation | string, input: unknown = {}): Promise<unknown> { return this.#invoke(operation, input); }
}
