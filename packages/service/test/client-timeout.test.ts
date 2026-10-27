import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceClient, ServiceRequestTimeoutError } from "../src/index.js";

const dirs: string[] = [];
const sockets: Array<{ close(): void }> = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ServiceClient client-side deadline (DESKTOP_GUI_PLAN §9)", () => {
  it("rejects with ServiceRequestTimeoutError when the service never answers", async () => {
    // Black-hole endpoint: accepts connections, never replies. Cancelling the
    // wait does not cancel any submitted action — the error says reconcile.
    const dir = mkdtempSync(join(tmpdir(), "svc-timeout-")); dirs.push(dir);
    const socketPath = join(dir, "blackhole.sock");
    const server = createServer(socket => { void socket; });
    sockets.push(server);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const client = new ServiceClient({ socket_path: socketPath, token: "unused" });
    const started = Date.now();
    await expect(client.call("workspace.info", {}, { timeoutMs: 300 })).rejects.toMatchObject({ name: "ServiceRequestTimeoutError", operation: "workspace.info" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("documents the reconcile-not-retry contract in the error message", () => {
    const error = new ServiceRequestTimeoutError("requests.get", 1500);
    expect(error.message).toContain("reconciled");
    expect(error.operation).toBe("requests.get");
    expect(error.timeoutMs).toBe(1500);
  });

  it("still answers normally within the deadline (live service)", async () => {
    // Negative control: an endpoint that answers keeps working with the option present.
    const dir = mkdtempSync(join(tmpdir(), "svc-timeout-ok-")); dirs.push(dir);
    const socketPath = join(dir, "live.sock");
    const server = createServer(socket => {
      let body = "";
      socket.on("data", chunk => {
        body += chunk.toString();
        if (!body.includes("}")) return;
        const payload = JSON.stringify({ ok: true, result: { workspace_id: "ws-x" } });
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      });
    });
    sockets.push(server);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const client = new ServiceClient({ socket_path: socketPath, token: "unused" });
    await expect(client.call("workspace.info", {}, { timeoutMs: 3000 })).resolves.toMatchObject({ workspace_id: "ws-x" });
  });
});
