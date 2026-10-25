import type { AnchorConfirmation, HumanAuthorizationEvent, HumanAuthorizationEventRecord } from "@roledock/protocol";

export type { HumanAuthorizationEvent, HumanAuthorizationEventRecord };

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
  /** Existing-session claims are separate from branch isolation. Missing means unsupported. */
  external?: { current_session_identity: boolean; human_authorization_events: boolean; load_materials: boolean; reconcile_load: boolean };
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
  capability_scope?: readonly string[];
  temp_dir?: string;
}

export interface TurnInput {
  /** Caller-visible turn content; the core never injects handoff instructions into old sessions. */
  message: string;
  execution_key?: string;
  budget?: { max_turns?: number; max_output_bytes?: number; deadline?: string };
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
  /**
   * Host-reported size of its latest answer material in bytes. Core uses
   * the larger of this report and the actual UTF-8 answer body size.
   */
  output_bytes?: number;
  /** Completion is explicit; running results never become formal artifacts. */
  completed?: boolean;
  body?: string;
  execution_key?: string;
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
  verifyExternalSession?(hostSessionId: string, connectionSubject: string): Promise<boolean>;
  readHumanAuthorization?(hostSessionId: string, eventRef: string): Promise<HumanAuthorizationEvent | null>;
  loadExternalMaterials?(input: ExternalMaterialLoad): Promise<AnchorConfirmation>;
  lookupExternalLoad?(hostSessionId: string, loadKey: string): Promise<ExternalLoadLookup>;
  /** B2: the trusted authority installs the workspace event store view on construction. */
  useHumanAuthorizationSource?(source: HumanAuthorizationSource): void;
}

export interface ExternalMaterialLoad {
  host_session_id: string; connection_subject: string; load_key: string;
  bootstrap: BootstrapLoad; capability_scope: readonly string[];
}
export type ExternalLoadLookup = { state: "loaded"; confirmation: AnchorConfirmation } | { state: "absent" | "unknown" };

/**
 * B2 (ADR-0011): read view over the workspace human-authorization event
 * store, wired by the trusted authority into adapters that attest human
 * events. The writer side is the owner face only (submitHumanEvent).
 */
export interface HumanAuthorizationSource {
  readEvent(hostSessionId: string, eventRef: string): Promise<HumanAuthorizationEventRecord | null>;
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
