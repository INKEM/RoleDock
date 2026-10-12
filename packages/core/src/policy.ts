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
