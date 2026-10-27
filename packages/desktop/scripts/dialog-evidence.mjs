#!/usr/bin/env node
/**
 * Evidence run: opens the REAL native directory dialog (no fixture env) and
 * proves it exists via the X11 window tree (xwininfo lists the portal
 * file-chooser window by its title). The pending IPC reply stays unresolved
 * while the dialog blocks — the round-trip with a selected path is verified
 * by the E2E spec's documented dialog fixture. Human selection inside the
 * native dialog is not automated (xdotool unavailable).
 * Usage: node scripts/dialog-evidence.mjs <out-page-png>
 */
import { _electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const outPath = process.argv[2];
if (!outPath) { console.error("usage: dialog-evidence.mjs <out-page-png>"); process.exit(2); }
const packageRoot = join(import.meta.dirname, "..");
const nodeBinary = join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");
const baseDir = mkdtempSync(join(tmpdir(), "roledock-dialog-evidence-"));
const step = message => process.stderr.write(`[dialog-evidence] ${message}\n`);

const app = await _electron.launch({
  args: [join(packageRoot, "dist-desktop", "vendor", "main.mjs")],
  cwd: packageRoot,
  env: { ...process.env, ROLEDOCK_PROBE_NODE: nodeBinary, ROLEDOCK_PROBE_DIR: baseDir },
});
step("launched");
let windowTree = "";
try {
  const win = await app.firstWindow();
  step("window ready");
  await win.getByRole("button", { name: "启动服务" }).click();
  await win.waitForFunction(() => document.getElementById("status")?.textContent?.includes("service.state=running"), undefined, { timeout: 30000 });
  step("service running");
  await win.screenshot({ path: outPath, fullPage: false });
  step("page screenshot saved");
  await win.getByRole("button", { name: "选择目录…" }).click();
  // The native dialog blocks the IPC reply; give it time to map, then query X11.
  await win.waitForTimeout(4000);
  windowTree = execFileSync("timeout", ["5", "xwininfo", "-root", "-tree"], { encoding: "utf8", env: process.env });
  step("xwininfo captured");
} finally {
  app.process().kill("SIGTERM");
  step("probe killed");
}
const dialogLines = windowTree.split("\n").filter(line => /roledock|选择目录|filechooser/i.test(line)).map(line => line.trim());
console.log(JSON.stringify({ kind: "dialog-evidence", dialogWindows: dialogLines }));
