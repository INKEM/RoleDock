import { describe, expect, it } from "vitest";
import { runCli, VERSION } from "../src/index.js";
import { validate } from "@roledock/protocol";
import type { ErrorEnvelope, OutputEnvelope } from "@roledock/protocol";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("cli version and help", () => {
  it("prints the version in human mode", async () => {
    const cap = capture();
    const result = await runCli(["--version"], cap.io);
    expect(result.exitCode).toBe(0);
    expect(cap.out()).toContain(VERSION);
  });

  it("prints a machine envelope with --json --version", async () => {
    const cap = capture();
    const result = await runCli(["--json", "--version"], cap.io);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(cap.out()) as OutputEnvelope<{ version: string }>;
    expect(validate("output-envelope", envelope).ok).toBe(true);
    expect(envelope.data?.version).toBe(VERSION);
  });

  it("prints usage for --help and exits 0", async () => {
    const cap = capture();
    const result = await runCli(["--help"], cap.io);
    expect(result.exitCode).toBe(0);
    expect(cap.out()).toContain("Usage:");
  });
});

describe("cli usage errors", () => {
  it("rejects unknown commands with exit code 2", async () => {
    const cap = capture();
    const result = await runCli(["frobnicate", "now"], cap.io);
    expect(result.exitCode).toBe(2);
    expect(cap.err()).toContain("unknown command");
  });

  it("reports unknown commands as VALIDATION_FAILED envelopes in json mode", async () => {
    const cap = capture();
    const result = await runCli(["--json", "nope", "nope"], cap.io);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(validate("error-envelope", envelope).ok).toBe(true);
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a dangling --root value with exit code 2", async () => {
    const cap = capture();
    const result = await runCli(["--root"], cap.io);
    expect(result.exitCode).toBe(2);
  });

  it("prints usage when no command is given", async () => {
    const cap = capture();
    const result = await runCli([], cap.io);
    expect(result.exitCode).toBe(2);
    expect(cap.err()).toContain("Usage:");
  });
});

describe("cli unimplemented operations fail honestly", () => {
  it("exits 1 with a NOT_IMPLEMENTED envelope for roles list in json mode", async () => {
    const cap = capture();
    const result = await runCli(["--json", "roles", "list"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.out()).toBe("");
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(validate("error-envelope", envelope).ok).toBe(true);
    expect(envelope.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("exits 1 with a human-readable error line by default", async () => {
    const cap = capture();
    const result = await runCli(["documents", "publish"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.err()).toContain("error: NOT_IMPLEMENTED");
    expect(cap.out()).toBe("");
  });

  it("wires every documented command group to an SDK method", async () => {
    // Every known command must reach the Coordinator surface and produce
    // NOT_IMPLEMENTED — a wiring typo would surface as INTERNAL, not
    // NOT_IMPLEMENTED, so asserting the code proves the dispatch table.
    const commands: Array<[string, string]> = [
      ["roles", "install"],
      ["roles", "list"],
      ["roles", "resolve"],
      ["sessions", "open"],
      ["sessions", "resume"],
      ["documents", "list"],
      ["documents", "read"],
      ["documents", "propose"],
      ["documents", "publish"],
      ["handoffs", "prepare"],
      ["handoffs", "activate"],
      ["requests", "create"],
      ["requests", "get"],
      ["requests", "reply"],
      ["requests", "cancel"],
      ["artifacts", "read"],
      ["knowledge", "export"],
      ["knowledge", "import"],
    ];
    for (const [group, operation] of commands) {
      const cap = capture();
      const result = await runCli(["--json", group, operation], cap.io);
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
      expect(`${group} ${operation}: ${envelope.error.code}`).toBe(
        `${group} ${operation}: NOT_IMPLEMENTED`,
      );
    }
  });
});
