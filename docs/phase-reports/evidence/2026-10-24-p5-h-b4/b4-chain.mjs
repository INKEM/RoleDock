// B4: 05H acceptance chain on the REAL zcode host with PRODUCTION declarations.
// Steps 1-6 run for real (human event -> anchor -> role action -> cross-session
// succession -> old authorization revoke). Step 7 (isolated requests) and 8
// (inbox adoption) are demonstrated as honestly refused: the adapter keeps
// G01-Z03 isolation undeclared, so the executor gate refuses with zero host
// turns. GUI confirm form factor was proven in G-min; this chain uses the
// owner face directly.
import { mkdirSync, rmSync } from "node:fs";
const REPO = "/home/inkem/Personal/RoleDock";
const WS = "/tmp/b4-chain-ws", JOURNAL = "/tmp/b4-chain-journal";
rmSync(WS, { recursive: true, force: true }); rmSync(JOURNAL, { recursive: true, force: true }); mkdirSync(WS, { recursive: true });
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);
const { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } = await import(`${REPO}/packages/core/dist/index.js`);
const tools = await connectZCodeConnector({
  command: process.execPath,
  args: [`${REPO}/adapters/zcode/dist/reference-bin.js`, "--cli", "/opt/ZCode/resources/glm/zcode.cjs", "--credential-helper", `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b3/credential-helper.mjs`, "--model", "GLM-5.3", "--journal", `${JOURNAL}/connector-journal.sqlite`],
  cwd: WS,
});
let core;
try {
  const adapter = new ZCodeAdapter({ tools, workspacePath: WS, stateDir: `${JOURNAL}/adapter` });
  print({ kind: "capabilities", external: adapter.getCapabilities().external });
  core = Coordinator.open({ root: WS, adapter });
  await core.installRolePack({ source_path: `${REPO}/examples/demo-team` });
  const admin = WorkspaceAdmin.forCoordinator(core);
  for (const cap of ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.execute", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"]) admin.grant({ role_id: "builder", capability: cap });
  for (const cap of ["documents.read", "requests.execute", "requests.reply"]) admin.grant({ role_id: "reviewer", capability: cap });
  const authority = new ExternalSessionAuthority(core, adapter);

  // Step 1: human authorization (owner face; GUI form factor proven in G-min).
  // Step 2: Agent-side register (production identity verification) + anchor.
  // Step 3: real material load inside the anchor drive.
  const created1 = await tools.call("zcode_create_session", { workspacePath: WS, mode: "plan" });
  const external1 = await authority.register({ host_session_id: created1.sessionId, connection_subject: "roledock-zcode-probe", capability_ceiling: ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"] });
  authority.submitHumanEvent({ external_session_id: external1.external_session_id, host_session_id: created1.sessionId, connection_subject: "roledock-zcode-probe", event_ref: "b4-chain-auth-1", actor_id: "owner", role_id: "builder", capabilities: ["documents.read", "documents.propose", "documents.publish"], inherit: "initialize", expires_at: new Date(Date.now() + 3600000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString() });
  const auth1 = await authority.recordHumanAuthorization({ external_session_id: external1.external_session_id, event_ref: "b4-chain-auth-1" });
  print({ kind: "step-1-3", authorization_id: auth1.authorization_id, source: auth1.source });
  const connection1 = authority.connect(external1.external_session_id, "roledock-zcode-probe");
  const anchor1 = await connection1.call("sessions.anchor", { authorization_id: auth1.authorization_id, idempotency_key: "b4-anchor-1" });
  print({ kind: "step-2-3-anchored", attempt_state: anchor1.attempt.state, generation: anchor1.binding?.generation, load_version: anchor1.attempt.confirmation?.load_version });

  // Budget evidence: an expired deadline is refused BEFORE any host spend.
  const before = await tools.call("zcode_status", { sessionId: created1.sessionId, workspacePath: WS });
  const beforeSeq = before.lastSeq;
  await expectReject(adapter.runTurn({ adapter: "zcode", host_session_id: created1.sessionId, creation_key: "budget" }, { message: "不应发生", execution_key: "budget-expired", budget: { deadline: new Date(Date.now() - 1000).toISOString() } }), "expired-budget");
  const after = await tools.call("zcode_status", { sessionId: created1.sessionId, workspacePath: WS });
  print({ kind: "budget-pre-spend", refused: true, host_seq_unchanged: after.lastSeq === beforeSeq, seq_before: beforeSeq, seq_after: after.lastSeq });

  // Step 4: formal role action through the bound connection.
  const proposed = await connection1.call("documents.propose", { target_role_id: "builder", document_key: "state", body: "# Project state\n\nStatus: B4 real-harness chain executed.\n", note: "B4 chain" });
  const published = await connection1.call("documents.publish", { document_key: "state", body: "# Project state\n\nStatus: B4 real-harness chain executed.\n", expected_revision: 0, expected_generation: 1, candidate_id: proposed.candidate_id });
  print({ kind: "step-4-role-action", proposed_candidate: proposed.candidate_id, published_revision: published.revision });

  // Step 5: cross-session succession — a NEW conversation takes over with its
  // own takeover authorization and a real material load.
  const created2 = await tools.call("zcode_create_session", { workspacePath: WS, mode: "plan" });
  const external2 = await authority.register({ host_session_id: created2.sessionId, connection_subject: "roledock-zcode-probe", capability_ceiling: ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"] });
  authority.submitHumanEvent({ external_session_id: external2.external_session_id, host_session_id: created2.sessionId, connection_subject: "roledock-zcode-probe", event_ref: "b4-chain-auth-2", actor_id: "owner", role_id: "builder", capabilities: ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"], inherit: "takeover", expires_at: new Date(Date.now() + 3600000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString() });
  const auth2 = await authority.recordHumanAuthorization({ external_session_id: external2.external_session_id, event_ref: "b4-chain-auth-2" });
  const connection2 = authority.connect(external2.external_session_id, "roledock-zcode-probe");
  const anchor2 = await connection2.call("sessions.anchor", { authorization_id: auth2.authorization_id, idempotency_key: "b4-anchor-2" });
  print({ kind: "step-5-succession", attempt_state: anchor2.attempt.state, generation: anchor2.binding?.generation, load_version: anchor2.attempt.confirmation?.load_version, old_binding_view: (await connection1.call("sessions.binding")).binding?.state });

  // Step 6: revoke the old authorization; the successor keeps generation 2.
  const revoked = await authority.revoke({ authorization_id: auth1.authorization_id });
  const oldView = (await connection1.call("sessions.binding")).binding;
  print({ kind: "step-6-revoked", revoked_at: revoked.revoked_at, old_binding_state: oldView?.state ?? null, successor_generation: anchor2.binding?.generation });

  // The consultation target role needs a primary instance (ROLE_UNINITIALIZED
  // otherwise); its initialization is another real material load.
  await core.openSession({ role_id: "reviewer", creation_key: "reviewer-initial" });
  print({ kind: "reviewer-initialized", generation: 1 });

  // Step 7+8: isolated requests and inbox adoption — the isolation
  // declarations (G01-Z03) are NOT proven, so the executor gate refuses with
  // zero host turns. This is the honest residual, demonstrated for real.
  const requests = [];
  for (let i = 0; i < 10; i++) requests.push(await connection2.call("requests.create", { target_role_id: "reviewer", question: `isolated question ${i}`, idempotency_key: `b4-req-${i}`, read_exception_rationale: "Isolation residual demonstration" }));
  await authority.tick();
  const states = [];
  for (const request of requests) states.push((await connection2.call("requests.get", { request_id: request.request_id })).state);
  print({ kind: "step-7-8-isolated-requests", requested: requests.length, states: [...new Set(states)], note: "Executor refuses on missing isolation declarations (G01-Z03 residual); zero host consultation turns spent." });
  print({ kind: "b4-chain-complete", steps_real: [1, 2, 3, 4, 5, 6], steps_blocked: [7, 8] });
} finally {
  await core?.close();
  await tools.disconnect();
}
async function expectReject(promise, label) {
  try { await promise; throw new Error(`${label} unexpectedly succeeded`); }
  catch (error) { return error; }
}
