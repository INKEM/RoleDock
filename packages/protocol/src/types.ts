/**
 * TypeScript mirrors of the JSON Schemas in ../schemas/.
 *
 * The schemas are the source of truth. Conformance tests validate fixture
 * values typed with these interfaces against the schemas, so a drift between
 * the two breaks the test suite instead of silently diverging.
 */
import type { ErrorCode } from "./error-codes.js";

/** RoleDock protocol version the schemas and types describe. */
export const PROTOCOL_VERSION = "0.1";

/**
 * Identifier shape shared by workspace, role, instance, session, document key
 * and artifact ids: ^[a-z][a-z0-9-]{0,63}$. Plain string aliases are kept on
 * purpose; schema validation, not the type system, is the enforcement point.
 */
export type Id = string;
/** Lowercase hex SHA-256 content hash. */
export type Sha256 = string;
/** ISO 8601 UTC timestamp, e.g. 2026-10-12T12:00:00Z. */
export type Iso8601Timestamp = string;

/**
 * Visibility ladder for document revisions. private < role < project < public:
 * public is additionally cleared for sharing outside the workspace (default
 * export scope). Request-branch sessions read only explicitly shared levels
 * (project/public); see docs/spec/objects-and-state-machines.md.
 */
export type DocumentVisibility = "private" | "role" | "project" | "public";

// ---------------------------------------------------------------------------
// Role pack
// ---------------------------------------------------------------------------

export interface DocumentSpec {
  key: Id;
  template: string;
  visibility: DocumentVisibility;
  title?: string;
  description?: string;
}

export interface OutputSchemaSpec {
  key: Id;
  schema: string;
}

export interface RoleDefinition {
  id: Id;
  title: string;
  instructions: string;
  description?: string;
  documents?: DocumentSpec[];
  output_schemas?: OutputSchemaSpec[];
  /** Requirements declaration only; never an authorization credential. */
  requested_capabilities?: string[];
}

export interface RolePack {
  schema_version: "0.1";
  name: Id;
  version: string;
  requires_protocol: "0.1";
  description?: string;
  roles: RoleDefinition[];
}

// ---------------------------------------------------------------------------
// Coordination objects
// ---------------------------------------------------------------------------

/** Frozen identity of the installed role pack version a role is registered from. */
export interface RoleContract {
  package_name: string;
  package_version: string;
  content_hash: Sha256;
}

/** Unique primary pointer per (workspace_id, role_id). */
export interface RoleHead {
  workspace_id: Id;
  role_id: Id;
  /** >= 1; increments by exactly one per handoff activation. */
  generation: number;
  /** >= 0; increases on every formal publish of the role. */
  knowledge_revision: number;
  current_instance_id: Id;
  role_contract: RoleContract;
  updated_at: Iso8601Timestamp;
}

/** One immutable revision of a role-owned document. */
export interface DocumentRevision {
  workspace_id: Id;
  role_id: Id;
  document_key: Id;
  /** >= 1, monotonic per (workspace_id, role_id, document_key). */
  revision: number;
  content_hash: Sha256;
  visibility: DocumentVisibility;
  created_by_instance_id: Id;
  created_at: Iso8601Timestamp;
}

export interface DocumentSnapshot {
  document_key: Id;
  revision: number;
  content_hash: Sha256;
}

export interface UserDecisionRef {
  summary: string;
  document_key?: Id;
  revision?: number;
}

export interface CheckpointTodo {
  description: string;
  done: boolean;
}

export interface CheckpointSource {
  kind: "document" | "request" | "external";
  document_key?: Id;
  revision?: number;
  description?: string;
}

export interface Checkpoint {
  checkpoint_id: Id;
  workspace_id: Id;
  role_id: Id;
  generation: number;
  knowledge_revision: number;
  document_snapshots: DocumentSnapshot[];
  handoff_summary: {
    format: "markdown";
    body: string;
    content_hash: Sha256;
  };
  user_decision_refs?: UserDecisionRef[];
  todos: CheckpointTodo[];
  sources: CheckpointSource[];
  created_by_instance_id: Id;
  created_at: Iso8601Timestamp;
}

/** Immutable handoff bundle a new host session loads; shareable knowledge only. */
export interface RoleMaterials {
  package_name: string;
  package_version: string;
  content_hash: Sha256;
  definition: RoleDefinition;
  instructions: string;
  templates: { key: string; body: string }[];
  schemas: { file: string; body: string }[];
}
export interface DocumentMaterials extends DocumentSnapshot {
  owner_role_id: Id;
  visibility: "role" | "project" | "public";
  body: string;
  created_by_instance_id: Id | null;
  created_at: Iso8601Timestamp;
}

