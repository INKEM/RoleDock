import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoleDockError } from "@roledock/protocol";
import type { AnchorConfirmation } from "@roledock/protocol";
import type { AdapterCapabilities, AdapterSessionHandle, AdapterSessionResult, CreateSessionInput, ExternalLoadLookup, ExternalMaterialLoad, HarnessAdapter, HostSessionInfo, HumanAuthorizationEvent, HumanAuthorizationSource, TurnInput, TurnResult } from "@roledock/core";
import { loadHeader } from "./reference-connector.js";

export { connectZCodeConnector } from "./connector.js";
// Read-only preflight helpers (P6-G2 desktop shell); pure/no-side-effect.
export { probeSandboxRunner, planEgress } from "./sandbox.js";
export type { SandboxRunnerInfo, EgressPlan } from "./sandbox.js";
export interface ZCodeToolCaller {
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
  /** docs/zcode-connector-tools.md §2: tool names the connector declared at handshake. */
  readonly tools?: ReadonlySet<string>;
}
interface Creation { creation_key: string; host_id: string | null; state: string }
interface Turn { execution_key: string; fingerprint: string; state: string; marker: number; events_json: string; body: string | null; budget_json: string }
interface Event { seq: number; type: string; response?: string }
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoleDockError("VALIDATION_FAILED", "Invalid ZCode connector record.");
  return value as Record<string, unknown>;
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function uncertain(message: string): RoleDockError { return new RoleDockError("INTERNAL", message, { details: { uncertain: true, harness: "zcode" } }); }

