#!/usr/bin/env node
/** Dev launcher for the G0 probe: verifies the cached runtime, then execs Electron. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBinary = join(packageRoot, ".cache", "runtime", "node-v22.23.2-linux-x64", "node");

if (!existsSync(nodeBinary)) {
  console.error(`Missing runtime cache at ${nodeBinary}. Run: npm run desktop:runtime`);
  process.exit(1);
}

const version = execFileSync(nodeBinary, ["--version"], { encoding: "utf8" }).trim();
if (version !== "v22.23.2") {
  console.error(`Cached runtime is ${version}, expected v22.23.2. Re-run: npm run desktop:runtime`);
  process.exit(1);
}

const electron = join(packageRoot, "..", "..", "node_modules", ".bin", "electron");
const result = spawnSync(electron, [join(packageRoot, "dist-desktop", "vendor", "main.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ROLEDOCK_PROBE_NODE: nodeBinary },
});
process.exit(result.status ?? 1);
