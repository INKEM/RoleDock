import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { planEgress, probeSandboxRunner } from "@roledock/adapter-zcode";
import type { LauncherSettings } from "./shared/settings.js";

/**
 * Desktop-side access preflight (DESKTOP_GUI_PLAN §10): Node, ZCode CLI,
 * connector bundle, bubblewrap/kernel userns, directory and egress list.
 * Ordinary preflight is read-only — it never creates sessions or consumes
 * model turns. The connection test is a separate user action (the shell
 * exposes it through its own named IPC method).
 */

export type PreflightState = "ok" | "degraded" | "missing" | "error";

export interface PreflightCheck {
  name: "node_runtime" | "zcode_cli" | "connector_bundle" | "sandbox_runner" | "userns" | "workspace_dir" | "egress_list";
  state: PreflightState;
  detail: string;
}

export interface PreflightDeps {
  /** Locked service runtime binary (dev cache or packaged resources). */
  nodePath: string;
  /** Bundled reference-connector entry (vendor/zcode-connector.mjs). */
  connectorPath: string;
  launcher: LauncherSettings;
  workspaceDir: string | null;
  execFile: (file: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  readFile?: (path: string) => string;
  probeSandbox?: typeof probeSandboxRunner;
}

const EXPECTED_RUNTIME = "v22.23.2";

export async function runPreflight(deps: PreflightDeps): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const probe = deps.probeSandbox ?? probeSandboxRunner;

  // 1. Locked Node runtime for the service subprocess.
  try {
    const version = (await deps.execFile(deps.nodePath, ["--version"], { timeout: 10000 })).stdout.trim();
    checks.push({ name: "node_runtime", state: version === EXPECTED_RUNTIME ? "ok" : "degraded", detail: version === EXPECTED_RUNTIME ? `锁定运行时 ${version}` : `运行时 ${version}，期望 ${EXPECTED_RUNTIME}（服务将以此启动，行为可能与定档不符）` });
  } catch (error) {
    checks.push({ name: "node_runtime", state: "error", detail: `无法执行运行时：${short(error)}` });
  }

  // 2. ZCode CLI: presence + --version query only (never a session).
  if (deps.launcher.kind !== "zcode" || !deps.launcher.cliPath) {
    checks.push({ name: "zcode_cli", state: "missing", detail: "未配置 ZCode CLI 路径；真实接入不可用（可改用 mock 诊断模式）" });
  } else {
    const cliPath = deps.launcher.cliPath;
    if (!existsSync(cliPath)) {
      checks.push({ name: "zcode_cli", state: "missing", detail: `CLI 路径不存在：${cliPath}` });
    } else {
      try { accessSync(cliPath, constants.X_OK); } catch {
        checks.push({ name: "zcode_cli", state: "missing", detail: `CLI 文件不可执行：${cliPath}` });
      }
      try {
        const version = (await deps.execFile(cliPath, ["--version"], { timeout: 15000 })).stdout.trim();
        checks.push({ name: "zcode_cli", state: "ok", detail: `CLI 版本：${version || "（无输出）"}` });
      } catch (error) {
        checks.push({ name: "zcode_cli", state: "error", detail: `CLI 版本查询失败：${short(error)}` });
      }
    }
  }

  // 3. Connector bundle: must be loadable by the INDEPENDENT locked Node —
  // an asar-internal path passes Electron's existsSync but fails real Node.
  if (!existsSync(deps.connectorPath)) {
    checks.push({ name: "connector_bundle", state: "missing", detail: `连接器缺失：${deps.connectorPath}` });
  } else {
    try {
      await deps.execFile(deps.nodePath, ["--check", deps.connectorPath], { timeout: 15000 });
      checks.push({ name: "connector_bundle", state: "ok", detail: "连接器可由锁定 Node 加载（--check 通过）" });
    } catch (error) {
      checks.push({ name: "connector_bundle", state: "missing", detail: `连接器无法由锁定 Node 加载：${short(error)}` });
    }
  }

  // 4. bubblewrap runner (real namespace dry-run; read-only).
  try {
    const runner = await probe();
    checks.push(runner.available
      ? { name: "sandbox_runner", state: "ok", detail: `bubblewrap ${runner.version ?? "可用"}（namespace 干跑通过）` }
      : { name: "sandbox_runner", state: "missing", detail: `受管沙箱不可用：${runner.reason ?? "未知原因"}；受管执行将被拒绝` });
  } catch (error) {
    checks.push({ name: "sandbox_runner", state: "error", detail: `沙箱探测失败：${short(error)}` });
  }

  // 5. Kernel unprivileged userns (informational read; functional coverage is the dry-run above).
  try {
    const clone = readFile("/proc/sys/kernel/unprivileged_userns_clone").trim();
    const max = readFile("/proc/sys/user/max_user_namespaces").trim();
    checks.push({ name: "userns", state: clone === "1" ? "ok" : "degraded", detail: `unprivileged_userns_clone=${clone || "未知"}，max_user_namespaces=${max || "未知"}` });
  } catch {
    checks.push({ name: "userns", state: "degraded", detail: "内核 userns 参数不可读（以沙箱干跑结果为准）" });
  }

  // 6. Workspace directory writability.
  if (!deps.workspaceDir) {
    checks.push({ name: "workspace_dir", state: "degraded", detail: "尚未选择工作空间目录" });
  } else {
    try {
      accessSync(deps.workspaceDir, constants.W_OK);
      checks.push({ name: "workspace_dir", state: "ok", detail: `目录可写：${deps.workspaceDir}` });
    } catch {
      checks.push({ name: "workspace_dir", state: "missing", detail: `目录不可写或不存在：${deps.workspaceDir}` });
    }
  }

  // 7. Managed egress list validity (pure planning; no sockets opened).
  const egress = deps.launcher.managedEgress;
  if (deps.launcher.kind !== "zcode") {
    checks.push({ name: "egress_list", state: "degraded", detail: "mock 模式不使用受管出口" });
  } else if (egress.length === 0) {
    checks.push({ name: "egress_list", state: "degraded", detail: "未配置受管出口（将以非受管 restricted 模式声明）" });
  } else {
    try {
      const plan = planEgress(egress);
      checks.push({ name: "egress_list", state: "ok", detail: `受管出口 ${egress.length} 项合法（伪 IP 分配 ${plan.entries.length} 条）` });
    } catch (error) {
      checks.push({ name: "egress_list", state: "error", detail: `出口白名单非法：${short(error)}` });
    }
  }
  return checks;
}

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
