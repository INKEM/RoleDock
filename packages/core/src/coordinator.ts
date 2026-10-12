import { RoleDockError } from "@roledock/protocol";
import type {
  KnowledgeExportScope,
} from "@roledock/protocol";
import { installRolePack, checkWorkspaceId } from "./roles/install.js";
import type { InstallRequest, InstallResult } from "./roles/install.js";
import { resolveRoleRecord, summarizeRoles } from "./roles/summary.js";
import type { RoleResolution, RoleSummary } from "./roles/summary.js";
import {
  listCandidates,
  listDocuments,
  proposeDocumentUpdate,
  publishDocument,
  readDocument,
} from "./documents/service.js";
import type {
  CandidateProposalResult,
  DocumentListEntry,
  DocumentPublishResult,
  DocumentReadResult,
} from "./documents/service.js";
import { exportKnowledge, importKnowledge } from "./knowledge/transfer.js";
import type { ExportResult, ImportResult } from "./knowledge/transfer.js";
import { WorkspaceStore } from "./store/workspace.js";
import type { HandleOptions } from "./options.js";
import { registerCoordinatorStore } from "./internal-store.js";
import { asRecord, optionalString, requiredString } from "./parse.js";

const SPEC = "docs/spec/sdk-operations.md";

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RoleDockError("VALIDATION_FAILED", `Input field "${key}" must be an integer.`, {
      details: { field: key },
    });
  }
  return value;
}

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
 * Implemented operations: roles.install/list/resolve (P1),
 * documents.list/read/propose/publish and knowledge.export/import (P2) —
 * plus the owner-side WorkspaceAdmin entry for capability policy. Session
 * identity for P2 operations comes from session bindings created through the
 * test-only @roledock/core/testing entry; sessions.open lands in P3. Every
 * other operation rejects with NOT_IMPLEMENTED until its delivery phase;
 * none of them may fake success. Contracts: docs/spec/sdk-operations.md.
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
    const coordinator = new Coordinator(store);
    registerCoordinatorStore(coordinator, store);
    return coordinator;
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

  // -- documents (implemented in P2) ------------------------------------------
  async listDocuments(input: unknown): Promise<{ documents: DocumentListEntry[] }> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const listInput: { session_id: string; role_id?: string } = {
      session_id: requiredString(record, "session_id"),
    };
    const roleId = optionalString(record, "role_id");
    if (roleId !== undefined) listInput.role_id = roleId;
    return listDocuments(this.store, listInput);
  }

  async readDocument(input: unknown): Promise<DocumentReadResult> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const readInput: {
      session_id: string;
      document_key: string;
      target_role_id?: string;
      revision?: number;
    } = {
      session_id: requiredString(record, "session_id"),
      document_key: requiredString(record, "document_key"),
    };
    const targetRole = optionalString(record, "target_role_id");
    if (targetRole !== undefined) readInput.target_role_id = targetRole;
    if (record.revision !== undefined) {
      if (typeof record.revision !== "number" || !Number.isInteger(record.revision)) {
        throw new RoleDockError("VALIDATION_FAILED", 'Input field "revision" must be an integer.');
      }
      readInput.revision = record.revision;
    }
    return readDocument(this.store, readInput);
  }

  async proposeDocumentUpdate(input: unknown): Promise<CandidateProposalResult> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const proposeInput: {
      session_id: string;
      target_role_id: string;
      document_key: string;
      body: string;
      note?: string;
    } = {
      session_id: requiredString(record, "session_id"),
      target_role_id: requiredString(record, "target_role_id"),
      document_key: requiredString(record, "document_key"),
      body: requiredString(record, "body"),
    };
    const note = optionalString(record, "note");
    if (note !== undefined) proposeInput.note = note;
    return proposeDocumentUpdate(this.store, proposeInput);
  }

  async publishDocument(input: unknown): Promise<DocumentPublishResult> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const publishInput: {
      session_id: string;
      document_key: string;
      body: string;
      expected_revision: number;
      expected_generation: number;
      candidate_id?: string;
    } = {
      session_id: requiredString(record, "session_id"),
      document_key: requiredString(record, "document_key"),
      body: requiredString(record, "body"),
      expected_revision: requireInteger(record, "expected_revision"),
      expected_generation: requireInteger(record, "expected_generation"),
    };
    const candidateId = optionalString(record, "candidate_id");
    if (candidateId !== undefined) publishInput.candidate_id = candidateId;
    return publishDocument(this.store, publishInput);
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

  // -- knowledge (implemented in P2, owner-level) ------------------------------
  async exportKnowledge(input: unknown): Promise<ExportResult> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const exportInput: { scope?: KnowledgeExportScope; role_id?: string } = {};
    const scope = optionalString(record, "scope");
    if (scope !== undefined) {
      if (scope !== "share" && scope !== "workspace") {
        throw new RoleDockError("VALIDATION_FAILED", 'Input field "scope" must be "share" or "workspace".');
      }
      exportInput.scope = scope;
    }
    const roleId = optionalString(record, "role_id");
    if (roleId !== undefined) exportInput.role_id = roleId;
    return exportKnowledge(this.store, exportInput);
  }

  async importKnowledge(input: unknown): Promise<ImportResult> {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    return importKnowledge(this.store, { bundle_dir: requiredString(record, "bundle_dir") });
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

/**
 * Operations implemented so far; everything else rejects with
 * NOT_IMPLEMENTED. The testing entry (P2) is deliberately absent: it is not
 * part of the SDK operation surface.
 */
export const IMPLEMENTED_OPERATIONS: readonly string[] = [
  "installRolePack",
  "listRoles",
  "resolveRole",
  "listDocuments",
  "readDocument",
  "proposeDocumentUpdate",
  "publishDocument",
  "exportKnowledge",
  "importKnowledge",
].sort();

/** P1 additions, kept for tests that split delivery phases. */
export const P1_IMPLEMENTED_OPERATIONS: readonly string[] = [
  "installRolePack",
  "listRoles",
  "resolveRole",
].sort();
