#!/usr/bin/env node
/**
 * Evidence run for the PACKAGED shell: launches the installed-shape binary,
 * opens an EMPTY workspace through the dialog fixture, and asserts the owned
 * service reaches running (exit condition: "空工作空间可从安装探针打开").
 * Usage: node scripts/packaged-shell-evidence.mjs <binary> <out-json>
 */
import { _electron } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [binary, outJson] = process.argv.slice(2);
if (!binary || !outJson) { console.error("usage: packaged-shell-evidence.mjs <binary> <out-json>"); process.exit(2); }
const workspace = mkdtempSync(join(tmpdir(), "roledock-packaged-shell-ws-"));
const userData = mkdtempSync(join(tmpdir(), "roledock-packaged-shell-ud-"));
const step = message => process.stderr.write(`[packaged-shell] ${message}\n`);

const app = await _electron.launch({ executablePath: binary, args: [], env: { ...process.env, ROLEDOCK_SHELL_USER_DATA: userData, ROLEDOCK_SHELL_DIALOG_FIXTURE: workspace } });
try {
  const win = await app.firstWindow();
  step("window ready");
  await win.evaluate(() => { location.hash = "#/workspace"; });
  await win.getByRole("button", { name: "选择目录并打开…" }).click();
  await win.waitForFunction(() => document.getElementById("status")?.textContent?.includes("workspace_id：ws-"), undefined, { timeout: 60000 });
  const status = await win.locator("#status .card").textContent();
  step("empty workspace running (packaged runtime)");
  await win.screenshot({ path: outJson.replace(/\.json$/, ".png"), fullPage: true });
  writeFileSync(outJson, JSON.stringify({ kind: "packaged-shell", status: status?.trim(), screenshot: outJson.replace(/\.json$/, ".png") }, null, 2) + "\n");
} finally {
  await app.close().catch(() => undefined);
}
