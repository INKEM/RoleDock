import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ServiceClient } from "@roledock/service";
import { channelFor, redact, PROBE_METHODS, SQLITE_BUSY_PROBE_SCRIPT } from "./shared/bridge.js";
import type { ProbeCheckResult, ProbeMethod, ProbeStateSnapshot } from "./shared/bridge.js";
import { resolveRuntimeNode } from "./runtime.js";
import { ServiceSupervisor } from "./supervisor.js";
import { probeMcpSubprocess } from "./mcp-probe.js";

/** dist-desktop/, derived from the bundle location (works in dev and in asar). */
const OUT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The locked runtime the service subprocess must run on (docs/toolchain.md). */
const EXPECTED_RUNTIME = "v22.23.2";
const EXPECTED_MCP_TOOLS = 14;

interface ProbeState {
  mode: "dev" | "packaged";
  runtimeNode: string;
  runtimeVersion: string | null;
  service: ProbeStateSnapshot["service"];
  events: ProbeStateSnapshot["events"];
}

const state: ProbeState = {
  mode: app.isPackaged ? "packaged" : "dev",
  runtimeNode: "",
  runtimeVersion: null,
  service: { state: "idle", pid: null, workspaceRoot: null, socketPath: null, workspaceId: null, error: null },
  events: [],
};

let supervisor: ServiceSupervisor | undefined;
let baseDir = "";
let stateFile = "";
let mainWindow: BrowserWindow | undefined;

function log(event: string, detail?: string): void {
  state.events.push({ at: new Date().toISOString(), event, ...(detail === undefined ? {} : { detail }) });
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  writeState();
}

function writeState(): void {
  if (!stateFile) return;
  try { writeFileSync(stateFile, JSON.stringify(snapshot(), null, 2)); } catch { /* best effort */ }
}

/** The state file is an evidence artifact: redacted, no credentials ever. */
function snapshot(): ProbeStateSnapshot {
  return redact({
    mode: state.mode,
    runtimeNode: state.runtimeNode,
    runtimeVersion: state.runtimeVersion,
    service: { ...state.service },
    events: [...state.events],
  });
}

function setupPaths(): void {
  if (stateFile) return;
  baseDir = process.env.ROLEDOCK_PROBE_DIR || mkdtempSync(join(tmpdir(), "roledock-desktop-probe-"));
  mkdirSync(baseDir, { recursive: true });
  stateFile = join(baseDir, "state.json");
  app.setPath("userData", join(baseDir, "user-data"));
}

function resolveRuntime(): void {
  const resolved = resolveRuntimeNode({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, envNode: process.env.ROLEDOCK_PROBE_NODE });
  state.mode = resolved.mode;
  state.runtimeNode = resolved.nodePath;
  log("runtime-resolved", `${resolved.mode}: ${resolved.nodePath}`);
}

