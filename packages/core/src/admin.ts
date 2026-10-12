import { RoleDockError } from "@roledock/protocol";
import type { RoleDefinition } from "@roledock/protocol";
import { checkWorkspaceId } from "./roles/install.js";
import { getRoleRow, listRoleRows } from "./store/queries.js";
import { WorkspaceStore } from "./store/workspace.js";
import type { HandleOptions } from "./options.js";
import { assertCapabilityName } from "./policy.js";
import { optionalString, requiredString, asRecord } from "./parse.js";

export interface PolicyEntry {
  role_id: string;
  title: string;
  requested: string[];
  granted: string[];
}

export interface PolicyReport {
  workspace_id: string;
  roles: PolicyEntry[];
}

export interface GrantResult {
  role_id: string;
  capability: string;
  granted: boolean;
  /** True when the grant (or its removal) was already in effect. */
  already_applied: boolean;
}

/**
 * Local owner management entry for workspace policy (docs/spec/identity-and-permissions.md).
 *
 * This is the trusted, owner-side surface: it is the only way capabilities
 * become grants. It is separate from the session-call surface (Coordinator),
 * whose actors must hold a trusted session identity. Installing a role pack
 * never touches this policy.
 */
export class WorkspaceAdmin {
  static open(options: HandleOptions): WorkspaceAdmin {
    const store = WorkspaceStore.open({ root: options.root });
    try {
      checkWorkspaceId(store, options.workspaceId);
    } catch (error) {
      store.close();
      throw error;
    }
    return new WorkspaceAdmin(store);
  }

  private constructor(private readonly store: WorkspaceStore) {}

  get workspaceId(): string {
    return this.store.workspaceId;
  }

  get root(): string {
    return this.store.root;
  }

  close(): void {
    this.store.close();
  }

  showPolicy(input: unknown = {}): PolicyReport {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const grants = this.store.getConfig().policy.grants;
    const roles = listRoleRows(this.store).map((row) => {
      const definition = JSON.parse(row.definition_json) as RoleDefinition;
      return {
        role_id: row.role_id,
        title: row.title,
        requested: definition.requested_capabilities ?? [],
        granted: [...(grants[row.role_id] ?? [])],
      };
    });
    return { workspace_id: this.store.workspaceId, roles };
  }

  grant(input: unknown): GrantResult {
    return this.applyGrant(input, "grant");
  }

  revoke(input: unknown): GrantResult {
    return this.applyGrant(input, "revoke");
  }

  private applyGrant(input: unknown, direction: "grant" | "revoke"): GrantResult {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const roleId = requiredString(record, "role_id");
    const capability = requiredString(record, "capability");
    assertCapabilityName(capability);

    const changed = this.store.tx(() => {
      if (getRoleRow(this.store, roleId) === undefined) {
        throw new RoleDockError(
          "NOT_FOUND",
          `Role "${roleId}" is not installed in this workspace.`,
          { details: { role_id: roleId } },
        );
      }
      const config = this.store.getConfig();
      const current = config.policy.grants[roleId] ?? [];
      const has = current.includes(capability);
      if (direction === "grant") {
        if (has) return false;
        config.policy.grants[roleId] = [...current, capability].sort();
      } else {
        if (!has) {
          throw new RoleDockError(
            "NOT_FOUND",
            `Role "${roleId}" does not hold capability "${capability}"; nothing to revoke.`,
            { details: { role_id: roleId, capability } },
          );
        }
        config.policy.grants[roleId] = current.filter((entry) => entry !== capability);
      }
      this.store.setConfig(config);
      return true;
    });

    return {
      role_id: roleId,
      capability,
      granted: direction === "grant",
      already_applied: !changed,
    };
  }
}
