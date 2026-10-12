import { RoleDockError } from "@roledock/protocol";
import { installRolePack } from "./roles/install.js";
import type { InstallRequest, InstallResult } from "./roles/install.js";
import { resolveRoleRecord, summarizeRoles } from "./roles/summary.js";
import type { RoleResolution, RoleSummary } from "./roles/summary.js";
import { WorkspaceStore } from "./store/workspace.js";
import type { HandleOptions } from "./options.js";
import { asRecord, optionalString, requiredString } from "./parse.js";
import { checkWorkspaceId } from "./roles/install.js";

const SPEC = "docs/spec/sdk-operations.md";

function notImplemented(operation: string): RoleDockError {
  return new RoleDockError(
    "NOT_IMPLEMENTED",
    `Operation "${operation}" is specified but not implemented in this build. See ${SPEC}.`,
    { details: { operation, spec: SPEC } },
  );
}

/**
 * The RoleDock coordinator: single writer per workspace (ADR-0001).
 *
 * Open with Coordinator.open({root}), which creates or attaches the
 * workspace and takes the single-writer lock; a second coordinator on the
 * same workspace fails with WORKSPACE_LOCKED. Close with close().
 *
 * Implemented operations (P1): roles.install/list/resolve — plus the
 * owner-side WorkspaceAdmin entry for capability policy. Every other
 * operation rejects with NOT_IMPLEMENTED until its delivery phase; none of
 * them may fake success. Operation contracts: docs/spec/sdk-operations.md.
 */
export class Coordinator {
  static open(options: HandleOptions): Coordinator {
    const store = WorkspaceStore.open({ root: options.root });
    try {
      checkWorkspaceId(store, options.workspaceId);
    } catch (error) {
      store.close();
      throw error;
    }
    return new Coordinator(store);
  }

  private constructor(private readonly store: WorkspaceStore) {}

  get workspaceId(): string {
    return this.store.workspaceId;
  }

  get root(): string {
    return this.store.root;
  }

  /** Release the workspace write lock. */
  close(): void {
    this.store.close();
  }

  // -- roles (implemented in P1) --------------------------------------------
  async installRolePack(input: unknown): Promise<InstallResult> {
    const record = asRecord(input);
    const request: InstallRequest = {
      sourcePath: requiredString(record, "source_path"),
    };
    const workspaceId = optionalString(record, "workspace_id");
    if (workspaceId !== undefined) request.workspaceId = workspaceId;
    return installRolePack(this.store, request);
  }

  async listRoles(input: unknown): Promise<{ roles: RoleSummary[] }> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    return { roles: summarizeRoles(this.store) };
  }

  async resolveRole(input: unknown): Promise<RoleResolution> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    return resolveRoleRecord(this.store, requiredString(record, "role_id"));
  }

  // -- sessions --------------------------------------------------------------
  async openSession(_input: unknown): Promise<never> {
    throw notImplemented("sessions.open");
  }
  async resumeSession(_input: unknown): Promise<never> {
    throw notImplemented("sessions.resume");
  }

  // -- documents -------------------------------------------------------------
  async listDocuments(_input: unknown): Promise<never> {
    throw notImplemented("documents.list");
  }
  async readDocument(_input: unknown): Promise<never> {
    throw notImplemented("documents.read");
  }
  async proposeDocumentUpdate(_input: unknown): Promise<never> {
    throw notImplemented("documents.propose");
  }
  async publishDocument(_input: unknown): Promise<never> {
    throw notImplemented("documents.publish");
  }

  // -- handoffs --------------------------------------------------------------
  async prepareHandoff(_input: unknown): Promise<never> {
    throw notImplemented("handoffs.prepare");
  }
  async activateHandoff(_input: unknown): Promise<never> {
    throw notImplemented("handoffs.activate");
  }

  // -- requests --------------------------------------------------------------
  async createRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.create");
  }
  async getRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.get");
  }
  async replyToRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.reply");
  }
  async cancelRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.cancel");
  }

  // -- artifacts ---------------------------------------------------------------
  async readArtifact(_input: unknown): Promise<never> {
    throw notImplemented("artifacts.read");
  }

  // -- knowledge ---------------------------------------------------------------
  async exportKnowledge(_input: unknown): Promise<never> {
    throw notImplemented("knowledge.export");
  }
  async importKnowledge(_input: unknown): Promise<never> {
    throw notImplemented("knowledge.import");
  }
}

/** All SDK operation names, derived from the Coordinator surface itself. */
/** Lifecycle and non-operation members that are not part of the SDK surface. */
const NON_OPERATIONS = new Set(["constructor", "close"]);

export function coordinatorOperations(): string[] {
  const proto = Coordinator.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => {
      if (NON_OPERATIONS.has(name)) return false;
      // Descriptor-based: invoking proto[name] would fire property getters.
      return typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function";
    })
    .sort();
}

/** Operations implemented as of P1; everything else rejects with NOT_IMPLEMENTED. */
export const IMPLEMENTED_OPERATIONS: readonly string[] = [
  "installRolePack",
  "listRoles",
  "resolveRole",
].sort();
