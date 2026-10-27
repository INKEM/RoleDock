import { expect, test, _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceClient } from "@roledock/service";

const packageRoot = join(import.meta.dirname, "..", "..");
const nodeBinary = process.env.ROLEDOCK_PROBE_NODE ?? join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");
const serviceBundle = join(packageRoot, "dist-desktop", "vendor", "service-bundle.mjs");
const shellMain = join(packageRoot, "dist-desktop", "shell", "main.mjs");

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "roledock-shell-e2e-"));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function spawnExternalService(dir: string): ChildProcess {
  const child = spawn(nodeBinary, [serviceBundle, "--mock-workspace", dir], { env: {}, stdio: "ignore" });
  const credentialPath = join(dir, ".roledock", "owner-connection.json");
  const deadline = Date.now() + 20000;
  for (;;) {
    if (existsSync(credentialPath)) return child;
    if (Date.now() > deadline) throw new Error("external service did not become ready");
    sleep(200);
  }
}

async function ownerInfo(dir: string, timeoutMs = 5000): Promise<{ workspace_id: string; service?: { pid: number; adapter: string; version: string; runtime: string } }> {
  const credential = JSON.parse(readFileSync(join(dir, ".roledock", "owner-connection.json"), "utf8")) as { socket_path: string; token: string };
  return new ServiceClient(credential).call<{ workspace_id: string; service?: { pid: number; adapter: string; version: string; runtime: string } }>("workspace.info", {}, { timeoutMs });
}

function launchShell(env: Record<string, string | undefined> = {}): Promise<ElectronApplication> {
  return _electron.launch({
    args: [shellMain],
    cwd: packageRoot,
    env: { ...process.env, ROLEDOCK_SHELL_NODE: nodeBinary, ...env },
  });
}

async function statusText(win: Page): Promise<string> {
  return (await win.locator("#status .card").textContent()) ?? "";
}

async function waitStatusContains(win: Page, needle: string, timeoutMs = 30000): Promise<string> {
  await expect.poll(() => statusText(win), { timeout: timeoutMs }).toContain(needle);
  return statusText(win);
}

async function openViaDialog(win: Page): Promise<void> {
  await expect(win.locator("#open-dir")).toBeVisible();
  await win.click("#open-dir");
}

async function openDirect(win: Page, dir: string): Promise<void> {
  await expect(win.locator("#open-dir")).toBeVisible();
  await win.evaluate((dir: unknown) => {
    return (window as unknown as { roledock: { shell: { workspace: { open: (payload: unknown) => Promise<unknown> } } } }).roledock.shell.workspace.open({ dir });
  }, dir);
}

