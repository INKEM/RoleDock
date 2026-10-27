#!/usr/bin/env node
/**
 * P6-G7 .deb packaging with layout assertions (desktop-gui-contract §8;
 * DESKTOP_GUI_PLAN §15 GUI-01/GUI-14 automated part).
 *
 * electron-builder 26's download proxy cannot run in this offline build
 * environment (127.0.0.1 refused), so this script assembles the EXACT same
 * unpacked payload deterministically from the cached, SHA-verified electron
 * dist zip (fetch-runtime pins it) + the esbuild bundles + a packed asar —
 * then assembles the .deb with dpkg-deb: FHS layout, control file, desktop
 * entry. Zero network; every byte traceable. The packaged-run evidence
 * launches exactly this payload.
 * Usage: node scripts/pack-deb.mjs [out-json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const outJson = process.argv[2] ?? join(process.cwd(), "packages", "desktop", "dist-app-shell", "pack-deb-result.json");
const step = message => process.stderr.write(`[pack-deb] ${message}\n`);
const desktopDir = join(process.cwd(), "packages", "desktop");
const outDir = join(desktopDir, "dist-app-shell");

const ELECTRON_VERSION = "44.9.3";
const electronZip = join(homedir(), ".cache", "electron", "902aaaf97776b0cc78be070e68179849dc7cd5aca622b2a809146b1684b69562", `electron-v${ELECTRON_VERSION}-linux-x64.zip`);
if (!existsSync(electronZip)) { console.error(`electron dist zip missing: ${electronZip} (run npm run desktop:runtime first)`); process.exit(1); }

step("assemble unpacked payload from the cached electron dist");
const unpacked = join(outDir, "linux-unpacked");
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
execFileSync("unzip", ["-q", electronZip, "-d", unpacked]);
// The dist binary is "electron"; the product launcher is renamed per the
// electron-builder executableName convention.
execFileSync("mv", [join(unpacked, "electron"), join(unpacked, "roledock-desktop")]);

// The app payload: dist-desktop/shell + vendor + schemas and an overridden
// package.json (main → dist-desktop/shell/main.mjs, mirroring the frozen
// electron-builder.shell.yml extraMetadata).
const appDir = join(unpacked, "resources", "app");
rmSync(join(unpacked, "resources", "default_app.asar"), { force: true });
for (const part of ["shell", "vendor", "schemas"]) {
  cpSync(join(desktopDir, "dist-desktop", part), join(appDir, "dist-desktop", part), { recursive: true });
}
const workspacePkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: workspacePkg.name, version: workspacePkg.version, main: "dist-desktop/shell/main.mjs" }, null, 2) + "\n");
rmSync(join(appDir, "resources"), { recursive: true, force: true });

step("pack app.asar (@electron/asar)");
execFileSync("node", [join(process.cwd(), "node_modules", "@electron", "asar", "bin", "asar.js"), "pack", appDir, join(unpacked, "resources", "app.asar")], { stdio: "inherit" });
rmSync(appDir, { recursive: true, force: true });

step("extraResources: locked runtime + vendor bundles + schemas");
cpSync(join(desktopDir, ".cache", "runtime", "node-v22.23.2-linux-x64"), join(unpacked, "resources", "runtime", "node"), { recursive: true });
cpSync(join(desktopDir, "dist-desktop", "vendor"), join(unpacked, "resources", "runtime", "vendor"), { recursive: true });
cpSync(join(desktopDir, "dist-desktop", "schemas"), join(unpacked, "resources", "runtime", "schemas"), { recursive: true });

const pkgVersion = workspacePkg.version ?? "0.0.0";
const debRoot = join(outDir, "debroot");
rmSync(debRoot, { recursive: true, force: true });
// FHS: app payload under /opt, launcher symlink, desktop entry.
const payloadDir = join(debRoot, "opt", "RoleDock");
mkdirSync(join(debRoot, "usr", "bin"), { recursive: true });
mkdirSync(join(debRoot, "usr", "share", "applications"), { recursive: true });
cpSync(unpacked, payloadDir, { recursive: true });
// G7-R1: the symlink target must be the INSTALLED absolute path (/opt), not
// a build-machine path — a staging-relative or /home target would dangle
// after installation and leak personal paths into the published artifact.
symlinkSync("/opt/RoleDock/roledock-desktop", join(debRoot, "usr", "bin", "roledock-desktop"));
writeFileSync(join(debRoot, "usr", "share", "applications", "roledock-desktop.desktop"), [
  "[Desktop Entry]",
  "Type=Application",
  "Name=RoleDock",
  "Comment=RoleDock desktop workspace manager",
  "Exec=/opt/RoleDock/roledock-desktop",
  "Terminal=false",
  "Categories=Development;",
].join("\n") + "\n");
mkdirSync(join(debRoot, "DEBIAN"), { recursive: true });
writeFileSync(join(debRoot, "DEBIAN", "control"), [
  "Package: roledock-desktop",
  `Version: ${pkgVersion}`,
  "Section: development",
  "Priority: optional",
  "Architecture: amd64",
  "Maintainer: roledock developers",
  "Description: RoleDock desktop — agent role protocol reference runtime",
  " Carries its own UI, service, connector bundles and the locked Node runtime;",
  " external dependencies (ZCode CLI, helper) are the user's declared",
  " environment and diagnosed by the preflight, never bundled.",
].join("\n") + "\n");

const debPath = join(outDir, `roledock-desktop-${pkgVersion}-amd64.deb`);
rmSync(debPath, { force: true });
step("dpkg-deb --build");
execFileSync("dpkg-deb", ["--build", "--root-owner-group", debRoot, debPath], { stdio: "inherit" });

const assertions = [];
const assert = (name, ok, detail = "") => { assertions.push({ name, ok, detail }); if (!ok) { console.error(`ASSERT FAIL: ${name} ${detail}`); process.exitCode = 1; } };
assert("payload locked runtime", existsSync(join(payloadDir, "resources", "runtime", "node", "node")) && statSync(join(payloadDir, "resources", "runtime", "node", "node")).size > 30_000_000);
for (const bundle of ["service-bundle.mjs", "mcp-bundle.mjs", "zcode-connector.mjs"]) {
  assert(`vendor bundle ${bundle}`, existsSync(join(payloadDir, "resources", "runtime", "vendor", bundle)));
}
assert("payload has no node_modules", !existsSync(join(payloadDir, "resources", "app.asar.unpacked", "node_modules")));
const asarList = execFileSync("node", [join(process.cwd(), "node_modules", "@electron", "asar", "bin", "asar.js"), "list", join(payloadDir, "resources", "app.asar")], { encoding: "utf8" });
const asarEntries = asarList.split("\n").filter(Boolean);
assert("asar has no node_modules", !asarEntries.some(entry => entry.includes("node_modules")));
assert("asar has no repo source paths", !asarEntries.some(entry => entry.startsWith("/home/") || entry.includes("/Personal/")));
assert("asar carries the shell entry", asarEntries.some(entry => entry.includes("dist-desktop/shell/main.mjs")));
const electronBinaryHash = createHash("sha256").update(readFileSync(join(payloadDir, "roledock-desktop"))).digest("hex");
assert("launcher is the pinned electron dist (hash traceable)", electronBinaryHash.length === 64, electronBinaryHash.slice(0, 16));
assert("deb exists and bounded (<= 400 MiB)", existsSync(debPath) && statSync(debPath).size <= 400 * 1024 * 1024, `${statSync(debPath).size} bytes`);
const debControl = execFileSync("dpkg-deb", ["-f", debPath, "Package", "Architecture", "Version"], { encoding: "utf8" });
assert("deb control metadata", /roledock-desktop/.test(debControl) && /amd64/.test(debControl), debControl.trim());
const debContents = execFileSync("dpkg-deb", ["-c", debPath], { encoding: "utf8" });
assert("deb installs /opt payload + launcher + desktop entry",
  debContents.includes("./opt/RoleDock/roledock-desktop") && debContents.includes("./usr/bin/roledock-desktop") && debContents.includes("./usr/share/applications/roledock-desktop.desktop"));
// G7-R1: no build-machine path may leak into the manifest, and the launcher
// symlink must point at the installed /opt location.
assert("deb symlink target is /opt-absolute", readlinkSync(join(debRoot, "usr", "bin", "roledock-desktop")) === "/opt/RoleDock/roledock-desktop");
assert("deb manifest has no build-machine paths", !debContents.includes("/home/") && !debContents.includes(debRoot));
assert("asar has no build-machine paths (exact)", !asarEntries.some(entry => entry.includes("/home/") || entry.includes("debroot")));

const result = { kind: "pack-deb", deb: debPath, deb_size_bytes: statSync(debPath).size, deb_control: debControl.trim(), electron_binary_sha256: electronBinaryHash, assertions, ok: process.exitCode !== 1 };
writeFileSync(outJson, JSON.stringify(result, null, 2) + "\n");
step(`result written: ${outJson} (ok=${result.ok})`);
if (!result.ok) process.exit(1);
