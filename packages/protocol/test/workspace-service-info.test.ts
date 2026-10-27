import { describe, expect, it } from "vitest";
import { SCHEMA_NAMES, validate } from "../src/validate.js";
import type { WorkspaceServiceInfo } from "../src/types.js";

const VALID: WorkspaceServiceInfo = {
  workspace_id: "ws-demo1",
  service: { version: "0.1.0-alpha.0", pid: 1234, started_at: "2026-10-26T05:00:00.000Z", adapter: "mock", runtime: "v22.23.2" },
};

describe("workspace-service-info schema (G1-R04)", () => {
  it("registers the schema in the protocol registry", () => {
    expect(SCHEMA_NAMES).toContain("workspace-service-info");
  });

  it("accepts the documented projection", () => {
    const result = validate<WorkspaceServiceInfo>("workspace-service-info", VALID);
    expect(result.ok).toBe(true);
  });

  it("rejects missing fields, wrong types and ranges", () => {
    expect(validate("workspace-service-info", { workspace_id: "ws-demo1" }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, workspace_id: "WS_BAD" }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, pid: 0 } }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, pid: "1234" } }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, started_at: "not-a-date" } }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, adapter: "Mock_Bad" } }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, runtime: "" } }).ok).toBe(false);
  });

  it("rejects fields outside the projection — including credential-shaped ones", () => {
    expect(validate("workspace-service-info", { ...VALID, token: "secret" }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, token: "secret" } }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, argv: ["--mock-workspace", "/tmp/x"] }).ok).toBe(false);
    expect(validate("workspace-service-info", { ...VALID, service: { ...VALID.service, socket_path: "/tmp/x.sock" } }).ok).toBe(false);
  });
});
