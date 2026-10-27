import { expect, test, _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceClient } from "@roledock/service";

const packageRoot = join(import.meta.dirname, "..", "..");
const nodeBinary = process.env.ROLEDOCK_PROBE_NODE ?? join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");
const expectedSurface = ["getStatus", "pickDirectory", "runChecks", "startService", "stopService"];

interface ProbeStateFile {
  mode: string;
  runtimeNode: string;
  runtimeVersion: string | null;
  service: { state: string; pid: number | null; workspaceRoot: string | null; socketPath: string | null; workspaceId: string | null };
  events: Array<{ at: string; event: string; detail?: string }>;
}

function readState(baseDir: string): ProbeStateFile {
  return JSON.parse(readFileSync(join(baseDir, "state.json"), "utf8")) as ProbeStateFile;
}

async function waitForEvent(baseDir: string, event: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readState(baseDir).events.some(item => item.event === event)) return;
    if (Date.now() > deadline) throw new Error(`event ${event} not observed within ${timeoutMs}ms; events=${JSON.stringify(readState(baseDir).events.map(item => item.event))}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("G0 probe lifecycle: named IPC, checks, dialog, window-close vs owned service, single instance, quit reap", async () => {
  expect(existsSync(nodeBinary), "runtime cache missing; run npm run desktop:runtime").toBe(true);
  const baseDir = mkdtempSync(join(tmpdir(), "roledock-e2e-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "roledock-e2e-picked-"));
  const outDir = process.env.ROLEDOCK_E2E_OUT ?? baseDir;
  const cleanup = [baseDir, fixtureDir];

  const app: ElectronApplication = await _electron.launch({
    args: [join(packageRoot, "dist-desktop", "vendor", "main.mjs")],
    cwd: packageRoot,
    env: { ...process.env, ROLEDOCK_PROBE_NODE: nodeBinary, ROLEDOCK_PROBE_DIR: baseDir, ROLEDOCK_PROBE_DIALOG_FIXTURE: fixtureDir },
  });

  try {
    const win: Page = await app.firstWindow();
    await expect(win).toHaveTitle("RoleDock P6-G0 技术探针");

    // 1. Named-IPC surface: closed vocabulary, no generic rpc, no Node in renderer.
    const surface = await win.evaluate(() => {
      const roledock = (window as unknown as { roledock?: Record<string, Record<string, unknown>> }).roledock;
      return {
        root: Object.keys(roledock ?? {}),
        probe: Object.keys(roledock?.probe ?? {}),
        allFunctions: Object.values(roledock?.probe ?? {}).every(item => typeof item === "function"),
        noProcess: typeof process === "undefined",
        noRequire: typeof require === "undefined",
      };
    });
    expect(surface.root).toEqual(["probe"]);
    expect(surface.probe.sort()).toEqual([...expectedSurface].sort());
    expect(surface.allFunctions).toBe(true);
    expect(surface.noProcess).toBe(true);
    expect(surface.noRequire).toBe(true);

    // 2. No credential material in the rendering layer.
    const html = await win.content();
    expect(html).not.toMatch(/[0-9a-f]{64}/);

    // 3. Service subprocess start (locked Node 22.23.2 binary).
    await win.click("#start");
    let pid = 0;
    await expect.poll(() => readState(baseDir).service.state, { timeout: 30000 }).toBe("running");
    {
      const state = readState(baseDir);
      pid = state.service.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      expect(state.service.workspaceId).toMatch(/^ws-/);
      expect(state.runtimeNode).toBe(nodeBinary);
      expect(state.mode).toBe("dev");
    }
    await win.screenshot({ path: join(outDir, "e2e-1-service-running.png"), fullPage: true });

    // 4. Checks: runtime version, owner RPC, SQLite single writer, MCP subprocess.
    await win.click("#run-checks");
    await expect(win.locator("#checks li")).toHaveCount(4, { timeout: 60000 });
    const checks = (await win.locator("#checks li").allTextContents()).join("\n");
    expect(checks).toContain("✅ runtime_version");
    expect(checks).toContain("v22.23.2");
    expect(checks).toContain("✅ workspace_info");
    expect(checks).toMatch(/✅ sqlite_single_writer.*errcode=5/s);
    expect(checks).toMatch(/✅ mcp_subprocess.*14 tools/s);
    await waitForEvent(baseDir, "checks-finished");
    await win.screenshot({ path: join(outDir, "e2e-2-checks.png"), fullPage: true });

    // 5. Directory selection through the named IPC (automated run uses the
    // documented dialog fixture; the real native dialog is exercised in the
    // interactive dev probe run recorded in the evidence log).
    await win.click("#pick");
    await expect(win.locator("#picked")).toHaveText(fixtureDir, { timeout: 15000 });

    // 6. Closing the window keeps the owned service running; owner RPC still answers.
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
    await waitForEvent(baseDir, "window-all-closed-service-kept");
    {
      const state = readState(baseDir);
      const credential = JSON.parse(readFileSync(join(state.service.workspaceRoot!, ".roledock", "owner-connection.json"), "utf8")) as { socket_path: string; token: string };
      const info = await new ServiceClient(credential).call<{ workspace_id: string }>("workspace.info");
      expect(info.workspace_id).toBe(state.service.workspaceId);
    }

    // 7. A second launch is refused by the single-instance lock; the first app logs the event.
    const second = spawnSync(join(packageRoot, "..", "..", "node_modules", ".bin", "electron"), [join(packageRoot, "dist-desktop", "vendor", "main.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, ROLEDOCK_PROBE_NODE: nodeBinary, ROLEDOCK_PROBE_DIR: baseDir },
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("desktop-probe-single-instance-refused");
    await waitForEvent(baseDir, "second-instance-focused");
    await win.screenshot({ path: join(outDir, "e2e-3-after-single-instance.png"), fullPage: true }).catch(() => undefined);

    // 8. Quitting the app reaps the owned service process.
    await app.close();
    const deadline = Date.now() + 15000;
    for (;;) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
      if (!alive) break;
      if (Date.now() > deadline) throw new Error(`service pid ${pid} still alive after app quit`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // 9. The lock is released: the same workspace can be opened by a fresh service.
    const state = readState(baseDir);
    const serviceBundle = join(packageRoot, "dist-desktop", "vendor", "service-bundle.mjs");
    const restart = spawn(nodeBinary, [serviceBundle, "--mock-workspace", state.service.workspaceRoot!], { env: {}, stdio: "ignore" });
    const credentialPath = join(state.service.workspaceRoot!, ".roledock", "owner-connection.json");
    const deadline2 = Date.now() + 20000;
    for (;;) {
      if (existsSync(credentialPath)) break;
      if (Date.now() > deadline2) throw new Error("workspace lock was not released after probe quit");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    restart.kill("SIGTERM");
  } finally {
    app.close().catch(() => undefined);
    if (process.env.ROLEDOCK_E2E_KEEP === undefined) for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
});
