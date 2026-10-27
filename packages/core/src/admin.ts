import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RoleDockError } from "@roledock/protocol";
import type { RoleDefinition, RoleDetails, PolicyListPage } from "@roledock/protocol";
import { checkWorkspaceId } from "./roles/install.js";
import { getHead, getPack, getRoleRow, listRoleRows } from "./store/queries.js";
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

  /**
   * Owner read: full role detail projection (desktop-gui-contract §2.3, G2;
   * content resolution per G2-R06 re-review). Instructions/templates/schema
   * references are resolved against the INSTALLED, hash-pinned pack copy —
   * never the mutable source directory — with a strict size cap and a
   * traversal guard; the renderer receives readable bodies, never paths to
   * open.
   */
  roleDetails(input: unknown): RoleDetails {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const roleId = requiredString(record, "role_id");
    const row = getRoleRow(this.store, roleId);
    if (row === undefined) {
      throw new RoleDockError("NOT_FOUND", `Role "${roleId}" is not installed in this workspace.`);
    }
    const packRow = getPack(this.store, row.pack_name, row.pack_version);
    if (packRow === undefined) {
      throw new RoleDockError("INTERNAL", `Role "${roleId}" references missing pack ${row.pack_name}@${row.pack_version}.`);
    }
    const packDir = join(this.store.packsDir, packRow.store_path);
    const head = getHead(this.store, roleId);
    const definition = JSON.parse(row.definition_json) as RoleDefinition;
    const grants = this.store.getConfig().policy.grants;
    return {
      workspace_id: this.store.workspaceId,
      role_id: row.role_id,
      title: row.title,
      instructions: this.#packText(packDir, row.instructions),
      ...(definition.description === undefined ? {} : { description: definition.description }),
      pack: { name: packRow.name, version: packRow.version, content_hash: packRow.content_hash },
      initialized: (head?.generation ?? 0) > 0,
      generation: head?.generation ?? 0,
      knowledge_revision: head?.knowledge_revision ?? 0,
      current_instance_id: head?.current_instance_id ?? null,
      requested_capabilities: definition.requested_capabilities ?? [],
      granted_capabilities: [...(grants[roleId] ?? [])],
      documents: (definition.documents ?? []).map((document) => ({
        key: document.key,
        ...(document.title === undefined ? {} : { title: document.title }),
        visibility: document.visibility,
        ...(document.description === undefined ? {} : { description: document.description }),
        template: this.#packText(packDir, document.template),
      })),
      output_schemas: (definition.output_schemas ?? []).map((schema) => ({ key: schema.key, schema: this.#packText(packDir, schema.schema) })),
    };
  }

  /**
   * Resolves a role-pack reference to readable body text from the installed
   * copy (G2-R06, re-review). The rolepack schema defines instructions /
   * template / schema as PACK-RELATIVE FILE PATHS — there is no inline-text
   * branch, and extensions are not part of the contract, so every reference
   * is resolved as a path. Missing/unreadable material is an explicit error,
   * never a path masquerading as body text. Traversal outside the pack
   * directory is rejected; bodies are capped (128 KiB) to stay bounded.
   */
  #packText(packDir: string, reference: string): string {
    const MAX = 128 * 1024;
    if (reference.includes("\0")) {
      throw new RoleDockError("INTERNAL", "Role material reference contains a NUL byte.");
    }
    const target = resolve(packDir, reference);
    if (!target.startsWith(resolve(packDir) + "/")) {
      throw new RoleDockError("INTERNAL", `Role material escapes the installed pack directory: ${reference}`);
    }
    let stat;
    try {
      stat = statSync(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new RoleDockError("INTERNAL", `Role material is missing from the installed pack copy: ${reference} (${code}). The installed content is pinned by content_hash; the source directory may have changed or the material was not installed.`);
    }
    if (!stat.isFile()) {
      throw new RoleDockError("INTERNAL", `Role material is not a regular file in the installed pack copy: ${reference}`);
    }
    try {
      return readFileSync(target, "utf8").slice(0, MAX);
    } catch (error) {
      throw new RoleDockError("INTERNAL", `Role material is unreadable from the installed pack copy: ${reference} (${(error as NodeJS.ErrnoException).code ?? "unknown"}).`);
    }
  }

  /** Owner read: paginated policy table (contract §2.1 pagination rules). */
  listPolicy(input: unknown = {}): PolicyListPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const limit = record.limit ?? 50;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
      throw new RoleDockError("VALIDATION_FAILED", "limit must be an integer between 1 and 200.");
    }
    let start = 0;
    if (record.cursor !== undefined && record.cursor !== null) {
      if (typeof record.cursor !== "string") throw new RoleDockError("VALIDATION_FAILED", "cursor must be a string.");
      const decoded = Number(Buffer.from(record.cursor, "base64").toString("utf8"));
      if (!Number.isInteger(decoded) || decoded < 0) throw new RoleDockError("VALIDATION_FAILED", "cursor is not a valid page offset.");
      start = decoded;
    }
    const grants = this.store.getConfig().policy.grants;
    const rows = listRoleRows(this.store).sort((a, b) => a.role_id.localeCompare(b.role_id));
    const page = rows.slice(start, start + (limit as number));
    const items = page.map((row) => {
      const definition = JSON.parse(row.definition_json) as RoleDefinition;
      return {
        role_id: row.role_id,
        title: row.title,
        requested: definition.requested_capabilities ?? [],
        granted: [...(grants[row.role_id] ?? [])],
      };
    });
    const next = start + (limit as number) < rows.length ? Buffer.from(String(start + (limit as number))).toString("base64") : null;
    return { workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), items, next_cursor: next };
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