async function nodeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(state.runtimeNode, ["--version"], { timeout: 15000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function startService(): Promise<void> {
  if (!supervisor) supervisor = new ServiceSupervisor({ nodePath: state.runtimeNode, bundlePath: serviceBundlePath(), log });
  state.service.state = "starting";
  writeState();
  try {
    const workspaceRoot = join(baseDir, "workspace");
    const started = await supervisor.start(workspaceRoot);
    state.service = { state: "running", pid: started.pid, workspaceRoot, socketPath: started.socketPath, workspaceId: started.workspaceId, error: null };
    log("service-started", `workspace=${started.workspaceId}`);
  } catch (error) {
    state.service.state = "failed";
    state.service.error = String(error instanceof Error ? error.message : error).slice(0, 300);
    log("service-failed", state.service.error);
    throw error;
  } finally {
    writeState();
  }
}

function ownerClient(): ServiceClient {
  if (!supervisor?.started) throw new Error("Service is not running.");
  return new ServiceClient(supervisor.started.ownerCredential);
}

async function runChecks(): Promise<ProbeCheckResult[]> {
  const results: ProbeCheckResult[] = [];

  const version = await nodeVersion();
  state.runtimeVersion = version;
  results.push({ name: "runtime_version", pass: version === EXPECTED_RUNTIME, detail: `service runtime ${version} (expected ${EXPECTED_RUNTIME}); source=${state.mode}` });

  const info = await ownerClient().call<{ workspace_id: string }>("workspace.info");
  results.push({ name: "workspace_info", pass: Boolean(info.workspace_id), detail: `workspace_id=${info.workspace_id} via owner RPC over Unix socket` });

  results.push(await sqliteBusyCheck());

  results.push(await mcpCheck());
  log("checks-finished", results.map(item => `${item.name}:${item.pass ? "pass" : "FAIL"}`).join(" "));
  writeState();
  return results;
}

async function sqliteBusyCheck(): Promise<ProbeCheckResult> {
  const sqlitePath = join(state.service.workspaceRoot ?? "", ".roledock", "state.sqlite");
  return new Promise(resolve => {
    const child = spawn(state.runtimeNode, ["-e", SQLITE_BUSY_PROBE_SCRIPT, sqlitePath], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", error => resolve({ name: "sqlite_single_writer", pass: false, detail: `probe spawn failed: ${error.message}` }));
    child.on("exit", () => {
      try {
        const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop()!) as { ok: boolean; errcode: number | null; code?: string | null; message: string };
        resolve({ name: "sqlite_single_writer", pass: parsed.ok, detail: `second connection: errcode=${parsed.errcode} (${parsed.code ?? "-"}) message="${parsed.message}"` });
      } catch {
        resolve({ name: "sqlite_single_writer", pass: false, detail: `unparsable probe output: ${out.slice(0, 200)}` });
      }
    });
  });
}

async function mcpCheck(): Promise<ProbeCheckResult> {
  const owner = ownerClient();
  // The mock adapter only verifies its seeded fixture session, so the trusted
  // subject must match the seed (bin.ts: mock-existing-conversation /
  // mock-fixture-subject) — probe-only values, never product wiring.
  const trusted = await owner.call<{ socket_path: string; token: string }>("connections.trust", { subject: "mock-fixture-subject", capability_ceiling: ["authorizations.get", "sessions.anchor"] });
  // The mock adapter only verifies its seeded fixture session (bin.ts seed),
  // which is exactly what the probe's temporary mock workspace provides.
  const registered = await new ServiceClient(trusted).call<{ external_session: { external_session_id: string }; credential: { token: string } }>("externalSessions.register", { host_session_id: "mock-existing-conversation" });
  const mcp = await probeMcpSubprocess({ nodePath: state.runtimeNode, bundlePath: mcpBundlePath(), socketPath: state.service.socketPath!, sessionToken: registered.credential.token, log });
  const pass = mcp.toolCount === EXPECTED_MCP_TOOLS && mcp.authorizationsGetOk;
  return { name: "mcp_subprocess", pass, detail: mcp.detail };
}

function serviceBundlePath(): string {
  return app.isPackaged ? join(process.resourcesPath, "runtime", "vendor", "service-bundle.mjs") : join(OUT_DIR, "vendor", "service-bundle.mjs");
}

function mcpBundlePath(): string {
  return app.isPackaged ? join(process.resourcesPath, "runtime", "vendor", "mcp-bundle.mjs") : join(OUT_DIR, "vendor", "mcp-bundle.mjs");
}

async function stopService(): Promise<void> {
  if (!supervisor) return;
  const result = await supervisor.stop();
  if (result.exitCode !== 0 || !result.socketRemoved) {
    state.service.error = `stop incomplete: exitCode=${result.exitCode} socketRemoved=${result.socketRemoved}`;
  }
  state.service.state = supervisor.state === "running" ? "running" : "stopped";
  state.service.pid = null;
  log("service-stop-verified", `exitCode=${result.exitCode} socketRemoved=${result.socketRemoved}`);
  writeState();
}

type IpcPayloads = {
  getStatus: () => Promise<ProbeStateSnapshot>;
  startService: () => Promise<{ ok: true }>;
  stopService: () => Promise<{ ok: true }>;
  runChecks: () => Promise<{ checks: ProbeCheckResult[] }>;
  pickDirectory: () => Promise<{ canceled: boolean; path: string | null }>;
};

function registerIpc(): void {
  const handlers: IpcPayloads = {
    getStatus: async () => snapshot(),
    startService: async () => { await startService(); return { ok: true as const }; },
    stopService: async () => { await stopService(); return { ok: true as const }; },
    runChecks: async () => ({ checks: redact(await runChecks()) }),
    pickDirectory: async () => {
      const fixture = process.env.ROLEDOCK_PROBE_DIALOG_FIXTURE;
      if (fixture) {
        log("dialog-fixture-used", "ROLEDOCK_PROBE_DIALOG_FIXTURE set; native dialog bypassed for automated runs");
        return { canceled: false, path: fixture };
      }
      const result = await dialog.showOpenDialog(mainWindow!, { title: "RoleDock 探针：选择目录", properties: ["openDirectory"] });
      log("dialog-returned", result.canceled ? "canceled" : result.filePaths[0] ?? "");
      return { canceled: result.canceled, path: result.canceled ? null : result.filePaths[0] ?? null };
    },
  };
  for (const method of PROBE_METHODS) {
    ipcMain.handle(channelFor(method), async (_event, payload: unknown) => {
      try {
        if (payload !== undefined && payload !== null && typeof payload === "object" && Object.keys(payload as object).length > 0) {
          throw new Error(`Probe IPC ${method} takes no payload.`);
        }
        return redact(await (handlers[method as keyof IpcPayloads] as () => unknown)());
      } catch (error) {
        return { ok: false, error: { message: String(error instanceof Error ? error.message : error).slice(0, 300) } };
      }
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 860,
    title: "RoleDock P6-G0 技术探针",
    webPreferences: { preload: join(OUT_DIR, "vendor", "preload.cjs") },
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  void mainWindow.loadFile(join(OUT_DIR, "renderer", "index.html"));
}

async function selfcheck(): Promise<number> {
  setupPaths();
  resolveRuntime();
  const checks: ProbeCheckResult[] = [];
  let ok = true;
  try {
    await startService();
    checks.push(...await runChecks());
  } catch (error) {
    ok = false;
    checks.push({ name: "workspace_info", pass: false, detail: String(error instanceof Error ? error.message : error).slice(0, 300) });
  }
  try { await stopService(); } catch { ok = false; }
  const line = { kind: "desktop-probe-selfcheck", mode: state.mode, runtimeNode: state.runtimeNode, runtimeVersion: state.runtimeVersion, pass: ok && checks.every(item => item.pass), checks };
  process.stdout.write(JSON.stringify(line) + "\n");
  return line.pass ? 0 : 1;
}

setupPaths();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  process.stdout.write(JSON.stringify({ kind: "desktop-probe-single-instance-refused" }) + "\n");
  app.exit(0);
} else {
  app.on("second-instance", () => {
    log("second-instance-focused", "another launch attempt was refused by the single-instance lock");
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.argv.includes("--selfcheck")) {
      const code = await selfcheck();
      app.exit(code);
      return;
    }
    setupPaths();
    resolveRuntime();
    registerIpc();
    createWindow();
    process.stdout.write(JSON.stringify({ kind: "desktop-probe", mode: state.mode, stateFile, pid: process.pid }) + "\n");
  });

  // Window close keeps the owned service running (DESKTOP_GUI_PLAN §4);
  // quitting the app reaps the service the probe owns.
  app.on("window-all-closed", () => {
    if (supervisor?.state === "running") log("window-all-closed-service-kept", `pid=${supervisor.pid}`);
    else app.quit();
  });
  app.on("before-quit", event => {
    if (supervisor?.state !== "running") return;
    event.preventDefault();
    void stopService().then(() => {
      log("owned-service-reaped-on-quit");
      app.quit();
    });
  });
}
