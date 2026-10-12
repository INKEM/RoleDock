/**
 * Protocol error code registry.
 *
 * This object is the single authorial source of error codes. The enum in
 * schemas/error-envelope.schema.json (and the copy inside
 * schemas/collaboration-request.schema.json) must list exactly the same
 * codes; tests/conformance asserts the sets are identical.
 */
export const ERROR_CODES = {
  /** The operation is specified by the protocol but not implemented in this build; it must never fake success. */
  NOT_IMPLEMENTED: "not implemented",
  /** Input was rejected by schema or semantic validation. */
  VALIDATION_FAILED: "validation failed",
  /** A referenced object does not exist. */
  NOT_FOUND: "not found",
  /** The trusted session identity lacks the required permission under the workspace policy. */
  PERMISSION_DENIED: "permission denied",
  /** Installing a role pack would collide with an existing role id; resolve explicitly, never silently overwrite. */
  ROLE_ALREADY_EXISTS: "role already exists",
  /** The target role has no primary instance yet; open the role explicitly first. */
  ROLE_UNINITIALIZED: "role uninitialized",
  /** Handoff compare-and-swap failed: the primary pointer moved concurrently; exactly one activation wins. */
  GENERATION_CONFLICT: "generation conflict",
  /** Publish rejected: expected_revision does not match the current revision of the document. */
  REVISION_CONFLICT: "revision conflict",
  /** The transition is not allowed by the state machine, e.g. publishing from an old generation or reviving a terminal request. */
  INVALID_STATE_TRANSITION: "invalid state transition",
  /** Same idempotency key reused with different content. */
  IDEMPOTENCY_CONFLICT: "idempotency conflict",
  /** Cancel was requested on a request that is no longer cancellable. */
  REQUEST_NOT_TERMINABLE: "request not terminable",
  /** The harness adapter lacks a required capability; the binding must report a restricted level instead of pretending. */
  ADAPTER_CAPABILITY_MISSING: "adapter capability missing",
  /** Another coordinator process holds the workspace write lock; only one coordinator may write a workspace (ADR-0001). */
  WORKSPACE_LOCKED: "workspace locked",
  /** Unexpected internal failure; always report, never mask as a domain outcome. */
  INTERNAL: "internal error",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
