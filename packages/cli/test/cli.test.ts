import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, VERSION } from "../src/index.js";
import { validate } from "@roledock/protocol";
import type { ErrorEnvelope, OutputEnvelope } from "@roledock/protocol";
import { writePack } from "../../../tests/helpers/packs.js";

const DEMO_TEAM = fileURLToPath(new URL("../../../examples/demo-team", import.meta.url));

const TEMP_ROOTS: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-cli-"));
  TEMP_ROOTS.push(root);
  return root;
}
afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

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

describe("cli implemented operations (P1)", () => {
  it("installs a pack via roles install and lists it via roles list", async () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "cli-pack", roles: [{ id: "worker" }] });

    const capInstall = capture();
    const installed = await runCli(["--json", "--root", root, "roles", "install", packDir], capInstall.io);
    expect(installed.exitCode).toBe(0);
    const installEnvelope = JSON.parse(capInstall.out()) as OutputEnvelope<{ pack: { name: string } }>;
    expect(validate("output-envelope", installEnvelope).ok).toBe(true);
    expect(installEnvelope.data?.pack.name).toBe("cli-pack");

    const capList = capture();
    const listed = await runCli(["--json", "--root", root, "roles", "list"], capList.io);
    expect(listed.exitCode).toBe(0);
    const listEnvelope = JSON.parse(capList.out()) as OutputEnvelope<{ roles: Array<{ role_id: string }> }>;
    expect(listEnvelope.data?.roles.map((role) => role.role_id)).toEqual(["worker"]);
  });

  it("installs the demo-team example via CLI and resolves a role", async () => {
    const root = makeRoot();
    const capInstall = capture();
    const installed = await runCli(["--root", root, "roles", "install", DEMO_TEAM], capInstall.io);
    expect(installed.exitCode).toBe(0);

    const capResolve = capture();
    const resolved = await runCli(["--json", "--root", root, "roles", "resolve", "explainer"], capResolve.io);
    expect(resolved.exitCode).toBe(0);
    const envelope = JSON.parse(capResolve.out()) as OutputEnvelope<{ role_id: string; initialized: boolean }>;
    expect(envelope.data).toMatchObject({ role_id: "explainer", initialized: false });
  });

  it("reports an unknown role as NOT_FOUND with exit code 1", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["--json", "--root", root, "roles", "resolve", "ghost"], cap.io);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("NOT_FOUND");
  });

  it("admin grant/policy work through the owner entry", async () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "admin-pack", roles: [{ id: "worker" }] });

    expect((await runCli(["--json", "--root", root, "roles", "install", packDir], capture().io)).exitCode).toBe(0);
    expect(
      (await runCli(["--json", "--root", root, "admin", "grant", "worker", "documents.read"], capture().io))
        .exitCode,
    ).toBe(0);

    const cap = capture();
    const result = await runCli(["--json", "--root", root, "admin", "policy"], cap.io);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(cap.out()) as OutputEnvelope<{ roles: Array<{ role_id: string; granted: string[] }> }>;
    expect(envelope.data?.roles[0]).toMatchObject({ role_id: "worker", granted: ["documents.read"] });
  });
});

describe("cli unimplemented operations fail honestly", () => {
  it("exits 1 with a NOT_IMPLEMENTED envelope for sessions open in json mode", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["--json", "--root", root, "sessions", "open"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.out()).toBe("");
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(validate("error-envelope", envelope).ok).toBe(true);
    expect(envelope.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("exits 1 with a human-readable error line by default", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["documents", "publish"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.err()).toContain("error: NOT_IMPLEMENTED");
    expect(cap.out()).toBe("");
  });

  it("keeps all unimplemented commands wired to the SDK surface", async () => {
    const root = makeRoot();
    const commands: Array<[string, string]> = [
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
      const result = await runCli(["--json", "--root", root, group, operation], cap.io);
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
      expect(`${group} ${operation}: ${envelope.error.code}`).toBe(
        `${group} ${operation}: NOT_IMPLEMENTED`,
      );
    }
  });
});
