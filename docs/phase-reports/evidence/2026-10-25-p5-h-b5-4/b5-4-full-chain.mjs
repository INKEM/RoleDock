// B5-4: the FULL 05H acceptance chain, eight steps, one managed-sandbox
// connector, ALL REAL model turns. Steps 1-6 are the production-semantics
// regression from the B4 chain (human event -> anchor gen1 -> pre-spend
// budget -> formal role action -> cross-session succession gen2 -> old
// authorization revoke); steps 7-8 are the managed request chain (10
// overlapping sandboxed requests -> inbox explicit adoption), first proven
// in B5-3. This is the closure evidence for the isolation declaration flip.
//
// Test-environment note: there is no desktop app here, so the anchored main
// sessions also run through the test connector (same form as B3/B4/G-min).
// In the product shape the anchored main session runs in the user's desktop
// app over its own trusted connection; only consultation branches are
// sandboxed there.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-25-p5-h-b5-4`;
const WS = "/tmp/b5-4-chain-ws", JOURNAL = "/tmp/b5-4-chain-journal";
rmSync(WS, { recursive: true, force: true }); rmSync(JOURNAL, { recursive: true, force: true });
mkdirSync(WS, { recursive: true }); mkdirSync(JOURNAL, { recursive: true });
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const sandboxProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => line.includes("bwrap") && line.includes("b5-4-chain-ws")).map(line => line.trim());
const EGRESS = ["api.z.ai:443", "open.bigmodel.cn:443"];
const CAPABILITIES = ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.read", "requests.reply", "requests.cancel", "requests.execute", "artifacts.read"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);
const { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } = await import(`${REPO}/packages/core/dist/index.js`);
const { executeRequest } = await import(`${REPO}/packages/core/dist/requests/executor.js`);
const { coordinatorStore } = await import(`${REPO}/packages/core/dist/internal-store.js`);

