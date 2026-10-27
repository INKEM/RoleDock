import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ServiceClient, ServiceRequestTimeoutError } from "@roledock/service";
import type { ServiceCredential } from "@roledock/service";
import type { WorkspaceServiceInfo } from "@roledock/protocol";

export type WorkspaceState = "starting" | "running" | "stopping" | "disconnected" | "error" | "conflict";

export interface WorkspaceHandle {
  dir: string;
  owned: boolean;
  /** mock（诊断）或 zcode（真实配置接入） */
  mode: "mock" | "zcode" | null;
  state: WorkspaceState;
  pid: number | null;
  socketPath: string | null;
  workspaceId: string | null;
  lastRefreshAt: string | null;
  error: string | null;
}

const OWNER_FILE_MODE_MASK = 0o077;
const STOP_GRACE_MS = 8000;

/**
 * Workspace service lifecycle owner (DESKTOP_GUI_PLAN §4.3; contract §7).
 *
 * Ownership rule (G1-R02): a handle is `owned` only when THIS shell spawned
 * the service. Re-opening a directory whose owned child is still alive keeps
 * the original handle (ownership, child, pid) — only genuinely external
 * services become attached handles. Directory keys are realpath-normalized
 * so path aliases cannot fork handles, and concurrent opens of one directory
 * share a single in-flight start.
 *
 * Attachment rule (G1-R01): a successful attach stores the VERIFIED owner
 * credential in the trusted process so confirm/diagnostics/health work;
 * refreshes honestly mark disconnection. Endpoints that cannot prove
 * ownership surface as `conflict` and are never overwritten.
 */
export class WorkspaceSupervisor {
  readonly #nodePath: string;
  readonly #bundlePath: string;
  readonly #handles = new Map<string, InternalHandle>();
  readonly #opening = new Map<string, Promise<WorkspaceHandle>>();
  readonly #onChange: (handle: WorkspaceHandle) => void;

  constructor(options: { nodePath: string; bundlePath: string; onChange?: (handle: WorkspaceHandle) => void }) {
    this.#nodePath = options.nodePath;
    this.#bundlePath = options.bundlePath;
    this.#onChange = options.onChange ?? (() => undefined);
  }

  /** Canonical handle key: path aliases must not fork workspace state. */
  static normalize(dir: string): string {
    if (!isAbsolute(dir)) dir = resolve(dir);
    try { return realpathSync(dir); } catch { return resolve(dir); }
  }

  get(dir: string): WorkspaceHandle | undefined {
    const handle = this.#handles.get(WorkspaceSupervisor.normalize(dir));
    return handle ? this.#view(handle) : undefined;
  }

