import { expect, test, _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * P6-G6 request inbox over the real shell, real service and real MCP stdio
 * clients — ZERO model turns (mock adapter). Both primaries are anchored
 * (builder initiator, reviewer target); a request auto-executes through the
 * service worker; the GUI shows the completed request with its real artifact,
 * the adoption guidance, the honest terminal-refusal, and the cleanup view.
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
  if (!reply.ok) {
    const error = new Error(`${reply.error?.code ?? "ipc"}: ${reply.error?.message ?? "error"}`);
    (error as Error & { code?: string }).code = reply.error?.code;
    throw error;
  }
  return reply.result as T;
}

interface McpToolReply { ok: boolean; result?: { attempt?: { state: string }; binding?: { state: string; generation: number } | null; authorizations?: Array<{ authorization_id: string }>; request_id?: string; entries?: Array<{ entry_id: string; artifact_id: string; state: string; owner_role_id: string; request_id?: string }>; revision?: number } }

type McpAgent = { call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: McpToolReply["result"]; errorText: string }>; close(): Promise<void> };

/** An MCP stdio client with EXPLICIT env credentials (for the initiator whose env file was overwritten by the later registration). */
async function agentClientWithEnv(socketPath: string, token: string): Promise<McpAgent> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpBin], env: { ...process.env, ROLEDOCK_SERVICE_SOCKET: socketPath, ROLEDOCK_SESSION_TOKEN: token } as Record<string, string> });
  const client = new Client({ name: "roledock-g6-e2e-agent", version: "0.1.0-alpha.0" });
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

async function agentClientWithFile(envFile: string): Promise<McpAgent> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpBin], env: { ...process.env, ROLEDOCK_CREDENTIAL_FILE: envFile } as Record<string, string> });
  const client = new Client({ name: "roledock-g6-e2e-agent", version: "0.1.0-alpha.0" });
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

function parseEnvFile(content: string): { socket: string; token: string } {
  const socket = content.match(/^ROLEDOCK_SERVICE_SOCKET=(.*)$/m)![1]!;
  const token = content.match(/^ROLEDOCK_SESSION_TOKEN=(.*)$/m)![1]!;
  return { socket, token };
}

