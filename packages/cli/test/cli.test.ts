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
  it("exits 1 with a NOT_IMPLEMENTED envelope for requests create in json mode", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["--json", "--root", root, "requests", "create"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.out()).toBe("");
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(validate("error-envelope", envelope).ok).toBe(true);
    expect(envelope.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("exits 1 with a human-readable error line by default", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["requests", "create"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.err()).toContain("error: NOT_IMPLEMENTED");
    expect(cap.out()).toBe("");
  });

  it("keeps all unimplemented commands wired to the SDK surface", async () => {
    const root = makeRoot();
    const commands: Array<[string, string]> = [
      ["requests", "create"],
      ["requests", "get"],
      ["requests", "reply"],
      ["requests", "cancel"],
      ["artifacts", "read"],
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

describe("cli P2 operations", () => {
  it("documents publish requires a session", async () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "p2-pack", roles: [{ id: "worker" }] });
    const bodyFile = join(root, "body.md");
    (await import("node:fs")).writeFileSync(bodyFile, "v1 body");
    expect((await runCli(["--json", "--root", root, "roles", "install", packDir], capture().io)).exitCode).toBe(0);

    const cap = capture();
    const result = await runCli(["--json", "--root", root, "documents", "publish", "notes", bodyFile, "0", "1"], cap.io);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.message).toContain("--session");
  });

  it("publishes and reads through a session id end to end", async () => {
    const { mkdtempSync: mkdtemp, writeFileSync } = await import("node:fs");
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "p2-pack", roles: [{ id: "worker" }] });
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "v1 body");
    expect((await runCli(["--json", "--root", root, "roles", "install", packDir], capture().io)).exitCode).toBe(0);

    // Mint a session through the SDK testing entry (CLI does not mint sessions).
    const { Coordinator } = await import("@roledock/core");
    const { testingOpenPrimarySession } = await import("@roledock/core/testing");
    const coordinator = Coordinator.open({ root });
    const session = testingOpenPrimarySession(
      coordinator as unknown as Parameters<typeof testingOpenPrimarySession>[0],
      { role_id: "worker" },
    );
    coordinator.close();

    const publishedCap = capture();
    const published = await runCli(
      ["--json", "--root", root, "--session", session.session_id, "documents", "publish", "notes", bodyFile, "0", "1"],
      publishedCap.io,
    );
    expect(published.exitCode).toBe(0);
    const publishedEnvelope = JSON.parse(publishedCap.out()) as OutputEnvelope<{ revision: number; knowledge_revision: number }>;
    expect(publishedEnvelope.data).toMatchObject({ revision: 1, knowledge_revision: 1 });

    const readCap = capture();
    const read = await runCli(
      ["--json", "--root", root, "--session", session.session_id, "documents", "read", "worker", "notes"],
      readCap.io,
    );
    expect(read.exitCode).toBe(0);
    const readEnvelope = JSON.parse(readCap.out()) as OutputEnvelope<{ body: string; receipt_id: string }>;
    expect(readEnvelope.data?.body).toBe("v1 body");
    expect(readEnvelope.data?.receipt_id).toMatch(/^rcpt-/);
  });

  it("exports and imports knowledge between two workspace roots", async () => {
    const { mkdtempSync: mkdtemp, writeFileSync, existsSync } = await import("node:fs");
    const sourceRoot = makeRoot();
    const packDir = join(sourceRoot, "src-pack");
    writePack({ dir: packDir, name: "x-pack", roles: [{ id: "worker" }] });
    const bodyFile = join(sourceRoot, "body.md");
    writeFileSync(bodyFile, "knowledge body");
    expect((await runCli(["--json", "--root", sourceRoot, "roles", "install", packDir], capture().io)).exitCode).toBe(0);

    const { Coordinator } = await import("@roledock/core");
    const { testingOpenPrimarySession } = await import("@roledock/core/testing");
    const coordinator = Coordinator.open({ root: sourceRoot });
    const session = testingOpenPrimarySession(
      coordinator as unknown as Parameters<typeof testingOpenPrimarySession>[0],
      { role_id: "worker" },
    );
    coordinator.close();
    expect(
      (
        await runCli([
          "--json",
          "--root",
          sourceRoot,
          "--session",
          session.session_id,
          "documents",
          "publish",
          "notes",
          bodyFile,
          "0",
          "1",
        ], capture().io)
      ).exitCode,
    ).toBe(0);

    const exportCap = capture();
    const exported = await runCli(["--json", "--root", sourceRoot, "knowledge", "export", "share"], exportCap.io);
    expect(exported.exitCode).toBe(0);
    const exportEnvelope = JSON.parse(exportCap.out()) as OutputEnvelope<{ bundle_dir: string; entry_count: number }>;
    expect(exportEnvelope.data?.entry_count).toBe(1);
    const bundleDir = exportEnvelope.data?.bundle_dir ?? "";
    expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);

    const targetRoot = mkdtemp(join(tmpdir(), "roledock-cli-dst-"));
    TEMP_ROOTS.push(targetRoot);
    expect((await runCli(["--json", "--root", targetRoot, "roles", "install", packDir], capture().io)).exitCode).toBe(0);
    const importCap = capture();
    const imported = await runCli(["--json", "--root", targetRoot, "knowledge", "import", bundleDir], importCap.io);
    expect(imported.exitCode).toBe(0);
    const importEnvelope = JSON.parse(importCap.out()) as OutputEnvelope<{ created_candidates: unknown[]; skipped: unknown[] }>;
    expect(importEnvelope.data?.created_candidates).toHaveLength(1);
    expect(importEnvelope.data?.skipped).toEqual([]);
  });
});

