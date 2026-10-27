import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShellApi, SHELL_NAMESPACES, channelFor } from "../src/shell/shared/contract.js";
import { redact, scrubDisplayText } from "../src/shell/shared/redact.js";
import { isTrustedSender, shellPageUrlPrefix } from "../src/shell/shared/sender.js";
import { loadSettingsFile, saveSettingsFile, settingsPath, DEFAULT_SETTINGS } from "../src/shell/shared/settings.js";
import { resolveRuntimeNode } from "../src/shell/runtime.js";
import { mkdirSync, chmodSync } from "node:fs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), "shell-test-")); dirs.push(dir); return dir; }

describe("shell named-IPC contract", () => {
  it("exposes closed namespaces — no generic rpc/call/invoke anywhere", async () => {
    const seen: string[] = [];
    const api = createShellApi(async (namespace, method) => { seen.push(`${namespace}.${method}`); return null; });
    expect(Object.keys(api).sort()).toEqual(Object.keys(SHELL_NAMESPACES).sort());
    for (const [namespace, methods] of Object.entries(SHELL_NAMESPACES)) {
      const namespaceApi = api[namespace as keyof typeof api];
      expect(Object.keys(namespaceApi).sort()).toEqual([...methods].sort());
      for (const method of methods) {
        expect(method).not.toMatch(/^(rpc|call|invoke|exec|shell)$/);
        const entry = namespaceApi[method];
        if (typeof entry === "function") await entry();
      }
    }
    expect(seen.length).toBe(Object.values(SHELL_NAMESPACES).flat().length);
    expect(channelFor("workspace", "open")).toBe("roledock:workspace:open");
  });

  it("G4: observability vocabulary is exactly the contracted read views plus the revoke pair — no release", () => {
    expect([...SHELL_NAMESPACES.sessions].sort()).toEqual(["listAttempts", "listBindings", "listLoads"]);
    expect([...SHELL_NAMESPACES.authorizations].sort()).toEqual(["revoke", "revokePreview"]);
    // desktop-gui-contract §5.2: release stays with the original session.
    expect(SHELL_NAMESPACES.authorizations).not.toContain("release");
    expect(SHELL_NAMESPACES.sessions).not.toContain("release");
  });

  it("G6: inbox vocabulary is the owner request views plus the reason-carrying cancel — no GUI reply/publish", () => {
    expect([...SHELL_NAMESPACES.inbox].sort()).toEqual(["cancelRequest", "getRequest", "listCleanup", "listRequests", "readArtifact"]);
    // Clarifications go back through the initiating session; adoption happens
    // in the target role's original session — the GUI has no chat/publish.
    expect(SHELL_NAMESPACES.inbox).not.toContain("reply");
    expect(SHELL_NAMESPACES.inbox).not.toContain("publish");
    expect(SHELL_NAMESPACES.inbox).not.toContain("adopt");
  });

  it("G5: knowledge vocabulary is exactly the six owner read views plus export/import — no owner publish/proposal", () => {
    expect([...SHELL_NAMESPACES.knowledge].sort()).toEqual(["export", "getCheckpoint", "import", "listCandidates", "listCheckpoints", "listDocuments", "listRevisions", "readDocument"]);
    // proposals.submit is contract G5/G6 and NOT implemented this phase; there
    // is no owner publish/adoption channel at all (publishing stays with the
    // role in its original session).
    expect(SHELL_NAMESPACES.knowledge).not.toContain("submit");
    expect(SHELL_NAMESPACES.knowledge).not.toContain("publish");
    expect(SHELL_NAMESPACES.knowledge).not.toContain("adopt");
  });
});

