import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RoleDockError } from "@roledock/protocol";
import { createSandboxLaunch, probeSandboxRunner } from "./sandbox.js";
import type { SandboxLaunch } from "./sandbox.js";

/**
 * Reference ZCode connector (docs/zcode-connector-tools.md is the contract).
 *
 * An MCP stdio server bridging the ZCodeAdapter to the official ZCode CLI
 * `app-server` (JSON-RPC over stdio). Injection rules from ADR-0010/0011:
 * the CLI entry and the optional credential helper are caller-provided; this
 * module never hardcodes personal paths and never reads or decrypts a
 * credential store — model-provider headers are delegated to the helper
 * process verbatim, and without one model turns fail honestly.
 */

export const REFERENCE_CONNECTOR_NAME = "roledock-zcode-reference";
/** 0.5.0 (B5-3): adds zcode_sandbox_status so the adapter verifies managed mode before declaring full isolation. */
export const REFERENCE_CONNECTOR_VERSION = "0.5.0";

const MAX_TEXT = 16_000;
const truncate = (value: unknown, limit = MAX_TEXT): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
};
/** Tool INPUT may reference either a connector-created conversation (sess_*)
 * or the user's persisted desktop session (session_<hex>; P6-G3 spike) —
 * the original sessions G3 registers and anchors. */
const REFERENCED_SESSION_ID = /^sess(?:ion)?_[\w-]+$/;
/** session/create output is always a fresh instance-scoped sess_* conversation. */
const SESSION_ID = /^sess_[\w-]+$/;
/** Anchor load protocol (docs/zcode-connector-tools.md §4.3). */
export const loadHeader = (loadKey: string): string => `roledock-anchor-load/${loadKey}`;
export const loadMarker = (loadKey: string, contentHash: string): string => `ROLEDOCK-ANCHOR-LOADED ${loadKey} ${contentHash}`;

function requireDirectory(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) {
    throw new Error(`${name} must be an existing absolute directory`);
  }
  return value;
}
function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !REFERENCED_SESSION_ID.test(value)) throw new Error("Invalid ZCode session ID");
  return value;
}

interface ServerMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }
interface PendingInteraction { method: string; params: Record<string, unknown> | undefined; envelopeIds: number[] }
type HostEvent = { seq?: number; type?: string; payload?: Record<string, unknown> };
interface LoadRow { session_id: string; content_hash: string; state: string; marker: number | null; confirmation_json: string | null }

/** Minimal JSON-RPC client for one owned `zcode.cjs app-server` child process. */
export class AppServerClient {
  readonly #cliPath: string;
  readonly #credentialHelper: string | undefined;
  readonly #provider: string | undefined;
  readonly #model: string | undefined;
  readonly #journalPath: string | undefined;
  #journal: DatabaseSync | undefined;
  readonly #sandbox: { egress: readonly string[] } | undefined;
  #sandboxLaunch: SandboxLaunch | undefined;
  #starting: Promise<void> | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #active = new Set<string>();
  readonly #subscribed = new Set<string>();
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #events = new Map<string, HostEvent[]>();
  #stderrTail = "";

  constructor(options: { cliPath: string; credentialHelper?: string; provider?: string; model?: string; journal?: string; sandbox?: { egress: readonly string[] } }) {
    if (!isAbsolute(options.cliPath) || !existsSync(options.cliPath)) throw new Error(`ZCode CLI entry not found: ${options.cliPath}`);
    if (options.journal !== undefined && !isAbsolute(options.journal)) throw new Error("journal must be an absolute path");
    this.#cliPath = options.cliPath;
    this.#credentialHelper = options.credentialHelper;
    this.#provider = options.provider;
    this.#model = options.model;
    this.#sandbox = options.sandbox;
    if (options.journal !== undefined) {
      mkdirSync(options.journal.slice(0, options.journal.lastIndexOf("/")) || "/", { recursive: true });
      this.#journal = new DatabaseSync(options.journal);
      this.#journal.exec("CREATE TABLE IF NOT EXISTS loads (load_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL, marker INTEGER, confirmation_json TEXT, updated_at TEXT NOT NULL) STRICT");
    }
  }

