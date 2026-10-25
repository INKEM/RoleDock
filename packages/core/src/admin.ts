import { RoleDockError } from "@roledock/protocol";
import type { RoleDefinition } from "@roledock/protocol";
import { checkWorkspaceId } from "./roles/install.js";
import { getRoleRow, listRoleRows } from "./store/queries.js";
import { WorkspaceStore } from "./store/workspace.js";
import type { HandleOptions } from "./options.js";
import { assertCapabilityName } from "./policy.js";
import { optionalString, requiredString, asRecord } from "./parse.js";
import type { Coordinator } from "./coordinator.js";
import { coordinatorStore } from "./internal-store.js";

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
  /** Trusted local owner only; shares the service's existing writer. Do not expose to session tools. */
  static forCoordinator(coordinator: Coordinator): WorkspaceAdmin {
    return new WorkspaceAdmin(coordinatorStore(coordinator), false);
  }
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

  private constructor(private readonly store: WorkspaceStore, private readonly ownsStore = true) {}

  get workspaceId(): string {
    return this.store.workspaceId;
  }

  get root(): string {
    return this.store.root;
  }

  close(): void {
    if (this.ownsStore) this.store.close();
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

  /** Owner diagnostic: the collaboration-request inbox, optionally per role. */
  showInbox(input: unknown = {}): {
    workspace_id: string;
    entries: Array<{
      entry_id: string;
      owner_role_id: string;
      request_id: string;
      artifact_id: string;
      state: string;
      delivered_at: string;
    }>;
  } {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const ownerRoleId = optionalString(record, "owner_role_id");
    const rows = this.store
      .prepare("SELECT * FROM request_inbox ORDER BY delivered_at")
      .all() as unknown as Array<{
      workspace_id: string;
      entry_id: string;
      owner_role_id: string;
      request_id: string;
      artifact_id: string;
      state: string;
      delivered_at: string;
    }>;
    return {
      workspace_id: this.store.workspaceId,
      entries: rows
        .filter((row) => ownerRoleId === undefined || row.owner_role_id === ownerRoleId)
        .map(({ workspace_id: _workspaceId, ...entry }) => entry),
    };
  }

  /** Owner diagnostic: the pending-delivery event log (outbox). */
  showEvents(input: unknown = {}): {
    workspace_id: string;
    events: Array<{
      id: string;
      kind: string;
      state: string;
      created_at: string;
    }>;
  } {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const kind = optionalString(record, "kind");
    const rows = this.store
      .prepare("SELECT id, workspace_id, kind, state, created_at FROM outbox_events ORDER BY created_at")
      .all() as unknown as Array<{
      workspace_id: string;
      id: string;
      kind: string;
      state: string;
      created_at: string;
    }>;
    return {
      workspace_id: this.store.workspaceId,
      events: rows
        .filter((row) => kind === undefined || row.kind === kind)
        .map(({ workspace_id: _workspaceId, ...event }) => event),
    };
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
