#!/usr/bin/env node
/**
 * G2-R03 re-verify evidence: the PACKAGED shell's real-config branch must
 * work end-to-end — preflight (connector loadable by the locked Node), the
 * connection-test handshake and a zcode-mode workspace launch — with no
 * source-tree dependency. Gated on the local ZCode CLI.
 * Usage: node scripts/packaged-g2-evidence.mjs <binary> <out-json>
 */
import { _electron } from "@playwright/test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [binary, outJson] = process.argv.slice(2);
if (!binary || !outJson) { console.error("usage: packaged-g2-evidence.mjs <binary> <out-json>"); process.exit(2); }
const cliPath = "/opt/ZCode/resources/glm/zcode.cjs";
if (!existsSync(cliPath)) { console.error(`local ZCode CLI not present at ${cliPath}; real branch cannot be verified`); process.exit(3); }
const workspace = mkdtempSync(join(tmpdir(), "roledock-packaged-g2-ws-"));
const userData = mkdtempSync(join(tmpdir(), "roledock-packaged-g2-ud-"));
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, "settings.json"), JSON.stringify({
  defaultWorkspaceDir: null,
  exitStopsOwnedServices: true,
  launcher: { kind: "zcode", cliPath, credentialHelper: null, provider: null, model: null, managedEgress: [] },
  recentWorkspaces: [],
}));
const step = message => process.stderr.write(`[packaged-g2] ${message}\n`);

const app = await _electron.launch({ executablePath: binary, args: [], env: { ...process.env, ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: workspace } });
try {
  const win = await app.firstWindow();
  await win.evaluate(() => { location.hash = "#/workspace"; });
  await win.waitForFunction(() => document.getElementById("preflight") !== null, undefined, { timeout: 30000 });
  await win.getByRole("button", { name: "运行预检" }).click();
  await win.waitForFunction(() => document.querySelectorAll("#checks li").length === 7, undefined, { timeout: 60000 });
  const checks = (await win.locator("#checks li").allTextContents()).join("\n");
  step("preflight finished");
  await win.getByRole("button", { name: "运行连接测试（独立动作）" }).click();
  await win.waitForFunction(() => document.getElementById("conn-result")?.textContent?.includes("握手成功"), undefined, { timeout: 60000 });
  const connection = (await win.locator("#conn-result").textContent())?.trim();
  step("connection handshake ok");
  await win.evaluate(() => { document.getElementById("mode").value = "zcode"; });
  await win.getByRole("button", { name: "选择目录并打开…" }).click();
  await win.waitForFunction(() => document.getElementById("status")?.textContent?.includes("workspace_id：ws-"), undefined, { timeout: 60000 });
  const status = (await win.locator("#status .card").textContent())?.trim();
  const diag = await win.evaluate(async () => {
    const shell = window.roledock.shell;
    const reply = await shell.workspace.diagnostics();
    if (!reply.ok) throw new Error("diagnostics failed");
    return reply.result;
  });
  step("zcode workspace running (packaged)");
  await win.screenshot({ path: outJson.replace(/\.json$/, ".png"), fullPage: true });
  writeFileSync(outJson, JSON.stringify({
    kind: "packaged-g2",
    connectorBundleCheck: checks.split("\n").find(line => line.includes("connector_bundle")) ?? null,
    zcodeCliCheck: checks.split("\n").find(line => line.includes("zcode_cli")) ?? null,
    connectionTest: connection,
    status: status,
    diagnostics: diag,
  }, null, 2) + "\n");
} finally {
  await app.close().catch(() => undefined);
}
