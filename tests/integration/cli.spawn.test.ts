import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "@roledock/protocol";
import type { ErrorEnvelope, OutputEnvelope } from "@roledock/protocol";

const CLI_PATH = fileURLToPath(new URL("../../packages/cli/dist/bin.js", import.meta.url));

function runCli(args: readonly string[]) {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built at ${CLI_PATH}; run "npm run build" first (root "test" does this automatically).`);
  }
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

describe("roledock CLI subprocess smoke", () => {
  it("reports its version and exits 0", () => {
    const result = runCli(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("fails an unimplemented operation with a valid NOT_IMPLEMENTED envelope on stderr and exit code 1", () => {
    const result = runCli(["--json", "roles", "list"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
    expect(validate("error-envelope", envelope).ok).toBe(true);
    expect(envelope.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("returns a version envelope in json mode", () => {
    const result = runCli(["--json", "--version"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout) as OutputEnvelope<{ version: string }>;
    expect(validate("output-envelope", envelope).ok).toBe(true);
    expect(envelope.data?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 2 on an unknown command", () => {
    const result = runCli(["--json", "does", "nothing"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
  });

  it("keeps human mode non-JSON by default", () => {
    const result = runCli(["requests", "create"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: NOT_IMPLEMENTED");
    expect(() => JSON.parse(result.stderr)).toThrow();
  });
});
