import { BrowserWindow } from "electron";
import { cp } from "node:fs/promises";
import { WorkspaceSupervisor } from "../supervisor.js";
import type { WorkspaceHandle } from "../supervisor.js";
import type { WorkspaceStatus } from "../shared/contract.js";
import { confirmInput } from "../../gmin/confirm.js";
import type { ConfirmRoleView, ConfirmSessionView } from "../shared/contract.js";
import { loadSettingsFile, saveSettingsFile, touchRecent } from "../shared/settings.js";
import type { ShellSettings } from "../shared/settings.js";
import { writeLauncherConfigFile } from "../shared/launcher.js";
import { writeMcpSessionEnvFile } from "../shared/credential-file.js";
import { EventProgressBridge } from "./event-bridge.js";
import type { BridgeStatus } from "./event-bridge.js";
import { connectZCodeConnector } from "@roledock/adapter-zcode";
import type { ServiceClient } from "@roledock/service";
import type { AuthorizationConfirmationsPage, SessionBindingsPage, AnchorAttemptsPage, AnchorLoadsPage, RevokePreview, OwnerDocumentListPage, OwnerDocumentRead, OwnerDocumentRevisionsPage, OwnerCandidatesPage, OwnerCheckpointListPage, OwnerCheckpointDetail, OwnerRequestInboxPage, OwnerRequestDetail, OwnerArtifactRead, OwnerCleanupPage, OwnerCancelResult } from "@roledock/protocol";

export interface RolesInstallResult { roles: Array<{ id: string; title: string; initialized: boolean }>; reinstalled: boolean }

/**
 * Foreground-workspace orchestration (DESKTOP_GUI_PLAN §4.3/§10): one
 * foreground workspace at a time; background owned services keep running and
 * are reaped on exit according to settings. Owner RPC for the confirm page,
 * role library and diagnostics flows through this controller — the renderer
 * never sees the credential, the helper output or any bearer.
 */
export class WorkspaceController {
  readonly #supervisor: WorkspaceSupervisor;
  readonly #settingsFile: string;
  readonly #nodePath: string;
  readonly #connectorPath: string;
  readonly #bridge: EventProgressBridge;
  #foreground: string | null = null;

