#!/usr/bin/env node
/**
 * P6-G0 probe build (esbuild is the only bundler; DESKTOP_GUI_PLAN §4/§8).
 * Inputs: packages/desktop/src/probe/** (app sides) and the already-built
 * workspace packages (run `npm run build` first: tsc -b at the repo root).
 * Outputs in packages/desktop/dist-desktop/:
 *   vendor/main.mjs             Electron main (electron external)
 *   vendor/preload.cjs          sandboxed preload (CJS required by sandbox)
 *   renderer/                   index.html + probe.css + renderer.js (browser)
 *   vendor/service-bundle.mjs   standalone workspace service (locked Node)
 *   vendor/mcp-bundle.mjs       standalone session MCP stdio server (locked Node)
 *   schemas/                    protocol JSON Schemas — @roledock/protocol
 *                               resolves them at runtime relative to the
 *                               bundle ("../schemas/"), so every bundle that
 *                               embeds protocol lives in vendor/ and schemas
 *                               one level up.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const outDir = join(packageRoot, "dist-desktop");
const srcDir = join(packageRoot, "src", "probe");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "renderer"), { recursive: true });
mkdirSync(join(outDir, "vendor"), { recursive: true });

const common = { bundle: true, logLevel: "warning", sourcemap: false, target: "node22" };
// ESM bundles keep CJS transitive deps working in Node/Electron ESM.
const esmNode = { ...common, format: "esm", platform: "node", banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' } };

await build({ ...esmNode, entryPoints: [join(srcDir, "main.ts")], outfile: join(outDir, "vendor", "main.mjs"), external: ["electron"] });
await build({ ...common, entryPoints: [join(srcDir, "preload.ts")], outfile: join(outDir, "vendor", "preload.cjs"), format: "cjs", platform: "node", external: ["electron"] });
await build({ ...common, entryPoints: [join(srcDir, "renderer", "app.ts")], outfile: join(outDir, "renderer", "renderer.js"), format: "esm", platform: "browser", target: "chrome130" });
await build({ ...esmNode, entryPoints: [join(repoRoot, "packages", "service", "dist", "bin.js")], outfile: join(outDir, "vendor", "service-bundle.mjs") });
await build({ ...esmNode, entryPoints: [join(repoRoot, "packages", "mcp", "dist", "bin.js")], outfile: join(outDir, "vendor", "mcp-bundle.mjs") });

cpSync(join(srcDir, "renderer", "index.html"), join(outDir, "renderer", "index.html"));
cpSync(join(srcDir, "renderer", "probe.css"), join(outDir, "renderer", "probe.css"));
cpSync(join(repoRoot, "packages", "protocol", "schemas"), join(outDir, "schemas"), { recursive: true });

console.log(`probe build ok -> ${outDir}`);
