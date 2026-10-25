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
