import { createHash } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";
import type { AnchorConfirmation } from "@roledock/protocol";
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
  ExternalMaterialLoad,
  ExternalLoadLookup,
  HumanAuthorizationEvent,
} from "@roledock/core";

export interface MockAdapterOptions {
  external?: Partial<NonNullable<AdapterCapabilities["external"]>>;
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
  cancelled?: boolean;
  turnKeys?: string[];
  capabilityScope?: readonly string[];
  tempDir?: string;
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
      external: { current_session_identity: true, human_authorization_events: true, load_materials: true, reconcile_load: true, ...options.external },
    };
    this.options = options;
  }

  private readonly options: MockAdapterOptions;
  private readonly externalSessions = new Map<string, { subject: string; loads: ExternalMaterialLoad[]; confirmations: Map<string, AnchorConfirmation>; history: string[] }>();
  private readonly humanEvents = new Map<string, { event: HumanAuthorizationEvent; source: "human" | "tool" | "model" | "document" }>();

  /** Fixture-only existing conversation. No production host claim is implied. */
  seedExternalSession(hostSessionId: string, subject: string, history: string[] = []): void {
    this.externalSessions.set(hostSessionId, { subject, loads: [], confirmations: new Map(), history: [...history] });
  }
  seedHumanAuthorization(event: HumanAuthorizationEvent, source: "human" | "tool" | "model" | "document" = "human"): void {
    this.humanEvents.set(JSON.stringify([event.host_session_id, event.event_ref]), { event: structuredClone(event), source });
  }
  peekExternal(hostSessionId: string): { loads: ExternalMaterialLoad[]; history: string[] } {
    const session = this.externalSessions.get(hostSessionId);
    if (!session) throw new RoleDockError("NOT_FOUND", "Mock external session does not exist.");
    return structuredClone({ loads: session.loads, history: session.history });
  }
  async verifyExternalSession(hostSessionId: string, connectionSubject: string): Promise<boolean> {
    return this.externalSessions.get(hostSessionId)?.subject === connectionSubject;
  }
  async readHumanAuthorization(hostSessionId: string, eventRef: string): Promise<HumanAuthorizationEvent | null> {
    const value = this.humanEvents.get(JSON.stringify([hostSessionId, eventRef]));
    return value?.source === "human" ? structuredClone(value.event) : null;
  }
  async loadExternalMaterials(input: ExternalMaterialLoad): Promise<AnchorConfirmation> {
    const session = this.externalSessions.get(input.host_session_id);
    if (!session || session.subject !== input.connection_subject) throw new RoleDockError("PERMISSION_DENIED", "Mock external connection mismatch.");
    verifyBootstrap(input.bootstrap);
    const prior = session.confirmations.get(input.load_key);
    if (prior) {
      if (prior.content_hash !== input.bootstrap.content_hash) throw new RoleDockError("IDEMPOTENCY_CONFLICT", "Mock load key has different material.");
      return { ...prior };
    }
    session.loads.push(structuredClone(input));
    const confirmation = { host_session_id: input.host_session_id, load_key: input.load_key, content_hash: input.bootstrap.content_hash, load_version: session.loads.length };
    session.confirmations.set(input.load_key, confirmation);
    return { ...confirmation };
  }
  async lookupExternalLoad(hostSessionId: string, loadKey: string): Promise<ExternalLoadLookup> {
    const session = this.externalSessions.get(hostSessionId);
    if (!session) return { state: "unknown" };
    const confirmation = session.confirmations.get(loadKey);
    return confirmation ? { state: "loaded", confirmation: { ...confirmation } } : { state: "absent" };
  }

  /** Test/inspection access to a host session's transcript and loaded bundle. */
  peek(hostSessionId: string): { transcript: readonly string[]; bootstrap?: BootstrapLoad; closed: boolean; capabilityScope?: readonly string[]; tempDir?: string } {
    const session = this.sessions.get(hostSessionId);
    if (session === undefined) {
      throw new RoleDockError("NOT_FOUND", `Mock host session "${hostSessionId}" does not exist.`);
    }
    return { transcript: [...session.transcript], bootstrap: session.bootstrap, closed: session.closed, capabilityScope: session.capabilityScope, tempDir: session.tempDir };
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
    // Keyed creation: an existing open session under the same key is
    // returned as-is, mirroring the process bridge's registry behavior.
    for (const session of this.sessions.values()) {
      if (session.handle.creation_key === input.creation_key && !session.closed) {
        return { ...session.handle };
      }
    }
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
    this.sessions.set(handle.host_session_id, { handle, bootstrap: input.bootstrap, transcript: [], closed: false, turnKeys: [], capabilityScope: input.capability_scope, tempDir: input.temp_dir });
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
    if (session === undefined || handle.adapter !== "mock" || session.handle.creation_key !== handle.creation_key) {
      throw new RoleDockError("NOT_FOUND", `Mock host session "${handle.host_session_id}" does not exist.`);
    }
    if (session.closed) {
      throw new RoleDockError("INVALID_STATE_TRANSITION", "Mock host session is closed.");
    }
    return session;
  }

  async runTurn(handle: AdapterSessionHandle, turn: TurnInput): Promise<TurnResult> {
    const session = this.requireSession(handle);
    if (session.cancelled) throw new RoleDockError("INVALID_STATE_TRANSITION", "Mock host session was cancelled.");
    if (turn.execution_key && session.turnKeys?.includes(turn.execution_key)) return { host_session_id: handle.host_session_id, accepted: true };
    session.transcript.push(turn.message);
    (session.turnKeys ??= []).push(turn.execution_key ?? "");
    return { host_session_id: handle.host_session_id, accepted: true };
  }

  async getResult(handle: AdapterSessionHandle): Promise<AdapterSessionResult> {
    const session = this.sessions.get(handle.host_session_id);
    if (session === undefined || handle.adapter !== "mock" || session.handle.creation_key !== handle.creation_key) {
      throw new RoleDockError("NOT_FOUND", `Mock host session "${handle.host_session_id}" does not exist.`);
    }
    const needsInputAt = this.options.needsInputAfterTurns ?? Number.POSITIVE_INFINITY;
    // The mock's fixed answer for the latest turn; its size is what a real
    // host would report as output_bytes.
    const lastAnswer = session.transcript.length > 0 ? `ack:${session.transcript.length}` : "";
    return {
      host_session_id: handle.host_session_id,
      state: session.closed ? "closed" : "idle",
      completed: session.transcript.length > 0 && session.transcript.length !== needsInputAt,
      body: lastAnswer,
      execution_key: session.turnKeys?.at(-1),
      turn_count: session.transcript.length,
      output_bytes: Buffer.byteLength(lastAnswer, "utf8"),
      ...(session.transcript.length === needsInputAt ? { needs_input: true } : {}),
    };
  }

  async closeSession(handle: AdapterSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.host_session_id);
    if (session && (handle.adapter !== "mock" || session.handle.creation_key !== handle.creation_key)) {
      throw new RoleDockError("NOT_FOUND", "Mock host handle belongs to another session.");
    }
    if (session) session.closed = true;
  }

  async cancel(handle: AdapterSessionHandle): Promise<void> {
    this.requireSession(handle).cancelled = true;
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
