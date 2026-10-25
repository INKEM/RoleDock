import { RoleDockError } from "@roledock/protocol";

/**
 * Capability name shape, mirroring the rolepack schema pattern. Requests are
 * namespaced ("documents.read"); the protocol defines no fixed vocabulary.
 */
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function assertCapabilityName(capability: string): void {
  if (!CAPABILITY_PATTERN.test(capability)) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Capability name "${capability}" is not a namespaced capability (expected e.g. "documents.read").`,
      { details: { capability } },
    );
  }
}

export type CapabilityGrants = Readonly<Record<string, readonly string[]>>;

/**
 * Evaluate one capability for one role against the workspace policy grants.
 *
 * This is the ONLY authority source: a caller-supplied role id with no
 * matching grant has no capability, no matter what the role pack requested.
 * `requested_capabilities` never becomes a grant automatically; only the
 * workspace owner's explicit admin entries create grants.
 */
export function evaluate(grants: CapabilityGrants, roleId: string, capability: string): boolean {
  return grants[roleId]?.includes(capability) ?? false;
}

import type { WorkspaceStore } from "./store/workspace.js";
import type { TrustedIdentity } from "./identity.js";
import { requireBindingCapability, requireDelegatedAuthorizations } from "./sessions/authorization.js";

export function requireCapability(store: WorkspaceStore, roleId: string | undefined, capability: string): void {
  if (!roleId || !evaluate(store.getConfig().policy.grants, roleId, capability)) {
    throw new RoleDockError("PERMISSION_DENIED", `Workspace policy denies ${capability}.`, { details: { capability } });
  }
}

export function requireSessionCapability(store: WorkspaceStore, identity: TrustedIdentity, capability: string): void {
  requireBindingCapability(store, identity.sessionId, capability);
  requireCapability(store, identity.roleId, capability);
  const row = store.prepare("SELECT kind, capability_scope_json FROM sessions WHERE id = ?").get(identity.sessionId) as { kind: string; capability_scope_json: string | null };
  if (row.kind === "request" && !(JSON.parse(row.capability_scope_json ?? "[]") as string[]).includes(capability)) {
    throw new RoleDockError("PERMISSION_DENIED", `Request scope denies ${capability}.`);
  }
  if (row.kind === "primary" && row.capability_scope_json !== null && !(JSON.parse(row.capability_scope_json) as string[]).includes(capability)) {
    throw new RoleDockError("PERMISSION_DENIED", `Loaded session scope denies ${capability}.`);
  }
  if (row.kind === "request") {
    const request = store.prepare("SELECT request_id FROM requests WHERE ('request-' || request_id) = (SELECT creation_key FROM sessions WHERE id = ?)").get(identity.sessionId) as { request_id: string } | undefined;
    if (request) requireDelegatedAuthorizations(store, request.request_id);
  }
}
