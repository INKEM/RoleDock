import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RoleDockError } from "@roledock/protocol";
import type {
  Checkpoint,
  CheckpointSource,
  CheckpointTodo,
  DocumentVisibility,
  OwnerCandidateEntry,
  OwnerCandidatesPage,
  OwnerCheckpointDetail,
  OwnerArtifactRead,
  OwnerCancelResult,
  OwnerCheckpointListPage,
  OwnerCheckpointSummary,
  OwnerCleanupEntry,
  OwnerCleanupPage,
  OwnerRequestDetail,
  OwnerRequestInboxPage,
  OwnerRequestSummary,
  OwnerDocumentListPage,
  OwnerDocumentRead,
  OwnerDocumentRevisionEntry,
  OwnerDocumentRevisionsPage,
  PolicyListPage,
  RoleDefinition,
  RoleDetails,
  UserDecisionRef,
} from "@roledock/protocol";
import { checkWorkspaceId } from "./roles/install.js";
import { getHead, getPack, getRoleRow, listRoleRows } from "./store/queries.js";
import { WorkspaceStore } from "./store/workspace.js";
import type { HandleOptions } from "./options.js";
import { assertCapabilityName } from "./policy.js";
import { optionalString, requiredString, asRecord } from "./parse.js";
import type { Coordinator } from "./coordinator.js";
import { coordinatorStore } from "./internal-store.js";
import { bodyHash, readObject } from "./store/objects.js";
import { cancelByOwner } from "./requests/service.js";

/** Raw requests table fields the G6 owner projections read. */
interface RequestRowLite {
  request_id: string; initiating_session_id: string; initiating_instance_id: string; initiating_role_id: string;
  target_role_id: string; state: string; execution_uncertain: number; cleanup_pending: number; execution_phase: string;
  output_bytes_used: number; turns_reserved: number; binding_generation: number; binding_knowledge_revision: number;
  budget_json: string; result_artifact_id: string | null; result_content_hash: string | null;
  error_json: string | null; idempotency_key: string;
  created_at: string; updated_at: string; terminal_at: string | null; question: string;
}

