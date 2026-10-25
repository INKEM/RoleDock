import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RoleDockError } from "@roledock/protocol";
import type {
  AdapterCapabilities,
  AdapterSessionHandle,
  AdapterSessionResult,
  BootstrapLoad,
  CreateSessionInput,
  HarnessAdapter,
  TurnInput,
  TurnResult,
} from "@roledock/core";

/**
 * Process-bridge Harness adapter (docs/spec/adapter-contract.md §4, layer 2).
 *
 * Every adapter operation launches a real operating-system process (the
 * fixture host program) with a structured argv array — user material travels
 * through stdin or files, never through a shell command string — and reads
 * one JSON reply from the child's stdout. Host state lives in a per-session
 * directory under the workspace, so sessions survive the adapter instance
 * and are recoverable by creation key after crashes.
 *
 * This layer validates OS execution, message framing and disconnect
 * handling. It is still not a real harness: the fixture host is a
 * fixed-answer protocol fixture, and its passes must never be reported as
 * real-harness evidence.
 */

/** Options for constructing the bridge adapter. */
export interface ProcessBridgeAdapterOptions {
  /**
   * Directory holding all host session directories. Scope it to the
   * workspace (e.g. `<root>/.roledock/host-sessions`) so lookup and
   * reclamation stay workspace-local.
   */
  stateDir: string;
  /**
   * Isolation scope overrides, mirroring the mock's option surface: any
   * missing scope degrades the declared level to "restricted" so callers
   * get a clear capability signal instead of a pretending one.
   */
  isolation?: Partial<AdapterCapabilities["isolation"]>;
  /**
   * Fixture chaos injection: `uncertain-create` makes load die after the
   * registry write (host session may exist, outcome unknown);
   * `crash-load` removes the session dir before dying (hard failure,
   * no host-side effect).
   */
  chaos?: "uncertain-create" | "crash-load";
  /** Per-operation timeout in milliseconds (default 15000). */
  timeoutMs?: number;
}

