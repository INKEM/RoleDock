/** Shell renderer: hash router + global error boundary over named-IPC pages. */

type IpcReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
export interface WorkspaceStatus { foregroundDir: string | null; workspaceId: string | null; state: string; owned: boolean; mode: "mock" | "zcode" | null; pid: number | null; socketPath: string | null; lastRefreshAt: string | null; error: string | null; detail: string | null }
export interface ConfirmSessionView { session: { external_session_id: string; host_session_id: string; connection_subject: string; created_at: string }; active_authorization: { authorization_id: string; role_id: string; expires_at: string; source: { kind: string; event_ref: string } } | null }
export interface ConfirmRoleView { role_id: string; title: string; initialized: boolean; requested_capabilities: string[]; generation?: number; granted_capabilities?: string[] }
export interface ShellSettings {
  defaultWorkspaceDir: string | null;
  exitStopsOwnedServices: boolean;
  launcher: { kind: "mock" | "zcode"; cliPath: string | null; credentialHelper: string | null; provider: string | null; model: string | null; managedEgress: string[] };
  recentWorkspaces: Array<{ path: string; label: string; lastOpenedAt: string }>;
}

export class ShellError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export async function call<T>(namespace: string, method: string, payload?: unknown): Promise<T> {
  const bridge = (window as unknown as { roledock?: { shell?: Record<string, Record<string, unknown>> } }).roledock?.shell;
  const entry = bridge?.[namespace]?.[method];
  if (typeof entry !== "function") throw new ShellError("NO_SUCH_METHOD", `未知 shell 方法：${namespace}.${method}`);
  const reply = (await (entry as (payload?: unknown) => Promise<IpcReply<T>>)(payload)) as IpcReply<T>;
  if (!reply.ok) throw new ShellError(reply.error.code, reply.error.message);
  return reply.result;
}

// -- error boundary -----------------------------------------------------------

const boundary = () => document.getElementById("error-boundary")!;

export function showError(error: unknown): void {
  const message = error instanceof ShellError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : String(error);
  boundary().textContent = `出错了：${message}`;
  boundary().classList.remove("hidden");
}

export function clearError(): void {
  boundary().textContent = "";
  boundary().classList.add("hidden");
}

window.addEventListener("error", event => showError(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => showError(event.reason));

/** Wraps an async page action: any throw lands in the boundary, never kills the shell. */
export function guarded(action: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      clearError();
      await action();
    } catch (error) {
      showError(error);
    }
  };
}

export function text(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

export function renderStatusCard(status: WorkspaceStatus): string {
  if (!status.foregroundDir) return `<div class="card">尚未打开工作空间。</div>`;
  const lines = [
    `目录：${status.foregroundDir}`,
    `workspace_id：${status.workspaceId ?? "—"}`,
    `状态：${status.state}${status.owned ? "（本应用启动）" : "（附着的外部服务）"}`,
    `pid：${status.pid ?? "—"}　socket：${status.socketPath ?? "—"}`,
    `最后刷新：${status.lastRefreshAt ?? "—"}`,
    status.error ? `错误：${status.error}` : "",
    status.state === "running" && status.owned ? "提示：关闭窗口不会停止该服务；退出应用才会停止本应用启动的服务。" : "",
  ];
  return `<div class="card">${lines.filter(Boolean).map(line => `${escapeHtml(line)}<br>`).join("")}</div>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// -- pages --------------------------------------------------------------------

import { renderWorkspacePage } from "./pages/workspace.js";
import { renderConfirmPage } from "./pages/confirm.js";
import { renderSettingsPage } from "./pages/settings.js";
import { renderRolesPage } from "./pages/roles.js";
import { renderKnowledgePage } from "./pages/knowledge.js";
import { renderInboxPage } from "./pages/inbox.js";

const routes: Record<string, (container: HTMLElement) => Promise<void>> = {
  "/workspace": renderWorkspacePage,
  "/confirm": renderConfirmPage,
  "/roles": renderRolesPage,
  "/knowledge": renderKnowledgePage,
  "/inbox": renderInboxPage,
  "/settings": renderSettingsPage,
};

async function route(): Promise<void> {
  clearError();
  const hash = location.hash.replace(/^#/, "") || "/workspace";
  for (const [path, id] of [["/workspace", "nav-workspace"], ["/confirm", "nav-confirm"], ["/roles", "nav-roles"], ["/knowledge", "nav-knowledge"], ["/inbox", "nav-inbox"], ["/settings", "nav-settings"]] as const) {
    document.getElementById(id)?.classList.toggle("active", hash === path);
  }
  const container = document.getElementById("page")!;
  container.textContent = "加载中…";
  const action = routes[hash] ?? renderWorkspacePage;
  await guarded(async () => {
    container.textContent = "";
    await action(container);
  })();
}

window.addEventListener("hashchange", () => void route());
void route();
