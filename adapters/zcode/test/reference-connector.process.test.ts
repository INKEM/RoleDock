import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeAdapter, connectZCodeConnector } from "../src/index.js";

// Real MCP stdio transport + real connector process; the ZCode CLI is a fake
// app-server implementing only the JSON-RPC subset the connector uses.
const connectorBin = fileURLToPath(new URL("../dist/reference-bin.js", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeCliPath(workspace: string): string {
  const path = join(workspace, "fake-app-server.mjs");
  writeFileSync(path, `
import { createInterface } from "node:readline";
const sessions = new Set(["sess_ref-1"]);
createInterface({ input: process.stdin }).on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  const fail = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } }) + "\\n");
  switch (m.method) {
    case "session/create": { const id = "sess_ref-" + (sessions.size + 1); sessions.add(id); reply({ session: { sessionId: id }, settings: { model: { available: ["GLM-5.3"] } } }); return; }
    case "session/resume": return sessions.has(m.params?.sessionId) ? reply({}) : fail("Session not found: " + m.params?.sessionId);
    case "session/read": return sessions.has(m.params?.sessionId) ? reply({ session: { title: "fixture" }, projection: { status: "idle" }, settings: { mode: { current: "plan" }, model: { current: "GLM-5.3" } } } ) : fail("Session is not active: " + m.params?.sessionId);
    case "session/list": { const ws = m.params?.workspace?.workspacePath; return reply({ sessions: [...sessions].map(sessionId => ({ sessionId, workspace: { workspacePath: ws }, updatedAt: "2026-10-24T00:00:00Z" })) }); }
    case "session/resume": case "session/subscribe": return reply({});
    case "session/events": return reply({ events: [] });
    case "session/send": return reply({ accepted: true });
    case "session/requestRuntimePreferences": return reply({ nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false });
    default: return fail("unsupported " + m.method);
  }
});
`);
  return path;
}

describe("reference connector over a real stdio transport", () => {
  it("declares its tool list and verifies session identity through the adapter", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rd-zcode-ref-")); roots.push(workspace);
    const tools = await connectZCodeConnector({ command: process.execPath, args: [connectorBin, "--cli", fakeCliPath(workspace)], cwd: workspace });
    try {
      expect(tools.server).toMatchObject({ name: "roledock-zcode-reference" });
      expect([...tools.tools]).toEqual(expect.arrayContaining(["zcode_create_session", "zcode_verify_session", "zcode_send", "zcode_status"]));
      const adapter = new ZCodeAdapter({ tools, workspacePath: workspace, stateDir: join(workspace, "journal") });
      const handle = await adapter.createSession({ creation_key: "one" });
      expect(await adapter.verifyExternalSession(handle.host_session_id, "subject-a")).toBe(true);
      expect(await adapter.verifyExternalSession(handle.host_session_id, "subject-a")).toBe(true);
      expect(await adapter.verifyExternalSession(handle.host_session_id, "subject-b")).toBe(false);
      expect(await adapter.verifyExternalSession("sess_absent", "subject-a")).toBe(false);
      adapter.closeJournal();
    } finally { await tools.disconnect(); }
  }, 30_000);
  it("fails verification uncertain when the injected CLI entry is unusable", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rd-zcode-ref-")); roots.push(workspace);
    const brokenCli = join(workspace, "not-a-cli.mjs");
    writeFileSync(brokenCli, "process.exit(3);\n");
    const tools = await connectZCodeConnector({ command: process.execPath, args: [connectorBin, "--cli", brokenCli], cwd: workspace });
    try {
      const adapter = new ZCodeAdapter({ tools, workspacePath: workspace, stateDir: join(workspace, "journal") });
      await expect(adapter.verifyExternalSession("sess_ref-1", "subject-a")).rejects.toMatchObject({ details: { uncertain: true } });
      adapter.closeJournal();
    } finally { await tools.disconnect(); }
  }, 30_000);
  it("refuses --sandbox (fail-closed) when no sandbox runner is available", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rd-zcode-ref-")); roots.push(workspace);
    // The diagnostic override forces the probe's stricter answer, so this is
    // machine-independent: with a working runner the managed path launches.
    const outcome = await new Promise<{ started: boolean; stderr: string }>(resolve => {
      execFile(process.execPath, [connectorBin, "--sandbox", "--cli", fakeCliPath(workspace)], { env: { ...process.env, ROLEDOCK_SANDBOX_PROBE: "unavailable" } }, (error, _stdout, stderr) => {
        resolve({ started: !error, stderr: String(stderr) });
      });
    });
    expect(outcome.started).toBe(false);
    // The connector module loads node:sqlite, so stderr also carries Node's
    // experimental warning in unspecified order; scan every line for the envelope.
    const envelope = outcome.stderr.trim().split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line) as unknown; } catch { return undefined; } })
      .find(value => value !== undefined);
    expect(envelope).toMatchObject({ ok: false, error: { code: "NOT_IMPLEMENTED" } });
  }, 30_000);
});
