import type { BootstrapBundle } from "@roledock/protocol";

/**
 * Harness adapter port (docs/spec/adapter-contract.md).
 *
 * The core talks to hosts only through this interface; it never calls a
 * model API directly. Required methods form the minimum viable host; the
 * optional methods are negotiated via AdapterCapabilities and must never be
 * invoked when undeclared.
 */

/** Host session reference returned by createSession/nativeResume/nativeFork. */
export interface AdapterSessionHandle {
  adapter: string;
  host_session_id: string;
  creation_key: string;
}

/** What the host declares about its abilities; drives restricted-level behavior. */
export interface AdapterCapabilities {
  /** Adapter identifier, e.g. "mock". */
  adapter: string;
  /** full: all four isolation scopes guaranteed; restricted: at least one missing. */
  level: "full" | "restricted";
  isolation: {
    context: boolean;
    temp_writes: boolean;
    results: boolean;
    capability_scope: boolean;
  };
  optional: {
    cancel: boolean;
    lookup_session_by_creation_key: boolean;
    native_resume: boolean;
    native_fork: boolean;
  };
}

/** The shareable role knowledge a new host session must load (P3 handoff). */
export interface BootstrapLoad {
  bundle_id: string;
  role_id: string;
  /** SHA-256 over the serialized bundle payload; hosts verify before confirming. */
  content_hash: string;
  payload: string;
}

export interface CreateSessionInput {
  /** Idempotent creation key; hosts may be looked up by it after crashes. */
  creation_key: string;
  bootstrap?: BootstrapLoad;
}

export interface TurnInput {
  /** Caller-visible turn content; the core never injects handoff instructions into old sessions. */
  message: string;
}

export interface TurnResult {
  host_session_id: string;
  accepted: boolean;
}

export interface AdapterSessionResult {
  host_session_id: string;
  state: "running" | "idle" | "closed";
  /** Host-side transcript length, for unpolluted-history assertions in tests. */
  turn_count: number;
  /** Host reports the branch needs initiator input (drives awaiting_input). */
  needs_input?: boolean;
}

/** Scope requested of a native fork; full private history across roles is rejected. */
export interface NativeForkRequest {
  share_scope: "bundle-shareable" | "full-private-history";
  target_role_id?: string;
}

export interface HarnessAdapter {
  getCapabilities(): AdapterCapabilities;
  /**
   * Create a host session, loading the bootstrap bundle when provided.
   * Implementations must confirm the load (hash check) before returning.
   * Creation is keyed: implement lookupSessionByCreationKey to allow crash
   * recovery, otherwise a failed create with unknown host-side outcome must
   * surface as an uncertain state the caller records.
   */
  createSession(input: CreateSessionInput): Promise<AdapterSessionHandle>;
  runTurn(handle: AdapterSessionHandle, turn: TurnInput): Promise<TurnResult>;
  getResult(handle: AdapterSessionHandle): Promise<AdapterSessionResult>;
  closeSession(handle: AdapterSessionHandle): Promise<void>;

  cancel?(handle: AdapterSessionHandle): Promise<void>;
  lookupSessionByCreationKey?(creationKey: string): Promise<AdapterSessionHandle | null>;
  nativeResume?(handle: AdapterSessionHandle): Promise<AdapterSessionHandle>;
  nativeFork?(handle: AdapterSessionHandle, request: NativeForkRequest): Promise<AdapterSessionHandle>;
}

/** Type guard: is the adapter's isolation complete enough for full access? */
export function isFullAccess(capabilities: AdapterCapabilities): boolean {
  const { isolation } = capabilities;
  return (
    capabilities.level === "full" &&
    isolation.context &&
    isolation.temp_writes &&
    isolation.results &&
    isolation.capability_scope
  );
}
