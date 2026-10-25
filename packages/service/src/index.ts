import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "@roledock/core";
import type { HarnessAdapter, SessionConnection } from "@roledock/core";
import { RoleDockError, toErrorEnvelope, validate } from "@roledock/protocol";
import type { ErrorEnvelope } from "@roledock/protocol";

export interface ServiceCredential { socket_path: string; token: string }
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
    if (["connections.trust", "externalSessions.register", "externalSessions.list", "authorizations.recordHuman", "authorizations.recordOwner", "authorizations.revoke", "authorizations.submitHumanEvent"].includes(operation)) {
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
    if (operation === "authorizations.revoke") return this.#authority.revoke(data);
    const adminMethods: Record<string, keyof WorkspaceAdmin> = { "policy.show": "showPolicy", "policy.grant": "grant", "policy.revoke": "revoke", "admin.inbox": "showInbox", "admin.events": "showEvents" };
    const adminMethod = adminMethods[operation];
    if (adminMethod) return (this.#admin[adminMethod] as (input: unknown) => unknown).call(this.#admin, data);
    const ownerMethods: Record<string, keyof Coordinator> = { "roles.install": "installRolePack", "roles.list": "listRoles", "roles.resolve": "resolveRole", "knowledge.export": "exportKnowledge", "knowledge.import": "importKnowledge" };
    const ownerMethod = ownerMethods[operation];
    if (ownerMethod) return (this.#coordinator[ownerMethod] as (input: unknown) => Promise<unknown>).call(this.#coordinator, data);
    if (operation === "workspace.info") return { workspace_id: this.workspaceId };
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
  call<T = unknown>(operation: string, input: unknown = {}): Promise<T> {
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
      req.on("error", reject); req.end(body);
    });
  }
}
