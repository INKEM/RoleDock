#!/usr/bin/env node
/**
 * Evidence run for the PACKAGED probe (electron-builder dir output): launches
 * the packaged binary, starts the service, runs all checks through the real
 * window UI, and captures page screenshots. The packaged selfcheck JSON is
 * captured separately (see phase report). Usage:
 *   node scripts/packaged-evidence.mjs <binary> <out-dir>
 */
import { _electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [binary, outDir] = process.argv.slice(2);
if (!binary || !outDir) { console.error("usage: packaged-evidence.mjs <binary> <out-dir>"); process.exit(2); }
const baseDir = mkdtempSync(join(tmpdir(), "roledock-packaged-evidence-"));
const step = message => process.stderr.write(`[packaged-evidence] ${message}\n`);

const app = await _electron.launch({ executablePath: binary, args: [], env: { ...process.env, ROLEDOCK_PROBE_DIR: baseDir } });
try {
  const win = await app.firstWindow();
  step("window ready");
  await win.getByRole("button", { name: "启动服务" }).click();
  await win.waitForFunction(() => document.getElementById("status")?.textContent?.includes("service.state=running"), undefined, { timeout: 30000 });
  step("service running (packaged runtime)");
  await win.click("#run-checks");
  await win.waitForFunction(() => document.querySelectorAll("#checks li").length === 4, undefined, { timeout: 60000 });
  const checks = await win.locator("#checks li").allTextContents();
  step("checks finished");
  await win.screenshot({ path: join(outDir, "e2e-5-packaged-checks.png"), fullPage: true });
  console.log(JSON.stringify({ kind: "packaged-probe", checks }));
} finally {
  await app.close().catch(() => undefined);
}
