import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "@roledock/core";
import type { HarnessAdapter, SessionConnection } from "@roledock/core";
import type { WorkspaceServiceInfo, WorkspaceRuntimeStatus, RoleDetails, PolicyListPage, AuthorizationConfirmationsPage, PendingHumanEventsPage, HostSessionDiscovery, SessionBindingsPage, AnchorAttemptsPage, AnchorLoadsPage, RevokePreview, OwnerDocumentListPage, OwnerDocumentRead, OwnerDocumentRevisionsPage, OwnerCandidatesPage, OwnerCheckpointListPage, OwnerCheckpointDetail } from "@roledock/protocol";
import { RoleDockError, toErrorEnvelope, validate } from "@roledock/protocol";
import type { ErrorEnvelope } from "@roledock/protocol";

export interface ServiceCredential { socket_path: string; token: string }
/** Bump together with packages/service/package.json (non-sensitive projection). */
export const SERVICE_VERSION = "0.1.0-alpha.0";
interface OwnerPrincipal { kind: "owner" }
interface TrustedPrincipal { kind: "trusted"; subject: string; ceiling: string[] }
interface SessionPrincipal { kind: "session"; connection: SessionConnection }
type Principal = OwnerPrincipal | TrustedPrincipal | SessionPrincipal;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoleDockError("VALIDATION_FAILED", "Expected object input.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new RoleDockError("VALIDATION_FAILED", "Expected nonempty string.");
  return value;
}
/** Linux local reference server. Only this process opens the workspace writer. */
export class WorkspaceService {
  readonly #coordinator: Coordinator;
  readonly #authority: ExternalSessionAuthority;
  readonly #admin: WorkspaceAdmin;
  readonly #principals = new Map<string, Principal>();
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #adapterName: string;
  readonly #capabilities: ReturnType<HarnessAdapter["getCapabilities"]>;
  readonly #startedAt = new Date().toISOString();
  #timer: ReturnType<typeof setInterval> | undefined;
  #worker: Promise<void> | undefined;
  #maintenance: Promise<void> | undefined;
  #closing = false;
  readonly ownerCredential: ServiceCredential;
  private constructor(root: string, adapter: HarnessAdapter, socketPath: string) {
    this.#coordinator = Coordinator.open({ root, adapter });
    this.#authority = new ExternalSessionAuthority(this.#coordinator, adapter);
    this.#admin = WorkspaceAdmin.forCoordinator(this.#coordinator);
    this.#socketPath = socketPath;
    this.#adapterName = adapter.getCapabilities().adapter;
    this.#capabilities = adapter.getCapabilities();
    this.ownerCredential = this.issue({ kind: "owner" });
    this.#server = createServer(async (req, res) => {
      const reply = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      try {
        if (this.#closing) throw new RoleDockError("INVALID_STATE_TRANSITION", "Service is shutting down.");
        if (req.method !== "POST" || req.url !== "/rpc") { reply(toErrorEnvelope(new RoleDockError("VALIDATION_FAILED", "Expected POST /rpc.")), 404); return; }
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const principal = this.#principals.get(token);
        if (!principal) { reply(toErrorEnvelope(new RoleDockError("PERMISSION_DENIED", "Unknown connection credential.")), 401); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk as Buffer);
          if (bytes > 1024 * 1024) { reply(toErrorEnvelope(new RoleDockError("VALIDATION_FAILED", "RPC input exceeds 1 MiB.")), 413); return; }
          chunks.push(Buffer.from(chunk as Buffer));
        }
        let envelope: Record<string, unknown>;
        try { envelope = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw new RoleDockError("VALIDATION_FAILED", "Malformed RPC JSON."); }
        if (Object.keys(envelope).some(key => !["operation", "input"].includes(key))) throw new RoleDockError("VALIDATION_FAILED", "Unknown RPC fields.");
        const result = await this.invoke(principal, text(envelope.operation), envelope.input ?? {});
        reply({ ok: true, result });
      } catch (error) { reply(toErrorEnvelope(error)); }
    });
    this.#server.requestTimeout = 30000;
    this.#server.headersTimeout = 10000;
  }
  static async start(options: { root: string; adapter: HarnessAdapter; socketPath: string; pollMs?: number }): Promise<WorkspaceService> {
    if (!isAbsolute(options.socketPath)) throw new RoleDockError("VALIDATION_FAILED", "Service socket path must be absolute.");
    mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    const service = new WorkspaceService(options.root, options.adapter, options.socketPath);
    try {
      // The writer lock is held before recovery. A dead, owned socket can be
      // removed after a failed connect; live sockets, files and symlinks cannot.
      await recoverStaleSocket(options.socketPath);
      await new Promise<void>((resolve, reject) => { service.#server.once("error", reject); service.#server.listen(options.socketPath, () => { service.#server.off("error", reject); resolve(); }); });
      chmodSync(options.socketPath, 0o600);
      const pollMs = options.pollMs ?? 100;
      if (!Number.isFinite(pollMs) || pollMs < 10) throw new RoleDockError("VALIDATION_FAILED", "Worker pollMs must be at least 10.");
      service.#timer = setInterval(() => service.schedule(), pollMs); service.#timer.unref();
      service.schedule();
      return service;
    } catch (error) { await service.close(); throw error; }
  }
  get workspaceId(): string { return this.#coordinator.workspaceId; }
  private issue(principal: Principal): ServiceCredential {
    const token = randomBytes(32).toString("hex"); this.#principals.set(token, principal);
    return { socket_path: this.#socketPath, token };
  }
  private async invoke(principal: Principal, operation: string, input: unknown): Promise<unknown> {
    if (principal.kind === "session") return principal.connection.call(operation, input);
    const data = object(input);
    if (["connections.trust", "externalSessions.register", "externalSessions.list", "externalSessions.discover", "authorizations.recordHuman", "authorizations.recordOwner", "authorizations.revoke", "authorizations.revokePreview", "authorizations.submitHumanEvent", "authorizations.pendingEvents", "authorizations.confirmations", "sessions.listBindings", "sessions.listAttempts", "sessions.listLoads", "documents.list", "documents.read", "documents.listRevisions", "documents.listCandidates", "checkpoints.list", "checkpoints.get"].includes(operation)) {
      const result = validate("service-control-operation", { operation, input });
      if (!result.ok) throw new RoleDockError("VALIDATION_FAILED", "Invalid control operation input.", { details: { errors: result.errors } });
    }
    if (principal.kind === "trusted") {
      if (operation === "externalSessions.register") {
        if (Object.keys(data).some(key => key !== "host_session_id")) throw new RoleDockError("VALIDATION_FAILED", "Trusted identity comes from connection, not RPC fields.");
        const external = await this.#authority.register({ host_session_id: text(data.host_session_id), connection_subject: principal.subject, capability_ceiling: principal.ceiling });
        return { external_session: external, credential: this.issue({ kind: "session", connection: this.#authority.connect(external.external_session_id, principal.subject) }) };
      }
      if (operation === "authorizations.recordHuman") {
        const external = this.#authority.externalSession(text(data.external_session_id));
        if (external.connection_subject !== principal.subject) throw new RoleDockError("PERMISSION_DENIED", "Human event channel belongs to another session subject.");
        return this.#authority.recordHumanAuthorization(data, principal.ceiling);
      }
      // G3 (ADR-0014): trusted event-progress bridge reads its own subject's
      // pending events; the subject comes from the principal, never input.
      if (operation === "authorizations.pendingEvents") {
        if (Object.keys(data).length > 0) throw new RoleDockError("VALIDATION_FAILED", "authorizations.pendingEvents takes no input; the subject comes from the trusted connection.");
        const page = this.#authority.listPendingHumanEvents(principal.subject);
        const checked = validate<PendingHumanEventsPage>("pending-human-events", page);
        if (!checked.ok) throw new RoleDockError("INTERNAL", "authorizations.pendingEvents projection failed schema validation.", { details: { errors: checked.errors } });
        return page;
      }
      // G3 (ADR-0014 §9.1): read-only host session discovery for the
      // desktop bridge; never creates sessions or consumes model turns.
      if (operation === "externalSessions.discover") {
        if (Object.keys(data).length > 0) throw new RoleDockError("VALIDATION_FAILED", "externalSessions.discover takes no input.");
        const discovery = await this.#authority.discoverHostSessions();
        const checked = validate<HostSessionDiscovery>("host-session-discovery", discovery);
        if (!checked.ok) throw new RoleDockError("INTERNAL", "externalSessions.discover projection failed schema validation.", { details: { errors: checked.errors } });
        return discovery;
      }
      throw new RoleDockError("PERMISSION_DENIED", "Trusted event channel cannot call owner or Agent operations.");
    }
    if (operation === "connections.trust") {
      if (Object.keys(data).some(key => !["subject", "capability_ceiling"].includes(key)) || !Array.isArray(data.capability_ceiling) || data.capability_ceiling.some(cap => typeof cap !== "string")) throw new RoleDockError("VALIDATION_FAILED", "Invalid trusted connection ceiling.");
      return this.issue({ kind: "trusted", subject: text(data.subject), ceiling: data.capability_ceiling as string[] });
    }
    if (operation === "authorizations.recordOwner") return this.#authority.recordOwnerAuthorization(data);
    // ADR-0011: trusted-entry writer (CLI console now, GUI confirm later); owner face only.
    if (operation === "authorizations.submitHumanEvent") return this.#authority.submitHumanEvent(data);
    // G-min: owner confirmation surface read view.
    if (operation === "externalSessions.list") return this.#authority.listExternalSessions();
    // G3 (desktop-gui-contract §9): owner confirmation progress chain view.
    if (operation === "authorizations.confirmations") {
      const page = this.#authority.listConfirmations(data);
      const checked = validate<AuthorizationConfirmationsPage>("authorization-confirmations", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "authorizations.confirmations projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "authorizations.revoke") return this.#authority.revoke(data);
    // G4 (desktop-gui-contract §2.3): owner read views of bindings, anchor
    // attempts, material loads and the revoke impact preview. Projection
    // only, owner principal; schema-enforced at the transport boundary.
    if (operation === "sessions.listBindings") {
      const page = this.#authority.listBindings(data);
      const checked = validate<SessionBindingsPage>("session-bindings", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "sessions.listBindings projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "sessions.listAttempts") {
      const page = this.#authority.listAttempts(data);
      const checked = validate<AnchorAttemptsPage>("anchor-attempts", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "sessions.listAttempts projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "sessions.listLoads") {
      const page = this.#authority.listLoads(data);
      const checked = validate<AnchorLoadsPage>("anchor-loads", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "sessions.listLoads projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "authorizations.revokePreview") {
      const preview = this.#authority.revokePreview(data);
      const checked = validate<RevokePreview>("revoke-preview", preview);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "authorizations.revokePreview projection failed schema validation.", { details: { errors: checked.errors } });
      return preview;
    }
    // G5 (desktop-gui-contract §2.3): owner knowledge read views — directory,
    // per-revision content (§3.2 matrix), revision history, candidates and
    // checkpoints. Projection only, owner principal; schema-enforced here.
    if (operation === "documents.list") {
      const page = (this.#admin.documentList as (input: unknown) => OwnerDocumentListPage)(data);
      const checked = validate<OwnerDocumentListPage>("owner-documents", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "documents.list projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "documents.read") {
      const read = (this.#admin.documentRead as (input: unknown) => OwnerDocumentRead)(data);
      const checked = validate<OwnerDocumentRead>("owner-document", read);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "documents.read projection failed schema validation.", { details: { errors: checked.errors } });
      return read;
    }
    if (operation === "documents.listRevisions") {
      const page = (this.#admin.documentRevisions as (input: unknown) => OwnerDocumentRevisionsPage)(data);
      const checked = validate<OwnerDocumentRevisionsPage>("owner-document-revisions", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "documents.listRevisions projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "documents.listCandidates") {
      const page = (this.#admin.candidateList as (input: unknown) => OwnerCandidatesPage)(data);
      const checked = validate<OwnerCandidatesPage>("owner-candidates", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "documents.listCandidates projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "checkpoints.list") {
      const page = (this.#admin.checkpointList as (input: unknown) => OwnerCheckpointListPage)(data);
      const checked = validate<OwnerCheckpointListPage>("owner-checkpoints", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "checkpoints.list projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    if (operation === "checkpoints.get") {
      const detail = (this.#admin.checkpointGet as (input: unknown) => OwnerCheckpointDetail)(data);
      const checked = validate<OwnerCheckpointDetail>("owner-checkpoint-detail", detail);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "checkpoints.get projection failed schema validation.", { details: { errors: checked.errors } });
      return detail;
    }
    const adminMethods: Record<string, keyof WorkspaceAdmin> = { "policy.show": "showPolicy", "policy.grant": "grant", "policy.revoke": "revoke", "admin.inbox": "showInbox", "admin.events": "showEvents" };
    // G2 read models with Schema enforcement at the transport boundary.
    if (operation === "roles.get") {
      const details = await (this.#admin.roleDetails as (input: unknown) => RoleDetails)(data);
      const checked = validate<RoleDetails>("role-details", details);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "roles.get projection failed schema validation.", { details: { errors: checked.errors } });
      return details;
    }
    if (operation === "policy.list") {
      const page = (this.#admin.listPolicy as (input: unknown) => PolicyListPage)(data);
      const checked = validate<PolicyListPage>("policy-list", page);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "policy.list projection failed schema validation.", { details: { errors: checked.errors } });
      return page;
    }
    const adminMethod = adminMethods[operation];
    if (adminMethod) return (this.#admin[adminMethod] as (input: unknown) => unknown).call(this.#admin, data);
    const ownerMethods: Record<string, keyof Coordinator> = { "roles.install": "installRolePack", "roles.list": "listRoles", "roles.resolve": "resolveRole", "knowledge.export": "exportKnowledge", "knowledge.import": "importKnowledge" };
    const ownerMethod = ownerMethods[operation];
    if (ownerMethod) return (this.#coordinator[ownerMethod] as (input: unknown) => Promise<unknown>).call(this.#coordinator, data);
    if (operation === "workspace.info") {
      // G1 extension (desktop-gui-contract §2.3): limited, non-sensitive
      // runtime projection — no argv, no filesystem paths, no credentials —
      // validated against the protocol Schema at the transport boundary.
      const projection = {
        workspace_id: this.workspaceId,
        service: { version: SERVICE_VERSION, pid: process.pid, started_at: this.#startedAt, adapter: this.#adapterName, runtime: process.version },
      };
      const checked = validate<WorkspaceServiceInfo>("workspace-service-info", projection);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "workspace.info projection failed schema validation.", { details: { errors: checked.errors } });
      return projection;
    }
    if (operation === "workspace.runtimeStatus") {
      // G2: service-side adapter capability projection (managed declaration
      // and basis). Runner/egress/connection checks are desktop preflight.
      const capabilities = this.#capabilities;
      const projection = {
        workspace_id: this.workspaceId,
        observed_at: new Date().toISOString(),
        runtime: { adapter: capabilities.adapter, level: capabilities.level, isolation: { ...capabilities.isolation } },
      };
      const checked = validate<WorkspaceRuntimeStatus>("workspace-runtime-status", projection);
      if (!checked.ok) throw new RoleDockError("INTERNAL", "workspace.runtimeStatus projection failed schema validation.", { details: { errors: checked.errors } });
      return projection;
    }
    throw new RoleDockError("PERMISSION_DENIED", "Operation is not available to this principal.");
  }
  private schedule(): void {
    if (this.#closing) return;
    this.#authority.expireBindings();
    if (!this.#maintenance) this.#maintenance = this.#authority.maintain().catch(() => undefined).finally(() => { this.#maintenance = undefined; });
    if (this.#worker) return;
    this.#worker = this.#authority.tick().catch(() => undefined).finally(() => { this.#worker = undefined; });
  }
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true; if (this.#timer) clearInterval(this.#timer);
    await new Promise<void>(resolve => this.#server.close(() => resolve()));
    await this.#worker;
    await this.#maintenance;
    this.#principals.clear(); this.#coordinator.close();
    // Node normally removes its socket on close; never delete a replacement endpoint.
  }
}

async function recoverStaleSocket(path: string): Promise<void> {
  let existing;
  try { existing = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new RoleDockError("VALIDATION_FAILED", "Socket path contains a foreign endpoint or non-socket file.");
  const dead = await new Promise<boolean>((resolve, reject) => {
    const connection = createConnection(path);
    connection.setTimeout(1000, () => { connection.destroy(); reject(new RoleDockError("VALIDATION_FAILED", "Existing socket liveness is uncertain.")); });
    connection.once("connect", () => { connection.destroy(); resolve(false); });
    connection.once("error", error => { if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(true); else reject(error); });
  });
  if (!dead) throw new RoleDockError("VALIDATION_FAILED", "Another live service owns the socket path.");
  const current = lstatSync(path);
  if (!current.isSocket() || current.ino !== existing.ino || current.dev !== existing.dev) throw new RoleDockError("VALIDATION_FAILED", "Socket changed during stale endpoint recovery.");
  unlinkSync(path);
}
/** Any number of clients share one service; the bearer fixes their principal. */
export class ServiceClient {
  readonly #credential: ServiceCredential;
  constructor(credential: ServiceCredential) { this.#credential = { ...credential }; }
  /**
   * Client-side deadline (DESKTOP_GUI_PLAN §9): the request is destroyed and
   * rejects with ServiceRequestTimeoutError when the wait is exhausted.
   * Cancelling the wait never cancels the already-submitted action — callers
   * must reconcile via persisted state instead of blind retries.
   */
  call<T = unknown>(operation: string, input: unknown = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new ServiceRequestTimeoutError(operation, timeoutMs));
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ operation, input });
      const req = request({ socketPath: this.#credential.socket_path, path: "/rpc", method: "POST", agent: false,
        headers: { authorization: `Bearer ${this.#credential.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
        let bytes = 0; const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { req.destroy(new Error("Service response exceeds 16 MiB.")); return; } chunks.push(chunk); });
        res.on("end", () => {
          try {
            const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: true; result: T } | ErrorEnvelope;
            if (envelope.ok) resolve(envelope.result);
            else reject(new RoleDockError(envelope.error.code, envelope.error.message, { details: envelope.error.details, retryable: envelope.error.retryable }));
          } catch (error) { reject(error); }
        });
        res.on("error", reject);
      });
      const timer = setTimeout(() => req.destroy(new ServiceRequestTimeoutError(operation, timeoutMs)), timeoutMs);
      timer.unref?.();
      req.on("error", error => { clearTimeout(timer); reject(error); });
      req.on("close", () => clearTimeout(timer));
      req.end(body);
    });
  }
}

/** Client-side wait deadline exhausted; the submitted action may still have run. */
export class ServiceRequestTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;
  constructor(operation: string, timeoutMs: number) {
    super(`Service request "${operation}" exceeded the ${timeoutMs}ms client deadline; the submitted action may still complete and must be reconciled, not blindly retried.`);
    this.name = "ServiceRequestTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}
