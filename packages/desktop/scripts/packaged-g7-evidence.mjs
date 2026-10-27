#!/usr/bin/env node
/**
 * P6-G7 packaged-run smoke (DESKTOP_GUI_PLAN §15 GUI-01 automated part):
 * launches the PACKAGED payload binary (no repo node_modules involvement —
 * the app carries its own UI, service bundle and locked Node runtime), opens
 * a mock workspace, installs a role pack from a user-chosen directory,
 * registers the original session, confirms, lets the trusted bridge advance,
 * anchors through the PACKAGED MCP bundle with the PACKAGED runtime node,
 * and asserts the active binding appears in the GUI.
 * Usage: node scripts/packaged-g7-evidence.mjs <payload-binary> [out-json]
 */
import { _electron } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const payloadBinary = join(process.cwd(), "packages", "desktop", "dist-app-shell", "linux-unpacked", "roledock-desktop");
const resourcesDir = join(payloadBinary, "..", "resources");
const outJson = process.argv[2] ?? join(process.cwd(), "packages", "desktop", "dist-app-shell", "packaged-g7-evidence.json");
if (!existsSync(payloadBinary)) { console.error(`payload binary missing: ${payloadBinary}`); process.exit(2); }
const packagedNode = join(resourcesDir, "runtime", "node", "node");
const packagedMcp = join(resourcesDir, "runtime", "vendor", "mcp-bundle.mjs");
const step = message => process.stderr.write(`[packaged-g7] ${message}\n`);

const workspace = mkdtempSync(join(tmpdir(), "roledock-g7-ws-"));
const userData = mkdtempSync(join(tmpdir(), "roledock-g7-ud-"));
const envFile = join(workspace, ".roledock", "mcp-session.env");
const demoTeamDir = join(process.cwd(), "examples", "demo-team"); // user-provided pack source, NOT a packaged resource

const ipcCall = async (win, namespace, method, payload) => {
  const reply = await win.evaluate(async ({ namespace, method, payload }) => {
    const shell = window.roledock?.shell;
    const entry = shell?.[namespace]?.[method];
    if (typeof entry !== "function") throw new Error(`no such method ${namespace}.${method}`);
    return await entry(payload);
  }, { namespace, method, payload });
  if (!reply.ok) throw new Error(`${reply.error?.code}: ${reply.error?.message}`);
  return reply.result;
};