  list(): WorkspaceHandle[] {
    return [...this.#handles.values()].map(handle => this.#view(handle));
  }

  /** Owner client for the trusted main process (confirm page, diagnostics). */
  ownerClient(dir: string): ServiceClient | undefined {
    const handle = this.#handles.get(WorkspaceSupervisor.normalize(dir));
    return handle?.credential ? new ServiceClient(handle.credential) : undefined;
  }

  /** Attach to a live endpoint, or start an owned service for the directory. */
  open(dirInput: string, launcher?: { configPath: string }): Promise<WorkspaceHandle> {
    const dir = WorkspaceSupervisor.normalize(dirInput);
    // G1-R02: in-flight opens are shared FIRST — concurrent callers of the
    // same directory all await the same readiness/failure result instead of
    // observing the intermediate "starting" handle.
    const inFlight = this.#opening.get(dir);
    if (inFlight) return inFlight;
    const existing = this.#handles.get(dir);
    // G1-R02: only a verified-alive owned service keeps its handle verbatim.
    // A signal-killed child (exitCode null but signalCode set / exit seen)
    // must fall through to a fresh start, never be reused.
    if (existing?.owned && existing.state === "running" && isAlive(existing)) {
      return Promise.resolve(this.#view(existing));
    }
    // G2-R02 (re-review): the per-workspace config file is the persisted
    // launch reference. A CORRUPT/broken reference is an explicit error —
    // never a silent fallback to mock on an established workspace.
    const persisted = persistedLauncher(dir);
    if (persisted.kind === "error" && !launcher) {
      return Promise.resolve(this.#put({ dir, owned: false, state: "error", pid: null, socketPath: null, workspaceId: null, error: `持久化启动配置不可用（${persisted.detail}）；已保留原端点，不会改用 mock 启动。请修复或删除该配置后重试` }));
    }
    const effectiveLauncher = launcher ?? (persisted.kind === "present" ? persisted.launcher : undefined);
    const task = this.#openUncached(dir, effectiveLauncher).finally(() => this.#opening.delete(dir));
    this.#opening.set(dir, task);
    return task;
  }

  async #openUncached(dir: string, launcher?: { configPath: string }): Promise<WorkspaceHandle> {
    const endpoint = readOwnerCredential(dir);
    if (endpoint.kind === "conflict") {
      return this.#put({ dir, owned: false, state: "conflict", pid: null, socketPath: endpoint.socketPath ?? null, workspaceId: null, error: endpoint.error });
    }
    if (endpoint.kind === "present") {
      const info = await probeInfo(endpoint.credential, 3000);
      if (info.ok) {
        // G2-R01 (re-review): bind the selected directory to the endpoint's
        // workspace_id via the persistent identity file. The file survives
        // normal stops, so a live attach MUST prove directory↔workspace
        // identity — missing or corrupt identity is a conflict too, never a
        // reason to attach unverified (an unproven endpoint may belong to
        // another workspace).
        const expected = readWorkspaceId(dir);
        if (expected.kind === "corrupt") {
          return this.#put({ dir, owned: false, state: "conflict", pid: null, socketPath: endpoint.credential.socket_path, workspaceId: info.workspaceId, error: `目录身份文件损坏（${expected.detail}），无法证明端点归属；已拒绝附着与写操作` });
        }
        if (expected.kind === "absent") {
          return this.#put({ dir, owned: false, state: "conflict", pid: null, socketPath: endpoint.credential.socket_path, workspaceId: info.workspaceId, error: "目录缺少身份记录（workspace-id），无法证明端点归属；已拒绝附着与写操作。新工作空间请以服务模式启动以建立身份" });
        }
        if (expected.workspaceId !== info.workspaceId) {
          return this.#put({ dir, owned: false, state: "conflict", pid: null, socketPath: endpoint.credential.socket_path, workspaceId: info.workspaceId, error: `目录身份不匹配：目录记录 ${expected.workspaceId}，端点实际 ${info.workspaceId}；已拒绝附着，不执行任何写操作` });
        }
        // G1-R01: keep the verified credential for owner RPC (confirm page,
        // diagnostics) and honest health refreshes. Never exposed to UI.
        const mode = info.adapter === "mock" ? "mock" as const : info.adapter === "zcode" ? "zcode" as const : null;
        return this.#put({ dir, owned: false, mode, state: "running", pid: info.pid, socketPath: endpoint.credential.socket_path, workspaceId: info.workspaceId, error: null, credential: endpoint.credential, lastRefreshAt: new Date().toISOString() });
      }
      if (info.permissionDenied) {
        // A live endpoint answered 401: the credential does not belong to us.
        // Never overwrite; surface the conflict.
        return this.#put({ dir, owned: false, state: "conflict", pid: null, socketPath: endpoint.credential.socket_path, workspaceId: null, error: `owner 端点拒绝了本凭据（${info.error}）；不附着、不覆盖` });
      }
      // Present but not answering (dead endpoint). Starting is safe: the
      // service recovers only same-uid DEAD sockets and refuses a live or
      // foreign endpoint (recoverStaleSocket), so no overwrite can happen.
      return this.#start(dir, launcher);
    }
    return this.#start(dir, launcher);
  }

  async #start(dir: string, launcher?: { configPath: string }): Promise<WorkspaceHandle> {
    try { accessSync(dir, constants.W_OK); } catch { return this.#put({ dir, owned: true, state: "error", pid: null, socketPath: null, workspaceId: null, error: "目录不可写，无法创建工作空间服务" }); }
    const existing = this.#handles.get(dir);
    // Belt against a lost in-flight record: never spawn a second writer over
    // an owned child that is verifiably still alive.
    if (existing?.owned && isAlive(existing)) return this.#view(existing);
    const mode: "mock" | "zcode" = launcher ? "zcode" : "mock";
    // Structured argv, no shell: mock diagnostics vs the real configured
    // launcher (config JSON written 0600 by the shell beforehand).
    const argv = launcher
      ? [this.#bundlePath, "--workspace-config", launcher.configPath, dir]
      : [this.#bundlePath, "--mock-workspace", dir];
    const handle: InternalHandle = { dir, owned: true, mode, state: "starting", pid: null, socketPath: null, workspaceId: null, lastRefreshAt: null, error: null, child: undefined, credential: undefined, exited: false, launcher };
    this.#handles.set(dir, handle);
    this.#emit(handle);
    let output = "";
    // Minimal, whitelist-only environment (G1 posture, adjusted in G3 for the
    // real connector/helper chain): nothing from the desktop's own shell env
    // leaks. PATH puts the LOCKED runtime first so `#!/usr/bin/env node`
    // helpers resolve to Node 22.23.2 — the system /usr/bin/node is older and
    // cannot parse the helper's modern syntax (P6-G3 field evidence); HOME is
    // required for provider/credential discovery (ADR-0014 §9.2).
    const child = spawn(this.#nodePath, argv, {
      env: { PATH: `${dirname(this.#nodePath)}:/usr/bin:/bin`, HOME: homedir(), TMPDIR: tmpdir(), LANG: process.env.LANG ?? "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    handle.child = child;
    handle.pid = child.pid ?? null;
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("exit", (code, signal) => {
      handle.exited = true;
      if (handle.state !== "stopping" && handle.state !== "error") {
        handle.state = "disconnected";
        handle.pid = null;
        handle.error = `服务进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）`;
        this.#emit(handle);
      }
    });
    try {
      // Readiness = the owner file exists AND its credential actually answers
      // workspace.info. A crashed predecessor leaves a stale file behind; the
      // new service rewrites it — validating probes skip the stale window.
      const credential = await waitFor(async () => {
        if (!isAlive(handle)) throw new Error(`服务在就绪前退出：${tail(output)}`);
        const parsed = readOwnerCredential(dir);
        if (parsed.kind !== "present") return undefined;
        const probe = await probeInfo(parsed.credential, 800);
        return probe.ok ? parsed.credential : undefined;
      }, 20000, 100);
      if (!isAlive(handle)) throw new Error(`服务在就绪前退出：${tail(output)}`);
      const info = await probeInfo(credential, 10000);
      if (!info.ok) throw new Error(`服务就绪校验失败：${info.error}`);
      const expected = readWorkspaceId(dir);
      const identityMismatch = expected.kind === "corrupt"
        || (expected.kind === "present" && expected.workspaceId !== info.workspaceId);
      if (identityMismatch) {
        handle.state = "conflict";
        handle.error = expected.kind === "corrupt"
          ? `目录身份文件损坍，无法证明服务归属`
          : `目录身份不匹配：目录记录 ${expected.workspaceId}，服务实际 ${info.workspaceId}`;
        this.#emit(handle);
        return this.#view(handle);
      }
      handle.credential = credential;
      handle.socketPath = credential.socket_path;
      handle.workspaceId = info.workspaceId;
      handle.pid = info.pid ?? child.pid ?? null;
      handle.state = "running";
      handle.lastRefreshAt = new Date().toISOString();
      this.#emit(handle);
      return this.#view(handle);
    } catch (error) {
      handle.state = isAlive(handle) ? "error" : "disconnected";
      // Prefer the child's own refusal reason (e.g. the service's foreign /
      // non-socket endpoint guard) over the transport error when it exited.
      const exitMessage = await waitFor(() => (!isAlive(handle) ? tail(output) : undefined), 3000, 100).catch(() => undefined);
      handle.error = exitMessage ? `服务启动失败：${exitMessage}` : error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      if (isAlive(handle)) child.kill("SIGTERM");
      this.#emit(handle);
      return this.#view(handle);
    }
  }

  /** Bounded stop: SIGTERM, grace wait, then SIGKILL. Cancelling the UI wait never cancels the stop. */
  async stop(dirInput: string, graceMs = STOP_GRACE_MS): Promise<WorkspaceHandle> {
    const dir = WorkspaceSupervisor.normalize(dirInput);
    const inFlight = this.#opening.get(dir);
    if (inFlight) await inFlight.catch(() => undefined);
    const handle = this.#handles.get(dir);
    if (!handle) throw new Error("该目录没有已打开的工作空间。");
    if (!handle.owned || !isAlive(handle)) {
      // Attached external services are never killed; UI detach only. An
      // already-dead child must not wait for an exit event that never
      // re-fires — clean up immediately.
      this.#handles.delete(dir);
      this.#emit(handle);
      return this.#view(handle);
    }
    handle.state = "stopping";
    this.#emit(handle);
    const child = handle.child;
    child.kill("SIGTERM");
    const forced = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(true); }, graceMs);
      child.once("exit", () => { clearTimeout(timer); resolve(false); });
    });
    // The workspace state file keeps execution/recovery uncertainty; the next
    // start reconciles from persisted state (never dropped for a fast exit).
    this.#handles.delete(dir);
    const final: WorkspaceHandle = { dir, owned: false, mode: handle.mode, state: "running", pid: null, socketPath: null, workspaceId: handle.workspaceId, lastRefreshAt: handle.lastRefreshAt, error: forced ? `宽限期 ${graceMs}ms 用尽后强制结束（SIGKILL）；持久状态保留待对账` : null };
    this.#emit({ ...final, child: undefined, credential: undefined, exited: true });
    return final;
  }

  async restart(dirInput: string): Promise<WorkspaceHandle> {
    const dir = WorkspaceSupervisor.normalize(dirInput);
    const handle = this.#handles.get(dir);
    if (handle?.owned && isAlive(handle)) await this.stop(dir);
    // G2-R02: restart keeps the workspace's own launcher (never falls back
    // to mock); open() additionally prefers the persisted config file.
    return this.open(dir, handle?.launcher);
  }

  /** Health refresh against the live endpoint; keeps lastRefreshAt honest. */
  async refresh(dirInput: string): Promise<WorkspaceHandle> {
    const dir = WorkspaceSupervisor.normalize(dirInput);
    const handle = this.#handles.get(dir);
    if (!handle) throw new Error("该目录没有已打开的工作空间。");
    if (!handle.credential) return this.#view(handle);
    const info = await probeInfo(handle.credential, 2000);
    handle.lastRefreshAt = new Date().toISOString();
    if (info.ok) {
      if (handle.state === "disconnected" || handle.state === "running") handle.state = "running";
      handle.workspaceId = info.workspaceId;
      if (info.pid) handle.pid = info.pid;
      handle.error = null;
    } else if (handle.state === "running") {
      handle.state = "disconnected";
      handle.error = `健康检查失败：${info.error}`;
    }
    this.#emit(handle);
    return this.#view(handle);
  }

  /** Reap every owned child (bounded); external handles are left untouched. */
  async reapOwned(graceMs = STOP_GRACE_MS): Promise<Array<{ dir: string; forced: boolean }>> {
    const results: Array<{ dir: string; forced: boolean }> = [];
    for (const dir of [...this.#handles.keys()]) {
      const handle = this.#handles.get(dir)!;
      if (!handle.owned || !isAlive(handle)) {
        // Dead children (including signal-ended ones) need no reap; external
        // handles are never touched.
        if (handle.owned) this.#handles.delete(dir);
        continue;
      }
      handle.state = "stopping";
      const child = handle.child!;
      child.kill("SIGTERM");
      const forced = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(true); }, graceMs);
        child.once("exit", () => { clearTimeout(timer); resolve(false); });
      });
      this.#handles.delete(dir);
      results.push({ dir, forced });
    }
    return results;
  }

  #put(patch: Omit<Partial<InternalHandle>, "child"> & { dir: string }): WorkspaceHandle {
    const existing = this.#handles.get(patch.dir);
    const handle: InternalHandle = { ...(existing ?? { child: undefined, credential: undefined, lastRefreshAt: null }), ...patch } as InternalHandle;
    this.#handles.set(handle.dir, handle);
    this.#emit(handle);
    return this.#view(handle);
  }

  #emit(handle: InternalHandle): void {
    this.#onChange(this.#view(handle));
  }

  #view(handle: InternalHandle): WorkspaceHandle {
    return { dir: handle.dir, owned: handle.owned, mode: handle.mode ?? null, state: handle.state, pid: handle.pid, socketPath: handle.socketPath, workspaceId: handle.workspaceId, lastRefreshAt: handle.lastRefreshAt, error: handle.error };
  }
}

