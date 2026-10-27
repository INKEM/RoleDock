import { createHash } from "node:crypto";
import { RoleDockError } from "@roledock/protocol";

/**
 * G-min confirmation decision logic (extracted in P6-G1 for module reuse;
 * behavior unchanged from the accepted G-min delivery).
 *
 * Both entry surfaces share this module:
 * - the loopback http diagnostic entry (src/index.ts, roledock-desktop-gmin),
 * - the desktop shell's production confirm page (src/shell/main/ipc.ts),
 *   where the Electron main process resolves entry/event_ref server-side.
 * The rendering surface never supplies provenance: `entry=gui-confirm` and
 * the event reference are always computed here, in the trusted process
 * (ADR-0007/ADR-0011 boundary).
 */

export const CONFIRM_ENTRY = "gui-confirm";
export const ID = /^[a-z][a-z0-9-]{0,63}$/;
export const CAP = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export interface SessionView { session: { external_session_id: string; host_session_id: string; connection_subject: string; created_at: string }; active_authorization: { authorization_id: string; role_id: string; expires_at: string; source: { kind: string; event_ref: string } } | null }
export interface RoleView { role_id: string; title: string; initialized: boolean; requested_capabilities: string[] }

/** Normalizes a session list reply that may be wrapped or bare. */
export function sessionViews(reply: SessionView[] | { external_sessions?: SessionView[] }): SessionView[] {
  return Array.isArray(reply) ? reply : reply.external_sessions ?? [];
}

export function confirmInput(sessions: SessionView[], roles: RoleView[], body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.external_session_id !== "string" || !ID.test(body.external_session_id)) throw new RoleDockError("VALIDATION_FAILED", "Invalid external_session_id.");
  if (typeof body.role_id !== "string" || !ID.test(body.role_id)) throw new RoleDockError("VALIDATION_FAILED", "Invalid role_id.");
  const view = sessions.find(item => item.session.external_session_id === body.external_session_id);
  if (!view) throw new RoleDockError("NOT_FOUND", "External session is not registered; the Agent must register it first.");
  if (view.active_authorization) throw new RoleDockError("INVALID_STATE_TRANSITION", "This session already has a live authorization; revoke it first or use a new conversation.");
  const role = roles.find(item => item.role_id === body.role_id);
  if (!role) throw new RoleDockError("NOT_FOUND", "Role is not installed.");
  const capabilities = Array.isArray(body.capabilities) && body.capabilities.every(item => typeof item === "string" && CAP.test(item)) ? [...new Set(body.capabilities as string[])].sort() : null;
  if (!capabilities || capabilities.length === 0) throw new RoleDockError("VALIDATION_FAILED", "capabilities must be a non-empty array of dotted capability names.");
  if (body.inherit !== "initialize" && body.inherit !== "takeover") throw new RoleDockError("VALIDATION_FAILED", "inherit must be initialize or takeover.");
  if (!Number.isInteger(body.expires_hours) || (body.expires_hours as number) < 1 || (body.expires_hours as number) > 168) throw new RoleDockError("VALIDATION_FAILED", "expires_hours must be an integer between 1 and 168.");
  // G3 stable action ID (desktop-gui-contract §5): the event reference and
  // expiry are derived from the confirmation INTENT, not from wall-clock
  // randomness — a double click, refresh or window reopen replays the same
  // intent through the idempotent submitHumanEvent store instead of writing
  // a second event that could produce a duplicate live authorization.
  const bucket = Math.floor((Date.now() + 3_600_000) / 3_600_000) * 3_600_000;
  const expires_at = new Date(bucket + (body.expires_hours as number) * 3_600_000).toISOString();
  const event_ref = `gui-${createHash("sha256").update(JSON.stringify({
    external_session_id: view.session.external_session_id,
    host_session_id: view.session.host_session_id,
    role_id: body.role_id,
    capabilities,
    inherit: body.inherit,
    expires_at,
  })).digest("hex").slice(0, 24)}`;
  return {
    external_session_id: view.session.external_session_id,
    host_session_id: view.session.host_session_id,
    connection_subject: view.session.connection_subject,
    event_ref,
    actor_id: "owner",
    role_id: body.role_id,
    capabilities,
    inherit: body.inherit,
    expires_at,
    entry: CONFIRM_ENTRY,
    recorded_at: new Date().toISOString(),
  };
}
