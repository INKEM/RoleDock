import { describe, expect, it } from "vitest";
import { validate, ERROR_CODES } from "../src/index.js";
import { readFileSync } from "node:fs";

describe("P5-A operation and lifecycle contracts", () => {
  it("rejects client identity overrides and privileged control fields on session operations", () => {
    expect(validate("session-operation", { operation: "sessions.anchor", input: { authorization_id: "auth-test", idempotency_key: "key" } }).ok).toBe(true);
    for (const injected of ["session_id", "workspace_id", "role_id", "connection_subject"]) expect(validate("session-operation", { operation: "sessions.anchor", input: { authorization_id: "auth-test", idempotency_key: "key", [injected]: "spoof" } }).ok).toBe(false);
    expect(validate("session-operation", { operation: "authorizations.record", input: {} }).ok).toBe(false);
    expect(validate("session-operation", { operation: "sessions.reconcile", input: {} }).ok).toBe(false);
  });
  it("validates trusted input separately with typed capability ceilings, intent and expiration", () => {
    const valid = { operation: "authorizations.recordOwner", input: { external_session_id: "ext-test", event_ref: "event", actor_id: "owner", role_id: "arbitrary-role", capabilities: ["documents.read"], inherit: "initialize", expires_at: "2099-01-01T00:00:00Z" } };
    expect(validate("service-control-operation", valid).ok).toBe(true);
    for (const override of [{ expires_at: "later" }, { inherit: "latest" }, { capabilities: ["documents.read", "documents.read"] }, { capabilities: ["shell"] }, { role_id: "Invalid Role" }]) expect(validate("service-control-operation", { ...valid, input: { ...valid.input, ...override } }).ok).toBe(false);
    expect(validate("service-control-operation", { operation: "connections.trust", input: { subject: "host", capability_ceiling: [], admin: true } }).ok).toBe(false);
  });
  it("active requires an actual typed confirmation and failed requires a registered error", () => {
    const attempt = { attempt_id: "anchor-a", external_session_id: "ext-a", authorization_id: "auth-a", idempotency_key: "key", input_hash: "a".repeat(64), bundle_hash: "b".repeat(64), load_key: "load-a", source_generation: 0, source_knowledge_revision: 0, state: "prepared", confirmation: null, error: null, created_at: "2026-10-14T00:00:00Z" };
    expect(validate("anchor-attempt", attempt).ok).toBe(true);
    expect(validate("anchor-attempt", { ...attempt, state: "active" }).ok).toBe(false);
    expect(validate("anchor-attempt", { ...attempt, state: "active", confirmation: { host_session_id: "host", load_key: "load-a", content_hash: "b".repeat(64), load_version: 1 } }).ok).toBe(true);
    expect(validate("anchor-attempt", { ...attempt, state: "failed" }).ok).toBe(false);
    expect(validate("anchor-attempt", { ...attempt, state: "failed", error: { code: "PERMISSION_DENIED", message: "Revoked" } }).ok).toBe(true);
    const schema = JSON.parse(readFileSync(new URL("../schemas/anchor-attempt.schema.json", import.meta.url), "utf8"));
    expect(schema.properties.error.anyOf[0].properties.code.enum.sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });
});
