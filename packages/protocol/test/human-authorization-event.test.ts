import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";

describe("P5-H b1 human authorization event contract", () => {
  const record = {
    workspace_id: "ws-demo",
    host_session_id: "sess_abc-1",
    connection_subject: "zcode-reference",
    event_ref: "confirm-2026-10-24-001",
    actor_id: "owner",
    role_id: "arbitrary-role",
    capabilities: ["documents.read", "documents.propose"],
    inherit: "initialize",
    expires_at: "2099-01-01T00:00:00Z",
    entry: "gui-confirm",
    recorded_at: "2026-10-24T00:00:00Z",
  };
  it("accepts a complete trusted-entry record and enforces the entry enum", () => {
    expect(validate("human-authorization-event", record).ok).toBe(true);
    expect(validate("human-authorization-event", { ...record, entry: "chat-message" }).ok).toBe(false);
    expect(validate("human-authorization-event", { ...record, entry: "cli-console" }).ok).toBe(true);
  });
  it("keeps capability, id and date formats aligned with the anchor contracts", () => {
    for (const override of [{ capabilities: ["documents.read", "documents.read"] }, { capabilities: ["shell"] }, { workspace_id: "WS" }, { role_id: "Invalid Role" }, { expires_at: "later" }, { recorded_at: 0 }]) {
      expect(validate("human-authorization-event", { ...record, ...override }).ok).toBe(false);
    }
    expect(validate("human-authorization-event", { ...record, extra: "field" }).ok).toBe(false);
  });
  it("registers the owner-face submitHumanEvent operation with the full record inline", () => {
    const base = { operation: "authorizations.submitHumanEvent", input: { external_session_id: "ext-demo", ...record } };
    delete (base.input as Record<string, unknown>).workspace_id;
    expect(validate("service-control-operation", base).ok).toBe(true);
    expect(validate("service-control-operation", { ...base, input: { ...base.input, entry: "gui-confirm", recorded_at: "nope" } }).ok).toBe(false);
    expect(validate("service-control-operation", { ...base, input: { ...base.input, workspace_id: "ws-injected" } }).ok).toBe(false);
    expect(validate("service-control-operation", { ...base, operation: "authorizations.recordHuman" }).ok).toBe(false);
  });
});
