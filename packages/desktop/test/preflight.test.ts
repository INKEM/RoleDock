import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreflight } from "../src/shell/preflight.js";
import type { LauncherSettings } from "../src/shell/shared/settings.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const baseLauncher: LauncherSettings = { kind: "mock", cliPath: null, credentialHelper: null, provider: null, model: null, managedEgress: [] };

function fakeExec(responses: Record<string, { stdout?: string; error?: Error }>) {
  return async (file: string, args: string[]) => {
    const key = `${file} ${args.join(" ")}`;
    const response = responses[key] ?? responses[file] ?? { stdout: "" };
    if (response.error) throw response.error;
    return { stdout: response.stdout ?? "", stderr: "" };
  };
}

describe("G2 access preflight (read-only, injected exec)", () => {
  it("happy path: node runtime, CLI version, sandbox runner and egress all ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-")); dirs.push(dir);
    const cli = join(dir, "zcode.cjs"); writeFileSync(cli, ""); chmodSync(cli, 0o755);
    const connector = join(dir, "zcode-connector.mjs"); writeFileSync(connector, "");
    const checks = await runPreflight({
      nodePath: "/node",
      connectorPath: connector,
      launcher: { ...baseLauncher, kind: "zcode", cliPath: cli, managedEgress: ["api.example.com:443"] },
      workspaceDir: dir,
      execFile: fakeExec({
        "/node --version": { stdout: "v22.23.2\n" },
        "/node --check": { stdout: "" },
        [`${cli} --version`]: { stdout: "0.16.9\n" },
      }),
      probeSandbox: async () => ({ available: true, runner: "bubblewrap", version: "0.6.1" }),
      readFile: () => "1\n124252\n",
    });
    const byName = Object.fromEntries(checks.map(check => [check.name, check]));
    expect(byName.node_runtime?.state).toBe("ok");
    expect(byName.zcode_cli?.state).toBe("ok");
    expect(byName.zcode_cli?.detail).toContain("0.16.9");
    expect(byName.connector_bundle?.state).toBe("ok");
    expect(byName.sandbox_runner?.state).toBe("ok");
    expect(byName.egress_list?.state).toBe("ok");
    expect(byName.workspace_dir?.state).toBe("ok");
    // Read-only promise: nothing here creates sessions or consumes model turns.
    expect(checks.length).toBe(7);
  });

  it("missing CLI config and broken runner surface honest degraded/missing states", async () => {
    const checks = await runPreflight({
      nodePath: "/node",
      connectorPath: "/nonexistent/connector.mjs",
      launcher: baseLauncher,
      workspaceDir: null,
      execFile: fakeExec({ "/node --version": { error: new Error("ENOENT") } }),
      probeSandbox: async () => ({ available: false, runner: "bubblewrap", reason: "Can't create user namespace" }),
      readFile: () => { throw new Error("unreadable"); },
    });
    const byName = Object.fromEntries(checks.map(check => [check.name, check]));
    expect(byName.node_runtime?.state).toBe("error");
    expect(byName.zcode_cli?.state).toBe("missing");
    expect(byName.zcode_cli?.detail).toContain("未配置");
    expect(byName.connector_bundle?.state).toBe("missing");
    expect(byName.sandbox_runner?.detail).toContain("受管执行将被拒绝");
    expect(byName.userns?.state).toBe("degraded");
    expect(byName.egress_list?.detail).toContain("mock");
  });

  it("invalid egress entries and unwritable directory are reported as errors/missing", async () => {
    const checks = await runPreflight({
      nodePath: "/node",
      connectorPath: "/vendor/zcode-connector.mjs",
      launcher: { ...baseLauncher, kind: "zcode", cliPath: "/cli", managedEgress: ["not a host"] },
      workspaceDir: "/proc/definitely/not/writable",
      execFile: fakeExec({ "/node --version": { stdout: "v22.23.2\n" }, "/cli --version": { stdout: "x\n" } }),
      probeSandbox: async () => ({ available: true, runner: "bubblewrap" }),
      readFile: () => "1\n",
    });
    const byName = Object.fromEntries(checks.map(check => [check.name, check]));
    expect(byName.egress_list?.state).toBe("error");
    expect(byName.workspace_dir?.state).toBe("missing");
  });
});
