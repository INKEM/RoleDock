import { expect, test, _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ServiceClient } from "@roledock/service";

/**
 * P6-G3 full confirmation chain over the real shell, real service and a real
 * MCP stdio client — ZERO model turns (mock workspace adapter confirms the
 * material load offline). GUI click → human event → trusted bridge advance →
 * Agent anchor in "its" session → active binding visible in the GUI.
 */
const packageRoot = join(import.meta.dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const nodeBinary = process.env.ROLEDOCK_PROBE_NODE ?? join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");
const shellMain = join(packageRoot, "dist-desktop", "shell", "main.mjs");
const mcpBin = join(packageRoot, "..", "mcp", "dist", "bin.js");
// O3 (P6-G3 review): anchor the fixture at this file's location — the spec
// must not depend on the shell process cwd.
const demoTeamDir = join(repoRoot, "examples", "demo-team");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function launchShell(env: Record<string, string | undefined>): Promise<ElectronApplication> {
  return _electron.launch({ args: [shellMain], cwd: packageRoot, env: { ...process.env, ROLEDOCK_SHELL_NODE: nodeBinary, ...env } });
}

async function callIpc<T>(win: Page, namespace: string, method: string, payload?: unknown): Promise<T> {
  type Reply = { ok: boolean; result?: unknown; error?: { code?: string; message?: string } };
  const reply = await win.evaluate(async ({ namespace, method, payload }: { namespace: string; method: string; payload: unknown }) => {
    const shell = (window as unknown as { roledock?: { shell?: Record<string, Record<string, unknown>> } }).roledock?.shell;
    const entry = shell?.[namespace]?.[method] as ((payload?: unknown) => Promise<Reply>) | undefined;
    if (typeof entry !== "function") throw new Error(`no such method ${namespace}.${method}`);
    return entry(payload);
  }, { namespace, method, payload }) as Reply;
  if (!reply.ok) throw new Error(`${reply.error?.code ?? "ipc"}: ${reply.error?.message ?? "error"}`);
  return reply.result as T;
}

interface McpToolReply { ok: boolean; result?: { attempt?: { state: string; error?: { code: string; message: string } | null }; binding?: { state: string; generation: number; role_id: string } | null; authorizations?: Array<{ authorization_id: string }> } }

/** A real MCP stdio client playing the original session's Agent, authorized through the credential file. */
async function agentClient(envFile: string): Promise<{ client: Client; call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: McpToolReply["result"]; errorText: string }>; close(): Promise<void> }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpBin], env: { ...process.env, ROLEDOCK_CREDENTIAL_FILE: envFile } as Record<string, string> });
  const client = new Client({ name: "roledock-g3-e2e-agent", version: "0.1.0-alpha.0" });
  await client.connect(transport);
  return {
    client,
    async call(name, args) {
      const reply = await client.callTool({ name, arguments: args });
      const text = Array.isArray(reply.content) && reply.content[0]?.type === "text" && typeof reply.content[0].text === "string" ? reply.content[0].text : "";
      let payload: McpToolReply["result"];
      try { payload = (JSON.parse(text) as { result?: McpToolReply["result"] }).result; } catch { payload = undefined; }
      return { isError: reply.isError === true, payload, errorText: text };
    },
    async close() { await client.close(); },
  };
}