const HOST_PROGRAM = fileURLToPath(new URL("../host/fixture-host.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 15_000;

interface HostReply {
  ok: boolean;
  host_session_id?: string;
  host_version?: string;
  protocol?: number;
  role_id?: string;
  accepted?: boolean;
  turn_index?: number;
  state?: "running" | "idle" | "closed";
  turn_count?: number;
  output_bytes?: number;
  completed?: boolean;
  body?: string;
  execution_key?: string;
  needs_input?: boolean;
  found?: boolean;
  status?: string;
  session_dir?: string;
  error?: { code?: string; message?: string };
  chaos?: string;
}

interface SessionRegistry {
  creation_key: string;
  host_session_id: string;
  role_id: string;
  bundle_id: string;
  status: "active" | "closed";
  host_version: string;
  created_at: string;
}

function sanitizeKey(creationKey: string): string {
  const safe = creationKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(creationKey, "utf8").digest("hex").slice(0, 12);
  return `${safe}-${digest}`;
}

export class ProcessBridgeAdapter implements HarnessAdapter {
  private readonly stateDir: string;
  private readonly chaos?: string;
  private readonly timeoutMs: number;
  private readonly capabilities: AdapterCapabilities;

  constructor(options: ProcessBridgeAdapterOptions) {
    this.stateDir = options.stateDir;
    this.chaos = options.chaos;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const isolation = {
      context: true,
      temp_writes: true,
      results: true,
      capability_scope: true,
      ...options.isolation,
    };
    const full =
      isolation.context && isolation.temp_writes && isolation.results && isolation.capability_scope;
    this.capabilities = {
      adapter: "process-bridge",
      level: full ? "full" : "restricted",
      isolation,
      optional: {
        cancel: true,
        lookup_session_by_creation_key: true,
        // Native context continuation is not part of the process-per-turn
        // bridge; continuation is the universal bundle path (ADR-0002).
        native_resume: false,
        native_fork: false,
      },
    };
    mkdirSync(join(this.stateDir, "sessions"), { recursive: true });
  }

  getCapabilities(): AdapterCapabilities {
    return {
      ...this.capabilities,
      isolation: { ...this.capabilities.isolation },
      optional: { ...this.capabilities.optional },
    };
  }

  /** Protocol fixture version, from the host program itself. */
  async hostVersion(): Promise<string> {
    const reply = await this.runHost({ args: ["version"] });
    return reply.host_version ?? "unknown";
  }

  async createSession(input: CreateSessionInput): Promise<AdapterSessionHandle> {
    const dirName = sanitizeKey(input.creation_key);
    const sessionDir = join(this.stateDir, "sessions", dirName);
    const registryPath = join(sessionDir, "session.json");

    if (existsSync(registryPath)) {
      // Idempotent creation under the same key returns the existing session.
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as SessionRegistry;
      if (registry.status === "closed") {
        throw new RoleDockError(
          "INVALID_STATE_TRANSITION",
          `Host session for creation key "${input.creation_key}" is closed.`,
        );
      }
      return {
        adapter: "process-bridge",
        host_session_id: registry.host_session_id,
        creation_key: input.creation_key,
      };
    }

    if (input.bootstrap !== undefined) {
      // The host verifies the hash itself; the bridge transports the whole
      // BootstrapLoad record verbatim.
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "bootstrap.json"), JSON.stringify(input.bootstrap, null, 2), "utf8");
    }
    const args = ["load", "--session-dir", sessionDir, "--creation-key", input.creation_key, "--capability-scope", JSON.stringify(input.capability_scope ?? [])];
    if (input.temp_dir) args.push("--temp-dir", input.temp_dir);
    if (this.chaos !== undefined) args.push("--chaos", this.chaos);
    let reply: HostReply;
    try {
      reply = await this.runHost({ args });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (existsSync(registryPath)) {
        // The registry exists but the host died before confirming: the host
        // session may exist and its outcome is unknown (uncertain creation).
        throw new RoleDockError(
          "INTERNAL",
          `Host load for creation key "${input.creation_key}" died after the registry write; outcome uncertain.`,
          {
            details: {
              creation_key: input.creation_key,
              session_dir: sessionDir,
              uncertain: true,
              cause: message,
            },
          },
        );
      }
      if (error instanceof RoleDockError) {
        // Structured host failure before any host-side effect (e.g. a
        // refused bootstrap): keep the host's protocol code.
        throw error;
      }
      throw new RoleDockError(
        "INTERNAL",
        `Host load for creation key "${input.creation_key}" failed: ${message}`,
        { details: { creation_key: input.creation_key, stage: "load" } },
      );
    }
    return {
      adapter: "process-bridge",
      host_session_id: reply.host_session_id ?? `pb-${dirName}`,
      creation_key: input.creation_key,
    };
  }

  async runTurn(handle: AdapterSessionHandle, turn: TurnInput): Promise<TurnResult> {
    const reply = await this.runHost({
      args: ["turn", "--session-dir", this.requireSessionDir(handle)],
      stdin: `${JSON.stringify(turn)}\n`,
    });
    return { host_session_id: handle.host_session_id, accepted: reply.accepted === true };
  }

  async getResult(handle: AdapterSessionHandle): Promise<AdapterSessionResult> {
    const reply = await this.runHost({ args: ["result", "--session-dir", this.requireSessionDir(handle)] });
    return {
      host_session_id: handle.host_session_id,
      state: reply.state ?? "idle",
      turn_count: reply.turn_count ?? 0,
      output_bytes: reply.output_bytes ?? 0,
      completed: reply.completed,
      body: reply.body,
      execution_key: reply.execution_key,
      ...(reply.needs_input === true ? { needs_input: true } : {}),
    };
  }

  async closeSession(handle: AdapterSessionHandle): Promise<void> {
    await this.runHost({ args: ["close", "--session-dir", this.requireSessionDir(handle)] });
  }

  async cancel(handle: AdapterSessionHandle): Promise<void> {
    // The bridge runs one process per operation, so there is no long-running
    // host execution to signal; cancellation records a cancelled marker the
    // host honors on the next operation.
    const sessionDir = this.requireSessionDir(handle);
    writeFileSync(join(sessionDir, "cancel.requested"), new Date().toISOString(), "utf8");
  }

  async lookupSessionByCreationKey(creationKey: string): Promise<AdapterSessionHandle | null> {
    const reply = await this.runHost({
      args: ["lookup", "--state-dir", this.stateDir, "--creation-key", creationKey],
    });
    if (reply.found !== true || reply.status === "closed") return null;
    return {
      adapter: "process-bridge",
      host_session_id: reply.host_session_id ?? "",
      creation_key: creationKey,
    };
  }

  // -- internals -------------------------------------------------------------

  private requireSessionDir(handle: AdapterSessionHandle): string {
    const dirName = sanitizeKey(handle.creation_key);
    const sessionDir = join(this.stateDir, "sessions", dirName);
    if (!existsSync(join(sessionDir, "session.json"))) {
      throw new RoleDockError(
        "NOT_FOUND",
        `Host session "${handle.host_session_id}" does not exist under ${this.stateDir}.`,
      );
    }
    return sessionDir;
  }

  /**
   * Run one fixture-host process and collect its single JSON reply.
   * Spawn uses an argv array only — no shell, no string interpolation of
   * user material into a command line (prompts/05 task 1).
   */
  private runHost(options: { args: readonly string[]; stdin?: string }): Promise<HostReply> {
    return new Promise<HostReply>((resolve, reject) => {
      const child = spawn(process.execPath, [HOST_PROGRAM, ...options.args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`fixture host timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
        const last = lines[lines.length - 1];
        if (code === 0 && last !== undefined) {
          try {
            resolve(JSON.parse(last) as HostReply);
            return;
          } catch (error) {
            reject(new Error(`fixture host reply was not JSON: ${(error as Error).message}`));
            return;
          }
        }
        // Non-zero exit: surface the host's structured error when present.
        const stderrLines = stderr.split("\n").filter((line) => line.trim().length > 0);
        const errorLine = stderrLines[stderrLines.length - 1];
        let detail = errorLine ?? `exit code ${code ?? "signal"}`;
        let hostCode: string | undefined;
        try {
          if (errorLine !== undefined) {
            const parsed = JSON.parse(errorLine) as {
              chaos?: string;
              error?: { code?: string; message?: string };
            };
            if (parsed.chaos !== undefined) detail = `chaos:${parsed.chaos}`;
            else if (parsed.error?.message !== undefined) {
              detail = parsed.error.message;
              hostCode = parsed.error.code;
            }
          }
        } catch {
          // keep the raw line as the detail
        }
        if (hostCode !== undefined) {
          // Structured host error: preserve its protocol code (e.g.
          // VALIDATION_FAILED for a refused bootstrap) instead of masking it.
          reject(new RoleDockError(hostCode as never, detail, { details: { host: "fixture" } }));
          return;
        }
        reject(new Error(detail));
      });

      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }
}

/** Re-export for tests that assert against the loaded payload shape. */
export type { BootstrapLoad };