test.describe("P6-G1 shell lifecycle (DESKTOP_GUI_PLAN §9)", () => {
  test("empty workspace start; two windows one writer; window close keeps service; quit reaps owned", async () => {
    expect(existsSync(nodeBinary), "runtime cache missing; run npm run desktop:runtime").toBe(true);
    const ws = tempWorkspace();
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
    try {
      const win = await app.firstWindow();
      await expect(win).toHaveTitle("RoleDock 桌面");

      // Named surface: closed namespaces under roledock.shell, no generic rpc,
      // no Node in the renderer.
      const surface = await win.evaluate(() => {
        const bridge = (window as unknown as { roledock?: { shell?: Record<string, Record<string, unknown>> } }).roledock?.shell;
        return {
          namespaces: Object.keys(bridge ?? {}).sort(),
          workspace: Object.keys(bridge?.workspace ?? {}).sort(),
          noProcess: typeof process === "undefined",
          noRequire: typeof require === "undefined",
        };
      });
      expect(surface.namespaces).toEqual(["app", "authorizations", "confirm", "inbox", "knowledge", "roles", "sessions", "settings", "workspace"]);
      expect(surface.workspace).toEqual(["diagnostics", "open", "openWindow", "pickDirectory", "preflight", "refresh", "removeRecent", "restart", "status", "stop", "testConnection"]);
      expect(surface.noProcess).toBe(true);
      expect(surface.noRequire).toBe(true);
      expect(await win.content()).not.toMatch(/[0-9a-f]{64}/);

      // 1. Open an empty workspace via the dialog fixture — no manual owner file input.
      await openViaDialog(win);
      const card = await waitStatusContains(win, "workspace_id：ws-");
      expect(card).toContain("running");
      expect(card).toContain("本应用启动");
      const firstPid = Number(card.match(/pid：(\d+)/)![1]);
      expect(firstPid).toBeGreaterThan(0);

      // 2. Re-opening the SAME owned workspace keeps ownership and pid (G1-R02).
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await openViaDialog(win);
      await win.click("#refresh");
      const reopened = await waitStatusContains(win, `workspace_id：${card.match(/workspace_id：(ws-[0-9a-f]+)/)![1]}`);
      expect(reopened).toContain(`pid：${firstPid}`);
      expect(reopened).toContain("本应用启动");

      // 3. Two windows, one writer: both show the same controller state/pid.
      await win.click("#new-window");
      const second = await app.waitForEvent("window", { timeout: 15000 });
      await expect(second.locator("#status .card")).toContainText(`workspace_id：`, { timeout: 30000 });
      const secondCard = await statusText(second);
      expect(secondCard).toContain(`pid：${firstPid}`);
      const secondId = secondCard.match(/workspace_id：(ws-[0-9a-f]+)/)![1];
      const firstId = card.match(/workspace_id：(ws-[0-9a-f]+)/)![1];
      expect(secondId).toBe(firstId);
      // The writer lock is exclusive: a second outside connection hits SQLITE_BUSY.
      const { DatabaseSync } = await import("node:sqlite");
      expect(() => {
        const db = new DatabaseSync(join(ws, ".roledock", "state.sqlite"), { timeout: 0 });
        try { db.exec("SELECT 1"); } finally { db.close(); }
      }).toThrow(/database is locked/);

      // 4. Closing all windows keeps the owned service running.
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
      await expect.poll(async () => (await ownerInfo(ws)).workspace_id, { timeout: 15000 }).toBe(firstId);

      // 5. Quitting the app reaps the owned service and frees the lock.
      await app.close();
      const deadline = Date.now() + 20000;
      for (;;) {
        let alive = false;
        try { process.kill(firstPid, 0); alive = true; } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
        if (!alive) break;
        if (Date.now() > deadline) throw new Error(`owned service pid ${firstPid} survived app quit`);
        sleep(200);
      }
      const restart = spawn(nodeBinary, [serviceBundle, "--mock-workspace", ws], { env: {}, stdio: "ignore" });
      const lockDeadline = Date.now() + 20000;
      for (;;) {
        if (existsSync(join(ws, ".roledock", "owner-connection.json"))) break;
        if (Date.now() > lockDeadline) throw new Error("workspace lock not released after quit");
        sleep(200);
      }
      restart.kill("SIGTERM");
    } finally {
      app.close().catch(() => undefined);
    }
  });

  test("external service is attached, never killed; UI restart attaches to the same workspace", async () => {
    const ws = tempWorkspace();
    const external = spawnExternalService(ws);
    const firstInfo = await ownerInfo(ws);
    const firstId = firstInfo.workspace_id;
    const externalPid = firstInfo.service?.pid;
    expect(externalPid).toBeGreaterThan(0);
    expect(firstInfo.service?.adapter).toBe("mock");
    const userData = tempWorkspace();
    let app: ElectronApplication | undefined;
    try {
      app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
      const win = await app.firstWindow();
      await openViaDialog(win);
      const card = await waitStatusContains(win, `workspace_id：${firstId}`);
      expect(card).toContain("附着的外部服务");
      // G1-R04: the attached service reports its own pid via workspace.info.
      expect(card).toContain(`pid：${externalPid}`);
      // G1-R01: attach keeps a working owner client — diagnostics and the
      // confirm role list must function through the real IPC.
      await win.click("#diagnostics");
      await expect(win.locator("#diag")).toContainText(`workspace_id=${firstId}`, { timeout: 15000 });
      await expect(win.locator("#diag")).toContainText("adapter=mock");
      const roles = await win.evaluate(async () => {
        return (window as unknown as { roledock: { shell: { confirm: { listRoles: () => Promise<{ ok: boolean; result?: { roles: unknown[] } }> } } } }).roledock.shell.confirm.listRoles();
      });
      expect(roles.ok).toBe(true);
      await app.close();
      expect((await ownerInfo(ws)).workspace_id).toBe(firstId);

      // Second launch attaches the same live service — still one writer.
      app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
      const win2 = await app.firstWindow();
      await openViaDialog(win2);
      expect(await waitStatusContains(win2, `workspace_id：${firstId}`)).toContain("附着的外部服务");
      // G1-R01: refresh with the stored credential detects a dead endpoint.
      external.kill("SIGKILL");
      await win2.click("#refresh");
      await expect(win2.locator("#status .card")).toContainText("disconnected", { timeout: 15000 });
      await app.close();
    } finally {
      external.kill("SIGTERM");
      app?.close().catch(() => undefined);
    }
  });

  test("foreign or broken owner endpoints refused without overwrite; owned crash recovers", async () => {
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: "unused" });
    try {
      const win = await app.firstWindow();
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();

      // 1. Loose-permission owner file (0644): conflict, no overwrite.
      const loose = tempWorkspace();
      mkdirSync(join(loose, ".roledock"), { recursive: true });
      writeFileSync(join(loose, ".roledock", "owner-connection.json"), JSON.stringify({ socket_path: "/nonexistent.sock", token: "x" }));
      chmodSync(join(loose, ".roledock", "owner-connection.json"), 0o644);
      await openDirect(win, loose);
      await win.click("#refresh");
      await expect(win.locator("#status .card")).toContainText("权限过宽", { timeout: 15000 });

      // 2. Owner file whose "socket" is a regular file: the service's own
      // foreign-endpoint guard refuses the start — nothing is overwritten.
      const bogus = tempWorkspace();
      mkdirSync(join(bogus, ".roledock"), { recursive: true });
      writeFileSync(join(bogus, ".roledock", "service.sock"), "not a socket");
      writeFileSync(join(bogus, ".roledock", "owner-connection.json"), JSON.stringify({ socket_path: join(bogus, ".roledock", "service.sock"), token: "x" }));
      chmodSync(join(bogus, ".roledock", "owner-connection.json"), 0o600);
      await openDirect(win, bogus);
      await win.click("#refresh");
      await expect(win.locator("#status .card")).toContainText("non-socket file", { timeout: 30000 });
      expect(readFileSync(join(bogus, ".roledock", "service.sock"), "utf8")).toBe("not a socket");

      // 3. Owned service crashed (SIGKILL) → disconnected → re-opening the
      // SAME directory (not restart) starts a fresh service with the same
      // workspace_id and a NEW pid (G1-R02 signal-exit boundary).
      const ws = tempWorkspace();
      await openDirect(win, ws);
      await win.click("#refresh");
      const card = await waitStatusContains(win, "workspace_id：ws-");
      const pid = Number(card.match(/pid：(\d+)/)![1]);
      const firstId = card.match(/workspace_id：(ws-[0-9a-f]+)/)![1];
      process.kill(pid, "SIGKILL");
      await expect.poll(() => statusText(win), { timeout: 15000 }).toContain("disconnected");
      await openDirect(win, ws);
      await win.click("#refresh");
      const recovered = await waitStatusContains(win, "running（本应用启动）");
      expect(recovered).toContain(`workspace_id：${firstId}`);
      const newPid = Number(recovered.match(/pid：(\d+)/)![1]);
      expect(newPid).not.toBe(pid);
    } finally {
      app.close().catch(() => undefined);
    }
  });

  test("G1-R02: concurrent first opens of one directory share a single ready result", async () => {
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: "unused" });
    try {
      const win = await app.firstWindow();
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();
      const ws = tempWorkspace();
      const replies = await win.evaluate(async (dir: unknown) => {
        const open = (window as unknown as { roledock: { shell: { workspace: { open: (payload: unknown) => Promise<{ ok: boolean; result?: { state: string; pid: number | null; workspaceId: string | null } }> } } } }).roledock.shell.workspace.open;
        return Promise.all([open({ dir }), open({ dir })]);
      }, ws);
      // Both callers get the SAME final result — running, same pid — not an
      // intermediate "starting" snapshot from whichever resolved first.
      for (const reply of replies) {
        expect(reply.ok).toBe(true);
        expect(reply.result?.state).toBe("running");
        expect(reply.result?.workspaceId).toMatch(/^ws-/);
        expect(reply.result?.pid).toBeGreaterThan(0);
      }
      expect(replies[0]!.result!.pid).toBe(replies[1]!.result!.pid);
      expect(replies[0]!.result!.workspaceId).toBe(replies[1]!.result!.workspaceId);
    } finally {
      app.close().catch(() => undefined);
    }
  });

  test("unauthorized IPC is rejected and the bridge stays closed", async () => {
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData });
    try {
      const win = await app.firstWindow();
      const result = await win.evaluate(async () => {
        const bridge = (window as unknown as { roledock?: { shell?: Record<string, Record<string, unknown>> } }).roledock?.shell;
        const unknownMethod = (bridge?.workspace as Record<string, unknown> | undefined)?.["rpc"];
        // The bridge never throws: it resolves the reply envelope, so the
        // unauthorized-payload case is a structured error reply.
        const statusFn = (bridge?.workspace as Record<string, unknown> | undefined)?.["status"] as ((payload?: unknown) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
        const reply = await statusFn?.({ smuggled: true });
        return { unknownMethod, payloadRejection: reply?.error?.message ?? "", namespaces: Object.keys(bridge ?? {}).sort() };
      });
      expect(result.unknownMethod).toBeUndefined();
      expect(result.payloadRejection).toContain("不接受参数");
      expect(result.namespaces).toEqual(["app", "authorizations", "confirm", "inbox", "knowledge", "roles", "sessions", "settings", "workspace"]);
    } finally {
      app.close().catch(() => undefined);
    }
  });
});

