import { expect, test, _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * P6-G5 role knowledge over the real shell, real service and a real MCP stdio
 * client — ZERO model turns (mock workspace adapter). Publishing/proposeing
 * happens in the ORIGINAL session through the Agent (session tools); the GUI
 * only OBSERVES: directory, on-demand bodies per the visibility matrix,
 * candidates, export (files copied to the fixture dir) and import (candidates
 * only, never publications).
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

interface McpToolReply { ok: boolean; result?: { attempt?: { state: string }; binding?: { state: string; generation: number } | null; authorizations?: Array<{ authorization_id: string }>; revision?: number; candidate_id?: string } }

async function agentClient(envFile: string): Promise<{ call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: McpToolReply["result"]; errorText: string }>; close(): Promise<void> }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpBin], env: { ...process.env, ROLEDOCK_CREDENTIAL_FILE: envFile } as Record<string, string> });
  const client = new Client({ name: "roledock-g5-e2e-agent", version: "0.1.0-alpha.0" });
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

test.describe("P6-G5 role knowledge page", () => {
  test("anchor → publish → GUI directory/body → candidate visible → export/import create candidates only", async () => {
    test.setTimeout(240_000);
    const ws = tempDir("roledock-g5-e2e-");
    const userData = tempDir("roledock-g5-user-");
    const exportDir = tempDir("roledock-g5-export-");
    const app = await launchShell({ ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: ws, ROLEDOCK_SHELL_EXPORT_FIXTURE: exportDir, ROLEDOCK_SHELL_IMPORT_FIXTURE: exportDir });
    const envFile = join(ws, ".roledock", "mcp-session.env");
    // Opt-in evidence capture (docs/phase-reports/evidence/…-p6-g5): set
    // ROLEDOCK_G5_EVIDENCE_DIR to persist GUI screenshots of the run.
    const evidenceDir = process.env.ROLEDOCK_G5_EVIDENCE_DIR;
    try {
      const win = await app.firstWindow();
      const shot = async (name: string) => { if (evidenceDir) await win.screenshot({ path: join(evidenceDir, name), fullPage: true }); };
      // 1. Open the mock workspace, install the role, grant, register, confirm (G3 flow).
      await win.evaluate(() => { location.hash = "#/workspace"; });
      await win.click("#open-dir");
      await expect(win.locator("#status .card")).toContainText("workspace_id：ws-", { timeout: 30000 });
      await callIpc(win, "roles", "install", { dir: demoTeamDir });
      await callIpc(win, "roles", "grant", { role_id: "builder", capability: "documents.read" });
      await callIpc(win, "roles", "grant", { role_id: "builder", capability: "documents.propose" });
      await callIpc(win, "roles", "grant", { role_id: "builder", capability: "documents.publish" });
      await win.evaluate(() => { location.hash = "#/confirm"; });
      await win.click("#discover");
      const row = win.locator("#discover-area tr", { hasText: "mock-desktop-original" });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.locator("button[data-host]").click();
      await expect(win.locator("#log")).toContainText("已登记 ext-", { timeout: 20000 });
      const sessionRow = win.locator("#sessions tbody tr", { hasText: "mock-desktop-original" });
      await sessionRow.locator("button").click();
      await expect(win.locator("#log")).toContainText("已确认 event_ref=gui-", { timeout: 15000 });
      await expect.poll(async () => {
        const page = await callIpc<{ items: Array<{ events: Array<{ authorization: { authorization_id: string } | null }> }> }>(win, "confirm", "confirmations", { limit: 50 });
        return page.items.some(item => item.events.some(event => event.authorization !== null)) ? "authorized" : "pending";
      }, { timeout: 25000 }).toBe("authorized");

      // 2. The Agent anchors in the original session and publishes state r1
      //    (project visibility) through its own session tools.
      const agent = await agentClient(envFile);
      let candidateId = "";
      try {
        const offered = await agent.call("authorizations.get", {});
        const authorizationId = offered.payload?.authorizations?.[0]!.authorization_id ?? "";
        expect(authorizationId).toBeTruthy();
        const anchor = await agent.call("sessions.anchor", { authorization_id: authorizationId, idempotency_key: "g5-shell-e2e" });
        expect(anchor.payload?.binding).toMatchObject({ state: "active", generation: 1 });
        // R1 regression: the body carries labeled-secret shapes; it must reach
        // the renderer byte-faithful (sha256(body) === content_hash) through
        // the shell IPC redact layer.
        const published = await agent.call("documents.publish", { document_key: "state", body: "状态文档 v1 正文（G5 E2E）\nAuthorization: Bearer SYNTHETIC_SENTINEL_G5_E2E_123456 expired\ntoken: Z0mB1eG5E2eSentinel789", expected_revision: 0, expected_generation: 1 });
        expect(published.isError).toBe(false);
        expect(published.payload?.revision).toBe(1);
        const proposed = await agent.call("documents.propose", { target_role_id: "builder", document_key: "state", body: "候选正文：v2 草案（待审）", note: "G5 E2E candidate" });
        expect(proposed.isError).toBe(false);
        candidateId = proposed.payload?.candidate_id ?? "";
        expect(candidateId).toBeTruthy();
      } finally {
        await agent.close().catch(() => undefined);
      }

      // 3. Knowledge page: directory shows published r1; the reader carries the
      //    project body; the private "handoff" doc stays metadata+hash.
      await win.evaluate(() => { location.hash = "#/knowledge"; });
      const stateRow = win.locator("#directory tr", { hasText: "builder" }).filter({ hasText: "state" });
      await expect(stateRow).toContainText("r1", { timeout: 20000 });
      const handoffRow = win.locator("#directory tr", { hasText: "handoff" });
      await expect(handoffRow).toContainText("未发布");
      await stateRow.locator("button[data-open]").click();
      await expect(win.locator("#body")).toContainText("状态文档 v1 正文（G5 E2E）", { timeout: 15000 });
      await expect(win.locator("#body")).toContainText("内容哈希");
      // R1: the IPC reply's body is byte-faithful — its sha256 equals content_hash.
      const read = await callIpc<{ body: string | null; content_hash: string; body_included: boolean }>(win, "knowledge", "readDocument", { role_id: "builder", document_key: "state" });
      expect(read.body_included).toBe(true);
      expect(read.body).toContain("Bearer SYNTHETIC_SENTINEL_G5_E2E_123456 expired");
      expect(createHash("sha256").update(read.body ?? "").digest("hex")).toBe(read.content_hash);

      // 4. Candidates: full proposed body visible; baseline not conflicted yet.
      const candidateBlock = win.locator("#candidates .chain", { hasText: "候选正文：v2 草案（待审）" });
      await expect(candidateBlock).toBeVisible({ timeout: 20000 });
      await expect(candidateBlock).toContainText("documents.propose");
      await expect(candidateBlock).not.toContainText("基线已过期");
      await shot("gui-01-knowledge-page.png");

      // 5. Export copies the share bundle (only published latest revisions ride;
      //    the never-published role "handoff" doc cannot appear).
      await win.locator("#export").click();
      await expect(win.locator("#transfer-result")).toContainText("已导出", { timeout: 20000 });
      await expect(win.locator("#transfer-result")).toContainText("已复制到所选目录");
      expect(existsSync(join(exportDir, "manifest.json"))).toBe(true);

      // 6. Import from the exported bundle: candidates only — no publication.
      await win.locator("#import").click();
      await expect(win.locator("#transfer-result")).toContainText(/已创建 \d+ 个候选/, { timeout: 20000 });
      await expect(win.locator("#transfer-result")).toContainText("正式采纳/发布由当前有权角色在原会话完成");
      const imported = await callIpc<{ items: Array<{ source: string; document_key: string; body: string | null }> }>(win, "knowledge", "listCandidates", { limit: 100 });
      const importedState = imported.items.filter(item => item.source === "knowledge.import" && item.document_key === "state");
      expect(importedState.length).toBeGreaterThanOrEqual(1);
      expect(importedState[0]!.body).toContain("状态文档 v1 正文");
      // Directory did not move: still r1 (import never publishes).
      const directoryAfter = await callIpc<{ items: Array<{ document_key: string; latest_revision: number }> }>(win, "knowledge", "listDocuments", { role_id: "builder" });
      expect(directoryAfter.items.find(item => item.document_key === "state")!.latest_revision).toBe(1);
      void candidateId;
    } finally {
      await app.close().catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
