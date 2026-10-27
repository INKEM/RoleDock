#!/usr/bin/env node
/**
 * Fetches the official Node.js v22.23.2 linux-x64 dist binary and verifies it
 * against the official SHASUMS256.txt, caching it under .cache/runtime/ for
 * dev probes and electron-builder extraResources. Uses curl so the download
 * honors the shell's proxy environment (Node's fetch ignores it).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const VERSION = "v22.23.2";
const DIST = "https://nodejs.org/dist";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(packageRoot, ".cache", "runtime", `node-${VERSION}-linux-x64`);
const nodeBinary = join(cacheDir, "node");

function curl(url, output) {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", url, "-o", output], { stdio: "inherit" });
}

async function ready() {
  if (!existsSync(nodeBinary)) return false;
  const version = execFileSync(nodeBinary, ["--version"], { encoding: "utf8" }).trim();
  if (version === VERSION) return true;
  return false;
}

if (await ready()) {
  console.log(`runtime cache ok: ${nodeBinary}`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "roledock-runtime-"));
try {
  const tarball = join(tmp, `node-${VERSION}-linux-x64.tar.xz`);
  const sums = join(tmp, "SHASUMS256.txt");
  curl(`${DIST}/${VERSION}/node-${VERSION}-linux-x64.tar.xz`, tarball);
  curl(`${DIST}/${VERSION}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8").split("\n").find(line => line.endsWith(`node-${VERSION}-linux-x64.tar.xz`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS256.txt has no entry for node-${VERSION}-linux-x64.tar.xz`);
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actual !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
  execFileSync("tar", ["-xJf", tarball, "-C", tmp, `node-${VERSION}-linux-x64/bin/node`, `node-${VERSION}-linux-x64/LICENSE`]);
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(join(tmp, `node-${VERSION}-linux-x64`, "bin", "node"), nodeBinary);
  copyFileSync(join(tmp, `node-${VERSION}-linux-x64`, "LICENSE"), join(cacheDir, "LICENSE"));
  chmodSync(nodeBinary, 0o755);
  console.log(`runtime cached (sha256 verified): ${nodeBinary}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
