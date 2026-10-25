#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "@roledock/core";
import type { AdapterCapabilities } from "@roledock/core";
import { ZCodeAdapter, connectZCodeConnector } from "./index.js";
import { toErrorEnvelope } from "@roledock/protocol";

/**
 * Fixture-scope subclasses for e2e plumbing evidence only.
 * - EventChainProbeAdapter flipped human_authorization_events (B2).
 * - AnchorProbeAdapter flips load_materials/reconcile_load (B3) so core's
 *   anchor drive can run against the real store, adapter and connector. The
 *   production declarations stay false until independent acceptance.
 */
class EventChainProbeAdapter extends ZCodeAdapter {
  override getCapabilities(): AdapterCapabilities {
    const capabilities = super.getCapabilities();
    return { ...capabilities, external: { ...capabilities.external!, human_authorization_events: true } };
  }
}
class AnchorProbeAdapter extends ZCodeAdapter {
  override getCapabilities(): AdapterCapabilities {
    const capabilities = super.getCapabilities();
    return { ...capabilities, external: { ...capabilities.external!, load_materials: true, reconcile_load: true } };
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { connector: { type: "string" }, workspace: { type: "string" }, "state-dir": { type: "string" }, "verify-session": { type: "boolean" }, "human-event": { type: "string" }, "external-session": { type: "string" }, "event-ref": { type: "string" }, "anchor-e2e": { type: "boolean" }, "role-pack": { type: "string" }, "connector-arg": { type: "string", multiple: true } }, strict: true });
  const connector = values.connector, workspace = values.workspace, stateDir = values["state-dir"];
  if (!connector || !workspace || !stateDir || ![connector,workspace,stateDir].every(isAbsolute)) throw new Error("Use --connector <absolute trusted .mjs path> --workspace <absolute diagnostic directory> --state-dir <absolute journal directory>.");
  const checksum = createHash("sha256").update(readFileSync(connector)).digest("hex");
  const tools = await connectZCodeConnector({ command: process.execPath, args: [connector, ...(values["connector-arg"] ?? [])], cwd: workspace });
  let adapter: ZCodeAdapter | undefined;
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value)+"\n");
  try {
    adapter = new ZCodeAdapter({ tools, workspacePath: workspace, stateDir });
    print({ kind: "diagnostic-only", connector_sha256: checksum, connector: tools.server, connector_tools: [...tools.tools].sort(), capabilities: adapter.getCapabilities() });
    if (values["verify-session"]) {
      // Identity-only evidence: one bare session creation, zero model turns.
      const handle = await adapter.createSession({ creation_key: "diagnostic-identity" });
      const verified = await adapter.verifyExternalSession(handle.host_session_id, "roledock-zcode-probe");
      const absent = await adapter.verifyExternalSession("sess_roledock-absent-probe", "roledock-zcode-probe");
      const conflicted = await adapter.verifyExternalSession(handle.host_session_id, "other-subject");
      print({ kind: "identity-verified", host_session_id: handle.host_session_id, subject: "roledock-zcode-probe", verified, absent_session_exists: absent, subject_conflict_confirmed_false: conflicted, note: "Declared since B2; re-run documents live host behavior." });
      return;
    }
    const chain = values["human-event"];
    if (chain === "stage" || chain === "record") {
      const subject = "roledock-zcode-probe";
      if (chain === "stage") {
        const handle = await adapter.createSession({ creation_key: "human-event-e2e" });
        const coordinator = Coordinator.open({ root: workspace, adapter });
        try {
          const external = await new ExternalSessionAuthority(coordinator, adapter).register({ host_session_id: handle.host_session_id, connection_subject: subject, capability_ceiling: ["documents.read"] });
          print({ kind: "human-event-staged", host_session_id: handle.host_session_id, external_session_id: external.external_session_id, subject, capability_ceiling: external.capability_ceiling, note: "Record the trusted-entry confirmation with `roledock admin submit-human-event` before running --human-event record." });
        } finally { coordinator.close(); }
        return;
      }
      const externalSessionId = values["external-session"], eventRef = values["event-ref"];
      if (!externalSessionId || !eventRef) throw new Error("--human-event record needs --external-session <id> --event-ref <ref>.");
      // The record step alone uses the fixture-scope declaration subclass.
      adapter.closeJournal();
      adapter = new EventChainProbeAdapter({ tools, workspacePath: workspace, stateDir });
      const coordinator = Coordinator.open({ root: workspace, adapter });
      try {
        const authorization = await new ExternalSessionAuthority(coordinator, adapter).recordHumanAuthorization({ external_session_id: externalSessionId, event_ref: eventRef });
        print({ kind: "human-event-recorded", authorization_id: authorization.authorization_id, source: authorization.source, role_id: authorization.role_id, capabilities: authorization.capabilities, note: "recordHuman ran over the real store and adapter with a CLI-console-written event; the human_authorization_events declaration was fixture-flipped for this step only." });
      } finally { coordinator.close(); }
      return;
    }
    if (values["anchor-e2e"]) {
      // Real anchor chain (05H steps 1-4): register -> trusted-entry event ->
      // recordHuman -> sessions.anchor with a REAL material load turn. The
      // load declarations are fixture-flipped for this mode only.
      adapter.closeJournal();
      adapter = new AnchorProbeAdapter({ tools, workspacePath: workspace, stateDir });
      const subject = "roledock-zcode-probe";
      const handle = await adapter.createSession({ creation_key: "anchor-e2e" });
      const coordinator = Coordinator.open({ root: workspace, adapter });
      try {
        await coordinator.installRolePack({ source_path: resolve(values["role-pack"] ?? "examples/demo-team") });
        WorkspaceAdmin.forCoordinator(coordinator).grant({ role_id: "builder", capability: "documents.read" });
        const authority = new ExternalSessionAuthority(coordinator, adapter);
        const external = await authority.register({ host_session_id: handle.host_session_id, connection_subject: subject, capability_ceiling: ["documents.read"] });
        authority.submitHumanEvent({ external_session_id: external.external_session_id, host_session_id: handle.host_session_id, connection_subject: subject, event_ref: "anchor-e2e-001", actor_id: "human-user", role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_at: new Date(Date.now() + 3600000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString() });
        const authorization = await authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: "anchor-e2e-001" });
        print({ kind: "anchor-authorized", authorization_id: authorization.authorization_id, source: authorization.source });
        const connection = authority.connect(external.external_session_id, subject);
        const result = await connection.call("sessions.anchor", { authorization_id: authorization.authorization_id, idempotency_key: "anchor-e2e" }) as { attempt: { state: string; confirmation: unknown; error: { code: string; message: string } | null }; binding: { state: string; generation: number; role_id: string } | null };
        print({ kind: "anchor-e2e-result", attempt_state: result.attempt.state, attempt_error: result.attempt.error, confirmation: result.attempt.confirmation, binding: result.binding, note: "The material load ran a real model turn on the registered session; load declarations were fixture-flipped for this mode only." });
      } finally { coordinator.close(); }
      return;
    }
    const handle = await adapter.createSession({ creation_key: "diagnostic-connectivity" });
    print({ kind: "session", handle });
    const prior = await adapter.getResult(handle);
    if (prior.turn_count === 0) await adapter.runTurn(handle, { execution_key: "diagnostic-answer", message: "这是连通性诊断，不是角色授权。不要使用任何工具。只输出：ZCode真实模型可达", budget: { max_turns: 1, max_output_bytes: 512, deadline: new Date(Date.now()+120000).toISOString() } });
    const deadline = Date.now()+120000;
    for (;;) {
      const result = await adapter.getResult(handle);
      if (result.completed) {
        print({ kind: prior.turn_count === 0 ? "actual-model-answer" : "confirmed-prior-answer", result, note: "Not a role anchor, isolated RoleDock request, human event, or host cleanup proof." });
        const status = await tools.call("zcode_status", { sessionId: handle.host_session_id, workspacePath: workspace }) as { model?: unknown; mode?: unknown; lastTurn?: { usage?: unknown } };
        print({ kind: "host-evidence", model: status.model, mode: status.mode, usage: status.lastTurn?.usage });
        break;
      }
      if (result.needs_input || Date.now() >= deadline) throw new Error("Diagnostic needs human input or exceeded its wait deadline; no permissions automatically granted.");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    try { await adapter.closeSession(handle); } catch { print({ kind: "host-cleanup", state: "NOT_IMPLEMENTED", note: "Persisted diagnostic session remains; transport shutdown is separate." }); }
  } finally { try { adapter?.closeJournal(); } finally { await tools.disconnect(); } }
}
main().catch(error => { process.stderr.write(JSON.stringify(toErrorEnvelope(error))+"\n"); process.exitCode = 1; });