test.describe("P6-G6 request inbox", () => {
  test("anchor both primaries → request auto-executes → GUI shows result, adoption guidance, honest refusal, cleanup", async () => {
    test.setTimeout(240_000);
    const ws = tempDir("roledock-g6-e2e-");
    const userData = tempDir("roledock-g6-user-");
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws });
    const envFile = join(ws, ".roledock", "mcp-session.env");
    // Opt-in evidence capture (docs/phase-reports/evidence/…-p6-g6).
    const evidenceDir = process.env.ROLEDOCK_G6_EVIDENCE_DIR;
    try {
      const win = await app.firstWindow();
      const shot = async (name: string) => { if (evidenceDir) await win.screenshot({ path: join(evidenceDir, name), fullPage: true }); };
      // 1. Workspace, roles, grants.
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 30000 });
      await callIpc(win, "roles", "install", { dir: demoTeamDir });
      for (const [role, capability] of [["builder", "documents.read"], ["builder", "requests.create"], ["builder", "requests.read"], ["reviewer", "documents.read"], ["reviewer", "requests.execute"], ["reviewer", "requests.read"], ["reviewer", "artifacts.read"]]) {
        await callIpc(win, "roles", "grant", { role_id: role, capability });
      }
      await win.evaluate(() => { location.hash = "#/confirm"; });
      await win.click("#discover");

      // 2. Register + confirm + bridge-advance + anchor the BUILDER on the first fixture.
      const discoverRows = win.locator("#discover-area tr");
      await expect(discoverRows.first()).toBeVisible({ timeout: 20000 });
      const builderRow = win.locator("#discover-area tr", { hasText: "mock-desktop-original" });
      await builderRow.locator("button[data-host]").click();
      await expect(win.locator("#log")).toContainText("已登记 ext-", { timeout: 20000 });
      const builderEnv = readFileSync(envFile, "utf8"); // capture BEFORE the second registration overwrites it (ADR-0014 v1 semantics)
      const sessionRow = win.locator("#sessions tbody tr", { hasText: "mock-desktop-original" });
      await sessionRow.locator("button").click();
      await expect(win.locator("#log")).toContainText("已确认 event_ref=gui-", { timeout: 15000 });
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ external_session_id: string; host_session_id: string; events: Array<{ authorization: { authorization_id: string } | null }> }> }>(win, "confirm", "confirmations", { limit: 50 });
        return page.items.some(item => item.host_session_id === "mock-desktop-original" && item.events.some(event => event.authorization !== null)) ? "authorized" : "pending";
      }, { timeout: 25000 }).toBe("authorized");
      const builderAgent = await agentClientWithEnv(parseEnvFile(builderEnv).socket, parseEnvFile(builderEnv).token);
      try {
        const offered = await builderAgent.call("authorizations.get", {});
        const authorizationId = offered.payload?.authorizations?.[0]!.authorization_id ?? "";
        const anchor = await builderAgent.call("sessions.anchor", { authorization_id: authorizationId, idempotency_key: "g6-builder" });
        expect(anchor.payload?.binding).toMatchObject({ state: "active", generation: 1, role_id: "builder" });
      } finally {
        await builderAgent.close().catch(() => undefined);
      }

      // 3. Register + confirm + anchor the REVIEWER on the second fixture
      //    (the credential file now points at the reviewer — v1 semantics).
      await win.click("#discover");
      const reviewerRow = win.locator("#discover-area tr", { hasText: "mock-desktop-second" });
      await expect(reviewerRow).toBeVisible({ timeout: 20000 });
      await reviewerRow.locator("button[data-host]").click();
      await expect(win.locator("#log")).toContainText("已登记 ext-", { timeout: 20000 });
      const reviewerSessionRow = win.locator("#sessions tbody tr", { hasText: "mock-desktop-second" });
      // The confirm row defaults to the first role (builder, already anchored):
      // this conversation initializes the REVIEWER role instead.
      await reviewerSessionRow.locator(".role").selectOption("reviewer");
      // The role's REQUESTED caps lack requests.execute; the authorization must
      // carry it for delegated execution (policy grant alone is not enough).
      await reviewerSessionRow.locator(".caps").fill("documents.read,requests.execute,requests.read,artifacts.read");
      await reviewerSessionRow.locator("button").click();
      await expect(win.locator("#log")).toContainText("已确认 event_ref=gui-", { timeout: 15000 });
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ host_session_id: string; events: Array<{ authorization: { authorization_id: string } | null }> }> }>(win, "confirm", "confirmations", { limit: 50 });
        return page.items.some(item => item.host_session_id === "mock-desktop-second" && item.events.some(event => event.authorization !== null)) ? "authorized" : "pending";
      }, { timeout: 25000 }).toBe("authorized");
      const reviewerAgent = await agentClientWithFile(envFile);
      try {
        const offered = await reviewerAgent.call("authorizations.get", {});
        const authorizationId = offered.payload?.authorizations?.[0]!.authorization_id ?? "";
        const anchor = await reviewerAgent.call("sessions.anchor", { authorization_id: authorizationId, idempotency_key: "g6-reviewer" });
        expect(anchor.payload?.binding).toMatchObject({ state: "active", generation: 1, role_id: "reviewer" });
      } finally {
        await reviewerAgent.close().catch(() => undefined);
      }

      // 4. The builder creates the request; the service worker auto-executes it.
      const builderAgent2 = await agentClientWithEnv(parseEnvFile(builderEnv).socket, parseEnvFile(builderEnv).token);
      let requestId = "";
      try {
        const created = await builderAgent2.call("requests.create", { target_role_id: "reviewer", question: "G6 E2E:需要真实答案的问题", idempotency_key: "g6-e2e-r1", read_exception_rationale: "No published target documents" });
        expect(created.isError, created.errorText).toBe(false);
        requestId = created.payload?.request_id ?? "";
        expect(requestId).toBeTruthy();
      } finally {
        await builderAgent2.close().catch(() => undefined);
      }

      // 5. GUI inbox: the completed request with its REAL artifact.
      await win.evaluate(() => { location.hash = "#/inbox"; });
      const requestRow = win.locator("#requests tr", { hasText: requestId.slice(0, 10) });
      await expect(requestRow).toBeVisible({ timeout: 30000 });
      await expect(requestRow).toContainText("completed");
      await requestRow.click();
      const detailBlock = win.locator("#detail .chain");
      await expect(detailBlock).toContainText("G6 E2E:需要真实答案的问题");
      await expect(detailBlock).toContainText("documents.publish(adopt_artifact_id=");
      await detailBlock.locator("button[data-artifact]").click();
      await expect(win.locator("#artifact-body")).toContainText("由 reviewer 产出", { timeout: 15000 });
      // Terminal refusal is shown honestly: no cancel control, explicit hint.
      await expect(detailBlock).toContainText("终态 completed");
      await expect(detailBlock.locator("#cancel")).toHaveCount(0);
      // Cleanup view: the completed request reclaimed without error.
      await expect(win.locator("#cleanup")).toContainText("回收完成", { timeout: 20000 });
      await shot("gui-01-inbox-page.png");

      // 6. The target role's own inbox via the session tool (MCP inbox_list).
      const reviewerAgent2 = await agentClientWithFile(envFile);
      try {
        const inbox = await reviewerAgent2.call("inbox.list", {});
        expect(inbox.isError).toBe(false);
        expect(inbox.payload?.entries?.some(entry => entry.request_id === requestId || entry.artifact_id)).toBeTruthy();
      } finally {
        await reviewerAgent2.close().catch(() => undefined);
      }
    } finally {
      await app.close().catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
