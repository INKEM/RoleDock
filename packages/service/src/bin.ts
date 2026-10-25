#!/usr/bin/env node
import { resolve, join } from "node:path";
import { writeFileSync, rmSync, openSync, closeSync, fchmodSync, constants, lstatSync } from "node:fs";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { WorkspaceService } from "./index.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--mock-workspace") {
  console.error("Usage: roledock-service --mock-workspace <root> (Mock state validation only; not a real Harness)"); process.exitCode = 2;
} else {
  const root = resolve(args[1]!);
  const endpoint = join(root, ".roledock", "owner-connection.json");
  let service: WorkspaceService | undefined;
  try {
    const adapter = new MockHarnessAdapter();
    adapter.seedExternalSession("mock-existing-conversation", "mock-fixture-subject");
    service = await WorkspaceService.start({ root, adapter, socketPath: join(root, ".roledock", "service.sock") });
    // Owner bootstrap only. Agent MCP gets a separately issued session credential.
    try {
      const prior = lstatSync(endpoint);
      if (!prior.isFile() || prior.uid !== process.getuid?.()) throw new Error("Owner credential path is not an owned regular file.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const descriptor = openSync(endpoint, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(descriptor, 0o600); writeFileSync(descriptor, JSON.stringify(service.ownerCredential)); } finally { closeSync(descriptor); }
    console.error(`Mock RoleDock service: ${service.workspaceId}; owner connection: ${endpoint}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await service!.close(); rmSync(endpoint, { force: true }); };
    process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
  } catch (error) { await service?.close(); console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