test.describe("P6-G3 original session authorization and explicit anchoring", () => {
  test("GUI click → event → trusted advance → Agent anchor → active binding, no duplicate under double actions", async () => {
    const ws = tempDir("roledock-g3-e2e-");
    const userData = tempDir("roledock-g3-user-");
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
    try {
      const win = await app.firstWindow();
      // 1. Open the mock workspace through the real UI.
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await expect(win.locator("#open-dir")).toBeVisible();
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 30000 });
      // 2. Install the demo role and grant its key capability (GUI policy flow).
      await callIpc(win, "roles", "install", { dir: demoTeamDir });
      await callIpc(win, "roles", "grant", { role_id: "builder", capability: "documents.read" });

      // 3. Discovery shows the desktop-bridge fixture session; register it.
      await win.evaluate(() => { location.hash = "#/confirm"; });
      await expect(win.locator("#discover")).toBeVisible();
      await win.click("#discover");
      const row = win.locator("#discover-area tr", { hasText: "mock-desktop-original" });
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row).not.toContainText("已登记");
      await row.locator("button[data-host]").click();
      await expect(win.locator("#log")).toContainText("已登记 ext-", { timeout: 20000 });
      const envFile = join(ws, ".roledock", "mcp-session.env");
      await expect.poll(() => existsSync(envFile), { timeout: 10000 }).toBe(true);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(envFile, "utf8")).toContain("ROLEDOCK_SESSION_TOKEN=");

      // 4. Confirm through the real page; double click must not double-submit.
      const sessionRow = win.locator("#sessions tbody tr", { hasText: "mock-desktop-original" });
      await expect(sessionRow).toBeVisible();
      await expect(sessionRow.locator(".diff")).toContainText("documents.read（已授予）");
      const confirmButton = sessionRow.locator("button");
      await confirmButton.click();
      await confirmButton.click({ force: true }); // second click lands while disabled
      await expect(win.locator("#log")).toContainText("已确认 event_ref=gui-", { timeout: 15000 });

      // 5. The trusted bridge advances the event to an authorization (≤ 2 ticks).
      let externalId = "";
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ external_session_id: string; events: Array<{ authorization: { authorization_id: string } | null }> }>; }>(win, "confirm", "confirmations", { limit: 50 });
        const entry = page.items.find(item => item.events.some(event => event.authorization !== null));
        if (entry) externalId = entry.external_session_id;
        return entry ? "authorized" : "pending";
      }, { timeout: 25000 }).toBe("authorized");
      expect(externalId).toMatch(/^ext-/);
      const page = await callIpc<{ items: Array<{ external_session_id: string; events: unknown[]; anchor_attempt: { state: string } | null; binding: { state: string; generation: number } | null }> }>(win, "confirm", "confirmations", { external_session_id: externalId });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.events).toHaveLength(1); // double click produced ONE event

      // 6. The Agent in the ORIGINAL session anchors explicitly over MCP.
      const agent = await agentClient(envFile);
      let authorizationId = "";
      try {
        const offered = await agent.call("authorizations.get", {});
        expect(offered.isError).toBe(false);
        authorizationId = offered.payload?.authorizations?.[0]!.authorization_id ?? "";
        expect(authorizationId).toBeTruthy();
        const anchor = await agent.call("sessions.anchor", { authorization_id: authorizationId, idempotency_key: "g3-shell-e2e" });
        expect(anchor.isError).toBe(false);
        expect(anchor.payload?.attempt?.state).toBe("active");
        expect(anchor.payload?.binding).toMatchObject({ state: "active", generation: 1, role_id: "builder" });
        // A second anchor on a bound conversation is refused honestly.
        const again = await agent.call("sessions.anchor", { authorization_id: authorizationId, idempotency_key: "g3-shell-e2e-2" });
        expect(again.isError).toBe(true);
        expect(again.errorText).toContain("INVALID_STATE_TRANSITION");
      } finally {
        await agent.close().catch(() => undefined);
      }

      // 7. The GUI progress chain shows active binding, generation 1; the session
      //    list shows the live authorization; page reload keeps one event, one binding.
      await expect.poll(async () => (await win.locator("#chains").textContent()) ?? "", { timeout: 20000 }).toContain("active · 角色 builder @ 代次 1");
      const sessionsAfter = await callIpc<{ external_sessions: Array<{ session: { external_session_id: string }; active_authorization: { role_id: string } | null }> }>(win, "confirm", "listSessions");
      expect(sessionsAfter.external_sessions.find(item => item.session.external_session_id === externalId)?.active_authorization?.role_id).toBe("builder");
      await win.evaluate(() => { location.hash = "#/workspace"; location.hash = "#/confirm"; });
      await expect(win.locator("#chains")).toContainText("代次 1", { timeout: 20000 });
      const reloaded = await callIpc<{ items: Array<{ events: unknown[]; binding: { state: string } | null }> }>(win, "confirm", "confirmations", { external_session_id: externalId });
      expect(reloaded.items[0]!.events).toHaveLength(1);
      expect(reloaded.items[0]!.binding?.state).toBe("active");

      // 8. Bridge status is observable (diagnostics parity, no silent failures).
      const bridge = await callIpc<{ running: boolean; advanced: number; lastError: string | null }>(win, "confirm", "bridgeStatus");
      expect(bridge.running).toBe(true);
      expect(bridge.advanced).toBeGreaterThanOrEqual(1);
      expect(bridge.lastError).toBeNull();
    } finally {
      await app.close().catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

void ServiceClient;