describe("cli P3 session operations", () => {
  it("opens a session through the full handoff via the CLI", async () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "p3-pack", roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }] }] });
    expect((await runCli(["--json", "--root", root, "roles", "install", packDir], capture().io)).exitCode).toBe(0);

    const firstCap = capture();
    const first = await runCli(["--json", "--root", root, "sessions", "open", "keeper"], firstCap.io);
    expect(first.exitCode).toBe(0);
    const firstEnvelope = JSON.parse(firstCap.out()) as OutputEnvelope<{
      session_id: string;
      instance_id: string;
      generation: number;
      handoff: { performed: boolean };
    }>;
    expect(firstEnvelope.data).toMatchObject({ generation: 1, handoff: { performed: false } });

    // Publish knowledge from the CLI-opened primary so the successor inherits it.
    const bodyFile = join(root, "state.md");
    (await import("node:fs")).writeFileSync(bodyFile, "inherited state");
    expect(
      (
        await runCli([
          "--json",
          "--root",
          root,
          "--session",
          firstEnvelope.data?.session_id ?? "",
          "documents",
          "publish",
          "state",
          bodyFile,
          "0",
          "1",
        ], capture().io)
      ).exitCode,
    ).toBe(0);

    const secondCap = capture();
    const second = await runCli(["--json", "--root", root, "sessions", "open", "keeper"], secondCap.io);
    expect(second.exitCode).toBe(0);
    const secondEnvelope = JSON.parse(secondCap.out()) as OutputEnvelope<{
      session_id: string;
      generation: number;
      predecessor_instance_id: string;
      handoff: { performed: boolean; bundle_id: string };
    }>;
    expect(secondEnvelope.data).toMatchObject({
      generation: 2,
      predecessor_instance_id: firstEnvelope.data?.instance_id ?? "",
      handoff: { performed: true },
    });

    // Resume from a fresh CLI process: the mock adapter is in-memory, so the
    // predecessor process's host session is unknown to it — the result
    // honestly reports that native resume did not happen and points at
    // semantic inheritance. Generation stays untouched either way.
    const resumeCap = capture();
    const resumed = await runCli(["--json", "--root", root, "sessions", "resume", secondEnvelope.data?.session_id ?? ""], resumeCap.io);
    expect(resumed.exitCode).toBe(0);
    const resumeEnvelope = JSON.parse(resumeCap.out()) as OutputEnvelope<{ resumed: boolean; generation: number }>;
    expect(resumeEnvelope.data).toMatchObject({ resumed: false, generation: 2 });
  });

  it("requires a handoff on an initialized role without inherit", async () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "p3b-pack", roles: [{ id: "keeper" }] });
    expect((await runCli(["--json", "--root", root, "roles", "install", packDir], capture().io)).exitCode).toBe(0);
    await runCli(["--json", "--root", root, "sessions", "open", "keeper"], capture().io);
    const cap = capture();
    const result = await runCli(["--json", "--root", root, "sessions", "open", "keeper", "none"], cap.io);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
  });
});