export interface BootstrapBundle {
  bundle_id: Id;
  protocol_version: "0.1";
  workspace_id: Id;
  role_id: Id;
  source_generation: number;
  source_knowledge_revision: number;
  role_contract: RoleContract;
  checkpoint: {
    checkpoint_id: Id;
    content_hash: Sha256;
  };
  created_by_instance_id: Id;
  created_at: Iso8601Timestamp;
  provisioned_session_id?: Id;
  materials?: { role: RoleMaterials; checkpoint: Checkpoint; documents: DocumentMaterials[] };
}

// ---------------------------------------------------------------------------
// Collaboration requests
// ---------------------------------------------------------------------------

export type CollaborationRequestState =
  | "accepted"
  | "queued"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export const TERMINAL_REQUEST_STATES = [
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly CollaborationRequestState[];

export type TerminalRequestState = (typeof TERMINAL_REQUEST_STATES)[number];

export interface ReadReceipt {
  document_key: Id;
  revision?: number;
}

export interface CollaborationRequest {
  request_id: Id;
  workspace_id: Id;
  idempotency_key: string;
  initiating: {
    session_id: Id;
    instance_id: Id;
    role_id: Id;
  };
  target_role_id: Id;
  /** Fixed in the accept transaction; existing requests never migrate. */
  binding: {
    target_generation: number;
    knowledge_revision: number;
    checkpoint_id?: Id;
  };
  budget?: {
    max_turns?: number;
    deadline?: Iso8601Timestamp;
  };
  state: CollaborationRequestState;
  execution_uncertain?: boolean;
  read_receipts?: ReadReceipt[];
  read_exception_rationale?: string;
  result?: {
    artifact_id: Id;
    content_hash: Sha256;
    summary?: string;
  };
  error?: {
    code: ErrorCode;
    message: string;
  };
  created_at: Iso8601Timestamp;
  updated_at: Iso8601Timestamp;
  terminal_at?: Iso8601Timestamp;
}

// ---------------------------------------------------------------------------
// Read receipts and candidate updates (P2)
// ---------------------------------------------------------------------------

/** Recorded by documents.read under the calling session's true binding. */
export interface DocumentReadReceipt {
  receipt_id: Id;
  workspace_id: Id;
  session_id: Id;
  instance_id?: Id;
  reader_role_id: Id;
  owner_role_id: Id;
  document_key: Id;
  revision: number;
  content_hash: Sha256;
  read_at: Iso8601Timestamp;
}

export type CandidateUpdateSource = "documents.propose" | "knowledge.import";

export type CandidateUpdateState = "open" | "adopted" | "superseded" | "rejected";

export interface CandidateUpdate {
  candidate_id: Id;
  workspace_id: Id;
  target_role_id: Id;
  document_key: Id;
  /** Document revision the proposal was made against; re-checked at adoption. */
  baseline_revision: number;
  proposed_body_hash: Sha256;
  note?: string;
  proposed_by_session_id: Id;
  proposed_by_role_id: Id;
  source: CandidateUpdateSource;
  state: CandidateUpdateState;
  adopted_revision?: number;
  created_at: Iso8601Timestamp;
  resolved_at?: Iso8601Timestamp;
}

// ---------------------------------------------------------------------------
// Knowledge export manifest (P2)
// ---------------------------------------------------------------------------

export type KnowledgeExportScope = "share" | "workspace";

export interface KnowledgeExportEntry {
  owner_role_id: Id;
  document_key: Id;
  revision: number;
  content_hash: Sha256;
  visibility: DocumentVisibility;
  created_by_instance_id: Id;
  created_at: Iso8601Timestamp;
  file: string;
}

export interface KnowledgeExportCheckpoint {
  checkpoint_id: Id;
  role_id: Id;
  generation: number;
  knowledge_revision: number;
  content_hash: Sha256;
  file: string;
}

export interface KnowledgeExportManifest {
  manifest_version: "0.1";
  source_workspace_id: Id;
  scope: KnowledgeExportScope;
  exported_at: Iso8601Timestamp;
  content_hash_algorithm: "sha256";
  entries: KnowledgeExportEntry[];
  checkpoints?: KnowledgeExportCheckpoint[];
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface OutputEnvelope<T = unknown> {
  ok: true;
  data?: T;
  request_id?: string;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
  request_id?: string;
}

export type Envelope<T = unknown> = OutputEnvelope<T> | ErrorEnvelope;

/** P5-A: identities and grants issued only by trusted owner/host connections. */
export interface AuthorizationSource { kind: "human-event" | "owner-selection"; event_ref: string; actor_id: string }
/**
 * B0 (P5-H b1): verbatim facts of a human role-authorization confirmation,
 * read back by the adapter's readHumanAuthorization port. Schema
 * human-authorization-event adds the trusted-entry provenance on the stored
 * record; the port returns only these facts.
 */
export interface HumanAuthorizationEvent {
  workspace_id: string; host_session_id: string; connection_subject: string; event_ref: string;
  actor_id: string; role_id: string; capabilities: string[]; inherit: "initialize" | "takeover"; expires_at: string;
}
/** Trusted local entry that captured the confirmation; written by owner-face code only. */
export type HumanAuthorizationEntry = "cli-console" | "gui-confirm";
export interface HumanAuthorizationEventRecord extends HumanAuthorizationEvent {
  entry: HumanAuthorizationEntry; recorded_at: string;
}
export interface ExternalSession {
  external_session_id: string; workspace_id: string; adapter: string; host_session_id: string;
  connection_subject: string; capability_ceiling: string[]; state: "connected" | "disconnected"; created_at: string;
}
export interface RoleAuthorization {
  authorization_id: string; workspace_id: string; external_session_id: string; connection_subject: string;
  role_id: string; role_contract: { package_name: string; package_version: string; content_hash: string };
  capabilities: string[]; inherit: "initialize" | "takeover"; expected_generation: number;
  expected_instance_id: string | null; expires_at: string; revoked_at: string | null;
  source: AuthorizationSource; created_at: string;
}
export interface AnchorConfirmation { host_session_id: string; load_key: string; content_hash: string; load_version: number }
export interface AnchorAttempt {
  attempt_id: string; external_session_id: string; authorization_id: string; idempotency_key: string;
  input_hash: string; bundle_hash: string; load_key: string; source_generation: number;
  source_knowledge_revision: number; state: "prepared" | "loading" | "uncertain" | "active" | "failed";
  confirmation: AnchorConfirmation | null; error: { code: string; message: string } | null; created_at: string;
}
export interface SessionBinding {
  external_session_id: string; session_id: string; instance_id: string; role_id: string; generation: number;
  authorization_id: string; state: "active" | "superseded" | "released" | "revoked" | "expired";
  capabilities: string[]; source: AuthorizationSource; created_at: string;
}
export type SessionOperation = "sessions.anchor" | "sessions.binding" | "sessions.reconcile" | "sessions.release" | "authorizations.get";

/** Owner-facing service runtime projection (desktop-gui-contract §2.3, G1). */
export interface WorkspaceServiceInfo {
  workspace_id: string;
  service: {
    /** Service package version line (non-sensitive; no argv, no paths). */
    version: string;
    /** Process id of the service holding the workspace writer. */
    pid: number;
    started_at: string;
    /** Adapter identifier the coordinator was opened with (e.g. "mock"). */
    adapter: string;
    /** Node runtime of the service process (expected v22.23.2). */
    runtime: string;
  };
}

/** Role detail projection for the owner role library (desktop-gui-contract §2.3, G2). */
export interface RoleDocumentTemplate {
  key: string;
  title?: string;
  visibility: string;
  description?: string;
  /** Template BODY resolved from the installed, hash-pinned pack copy. */
  template: string;
}

export interface RoleOutputSchemaSummary {
  key: string;
  schema: string;
}

export interface RoleDetails {
  workspace_id: string;
  role_id: string;
  title: string;
  /** Responsibility text declared by the role pack (pack data, not core logic). */
  instructions: string;
  description?: string;
  pack: { name: string; version: string; content_hash: string };
  initialized: boolean;
  generation: number;
  knowledge_revision: number;
  /** Actual primary pointer; null when the role has no initialized generation. */
  current_instance_id: string | null;
  requested_capabilities: string[];
  granted_capabilities: string[];
  documents: RoleDocumentTemplate[];
  output_schemas: RoleOutputSchemaSummary[];
}

/** One page of the owner policy table (desktop-gui-contract §2.3, G2). */
export interface PolicyEntry {
  role_id: string;
  title: string;
  requested: string[];
  granted: string[];
}

export interface PolicyListPage {
  workspace_id: string;
  observed_at: string;
  items: PolicyEntry[];
  next_cursor: string | null;
}

/** Service-side adapter capability projection (desktop-gui-contract §2.3, G2).
 * Desktop-side preflight (runner/egress/connection test) is reported separately. */
export interface WorkspaceRuntimeStatus {
  workspace_id: string;
  observed_at: string;
  runtime: {
    adapter: string;
    level: "full" | "restricted";
    isolation: { context: boolean; temp_writes: boolean; results: boolean; capability_scope: boolean };
  };
}

/** G3 (desktop-gui-contract §2.3): one stored human event with the
 * authorization it produced (if any). Projection only — reading never
 * advances the chain. */
export interface ConfirmationEventView {
  event_ref: string;
  actor_id: string;
  role_id: string;
  capabilities: string[];
  inherit: "initialize" | "takeover";
  expires_at: string;
  entry: HumanAuthorizationEntry;
  recorded_at: string;
  authorization: { authorization_id: string; created_at: string; revoked_at: string | null; expected_generation: number } | null;
}

/** G3 owner read view of the confirmation progress chain for one registered
 * external session: stored human events → authorizations → latest anchor
 * attempt → binding. The GUI displays the stages separately; "event stored"
 * never means "bound". */
export interface ConfirmationChainEntry {
  external_session_id: string;
  host_session_id: string;
  connection_subject: string;
  created_at: string;
  events: ConfirmationEventView[];
  anchor_attempt: {
    attempt_id: string;
    authorization_id: string;
    state: AnchorAttempt["state"];
    created_at: string;
    error: { code: string; message: string } | null;
    load: AnchorConfirmation | null;
  } | null;
  binding: { session_id: string; role_id: string; generation: number; state: SessionBinding["state"]; created_at: string } | null;
}

export interface AuthorizationConfirmationsPage {
  workspace_id: string;
  observed_at: string;
  items: ConfirmationChainEntry[];
  next_cursor: string | null;
}

/** G3 trusted-face read view: human events stored for THIS connection
 * subject's registered sessions that have no live authorization yet. The
 * subject comes from the trusted principal, never from RPC input. */
export interface PendingHumanEventView {
  external_session_id: string;
  host_session_id: string;
  event_ref: string;
  role_id: string;
  capabilities: string[];
  inherit: "initialize" | "takeover";
  expires_at: string;
  recorded_at: string;
}

export interface PendingHumanEventsPage {
  workspace_id: string;
  observed_at: string;
  items: PendingHumanEventView[];
}

/** G3 (desktop-gui-contract §9): read-only discovery candidate from the
 * host. `registered_external_session_id` marks sessions already registered
 * in this workspace; discovery never creates or attaches anything. */
export interface HostSessionCandidate {
  host_session_id: string;
  title: string | null;
  status: string | null;
  kind: string | null;
  updated_at: string | null;
  registered_external_session_id: string | null;
}

export interface HostSessionDiscovery {
  workspace_id: string;
  observed_at: string;
  adapter: string;
  items: HostSessionCandidate[];
}

/** G4 (desktop-gui-contract §2.3): owner read view of one session binding.
 * `state` is the stored state; `effective_state` is display-level validity —
 * an `active` row whose role head has moved displays `superseded` without the
 * projection writing anything. Connection availability is reported on the
 * external session, never folded into this state. */
export interface SessionBindingView {
  external_session_id: string;
  host_session_id: string;
  session_id: string;
  instance_id: string;
  /** Predecessor primary instance this generation took over from. */
  predecessor_instance_id: string | null;
  role_id: string;
  generation: number;
  state: SessionBinding["state"];
  effective_state: SessionBinding["state"];
  /** Effective capabilities (scope ∩ policy grants ∩ authorization) for
   * active/superseded; empty for withdrawn states. */
  capabilities: string[];
  authorization: {
    authorization_id: string;
    revoked_at: string | null;
    expires_at: string;
    source: AuthorizationSource;
    /** The attempt that activated this binding carries the load facts. */
    source_knowledge_revision: number | null;
  } | null;
  /** Checkpoint the binding's materials were built on, if any. */
  checkpoint_id: string | null;
  created_at: string;
  /** When the binding entered its current state (creation, or the release/
   * revocation/expiry transition); null for rows written before the column
   * existed. Never fabricated. */
  state_changed_at: string | null;
}

export interface SessionBindingsPage {
  workspace_id: string;
  observed_at: string;
  items: SessionBindingView[];
  next_cursor: string | null;
}

/** G4 owner read view of one anchor attempt. `error` stays at the
 * error-message layer (desktop-gui-contract §3.1); `confirmation` carries
 * the four load-confirmation judges when the host confirmed the load. */
export interface AnchorAttemptView {
  attempt_id: string;
  external_session_id: string;
  host_session_id: string;
  authorization_id: string;
  state: AnchorAttempt["state"];
  source_generation: number;
  source_knowledge_revision: number;
  bundle_hash: string;
  load_key: string;
  confirmation: AnchorConfirmation | null;
  error: { code: string; message: string } | null;
  created_at: string;
}

export interface AnchorAttemptsPage {
  workspace_id: string;
  observed_at: string;
  items: AnchorAttemptView[];
  next_cursor: string | null;
}

/** G4 owner read view of one material load record. `load_version`/`confirmed_at`
 * stay null until the host confirmed the load. */
export interface AnchorLoadView {
  load_key: string;
  attempt_id: string;
  external_session_id: string;
  bundle_hash: string;
  load_version: number | null;
  prepared_at: string;
  confirmed_at: string | null;
}

export interface AnchorLoadsPage {
  workspace_id: string;
  observed_at: string;
  items: AnchorLoadView[];
  next_cursor: string | null;
}

/** G4 read-only impact preview for `authorizations.revoke`: what would stop
 * working if this authorization were revoked right now. Revoking is a
 * separate explicit write; the preview never revokes. */
export interface RevokePreview {
  workspace_id: string;
  observed_at: string;
  authorization: {
    authorization_id: string;
    role_id: string;
    external_session_id: string;
    host_session_id: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
  };
  /** Live (active/superseded) bindings that would be invalidated. */
  bindings: Array<{ external_session_id: string; session_id: string; role_id: string; generation: number; state: SessionBinding["state"] }>;
  /** Non-terminal delegated requests that would be withdrawn under the
   * existing revocation rules (binding withdrawn → task authorization gone). */
  requests: Array<{
    request_id: string;
    state: CollaborationRequestState;
    execution_uncertain: boolean;
    cleanup_pending: boolean;
    target_role_id: string;
    question: string;
  }>;
}

/** G5 (desktop-gui-contract §2.3): one document-directory entry for the owner
 * knowledge page. Bodies never appear here — the directory is metadata only. */
export interface OwnerDocumentEntry {
  role_id: string;
  document_key: string;
  /** 0 when the declared document has no published revision yet. */
  latest_revision: number;
  visibility: DocumentVisibility | null;
  updated_at: string | null;
  content_hash: string | null;
}

export interface OwnerDocumentListPage {
  workspace_id: string;
  observed_at: string;
  items: OwnerDocumentEntry[];
  next_cursor: string | null;
}

/** G5 owner read of one document revision. `body_included: false` marks the
 * private/role ladder per the §3.2 matrix — metadata + hash only, the body
 * never crosses the boundary; `body` is the raw published bytes the
 * content_hash was computed over. */
export interface OwnerDocumentRead {
  workspace_id: string;
  observed_at: string;
  role_id: string;
  document_key: string;
  revision: number;
  visibility: DocumentVisibility;
  content_hash: string;
  created_at: string;
  created_by_instance_id: string | null;
  body_included: boolean;
  body: string | null;
}

export interface OwnerDocumentRevisionEntry {
  revision: number;
  content_hash: string;
  visibility: DocumentVisibility;
  created_by_instance_id: string | null;
  created_at: string;
}

export interface OwnerDocumentRevisionsPage {
  workspace_id: string;
  observed_at: string;
  role_id: string;
  document_key: string;
  items: OwnerDocumentRevisionEntry[];
  next_cursor: string | null;
}

/** G5 owner read of one candidate. The candidate BODY is always included
 * (§3.2: candidates are explicitly submitted for review); the BASELINE body
 * follows the private/role rule and never rides along. `baseline_conflicted`
 * is display-level: the candidate's baseline is older than the current latest
 * revision — shown, never auto-merged. */
export interface OwnerCandidateEntry {
  candidate_id: string;
  target_role_id: string;
  document_key: string;
  state: CandidateUpdateState;
  source: CandidateUpdateSource | "request.result";
  note: string | null;
  proposed_by_role_id: string;
  baseline_revision: number;
  latest_revision: number;
  baseline_conflicted: boolean;
  proposed_body_hash: string;
  body_included: boolean;
  body: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface OwnerCandidatesPage {
  workspace_id: string;
  observed_at: string;
  items: OwnerCandidateEntry[];
  next_cursor: string | null;
}

/** G5 checkpoint summary: handoff summary METADATA (format + hash, no body)
 * and the todo overview; the full body lives behind checkpoints.get. */
export interface OwnerCheckpointSummary {
  checkpoint_id: string;
  role_id: string;
  generation: number;
  knowledge_revision: number;
  document_snapshots: DocumentSnapshot[];
  handoff_summary: { format: "markdown"; content_hash: string };
  todos_total: number;
  todos_done: number;
  todos_open: Array<{ description: string }>;
  created_by_instance_id: string;
  created_at: string;
}

export interface OwnerCheckpointListPage {
  workspace_id: string;
  observed_at: string;
  items: OwnerCheckpointSummary[];
  next_cursor: string | null;
}

/** G5 checkpoint detail: the full handoff summary body (explicitly written
 * handoff product, §3.2 full text for the owner) plus todos/sources/refs. */
export interface OwnerCheckpointDetail {
  workspace_id: string;
  observed_at: string;
  checkpoint_id: string;
  role_id: string;
  generation: number;
  knowledge_revision: number;
  document_snapshots: DocumentSnapshot[];
  handoff_summary: { format: "markdown"; body: string; content_hash: string };
  user_decision_refs: UserDecisionRef[];
  todos: CheckpointTodo[];
  sources: CheckpointSource[];
  created_by_instance_id: string;
  created_at: string;
}

/** G6 (desktop-gui-contract §2.3): owner request summary. Usage is what the
 * host actually REPORTED — null means unknown (never rendered as 0). */
export interface OwnerRequestSummary {
  request_id: string;
  initiating: { session_id: string; instance_id: string; role_id: string };
  target_role_id: string;
  state: CollaborationRequestState;
  execution_uncertain: boolean;
  cleanup_pending: boolean;
  binding: { target_generation: number; knowledge_revision: number };
  budget: { max_turns?: number; deadline?: string };
  usage: { output_bytes: number | null; turns_reserved: number | null };
  result: { artifact_id: string; content_hash: string; summary?: string } | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  question_preview: string;
}

export interface OwnerRequestInboxPage {
  workspace_id: string;
  observed_at: string;
  items: OwnerRequestSummary[];
  next_cursor: string | null;
}

/** G6 owner read of one request: full question (including appended
 * clarification turns), budget and reported usage. */
export interface OwnerRequestDetail {
  workspace_id: string;
  observed_at: string;
  request_id: string;
  idempotency_key: string;
  initiating: { session_id: string; instance_id: string; role_id: string };
  target_role_id: string;
  state: CollaborationRequestState;
  execution_uncertain: boolean;
  cleanup_pending: boolean;
  binding: { target_generation: number; knowledge_revision: number };
  budget: { max_turns?: number; deadline?: string };
  usage: { output_bytes: number | null; turns_reserved: number | null };
  question: string;
  result: { artifact_id: string; content_hash: string; summary?: string } | null;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

/** G6 owner artifact read: the raw bytes the content_hash was computed over.
 * Reading grants no write/publish right. */
export interface OwnerArtifactRead {
  workspace_id: string;
  observed_at: string;
  artifact_id: string;
  request_id: string;
  producing_role_id: string;
  content_hash: string;
  body: string;
  created_at: string;
}

/** G6 cleanup (reclamation) view: terminal requests with their reclamation
 * state. A cleanup FAILURE is distinguishable from completion via
 * cleanup_error and never changes the terminal state. */
export interface OwnerCleanupEntry {
  request_id: string;
  state: TerminalRequestState;
  cleanup_pending: boolean;
  cleanup_error: { code: string; message: string } | null;
  terminal_at: string | null;
}

export interface OwnerCleanupPage {
  workspace_id: string;
  observed_at: string;
  items: OwnerCleanupEntry[];
  next_cursor: string | null;
}

/** G6 owner management cancellation result (§6 matrix). `idempotent_replay`
 * marks a same-key replay returning the FIRST result. */
export interface OwnerCancelResult {
  request_id: string;
  state: CollaborationRequestState;
  idempotent_replay: boolean;
  observed_at: string;
}
