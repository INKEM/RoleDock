import { ipcMain, dialog, app, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { redact } from "../shared/redact.js";
import { channelFor, SHELL_NAMESPACES } from "../shared/contract.js";
import type { ShellNamespace } from "../shared/contract.js";
import { isTrustedSender, shellPageUrlPrefix } from "../shared/sender.js";
import { loadSettingsFile, saveSettingsFile, settingsPath, removeRecent } from "../shared/settings.js";
import type { ShellSettings } from "../shared/settings.js";
import { runPreflight } from "../preflight.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceController } from "./workspace-controller.js";

export function createShellWindow(rendererDir: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "RoleDock",
    webPreferences: { preload: join(rendererDir, "..", "preload.cjs") },
  });
  void window.loadFile(join(rendererDir, "index.html"));
  return window;
}

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => Promise<unknown> | unknown;

/**
 * Registers the closed-vocabulary shell IPC surface (desktop-gui-contract
 * §4). Unknown channels never reach a handler — only manifest channels are
 * registered; every handler checks the sender frame, validates the payload
 * shape, and redacts its reply: no bearer, no generic rpc, no
 * renderer-controlled operation name, no shell.
 */
export function registerShellIpc(options: { rendererDir: string; controller: WorkspaceController; userDataDir: string; nodePath: string; connectorPath: string }): { settingsFile: string } {
  const urlPrefix = shellPageUrlPrefix(options.rendererDir);
  const settingsFile = settingsPath(options.userDataDir);
  const noPayload = (handler: () => unknown): Handler => (payload, event) => {
    assertTrusted(event, urlPrefix);
    assertEmptyPayload(payload);
    return handler();
  };
  const handlers: Record<string, Handler> = {
    "workspace:pickDirectory": async (payload, event) => {
      assertTrusted(event, urlPrefix);
      assertEmptyPayload(payload);
      // Automated runs use the documented fixture; interactive runs get the
      // real native directory dialog attached to the focused shell window.
      const fixture = process.env.ROLEDOCK_SHELL_DIALOG_FIXTURE;
      if (fixture) return { canceled: false, path: fixture };
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) throw new Error("没有可用的 shell 窗口。");
      const result = await dialog.showOpenDialog(target, { title: "选择工作空间目录", properties: ["openDirectory", "createDirectory"] });
      return { canceled: result.canceled, path: result.canceled ? null : result.filePaths[0] ?? null };
    },
    "workspace:open": (payload, event) => {
      assertTrusted(event, urlPrefix);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("需要包含 dir 的 JSON 对象。");
      const record = payload as Record<string, unknown>;
      const dir = stringField(payload, "dir");
      const launcherKind = record.launcher === undefined ? undefined : record.launcher === "zcode" ? "zcode" as const : record.launcher === "mock" ? "mock" as const : undefined;
      if (record.launcher !== undefined && launcherKind === undefined) throw new Error("launcher 必须是 \"mock\" 或 \"zcode\"。");
      return options.controller.open(dir, launcherKind);
    },
    "workspace:status": noPayload(() => options.controller.status()),
    "workspace:refresh": noPayload(() => options.controller.refresh()),
    "workspace:stop": noPayload(() => options.controller.stop()),
    "workspace:restart": noPayload(() => options.controller.restart()),
    "workspace:diagnostics": noPayload(() => options.controller.diagnostics()),
    "workspace:openWindow": noPayload(() => { createShellWindow(options.rendererDir); return { ok: true }; }),
    "workspace:removeRecent": (payload, event) => {
      assertTrusted(event, urlPrefix);
      const path = stringField(payload, "path");
      // G2-R04: the removal must be PERSISTED, not just returned.
      return { recentWorkspaces: saveSettingsFile(settingsFile, { recentWorkspaces: removeRecent(loadSettingsFile(settingsFile), path).recentWorkspaces }).recentWorkspaces };
    },
    "workspace:preflight": async (payload, event) => {
      assertTrusted(event, urlPrefix);
      assertEmptyPayload(payload);
      const settings = loadSettingsFile(settingsFile);
      const dir = options.controller.foregroundDir;
      return runPreflight({
        nodePath: options.nodePath,
        connectorPath: options.connectorPath,
        launcher: settings.launcher,
        workspaceDir: dir,
        execFile: promisify(execFile),
      });
    },
    "workspace:testConnection": noPayload(() => options.controller.testConnection()),
    "roles:install": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.rolesInstall(stringField(payload, "dir"));
    },
    "roles:list": noPayload(() => options.controller.rolesList()),
    "roles:get": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.rolesGet(stringField(payload, "role_id"));
    },
    "roles:grant": (payload, event) => {
      assertTrusted(event, urlPrefix);
      if (!payload || typeof payload !== "object") throw new Error("需要 JSON 对象。");
      const record = payload as Record<string, unknown>;
      return options.controller.policyGrant(stringField(record, "role_id"), stringField(record, "capability"));
    },
    "roles:revoke": (payload, event) => {
      assertTrusted(event, urlPrefix);
      if (!payload || typeof payload !== "object") throw new Error("需要 JSON 对象。");
      const record = payload as Record<string, unknown>;
      return options.controller.policyRevoke(stringField(record, "role_id"), stringField(record, "capability"));
    },
    "confirm:listSessions": noPayload(() => options.controller.confirmSessions()),
    "confirm:listRoles": noPayload(() => options.controller.confirmRoles()),
    "confirm:submit": (payload, event) => {
      assertTrusted(event, urlPrefix);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("confirm submit 需要 JSON 对象。");
      return options.controller.confirmSubmit(payload as Record<string, unknown>);
    },
    // G3 (desktop-gui-contract §9): discovery, registration and the
    // confirmation progress chain. Registration input is exactly one host
    // session reference; the trusted bridge resolves everything else.
    "confirm:discoverSessions": noPayload(() => options.controller.discoverSessions()),
    "confirm:registerSession": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.registerSession(stringField(payload, "host_session_id"));
    },
    "confirm:confirmations": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.confirmations(pagedListInput(payload));
    },
    "confirm:bridgeStatus": noPayload(() => options.controller.bridgeStatus()),
    // G4 (desktop-gui-contract §2.3): paged owner read views over bindings,
    // anchor attempts and material loads. Same input discipline as
    // confirm:confirmations; the service validates again at its boundary.
    "sessions:listBindings": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.listBindings(pagedListInput(payload));
    },
    "sessions:listAttempts": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.listAttempts(pagedListInput(payload));
    },
    "sessions:listLoads": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.listLoads(pagedListInput(payload));
    },
    // G4 revoke surface: preview is read-only and revoke is the explicit
    // write; the renderer must call the preview first (§2.2 撤销与影响预览).
    // No owner release method exists — release stays with the original
    // session (§5.2).
    "authorizations:revokePreview": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.revokePreview(stringField(payload, "authorization_id"));
    },
    "authorizations:revoke": (payload, event) => {
      assertTrusted(event, urlPrefix);
      return options.controller.revokeAuthorization(stringField(payload, "authorization_id"));
    },
    "settings:get": noPayload(() => loadSettingsFile(settingsFile)),
    "settings:set": (payload, event) => {
      assertTrusted(event, urlPrefix);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("settings set 需要 JSON 对象。");
      const patch = payload as Partial<ShellSettings>;
      if (patch.defaultWorkspaceDir !== undefined && patch.defaultWorkspaceDir !== null && typeof patch.defaultWorkspaceDir !== "string") throw new Error("defaultWorkspaceDir 必须是字符串或 null。");
      if (patch.exitStopsOwnedServices !== undefined && typeof patch.exitStopsOwnedServices !== "boolean") throw new Error("exitStopsOwnedServices 必须是布尔值。");
      if (patch.launcher !== undefined) {
        const launcher = patch.launcher;
        if (!launcher || typeof launcher !== "object") throw new Error("launcher 必须是对象。");
        if (launcher.kind !== "mock" && launcher.kind !== "zcode") throw new Error("launcher.kind 必须是 mock 或 zcode。");
        for (const field of ["cliPath", "credentialHelper", "provider", "model"] as const) {
          const value = launcher[field];
          if (value !== null && typeof value !== "string") throw new Error(`launcher.${field} 必须是字符串或 null。`);
        }
        if (!Array.isArray(launcher.managedEgress) || launcher.managedEgress.some(item => typeof item !== "string")) throw new Error("launcher.managedEgress 必须是字符串数组。");
      }
      if (patch.recentWorkspaces !== undefined && !Array.isArray(patch.recentWorkspaces)) throw new Error("recentWorkspaces 必须是数组。");
      return saveSettingsFile(settingsFile, patch);
    },
    "app:quit": noPayload(() => { app.quit(); return { ok: true }; }),
    "app:version": noPayload(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, mode: app.isPackaged ? "packaged" : "dev" })),
  };
  for (const [namespace, methods] of Object.entries(SHELL_NAMESPACES) as Array<[ShellNamespace, readonly string[]]>) {
    for (const method of methods) {
      const key = `${namespace}:${method}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`Shell IPC manifest method ${key} has no handler.`);
      ipcMain.handle(channelFor(namespace, method), async (event, payload: unknown) => {
        try {
          return { ok: true, result: redact(await handler(payload, event)) };
        } catch (error) {
          const rawCode = error instanceof Error && typeof (error as unknown as { code?: unknown }).code === "string" ? (error as unknown as { code: string }).code : undefined;
          return { ok: false, error: { code: rawCode ?? "SHELL_ERROR", message: (error instanceof Error ? error.message : String(error)).slice(0, 300) } };
        }
      });
    }
  }
  return { settingsFile };
}

function assertTrusted(event: IpcMainInvokeEvent, urlPrefix: string): void {
  if (!isTrustedSender(event, urlPrefix)) throw new Error("IPC 调用来源不受信，已拒绝。");
}

function assertEmptyPayload(payload: unknown): void {
  if (payload !== undefined && payload !== null && typeof payload === "object" && Object.keys(payload as object).length > 0) {
    throw new Error("该方法不接受参数。");
  }
}

/** Shared validation for paged owner list payloads: `{cursor?, limit?,
 * external_session_id?}`, nothing else. */
function pagedListInput(payload: unknown): { cursor?: string; limit?: number; external_session_id?: string } {
  const input: { cursor?: string; limit?: number; external_session_id?: string } = {};
  if (payload !== undefined && payload !== null) {
    if (typeof payload !== "object" || Array.isArray(payload)) throw new Error("分页查询需要 JSON 对象。");
    const record = payload as Record<string, unknown>;
    if (record.cursor !== undefined && (typeof record.cursor !== "string" || !record.cursor)) throw new Error("cursor 必须是非空字符串。");
    if (record.external_session_id !== undefined && (typeof record.external_session_id !== "string" || !record.external_session_id)) throw new Error("external_session_id 必须是非空字符串。");
    if (record.limit !== undefined && record.limit !== null) {
      if (!Number.isInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > 200) throw new Error("limit 必须是 1-200 的整数。");
      input.limit = record.limit as number;
    }
    if (record.cursor !== undefined) input.cursor = record.cursor;
    if (record.external_session_id !== undefined) input.external_session_id = record.external_session_id;
  }
  return input;
}

function stringField(payload: unknown, field: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`需要包含 ${field} 的 JSON 对象。`);
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串。`);
  return value;
}