/** Raw checkpoints table row (G5 owner read models). */
interface CheckpointRow {
  checkpoint_id: string; role_id: string; generation: number; knowledge_revision: number;
  document_snapshots_json: string; handoff_summary_json: string; user_decision_refs_json: string | null;
  todos_json: string; sources_json: string; created_by_instance_id: string; created_at: string;
}

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

  // -- G5 owner knowledge read models (desktop-gui-contract §2.3) ------------
  // Projection only: reading never advances or rewrites anything. Document
  // and revision lists are metadata; bodies ride along ONLY per the §3.2
  // visibility matrix (public/project full text; private/role metadata +
  // content_hash). Candidate bodies are always included — candidates are
  // explicitly submitted for review.

  /** Shared offset pagination for the owner knowledge lists (policy.list precedent). */
  #pageOffset(record: Record<string, unknown>): { limit: number; offset: number } {
    const limit = record.limit ?? 50;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
      throw new RoleDockError("VALIDATION_FAILED", "limit must be an integer between 1 and 200.");
    }
    let offset = 0;
    if (record.cursor !== undefined && record.cursor !== null) {
      if (typeof record.cursor !== "string") throw new RoleDockError("VALIDATION_FAILED", "cursor must be a string.");
      const decoded = Number(Buffer.from(record.cursor, "base64").toString("utf8"));
      if (!Number.isInteger(decoded) || decoded < 0) throw new RoleDockError("VALIDATION_FAILED", "cursor is not a valid page offset.");
      offset = decoded;
    }
    return { limit: limit as number, offset };
  }

  #cursorAt(offset: number, count: number, total: number): string | null {
    return offset + count < total ? Buffer.from(String(offset + count)).toString("base64") : null;
  }

  #declaredVisibility(roleId: string, documentKey: string): DocumentVisibility {
    const row = getRoleRow(this.store, roleId);
    if (row === undefined) throw new RoleDockError("NOT_FOUND", `Role "${roleId}" is not installed in this workspace.`);
    const definition = JSON.parse(row.definition_json) as RoleDefinition;
    return definition.documents?.find(entry => entry.key === documentKey)?.visibility ?? "project";
  }

  /** Owner read: the knowledge directory — declared documents per role with
   * their published latest revision metadata (no bodies). */
  documentList(input: unknown = {}): OwnerDocumentListPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const { limit, offset } = this.#pageOffset(record);
    const roleId = optionalString(record, "role_id");
    const roleIds = roleId !== undefined ? [roleId] : listRoleRows(this.store).map(row => row.role_id).sort();
    const entries: OwnerDocumentListPage["items"] = [];
    for (const id of roleIds) {
      const registry = new Map(
        (this.store.prepare("SELECT document_key, latest_revision FROM documents WHERE role_id = ?").all(id) as Array<{ document_key: string; latest_revision: number }>)
          .map(row => [row.document_key, row.latest_revision]),
      );
      let keys: string[];
      try {
        const role = getRoleRow(this.store, id);
        const declared = role === undefined ? [] : (JSON.parse(role.definition_json) as RoleDefinition).documents ?? [];
        keys = [...new Set([...declared.map(document => document.key), ...registry.keys()])].sort();
      } catch {
        keys = [...registry.keys()].sort();
      }
      for (const key of keys) {
        const latest = registry.get(key) ?? 0;
        if (latest <= 0) {
          entries.push({ role_id: id, document_key: key, latest_revision: 0, visibility: this.#declaredVisibility(id, key), updated_at: null, content_hash: null });
          continue;
        }
        const revision = this.store.prepare("SELECT content_hash, visibility, created_at FROM document_revisions WHERE role_id = ? AND document_key = ? AND revision = ?")
          .get(id, key, latest) as { content_hash: string; visibility: DocumentVisibility; created_at: string } | undefined;
        if (revision === undefined) throw new RoleDockError("INTERNAL", "Document registry points at a missing revision.");
        entries.push({ role_id: id, document_key: key, latest_revision: latest, visibility: revision.visibility, updated_at: revision.created_at, content_hash: revision.content_hash });
      }
    }
    entries.sort((a, b) => a.role_id.localeCompare(b.role_id) || a.document_key.localeCompare(b.document_key));
    const page = entries.slice(offset, offset + limit);
    return { workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), items: page, next_cursor: this.#cursorAt(offset, page.length, entries.length) };
  }

  /** Owner read: one document revision per the §3.2 matrix. private/role
   * bodies stay at the metadata layer with body_included:false. */
  documentRead(input: unknown): OwnerDocumentRead {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const roleId = requiredString(record, "role_id");
    const documentKey = requiredString(record, "document_key");
    const registry = this.store.prepare("SELECT latest_revision FROM documents WHERE role_id = ? AND document_key = ?").get(roleId, documentKey) as { latest_revision: number } | undefined;
    if (registry === undefined || registry.latest_revision <= 0) {
      throw new RoleDockError("NOT_FOUND", `No published document "${documentKey}" for role "${roleId}".`);
    }
    const requested = record.revision;
    if (requested !== undefined && requested !== null && !Number.isInteger(requested)) {
      throw new RoleDockError("VALIDATION_FAILED", "revision must be an integer.");
    }
    const revision: number = requested === undefined || requested === null ? registry.latest_revision : requested as number;
    if (!Number.isInteger(revision) || revision < 1 || revision > registry.latest_revision) {
      throw new RoleDockError("NOT_FOUND", `Revision ${String(revision)} of "${documentKey}" does not exist (latest: ${registry.latest_revision}).`);
    }
    const row = this.store.prepare("SELECT content_hash, visibility, created_at, created_by_instance_id FROM document_revisions WHERE role_id = ? AND document_key = ? AND revision = ?")
      .get(roleId, documentKey, revision) as { content_hash: string; visibility: DocumentVisibility; created_at: string; created_by_instance_id: string | null } | undefined;
    if (row === undefined) throw new RoleDockError("INTERNAL", "Revision row missing for a published revision.");
    const bodyIncluded = row.visibility === "public" || row.visibility === "project";
    let body: string | null = null;
    if (bodyIncluded) {
      body = readObject(this.store, row.content_hash);
      if (bodyHash(body) !== row.content_hash) throw new RoleDockError("INTERNAL", "Stored document body does not match its content hash; the content store is corrupt.");
    }
    return {
      workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), role_id: roleId, document_key: documentKey,
      revision, visibility: row.visibility, content_hash: row.content_hash, created_at: row.created_at,
      created_by_instance_id: row.created_by_instance_id, body_included: bodyIncluded, body,
    };
  }

  /** Owner read: immutable revision history (metadata only) for one document. */
  documentRevisions(input: unknown): OwnerDocumentRevisionsPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const roleId = requiredString(record, "role_id");
    const documentKey = requiredString(record, "document_key");
    const { limit, offset } = this.#pageOffset(record);
    const rows = this.store.prepare("SELECT revision, content_hash, visibility, created_by_instance_id, created_at FROM document_revisions WHERE role_id = ? AND document_key = ? ORDER BY revision")
      .all(roleId, documentKey) as unknown as OwnerDocumentRevisionEntry[];
    const page = rows.slice(offset, offset + limit);
    return {
      workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), role_id: roleId, document_key: documentKey,
      items: page, next_cursor: this.#cursorAt(offset, page.length, rows.length),
    };
  }

  /** Owner read: candidate updates with their full proposed bodies. The
   * BASELINE body never rides along (§3.2); a stale baseline is surfaced as
   * baseline_conflicted for display, never auto-merged. */
  candidateList(input: unknown = {}): OwnerCandidatesPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const { limit, offset } = this.#pageOffset(record);
    const roleId = optionalString(record, "role_id");
    const source = optionalString(record, "source");
    let rows = this.store.prepare("SELECT candidate_id, target_role_id, document_key, baseline_revision, proposed_body_hash, note, proposed_by_role_id, source, state, created_at, resolved_at FROM candidate_updates ORDER BY created_at, candidate_id")
      .all() as Array<{
      candidate_id: string; target_role_id: string; document_key: string; baseline_revision: number; proposed_body_hash: string;
      note: string | null; proposed_by_role_id: string; source: OwnerCandidateEntry["source"]; state: OwnerCandidateEntry["state"];
      created_at: string; resolved_at: string | null;
    }>;
    if (roleId !== undefined) rows = rows.filter(row => row.target_role_id === roleId);
    if (source !== undefined) rows = rows.filter(row => row.source === source);
    const page = rows.slice(offset, offset + limit).map(row => {
      const body = readObject(this.store, row.proposed_body_hash);
      if (bodyHash(body) !== row.proposed_body_hash) throw new RoleDockError("INTERNAL", "Stored candidate body does not match its content hash; the content store is corrupt.");
      const registry = this.store.prepare("SELECT latest_revision FROM documents WHERE role_id = ? AND document_key = ?").get(row.target_role_id, row.document_key) as { latest_revision: number } | undefined;
      const latest = registry?.latest_revision ?? 0;
      return { ...row, latest_revision: latest, baseline_conflicted: row.baseline_revision < latest, body_included: true, body };
    });
    return { workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), items: page, next_cursor: this.#cursorAt(offset, page.length, rows.length) };
  }

  #checkpointRow(row: CheckpointRow): Checkpoint {
    const parsed = JSON.parse(row.handoff_summary_json) as Checkpoint["handoff_summary"];
    return {
      checkpoint_id: row.checkpoint_id, workspace_id: this.store.workspaceId, role_id: row.role_id,
      generation: row.generation, knowledge_revision: row.knowledge_revision,
      document_snapshots: JSON.parse(row.document_snapshots_json) as Checkpoint["document_snapshots"],
      handoff_summary: parsed, user_decision_refs: row.user_decision_refs_json ? JSON.parse(row.user_decision_refs_json) as UserDecisionRef[] : [],
      todos: JSON.parse(row.todos_json) as CheckpointTodo[], sources: JSON.parse(row.sources_json) as CheckpointSource[],
      created_by_instance_id: row.created_by_instance_id, created_at: row.created_at,
    };
  }

  /** Owner read: checkpoint summaries — handoff summary METADATA and the
   * todo overview; the full handoff body lives behind checkpoints.get. */
  checkpointList(input: unknown = {}): OwnerCheckpointListPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const { limit, offset } = this.#pageOffset(record);
    const roleId = optionalString(record, "role_id");
    let rows = this.store.prepare("SELECT * FROM checkpoints ORDER BY created_at DESC, checkpoint_id").all() as unknown as CheckpointRow[];
    if (roleId !== undefined) rows = rows.filter(row => row.role_id === roleId);
    const page = rows.slice(offset, offset + limit).map(row => {
      const checkpoint = this.#checkpointRow(row);
      const summary: OwnerCheckpointSummary = {
        checkpoint_id: checkpoint.checkpoint_id, role_id: checkpoint.role_id, generation: checkpoint.generation,
        knowledge_revision: checkpoint.knowledge_revision, document_snapshots: checkpoint.document_snapshots,
        handoff_summary: { format: checkpoint.handoff_summary.format, content_hash: checkpoint.handoff_summary.content_hash },
        todos_total: checkpoint.todos.length, todos_done: checkpoint.todos.filter(todo => todo.done).length,
        todos_open: checkpoint.todos.filter(todo => !todo.done).map(todo => ({ description: todo.description })),
        created_by_instance_id: checkpoint.created_by_instance_id, created_at: checkpoint.created_at,
      };
      return summary;
    });
    return { workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), items: page, next_cursor: this.#cursorAt(offset, page.length, rows.length) };
  }

  /** Owner read: one checkpoint in full — the handoff summary body is an
   * explicitly written handoff product (§3.2 full text for the owner). */
  checkpointGet(input: unknown): OwnerCheckpointDetail {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const checkpointId = requiredString(record, "checkpoint_id");
    const row = this.store.prepare("SELECT * FROM checkpoints WHERE checkpoint_id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (row === undefined) throw new RoleDockError("NOT_FOUND", `Checkpoint "${checkpointId}" does not exist in this workspace.`);
    const checkpoint = this.#checkpointRow(row);
    if (bodyHash(checkpoint.handoff_summary.body) !== checkpoint.handoff_summary.content_hash) {
      throw new RoleDockError("INTERNAL", "Stored handoff summary does not match its content hash; the content store is corrupt.");
    }
    return {
      workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), checkpoint_id: checkpoint.checkpoint_id,
      role_id: checkpoint.role_id, generation: checkpoint.generation, knowledge_revision: checkpoint.knowledge_revision,
      document_snapshots: checkpoint.document_snapshots, handoff_summary: checkpoint.handoff_summary,
      user_decision_refs: checkpoint.user_decision_refs ?? [], todos: checkpoint.todos, sources: checkpoint.sources,
      created_by_instance_id: checkpoint.created_by_instance_id, created_at: checkpoint.created_at,
    };
  }

  // -- G6 owner request read models + management cancellation ----------------
  // Projection only for reads; cancelByOwner is the §6-matrix owner write
  // with an independent principal and audit trail (never the initiating
  // session identity). Reported usage is null until the host actually
  // started executing — unknown is never rendered as 0.

  static #requestUsage(row: { state: string; execution_phase: string; output_bytes_used: number; turns_reserved: number }): OwnerRequestSummary["usage"] {
    const started = !["accepted", "queued"].includes(row.state) || row.execution_phase !== "pending";
    return started ? { output_bytes: row.output_bytes_used, turns_reserved: row.turns_reserved } : { output_bytes: null, turns_reserved: null };
  }

  #requestRow(requestId: string): RequestRowLite | undefined {
    return this.store.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId) as RequestRowLite | undefined;
  }

  #requestSummary(row: RequestRowLite): OwnerRequestSummary {
    return {
      request_id: row.request_id,
      initiating: { session_id: row.initiating_session_id, instance_id: row.initiating_instance_id, role_id: row.initiating_role_id },
      target_role_id: row.target_role_id,
      state: row.state as OwnerRequestSummary["state"],
      execution_uncertain: row.execution_uncertain === 1,
      cleanup_pending: row.cleanup_pending === 1,
      binding: { target_generation: row.binding_generation, knowledge_revision: row.binding_knowledge_revision },
      budget: JSON.parse(row.budget_json) as OwnerRequestSummary["budget"],
      usage: WorkspaceAdmin.#requestUsage(row),
      result: row.result_artifact_id ? { artifact_id: row.result_artifact_id, content_hash: row.result_content_hash ?? "" } : null,
      created_at: row.created_at, updated_at: row.updated_at, terminal_at: row.terminal_at,
      question_preview: row.question.length > 160 ? `${row.question.slice(0, 160)}…` : row.question,
    };
  }

  /** Owner read: paged request view (state/role filters). */
  requestInbox(input: unknown = {}): OwnerRequestInboxPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const { limit, offset } = this.#pageOffset(record);
    const state = optionalString(record, "state");
    const targetRole = optionalString(record, "target_role_id");
    const createdSince = optionalString(record, "created_since");
    const createdUntil = optionalString(record, "created_until");
    for (const [name, value] of [["created_since", createdSince], ["created_until", createdUntil]] as const) {
      if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new RoleDockError("VALIDATION_FAILED", `${name} must be an ISO date-time.`);
    }
    let rows = this.store.prepare("SELECT * FROM requests ORDER BY created_at, request_id").all() as unknown as RequestRowLite[];
    if (state !== undefined) rows = rows.filter(row => row.state === state);
    if (targetRole !== undefined) rows = rows.filter(row => row.target_role_id === targetRole);
    if (createdSince !== undefined) rows = rows.filter(row => row.created_at >= createdSince);
    if (createdUntil !== undefined) rows = rows.filter(row => row.created_at <= createdUntil);
    const page = rows.slice(offset, offset + limit).map(row => this.#requestSummary(row));
    return { workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), items: page, next_cursor: this.#cursorAt(offset, page.length, rows.length) };
  }

  /** Owner read: one request in full (question includes appended clarifications). */
  requestGet(input: unknown): OwnerRequestDetail {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const requestId = requiredString(record, "request_id");
    const row = this.#requestRow(requestId);
    if (row === undefined) throw new RoleDockError("NOT_FOUND", `Request "${requestId}" does not exist.`);
    const summary = this.#requestSummary(row);
    return {
      workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(),
      request_id: row.request_id, idempotency_key: row.idempotency_key,
      initiating: summary.initiating, target_role_id: row.target_role_id, state: summary.state,
      execution_uncertain: summary.execution_uncertain, cleanup_pending: summary.cleanup_pending,
      binding: summary.binding, budget: summary.budget, usage: summary.usage, question: row.question,
      result: summary.result,
      error: row.error_json ? JSON.parse(row.error_json) as { code: string; message: string } : null,
      created_at: row.created_at, updated_at: row.updated_at, terminal_at: row.terminal_at,
    };
  }

  /** Owner read: one artifact's raw bytes. Reading grants no write/publish right. */
  artifactRead(input: unknown): OwnerArtifactRead {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const artifactId = requiredString(record, "artifact_id");
    const artifact = this.store.prepare("SELECT * FROM request_artifacts WHERE artifact_id = ?").get(artifactId) as
      | { artifact_id: string; request_id: string; producing_role_id: string; content_hash: string; created_at: string }
      | undefined;
    if (artifact === undefined) throw new RoleDockError("NOT_FOUND", `Artifact "${artifactId}" does not exist.`);
    const body = readObject(this.store, artifact.content_hash);
    if (bodyHash(body) !== artifact.content_hash) throw new RoleDockError("INTERNAL", "Artifact body does not match its content hash.");
    return {
      workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(),
      artifact_id: artifact.artifact_id, request_id: artifact.request_id,
      producing_role_id: artifact.producing_role_id, content_hash: artifact.content_hash, body, created_at: artifact.created_at,
    };
  }

  /** Owner read: reclamation view — cleanup failures are distinguishable from
   * completion and never change the terminal state. */
  cleanupList(input: unknown = {}): OwnerCleanupPage {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const { limit, offset } = this.#pageOffset(record);
    const pendingOnly = record.pending_only === true;
    let rows = this.store.prepare("SELECT request_id, state, cleanup_pending, cleanup_error_json, terminal_at FROM requests WHERE state IN ('completed','failed','cancelled','expired') ORDER BY terminal_at, request_id")
      .all() as Array<{ request_id: string; state: OwnerCleanupEntry["state"]; cleanup_pending: number; cleanup_error_json: string | null; terminal_at: string | null }>;
    if (pendingOnly) rows = rows.filter(row => row.cleanup_pending === 1);
    const page = rows.slice(offset, offset + limit).map(row => ({
      request_id: row.request_id, state: row.state, cleanup_pending: row.cleanup_pending === 1,
      cleanup_error: row.cleanup_error_json ? JSON.parse(row.cleanup_error_json) as { code: string; message: string } : null,
      terminal_at: row.terminal_at,
    }));
    return { workspace_id: this.store.workspaceId, observed_at: new Date().toISOString(), items: page, next_cursor: this.#cursorAt(offset, page.length, rows.length) };
  }

  /** Owner management cancellation (§6 matrix, independent principal, audit
   * event written by the core). adapterCancelDeclared comes from the
   * service's adapter capabilities — the owner cannot bypass that boundary. */
  cancelRequestByOwner(input: unknown, adapterCancelDeclared: boolean): OwnerCancelResult {
    const record = asRecord(input);
    checkWorkspaceId(this.store, optionalString(record, "workspace_id"));
    const requestId = requiredString(record, "request_id");
    const reason = requiredString(record, "reason");
    const idempotencyKey = optionalString(record, "idempotency_key");
    const outcome = cancelByOwner(this.store, adapterCancelDeclared, { request_id: requestId, reason, ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}) });
    return { request_id: outcome.request_id, state: outcome.state, idempotent_replay: outcome.idempotent_replay, observed_at: new Date().toISOString() };
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
