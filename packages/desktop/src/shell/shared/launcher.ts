import { constants, mkdirSync, openSync, closeSync, fchmodSync, writeFileSync, lstatSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Launcher configuration persisted next to the workspace (0600): paths and
 * identifiers only — credentials stay with the external credential helper. */
export interface ZcodeLauncherConfig {
  kind: "zcode";
  cliPath: string;
  connectorPath: string;
  credentialHelper?: string;
  provider?: string;
  model?: string;
  managed?: { egress: string[] };
  journalPath?: string;
}

/**
 * Safe launcher-config write (G2-R05): never follows symlinks and never
 * overwrites a non-owned endpoint. The state directory must be a real,
 * user-owned directory; an existing config must be a regular owned file.
 * Content is written to an exclusive temp file and atomically renamed, so
 * the previous config survives until the new one is fully on disk, and a
 * rename replaces a planted symlink itself instead of its target.
 */
export function writeLauncherConfigFile(dir: string, config: ZcodeLauncherConfig): string {
  const stateDir = join(dir, ".roledock");
  let stateStat;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    stateStat = lstatSync(stateDir);
  } catch (error) {
    throw new Error(`工作空间状态目录不可用：${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new Error(".roledock 不是真实目录（符号链接或其他端点），拒绝写入。");
  }
  if (process.getuid !== undefined && stateStat.uid !== process.getuid()) {
    throw new Error(".roledock 属主不是当前用户，拒绝写入。");
  }
  const path = join(stateDir, "launcher-config.json");
  let existing;
  try { existing = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`配置端点不可检查：${(error as NodeJS.ErrnoException).code}`);
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("launcher-config.json 不是常规文件（符号链接或其他端点），拒绝覆盖；目标内容保持不变。");
    }
    if (process.getuid !== undefined && existing.uid !== process.getuid()) {
      throw new Error("launcher-config.json 属主不是当前用户，拒绝覆盖。");
    }
  }
  // Exclusive temp file (O_NOFOLLOW: never write through a planted link),
  // fully written and fsync-ordered by close, then atomically renamed.
  const temp = join(stateDir, `launcher-config.json.tmp-${randomBytes(4).toString("hex")}`);
  const descriptor = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify(config, null, 2));
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return path;
}