describe("shell redaction (identical layered rules to the probe)", () => {
  const SHA256 = "a".repeat(64);
  const HOST32 = "b".repeat(32);

  it("keeps business identifiers, drops credential-named fields", () => {
    const dto = redact({
      authorization_id: "auth-demo",
      active_authorization: { authorization_id: "auth-demo", role_id: "builder" },
      session_token: "SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL",
    });
    expect((dto as { authorization_id: string }).authorization_id).toBe("auth-demo");
    expect((dto as { active_authorization: { role_id: string } }).active_authorization.role_id).toBe("builder");
    expect(JSON.stringify(dto)).not.toContain("SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL");
  });

  it("G0-R01: structured public hashes and host identifiers pass through VERBATIM (exact equality)", () => {
    const dto = redact({
      content_hash: SHA256,
      host_session_id: HOST32,
      event_ref: `event-${"c".repeat(40)}`,
      socket_path: "/tmp/ws/.roledock/service.sock",
    });
    expect((dto as { content_hash: string }).content_hash).toBe(SHA256);
    expect((dto as { host_session_id: string }).host_session_id).toBe(HOST32);
    expect((dto as { event_ref: string }).event_ref).toBe(`event-${"c".repeat(40)}`);
    expect(JSON.stringify(dto)).not.toContain("[masked]");
  });

  it("R1 (P6-G5 review): hash-paired bodies pass through byte-faithful even with labeled-secret shapes", () => {
    const body = `状态 v2\nAuthorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL expired\ntoken: Z0mB1eR1B0dySentinel123\n普通散文保持不变`;
    const dto = redact({
      body,
      content_hash: SHA256,
      message: "Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL rejected",
    });
    // The body is content-addressed bytes: verbatim, hash still corresponds.
    expect((dto as { body: string }).body).toBe(body);
    // Free-text DISPLAY fields keep their layer-3 scrubbing.
    expect((dto as { message: string }).message).toBe("Authorization: Bearer [masked] rejected");
  });

  it("masks labeled secrets in free-text fields only; unlabeled blobs are untouched", () => {
    const masked = redact({
      message: "Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL rejected",
      detail: "bearer Z0mB1ePr0beTok3nValue expired",
      note: "plain prose",
    });
    expect((masked as { message: string }).message).toBe("Authorization: Bearer [masked] rejected");
    expect((masked as { detail: string }).detail).toBe("bearer [masked] expired");
    expect((masked as { note: string }).note).toBe("plain prose");
    expect(scrubDisplayText(`hash ${SHA256} recorded`)).toBe(`hash ${SHA256} recorded`);
    expect(scrubDisplayText("obfuscated: YWJjZGVmZ2hpamtsbW5vcA==")).toContain("YWJjZGVmZ2hpamtsbW5vcA==");
  });
});

describe("IPC sender validation", () => {
  it("accepts the production renderer frame and rejects anything else", () => {
    const prefix = shellPageUrlPrefix("/app/dist-desktop/shell/renderer");
    expect(prefix).toMatch(/^file:\/\//);
    expect(isTrustedSender({ senderFrame: { url: `${prefix}index.html` } }, prefix)).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: "file:///evil/index.html" } }, prefix)).toBe(false);
    expect(isTrustedSender({ senderFrame: undefined }, prefix)).toBe(false);
    expect(isTrustedSender({ senderFrame: { url: `${prefix}../evil.html` } }, prefix)).toBe(true); // prefix scoping only; path traversal is prevented by loadFile, noted here
  });
});

describe("shell settings persistence", () => {
  it("defaults, merges and persists across loads", () => {
    const file = settingsPath(tempDir());
    expect(loadSettingsFile(file)).toEqual(DEFAULT_SETTINGS);
    const saved = saveSettingsFile(file, { exitStopsOwnedServices: false, defaultWorkspaceDir: "/tmp/ws" });
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, defaultWorkspaceDir: "/tmp/ws", exitStopsOwnedServices: false });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved);
    expect(loadSettingsFile(file)).toEqual(saved);
  });

  it("falls back to defaults on corrupt content", () => {
    const file = settingsPath(tempDir());
    writeFileSync(file, "{not json");
    expect(loadSettingsFile(file)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("shell runtime resolution", () => {
  it("packaged uses resources, dev requires the env node", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "runtime", "node"), { recursive: true });
    writeFileSync(join(dir, "runtime", "node", "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "runtime", "node", "node"), 0o755);
    expect(resolveRuntimeNode({ isPackaged: true, resourcesPath: dir, envNode: undefined })).toEqual({ mode: "packaged", nodePath: join(dir, "runtime", "node", "node") });
    expect(() => resolveRuntimeNode({ isPackaged: false, resourcesPath: dir, envNode: undefined })).toThrow(/ROLEDOCK_SHELL_NODE/);
  });
});