  constructor(options: { supervisor: WorkspaceSupervisor; settingsFile: string; nodePath: string; connectorPath: string }) {
    this.#supervisor = options.supervisor;
    this.#settingsFile = options.settingsFile;
    this.#nodePath = options.nodePath;
    this.#connectorPath = options.connectorPath;
    // G3 (ADR-0014 §9.3): the trusted event-progress bridge lives in this
    // main process; the session bearer it registers goes straight into the
    // workspace's 0600 MCP credential file, never to the renderer.
    this.#bridge = new EventProgressBridge({
      ownerClient: () => this.#ownerClient(),
      writeSessionCredential: writeMcpSessionEnvFile,
    });
  }

  get foregroundDir(): string | null {
    return this.#foreground;
  }

  status(): WorkspaceStatus {
    const handle = this.#foreground ? this.#supervisor.get(this.#foreground) : undefined;
    return this.#view(handle);
  }

  async open(dir: string, launcherKind?: "mock" | "zcode"): Promise<WorkspaceStatus> {
    this.#foreground = dir;
    let launcher: { configPath: string } | undefined;
    if (launcherKind === "zcode") {
      const settings = this.#settings();
      if (settings.launcher.kind !== "zcode" || !settings.launcher.cliPath) {
        throw new Error("真实接入需要先在设置中配置 ZCode CLI 路径。");
      }
      const egress = settings.launcher.managedEgress;
      launcher = {
        configPath: writeLauncherConfigFile(dir, {
          kind: "zcode",
          cliPath: settings.launcher.cliPath,
          connectorPath: this.#connectorPath,
          ...(settings.launcher.credentialHelper ? { credentialHelper: settings.launcher.credentialHelper } : {}),
          ...(settings.launcher.provider ? { provider: settings.launcher.provider } : {}),
          ...(settings.launcher.model ? { model: settings.launcher.model } : {}),
          ...(egress.length ? { managed: { egress } } : {}),
        }),
      };
    }
    const handle = await this.#supervisor.open(dir, launcher);
    saveSettingsFile(this.#settingsFile, { recentWorkspaces: touchRecent(this.#settings(), dir).recentWorkspaces });
    // G3: polling starts only while a workspace is actually foregrounded.
    this.#bridge.start(dir);
    return this.#view(handle);
  }

  async stop(): Promise<WorkspaceStatus> {
    this.#bridge.stop();
    if (!this.#foreground) return this.status();
    const handle = await this.#supervisor.stop(this.#foreground);
    if (handle.state === "running" && !handle.owned && !handle.socketPath) {
      this.#foreground = null;
      return this.#view(undefined);
    }
    return this.#view(handle);
  }

  async restart(): Promise<WorkspaceStatus> {
    if (!this.#foreground) return this.status();
    const dir = this.#foreground;
    this.#bridge.stop();
    const handle = await this.#supervisor.restart(dir);
    this.#bridge.start(dir);
    return this.#view(handle);
  }

  async refresh(): Promise<WorkspaceStatus> {
    if (!this.#foreground) return this.status();
    return this.#view(await this.#supervisor.refresh(this.#foreground));
  }

  async diagnostics(): Promise<{ workspace_id: string; service: { version: string; pid: number; started_at: string; adapter: string; runtime: string }; events: Array<{ id: number; kind: string; state: string; created_at: string }>; bridge: BridgeStatus }> {
    const client = this.#ownerClient();
    const info = await client.call<{ workspace_id: string; service: { version: string; pid: number; started_at: string; adapter: string; runtime: string } }>("workspace.info", {}, { timeoutMs: 5000 });
    const events = await client.call<{ events: Array<{ id: number; kind: string; state: string; created_at: string }> }>("admin.events", {}, { timeoutMs: 5000 });
    return { workspace_id: info.workspace_id, service: info.service, events: events.events, bridge: this.#bridge.status };
  }

  /** G2 connection test: connector handshake (tools/list) only — zero
   * sessions, zero model turns. Server/tool names are shown; helper output
   * and any bearer never cross to the renderer. */
  async testConnection(): Promise<{ server: { name: string; version: string } | null; toolCount: number }> {
    const settings = this.#settings();
    if (settings.launcher.kind !== "zcode" || !settings.launcher.cliPath) {
      throw new Error("连接测试需要先配置 ZCode CLI 路径。");
    }
    const egress = settings.launcher.managedEgress;
    const args = [this.#connectorPath, "--cli", settings.launcher.cliPath];
    if (settings.launcher.credentialHelper) args.push("--credential-helper", settings.launcher.credentialHelper);
    if (settings.launcher.provider) args.push("--provider", settings.launcher.provider);
    if (settings.launcher.model) args.push("--model", settings.launcher.model);
    if (egress.length) {
      args.push("--sandbox");
      for (const entry of egress) args.push("--sandbox-egress", entry);
    }
    const tools = await connectZCodeConnector({ command: this.#nodePath, args, cwd: process.cwd() });
    try {
      return { server: tools.server ?? null, toolCount: tools.tools?.size ?? 0 };
    } finally {
      await tools.disconnect().catch(() => undefined);
    }
  }

  async confirmSessions(): Promise<{ external_sessions: ConfirmSessionView[] }> {
    const reply = await this.#ownerClient().call<{ external_sessions?: ConfirmSessionView[] } | ConfirmSessionView[]>("externalSessions.list", {}, { timeoutMs: 5000 });
    return { external_sessions: Array.isArray(reply) ? reply : reply.external_sessions ?? [] };
  }

  async confirmRoles(): Promise<{ roles: ConfirmRoleView[] }> {
    return this.#ownerClient().call<{ roles: ConfirmRoleView[] }>("roles.list", {}, { timeoutMs: 5000 });
  }

  async confirmSubmit(body: Record<string, unknown>): Promise<{ event_ref: string; entry: string }> {
    const [sessions, roles] = await Promise.all([this.confirmSessions(), this.confirmRoles()]);
    const input = confirmInput(sessions.external_sessions, roles.roles, body);
    const record = await this.#ownerClient().call<{ event_ref: string }>("authorizations.submitHumanEvent", input, { timeoutMs: 5000 });
    return { event_ref: record.event_ref, entry: String(input.entry) };
  }

  /** G3 §9.1: discovery via the trusted bridge; falls back to paste-a-reference on failure.
   * Connector-level causes are surfaced (error message layer) so the user
   * sees why discovery is unavailable, per desktop-gui-contract §2.1. */
  async discoverSessions(): Promise<{ adapter: string; items: Array<{ host_session_id: string; title: string | null; status: string | null; kind: string | null; updated_at: string | null; registered_external_session_id: string | null }>; error: string | null }> {
    try {
      const reply = await this.#bridge.discoverHostSessions();
      return { adapter: reply.adapter, items: reply.items, error: null };
    } catch (error) {
      const detail = (error as { details?: { connector_error?: unknown } }).details?.connector_error;
      const base = error instanceof Error ? error.message : String(error);
      const message = detail ? `${base}（连接器：${String(detail).slice(0, 200)}）` : base;
      return { adapter: "unknown", items: [], error: message.slice(0, 300) };
    }
  }

  async registerSession(hostSessionId: string): Promise<{ external_session_id: string; envFile: string }> {
    if (!this.#foreground) throw new Error("尚未打开工作空间。");
    return this.#bridge.registerOriginalSession(this.#foreground, hostSessionId);
  }

  async confirmations(input: { cursor?: string; limit?: number; external_session_id?: string } = {}): Promise<AuthorizationConfirmationsPage> {
    return this.#ownerClient().call<AuthorizationConfirmationsPage>("authorizations.confirmations", input, { timeoutMs: 5000 });
  }

  /** G4 (desktop-gui-contract §2.3): paged owner read views over bindings,
   * anchor attempts and material loads. Pure proxies — input shape is
   * validated in the IPC handler and again at the service boundary. */
  listBindings(input: { cursor?: string; limit?: number; external_session_id?: string } = {}): Promise<SessionBindingsPage> {
    return this.#ownerClient().call<SessionBindingsPage>("sessions.listBindings", input, { timeoutMs: 5000 });
  }

  listAttempts(input: { cursor?: string; limit?: number; external_session_id?: string } = {}): Promise<AnchorAttemptsPage> {
    return this.#ownerClient().call<AnchorAttemptsPage>("sessions.listAttempts", input, { timeoutMs: 5000 });
  }

  listLoads(input: { cursor?: string; limit?: number; external_session_id?: string } = {}): Promise<AnchorLoadsPage> {
    return this.#ownerClient().call<AnchorLoadsPage>("sessions.listLoads", input, { timeoutMs: 5000 });
  }

  /** G4: read-only impact preview, then the explicit revoke. Two separate
   * calls — the GUI must show the preview before revoking; release is NOT
   * offered here (desktop-gui-contract §5.2: release stays with the
   * original session via sessions.release). */
  revokePreview(authorizationId: string): Promise<RevokePreview> {
    return this.#ownerClient().call<RevokePreview>("authorizations.revokePreview", { authorization_id: authorizationId }, { timeoutMs: 5000 });
  }

  revokeAuthorization(authorizationId: string): Promise<unknown> {
    return this.#ownerClient().call("authorizations.revoke", { authorization_id: authorizationId }, { timeoutMs: 10000 });
  }

  /** G5 (desktop-gui-contract §2.3): owner knowledge read views. Pure proxies
   * — input shape is validated in the IPC handler and again at the service
   * boundary. Bodies arrive per the §3.2 matrix (private/role stay
   * metadata+hash); the renderer never touches object paths. */
  knowledgeListDocuments(input: { cursor?: string; limit?: number; role_id?: string } = {}): Promise<OwnerDocumentListPage> {
    return this.#ownerClient().call<OwnerDocumentListPage>("documents.list", input, { timeoutMs: 5000 });
  }

  knowledgeReadDocument(input: { role_id: string; document_key: string; revision?: number }): Promise<OwnerDocumentRead> {
    return this.#ownerClient().call<OwnerDocumentRead>("documents.read", input, { timeoutMs: 5000 });
  }

  knowledgeListRevisions(input: { role_id: string; document_key: string; cursor?: string; limit?: number }): Promise<OwnerDocumentRevisionsPage> {
    return this.#ownerClient().call<OwnerDocumentRevisionsPage>("documents.listRevisions", input, { timeoutMs: 5000 });
  }

  knowledgeListCandidates(input: { cursor?: string; limit?: number; role_id?: string; source?: string } = {}): Promise<OwnerCandidatesPage> {
    return this.#ownerClient().call<OwnerCandidatesPage>("documents.listCandidates", input, { timeoutMs: 5000 });
  }

  knowledgeListCheckpoints(input: { cursor?: string; limit?: number; role_id?: string } = {}): Promise<OwnerCheckpointListPage> {
    return this.#ownerClient().call<OwnerCheckpointListPage>("checkpoints.list", input, { timeoutMs: 5000 });
  }

  knowledgeGetCheckpoint(input: { checkpoint_id: string }): Promise<OwnerCheckpointDetail> {
    return this.#ownerClient().call<OwnerCheckpointDetail>("checkpoints.get", input, { timeoutMs: 5000 });
  }

  /** G6 (desktop-gui-contract §2.3): owner request inbox views and the §6
   * management cancellation. Pure proxies; the adapter's cancel capability
   * boundary lives in the service. */
  inboxListRequests(input: { cursor?: string; limit?: number; state?: string; target_role_id?: string } = {}): Promise<OwnerRequestInboxPage> {
    return this.#ownerClient().call<OwnerRequestInboxPage>("requests.listInbox", input, { timeoutMs: 5000 });
  }

  inboxGetRequest(input: { request_id: string }): Promise<OwnerRequestDetail> {
    return this.#ownerClient().call<OwnerRequestDetail>("requests.get", input, { timeoutMs: 5000 });
  }

  inboxReadArtifact(input: { artifact_id: string }): Promise<OwnerArtifactRead> {
    return this.#ownerClient().call<OwnerArtifactRead>("artifacts.read", input, { timeoutMs: 5000 });
  }

  inboxListCleanup(input: { cursor?: string; limit?: number; pending_only?: boolean } = {}): Promise<OwnerCleanupPage> {
    return this.#ownerClient().call<OwnerCleanupPage>("requests.listCleanup", input, { timeoutMs: 5000 });
  }

  inboxCancelRequest(input: { request_id: string; reason: string; idempotency_key?: string }): Promise<OwnerCancelResult> {
    return this.#ownerClient().call<OwnerCancelResult>("requests.cancelByOwner", input, { timeoutMs: 10000 });
  }

  /** G5 knowledge export: `knowledge.export` writes the bundle under the
   * workspace first, then the main process copies it to the directory the
   * user picked in the native dialog. The renderer receives the summary and
   * the chosen directory label — never object paths to open. */
  async knowledgeExport(input: { scope?: "share" | "workspace"; role_id?: string }): Promise<{ export_id: string; entry_count: number; checkpoint_count: number; saved_to: string | null; error: string | null }> {
    const result = await this.#ownerClient().call<{ export_id: string; bundle_dir: string; entry_count: number; checkpoint_count: number }>("knowledge.export", { ...(input.scope ? { scope: input.scope } : {}), ...(input.role_id ? { role_id: input.role_id } : {}) }, { timeoutMs: 30000 });
    const fixture = process.env.ROLEDOCK_SHELL_EXPORT_FIXTURE;
    let target: string | null = fixture ?? null;
    if (!target) {
      const { dialog } = await import("electron");
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const picked = parent ? await dialog.showOpenDialog(parent, { title: "选择导出目录", properties: ["openDirectory", "createDirectory"] }) : { canceled: true } as const;
      target = picked.canceled ? null : picked.filePaths[0] ?? null;
    }
    if (!target) return { export_id: result.export_id, entry_count: result.entry_count, checkpoint_count: result.checkpoint_count, saved_to: null, error: "已取消:导出包保留在工作空间 .roledock/exports 下。" };
    try {
      await cp(result.bundle_dir, target, { recursive: true });
      return { export_id: result.export_id, entry_count: result.entry_count, checkpoint_count: result.checkpoint_count, saved_to: target, error: null };
    } catch (error) {
      return { export_id: result.export_id, entry_count: result.entry_count, checkpoint_count: result.checkpoint_count, saved_to: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }

  /** G5 knowledge import: the user picks an export bundle directory; import
   * only CREATES candidates — adoption/publishing stays with the authorized
   * role in its original session. */
  async knowledgeImport(): Promise<{ ok: boolean; created: Array<{ candidate_id: string; target_role_id: string; document_key: string; baseline_revision: number }>; skipped: Array<{ document_key: string; reason: string }>; source_workspace_id: string | null; error: string | null }> {
    const fixture = process.env.ROLEDOCK_SHELL_IMPORT_FIXTURE;
    let bundleDir: string | null = fixture ?? null;
    if (!bundleDir) {
      const { dialog } = await import("electron");
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const picked = parent ? await dialog.showOpenDialog(parent, { title: "选择知识导出包目录", properties: ["openDirectory"] }) : { canceled: true } as const;
      bundleDir = picked.canceled ? null : picked.filePaths[0] ?? null;
    }
    if (!bundleDir) return { ok: false, created: [], skipped: [], source_workspace_id: null, error: "已取消:未选择导出包。" };
    try {
      const result = await this.#ownerClient().call<{ source_workspace_id: string; created_candidates: Array<{ candidate_id: string; target_role_id: string; document_key: string; baseline_revision: number }>; skipped: Array<{ document_key: string; reason: string }> }>("knowledge.import", { bundle_dir: bundleDir }, { timeoutMs: 30000 });
      return { ok: true, created: result.created_candidates, skipped: result.skipped, source_workspace_id: result.source_workspace_id, error: null };
    } catch (error) {
      return { ok: false, created: [], skipped: [], source_workspace_id: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }

  bridgeStatus(): BridgeStatus {
    return this.#bridge.status;
  }

  async rolesInstall(sourcePath: string): Promise<{ roles: Array<{ id: string; title: string; initialized: boolean }>; reinstalled: boolean }> {
    return this.#ownerClient().call("roles.install", { source_path: sourcePath }, { timeoutMs: 30000 });
  }

  async rolesList(): Promise<{ roles: Array<{ role_id: string; title: string; initialized: boolean; generation: number; requested_capabilities: string[]; granted_capabilities: string[] }> }> {
    return this.#ownerClient().call("roles.list", {}, { timeoutMs: 5000 });
  }

  async rolesGet(roleId: string): Promise<unknown> {
    return this.#ownerClient().call("roles.get", { role_id: roleId }, { timeoutMs: 5000 });
  }

  async policyGrant(roleId: string, capability: string): Promise<unknown> {
    return this.#ownerClient().call("policy.grant", { role_id: roleId, capability }, { timeoutMs: 5000 });
  }

  async policyRevoke(roleId: string, capability: string): Promise<unknown> {
    return this.#ownerClient().call("policy.revoke", { role_id: roleId, capability }, { timeoutMs: 5000 });
  }

  async policyList(): Promise<unknown> {
    return this.#ownerClient().call("policy.list", { limit: 200 }, { timeoutMs: 5000 });
  }

  #settings(): ShellSettings {
    return loadSettingsFile(this.#settingsFile);
  }

  #ownerClient() {
    if (!this.#foreground) throw new Error("尚未打开工作空间。");
    const client = this.#supervisor.ownerClient(this.#foreground);
    if (!client) throw new Error("当前工作空间没有可用的 owner 连接。");
    return client;
  }

  #view(handle: WorkspaceHandle | undefined): WorkspaceStatus {
    if (!handle) return { foregroundDir: null, workspaceId: null, state: "closed", owned: false, mode: null, pid: null, socketPath: null, lastRefreshAt: null, error: null, detail: null };
    return { foregroundDir: handle.dir, workspaceId: handle.workspaceId, state: handle.state, owned: handle.owned, mode: handle.mode, pid: handle.pid, socketPath: handle.socketPath, lastRefreshAt: handle.lastRefreshAt, error: handle.error, detail: handle.owned ? "本应用启动的服务" : "附着的外部服务（退出应用不会停止它）" };
  }
}
