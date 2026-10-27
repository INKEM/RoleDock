import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_CHANNEL_PREFIX, PROBE_METHODS, channelFor, createBridgeApi, redact, scrubDisplayText, SQLITE_BUSY_PROBE_SCRIPT } from "../src/probe/shared/bridge.js";
import { resolveRuntimeNode } from "../src/probe/runtime.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("probe named-IPC contract", () => {
  it("exposes a closed vocabulary — no generic rpc/call/invoke channel exists", () => {
    const calls: string[] = [];
    const api = createBridgeApi(async channel => { calls.push(channel); return null; });
    expect(Object.keys(api).sort()).toEqual([...PROBE_METHODS].sort());
    expect(Object.keys(api)).not.toContain("rpc");
    expect(Object.keys(api)).not.toContain("call");
    expect(Object.keys(api)).not.toContain("invoke");
    void api.getStatus();
    expect(calls).toEqual([PROBE_CHANNEL_PREFIX + "getStatus"]);
    expect(channelFor("startService")).toBe(PROBE_CHANNEL_PREFIX + "startService");
  });
});

describe("R01 redaction: secret fields vs public business identifiers", () => {
  const SHA256 = "a".repeat(64);
  const HOST32 = "b".repeat(32);
  const EVENT_REF = `event-${"c".repeat(40)}`;

  it("keeps public association ids and authorization views, drops credential-valued fields", () => {
    const dto = redact({
      external_session_id: "ext-demo",
      authorization_id: "auth-demo",
      active_authorization: { authorization_id: "auth-demo", role_id: "builder", expires_at: "2026-12-01T00:00:00Z", source: { kind: "human-event", event_ref: "gui-1-abc" } },
      session_token: "SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL",
      owner_credential_token: "SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL",
      nested: { api_key: "SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL", note: "keep" },
    });
    expect((dto as { authorization_id: string }).authorization_id).toBe("auth-demo");
    expect((dto as { active_authorization: object }).active_authorization).toMatchObject({ authorization_id: "auth-demo", role_id: "builder" });
    expect(JSON.stringify(dto)).not.toContain("SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL");
    expect((dto as { nested: { note: string } }).nested.note).toBe("keep");
  });

  it("G0-R01: structured public hashes and host identifiers pass through VERBATIM (exact equality)", () => {
    const dto = redact({
      content_hash: SHA256,
      host_session_id: HOST32,
      event_ref: EVENT_REF,
      artifacts: [{ artifact_id: "art-1", content_hash: SHA256 }],
    });
    expect((dto as { content_hash: string }).content_hash).toBe(SHA256);
    expect((dto as { host_session_id: string }).host_session_id).toBe(HOST32);
    expect((dto as { event_ref: string }).event_ref).toBe(EVENT_REF);
    expect((dto as { artifacts: Array<{ content_hash: string }> }).artifacts[0]!.content_hash).toBe(SHA256);
    expect(JSON.stringify(dto)).not.toContain("[masked]");
  });

  it("masks labeled secrets in free-text fields, keeps labels and prose", () => {
    const masked = redact({
      message: "Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL rejected",
      body: "normal prose stays intact; see document_key builder-style-guide",
      detail: "handoff note: bearer Z0mB1ePr0beTok3nValue expired",
    });
    expect((masked as { message: string }).message).toBe("Authorization: Bearer [masked] rejected");
    expect((masked as { body: string }).body).toBe("normal prose stays intact; see document_key builder-style-guide");
    expect((masked as { detail: string }).detail).toBe("handoff note: bearer [masked] expired");
  });

  it("R1 (P6-G5 review): hash-paired bodies are byte-faithful in BOTH bridges (G0-R01 parity)", () => {
    const body = "状态 v2\nAuthorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL expired\ntoken: Z0mB1eR1B0dySentinel123";
    const masked = redact({ body, content_hash: SHA256 });
    expect((masked as { body: string }).body).toBe(body);
    expect(JSON.stringify(masked)).not.toContain("[masked]");
  });

  it("documented boundary: unlabeled blobs and bare hashes in free text are NOT masked", () => {
    // Contract §3.1 layer 3 (v3): scrubbing covers LABELED secret patterns
    // only. Unlabeled values are the DTO projection layer's responsibility —
    // redact must not rewrite structured hashes or unknown blobs.
    expect(scrubDisplayText(`hash ${SHA256} recorded`)).toBe(`hash ${SHA256} recorded`);
    expect(scrubDisplayText("value YWJjZGVmZ2hpamtsbW5vcA== (base64 prose)")).toBe("value YWJjZGVmZ2hpamtsbW5vcA== (base64 prose)");
  });
});

describe("runtime resolution and second-connection probe script", () => {
  it("resolves the packaged runtime from resources and rejects missing dev runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-runtime-")); dirs.push(dir);
    mkdirSync(join(dir, "runtime", "node"), { recursive: true });
    writeFileSync(join(dir, "runtime", "node", "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "runtime", "node", "node"), 0o755);
    const packaged = resolveRuntimeNode({ isPackaged: true, resourcesPath: dir, envNode: undefined });
    expect(packaged).toEqual({ mode: "packaged", nodePath: join(dir, "runtime", "node", "node") });
    expect(() => resolveRuntimeNode({ isPackaged: false, resourcesPath: dir, envNode: undefined })).toThrow(/ROLEDOCK_PROBE_NODE/);
  });

  it("second-connection probe script reports SQLITE_BUSY (errcode 5), not success", () => {
    expect(SQLITE_BUSY_PROBE_SCRIPT).toContain("errcode === 5");
    expect(SQLITE_BUSY_PROBE_SCRIPT).toContain("node:sqlite");
  });
});
