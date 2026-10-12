import type { ErrorCode } from "./error-codes.js";
import type { ErrorEnvelope } from "./types.js";

export interface RoleDockErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  requestId?: string;
}

/**
 * The single error type every SDK operation and CLI command produces.
 * Convert to a machine-readable envelope with toEnvelope() at the boundary.
 */
export class RoleDockError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(code: ErrorCode, message: string, options: RoleDockErrorOptions = {}) {
    super(message);
    this.name = "RoleDockError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope["error"] = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) error.details = this.details;
    const envelope: ErrorEnvelope = { ok: false, error };
    if (this.requestId !== undefined) envelope.request_id = this.requestId;
    return envelope;
  }
}

export function isRoleDockError(value: unknown): value is RoleDockError {
  return value instanceof RoleDockError;
}

/** Normalize anything thrown into an error envelope; unknown causes become INTERNAL and never masquerade as domain outcomes. */
export function toErrorEnvelope(value: unknown): ErrorEnvelope {
  if (isRoleDockError(value)) return value.toEnvelope();
  const message = value instanceof Error ? value.message : String(value);
  return new RoleDockError("INTERNAL", message).toEnvelope();
}
