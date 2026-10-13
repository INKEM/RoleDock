import { createHash } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";
import type {
  AdapterCapabilities,
  AdapterSessionHandle,
  AdapterSessionResult,
  BootstrapLoad,
  CreateSessionInput,
  HarnessAdapter,
  NativeForkRequest,
  TurnInput,
  TurnResult,
} from "@roledock/core";

export interface MockAdapterOptions {
  /** Declared optional capabilities; all default to true unless overridden. */
  optional?: Partial<AdapterCapabilities["optional"]>;
  /** Isolation scopes; default all true (full access). */
  isolation?: Partial<AdapterCapabilities["isolation"]>;
  /** getResult reports needs_input after the configured turn count. */
  needsInputAfterTurns?: number;
  /** createSession fails hard before any host-side effect. */
  failCreate?: boolean;
  /**
   * createSession creates the host session and THEN throws — the host-side
   * outcome is unknown to the caller (uncertain creation). Recoverable via
   * lookupSessionByCreationKey when that capability is declared.
   */
  uncertainCreate?: boolean;
  /** Throw uncertain for the first N createSession calls, succeed after. */
  uncertainCreateTimes?: number;
}

interface MockHostSession {
  handle: AdapterSessionHandle;
  bootstrap?: BootstrapLoad;
  transcript: string[];
  closed: boolean;
}

/**
 * In-memory mock host: deterministic, scriptable failure modes, full
 * recording for assertions. It proves CORE state mechanics only — it is not
 * evidence of real-harness behavior and must never be reported as such.
 */
export class MockHarnessAdapter implements HarnessAdapter {
  private readonly sessions = new Map<string, MockHostSession>();
  private readonly capabilities: AdapterCapabilities;

  constructor(options: MockAdapterOptions = {}) {
    const optional: AdapterCapabilities["optional"] = {
      cancel: true,
      lookup_session_by_creation_key: true,
      native_resume: true,
      native_fork: true,
      ...options.optional,
    };
    const isolation: AdapterCapabilities["isolation"] = {
      context: true,
      temp_writes: true,
      results: true,
      capability_scope: true,
      ...options.isolation,
    };
    const full =
      isolation.context && isolation.temp_writes && isolation.results && isolation.capability_scope;
    this.capabilities = {
      adapter: "mock",
      level: full ? "full" : "restricted",
      isolation,
      optional,
    };
    this.options = options;
  }

  private readonly options: MockAdapterOptions;

  /** Test/inspection access to a host session's transcript and loaded bundle. */
  peek(hostSessionId: string): { transcript: readonly string[]; bootstrap?: BootstrapLoad; closed: boolean } {
    const session = this.sessions.get(hostSessionId);
    if (session === undefined) {
      throw new RoleDockError("NOT_FOUND", `Mock host session "${hostSessionId}" does not exist.`);
    }
    return { transcript: [...session.transcript], bootstrap: session.bootstrap, closed: session.closed };
  }

  /** True when the core never drove a native fork through this adapter. */
  nativeForkInvocationCount(): number {
    return this.forkInvocations;
  }

  private forkInvocations = 0;
  private uncertainCount = 0;

  getCapabilities(): AdapterCapabilities {
    return { ...this.capabilities, isolation: { ...this.capabilities.isolation }, optional: { ...this.capabilities.optional } };
  }

  async createSession(input: CreateSessionInput): Promise<AdapterSessionHandle> {
    if (this.options.failCreate === true) {
      throw new RoleDockError(
        "INTERNAL",
        "mock adapter: createSession configured to fail before any host-side effect",
        { details: { adapter: "mock", creation_key: input.creation_key } },
      );
    }
    if (input.bootstrap !== undefined) {
      verifyBootstrap(input.bootstrap);
    }
    const handle: AdapterSessionHandle = {
      adapter: "mock",
      host_session_id: `mock-${this.nextId()}`,
      creation_key: input.creation_key,
    };
    this.sessions.set(handle.host_session_id, { handle, bootstrap: input.bootstrap, transcript: [], closed: false });
    const uncertainTimes = this.options.uncertainCreateTimes ?? 0;
    if (this.options.uncertainCreate === true || this.uncertainCount < uncertainTimes) {
      this.uncertainCount += 1;
      // The host session exists but the caller learns only that the outcome
      // is unknown — the creation-key lookup is the recovery path.
      throw new RoleDockError(
        "INTERNAL",
        "mock adapter: host session created but the outcome could not be confirmed",
        { details: { adapter: "mock", creation_key: input.creation_key, uncertain: true } },
      );
    }
    return handle;
  }

