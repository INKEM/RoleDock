import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { confirmInput } from "../src/gmin/confirm.js";
import { writeMcpSessionEnvFile, mcpSessionEnvPath } from "../src/shell/shared/credential-file.js";

const sessions = [
  { session: { external_session_id: "ext-abc", host_session_id: "sess-1", connection_subject: "desktop-event-bridge", created_at: new Date().toISOString() }, active_authorization: null },
];
const roles = [{ role_id: "builder", title: "Builder", initialized: false, requested_capabilities: ["documents.read", "requests.create"] }];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function errorCode(action: () => unknown): string {
  try { action(); } catch (error) { return (error as { code?: string }).code ?? "NO_CODE"; }
  return "NO_THROW";
}

describe("G3 stable confirmation action ID", () => {
  it("same intent (double click / refresh / reopen) derives the same event_ref and expiry", () => {
    const body = { external_session_id: "ext-abc", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_hours: 8 };
    const first = confirmInput(sessions, roles, body) as { event_ref: string; expires_at: string };
    const second = confirmInput(sessions, roles, body) as { event_ref: string; expires_at: string };
    expect(first.event_ref).toBe(second.event_ref);
    expect(first.event_ref).toMatch(/^gui-[0-9a-f]{24}$/);
    expect(first.expires_at).toBe(second.expires_at);
  });

  it("capability order does not change the intent; a different expiry is a new intent", () => {
    const base = { external_session_id: "ext-abc", role_id: "builder", inherit: "initialize" };
    const a = confirmInput(sessions, roles, { ...base, capabilities: ["documents.read", "requests.create"], expires_hours: 8 });
    const b = confirmInput(sessions, roles, { ...base, capabilities: ["requests.create", "documents.read"], expires_hours: 8 });
    expect(a.event_ref).toBe(b.event_ref);
    const other = confirmInput(sessions, roles, { ...base, capabilities: ["documents.read"], expires_hours: 24 });
    expect(other.event_ref).not.toBe(a.event_ref);
  });

  it("guards stay: unregistered session, live authorization and bad inputs fail honestly", () => {
    expect(errorCode(() => confirmInput(sessions, roles, { external_session_id: "ext-missing", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_hours: 1 })))
      .toBe("NOT_FOUND");
    const live = [{ ...sessions[0]!, active_authorization: { authorization_id: "auth-1", role_id: "builder", expires_at: new Date(Date.now() + 60000).toISOString(), source: { kind: "human-event", event_ref: "x" } } }];
    expect(errorCode(() => confirmInput(live, roles, { external_session_id: "ext-abc", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_hours: 1 })))
      .toBe("INVALID_STATE_TRANSITION");
    expect(errorCode(() => confirmInput(sessions, roles, { external_session_id: "ext-abc", role_id: "builder", capabilities: [], inherit: "initialize", expires_hours: 1 })))
      .toBe("VALIDATION_FAILED");
    expect(errorCode(() => confirmInput(sessions, roles, { external_session_id: "ext-abc", role_id: "builder", capabilities: ["documents.read"], inherit: "takeover-ish", expires_hours: 1 })))
      .toBe("VALIDATION_FAILED");
    expect(errorCode(() => confirmInput(sessions, roles, { external_session_id: "ext-abc", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_hours: 0 })))
      .toBe("VALIDATION_FAILED");
  });
});

describe("G3 MCP session credential handoff file", () => {
  it("writes a 0600 env file with the session bearer and replaces it atomically on re-registration", () => {
    const root = mkdtempSync(join(tmpdir(), "rd-g3-cred-"));
    roots.push(root);
    const first = writeMcpSessionEnvFile(root, { socket_path: "/tmp/s1.sock", token: "token-one" });
    expect(first).toBe(mcpSessionEnvPath(root));
    const stat = statSync(first);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(first, "utf8")).toContain("ROLEDOCK_SERVICE_SOCKET=/tmp/s1.sock");
    expect(readFileSync(first, "utf8")).toContain("ROLEDOCK_SESSION_TOKEN=token-one");
    writeMcpSessionEnvFile(root, { socket_path: "/tmp/s2.sock", token: "token-two" });
    const replaced = readFileSync(first, "utf8");
    expect(replaced).toContain("token-two");
    expect(replaced).not.toContain("token-one");
    expect(statSync(first).mode & 0o777).toBe(0o600);
  });
});
