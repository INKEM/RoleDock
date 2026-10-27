import { expect, test, _electron } from "@playwright/test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ServiceClient } from "@roledock/service";

const packageRoot = join(import.meta.dirname, "..", "..");
const nodeBinary = process.env.ROLEDOCK_PROBE_NODE ?? join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");
const shellMain = join(packageRoot, "dist-desktop", "shell", "main.mjs");
const customRoleDir = resolve("examples/custom-role");
const localZcodeCli = "/opt/ZCode/resources/glm/zcode.cjs";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "roledock-g2-e2e-"));
}

function spawnExternalService(dir: string): ChildProcess {
  const connector = join(packageRoot, "dist-desktop", "vendor", "zcode-connector.mjs");
  void connector;
  const child = spawn(nodeBinary, [join(packageRoot, "dist-desktop", "vendor", "service-bundle.mjs"), "--mock-workspace", dir], { env: {}, stdio: "ignore" });
  const credentialPath = join(dir, ".roledock", "owner-connection.json");
  const deadline = Date.now() + 20000;
  for (;;) {
    if (existsSync(credentialPath)) return child;
    if (Date.now() > deadline) throw new Error("external service not ready");
    sleep(200);
  }
}

async function ownerInfo(dir: string, timeoutMs = 5000): Promise<{ workspace_id: string; service?: { pid: number; adapter: string } }> {
  const credential = JSON.parse(readFileSync(join(dir, ".roledock", "owner-connection.json"), "utf8")) as { socket_path: string; token: string };
  return new ServiceClient(credential).call("workspace.info", {}, { timeoutMs });
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function launchShell(env: Record<string, string | undefined>): Promise<ElectronApplication> {
  return _electron.launch({ args: [shellMain], cwd: packageRoot, env: { ...process.env, ROLEDOCK_SHELL_NODE: nodeBinary, ...env } });
}

async function callIpc<T>(win: Page, namespace: string, method: string, payload?: unknown): Promise<T> {
  type Reply = { ok: boolean; result?: unknown; error?: { message: string } };
  const reply = await win.evaluate(async ({ namespace, method, payload }: { namespace: string; method: string; payload: unknown }) => {
    const shell = (window as unknown as { roledock?: { shell?: Record<string, Record<string, unknown>> } }).roledock?.shell;
    const entry = shell?.[namespace]?.[method] as ((payload?: unknown) => Promise<Reply>) | undefined;
    if (typeof entry !== "function") throw new Error(`no such method ${namespace}.${method}`);
    return entry(payload);
  }, { namespace, method, payload }) as Reply;
  if (!reply.ok) throw new Error(reply.error?.message ?? "ipc error");
  return reply.result as T;
}

async function statusText(win: Page): Promise<string> {
  return (await win.locator("#status .card").textContent()) ?? "";
}

test.describe("P6-G2 workspaces, preflight, roles and policy", () => {
  test("install custom role, inspect details, edit policy with read-back; recent list removable; no session entry", async () => {
    const ws = tempWorkspace();
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
    try {
      const win = await app.firstWindow();
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 30000 });

      // Install an arbitrary role pack from a directory — no CLI, no core changes.
      const installed = await callIpc<{ roles: Array<{ id: string; title: string; initialized: boolean }>; reinstalled: boolean }>(win, "roles", "install", { dir: customRoleDir });
      expect(installed.roles.map(role => role.id)).toContain("archivist");

      // Details: pack data, coordination state, requested vs granted.
      const details = await callIpc<{ role_id: string; instructions: string; pack: { content_hash: string }; initialized: boolean; current_instance_id: string | null; requested_capabilities: string[]; granted_capabilities: string[] }>(win, "roles", "get", { role_id: "archivist" });
      expect(details.role_id).toBe("archivist");
      expect(details.instructions.length).toBeGreaterThan(0);
      expect(details.pack.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(details.initialized).toBe(false);
      expect(details.current_instance_id).toBeNull();
      expect(details.requested_capabilities).toContain("documents.read");
      expect(details.granted_capabilities).toEqual([]);

      // Policy editing with read-back, per capability.
      await callIpc(win, "roles", "grant", { role_id: "archivist", capability: "documents.read" });
      const granted = await callIpc<{ granted_capabilities: string[] }>(win, "roles", "get", { role_id: "archivist" });
      expect(granted.granted_capabilities).toEqual(["documents.read"]);
      await callIpc(win, "roles", "revoke", { role_id: "archivist", capability: "documents.read" });
      const revoked = await callIpc<{ granted_capabilities: string[] }>(win, "roles", "get", { role_id: "archivist" });
      expect(revoked.granted_capabilities).toEqual([]);

      // The roles page provides no way to open a session (anchoring stays in G3).
      await win.evaluate(() => { location.hash = "#/roles"; });
      await expect(win.locator("#install")).toBeVisible();
      const pageText = (await win.locator("#page").textContent()) ?? "";
      expect(pageText).toContain("不会打开会话");
      expect(pageText).not.toContain("锚定此会话");

      // Recent workspaces: recorded on open; removal keeps the directory.
      let settings = await callIpc<{ recentWorkspaces: Array<{ path: string }> }>(win, "settings", "get");
      expect(settings.recentWorkspaces.map(item => item.path)).toContain(ws);
      settings = await callIpc<{ recentWorkspaces: Array<{ path: string }> }>(win, "workspace", "removeRecent", { path: ws });
      expect(settings.recentWorkspaces.map(item => item.path)).not.toContain(ws);
      expect(existsSync(ws)).toBe(true);
      // Re-entering the page re-reads from disk: the entry stays gone.
      await win.evaluate(() => { location.hash = "#/settings"; location.hash = "#/workspace"; });
      await expect(win.locator("#recent")).not.toContainText(ws, { timeout: 15000 });
    } finally {
      await app.close().catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test("real ZCode launcher branch (gated on local CLI) or honest restricted display", async () => {
    const cliAvailable = existsSync(localZcodeCli);
    test.info().annotations.push({ type: "info", description: `local ZCode CLI ${cliAvailable ? "present: real launch" : "absent: restricted display branch"}` });
    const ws = tempWorkspace();
    const userData = tempWorkspace();
    if (cliAvailable) {
      // Prefill the launcher configuration before launch.
      mkdirSync(userData, { recursive: true });
      writeFileSync(join(userData, "settings.json"), JSON.stringify({
        defaultWorkspaceDir: null,
        exitStopsOwnedServices: true,
        launcher: { kind: "zcode", cliPath: localZcodeCli, credentialHelper: null, provider: null, model: null, managedEgress: [] },
        recentWorkspaces: [],
      }));
    }
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
    let servicePid: number | null = null;
    try {
      const win = await app.firstWindow();
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();
      // Preflight is read-only and works without a workspace.
      const checks = await callIpc<Array<{ name: string; state: string; detail: string }>>(win, "workspace", "preflight");
      const byName = Object.fromEntries(checks.map(check => [check.name, check] as const));
      expect(byName.node_runtime!.state).toBe("ok");
      if (!cliAvailable) {
        // Honest restricted display without dependencies.
        expect(byName.zcode_cli!.state).toBe("missing");
        await win.click("#open-dir");
        await expect(win.locator("#open-error")).toContainText("ZCode CLI", { timeout: 15000 });
        return;
      }
      expect(byName.zcode_cli!.state).toBe("ok");
      await win.evaluate(() => { (document.getElementById("mode") as HTMLSelectElement).value = "zcode"; });
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 60000 });
      const card = await statusText(win);
      expect(card).toContain("模式：zcode");
      servicePid = Number(card.match(/pid：(\d+)/)![1]);
      // The real service runs the configured adapter; no session, no model turn.
      const diag = await callIpc<{ service: { adapter: string }; workspace_id: string }>(win, "workspace", "diagnostics");
      expect(diag.service.adapter).toBe("zcode");
      const roles = await callIpc<{ roles: unknown[] }>(win, "roles", "list");
      expect(Array.isArray(roles.roles)).toBe(true);

      // G2-R02: restart must keep the real launcher (never revert to mock).
      await win.click("#restart");
      await expect.poll(async () => {
        try { return (await callIpc<{ service: { adapter: string } }>(win, "workspace", "diagnostics")).service.adapter; }
        catch { return "pending"; }
      }, { timeout: 60000 }).toBe("zcode");
      await expect.poll(() => statusText(win), { timeout: 30000 }).toContain("模式：zcode");

      await win.click("#stop");
      await expect(win.locator("#status .card")).toContainText("尚未打开工作空间", { timeout: 20000 });
      servicePid = null;
    } finally {
      await app.close().catch(() => undefined);
      if (servicePid !== null) {
        const deadline = Date.now() + 15000;
        for (;;) {
          let alive = false;
          try { process.kill(servicePid, 0); alive = true; } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
          if (!alive) break;
          if (Date.now() > deadline) throw new Error("zcode service survived quit");
          sleep(200);
        }
      }
      rmSync(ws, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

void ServiceClient;

test("G2-R01: a directory whose endpoint belongs to another workspace is a conflict, no writes", async () => {
  const dirA = tempWorkspace();
  const dirB = tempWorkspace();
  const serviceA = spawnExternalService(dirA);
  const serviceB = spawnExternalService(dirB);
  const idA = (await ownerInfo(dirA)).workspace_id;
  const idB = (await ownerInfo(dirB)).workspace_id;
  expect(idA).not.toBe(idB);
  try {
    // Swap: A's endpoint file now points at B's live service. The identity
    // file persists across stops, so the mismatch is provable while both
    // services are live.
    const connectionB = readFileSync(join(dirB, ".roledock", "owner-connection.json"), "utf8");
    writeFileSync(join(dirA, ".roledock", "owner-connection.json"), connectionB);
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: dirA });
    try {
      const win = await app.firstWindow();
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("目录身份不匹配", { timeout: 20000 });
      await expect(win.locator("#status .card")).toContainText(idB);
      await expect(win.locator("#status .card")).toContainText("conflict");
      // Writes are stopped: installing through this view must fail.
      await expect(callIpc(win, "roles", "install", { dir: customRoleDir })).rejects.toThrow(/尚未打开工作空间|owner 连接/);
      // B's workspace was not polluted through the A view.
      const rolesB = await ownerInfo(dirB);
      expect(rolesB.workspace_id).toBe(idB);
    } finally {
      await app.close().catch(() => undefined);
    }
  } finally {
    serviceA.kill("SIGTERM");
    serviceB.kill("SIGTERM");
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("G2-R01(re): after a normal stop, a planted foreign endpoint is refused via the persisted identity", async () => {
  const dirA = tempWorkspace();
  const dirB = tempWorkspace();
  const serviceA = spawnExternalService(dirA);
  const serviceB = spawnExternalService(dirB);
  const idA = (await ownerInfo(dirA)).workspace_id;
  const idB = (await ownerInfo(dirB)).workspace_id;
  expect(idA).not.toBe(idB);
  try {
    // Normal stop of A: owner file removed, workspace-id KEPT on disk.
    serviceA.kill("SIGTERM");
    const deadline = Date.now() + 20000;
    for (;;) {
      if (!existsSync(join(dirA, ".roledock", "owner-connection.json"))) break;
      if (Date.now() > deadline) throw new Error("A did not stop in time");
      sleep(200);
    }
    sleep(500); // let the stopped process fully exit before asserting identity
    expect(existsSync(join(dirA, ".roledock", "workspace-id"))).toBe(true);
    // Plant B's live connection into A (mode 0600: the endpoint guard
    // requires an owned regular file).
    writeFileSync(join(dirA, ".roledock", "owner-connection.json"), readFileSync(join(dirB, ".roledock", "owner-connection.json"), "utf8"));
    chmodSync(join(dirA, ".roledock", "owner-connection.json"), 0o600);
    const userData = tempWorkspace();
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: dirA });
    try {
      const win = await app.firstWindow();
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("目录身份不匹配", { timeout: 20000 });
      await expect(win.locator("#status .card")).toContainText(idB);
      // Owner writes via this view are stopped; B stays untouched.
      await expect(callIpc(win, "roles", "install", { dir: customRoleDir })).rejects.toThrow(/尚未打开工作空间|owner 连接/);
      expect((await ownerInfo(dirB)).workspace_id).toBe(idB);
    } finally {
      await app.close().catch(() => undefined);
    }
  } finally {
    serviceA.kill("SIGKILL");
    serviceB.kill("SIGKILL");
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("G2-R02(re): a broken persisted launcher config fails loudly, never silently mocks", async () => {
  const ws = tempWorkspace();
  const userData = tempWorkspace();
  mkdirSync(join(userData), { recursive: true });
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    defaultWorkspaceDir: null,
    exitStopsOwnedServices: true,
    launcher: { kind: "zcode", cliPath: "/opt/ZCode/resources/glm/zcode.cjs", credentialHelper: null, provider: null, model: null, managedEgress: [] },
    recentWorkspaces: [],
  }));
  const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
  try {
    const win = await app.firstWindow();
    await win.evaluate(() => { location.hash = "#/workspace"; });
    await expect(win.locator("#open-dir")).toBeVisible();
    // Establish a real zcode workspace first.
    await win.evaluate(() => { (document.getElementById("mode") as HTMLSelectElement).value = "zcode"; });
    await win.click("#open-dir");
    await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 60000 });
    await win.click("#stop");
    await expect(win.locator("#status .card")).toContainText("尚未打开工作空间", { timeout: 20000 });
    // Corrupt the persisted reference: replace with a symlink to a scratch file.
    const target = join(ws, "scratch.txt");
    writeFileSync(target, "SYNTHETIC_SENTINEL");
    rmSync(join(ws, ".roledock", "launcher-config.json"));
    symlinkSync(target, join(ws, ".roledock", "launcher-config.json"));
    // Re-open WITHOUT an explicit launcher (the recent-list/restart path —
    // direct IPC, like the recent list uses). The persisted reference is
    // broken, so the open must fail loudly and start nothing.
    const reply = await win.evaluate(async (dir: unknown) => {
      const shell = (window as unknown as { roledock: { shell: { workspace: { open: (payload: unknown) => Promise<{ ok: boolean; result?: { state: string; error: string | null; mode: string | null } }> } } } }).roledock.shell.workspace;
      return shell.open({ dir });
    }, ws);
    expect(reply.ok).toBe(true);
    expect(reply.result?.state).toBe("error");
    expect(reply.result?.mode).toBeNull();
    expect(reply.result?.error ?? "").toContain("持久化启动配置不可用");
    // The link and its target are untouched; no mock service was started.
    expect(readFileSync(target, "utf8")).toBe("SYNTHETIC_SENTINEL");
    expect(lstatSync(join(ws, ".roledock", "launcher-config.json")).isSymbolicLink()).toBe(true);
    await expect.poll(() => existsSync(join(ws, ".roledock", "service.sock")), { timeout: 10000 }).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(ws, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});