interface InternalHandle extends WorkspaceHandle {
  child?: ChildProcess;
  credential?: ServiceCredential;
  /** Set by the child's exit event; authoritative across signal exits where
   * `exitCode` stays null while `signalCode` is set (G1-R02). */
  exited: boolean;
  /** Per-workspace launch reference (G2-R02): survives restart/crash-reopen. */
  launcher?: { configPath: string };
}

/**
 * Unified liveness for an owned child: the exit event is the authoritative
 * signal (a SIGKILLed child keeps `exitCode === null` while `signalCode` is
 * set — checking exitCode alone misjudges it as alive).
 */
function isAlive(handle: InternalHandle): handle is InternalHandle & { child: ChildProcess } {
  return !!handle.child && !handle.exited && handle.child.exitCode === null && handle.child.signalCode === null;
}

type Endpoint = { kind: "absent" } | { kind: "present"; credential: ServiceCredential } | { kind: "conflict"; error: string; socketPath: string | null };

/** Service-persisted workspace identity (G2-R01, kept across normal stops):
 * present = verified binding, absent = never-established record, corrupt =
 * unusable endpoint file. Absent/corrupt identity + a live endpoint is a
 * conflict — never silently attachable. */
function readWorkspaceId(dir: string): { kind: "absent" } | { kind: "present"; workspaceId: string } | { kind: "corrupt"; detail: string } {
  const path = join(dir, ".roledock", "workspace-id");
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", detail: `不可读取（${(error as NodeJS.ErrnoException).code}）` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "corrupt", detail: "非常规文件" };
  try {
    const value = readFileSync(path, "utf8").trim();
    if (/^ws-[0-9a-f]{4,}$/.test(value)) return { kind: "present", workspaceId: value };
    return { kind: "corrupt", detail: "内容不是有效 workspace_id" };
  } catch {
    return { kind: "corrupt", detail: "不可读取" };
  }
}

