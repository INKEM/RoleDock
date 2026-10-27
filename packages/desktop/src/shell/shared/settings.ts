import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Shell settings persisted under the app's stable userData directory. */
export interface LauncherSettings {
  kind: "mock" | "zcode";
  cliPath: string | null;
  credentialHelper: string | null;
  provider: string | null;
  model: string | null;
  managedEgress: string[];
}

export interface RecentWorkspace { path: string; label: string; lastOpenedAt: string }

export interface ShellSettings {
  defaultWorkspaceDir: string | null;
  exitStopsOwnedServices: boolean;
  launcher: LauncherSettings;
  recentWorkspaces: RecentWorkspace[];
}

export const DEFAULT_SETTINGS: ShellSettings = {
  defaultWorkspaceDir: null,
  exitStopsOwnedServices: true,
  launcher: { kind: "mock", cliPath: null, credentialHelper: null, provider: null, model: null, managedEgress: [] },
  recentWorkspaces: [],
};

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}

export function loadSettingsFile(path: string): ShellSettings {
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ShellSettings>;
    const launcher = raw.launcher ?? DEFAULT_SETTINGS.launcher;
    return {
      defaultWorkspaceDir: typeof raw.defaultWorkspaceDir === "string" && raw.defaultWorkspaceDir.trim() ? raw.defaultWorkspaceDir : null,
      exitStopsOwnedServices: raw.exitStopsOwnedServices !== false,
      launcher: {
        kind: launcher.kind === "zcode" ? "zcode" : "mock",
        cliPath: typeof launcher.cliPath === "string" && launcher.cliPath.trim() ? launcher.cliPath : null,
        credentialHelper: typeof launcher.credentialHelper === "string" && launcher.credentialHelper.trim() ? launcher.credentialHelper : null,
        provider: typeof launcher.provider === "string" && launcher.provider.trim() ? launcher.provider : null,
        model: typeof launcher.model === "string" && launcher.model.trim() ? launcher.model : null,
        managedEgress: Array.isArray(launcher.managedEgress) ? launcher.managedEgress.filter((item): item is string => typeof item === "string") : [],
      },
      recentWorkspaces: Array.isArray(raw.recentWorkspaces)
        ? raw.recentWorkspaces.filter((item): item is RecentWorkspace => !!item && typeof item.path === "string" && typeof item.lastOpenedAt === "string")
        : [],
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettingsFile(path: string, patch: Partial<ShellSettings>): ShellSettings {
  const current = loadSettingsFile(path);
  const merged: ShellSettings = {
    ...current,
    ...patch,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return merged;
}

/** Moves `path` to the front of the recent list (deduped, capped at 10). */
export function touchRecent(settings: ShellSettings, path: string, now = new Date().toISOString()): ShellSettings {
  const label = path.split("/").filter(Boolean).pop() ?? path;
  const rest = settings.recentWorkspaces.filter(item => item.path !== path);
  return { ...settings, recentWorkspaces: [{ path, label, lastOpenedAt: now }, ...rest].slice(0, 10) };
}

/** Removes a recent entry; the workspace project itself is never deleted. */
export function removeRecent(settings: ShellSettings, path: string): ShellSettings {
  return { ...settings, recentWorkspaces: settings.recentWorkspaces.filter(item => item.path !== path) };
}
