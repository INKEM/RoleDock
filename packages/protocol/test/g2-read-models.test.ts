import { describe, expect, it } from "vitest";
import { validate } from "../src/validate.js";
import type { PolicyListPage, RoleDetails, WorkspaceRuntimeStatus } from "../src/types.js";

const SHA = "a".repeat(64);
const DETAILS: RoleDetails = {
  workspace_id: "ws-demo1",
  role_id: "builder",
  title: "Builder",
  instructions: "Build things carefully.",
  pack: { name: "custom-role", version: "0.1.0", content_hash: SHA },
  initialized: false,
  generation: 0,
  knowledge_revision: 0,
  current_instance_id: null,
  requested_capabilities: ["documents.read", "documents.propose"],
  granted_capabilities: ["documents.read"],
  documents: [{ key: "style-guide", visibility: "project", title: "Style Guide", template: "# Style Guide\n\nKeep it tidy." }],
  output_schemas: [{ key: "report", schema: "{\"type\":\"object\"}" }],
};

const POLICY: PolicyListPage = {
  workspace_id: "ws-demo1",
  observed_at: "2026-10-26T05:00:00.000Z",
  items: [{ role_id: "builder", title: "Builder", requested: ["documents.read"], granted: [] }],
  next_cursor: null,
};

const RUNTIME: WorkspaceRuntimeStatus = {
  workspace_id: "ws-demo1",
  observed_at: "2026-10-26T05:00:00.000Z",
  runtime: { adapter: "mock", level: "restricted", isolation: { context: true, temp_writes: true, results: true, capability_scope: false } },
};

describe("G2 owner read-model schemas", () => {
  it("role-details: accepts the documented projection, rejects gaps and extras", () => {
    expect(validate<RoleDetails>("role-details", DETAILS).ok).toBe(true);
    expect(validate("role-details", { ...DETAILS, role_id: "BAD" }).ok).toBe(false);
    expect(validate("role-details", { ...DETAILS, pack: { ...DETAILS.pack, content_hash: "nothex" } }).ok).toBe(false);
    expect(validate("role-details", { ...DETAILS, requested_capabilities: "documents.read" }).ok).toBe(false);
    expect(validate("role-details", { ...DETAILS, token: "secret" }).ok).toBe(false);
    expect(validate("role-details", { ...DETAILS, documents: [{ key: "x", visibility: "secret" }] }).ok).toBe(false);
  });

  it("policy-list: accepts a page, rejects bad cursors, timestamps and extras", () => {
    expect(validate<PolicyListPage>("policy-list", POLICY).ok).toBe(true);
    expect(validate("policy-list", { ...POLICY, observed_at: "yesterday" }).ok).toBe(false);
    expect(validate("policy-list", { ...POLICY, next_cursor: 5 }).ok).toBe(false);
    expect(validate("policy-list", { ...POLICY, items: [{ ...POLICY.items[0]!, granted: undefined }] }).ok).toBe(false);
    expect(validate("policy-list", { ...POLICY, grants: { builder: [] } }).ok).toBe(false);
  });

  it("workspace-runtime-status: accepts capabilities projection, rejects unknown shapes", () => {
    expect(validate<WorkspaceRuntimeStatus>("workspace-runtime-status", RUNTIME).ok).toBe(true);
    expect(validate("workspace-runtime-status", { ...RUNTIME, runtime: { ...RUNTIME.runtime, level: "unlimited" } }).ok).toBe(false);
    expect(validate("workspace-runtime-status", { ...RUNTIME, runtime: { ...RUNTIME.runtime, isolation: { context: true } } }).ok).toBe(false);
    expect(validate("workspace-runtime-status", { ...RUNTIME, egress: ["api.example.com:443"] }).ok).toBe(false);
  });
});
