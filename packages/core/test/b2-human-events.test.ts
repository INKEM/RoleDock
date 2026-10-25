import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin, storeHumanAuthorizationSource } from "../src/index.js";
import type { HumanAuthorizationSource } from "../src/index.js";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import type { HumanAuthorizationEventRecord } from "@roledock/protocol";
import { coordinatorStore } from "../src/internal-store.js";

const CAPS = ["documents.read", "documents.propose", "requests.create"];
const workspaces: { root: string; coordinator: Coordinator }[] = [];
afterEach(() => { for (const item of workspaces.splice(0)) { item.coordinator.close(); rmSync(item.root, { recursive: true, force: true }); } });
async function setup(adapter = new MockHarnessAdapter()) {
  const root = mkdtempSync(join(tmpdir(), "rd-b2-events-"));
  const coordinator = Coordinator.open({ root, adapter }); workspaces.push({ root, coordinator });
  await coordinator.installRolePack({ source_path: resolve("examples/demo-team") });
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  for (const role of ["builder", "reviewer"]) for (const cap of CAPS) admin.grant({ role_id: role, capability: cap });
  const authority = new ExternalSessionAuthority(coordinator, adapter);
  return { root, coordinator, authority, adapter, store: coordinatorStore(coordinator) };
}
const RECORDED_AT = "2026-10-24T00:00:00Z";
const EXPIRES_AT = "2099-01-01T00:00:00Z";
const eventInput = (external_session_id: string, overrides: Record<string, unknown> = {}) => ({
  external_session_id, host_session_id: "chat", connection_subject: "chat", event_ref: "confirm-001",
  actor_id: "human-user", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize",
  expires_at: EXPIRES_AT, entry: "cli-console", recorded_at: RECORDED_AT, ...overrides,
});

/** Test-only adapter that reads the wired workspace source, mirroring the ZCode adapter's readHumanAuthorization. */
class StoreReading extends MockHarnessAdapter {
  #source: HumanAuthorizationSource | undefined;
  wired = false;
  useHumanAuthorizationSource(source: HumanAuthorizationSource): void { this.#source = source; this.wired = true; }
  override async readHumanAuthorization(host: string, ref: string) {
    if (!this.#source) throw new Error("source was not wired by the authority");
    const record = await this.#source.readEvent(host, ref);
    if (!record) return null;
    return { workspace_id: record.workspace_id, host_session_id: record.host_session_id, connection_subject: record.connection_subject, event_ref: record.event_ref, actor_id: record.actor_id, role_id: record.role_id, capabilities: [...record.capabilities], inherit: record.inherit, expires_at: record.expires_at };
  }
}

describe("B2 trusted-entry human authorization events", () => {
  it("stores a verbatim owner-submitted record and replays it idempotently on identical content", async () => {
    const context = await setup();
    context.adapter.seedExternalSession("chat", "chat");
    const external = await context.authority.register({ host_session_id: "chat", connection_subject: "chat", capability_ceiling: CAPS });
    const record = context.authority.submitHumanEvent(eventInput(external.external_session_id));
    expect(record.workspace_id).toBe(context.coordinator.workspaceId);
    expect(record.entry).toBe("cli-console");
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM human_authorization_events").get()).toMatchObject({ n: 1 });
    expect(context.authority.submitHumanEvent(eventInput(external.external_session_id))).toEqual(record);
    expect(context.authority.submitHumanEvent(eventInput(external.external_session_id, { recorded_at: "2026-10-24T09:30:00Z", entry: "gui-confirm" }))).toEqual(record);
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM human_authorization_events").get()).toMatchObject({ n: 1 });
    expect(() => context.authority.submitHumanEvent(eventInput(external.external_session_id, { capabilities: ["documents.propose"] }))).toThrowError(/changed content/i);
  });
  it("binds the event to the registered session identity and rejects mismatch, unknown session and contract violations", async () => {
    const context = await setup();
    context.adapter.seedExternalSession("chat", "chat");
    const external = await context.authority.register({ host_session_id: "chat", connection_subject: "chat", capability_ceiling: CAPS });
    for (const overrides of [{ host_session_id: "other" }, { connection_subject: "someone-else" }, { entry: "chat-message" }, { inherit: "latest" }, { recorded_at: "not-a-time" }]) {
      expect(() => context.authority.submitHumanEvent(eventInput(external.external_session_id, overrides))).toThrowError();
    }
    expect(() => context.authority.submitHumanEvent(eventInput("ext-missing"))).toThrowError(/unavailable/);
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM human_authorization_events").get()).toMatchObject({ n: 0 });
  });
  it("wires the store-backed source into adapters that attest human events and completes the recordHuman chain", async () => {
    const adapter = new StoreReading();
    const context = await setup(adapter);
    expect(adapter.wired).toBe(true);
    context.adapter.seedExternalSession("chat", "chat");
    const external = await context.authority.register({ host_session_id: "chat", connection_subject: "chat", capability_ceiling: CAPS });
    context.authority.submitHumanEvent(eventInput(external.external_session_id, { capabilities: ["documents.read"] }));
    const auth = await context.authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: "confirm-001" });
    expect(auth.source).toMatchObject({ kind: "human-event", event_ref: "confirm-001" });
    expect(context.store.prepare("SELECT COUNT(*) AS n FROM role_authorizations").get()).toMatchObject({ n: 1 });
  });
  it("exposes the read view independently and returns null for unknown references", async () => {
    const context = await setup();
    const source = storeHumanAuthorizationSource(context.store);
    expect(await source.readEvent("chat", "nothing")).toBeNull();
    context.adapter.seedExternalSession("chat", "chat");
    const external = await context.authority.register({ host_session_id: "chat", connection_subject: "chat", capability_ceiling: CAPS });
    const stored: HumanAuthorizationEventRecord = context.authority.submitHumanEvent(eventInput(external.external_session_id));
    expect(await source.readEvent("chat", "confirm-001")).toEqual(stored);
    expect(await source.readEvent("other-host", "confirm-001")).toBeNull();
  });
});

describe("G-min owner confirmation surface read view", () => {
  it("lists registered sessions with their live authorization summary and grants nothing", async () => {
    const context = await setup(new StoreReading());
    expect(context.authority.listExternalSessions()).toEqual([]);
    context.adapter.seedExternalSession("chat", "chat");
    const external = await context.authority.register({ host_session_id: "chat", connection_subject: "chat", capability_ceiling: CAPS });
    const listed = context.authority.listExternalSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.session).toMatchObject({ external_session_id: external.external_session_id, host_session_id: "chat" });
    expect(listed[0]!.active_authorization).toBeNull();
    context.authority.submitHumanEvent(eventInput(external.external_session_id));
    const auth = await context.authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: "confirm-001" });
    const after = context.authority.listExternalSessions()[0]!;
    expect(after.active_authorization).toMatchObject({ authorization_id: auth.authorization_id, role_id: "builder" });
    await context.authority.revoke({ authorization_id: auth.authorization_id });
    expect(context.authority.listExternalSessions()[0]!.active_authorization).toBeNull();
  });
});
