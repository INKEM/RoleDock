#!/usr/bin/env node
/**
 * P6-G1 shell build (esbuild; G0 toolchain decision). The G0 probe build
 * (scripts/build.mjs) stays frozen — this script builds the shell app sides
 * plus the same vendor service/MCP bundles and schemas layout:
 *   dist-desktop/shell/main.mjs          Electron main
 *   dist-desktop/shell/preload.cjs       sandboxed preload (CJS)
 *   dist-desktop/shell/renderer/         index.html + shell.css + renderer.js
 *   dist-desktop/vendor/*.mjs            service / MCP bundles (locked Node)
 *   dist-desktop/schemas/                protocol JSON Schemas
 * Run `npm run build` first (workspace tsc -b).
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const outDir = join(packageRoot, "dist-desktop");
const shellDir = join(outDir, "shell");
const srcDir = join(packageRoot, "src", "shell");

mkdirSync(shellDir, { recursive: true });
mkdirSync(join(shellDir, "renderer"), { recursive: true });
mkdirSync(join(outDir, "vendor"), { recursive: true });

const common = { bundle: true, logLevel: "warning", sourcemap: false, target: "node22" };
const esmNode = { ...common, format: "esm", platform: "node", banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' } };

await build({ ...esmNode, entryPoints: [join(srcDir, "main", "index.ts")], outfile: join(shellDir, "main.mjs"), external: ["electron"] });
await build({ ...common, entryPoints: [join(srcDir, "preload.ts")], outfile: join(shellDir, "preload.cjs"), format: "cjs", platform: "node", external: ["electron"] });
await build({ ...common, entryPoints: [join(srcDir, "renderer", "main.ts")], outfile: join(shellDir, "renderer", "renderer.js"), format: "esm", platform: "browser", target: "chrome130" });
await build({ ...esmNode, entryPoints: [join(repoRoot, "packages", "service", "dist", "bin.js")], outfile: join(outDir, "vendor", "service-bundle.mjs") });
await build({ ...esmNode, entryPoints: [join(repoRoot, "packages", "mcp", "dist", "bin.js")], outfile: join(outDir, "vendor", "mcp-bundle.mjs") });
// G2: reference connector entry for the real ZCode launcher (spawned by the
// service bin through connectZCodeConnector).
await build({ ...esmNode, entryPoints: [join(repoRoot, "adapters", "zcode", "dist", "reference-bin.js")], outfile: join(outDir, "vendor", "zcode-connector.mjs") });

cpSync(join(srcDir, "renderer", "index.html"), join(shellDir, "renderer", "index.html"));
cpSync(join(srcDir, "renderer", "shell.css"), join(shellDir, "renderer", "shell.css"));
cpSync(join(repoRoot, "packages", "protocol", "schemas"), join(outDir, "schemas"), { recursive: true });

console.log(`shell build ok -> ${shellDir}`);
