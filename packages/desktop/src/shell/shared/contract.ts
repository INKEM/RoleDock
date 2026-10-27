/**
 * Shell named-IPC contract (desktop-gui-contract §4): the preload exposes
 * exactly the methods below — closed vocabulary, no generic
 * `rpc(operation, input)` channel, no credentials across the bridge.
 * Every handler validates the sender frame and redacts its reply.
 */

export type IpcReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export interface WorkspaceStatus {
  foregroundDir: string | null;
  workspaceId: string | null;
  /** closed | preparing | starting | running | stopping | disconnected | error | conflict */
  state: string;
  /** true → the shell spawned the service and reaps it on exit; false → attached external service */
  owned: boolean;
  /** mock（诊断）或 zcode（真实配置接入） */
  mode: "mock" | "zcode" | null;
  pid: number | null;
  socketPath: string | null;
  lastRefreshAt: string | null;
  error: string | null;
  detail: string | null;
}

export interface ConfirmSessionView { session: { external_session_id: string; host_session_id: string; connection_subject: string; created_at: string }; active_authorization: { authorization_id: string; role_id: string; expires_at: string; source: { kind: string; event_ref: string } } | null }
export interface ConfirmRoleView { role_id: string; title: string; initialized: boolean; requested_capabilities: string[]; generation?: number; granted_capabilities?: string[] }

/** G3 discovery candidate (desktop-gui-contract §9.1) — host metadata only. */
export interface DiscoverCandidateView { host_session_id: string; title: string | null; status: string | null; kind: string | null; updated_at: string | null; registered_external_session_id: string | null }
export interface DiscoverReplyView { adapter: string; items: DiscoverCandidateView[]; error: string | null }
/** G3 confirmation progress chain (owner projection; protocol-typed). */
export type { AuthorizationConfirmationsPage, ConfirmationChainEntry } from "@roledock/protocol";
/** G4 session observability (owner projections; protocol-typed). */
export type { SessionBindingsPage, AnchorAttemptsPage, AnchorLoadsPage, RevokePreview } from "@roledock/protocol";
/** G5 role knowledge (owner projections; protocol-typed). */
export type { OwnerDocumentListPage, OwnerDocumentRead, OwnerDocumentRevisionsPage, OwnerCandidatesPage, OwnerCheckpointListPage, OwnerCheckpointDetail } from "@roledock/protocol";

export interface ShellSettings { defaultWorkspaceDir: string | null; exitStopsOwnedServices: boolean }

export const SHELL_NAMESPACES = {
  workspace: ["pickDirectory", "open", "status", "refresh", "stop", "restart", "diagnostics", "openWindow", "preflight", "testConnection", "removeRecent"] as const,
  confirm: ["listSessions", "listRoles", "submit", "registerSession", "discoverSessions", "confirmations", "bridgeStatus"] as const,
  // G4 (desktop-gui-contract §2.3): owner read views over bindings/attempts/
  // loads plus the revoke surface. The preview and revoke take exactly one
  // authorization_id; release stays with the original session — there is no
  // owner release method here by contract (§5.2).
  sessions: ["listBindings", "listAttempts", "listLoads"] as const,
  authorizations: ["revokePreview", "revoke"] as const,
  // G5 (desktop-gui-contract §2.3): owner knowledge views. Reads take
  // explicit role/document keys; export/import resolve files through native
  // dialogs in the trusted main process — the renderer never touches paths.
  knowledge: ["listDocuments", "readDocument", "listRevisions", "listCandidates", "listCheckpoints", "getCheckpoint", "export", "import"] as const,
  roles: ["install", "list", "get", "grant", "revoke"] as const,
  settings: ["get", "set"] as const,
  app: ["quit", "version"] as const,
};

export type ShellNamespace = keyof typeof SHELL_NAMESPACES;

export function channelFor(namespace: ShellNamespace, method: string): string {
  return `roledock:${namespace}:${method}`;
}

export type ShellInvoke = (namespace: ShellNamespace, method: string, payload: unknown) => Promise<unknown>;

/** Closed-vocabulary bridge: namespaces with fixed methods, nothing else. */
export function createShellApi(invoke: ShellInvoke): Record<ShellNamespace, Record<string, (payload?: unknown) => Promise<unknown>>> {
  const api = {} as Record<ShellNamespace, Record<string, (payload?: unknown) => Promise<unknown>>>;
  for (const [namespace, methods] of Object.entries(SHELL_NAMESPACES) as Array<[ShellNamespace, readonly string[]]>) {
    api[namespace] = {};
    for (const method of methods) {
      api[namespace][method] = (payload?: unknown) => invoke(namespace, method, payload);
    }
  }
  return api;
}
