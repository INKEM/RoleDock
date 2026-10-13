import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("returns a version envelope in json mode", () => {
    const result = runCli(["--json", "--version"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout) as OutputEnvelope<{ version: string }>;
    expect(validate("output-envelope", envelope).ok).toBe(true);
    expect(envelope.data?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports no operation as NOT_IMPLEMENTED — every specified command is wired", () => {
    for (const [group, operation] of [
      ["sessions", "open"],
      ["documents", "list"],
      ["handoffs", "prepare"],
      ["requests", "get"],
      ["artifacts", "read"],
    ] as Array<[string, string]>) {
      const result = runCli(["--json", "--root", mkdtempSync(join(tmpdir(), "roledock-spawn-")), group, operation]);
      if (result.status === 1) {
        const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
        expect(`${group} ${operation}: ${envelope.error.code}`).not.toBe(
          `${group} ${operation}: NOT_IMPLEMENTED`,
        );
      }
    }
  });

  it("exits 2 on an unknown command", () => {
    const result = runCli(["--json", "does", "nothing"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
  });

  it("keeps human mode non-JSON by default", () => {
    const result = runCli(["requests", "get"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: VALIDATION_FAILED");
    expect(() => JSON.parse(result.stderr)).toThrow();
  });

  it("creates a fresh workspace on demand and reports zero roles via admin policy", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "roledock-spawn-"));
    try {
      const result = spawnSync(process.execPath, [CLI_PATH, "--json", "--root", workspaceRoot, "admin", "policy"], {
        encoding: "utf8",
        timeout: 15000,
      });
      if (result.error !== undefined) throw result.error;
      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout) as OutputEnvelope<{ roles: unknown[] }>;
      expect(validate("output-envelope", envelope).ok).toBe(true);
      expect(envelope.data?.roles).toEqual([]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