  #loadRow(loadKey: string): LoadRow | undefined {
    return this.#journal?.prepare("SELECT session_id, content_hash, state, marker, confirmation_json FROM loads WHERE load_key = ?").get(loadKey) as LoadRow | undefined;
  }
  #saveLoad(loadKey: string, sessionId: string, contentHash: string, state: string, marker: number | null, confirmation: Record<string, unknown> | undefined): void {
    this.#journal?.prepare("INSERT INTO loads (load_key, session_id, content_hash, state, marker, confirmation_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(load_key) DO UPDATE SET state = excluded.state, marker = excluded.marker, confirmation_json = excluded.confirmation_json, updated_at = excluded.updated_at")
      .run(loadKey, sessionId, contentHash, state, marker, confirmation ? JSON.stringify(confirmation) : null, new Date().toISOString());
  }

  /** B5-3: lets the adapter verify managed mode before declaring full isolation. */
  get sandboxStatus(): Record<string, unknown> {
    return this.#sandbox
      ? { sandboxed: true, runner: "bubblewrap", egress_entries: [...this.#sandbox.egress], workspace_root: process.cwd() }
      : { sandboxed: false, runner: null, egress_entries: [], workspace_root: process.cwd() };
  }

  /** Single-flight: concurrent first calls must spawn exactly one sandbox (B5-3, 10 overlapping requests). */
  async start(): Promise<void> {
    if (this.#child && !this.#child.killed) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart();
    try { await this.#starting; } finally { this.#starting = undefined; }
  }

  async #doStart(): Promise<void> {
    if (this.#child && !this.#child.killed) return;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Point the child at ZCode's own bundled/personal provider configs when the
    // caller did not; these are configuration metadata, never credentials.
    if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      const discovered = newestBuiltinProviderConfig();
      if (discovered) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = discovered;
    }
    if (!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
      const personal = join(homedir(), ".zcode/v2/provider_config.json");
      if (existsSync(personal)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
    }
    let child: ChildProcessWithoutNullStreams;
    if (this.#sandbox) {
      // Managed execution (ADR-0012): the app-server runs inside a bubblewrap
      // sandbox; the connector cwd is the single rw-bound workspace root and
      // the parent env never enters (fail-closed probe happened at start-up).
      // The anchor-materials directory is pre-created so its read-only bind
      // (B5-3) exists from the first launch onward.
      const workspaceRoot = process.cwd();
      mkdirSync(join(workspaceRoot, ".roledock", "anchor-materials"), { recursive: true });
      const launch = await createSandboxLaunch({
        workspaceRoot,
        cliPath: this.#cliPath,
        nodeBin: process.execPath,
        egress: this.#sandbox.egress,
        providerBuiltinConfig: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
        providerPersonalConfig: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
        evidenceDir: join(workspaceRoot, ".roledock", "sandbox-evidence"),
      });
      this.#sandboxLaunch = launch;
      process.stderr.write(JSON.stringify({ kind: "roledock-sandbox-launch", runner: "bubblewrap", runtimeDir: launch.runtimeDir, args: launch.args }) + "\n");
      child = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    } else {
      child = spawn(process.execPath, [this.#cliPath, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
    }
    this.#child = child;
    // A fresh app-server instance has an empty provider registry; the
    // bootstrap must run again for every (re)started child.
    this.#bootstrap = undefined;
    this.#active.clear(); this.#subscribed.clear(); this.#pending.clear(); this.#events.clear(); this.#stderrTail = "";
    createInterface({ input: child.stdout }).on("line", line => this.receive(line));
    child.stderr.on("data", chunk => { this.#stderrTail = (this.#stderrTail + String(chunk)).slice(-4000); });
    child.on("error", error => { this.#stderrTail = error.message; });
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#sandboxLaunch?.stop();
      for (const { reject, timer } of this.#waiting.values()) { clearTimeout(timer); reject(new Error(`ZCode app-server exited (${code ?? signal}). ${truncate(this.#stderrTail, 500)}`)); }
      this.#waiting.clear();
    });
  }

  private write(value: ServerMessage): void {
    if (!this.#child?.stdin.writable) throw new Error("ZCode app-server is unavailable");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(line: string): void {
    let message: ServerMessage;
    try { message = JSON.parse(line) as ServerMessage; } catch { return; }
    if (message.id !== undefined && !message.method && this.#waiting.has(message.id)) {
      const entry = this.#waiting.get(message.id)!;
      clearTimeout(entry.timer); this.#waiting.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message || "ZCode error"} (${message.error.code ?? "unknown"})`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "session/event") {
      const id = message.params?.sessionId;
      if (typeof id === "string") {
        const queue = this.#events.get(id) ?? [];
        queue.push(message.params as HostEvent);
        if (queue.length > 500) queue.splice(0, queue.length - 500);
        this.#events.set(id, queue);
      }
      return;
    }
    if (message.id === undefined || !message.method) return;
    if (message.method === "session/requestRuntimePreferences") {
      this.write({ id: message.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } });
      return;
    }
    if (message.method === "interaction/requestOfficialMcpAuthHeaders") {
      this.write({ id: message.id, result: { headers: {} } });
      return;
    }
    if (message.method === "interaction/requestProviderRuntimeHeaders") {
      void this.answerProviderHeaders(message.params).then(
        result => this.write({ id: message.id, result }),
        error => this.write({ id: message.id, result: { headersApplied: false, errorMessage: truncate(String((error as Error)?.message ?? error), 200) } }),
      );
      return;
    }
    if (message.method.startsWith("interaction/")) {
      // Park permission/input requests for explicit human or operator answer;
      // this connector never auto-answers anything.
      const key = (message.params?.requestId as string | undefined) ?? String(message.id);
      const entry = this.#pending.get(key) ?? { method: message.method, params: message.params, envelopeIds: [] };
      entry.envelopeIds.push(message.id);
      this.#pending.set(key, entry);
      return;
    }
    this.write({ id: message.id, error: { code: -32601, message: "Unsupported client request" } });
  }

  /** Credentials stay outside this repo: an external helper answers, or the header request fails honestly. */
  #helperCall(req: Record<string, unknown>): Promise<unknown> {
    const helperCommand = this.#credentialHelper;
    if (!helperCommand) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const helper = spawn(helperCommand, [], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      let stdout = "";
      const timer = setTimeout(() => { helper.kill("SIGKILL"); reject(new Error("Credential helper timed out")); }, 10_000);
      helper.stdout.on("data", chunk => { stdout += String(chunk); });
      helper.on("exit", () => { clearTimeout(timer); try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Credential helper returned malformed JSON")); } });
      helper.on("error", error => { clearTimeout(timer); reject(error); });
      helper.stdin.write(`${JSON.stringify(req)}\n`);
      helper.stdin.end();
    });
  }

  private async answerProviderHeaders(params: Record<string, unknown> | undefined): Promise<unknown> {
    if (!this.#credentialHelper) return { headersApplied: false, errorMessage: "No credential helper configured for this reference connector." };
    return this.#helperCall({ providerId: params?.providerId ?? null });
  }

  /**
   * Register the caller-provided account providers with the app-server
   * registry before any send (official provider/updateAccountConfig; no
   * secrets — the helper computes the entitlement map). Without a helper the
   * registry stays empty and model turns fail on the host side.
   */
  #bootstrap: Promise<void> | undefined;
  #resolvedProvider: string | undefined;
  private ensureBootstrap(): Promise<void> {
    if (!this.#credentialHelper) return Promise.resolve();
    if (!this.#bootstrap) {
      this.#bootstrap = (async () => {
        const builtinPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? newestBuiltinProviderConfig();
        const answer = await this.#helperCall({ bootstrap: { builtinPath: builtinPath ?? null } }) as { params?: Record<string, unknown>; preferred?: string; error?: string };
        if (!answer.params) throw new Error(`Credential helper cannot register providers: ${answer.error ?? "no params"}`);
        this.#resolvedProvider = typeof answer.preferred === "string" ? answer.preferred : undefined;
        await this.rawCall("provider/updateAccountConfig", answer.params);
      })().catch(error => { this.#bootstrap = undefined; this.#resolvedProvider = undefined; throw error; });
    }
    return this.#bootstrap;
  }

  private rawCall(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => { this.#waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.#waiting.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.#waiting.delete(id); reject(error as Error); }
    });
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    await this.start();
    await this.ensureBootstrap();
    return this.rawCall(method, params, timeoutMs);
  }

  async ensure(sessionId: string, workspacePath?: string): Promise<void> {
    if (this.#active.has(sessionId)) return;
    const params: Record<string, unknown> = { sessionId };
    if (workspacePath) params.workspace = { workspacePath, workspaceKey: workspacePath };
    await this.call("session/resume", params);
    this.#active.add(sessionId);
  }

  markActive(sessionId: string): void { this.#active.add(sessionId); }

  /**
   * G3 discovery (docs/zcode-connector-tools.md §4.6): workspace-store-level
   * session enumeration (P6-G3 spike: a fresh app-server lists persisted
   * workspace sessions without any attach). Metadata only — no resume, no
   * read, no model turn.
   */
  async listSessions(workspacePath: string): Promise<Array<Record<string, unknown>>> {
    const listed = await this.call("session/list", { workspace: { workspacePath, workspaceKey: workspacePath } }) as { sessions?: Array<Record<string, unknown>> } | undefined;
    return Array.isArray(listed?.sessions) ? listed!.sessions.filter(entry => !!entry && typeof entry === "object") : [];
  }

  get provider(): string | undefined { return this.#provider ?? this.#resolvedProvider; }
  get model(): string | undefined { return this.#model; }

  async subscribe(sessionId: string): Promise<void> {
    if (this.#subscribed.has(sessionId)) return;
    await this.call("session/subscribe", { sessionId, deliveryKind: "desktop-continuous", includeSnapshot: false, afterSeq: 0 });
    this.#subscribed.add(sessionId);
  }

  pendingFor(sessionId: string): unknown[] {
    return [...this.#pending].filter(([, entry]) => entry.params?.sessionId === sessionId).map(([requestId, entry]) => ({ requestId, method: entry.method, ...entry.params }));
  }

  async status(sessionId: string, afterSeq = 0): Promise<Record<string, unknown>> {
    const state = await this.call("session/read", { sessionId }) as Record<string, any>;
    let events = this.#events.get(sessionId) ?? [];
    try {
      const pulled = await this.call("session/events", { sessionId, afterSeq }) as { events?: HostEvent[] } | undefined;
      if (Array.isArray(pulled?.events)) {
        const merged = new Map<number, HostEvent>([...events, ...pulled.events].filter(event => typeof event.seq === "number").map(event => [event.seq!, event]));
        events = [...merged.values()].sort((a, b) => a.seq! - b.seq!);
        this.#events.set(sessionId, events.slice(-500));
      }
    } catch { /* The push stream remains usable on CLI builds without session/events. */ }
    const recent = events.filter(event => (event.seq ?? 0) > afterSeq);
    const lastTerminal = [...events].reverse().find(event => event.type === "turn.completed" || event.type === "turn.failed");
    return {
      sessionId,
      title: state.session?.title,
      status: state.projection?.status ?? state.session?.status,
      mode: state.settings?.mode?.current ?? state.projection?.mode,
      model: state.settings?.model?.current,
      pendingRequests: this.pendingFor(sessionId),
      lastSeq: events.at(-1)?.seq ?? 0,
      lastTurn: lastTerminal ? { type: lastTerminal.type, response: lastTerminal.payload?.response, error: lastTerminal.payload?.error, usage: lastTerminal.payload?.usage } : null,
      // §4.1 requires a CONTIGUOUS seq window after afterSeq; the cap must
      // cover the whole window (bounded by the per-session buffer), not a
      // fixed 20 — long streaming turns otherwise become unreconcilable.
      recentEvents: recent.slice(-500).map(event => ({
        seq: event.seq, type: event.type, kind: event.payload?.kind, toolName: event.payload?.toolName,
        ...(event.type === "turn.completed" ? { response: truncate(event.payload?.response ?? "", 8000) } : {}),
        ...(event.type === "turn.failed" ? { error: event.payload?.error } : {}),
      })),
    };
  }

  /**
   * Authoritative identity for zcode_verify_session (docs/zcode-connector-tools.md §4.2).
   * session/resume is the existence oracle: an official "not found" error is a
   * definitive negative; success means the session exists and attaches to this
   * workspace. read/list are best-effort corroboration only — read fails with
   * "not active" for any session this app-server instance has not attached, so
   * it is never a negative, and list does not surface non-attached sessions.
   */
  async verify(sessionId: string, workspacePath: string): Promise<Record<string, unknown>> {
    try {
      await this.call("session/resume", { sessionId, workspace: { workspacePath, workspaceKey: workspacePath } });
    } catch (error) {
      if (/not found/i.test(String((error as Error)?.message))) return { sessionId, exists: false };
      throw error;
    }
    this.#active.add(sessionId);
    const state = await this.call("session/read", { sessionId }).then(
      value => value as Record<string, any>,
      () => undefined,
    );
    const listed = await this.call("session/list", { workspace: { workspacePath, workspaceKey: workspacePath } }).then(
      value => value as { sessions?: Array<Record<string, any>> } | undefined,
      () => undefined,
    );
    const member = Array.isArray(listed?.sessions) ? listed.sessions.find(entry => entry?.sessionId === sessionId) : undefined;
    if (listed && !member) throw new Error(`Session ${sessionId} identity is inconsistent: resumed but absent from the workspace list`);
    return {
      sessionId,
      exists: true,
      workspacePath: typeof member?.workspace?.workspacePath === "string" ? member.workspace.workspacePath : workspacePath,
      title: state?.session?.title,
      status: state?.projection?.status ?? state?.session?.status,
      mode: state?.settings?.mode?.current,
      model: state?.settings?.model?.current,
      updatedAt: member?.updatedAt,
    };
  }

  /** Full ordered event history from seq 0 (push stream merged with official pulls). */
  async collectEvents(sessionId: string): Promise<HostEvent[]> {
    await this.ensure(sessionId);
    const pulled = await this.call("session/events", { sessionId, afterSeq: 0 }) as { events?: HostEvent[] } | undefined;
    const merged = new Map<number, HostEvent>([...(this.#events.get(sessionId) ?? []), ...(pulled?.events ?? [])].filter(event => typeof event.seq === "number").map(event => [event.seq!, event]));
    const sorted = [...merged.values()].sort((a, b) => a.seq! - b.seq!);
    this.#events.set(sessionId, sorted.slice(-2000));
    return sorted;
  }

  /** Send the anchor load turn (docs/zcode-connector-tools.md §4.3); journals the intent before the send. */
  async loadMaterial(input: { sessionId: string; loadKey: string; contentHash: string; filePath: string }): Promise<Record<string, unknown>> {
    const provider = this.provider, model = this.model;
    if (!provider || !model) throw new Error("Provider/model are not configured on this reference connector; anchor load turns cannot be sent.");
    const prior = this.#loadRow(input.loadKey);
    if (prior?.state === "confirmed") return { sessionId: prior.session_id, loadKey: input.loadKey, accepted: true, marker: prior.marker ?? 0 };
    await this.ensure(input.sessionId);
    await this.subscribe(input.sessionId);
    const history = await this.collectEvents(input.sessionId);
    const marker = history.at(-1)?.seq ?? 0;
    this.#saveLoad(input.loadKey, input.sessionId, input.contentHash, "loading", null, undefined);
    const message = [
      "[RoleDock anchor material load]",
      loadHeader(input.loadKey),
      `sha256:${input.contentHash}`,
      `Read the file at ${input.filePath} and verify its header declares exactly the load key and sha256 above.`,
      `Then reply with exactly one line: ${loadMarker(input.loadKey, input.contentHash)}`,
    ].join("\n");
    const result = await this.call("session/send", { sessionId: input.sessionId, content: message, modelSelection: { providerId: provider, modelId: model, options: { reasoningLevel: "low" } } }) as { accepted?: boolean };
    if (result?.accepted !== true) throw new Error("ZCode did not accept the anchor material load turn.");
    this.#saveLoad(input.loadKey, input.sessionId, input.contentHash, "loading", marker, undefined);
    return { sessionId: input.sessionId, loadKey: input.loadKey, accepted: true, marker };
  }

  /**
   * Authoritative anchor load lookup. Live event windows are verified first;
   * the persistent journal replays confirmations across connector restarts
   * (the app-server does not replay pre-resume events on session/events).
   */
  async lookupLoad(input: { sessionId: string; loadKey: string; contentHash: string }): Promise<Record<string, unknown>> {
    const row = this.#loadRow(input.loadKey);
    if (row?.state === "confirmed" && row.confirmation_json) return { state: "loaded", confirmation: JSON.parse(row.confirmation_json) };
    if (row && row.session_id !== input.sessionId) return { state: "unknown", reason: "load_key belongs to another session" };
    const events = await this.collectEvents(input.sessionId);
    const verdict = verifyLoadWindow(events, input.loadKey, input.contentHash);
    if (verdict.state === "absent" && !row) return { state: "absent" };
    if (verdict.state === "loaded") {
      const confirmation = { host_session_id: input.sessionId, load_key: input.loadKey, content_hash: input.contentHash, load_version: verdict.version! };
      this.#saveLoad(input.loadKey, input.sessionId, input.contentHash, "confirmed", row?.marker ?? null, confirmation);
      return { state: "loaded", confirmation };
    }
    return { state: "unknown", reason: verdict.reason };
  }

  /** Official session/stop: abort the active turn. A no-op when idle; never a close. */
  async cancelTurn(sessionId: string): Promise<Record<string, unknown>> {
    await this.ensure(sessionId);
    await this.call("session/stop", { sessionId });
    return { sessionId, stop_signal_sent: true };
  }

  /** Official session/close: the host deletes its event store; closed:false is reported verbatim. */
  async closeSession(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.call("session/close", { sessionId }) as { closed?: boolean };
    return { sessionId, closed: result?.closed === true };
  }
}

/** Scoped verdict for one anchor load turn window (B3; see docs/zcode-connector-tools.md §4.3). */
function windowVerdict(events: HostEvent[], start: HostEvent): { verdict: "loaded" | "unknown"; reason: string } {
  const input = String(start.payload?.input ?? "");
  const key = /roledock-anchor-load\/([\w.-]+)/.exec(input)?.[1];
  const hash = /sha256:([0-9a-f]{64})/.exec(input)?.[1];
  if (key === undefined || hash === undefined) return { verdict: "unknown", reason: "load turn message lacks a parsable key/hash" };
  const after = events.filter(event => (event.seq ?? 0) > (start.seq ?? 0));
  const terminalIndex = after.findIndex(event => event.type === "turn.completed" || event.type === "turn.failed");
  if (terminalIndex === -1) return { verdict: "unknown", reason: "load turn has no terminal event yet" };
  const scoped = after.slice(0, terminalIndex + 1);
  const terminal = scoped[terminalIndex]!;
  if (terminal.type === "turn.failed") return { verdict: "unknown", reason: `load turn failed on the host: ${String((terminal.payload?.error as { message?: unknown } | undefined)?.message ?? JSON.stringify(terminal.payload?.error ?? "")).slice(0, 300)}` };
  const consumed = scoped.some(event => {
    if (event.type !== "tool.updated") return false;
    const result = event.payload?.result as { success?: unknown; content?: unknown; truncated?: unknown } | undefined;
    return result?.success === true && result.truncated !== true && typeof result.content === "string" && result.content.includes(loadHeader(key)) && result.content.includes(`sha256:${hash}`);
  });
  if (!consumed) return { verdict: "unknown", reason: "no successful untruncated tool result carried the material header" };
  const response = String(terminal.payload?.response ?? "");
  if (!response.includes(loadMarker(key, hash))) return { verdict: "unknown", reason: "terminal response lacks the exact load marker" };
  return { verdict: "loaded", reason: "ok" };
}

function verifyLoadWindow(events: HostEvent[], loadKey: string, contentHash: string): { state: "absent" | "unknown" | "loaded"; version?: number; reason: string } {
  const header = loadHeader(loadKey);
  const starts = events.filter(event => event.type === "turn.started" && typeof event.payload?.input === "string" && (event.payload.input as string).includes(header));
  if (starts.length === 0) return { state: "absent", reason: "no load turn in session history" };
  if (starts.length !== 1) return { state: "unknown", reason: `expected one load turn for this key, found ${starts.length}` };
  const verdict = windowVerdict(events, starts[0]!);
  if (verdict.verdict !== "loaded") return { state: "unknown", reason: verdict.reason };
  const confirmed: string[] = [];
  for (const start of events.filter(event => event.type === "turn.started" && typeof event.payload?.input === "string" && (event.payload.input as string).includes("roledock-anchor-load/"))) {
    const key = /roledock-anchor-load\/([\w.-]+)/.exec(String(start.payload?.input))?.[1];
    if (key === undefined || confirmed.includes(key)) continue;
    if (windowVerdict(events, start).verdict === "loaded") confirmed.push(key);
  }
  return { state: "loaded", version: confirmed.indexOf(loadKey) + 1, reason: "ok" };
}

function newestBuiltinProviderConfig(): string | undefined {
  try {
    const root = join(homedir(), ".zcode/v2/runtime/provider");
    const found: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) stack.push(path);
        else if (item.name === "zcode-builtin.json") found.push(path);
      }
    }
    found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return found[0];
  } catch { return undefined; }
}

const string = { type: "string", minLength: 1 };
function tool(name: string, description: string, properties: Record<string, object>, required: string[] = Object.keys(properties)): Tool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export const REFERENCE_TOOLS: readonly Tool[] = [
  tool("zcode_create_session", "Create a ZCode CLI conversation in a workspace. Returns its session ID; a model account is only needed when sending turns.", { workspacePath: string, mode: { type: "string", enum: ["build", "edit", "plan", "yolo"], description: "Permission mode declaration; the reference connector defaults to plan" } }, ["workspacePath"]),
  tool("zcode_list_sessions", "List persisted ZCode sessions for a workspace (metadata only: IDs, titles, status). Read-only: never creates or attaches a session and spends no model turn.", { workspacePath: string }, ["workspacePath"]),
  tool("zcode_verify_session", "Authoritative session identity: confirm existence via session/resume. No model turn is spent.", { sessionId: string, workspacePath: string }),
  tool("zcode_send", "Send one turn to an existing ZCode conversation. Requires the connector to be configured with --provider/--model and a credential helper; returns immediately.", { sessionId: string, message: string, workspacePath: string, reasoningLevel: { type: "string", enum: ["low", "high", "max"] } }, ["sessionId", "message"]),
  tool("zcode_status", "Read execution status, recent events, final answer and pending permission/input requests.", { sessionId: string, workspacePath: string, afterSeq: { type: "integer", minimum: 0 } }, ["sessionId"]),
  tool("zcode_load_material", "Send the anchor material load turn for a content-addressed material file; returns the event marker to poll. Requires provider/model config.", { sessionId: string, workspacePath: string, loadKey: string, contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" }, filePath: string }, ["sessionId", "workspacePath", "loadKey", "contentHash", "filePath"]),
  tool("zcode_lookup_load", "Authoritative anchor load lookup from the persisted session history: loaded/absent/unknown with a strict confirmation.", { sessionId: string, workspacePath: string, loadKey: string, contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["sessionId", "workspacePath", "loadKey", "contentHash"]),
  tool("zcode_cancel", "Abort the session's active turn via the official session/stop. An honest no-op signal when the host is idle; never a close.", { sessionId: string }, ["sessionId"]),
  tool("zcode_close", "Close and reclaim the persisted session via the official session/close (host deletes its event store). Returns closed:true/false; never claims more than the host answered.", { sessionId: string }, ["sessionId"]),
  tool("zcode_sandbox_status", "Report whether this connector runs the app-server inside the managed sandbox (B5-3). The adapter refuses managed sessions unless this says sandboxed with a matching egress list.", {}, []),
];

async function dispatch(name: string, args: Record<string, unknown>, host: AppServerClient): Promise<unknown> {
  if (name === "zcode_create_session") {
    const workspacePath = requireDirectory(args.workspacePath, "workspacePath");
    const mode = typeof args.mode === "string" && ["build", "edit", "plan", "yolo"].includes(args.mode) ? args.mode : "plan";
    const result = await host.call("session/create", { workspace: { workspacePath, workspaceKey: workspacePath }, mode, persistence: "immediate" }) as Record<string, any>;
    const sessionId = result?.session?.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("ZCode did not return a valid session ID");
    host.markActive(sessionId);
    return { sessionId, workspacePath, mode, ...(Array.isArray(result?.settings?.model?.available) && result.settings.model.available.length === 0 ? { warning: "No model is configured; sending turns will fail until an account is available." } : {}) };
  }
  if (name === "zcode_verify_session") {
    const sessionId = requireSessionId(args.sessionId);
    const workspacePath = requireDirectory(args.workspacePath, "workspacePath");
    return host.verify(sessionId, workspacePath);
  }
  if (name === "zcode_sandbox_status") return host.sandboxStatus;
  if (name === "zcode_list_sessions") {
    const workspacePath = requireDirectory(args.workspacePath, "workspacePath");
    return { sessions: await host.listSessions(workspacePath) };
  }
  const sessionId = requireSessionId(args.sessionId);
  if (name === "zcode_send") {
    if (typeof args.message !== "string" || !args.message.trim()) throw new Error("message must be a non-empty string");
    const workspacePath = typeof args.workspacePath === "string" ? args.workspacePath : undefined;
    await host.ensure(sessionId, workspacePath);
    await host.subscribe(sessionId);
    const reasoningLevel = typeof args.reasoningLevel === "string" && ["low", "high", "max"].includes(args.reasoningLevel) ? args.reasoningLevel : "low";
    const result = await host.call("session/send", { sessionId, content: args.message, modelSelection: { providerId: host.provider, modelId: host.model, options: { reasoningLevel } } }) as Record<string, any>;
    return { sessionId, accepted: result?.accepted === true };
  }
  if (name === "zcode_status") {
    const workspacePath = typeof args.workspacePath === "string" ? args.workspacePath : undefined;
    await host.ensure(sessionId, workspacePath);
    return host.status(sessionId, typeof args.afterSeq === "number" && args.afterSeq >= 0 ? args.afterSeq : 0);
  }
  if (name === "zcode_load_material") {
    const workspacePath = requireDirectory(args.workspacePath, "workspacePath");
    const loadKey = typeof args.loadKey === "string" && /^[\w.-]{1,128}$/.test(args.loadKey) ? args.loadKey : null;
    const contentHash = typeof args.contentHash === "string" && /^[0-9a-f]{64}$/.test(args.contentHash) ? args.contentHash : null;
    const filePath = typeof args.filePath === "string" && isAbsolute(args.filePath) ? args.filePath : null;
    if (!loadKey || !contentHash || !filePath) throw new Error("loadKey, contentHash and an absolute filePath are required.");
    return host.loadMaterial({ sessionId, loadKey, contentHash, filePath });
  }
  if (name === "zcode_lookup_load") {
    if (typeof args.workspacePath !== "string") throw new Error("workspacePath must be a string");
    const loadKey = typeof args.loadKey === "string" && /^[\w.-]{1,128}$/.test(args.loadKey) ? args.loadKey : null;
    const contentHash = typeof args.contentHash === "string" && /^[0-9a-f]{64}$/.test(args.contentHash) ? args.contentHash : null;
    if (!loadKey || !contentHash) throw new Error("loadKey and contentHash are required.");
    return host.lookupLoad({ sessionId, loadKey, contentHash });
  }
  if (name === "zcode_cancel") return host.cancelTurn(sessionId);
  if (name === "zcode_close") return host.closeSession(sessionId);
  throw new Error(`Unknown tool: ${name}`);
}

/** Shared options for the reference connector entry points (managed mode is opt-in via `sandbox`). */
export interface ReferenceConnectorOptions {
  cliPath: string;
  credentialHelper?: string;
  provider?: string;
  model?: string;
  journal?: string;
  /** Managed sandbox execution (docs/zcode-connector-tools.md §4.5). Egress is a host[:port] allowlist; the sandbox refuses to start when no runner is available. */
  sandbox?: { egress: readonly string[] };
}

/** Build the MCP stdio server for this connector; the caller owns connect/lifecycle. */
export function createReferenceConnectorServer(options: ReferenceConnectorOptions): Server {
  if (options.sandbox && (!Array.isArray(options.sandbox.egress) || options.sandbox.egress.some(entry => typeof entry !== "string"))) {
    throw new RoleDockError("VALIDATION_FAILED", "sandbox.egress must be an array of host[:port] strings.");
  }
  const host = new AppServerClient(options);
  const server = new Server({ name: REFERENCE_CONNECTOR_NAME, version: REFERENCE_CONNECTOR_VERSION }, {
    capabilities: { tools: {} },
    instructions: "Reference connector bridging RoleDock diagnostics to the official ZCode CLI app-server. It never reads credential stores: provider headers come from the caller-provided helper, and parked interaction requests are never auto-answered.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(REFERENCE_TOOLS) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const value = await dispatch(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, host);
      return { content: [{ type: "text", text: truncate(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: truncate(String((error as Error)?.message ?? error)) }] };
    }
  });
  return server;
}

/** stdio entry: run the reference connector in the foreground. */
export async function runReferenceConnector(options: ReferenceConnectorOptions): Promise<void> {
  if (options.sandbox) {
    // Fail closed: probe before anything binds or listens; without a runner
    // there is no isolation boundary, so managed mode refuses rather than
    // running unsandboxed while anything claims isolation.
    const runner = await probeSandboxRunner();
    if (!runner.available) {
      throw new RoleDockError("NOT_IMPLEMENTED", `Managed sandbox execution is unavailable on this machine (${runner.reason ?? "no sandbox runner"}); refusing to start without the sandbox boundary (fail-closed).`);
    }
  }
  const server = createReferenceConnectorServer(options);
  await server.connect(new StdioServerTransport());
}