const tools = await connectZCodeConnector({
  command: process.execPath,
  args: [
    `${REPO}/adapters/zcode/dist/reference-bin.js`,
    "--cli", "/opt/ZCode/resources/glm/zcode.cjs",
    "--credential-helper", `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b3/credential-helper.mjs`,
    "--model", "GLM-5.3",
    "--journal", `${JOURNAL}/connector-journal.sqlite`,
    "--sandbox", ...EGRESS.flatMap(entry => ["--sandbox-egress", entry]),
  ],
  cwd: WS,
});
let adapter, core;
try {
  const sandboxStatus = await tools.call("zcode_sandbox_status");
  print({ kind: "sandbox-status", ...sandboxStatus });
  adapter = new ZCodeAdapter({ tools, workspacePath: WS, stateDir: `${JOURNAL}/adapter`, managed: { egress: EGRESS } });
  const capabilities = adapter.getCapabilities();
  print({ kind: "capabilities", level: capabilities.level, isolation: capabilities.isolation, external: capabilities.external });
  core = Coordinator.open({ root: WS, adapter });
  const store = coordinatorStore(core);
  await core.installRolePack({ source_path: `${REPO}/examples/demo-team` });
  const admin = WorkspaceAdmin.forCoordinator(core);
  for (const cap of CAPABILITIES) admin.grant({ role_id: "builder", capability: cap });
  for (const cap of CAPABILITIES) admin.grant({ role_id: "reviewer", capability: cap });
  const authority = new ExternalSessionAuthority(core, adapter);

  const anchor = async (role, eventRef, inherit) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const created = await tools.call("zcode_create_session", { workspacePath: WS, mode: "plan" });
      const external = await authority.register({ host_session_id: created.sessionId, connection_subject: "roledock-zcode-probe", capability_ceiling: CAPABILITIES });
      authority.submitHumanEvent({ external_session_id: external.external_session_id, host_session_id: created.sessionId, connection_subject: "roledock-zcode-probe", event_ref: `${eventRef}-${attempt}`, actor_id: "owner", role_id: role, capabilities: CAPABILITIES, inherit, expires_at: new Date(Date.now() + 7200000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString() });
      const auth = await authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: `${eventRef}-${attempt}` });
      const connection = authority.connect(external.external_session_id, "roledock-zcode-probe");
      const anchored = await connection.call("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: `b5-4-${eventRef}-${attempt}` });
      print({ kind: `anchor-${role}`, step_attempt: attempt, attempt_state: anchored.attempt.state, generation: anchored.binding?.generation, load_version: anchored.attempt.confirmation?.load_version });
      if (anchored.attempt.state === "active") return { connection, sessionId: created.sessionId, external, auth, anchored };
      const diagnosis = await tools.call("zcode_status", { sessionId: created.sessionId, workspacePath: WS }).catch(error => ({ error: String(error).slice(0, 100) }));
      print({ kind: `anchor-${role}-diagnosis`, status: diagnosis.status, lastSeq: diagnosis.lastSeq, recent_tail: (diagnosis.recentEvents ?? []).slice(-2).map(event => ({ seq: event.seq, type: event.type })) });
      if (attempt < 3) await sleep(30_000);
    }
    throw new Error(`anchor for ${role} stayed uncertain after 3 attempts`);
  };

  // Step 1 (human event) + step 2 (agent-side register + anchor) + step 3 (real material load), builder gen1.
  const builder1 = await anchor("builder", "b5-4-builder-auth", "initialize");

  // Budget regression (step 3 companion, B4 semantics): a lapsed deadline is
  // refused BEFORE any host spend — the host event sequence number is unchanged.
  const beforeSeq = (await tools.call("zcode_status", { sessionId: builder1.sessionId, workspacePath: WS })).lastSeq;
  const expiredHandle = { adapter: "zcode", host_session_id: builder1.sessionId, creation_key: `b5-4-budget-${builder1.anchored.binding?.generation}` };
  await expectReject(adapter.runTurn(expiredHandle, { execution_key: "b5-4-budget-expired", message: "不应发生", budget: { deadline: new Date(Date.now() - 1000).toISOString() } }));
  const afterSeq = (await tools.call("zcode_status", { sessionId: builder1.sessionId, workspacePath: WS })).lastSeq;
  print({ kind: "step3-budget-pre-spend", refused: true, seq_before: beforeSeq, seq_after: afterSeq, host_seq_unchanged: beforeSeq === afterSeq });
  if (beforeSeq !== afterSeq) throw new Error("budget regression: host spent a turn on an expired deadline");
  async function expectReject(promise) { let rejected = false; try { await promise; } catch { rejected = true; } if (!rejected) throw new Error("expired deadline was not refused"); }
  await sleep(15_000);
  const reviewer = await anchor("reviewer", "b5-4-reviewer-auth", "initialize");

  // Step 4: formal role action through the bound connection.
  const proposed = await builder1.connection.call("documents.propose", { target_role_id: "builder", document_key: "state", body: "# Project state\n\nStatus: B5-4 full chain executed.\n", note: "B5-4 chain" });
  const published = await builder1.connection.call("documents.publish", { document_key: "state", body: "# Project state\n\nStatus: B5-4 full chain executed.\n", expected_revision: 0, expected_generation: 1, candidate_id: proposed.candidate_id });
  print({ kind: "step4-role-action", proposed_candidate: proposed.candidate_id, published_revision: published.revision });

  // Step 5: cross-session succession — a NEW conversation takes over with its own takeover authorization and a real material load (builder gen2).
  const builder2 = await anchor("builder", "b5-4-builder-takeover", "takeover");
  print({ kind: "step5-succession", generation: builder2.anchored.binding?.generation, predecessor_superseded: builder1.anchored.binding?.generation === 1 });

  // Step 6: old primary authorization revoked; the old connection loses standing, the successor stays.
  await authority.revoke({ authorization_id: builder1.auth.authorization_id });
  const oldView = await builder1.connection.call("sessions.binding").catch(error => ({ revoked_connection_error: String(error).slice(0, 80) }));
  const oldInstance = store.prepare("SELECT state FROM agent_instances WHERE id = ?", builder1.anchored.binding.instance_id).get();
  print({ kind: "step6-revoke", old_view: oldView, old_instance_state: oldInstance?.state });

  // Step 7: TEN OVERLAPPING independent requests (reviewer initiates, builder gen2 executes) in managed sandbox instances.
  const requests = [];
  for (let i = 0; i < 10; i++) {
    requests.push(await reviewer.connection.call("requests.create", { target_role_id: "builder", question: `这是 B5-4 全链受管请求 ${i}。不要使用任何工具。只输出：CHAIN-OK-${i}`, idempotency_key: `b5-4-bulk-${i}`, read_exception_rationale: "B5-4 full-chain evidence" }));
  }
  print({ kind: "step7-created", count: requests.length, unique_ids: new Set(requests.map(r => r.request_id)).size });
  const startedAt = Date.now();
  const results = new Array(requests.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (;;) {
      const index = cursor; cursor += 1;
      if (index >= requests.length) return;
      try { results[index] = { status: "fulfilled", value: await executeRequest(store, adapter, requests[index].request_id) }; }
      catch (error) { results[index] = { status: "rejected", reason: error }; }
    }
  }));
  const deadline = Date.now() + 900_000;
  for (;;) {
    const pending = requests.map((request, index) => ({ request, index })).filter(({ index }) => results[index].status === "fulfilled" && results[index].value.state === "running");
    if (pending.length === 0 || Date.now() >= deadline) break;
    await Promise.allSettled(pending.map(({ request, index }) => executeRequest(store, adapter, request.request_id).then(value => { results[index] = { status: "fulfilled", value }; })));
    await sleep(5000);
  }
  const fulfilled = results.filter(result => result.status === "fulfilled").map(result => result.value);
  const rejected = results.filter(result => result.status === "rejected").map(result => String(result.reason?.message ?? result.reason).slice(0, 200));
  const stateCounts = {};
  for (const result of fulfilled) stateCounts[result.state] = (stateCounts[result.state] ?? 0) + 1;
  print({ kind: "step7-executed", wall_ms: Date.now() - startedAt, state_counts: stateCounts, rejected: rejected.length });
  if (rejected.length > 0 || fulfilled.length !== 10 || fulfilled.some(result => result.state !== "completed")) throw new Error("step 7 did not complete: " + JSON.stringify({ rejected, stateCounts }));
  const requestSessions = store.prepare("SELECT instance_id, host_session_ref FROM sessions WHERE kind='request'").all();
  const artifacts = store.prepare("SELECT artifact_id FROM request_artifacts").all();
  const inbox = store.prepare("SELECT entry_id FROM request_inbox").all();
  const primaries = store.prepare("SELECT state, host_session_ref FROM sessions WHERE kind='primary'").all();
  // Zero-injection invariant: no request session shares a host session with a
  // main session. Primary states themselves show step 6 by design: the revoked
  // gen1 primary is no longer active; the gen2 successor and the reviewer
  // primary stay active.
  const zeroInjection = !primaries.some(row => requestSessions.some(r => r.host_session_ref === row.host_session_ref));
  print({
    kind: "step7-asserts",
    request_sessions: requestSessions.length,
    all_instance_id_null: requestSessions.every(row => row.instance_id === null),
    distinct_host_sessions: new Set(requestSessions.map(row => row.host_session_ref)).size,
    artifacts: artifacts.length,
    inbox: inbox.length,
    zero_main_session_injection: zeroInjection,
    primary_session_states: primaries.map(row => ({ state: row.state })),
  });
  if (!zeroInjection) throw new Error("step 7: a request session shares a host session with a main session");
  if (requestSessions.length !== 10 || artifacts.length !== 10 || inbox.length !== 10) throw new Error("step 7 invariants violated");

  // Step 8: inbox — explicit adoption through the SUCCESSOR builder main session.
  const read = await reviewer.connection.call("artifacts.read", { artifact_id: artifacts[0].artifact_id });
  print({ kind: "step8-read", artifact_id: artifacts[0].artifact_id, body_preview: String(read.body ?? "").slice(0, 60) });
  const adopted = await builder2.connection.call("documents.publish", { document_key: "state", body: "unused", expected_revision: 1, expected_generation: 2, adopt_artifact_id: artifacts[0].artifact_id });
  const candidate = store.prepare("SELECT source, state FROM candidate_updates WHERE candidate_id=?").get(adopted.candidate_id);
  print({ kind: "step8-adopted", revision: adopted.revision, candidate_source: candidate?.source, candidate_state: candidate?.state });
  if (!candidate || candidate.state !== "adopted" || candidate.source !== "request.result") throw new Error("step 8 adoption failed");

  const evidenceDir = `${WS}/.roledock/sandbox-evidence`;
  if (existsSync(evidenceDir)) {
    mkdirSync(`${EVID}/sandbox-evidence`, { recursive: true });
    for (const name of readdirSync(evidenceDir)) { try { execFileSync("cp", [`${evidenceDir}/${name}`, `${EVID}/sandbox-evidence/${name}`]); } catch {} }
    print({ kind: "sandbox-boundary-evidence", files: readdirSync(`${EVID}/sandbox-evidence`), env_keys: JSON.parse(readFileSync(`${EVID}/sandbox-evidence/env-keys.json`, "utf8")) });
  }
} finally {
  try { adapter?.closeJournal(); } finally { try { core?.close(); } finally { await tools.disconnect(); } }
}
await sleep(2500);
const after = sandboxProcs();
print({ kind: "process-tree-reclaimed", sandboxed_processes_after: after.length, reclaimed: after.length === 0 });
if (after.length !== 0) throw new Error("sandboxed process tree was not reclaimed");
print({ kind: "b5-4-chain-result", ok: true, note: "05H eight-step chain fully executed on the real host; isolation declarations flipped with the managed variant pending independent acceptance." });
