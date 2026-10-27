import { spawn } from "node:child_process";
import { readFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { ServiceClient } from "@roledock/service";
import type { ServiceCredential } from "@roledock/service";

export interface StartedService {
  pid: number;
  workspaceRoot: string;
  socketPath: string;
  workspaceId: string;
  ownerCredential: ServiceCredential;
}

/**
 * Owns the workspace-service child process (G0 probe: the probe workspace is
 * ephemeral, so app exit reaps it; window close keeps it — lifecycle matrix
 * in docs/spec/desktop-gui-contract.md).
 *
 * The owner credential stays inside the main process: it is never part of any
 * IPC reply and never written to the probe state file.
 */
export class ServiceSupervisor {
  #child: ReturnType<typeof spawn> | undefined;
  readonly #nodePath: string;
  readonly #bundlePath: string;
  readonly #log: (event: string, detail?: string) => void;
  #started: StartedService | undefined;

  constructor(options: { nodePath: string; bundlePath: string; log?: (event: string, detail?: string) => void }) {
    this.#nodePath = options.nodePath;
    this.#bundlePath = options.bundlePath;
    this.#log = options.log ?? (() => undefined);
  }

  get state(): "idle" | "running" | "stopped" {
    if (!this.#child) return "idle";
    return this.#child.exitCode === null ? "running" : "stopped";
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get started(): StartedService | undefined {
    return this.#started;
  }

  async start(workspaceRoot: string): Promise<StartedService> {
    if (this.state === "running") return this.#started!;
    this.#log("service-starting", this.#bundlePath);
    const child = spawn(this.#nodePath, [this.#bundlePath, "--mock-workspace", workspaceRoot], {
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    let earlyFailure: Error | undefined;
    child.on("error", error => { earlyFailure = new Error(`service spawn failed: ${error.message}`); });
    child.on("exit", (code, signal) => {
      this.#log("service-exit", `code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (!earlyFailure) earlyFailure = new Error(`service exited before becoming ready (code=${code} signal=${signal}): ${output.slice(-400).trim()}`);
    });
    try {
      const credentialFile = join(workspaceRoot, ".roledock", "owner-connection.json");
      const credential = await waitFor(() => {
        if (earlyFailure) throw earlyFailure;
        try { return JSON.parse(readFileSync(credentialFile, "utf8")) as ServiceCredential; } catch (error) { if (earlyFailure) throw earlyFailure; return undefined; }
      }, 20000, 100);
      const socketPath = credential.socket_path;
      const client = new ServiceClient(credential);
      const info = await waitForAsync(async () => {
        try { return await client.call<{ workspace_id: string }>("workspace.info"); } catch { return undefined; }
      }, 10000, 100);
      this.#started = { pid: child.pid!, workspaceRoot, socketPath, workspaceId: info.workspace_id, ownerCredential: credential };
      void output;
      this.#log("service-running", `pid=${child.pid} workspace=${info.workspace_id}`);
      return this.#started;
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  async stop(): Promise<{ exitCode: number | null; socketRemoved: boolean }> {
    const child = this.#child;
    const started = this.#started;
    if (!child || child.exitCode !== null) return { exitCode: child?.exitCode ?? null, socketRemoved: true };
    this.#log("service-stopping", `pid=${child.pid}`);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(child.exitCode); }, 10000);
      child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    const socketRemoved = started ? !exists(started.socketPath) : true;
    this.#log("service-stopped", `exitCode=${exitCode} socketRemoved=${socketRemoved}`);
    return { exitCode, socketRemoved };
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function waitFor<T>(probe: () => T | undefined, timeoutMs: number, intervalMs: number): Promise<T> {
  return waitForAsync(async () => probe(), timeoutMs, intervalMs);
}

async function waitForAsync<T>(probe: () => Promise<T | undefined>, timeoutMs: number, intervalMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms.`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** Removes the probe workspace (dev evidence hygiene); never follows links. */
export function removeWorkspace(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