  private idCounter = 0;
  private nextId(): string {
    this.idCounter += 1;
    return this.idCounter.toString().padStart(4, "0");
  }

  private requireSession(handle: AdapterSessionHandle): MockHostSession {
    const session = this.sessions.get(handle.host_session_id);
    if (session === undefined || handle.adapter !== "mock") {
      throw new RoleDockError("NOT_FOUND", `Mock host session "${handle.host_session_id}" does not exist.`);
    }
    if (session.closed) {
      throw new RoleDockError("INVALID_STATE_TRANSITION", "Mock host session is closed.");
    }
    return session;
  }

  async runTurn(handle: AdapterSessionHandle, turn: TurnInput): Promise<TurnResult> {
    const session = this.requireSession(handle);
    session.transcript.push(turn.message);
    return { host_session_id: handle.host_session_id, accepted: true };
  }

  async getResult(handle: AdapterSessionHandle): Promise<AdapterSessionResult> {
    const session = this.sessions.get(handle.host_session_id);
    if (session === undefined || handle.adapter !== "mock") {
      throw new RoleDockError("NOT_FOUND", `Mock host session "${handle.host_session_id}" does not exist.`);
    }
    const needsInputAt = this.options.needsInputAfterTurns ?? Number.POSITIVE_INFINITY;
    return {
      host_session_id: handle.host_session_id,
      state: session.closed ? "closed" : session.transcript.length > 0 ? "running" : "idle",
      turn_count: session.transcript.length,
      ...(session.transcript.length === needsInputAt ? { needs_input: true } : {}),
    };
  }

  async closeSession(handle: AdapterSessionHandle): Promise<void> {
    const session = this.requireSession(handle);
    session.closed = true;
  }

  async cancel(handle: AdapterSessionHandle): Promise<void> {
    this.requireSession(handle);
  }

  async lookupSessionByCreationKey(creationKey: string): Promise<AdapterSessionHandle | null> {
    for (const session of this.sessions.values()) {
      if (session.handle.creation_key === creationKey && !session.closed) {
        return session.handle;
      }
    }
    return null;
  }

  async nativeResume(handle: AdapterSessionHandle): Promise<AdapterSessionHandle> {
    const session = this.requireSession(handle);
    return { ...session.handle, host_session_id: session.handle.host_session_id };
  }

  async nativeFork(handle: AdapterSessionHandle, request: NativeForkRequest): Promise<AdapterSessionHandle> {
    this.forkInvocations += 1;
    const session = this.requireSession(handle);
    // Full private history must never cross to another role; only the
    // shareable bundle path may (ADR-0002).
    if (request.share_scope === "full-private-history" && request.target_role_id !== undefined) {
      throw new RoleDockError(
        "PERMISSION_DENIED",
        "mock adapter: native fork with full private history across roles is rejected; use the shareable bootstrap bundle path",
      );
    }
    const forkHandle: AdapterSessionHandle = {
      adapter: "mock",
      host_session_id: `mock-${this.nextId()}`,
      creation_key: `${session.handle.creation_key}+fork-${this.forkInvocations}`,
    };
    this.sessions.set(forkHandle.host_session_id, {
      handle: forkHandle,
      transcript: request.share_scope === "full-private-history" ? [...session.transcript] : [],
      closed: false,
    });
    return forkHandle;
  }
}

function verifyBootstrap(bootstrap: BootstrapLoad): void {
  const actual = createHash("sha256").update(bootstrap.payload, "utf8").digest("hex");
  if (actual !== bootstrap.content_hash) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      "Bootstrap bundle failed its content hash check; host refuses the load.",
      { details: { bundle_id: bootstrap.bundle_id, expected: bootstrap.content_hash, actual } },
    );
  }
}
