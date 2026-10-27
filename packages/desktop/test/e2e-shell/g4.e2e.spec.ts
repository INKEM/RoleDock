import { expect, test, _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ServiceClient } from "@roledock/service";

/**
 * P6-G4 session observability over the real shell, real service and real MCP
 * stdio clients — ZERO model turns (mock workspace adapter confirms the
 * material load offline). Anchored chain (G3 flow) observed through the G4
 * owner read views: generation timeline, connection vs role validity shown
 * separately, double authorization, service restart + re-registration with an
 * UNCHANGED generation, and the revoke surface (preview first, then the
 * explicit revoke; release stays with the original session).
 */
const packageRoot = join(import.meta.dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const nodeBinary = process.env.ROLEDOCK_PROBE_NODE ?? join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");
const shellMain = join(packageRoot, "dist-desktop", "shell", "main.mjs");
const mcpBin = join(packageRoot, "..", "mcp", "dist", "bin.js");
const demoTeamDir = join(repoRoot, "examples", "demo-team");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
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

interface McpToolReply { ok: boolean; result?: { attempt?: { state: string }; binding?: { state: string; generation: number; role_id: string } | null; authorizations?: Array<{ authorization_id: string; expires_at: string }> } }

/** A real MCP stdio client playing the original session's Agent (fresh process per credential refresh). */
async function agentClient(envFile: string): Promise<{ call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: McpToolReply["result"]; errorText: string }>; close(): Promise<void> }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpBin], env: { ...process.env, ROLEDOCK_CREDENTIAL_FILE: envFile } as Record<string, string> });
  const client = new Client({ name: "roledock-g4-e2e-agent", version: "0.1.0-alpha.0" });
  await client.connect(transport);
  return {
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

test.describe("P6-G4 session observability, revoke surface and restart restoration", () => {
  test("anchor → GUI timeline → double authorization → restart keeps generation → revoke preview → revoked display", async () => {
    test.setTimeout(240_000);
    const ws = tempDir("roledock-g4-e2e-");
    const userData = tempDir("roledock-g4-user-");
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
    const envFile = join(ws, ".roledock", "mcp-session.env");
    // Opt-in evidence capture (docs/phase-reports/evidence/…-p6-g4): set
    // ROLEDOCK_G4_EVIDENCE_DIR to persist GUI screenshots of the run.
    const evidenceDir = process.env.ROLEDOCK_G4_EVIDENCE_DIR;
    try {
      const win = await app.firstWindow();
      const shot = async (name: string) => { if (evidenceDir) await win.screenshot({ path: join(evidenceDir, name), fullPage: true }); };
      // 1. Open the mock workspace, install the role, grant, register and confirm (G3 flow).
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 30000 });
      await callIpc(win, "roles", "install", { dir: demoTeamDir });
      await callIpc(win, "roles", "grant", { role_id: "builder", capability: "documents.read" });
      await win.evaluate(() => { location.hash = "#/confirm"; });
      await win.click("#discover");
      const row = win.locator("#discover-area tr", { hasText: "mock-desktop-original" });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.locator("button[data-host]").click();
      await expect(win.locator("#log")).toContainText("已登记 ext-", { timeout: 20000 });
      const sessionRow = win.locator("#sessions tbody tr", { hasText: "mock-desktop-original" });
      await expect(sessionRow).toBeVisible();
      await sessionRow.locator("button").click();
      await expect(win.locator("#log")).toContainText("已确认 event_ref=gui-", { timeout: 15000 });

      // 2. Bridge advances; the Agent anchors explicitly over MCP.
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ events: Array<{ authorization: { authorization_id: string } | null }> }> }>(win, "confirm", "confirmations", { limit: 50 });
        return page.items.some(item => item.events.some(event => event.authorization !== null)) ? "authorized" : "pending";
      }, { timeout: 25000 }).toBe("authorized");
      let agent = await agentClient(envFile);
      let authorizationId = "";
      try {
        const offered = await agent.call("authorizations.get", {});
        authorizationId = offered.payload?.authorizations?.[0]!.authorization_id ?? "";
        expect(authorizationId).toBeTruthy();
        const anchor = await agent.call("sessions.anchor", { authorization_id: authorizationId, idempotency_key: "g4-shell-e2e" });
        expect(anchor.isError).toBe(false);
        expect(anchor.payload?.binding).toMatchObject({ state: "active", generation: 1, role_id: "builder" });
      } finally {
        await agent.close().catch(() => undefined);
      }

      // 3. The G4 observability block: connection and role validity shown
      //    SEPARATELY; generation timeline, attempts and loads with observed_at.
      await expect(win.locator("#observability")).toContainText("有权工作（active）", { timeout: 20000 });
      await expect(win.locator("#observability")).toContainText("连接：服务 running");
      await expect(win.locator("#observability")).toContainText("代次 1");
      await expect(win.locator("#observability")).toContainText("知识版本 r0");
      await expect(win.locator("#observability")).toContainText("锚定尝试");
      await expect(win.locator("#observability")).toContainText("已确认 v1");
      await expect(win.locator("#observability")).toContainText("载入记录");
      await expect(win.locator("#observability")).toContainText("观察时间：");
      const bindingsBefore = await callIpc<{ items: Array<{ state: string; effective_state: string; generation: number; state_changed_at: string | null; capabilities: string[] }> }>(win, "sessions", "listBindings", {});
      expect(bindingsBefore.items).toHaveLength(1);
      expect(bindingsBefore.items[0]).toMatchObject({ state: "active", effective_state: "active", generation: 1 });
      expect(bindingsBefore.items[0]!.state_changed_at).toBeTruthy();
      expect(bindingsBefore.items[0]!.capabilities).toContain("documents.read");
      const attemptsView = await callIpc<{ items: Array<{ state: string; confirmation: { load_version: number } | null }> }>(win, "sessions", "listAttempts", {});
      expect(attemptsView.items[0]).toMatchObject({ state: "active", confirmation: { load_version: 1 } });
      await shot("gui-01-active-timeline.png");

      // 4. Double authorization: the GUI deliberately REFUSES a second
      //    confirmation while one is live (confirm.ts guard — revoke first or
      //    use a new conversation). The coexisting 8h takeover authorization
      //    is written through the owner face (submitHumanEvent, cli-console
      //    entry) and advanced by the trusted bridge — the G3 leftover state
      //    "双授权并存" that the G4 revoke surface must handle.
      const owner = new ServiceClient(JSON.parse(readFileSync(join(ws, ".roledock", "owner-connection.json"), "utf8")) as { socket_path: string; token: string });
      const externalId = (await callIpc<{ items: Array<{ external_session_id: string }> }>(win, "confirm", "confirmations", { limit: 50 })).items[0]!.external_session_id;
      await owner.call("authorizations.submitHumanEvent", {
        external_session_id: externalId, host_session_id: "mock-desktop-original", connection_subject: "desktop-event-bridge",
        event_ref: "gui-g4e2e-8h-takeover", actor_id: "owner", role_id: "builder", capabilities: ["documents.read"], inherit: "takeover",
        expires_at: new Date(Date.now() + 8 * 3_600_000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString(),
      });
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ external_session_id: string; events: Array<{ authorization: { authorization_id: string } | null }> }> }>(win, "confirm", "confirmations", { limit: 50 });
        const entry = page.items.find(item => item.external_session_id === externalId);
        return entry && entry.events.length >= 2 && entry.events.every(event => event.authorization !== null) ? "two-live" : "pending";
      }, { timeout: 25000 }).toBe("two-live");

      // 5. Service restart + re-registration: the binding is restored with the
      //    SAME generation; a fresh MCP process (refreshed credential file) sees it.
      await callIpc(win, "workspace", "restart");
      await expect.poll(async () => (await callIpc<{ state: string }>(win, "workspace", "status")).state, { timeout: 30000 }).toBe("running");
      await expect.poll(async () => existsSync(envFile), { timeout: 10000 }).toBe(true);
      const registered = await callIpc<{ external_session_id: string; envFile: string }>(win, "confirm", "registerSession", { host_session_id: "mock-desktop-original" });
      expect(registered.envFile).toBe(envFile);
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ binding: { state: string; generation: number } | null }> }>(win, "confirm", "confirmations", { limit: 50 });
        return page.items[0]?.binding?.state === "active" ? "restored" : "pending";
      }, { timeout: 25000 }).toBe("restored");
      const bindingsAfterRestart = await callIpc<{ items: Array<{ state: string; generation: number }> }>(win, "sessions", "listBindings", {});
      expect(bindingsAfterRestart.items[0]).toMatchObject({ state: "active", generation: 1 });
      agent = await agentClient(envFile);
      try {
        const offered = await agent.call("authorizations.get", {});
        expect(offered.payload?.authorizations?.map(item => item.authorization_id)).toContain(authorizationId);
        expect(offered.payload?.authorizations).toHaveLength(2);
        const binding = await agent.call("sessions.binding", {});
        expect(binding.payload?.binding).toMatchObject({ state: "active", generation: 1 });
      } finally {
        await agent.close().catch(() => undefined);
      }

      // 6. Revoke surface: preview first (read-only), then the explicit revoke.
      //    Revoking the anchoring authorization invalidates the binding; the
      //    second (8h takeover) authorization's record stays untouched.
      await win.locator(`button[data-preview-auth="${authorizationId}"]`).click();
      const previewArea = win.locator(`#revoke-area [data-revoke="${authorizationId}"]`);
      await expect(previewArea).toContainText("撤销影响预览");
      await expect(previewArea).toContainText("将失效的绑定");
      await expect(previewArea).toContainText("代次 1");
      await expect(previewArea).toContainText("将撤权的委派请求");
      // Preview is read-only: the binding is still active after opening it.
      expect((await callIpc<{ items: Array<{ state: string }> }>(win, "sessions", "listBindings", {})).items[0]!.state).toBe("active");
      await previewArea.locator("button[data-confirm-revoke]").click();
      await expect(win.locator("#log")).toContainText(`已撤销 ${authorizationId}`, { timeout: 15000 });

      // 7. Revoked ≠ disconnected: the connection line stays "running" while the
      //    validity line shows revoked with the recovery next step.
      const validityBlock = win.locator("#observability .chain", { hasText: "已撤销（revoked）" });
      await expect(validityBlock).toBeVisible({ timeout: 20000 });
      await expect(validityBlock).toContainText("连接：服务 running");
      await expect(validityBlock).toContainText("撤销已在 RoleDock 生效；外部会话进程是否结束以宿主为准");
      const bindingsAfterRevoke = await callIpc<{ items: Array<{ state: string; effective_state: string; generation: number }> }>(win, "sessions", "listBindings", {});
      expect(bindingsAfterRevoke.items[0]).toMatchObject({ state: "revoked", effective_state: "revoked", generation: 1 });
      // The generation history is intact — no row was rewritten or dropped.
      expect((await callIpc<{ items: Array<{ state: string; authorization: { revoked_at: string | null } | null }> }>(win, "sessions", "listAttempts", {})).items).toHaveLength(1);
      // The coexisting 8h takeover authorization is untouched by the revocation;
      // only the anchoring authorization died with its binding.
      agent = await agentClient(envFile);
      try {
        const afterRevoke = await agent.call("authorizations.get", {});
        expect(afterRevoke.payload?.authorizations?.map(item => item.authorization_id)).not.toContain(authorizationId);
        expect(afterRevoke.payload?.authorizations).toHaveLength(1);
      } finally {
        await agent.close().catch(() => undefined);
      }
      // No owner release surface exists (§5.2): the vocabulary test locks it.
      await shot("gui-02-revoked-connection-split.png");
    } finally {
      await app.close().catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
