import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
const script = resolve("tests/integration/helpers/crash-anchor.mjs");

async function interruptAt(root: string, phase: string): Promise<void> {
  const child = spawn(process.execPath, [script, root, phase], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", signalled = false;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Fixture did not reach crash point: ${stderr}`)); }, 20000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.includes("CRASH-POINT") && !signalled) { signalled = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (_code, signal) => { clearTimeout(timer); if (signalled && signal === "SIGKILL") resolvePromise(); else reject(new Error(`Unexpected fixture exit: ${stderr}`)); });
  });
}
async function recover(root: string): Promise<{ attempt: { state: string }; binding: { generation: number }; loads: number }> {
  const child = spawn(process.execPath, [script, root, "recover"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  return new Promise((resolvePromise, reject) => {
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.on("error", reject);
    child.on("exit", code => { if (code !== 0) reject(new Error(stderr)); else { try { resolvePromise(JSON.parse(stdout.trim())); } catch (error) { reject(error); } } });
  });
}
describe("actual coordinator SIGKILL and persisted anchor intent recovery (fixture)", () => {
  it.each(["before-load", "after-load", "after-activate"])("recovers %s with exactly one confirmed material load and one generation", async phase => {
    const root = mkdtempSync(join(tmpdir(), "rd-anchor-crash-"));
    try {
      await interruptAt(root, phase);
      const first = await recover(root); expect(first.attempt.state).toBe("active"); expect(first.binding.generation).toBe(1); expect(first.loads).toBe(1);
      const second = await recover(root); expect(second).toEqual(first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