const app = await _electron.launch({ executablePath: payloadBinary, args: [], env: { ...process.env, ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: workspace } });
const checks = [];
const result = { kind: "packaged-g7-smoke", ok: false, checks, screenshot: undefined, binding: undefined };
try {
  const win = await app.firstWindow();
  step("window ready (packaged)");
  checks.push({ name: "packaged window opens", ok: true });

  // 1. Open the mock workspace through the packaged shell.
  await win.evaluate(() => { location.hash = "#/workspace"; });
  await win.click("#open-dir");
  await win.waitForFunction(() => document.getElementById("status")?.textContent?.includes("workspace_id：ws-"), undefined, { timeout: 60000 });
  checks.push({ name: "workspace opens from the packaged app", ok: true });
  step("workspace running");

  // 2. Role pack install + grant (owner flows).
  await ipcCall(win, "roles", "install", { dir: demoTeamDir });
  await ipcCall(win, "roles", "grant", { role_id: "builder", capability: "documents.read" });
  checks.push({ name: "role pack installs and policy grants from the packaged app", ok: true });

  // 3. Discover + register the original session (bridge fixtures live in the packaged service bundle).
  await win.evaluate(() => { location.hash = "#/confirm"; });
  await win.click("#discover");
  await win.waitForFunction(() => (document.getElementById("discover-area")?.textContent ?? "").includes("mock-desktop-original"), undefined, { timeout: 30000 });
  await win.locator("#discover-area tr", { hasText: "mock-desktop-original" }).locator("button[data-host]").click();
  await win.waitForFunction(() => (document.getElementById("log")?.textContent ?? "").includes("已登记 ext-"), undefined, { timeout: 30000 });
  if (!existsSync(envFile)) throw new Error("session env file missing");
  const env = readFileSync(envFile, "utf8");
  const socket = env.match(/^ROLEDOCK_SERVICE_SOCKET=(.*)$/m)?.[1] ?? "";
  const token = env.match(/^ROLEDOCK_SESSION_TOKEN=(.*)$/m)?.[1] ?? "";
  checks.push({ name: "original session registered; 0600 credential file written", ok: (statSync(envFile).mode & 0o777) === 0o600 });

  // 4. Confirm through the page; the packaged bridge advances event → authorization.
  const sessionRow = win.locator("#sessions tbody tr", { hasText: "mock-desktop-original" });
  await sessionRow.locator("button").click();
  await win.waitForFunction(() => (document.getElementById("log")?.textContent ?? "").includes("已确认 event_ref=gui-"), undefined, { timeout: 30000 });
  await win.waitForFunction(() => (document.querySelector("#chains")?.textContent ?? "").includes("授权已生成"), undefined, { timeout: 30000 });
  checks.push({ name: "human confirmation stored; trusted bridge advanced to authorization", ok: true });

  // 5. Anchor through the PACKAGED MCP bundle with the PACKAGED runtime node.
  const transport = new StdioClientTransport({ command: packagedNode, args: [packagedMcp], env: { ...process.env, ROLEDOCK_SERVICE_SOCKET: socket, ROLEDOCK_SESSION_TOKEN: token } });
  const client = new Client({ name: "roledock-g7-packaged-agent", version: "0.1.0-alpha.0" });
  await client.connect(transport);
  const offered = await client.callTool({ name: "authorizations.get", arguments: {} });
  const offeredText = Array.isArray(offered.content) && offered.content[0]?.type === "text" ? offered.content[0].text : "";
  const authorizationId = JSON.parse(offeredText)?.result?.authorizations?.[0]?.authorization_id ?? "";
  if (!authorizationId) throw new Error("no authorization offered to the anchored session");
  const anchorReply = await client.callTool({ name: "sessions.anchor", arguments: { authorization_id: authorizationId, idempotency_key: "g7-packaged" } });
  const anchorText = Array.isArray(anchorReply.content) && anchorReply.content[0]?.type === "text" ? anchorReply.content[0].text : "";
  const anchorPayload = JSON.parse(anchorText)?.result;
  const anchoredOk = anchorPayload?.attempt?.state === "active" && anchorPayload?.binding?.state === "active" && anchorPayload?.binding?.generation === 1;
  checks.push({ name: "agent anchors via packaged MCP; active binding generation 1", ok: anchoredOk === true, detail: JSON.stringify(anchorPayload?.binding) });
  await client.close().catch(() => undefined);

  // 6. The GUI progress chain shows the active binding.
  await win.waitForFunction(() => (document.querySelector("#chains")?.textContent ?? "").includes("active · 角色"), undefined, { timeout: 30000 });
  const screenshot = outJson.replace(/\.json$/, ".png");
  await win.screenshot({ path: screenshot, fullPage: true });
  result.ok = checks.every(entry => entry.ok);
  result.screenshot = screenshot;
  result.binding = anchorPayload?.binding;
  writeFileSync(outJson, JSON.stringify(result, null, 2) + "\n");
  step(`done: ok=${result.ok}`);
  if (!result.ok) process.exit(1);
} catch (error) {
  checks.push({ name: "smoke completed", ok: false, detail: error.message.slice(0, 300) });
  result.ok = false;
  try {
    const win = await app.firstWindow();
    result.screenshot = outJson.replace(/\.json$/, ".png");
    await win.screenshot({ path: result.screenshot, fullPage: true });
    result.diag = {
      log: await win.locator("#log").textContent().catch(() => null),
      discover: await win.locator("#discover-area").textContent().catch(() => null),
      chains: await win.locator("#chains").textContent().catch(() => null),
      boundary: await win.locator("#error-boundary").textContent().catch(() => null),
    };
  } catch { /* diagnostics best-effort */ }
  writeFileSync(outJson, JSON.stringify(result, null, 2) + "\n");
  step(`FAILED: ${error.message.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}