/** Persisted per-workspace launch reference (G2-R02, re-review): absent =
 * fresh/mock-eligible workspace, present = the launcher to reuse, error =
 * a broken/corrupt reference that must fail loudly instead of falling back
 * to mock on an established real workspace. */
function persistedLauncher(dir: string): { kind: "absent" } | { kind: "present"; launcher: { configPath: string } } | { kind: "error"; detail: string } {
  const path = join(dir, ".roledock", "launcher-config.json");
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "error", detail: `不可检查（${(error as NodeJS.ErrnoException).code}）` };
  }
  if (stat.isSymbolicLink()) return { kind: "error", detail: "配置是符号链接" };
  if (!stat.isFile()) return { kind: "error", detail: "配置不是常规文件" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { kind?: unknown };
    if (parsed.kind !== "zcode") return { kind: "error", detail: "配置类型不可识别" };
    return { kind: "present", launcher: { configPath: path } };
  } catch {
    return { kind: "error", detail: "配置内容损坍" };
  }
}

/** Same ownership checks as the accepted G-min entry (regular file, own uid, mode 0600). */
function readOwnerCredential(dir: string): Endpoint {
  const path = join(dir, ".roledock", "owner-connection.json");
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "conflict", error: `owner 端点不可读：${(error as NodeJS.ErrnoException).code ?? error}`, socketPath: null };
  }
  if (!stat.isFile()) return { kind: "conflict", error: "owner 端点不是常规文件，拒绝使用。", socketPath: null };
  if (stat.uid !== process.getuid?.()) return { kind: "conflict", error: "owner 端点属于其他用户，拒绝附着。", socketPath: null };
  if (stat.mode & OWNER_FILE_MODE_MASK) return { kind: "conflict", error: "owner 端点权限过宽（须 0600），拒绝使用。", socketPath: null };
  try {
    const credential = JSON.parse(readFileSync(path, "utf8")) as ServiceCredential;
    if (typeof credential.socket_path !== "string" || typeof credential.token !== "string") throw new Error("格式不符");
    return { kind: "present", credential };
  } catch {
    return { kind: "conflict", error: "owner 端点内容不是有效凭据，拒绝使用。", socketPath: null };
  }
}

async function probeInfo(credential: ServiceCredential, timeoutMs: number): Promise<{ ok: true; workspaceId: string; pid: number | null; adapter: string | null } | { ok: false; error: string; permissionDenied: boolean }> {
  try {
    const info = await new ServiceClient(credential).call<WorkspaceServiceInfo>("workspace.info", {}, { timeoutMs });
    return { ok: true, workspaceId: info.workspace_id, pid: typeof info.service?.pid === "number" ? info.service.pid : null, adapter: typeof info.service?.adapter === "string" ? info.service.adapter : null };
  } catch (error) {
    const detail = error instanceof ServiceRequestTimeoutError ? "等待超时" : error instanceof Error ? error.message : String(error);
    const permissionDenied = error instanceof Error && "code" in error && (error as { code?: string }).code === "PERMISSION_DENIED";
    return { ok: false, error: detail.slice(0, 200), permissionDenied };
  }
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number, intervalMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待 owner 端点超时（${timeoutMs}ms）。`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function tail(text: string): string {
  return text.trim().slice(-300);
}
