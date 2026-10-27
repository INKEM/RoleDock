import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ServiceClient } from "@roledock/service";
import type { ServiceCredential } from "@roledock/service";

async function start(root: string): Promise<{ child: ChildProcessWithoutNullStreams; credential: ServiceCredential }> {
  const child = spawn(process.execPath, [resolve("packages/service/dist/bin.js"), "--mock-workspace", root]);
  let stderr = "";
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Service not ready: ${stderr}`)); }, 20000);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.includes("RoleDock service (")) { clearTimeout(timer); resolvePromise({ child, credential: JSON.parse(readFileSync(join(root, ".roledock", "owner-connection.json"), "utf8")) }); } });
    child.on("error", reject); child.once("exit", code => { clearTimeout(timer); if (!stderr.includes("RoleDock service (")) reject(new Error(`Service startup exit ${code}: ${stderr}`)); });
  });
}
async function stop(child: ChildProcessWithoutNullStreams, signal: "SIGKILL" | "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())); child.kill(signal); await ended;
}
describe("shared service actual process restart", () => {
  it("safely recovers its stale socket and refreshes owner credentials after SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "rd-svc-crash-")); let first: ChildProcessWithoutNullStreams | undefined, second: ChildProcessWithoutNullStreams | undefined;
    try {
      const a = await start(root); first = a.child; const clientA = new ServiceClient(a.credential);
      const identity = await clientA.call<{ workspace_id: string; service: { pid: number; started_at: string } }>("workspace.info");
      await clientA.call("roles.install", { source_path: resolve("examples/custom-role") });
      await stop(first, "SIGKILL"); expect(existsSync(a.credential.socket_path)).toBe(true);
      const b = await start(root); second = b.child;
      expect(b.credential.token).not.toBe(a.credential.token); await expect(clientA.call("workspace.info")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      const clientB = new ServiceClient(b.credential);
      // Workspace identity is stable across restarts; the runtime projection
      // (service.pid/started_at) intentionally differs — it must identify the
      // NEW process, proving the RPC answers from the live writer.
      const fresh = await clientB.call<{ workspace_id: string; service: { pid: number; started_at: string } }>("workspace.info");
      expect(fresh.workspace_id).toBe(identity.workspace_id);
      expect(fresh.service.pid).toBe(second.pid);
      expect(fresh.service.started_at).not.toBe(identity.service.started_at);
      expect((await clientB.call<{ roles: unknown[] }>("roles.list")).roles).toHaveLength(1);
      await stop(second, "SIGTERM"); expect(existsSync(b.credential.socket_path)).toBe(false); expect(existsSync(join(root, ".roledock", "owner-connection.json"))).toBe(false);
    } finally { if (first) await stop(first, "SIGKILL"); if (second) await stop(second, "SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });
});
