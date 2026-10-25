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

async function grantTestPolicy(root: string, roles: string[]): Promise<void> {
  for (const role of roles) for (const capability of ["documents.read", "documents.publish", "documents.propose", "requests.create", "requests.execute", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"]) {
    expect((await runCli(["--json", "--root", root, "admin", "grant", role, capability], capture().io)).exitCode).toBe(0);
  }
}
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
  it("fails request creation without a session with a structured envelope", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["--json", "--root", root, "requests", "create", "owner", "-"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.out()).toBe("");
    const envelope = JSON.parse(cap.err()) as ErrorEnvelope;
    expect(validate("error-envelope", envelope).ok).toBe(true);
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.message).toContain("--session");
  });

  it("fails request operations that lack a session with a human-readable line", async () => {
    const root = makeRoot();
    const cap = capture();
    const result = await runCli(["requests", "get"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(cap.err()).toContain("error: VALIDATION_FAILED");
    expect(cap.err()).toContain("--session");
    expect(cap.out()).toBe("");
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
    await grantTestPolicy(root, ["worker"]);

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
    await grantTestPolicy(sourceRoot, ["worker"]);

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
    await grantTestPolicy(root, ["keeper"]);

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

describe("P5: adapter selection, adoption and owner diagnostics", () => {
  it("rejects an unknown --adapter value with exit code 2", async () => {
    const cap = capture();
    const result = await runCli(["--json", "--root", makeRoot(), "--adapter", "pod", "roles", "list"], cap.io);
    expect(result.exitCode).toBe(2);
  });

  it("drives a full handoff through the process bridge and reports diagnostics", async () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({
      dir: packDir,
      name: "p5-pack",
      roles: [{ id: "keeper", docs: [{ key: "state", visibility: "project" }] }],
    });
    const bridge = ["--json", "--root", root, "--adapter", "bridge"];
    expect((await runCli([...bridge, "roles", "install", packDir], capture().io)).exitCode).toBe(0);
    await grantTestPolicy(root, ["keeper"]);
    const firstCap = capture();
    expect((await runCli([...bridge, "sessions", "open", "keeper"], firstCap.io)).exitCode).toBe(0);
    const first = JSON.parse(firstCap.out()) as OutputEnvelope<{ session_id: string; generation: number }>;

    // Publish knowledge via the bridge-backed session.
    const bodyFile = join(root, "state.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bodyFile, "state v1 for the bridge", "utf8");
    const publishCap = capture();
    expect(
      (
        await runCli(
          [...bridge, "--session", first.data?.session_id ?? "", "documents", "publish", "state", bodyFile, "0", String(first.data?.generation ?? 1)],
          publishCap.io,
        )
      ).exitCode,
    ).toBe(0);

    // The handoff provisions a real host session directory under the workspace.
    const secondCap = capture();
    expect((await runCli([...bridge, "sessions", "open", "keeper", "latest"], secondCap.io)).exitCode).toBe(0);
    const second = JSON.parse(secondCap.out()) as OutputEnvelope<{ session_id: string; generation: number }>;
    expect(second.data?.generation).toBe(2);
    const { existsSync, readdirSync } = await import("node:fs");
    const hostSessions = join(root, ".roledock", "host-sessions", "sessions");
    expect(existsSync(hostSessions)).toBe(true);
    expect(readdirSync(hostSessions).some((entry) => entry.startsWith("provision-"))).toBe(true);

    // Owner diagnostics: empty inbox and at least the handoff/execute events.
    const inboxCap = capture();
    expect((await runCli(["--json", "--root", root, "admin", "inbox"], inboxCap.io)).exitCode).toBe(0);
    const inbox = JSON.parse(inboxCap.out()) as OutputEnvelope<{ entries: unknown[] }>;
    expect(inbox.data?.entries).toEqual([]);
    const eventsCap = capture();
    expect((await runCli(["--json", "--root", root, "admin", "events"], eventsCap.io)).exitCode).toBe(0);
    const events = JSON.parse(eventsCap.out()) as OutputEnvelope<{ events: Array<{ kind: string }> }>;
    expect(Array.isArray(events.data?.events)).toBe(true);
  }, 30000);

  it("adopts a request result through --adopt-artifact and flips the inbox to read", async () => {
    const root = makeRoot();
    const { ProcessBridgeAdapter } = await import("@roledock/adapter-process-bridge");
    // Source-path imports keep Coordinator and coordinatorStore in the same
    // module graph (the internal store registry is module-private).
    const { Coordinator } = await import("../../../packages/core/src/index.js");
    const { coordinatorStore } = await import("../../../packages/core/src/internal-store.js");
    const { executeRequest } = await import("../../../packages/core/src/requests/executor.js");
    const packDir = join(root, "src-pack");
    writePack({
      dir: packDir,
      name: "adopt-pack",
      roles: [{ id: "asker" }, { id: "owner", docs: [{ key: "state", visibility: "project" }] }],
    });
    const base = ["--json", "--root", root];
    expect((await runCli([...base, "roles", "install", packDir], capture().io)).exitCode).toBe(0);
    await grantTestPolicy(root, ["asker", "owner"]);
    const ownerCap = capture();
    await runCli([...base, "sessions", "open", "owner"], ownerCap.io);
    const owner = JSON.parse(ownerCap.out()) as OutputEnvelope<{ session_id: string }>;
    const askerCap = capture();
    await runCli([...base, "sessions", "open", "asker"], askerCap.io);
    const asker = JSON.parse(askerCap.out()) as OutputEnvelope<{ session_id: string }>;

    // The owner publishes shared state; the asker reads it (a real receipt),
    // which is the creation precondition for requests.
    const stateFile = join(root, "state.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(stateFile, "shared context", "utf8");
    expect(
      (
        await runCli(
          [...base, "--session", owner.data?.session_id ?? "", "documents", "publish", "state", stateFile, "0", "1"],
          capture().io,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(
          [...base, "--session", asker.data?.session_id ?? "", "documents", "read", "owner", "state"],
          capture().io,
        )
      ).exitCode,
    ).toBe(0);

    const questionFile = join(root, "q.md");
    writeFileSync(questionFile, "what should state say?", "utf8");
    const createCap = capture();
    expect(
      (await runCli([...base, "--session", asker.data?.session_id ?? "", "requests", "create", "owner", questionFile, "adopt-e2e"], createCap.io)).exitCode,
    ).toBe(0);
    const created = JSON.parse(createCap.out()) as OutputEnvelope<{ request_id: string }>;

    // Execute through the bridge-backed engine (the outbox drain path).
    const adapter = new ProcessBridgeAdapter({ stateDir: join(root, ".roledock", "host-sessions") });
    const coordinator = Coordinator.open({ root, adapter });
    const executed = await executeRequest(
      coordinatorStore(coordinator),
      adapter,
      created.data?.request_id ?? "",
    );
    expect(executed.state).toBe("completed");
    coordinator.close();

    const inboxCap = capture();
    await runCli([...base, "admin", "inbox", "owner"], inboxCap.io);
    const inbox = JSON.parse(inboxCap.out()) as OutputEnvelope<{ entries: Array<{ state: string; artifact_id: string }> }>;
    expect(inbox.data?.entries).toHaveLength(1);
    expect(inbox.data?.entries[0]?.state).toBe("unread");
    const artifactId = inbox.data?.entries[0]?.artifact_id ?? "";

    // Adopt through the CLI flag as the owner's current primary session.
    const bodyFile = join(root, "adopt-body.md");
    writeFileSync(bodyFile, "unused — the artifact body wins", "utf8");
    const adoptCap = capture();
    const adopted = await runCli(
      [...base, "--session", owner.data?.session_id ?? "", "documents", "publish", "state", bodyFile, "1", "1", "--adopt-artifact", artifactId],
      adoptCap.io,
    );
    expect(adopted.exitCode).toBe(0);
    const afterInboxCap = capture();
    await runCli([...base, "admin", "inbox", "owner"], afterInboxCap.io);
    const afterInbox = JSON.parse(afterInboxCap.out()) as OutputEnvelope<{ entries: Array<{ state: string }> }>;
    expect(afterInbox.data?.entries[0]?.state).toBe("read");
  }, 30000);
});

describe("cli B2 trusted-entry human event submission", () => {
  it("stores the CLI-console event for a registered session and rejects mismatched identity", async () => {
    const { Coordinator, ExternalSessionAuthority } = await import("@roledock/core");
    const { MockHarnessAdapter } = await import("@roledock/adapter-mock");
    const root = makeRoot();
    const adapter = new MockHarnessAdapter();
    // The CLI opens the workspace writer itself; setup must close before invoking it.
    const setupCoordinator = Coordinator.open({ root, adapter });
    let externalSessionId: string;
    try {
      await setupCoordinator.installRolePack({ source_path: DEMO_TEAM });
      adapter.seedExternalSession("sess_cli-1", "chat");
      const external = await new ExternalSessionAuthority(setupCoordinator, adapter).register({ host_session_id: "sess_cli-1", connection_subject: "chat", capability_ceiling: ["documents.read"] });
      externalSessionId = external.external_session_id;
    } finally { setupCoordinator.close(); }
    const base = ["--json", "--root", root, "admin", "submit-human-event", externalSessionId, "sess_cli-1", "chat", "confirm-001", "human-user", "builder", "documents.read", "initialize", "2099-01-01T00:00:00Z"];
    const first = capture();
    expect((await runCli(base, first.io)).exitCode).toBe(0);
    const envelope = JSON.parse(first.out()) as OutputEnvelope<{ entry: string; event_ref: string }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.entry).toBe("cli-console");
    const replay = capture();
    expect((await runCli(base, replay.io)).exitCode).toBe(0);
    expect((JSON.parse(replay.out()) as OutputEnvelope<{ event_ref: string }>).data?.event_ref).toBe("confirm-001");
    const mismatched = capture();
    const mismatchResult = await runCli(["--json", "--root", root, "admin", "submit-human-event", externalSessionId, "sess_other", "chat", "confirm-003", "human-user", "builder", "documents.read", "initialize", "2099-01-01T00:00:00Z"], mismatched.io);
    expect(mismatchResult.exitCode).toBe(1);
    expect((JSON.parse(mismatched.err()) as ErrorEnvelope).ok).toBe(false);
    const malformed = capture();
    expect((await runCli(["--json", "--root", root, "admin", "submit-human-event", externalSessionId, "sess_cli-1", "chat", "confirm-004", "human-user", "builder", "documents.read", "initialize", "2099-01-01T00:00:00Z", "extra"], malformed.io)).exitCode).toBe(1);
  });
});