test("G1-R03: relaunching after closing all windows restores the shell UI, same writer", async () => {
  const ws = tempWorkspace();
  const userData = tempWorkspace();
  const env = { ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws };
  const app = await launchShell(env);
  try {
    const win = await app.firstWindow();
    await openViaDialog(win);
    const card = await waitStatusContains(win, "workspace_id：ws-");
    const pid = Number(card.match(/pid：(\d+)/)![1]);
    const firstId = card.match(/workspace_id：(ws-[0-9a-f]+)/)![1];

    // Close all windows: the process stays alive with the owned service.
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
    await expect.poll(async () => (await ownerInfo(ws)).workspace_id, { timeout: 15000 }).toBe(firstId);

    // A fresh launch is refused by the single-instance lock — and must
    // restore the shell UI in the ORIGINAL process instead of just exiting.
    const second = spawnSync(join(packageRoot, "..", "..", "node_modules", ".bin", "electron"), [shellMain], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, ROLEDOCK_SHELL_NODE: nodeBinary, ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws },
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("shell-single-instance-refused");
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 20000 }).toBe(1);

    // The restored window shows the SAME writer (pid/workspace_id unchanged)
    // and owner RPC (diagnostics) works — no second service was started.
    const restored = await app.firstWindow();
    await expect(restored.locator("#status .card")).toContainText(`workspace_id：${firstId}`, { timeout: 30000 });
    const restoredCard = await statusText(restored);
    expect(restoredCard).toContain(`pid：${pid}`);
    await restored.click("#diagnostics");
    await expect(restored.locator("#diag")).toContainText(`workspace_id=${firstId}`, { timeout: 15000 });

    // Explicit quit still reaps the owned service.
    await app.close();
    const deadline = Date.now() + 20000;
    for (;;) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
      if (!alive) break;
      if (Date.now() > deadline) throw new Error(`owned service pid ${pid} survived final quit`);
      sleep(200);
    }
  } finally {
    app.close().catch(() => undefined);
  }
});