/** Diagnostic-only reference integration. It deliberately cannot load a role. */
export class ZCodeAdapter implements HarnessAdapter {
  readonly #tools: ZCodeToolCaller;
  readonly #db: DatabaseSync;
  readonly #workspace: string;
  readonly #creating = new Map<string, Promise<AdapterSessionHandle>>();
  readonly #sending = new Map<string, Promise<TurnResult>>();
  #managed: { egress: readonly string[] } | undefined;
  #managedVerified = false;
  #source: HumanAuthorizationSource | undefined;
  constructor(options: { tools: ZCodeToolCaller; workspacePath: string; stateDir: string; humanAuthorizationSource?: HumanAuthorizationSource; managed?: { egress: readonly string[] } }) {
    if (!isAbsolute(options.workspacePath) || !isAbsolute(options.stateDir)) throw new RoleDockError("VALIDATION_FAILED", "ZCode workspace/state paths must be absolute.");
    this.#tools = options.tools; this.#workspace = options.workspacePath; this.#source = options.humanAuthorizationSource;
    this.#managed = options.managed;
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(options.stateDir, "diagnostics.sqlite"));
    try {
      this.#db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS metadata (workspace TEXT PRIMARY KEY) STRICT; CREATE TABLE IF NOT EXISTS creations (creation_key TEXT PRIMARY KEY, host_id TEXT UNIQUE, state TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS turns (host_id TEXT NOT NULL, execution_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, marker INTEGER NOT NULL, events_json TEXT NOT NULL, body TEXT, budget_json TEXT NOT NULL, PRIMARY KEY(host_id, execution_key)) STRICT; CREATE TABLE IF NOT EXISTS identity_bindings (host_id TEXT PRIMARY KEY, subject TEXT NOT NULL, verified_at TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS identity_verifications (host_id TEXT NOT NULL, subject TEXT NOT NULL, result INTEGER NOT NULL, verified_at TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS material_loads (load_key TEXT PRIMARY KEY, host_id TEXT NOT NULL, content_hash TEXT NOT NULL, file_path TEXT NOT NULL, state TEXT NOT NULL, marker INTEGER, confirmation_json TEXT) STRICT; CREATE TABLE IF NOT EXISTS request_scopes (creation_key TEXT PRIMARY KEY, capability_scope_json TEXT NOT NULL, temp_dir TEXT, verified_at TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS cancelled_sessions (host_id TEXT PRIMARY KEY, cancelled_at TEXT NOT NULL) STRICT; COMMIT;");
    } catch (error) {
      this.#db.close();
      if ((error as { errcode?: number }).errcode === 5) throw new RoleDockError("WORKSPACE_LOCKED", "Another diagnostic adapter owns this journal.");
      throw error;
    }
    const prior = this.#db.prepare("SELECT workspace FROM metadata").get() as { workspace: string } | undefined;
    if (prior && prior.workspace !== this.#workspace) { this.#db.close(); throw new RoleDockError("PERMISSION_DENIED", "Diagnostic journal belongs to another workspace."); }
    if (!prior) this.#db.prepare("INSERT INTO metadata VALUES (?)").run(this.#workspace);
  }
  getCapabilities(): AdapterCapabilities {
    // B4: load_materials/reconcile_load declared on the strength of the B3
    // real anchor evidence; cancel declared with the official session/stop.
    // Unmanaged (default): the four isolation scopes stay undeclared — the
    // plain connector has no execution boundary. Managed mode (B5-3): the
    // adapter runs sessions behind the RoleDock sandbox boundary whose escape
    // evidence (B5-2) backs these declarations; every managed createSession
    // re-verifies the connector really is sandboxed before any host action
    // (zcode_sandbox_status), failing closed with NOT_IMPLEMENTED otherwise.
    const isolation = { context: this.#managed !== undefined, temp_writes: this.#managed !== undefined, results: this.#managed !== undefined, capability_scope: this.#managed !== undefined };
    return { adapter: "zcode", level: this.#managed ? "full" : "restricted", isolation, optional: { cancel: true, lookup_session_by_creation_key: true, native_resume: false, native_fork: false }, external: { current_session_identity: true, human_authorization_events: true, load_materials: true, reconcile_load: true } };
  }
  /**
   * B5-3: managed declarations are bound to facts. Before the first managed
   * session the connector must answer zcode_sandbox_status with the sandboxed
   * bubblewrap launch and exactly the configured egress list; anything else
   * refuses with NOT_IMPLEMENTED — never an unsandboxed run under a full
   * isolation claim.
   */
  async #verifyManaged(): Promise<void> {
    if (this.#managedVerified) return;
    if (!this.#tools.tools?.has("zcode_sandbox_status")) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare zcode_sandbox_status; managed isolation cannot be verified.");
    let status: Record<string, unknown>;
    try { status = record(await this.#tools.call("zcode_sandbox_status", {})); }
    catch { throw new RoleDockError("NOT_IMPLEMENTED", "Managed sandbox status was not confirmed by the connector; refusing managed sessions (fail-closed)."); }
    const expected = [...this.#managed!.egress].sort().join(",");
    const actual = Array.isArray(status.egress_entries) ? (status.egress_entries as unknown[]).map(String).sort().join(",") : "(missing)";
    if (status.sandboxed !== true || status.runner !== "bubblewrap" || actual !== expected) {
      throw new RoleDockError("NOT_IMPLEMENTED", `Managed mode requires a sandboxed connector with the configured egress whitelist; refusing (fail-closed). status=${JSON.stringify(status)} expected_egress=${expected}`);
    }
    this.#managedVerified = true;
  }
  async createSession(input: CreateSessionInput): Promise<AdapterSessionHandle> {
    if (!input.creation_key?.trim()) throw new RoleDockError("VALIDATION_FAILED", "Expected creation key.");
    if (input.bootstrap && hash(input.bootstrap.payload) !== input.bootstrap.content_hash) throw new RoleDockError("VALIDATION_FAILED", "Bootstrap hash mismatch.");
    if (input.capability_scope !== undefined || input.temp_dir !== undefined) {
      if (!this.#managed) throw new RoleDockError("NOT_IMPLEMENTED", "Capability scope and task isolation require managed sandbox execution; construct the adapter with managed:{egress} (B5-3).");
      await this.#verifyManaged();
      if (input.temp_dir) { try { mkdirSync(input.temp_dir, { recursive: true }); } catch { /* the executor owns this directory's lifecycle host-side */ } }
      this.#db.prepare("INSERT OR IGNORE INTO request_scopes VALUES (?, ?, ?, ?)").run(input.creation_key, JSON.stringify(input.capability_scope ?? []), input.temp_dir ?? null, new Date().toISOString());
    }
    const pending = this.#creating.get(input.creation_key); if (pending) return pending;
    const existing = this.#db.prepare("SELECT * FROM creations WHERE creation_key = ?").get(input.creation_key) as unknown as Creation | undefined;
    if (existing) { if (!existing.host_id || existing.state !== "confirmed") throw uncertain("Creation outcome is unknown; do not create again."); return this.handle(existing); }
    this.#db.prepare("INSERT INTO creations VALUES (?, NULL, 'intent')").run(input.creation_key);
    const promise = this.create(input.creation_key, input); this.#creating.set(input.creation_key, promise);
    try { return await promise; } finally { this.#creating.delete(input.creation_key); }
  }
  private async create(key: string, input: CreateSessionInput): Promise<AdapterSessionHandle> {
    try {
      const output = record(await this.#tools.call("zcode_create_session", { workspacePath: this.#workspace, mode: "plan" }));
      if (typeof output.sessionId !== "string" || !/^sess_[\w-]+$/.test(output.sessionId)) throw uncertain("ZCode did not confirm a valid session ID.");
      this.#db.prepare("UPDATE creations SET host_id = ?, state = 'loading' WHERE creation_key = ?").run(output.sessionId, key);
      const handle: AdapterSessionHandle = { adapter: "zcode", host_session_id: output.sessionId, creation_key: key };
      if (input.bootstrap) {
        // B4: provision with a real material load turn before the handle is
        // returned (handoff/inheritance path); any non-confirm rethrows
        // uncertain and the journal keeps the intent for reconciliation.
        await this.loadExternalMaterials({ host_session_id: handle.host_session_id, connection_subject: `creation:${key}`, load_key: `create-${key}`, bootstrap: input.bootstrap, capability_scope: [] });
      }
      this.#db.prepare("UPDATE creations SET state = 'confirmed' WHERE creation_key = ?").run(key);
      return handle;
    } catch { throw uncertain("ZCode creation was not confirmed; local intent retained."); }
  }
  private handle(row: Creation): AdapterSessionHandle { return { adapter: "zcode", host_session_id: row.host_id!, creation_key: row.creation_key }; }
  /** The journal owns this handle; the row may still be unconfirmed or closed. */
  #owned(handle: AdapterSessionHandle): Creation {
    const row = this.#db.prepare("SELECT * FROM creations WHERE creation_key = ?").get(handle.creation_key) as unknown as Creation | undefined;
    if (handle.adapter !== "zcode" || !row || row.host_id !== handle.host_session_id) throw new RoleDockError("NOT_FOUND", "Host handle is not owned by this diagnostic journal.");
    return row;
  }
  private requireHandle(handle: AdapterSessionHandle): Creation {
    const row = this.#owned(handle);
    if (row.state !== "confirmed") throw new RoleDockError("INVALID_STATE_TRANSITION", `Host handle is ${row.state}; further turns are not accepted.`);
    return row;
  }
  async lookupSessionByCreationKey(key: string): Promise<AdapterSessionHandle | null> {
    const row = this.#db.prepare("SELECT * FROM creations WHERE creation_key = ?").get(key) as unknown as Creation | undefined;
    if (!row) return null;
    if (row.state === "closed") return null;
    if (!row.host_id || row.state !== "confirmed") throw uncertain("No reliable host creation key exists for this pending intent.");
    return this.handle(row);
  }
  /**
   * B1: authoritative session identity via the connector's zcode_verify_session
   * (docs/zcode-connector-tools.md §4.2). Read-only: no host session or model
   * turn is created. The first successful verification binds host↔subject in
   * the journal; a later different subject is a definitive false. Connector
   * failures stay uncertain — they are never converted into a negative.
   * Declared since B2: the B1 real probe evidence passed review scoping.
   */
  async verifyExternalSession(hostSessionId: string, connectionSubject: string): Promise<boolean> {
    // sess_* are connector/instance-created conversations; session_<hex> are
    // the user's PERSISTED DESKTOP sessions (P6-G3 spike) — the original
    // sessions G3 anchors. Both are valid original-session references.
    if (typeof hostSessionId !== "string" || !/^sess(?:ion)?_[\w-]+$/.test(hostSessionId)) throw new RoleDockError("VALIDATION_FAILED", "Invalid host session id format.");
    if (typeof connectionSubject !== "string" || !connectionSubject.trim()) throw new RoleDockError("VALIDATION_FAILED", "Expected a connection subject.");
    if (!this.#tools.tools?.has("zcode_verify_session")) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare zcode_verify_session.", { details: { capability: "current_session_identity" } });
    const now = new Date().toISOString();
    const bound = this.#db.prepare("SELECT subject FROM identity_bindings WHERE host_id = ?").get(hostSessionId) as { subject: string } | undefined;
    if (bound && bound.subject !== connectionSubject) {
      this.recordVerification(hostSessionId, connectionSubject, false, now);
      return false;
    }
    let output: Record<string, unknown>;
    try { output = record(await this.#tools.call("zcode_verify_session", { sessionId: hostSessionId, workspacePath: this.#workspace })); }
    catch (error) {
      // Keep the connector-layer cause attached (desktop-gui-contract §2.1
      // diagnosability): a bare "not confirmed" hides register-blockers.
      const detail = (error as { details?: { connector_error?: unknown } }).details?.connector_error;
      throw uncertain(`Session verification was not confirmed by the connector${detail ? `: ${String(detail).slice(0, 200)}` : "."}`);
    }
    if (output.sessionId !== hostSessionId || typeof output.exists !== "boolean") throw uncertain("Malformed session verification answer.");
    if (output.exists !== true) {
      this.recordVerification(hostSessionId, connectionSubject, false, now);
      return false;
    }
    if (output.workspacePath !== this.#workspace) throw uncertain("Verified session did not echo the configured workspace.");
    if (!bound) this.#db.prepare("INSERT INTO identity_bindings VALUES (?, ?, ?)").run(hostSessionId, connectionSubject, now);
    this.recordVerification(hostSessionId, connectionSubject, true, now);
    return true;
  }
  private recordVerification(hostId: string, subject: string, result: boolean, at: string): void {
    this.#db.prepare("INSERT INTO identity_verifications VALUES (?, ?, ?, ?)").run(hostId, subject, result ? 1 : 0, at);
  }
  useHumanAuthorizationSource(source: HumanAuthorizationSource): void { this.#source = source; }
  /**
   * B3: delivers the anchor material into the original session through the
   * connector's load protocol (docs/zcode-connector-tools.md §4.3). The
   * payload is written content-addressed with a verifiable header; the
   * connector's zcode_lookup_load is the single authority for the
   * confirmation (structural read evidence + exact marker echo). Poll
   * deadline bounds the wait; timeout keeps the local intent 'loading' and
   * fails uncertain — the core drive then reconciles via lookupExternalLoad.
   */
  async loadExternalMaterials(input: ExternalMaterialLoad): Promise<AnchorConfirmation> {
    if (!this.#tools.tools?.has("zcode_load_material") || !this.#tools.tools?.has("zcode_lookup_load")) {
      throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare the anchor material load tools.", { details: { capability: "load_materials" } });
    }
    const payload = input.bootstrap.payload;
    if (hash(payload) !== input.bootstrap.content_hash) throw new RoleDockError("VALIDATION_FAILED", "Anchor material payload hash mismatch.");
    const fileDir = join(this.#workspace, ".roledock", "anchor-materials");
    mkdirSync(fileDir, { recursive: true });
    const filePath = join(fileDir, `${input.load_key}.txt`);
    writeFileSync(filePath, `${loadHeader(input.load_key)}\nsha256:${input.bootstrap.content_hash}\n${payload}`);
    const existing = this.#db.prepare("SELECT state FROM material_loads WHERE load_key = ?").get(input.load_key) as { state: string } | undefined;
    if (existing?.state === "confirmed") return this.materialConfirmation(input.load_key);
    if (!existing) {
      const sent = record(await this.#tools.call("zcode_load_material", { sessionId: input.host_session_id, workspacePath: this.#workspace, loadKey: input.load_key, contentHash: input.bootstrap.content_hash, filePath }));
      if (sent.sessionId !== input.host_session_id || sent.accepted !== true || !integer(sent.marker)) throw uncertain("Anchor material send was not confirmed; local intent is retained.");
      this.#db.prepare("INSERT INTO material_loads VALUES (?, ?, ?, ?, 'loading', ?, NULL)").run(input.load_key, input.host_session_id, input.bootstrap.content_hash, filePath, sent.marker);
    }
    const deadline = Date.now() + 300_000;
    for (;;) {
      const status = record(await this.#tools.call("zcode_status", { sessionId: input.host_session_id, workspacePath: this.#workspace, afterSeq: this.materialMarker(input.load_key) }));
      if (Array.isArray(status.recentEvents) && status.recentEvents.some((event: unknown) => record(event).type === "turn.completed" || record(event).type === "turn.failed")) break;
      if (Array.isArray(status.pendingRequests) && status.pendingRequests.length > 0) throw uncertain("The host is holding a human input or permission request during the anchor material load; it needs an operator, not a retry.");
      if (Date.now() >= deadline) throw uncertain("Anchor material load turn did not reach a terminal state within the deadline.");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return this.reconcileMaterialLoad(input.host_session_id, input.load_key);
  }
  /** Authoritative reconciliation against the connector's persisted session history. */
  async lookupExternalLoad(hostSessionId: string, loadKey: string): Promise<ExternalLoadLookup> {
    if (!this.#tools.tools?.has("zcode_lookup_load")) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare zcode_lookup_load.", { details: { capability: "reconcile_load" } });
    const row = this.#db.prepare("SELECT state FROM material_loads WHERE load_key = ?").get(loadKey) as { state: string } | undefined;
    if (row?.state === "confirmed") return { state: "loaded", confirmation: this.materialConfirmation(loadKey) };
    if (!row) return { state: "absent" };
    try { return { state: "loaded", confirmation: await this.reconcileMaterialLoad(hostSessionId, loadKey) }; }
    catch { return { state: "unknown" }; }
  }
  /**
   * G3 (ADR-0014 §9.1): workspace-store-level discovery of the user's real
   * sessions. Read-only — never creates, attaches or spends a model turn.
   * The connector must declare zcode_list_sessions; otherwise discovery is
   * honestly unavailable and the desktop falls back to paste-a-reference.
   */
  async listHostSessions(): Promise<HostSessionInfo[]> {
    if (!this.#tools.tools?.has("zcode_list_sessions")) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare zcode_list_sessions.", { details: { capability: "host_session_discovery" } });
    const answer = record(await this.#tools.call("zcode_list_sessions", { workspacePath: this.#workspace })) as { sessions?: unknown };
    if (!Array.isArray(answer.sessions)) throw uncertain("Malformed host session discovery answer.");
    return answer.sessions.flatMap(entry => {
      const item = record(entry);
      if (typeof item.sessionId !== "string" || !item.sessionId) return [];
      return [{
        host_session_id: item.sessionId,
        title: typeof item.title === "string" && item.title.trim() ? item.title : null,
        status: typeof item.status === "string" && item.status.trim() ? item.status : null,
        kind: typeof item.sessionKind === "string" && item.sessionKind.trim() ? item.sessionKind : null,
        updated_at: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null,
      }];
    });
  }
  private async reconcileMaterialLoad(hostSessionId: string, loadKey: string): Promise<AnchorConfirmation> {
    const row = this.#db.prepare("SELECT content_hash FROM material_loads WHERE load_key = ?").get(loadKey) as { content_hash: string };
    const answer = record(await this.#tools.call("zcode_lookup_load", { sessionId: hostSessionId, workspacePath: this.#workspace, loadKey, contentHash: row.content_hash }));
    if (answer.state === "loaded") {
      const confirmation = record(answer.confirmation);
      if (confirmation.host_session_id !== hostSessionId || confirmation.load_key !== loadKey || confirmation.content_hash !== row.content_hash || !integer(confirmation.load_version) || confirmation.load_version < 1) throw uncertain("Anchor load confirmation does not match session, key, hash and version.");
      this.#db.prepare("UPDATE material_loads SET state = 'confirmed', confirmation_json = ? WHERE load_key = ?").run(JSON.stringify(confirmation), loadKey);
      return { host_session_id: hostSessionId, load_key: loadKey, content_hash: row.content_hash, load_version: confirmation.load_version as number };
    }
    throw uncertain(`Anchor material load is not confirmable (connector state: ${String(answer.state)}${typeof answer.reason === "string" ? `, reason: ${answer.reason}` : ""}).`);
  }
  private materialMarker(loadKey: string): number {
    return (this.#db.prepare("SELECT marker FROM material_loads WHERE load_key = ?").get(loadKey) as { marker: number }).marker;
  }
  private materialConfirmation(loadKey: string): AnchorConfirmation {
    const row = this.#db.prepare("SELECT host_id, content_hash, confirmation_json FROM material_loads WHERE load_key = ?").get(loadKey) as { host_id: string; content_hash: string; confirmation_json: string };
    const confirmation = JSON.parse(row.confirmation_json) as AnchorConfirmation;
    return { host_session_id: row.host_id, load_key: loadKey, content_hash: row.content_hash, load_version: confirmation.load_version };
  }
  /**
   * B2: returns the owner-written event record's facts for core's
   * recordHumanAuthorization, which performs the workspace/subject/host
   * consistency and ceiling checks. Without a wired source this fails
   * honestly; the capability declaration stays false until acceptance.
   */
  async readHumanAuthorization(hostSessionId: string, eventRef: string): Promise<HumanAuthorizationEvent | null> {
    // Original sessions may be persisted desktop conversations (session_<hex>)
    // or connector-created ones (sess_*); see verifyExternalSession.
    if (typeof hostSessionId !== "string" || !/^sess(?:ion)?_[\w-]+$/.test(hostSessionId)) throw new RoleDockError("VALIDATION_FAILED", "Invalid host session id format.");
    if (typeof eventRef !== "string" || !eventRef.trim()) throw new RoleDockError("VALIDATION_FAILED", "Expected an event reference.");
    if (!this.#source) throw new RoleDockError("NOT_IMPLEMENTED", "No human authorization source is wired into this adapter.");
    const record = await this.#source.readEvent(hostSessionId, eventRef);
    if (!record) return null;
    if (record.host_session_id !== hostSessionId || record.event_ref !== eventRef) throw uncertain("Human authorization event lookup is inconsistent.");
    return { workspace_id: record.workspace_id, host_session_id: record.host_session_id, connection_subject: record.connection_subject, event_ref: record.event_ref, actor_id: record.actor_id, role_id: record.role_id, capabilities: [...record.capabilities], inherit: record.inherit, expires_at: record.expires_at };
  }
  async runTurn(handle: AdapterSessionHandle, input: TurnInput): Promise<TurnResult> {
    this.requireHandle(handle);
    if (typeof input.message !== "string" || !input.message.trim()) throw new RoleDockError("VALIDATION_FAILED", "Diagnostics require an explicit message.");
    // Core always supplies an execution key; direct callers may omit it, in
    // which case every call is a fresh turn (keyed idempotency applies only
    // to explicitly keyed turns).
    const executionKey = input.execution_key?.trim() || `turn-${randomUUID()}`;
    const budget = input.budget ?? {};
    if ((budget.max_turns !== undefined && (!Number.isInteger(budget.max_turns) || budget.max_turns < 1)) || (budget.max_output_bytes !== undefined && (!Number.isInteger(budget.max_output_bytes) || budget.max_output_bytes < 0)) || (budget.deadline !== undefined && !Number.isFinite(Date.parse(budget.deadline)))) throw new RoleDockError("VALIDATION_FAILED", "Invalid diagnostic budget.");
    const fingerprint = hash(JSON.stringify({ message: input.message, max_turns: budget.max_turns, max_output_bytes: budget.max_output_bytes, deadline: budget.deadline }));
    const old = this.#db.prepare("SELECT * FROM turns WHERE host_id = ? AND execution_key = ?").get(handle.host_session_id, executionKey) as unknown as Turn | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Execution key has different diagnostic input.");
      if (old.state === "intent") throw uncertain("Send outcome is unknown; do not send again.");
      if (old.state === "rejected") throw new RoleDockError("INVALID_STATE_TRANSITION", "ZCode did not accept this diagnostic turn.");
      return { host_session_id: handle.host_session_id, accepted: true };
    }
    const key = handle.host_session_id;
    // B5-4 (conformance alignment): the host runs one turn at a time, so an
    // accepted-but-unfinished predecessor queues the new send instead of
    // refusing it. Intent rows (lost send confirmation) still refuse — they
    // are never replayed automatically.
    if (this.#db.prepare("SELECT 1 FROM cancelled_sessions WHERE host_id = ?").get(key)) throw new RoleDockError("INVALID_STATE_TRANSITION", "This session was cancelled; no further turns may be spent on it.");
    if (this.#sending.has(key)) throw new RoleDockError("INVALID_STATE_TRANSITION", "Reconcile the in-flight send before sending another.");
    const predecessor = this.#db.prepare("SELECT execution_key FROM turns WHERE host_id = ? AND state = 'accepted' ORDER BY rowid DESC LIMIT 1").get(key) as { execution_key: string } | undefined;
    if (predecessor) await this.#awaitTerminal(handle, budget.deadline);
    if (this.#db.prepare("SELECT 1 FROM turns WHERE host_id = ? AND state IN ('intent','accepted')").get(key)) throw new RoleDockError("INVALID_STATE_TRANSITION", "Reconcile the existing diagnostic turn before sending another.");
    const count = (this.#db.prepare("SELECT count(*) AS n FROM turns WHERE host_id = ?").get(key) as { n: number }).n;
    if ((budget.max_turns !== undefined && count >= budget.max_turns) || (budget.deadline !== undefined && Date.parse(budget.deadline) <= Date.now())) throw new RoleDockError("INVALID_STATE_TRANSITION", "Diagnostic budget exhausted before send.");
    const promise = this.send(handle, input, fingerprint, executionKey); this.#sending.set(key, promise);
    try { return await promise; } finally { this.#sending.delete(key); }
  }
  /** Polls getResult until the in-flight turn reaches a terminal state (bounded by the turn deadline, max 120s). */
  async #awaitTerminal(handle: AdapterSessionHandle, deadline: string | undefined): Promise<void> {
    const limit = Math.min(deadline ? Date.parse(deadline) : Infinity, Date.now() + 120_000);
    for (;;) {
      const result = await this.getResult(handle);
      if (result.completed) return;
      if (result.needs_input || Date.now() >= limit) throw new RoleDockError("INVALID_STATE_TRANSITION", "The previous turn did not reach a terminal state before the next send.");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  private async send(handle: AdapterSessionHandle, input: TurnInput, fingerprint: string, executionKey: string): Promise<TurnResult> {
    const status = record(await this.#tools.call("zcode_status", { sessionId: handle.host_session_id, workspacePath: this.#workspace }));
    if (status.sessionId !== handle.host_session_id || status.status !== "idle" || !integer(status.lastSeq)) throw new RoleDockError("INVALID_STATE_TRANSITION", "Diagnostic host is not confirmed idle.");
    if (input.budget?.deadline && Date.parse(input.budget.deadline) <= Date.now()) throw new RoleDockError("INVALID_STATE_TRANSITION", "Diagnostic deadline passed while reading host state.");
    this.#db.prepare("INSERT INTO turns VALUES (?, ?, ?, 'intent', ?, '[]', NULL, ?)").run(handle.host_session_id, executionKey, fingerprint, status.lastSeq, JSON.stringify(input.budget ?? {}));
    try {
      const output = record(await this.#tools.call("zcode_send", { sessionId: handle.host_session_id, workspacePath: this.#workspace, message: input.message, reasoningLevel: "low" }));
      if (output.sessionId !== handle.host_session_id || output.accepted !== true) {
        if (output.sessionId === handle.host_session_id && output.accepted === false) this.#db.prepare("UPDATE turns SET state = 'rejected' WHERE host_id = ? AND execution_key = ?").run(handle.host_session_id, executionKey);
        if (output.sessionId === handle.host_session_id && output.accepted === false) throw new RoleDockError("INVALID_STATE_TRANSITION", "ZCode refused the diagnostic turn.");
        throw uncertain("Diagnostic send acceptance was not confirmed.");
      }
      this.#db.prepare("UPDATE turns SET state = 'accepted' WHERE host_id = ? AND execution_key = ?").run(handle.host_session_id, executionKey);
      return { host_session_id: handle.host_session_id, accepted: true };
    } catch (error) {
      const state = this.#db.prepare("SELECT state FROM turns WHERE host_id = ? AND execution_key = ?").get(handle.host_session_id, executionKey) as { state: string };
      if (state.state === "rejected") throw error;
      throw uncertain("Diagnostic send was not confirmed; intent is retained, not replayed.");
    }
  }
  async getResult(handle: AdapterSessionHandle): Promise<AdapterSessionResult> {
    const creation = this.#owned(handle);
    // B5-4 (conformance alignment): a closed session reports the closed state
    // instead of pretending the handle never existed.
    if (creation.state === "closed") {
      const closed = (this.#db.prepare("SELECT count(*) AS n FROM turns WHERE host_id = ? AND state IN ('accepted','completed')").get(handle.host_session_id) as { n: number }).n;
      return { host_session_id: handle.host_session_id, state: "closed", turn_count: closed, completed: false };
    }
    this.requireHandle(handle);
    const turn = this.#db.prepare("SELECT * FROM turns WHERE host_id = ? ORDER BY rowid DESC LIMIT 1").get(handle.host_session_id) as unknown as Turn | undefined;
    const count = (this.#db.prepare("SELECT count(*) AS n FROM turns WHERE host_id = ? AND state IN ('accepted','completed')").get(handle.host_session_id) as { n: number }).n;
    if (!turn) return { host_session_id: handle.host_session_id, state: "idle", turn_count: 0, completed: false };
    if (turn.state === "intent") throw uncertain("Unknown diagnostic send requires an authoritative host key; no automatic replay.");
    if (turn.state === "rejected") throw new RoleDockError("INVALID_STATE_TRANSITION", "Diagnostic turn was rejected.");
    if (turn.state === "completed") return { host_session_id: handle.host_session_id, state: "idle", turn_count: count, completed: true, body: turn.body!, output_bytes: Buffer.byteLength(turn.body!), execution_key: turn.execution_key };
    const status = record(await this.#tools.call("zcode_status", { sessionId: handle.host_session_id, workspacePath: this.#workspace, afterSeq: turn.marker }));
    if (status.sessionId !== handle.host_session_id || !integer(status.lastSeq) || !Array.isArray(status.recentEvents)) throw uncertain("Malformed or truncated diagnostic status.");
    const seen = new Map<number, Event>((JSON.parse(turn.events_json) as Event[]).map(e => [e.seq, e]));
    for (const value of status.recentEvents) {
      const event = record(value);
      if (!integer(event.seq) || typeof event.type !== "string") throw uncertain("Malformed diagnostic event.");
      if (event.seq > turn.marker) {
        const next: Event = { seq: event.seq, type: event.type, ...(typeof event.response === "string" ? { response: event.response } : {}) };
        const prior = seen.get(next.seq);
        if (prior && JSON.stringify(prior) !== JSON.stringify(next)) throw uncertain("Diagnostic event changed during reconciliation.");
        seen.set(next.seq, next);
      }
    }
    const events = [...seen.values()].sort((a,b) => a.seq-b.seq);
    if (events.length > 4096) throw uncertain("Diagnostic event window exceeded; no completion is inferred.");
    this.#db.prepare("UPDATE turns SET events_json = ? WHERE host_id = ? AND execution_key = ?").run(JSON.stringify(events), handle.host_session_id, turn.execution_key);
    const started = events.filter(e => e.type === "turn.started");
    const terminal = events.filter(e => e.type === "turn.completed" || e.type === "turn.failed");
    if (!terminal.length) return { host_session_id: handle.host_session_id, state: "running", turn_count: count, completed: false, execution_key: turn.execution_key, needs_input: Array.isArray(status.pendingRequests) && status.pendingRequests.length > 0 };
    // Adoption invariants (B5-3, tightened for real-host concurrency): the
    // window starts after our own send marker, contains exactly one
    // turn.started and exactly one terminal, in that order, with strictly
    // increasing seqs (the push stream may drop streaming-noise events under
    // overlapping sessions; the answer itself is cross-checked against
    // lastTurn below, so gaps in noise events cannot admit a wrong answer).
    const strictlyIncreasing = events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq);
    if (!strictlyIncreasing || started.length !== 1 || terminal.length !== 1 || terminal[0]!.seq! <= started[0]!.seq! || status.status !== "idle") throw uncertain("Incomplete or ambiguous diagnostic event trace; old answers are not adopted.");
    const completed = terminal[0]!;
    const last = record(status.lastTurn);
    if (completed.type !== "turn.completed" || typeof completed.response !== "string" || !completed.response || completed.response.includes("… (") || last.type !== "turn.completed" || last.response !== completed.response) throw uncertain("No complete matching real answer is available.");
    const budget = JSON.parse(turn.budget_json) as NonNullable<TurnInput["budget"]>;
    if ((budget.deadline && Date.parse(budget.deadline) <= Date.now()) || (budget.max_output_bytes !== undefined && Buffer.byteLength(completed.response) > budget.max_output_bytes)) throw new RoleDockError("INVALID_STATE_TRANSITION", "Actual diagnostic answer exceeded its budget.");
    this.#db.prepare("UPDATE turns SET state = 'completed', body = ? WHERE host_id = ? AND execution_key = ?").run(completed.response, handle.host_session_id, turn.execution_key);
    return { host_session_id: handle.host_session_id, state: "idle", turn_count: count, completed: true, body: completed.response, output_bytes: Buffer.byteLength(completed.response), execution_key: turn.execution_key };
  }
  /** B4: official session/stop — abort the active turn; an honest no-op when idle; never a close. */
  async cancel(handle: AdapterSessionHandle): Promise<void> {
    this.requireHandle(handle);
    if (!this.#tools.tools?.has("zcode_cancel")) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare zcode_cancel.", { details: { capability: "cancel" } });
    try { record(await this.#tools.call("zcode_cancel", { sessionId: handle.host_session_id })); }
    catch { throw uncertain("Cancel signal was not confirmed; the host turn state is unknown."); }
    // spec §7: a declaring-cancel adapter must prevent turns after the cancel.
    this.#db.prepare("INSERT OR IGNORE INTO cancelled_sessions VALUES (?, ?)").run(handle.host_session_id, new Date().toISOString());
  }
  /** B4: official session/close — the host deletes its event store; closed:false stays uncertain. Repeatable: an already-closed session is an honest no-op. */
  async closeSession(handle: AdapterSessionHandle): Promise<void> {
    const creation = this.#owned(handle);
    if (creation.state === "closed") return;
    if (!this.#tools.tools?.has("zcode_close")) throw new RoleDockError("ADAPTER_CAPABILITY_MISSING", "Connector does not declare zcode_close.");
    let answer: Record<string, unknown>;
    try { answer = record(await this.#tools.call("zcode_close", { sessionId: handle.host_session_id })); }
    catch { throw uncertain("Host close was not confirmed; do not assume the session was reclaimed."); }
    if (answer.closed !== true) throw uncertain("Host did not confirm the session close.");
    this.#db.prepare("UPDATE creations SET state = 'closed' WHERE creation_key = ? AND host_id = ?").run(handle.creation_key, handle.host_session_id);
  }
  /** Closes only the local journal, never claims host/model cancellation. */
  closeJournal(): void { this.#db.close(); }
  /** B5-3 audit view: the frozen scope and temp whitelist recorded for a managed session. */
  requestScope(creationKey: string): { capability_scope: string[]; temp_dir: string | null; verified_at: string } | null {
    const row = this.#db.prepare("SELECT capability_scope_json, temp_dir, verified_at FROM request_scopes WHERE creation_key = ?").get(creationKey) as { capability_scope_json: string; temp_dir: string | null; verified_at: string } | undefined;
    return row ? { capability_scope: JSON.parse(row.capability_scope_json) as string[], temp_dir: row.temp_dir, verified_at: row.verified_at } : null;
  }
}
