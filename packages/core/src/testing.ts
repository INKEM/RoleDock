/**
 * Test-only entry point for RoleDock core.
 *
 * P2 has no production session creation (sessions.open lands in P3). This
 * module exists so tests can establish primary instances and role-bound
 * sessions. It is deliberately NOT reachable from the Coordinator or CLI
 * surfaces (tests assert both), and the generation-bump shortcut it offers
 * is fixture-only: the production handoff flow in P3 replaces it.
 */
import type { Coordinator } from "./coordinator.js";
import { checkWorkspaceId } from "./roles/install.js";
import { coordinatorStore } from "./internal-store.js";
import { asRecord, optionalString, requiredString } from "./parse.js";
import { openPrimarySession } from "./sessions/internal.js";

export interface TestingPrimarySession {
  session_id: string;
  instance_id: string;
  role_id: string;
  generation: number;
}

/**
 * Open a primary session for a role. On an uninitialized role this
 * initializes the first primary instance (generation 1); on an initialized
 * role it performs a fixture-only generation bump (retiring the current
 * instance) so tests can construct stale-generation scenarios. Production
 * session opening in P3 goes through handoff validation instead.
 */
export function testingOpenPrimarySession(coordinator: Coordinator, input: unknown): TestingPrimarySession {
  const store = coordinatorStore(coordinator);
  const record = asRecord(input);
  checkWorkspaceId(store, optionalString(record, "workspace_id"));
  return openPrimarySession(store, {
    role_id: requiredString(record, "role_id"),
    workspace_id: optionalString(record, "workspace_id"),
  });
}

// Low-level fixtures and owner state inspection are never session tools.
export { WorkspaceStore } from "./store/workspace.js";
export { MIGRATIONS, runMigrations } from "./store/migrations.js";
export { bodyHash, putObject, readObject, objectPath } from "./store/objects.js";
export { installRolePack, checkWorkspaceId } from "./roles/install.js";
export {
  listDocuments,
  readDocument,
  proposeDocumentUpdate,
  publishDocument,
  listCandidates,
  canRead,
} from "./documents/service.js";
export { buildCheckpoint, getLatestCheckpoint } from "./documents/checkpoint.js";
export { exportKnowledge, importKnowledge } from "./knowledge/transfer.js";
export {
  resolveSessionIdentity,
  openPrimarySession,
  recordReadReceipt,
  listReceiptsForSession,
} from "./sessions/internal.js";
export {
  createRequest,
  getRequest,
  replyToRequest,
  cancelRequest,
  readArtifact,
  listInboxEntries,
  listRequests,
  expireIfOverdue,
} from "./requests/service.js";
export { executeRequest, rejectLateCompletion } from "./requests/executor.js";
export { prepareHandoff, provisionHandoff, activateHandoff } from "./sessions/handoff.js";
