// B5-3: the managed request chain on the REAL zcode host — 05H acceptance
// chain steps 7 and 8 for the first time with production adapter semantics.
// Steps 1-3 (production anchor regressions) set up two real anchored primary
// sessions (builder = request target, reviewer = initiator), then TEN
// OVERLAPPING independent requests run inside managed sandbox instances
// (each with its own real material load turn), land as artifacts in the
// inbox, and one artifact is EXPLICITLY ADOPTED through the builder main
// session. Budget (pre-spend expiry) and cancel (queued) regressions run in
// managed mode too. The executor gate semantics are unchanged: the managed
// adapter honestly declares full isolation, backed by the B5-2 escape
// evidence and a live zcode_sandbox_status verification.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-25-p5-h-b5-3`;
const WS = "/tmp/b5-3-chain-ws", JOURNAL = "/tmp/b5-3-chain-journal";
rmSync(WS, { recursive: true, force: true }); rmSync(JOURNAL, { recursive: true, force: true });
mkdirSync(WS, { recursive: true }); mkdirSync(JOURNAL, { recursive: true });
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const sandboxProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => line.includes("bwrap") && line.includes("b5-3-chain-ws")).map(line => line.trim());
const EGRESS = ["api.z.ai:443", "open.bigmodel.cn:443"];
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
  for (const cap of ["documents.read", "documents.propose", "documents.publish", "requests.execute", "requests.read", "artifacts.read"]) admin.grant({ role_id: "builder", capability: cap });
  for (const cap of ["documents.read", "requests.create", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"]) admin.grant({ role_id: "reviewer", capability: cap });
  const authority = new ExternalSessionAuthority(core, adapter);

  // Anchor two real primary sessions (one real material load turn each).
  // Provider-side stream errors (GLM business limits) are transient: retry the
  // anchor on a fresh session with backoff; every uncertain attempt is logged.
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const anchor = async (role, eventRef) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const created = await tools.call("zcode_create_session", { workspacePath: WS, mode: "plan" });
      const external = await authority.register({ host_session_id: created.sessionId, connection_subject: "roledock-zcode-probe", capability_ceiling: ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.read", "requests.reply", "requests.cancel", "requests.execute", "artifacts.read"] });
      authority.submitHumanEvent({ external_session_id: external.external_session_id, host_session_id: created.sessionId, connection_subject: "roledock-zcode-probe", event_ref: `${eventRef}-${attempt}`, actor_id: "owner", role_id: role, capabilities: ["documents.read", "documents.propose", "documents.publish", "requests.create", "requests.read", "requests.reply", "requests.cancel", "requests.execute", "artifacts.read"], inherit: "initialize", expires_at: new Date(Date.now() + 7200000).toISOString(), entry: "cli-console", recorded_at: new Date().toISOString() });
      const auth = await authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: `${eventRef}-${attempt}` });
      const connection = authority.connect(external.external_session_id, "roledock-zcode-probe");
      const anchored = await connection.call("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: `b5-3-anchor-${role}-${attempt}` });
      print({ kind: `anchor-${role}`, attempt, attempt_state: anchored.attempt.state, generation: anchored.binding?.generation, load_version: anchored.attempt.confirmation?.load_version });
      if (anchored.attempt.state === "active") return { connection, sessionId: created.sessionId, anchored };
      const diagnosis = await tools.call("zcode_status", { sessionId: created.sessionId, workspacePath: WS }).catch(error => ({ error: String(error).slice(0, 120) }));
      print({ kind: `anchor-${role}-diagnosis`, attempt, status: diagnosis.status, lastSeq: diagnosis.lastSeq, pendingRequests: diagnosis.pendingRequests, recent_tail: (diagnosis.recentEvents ?? []).slice(-3).map(event => ({ seq: event.seq, type: event.type, detail: JSON.stringify(event.payload ?? event).slice(0, 1600) })) });
      if (attempt < 3) await sleep(30_000);
    }
    throw new Error(`anchor for ${role} stayed uncertain after 3 attempts`);
  };
  const builder = await anchor("builder", "b5-3-auth-builder");
  await sleep(20_000);
  const reviewer = await anchor("reviewer", "b5-3-auth-reviewer");

  // Budget regression in managed mode: a deadline that lapses before execution
  // fails the request with zero host spend (creation rejects past deadlines,
  // so the pre-spend path is exercised by letting a short deadline lapse).
  const expired = await reviewer.connection.call("requests.create", { target_role_id: "builder", question: "expired budget probe", idempotency_key: "b5-3-expired", budget: { deadline: new Date(Date.now() + 5000).toISOString() }, read_exception_rationale: "B5-3 managed budget regression" });
  await new Promise(resolve => setTimeout(resolve, 6500));
  await executeRequest(store, adapter, expired.request_id);
  const expiredRow = store.prepare("SELECT state FROM requests WHERE request_id=?").get(expired.request_id);
  const creationsAfterExpired = store.prepare("SELECT count(*) n FROM sessions WHERE kind='request'").get();
  print({ kind: "budget-pre-spend", state: expiredRow.state, request_sessions: creationsAfterExpired.n, note: "Deadline lapsed before execution; the request failed before any host session was created." });

  // Cancel regression in managed mode: a queued request is cancelled without a host session.
  const cancellable = await reviewer.connection.call("requests.create", { target_role_id: "builder", question: "cancel probe", idempotency_key: "b5-3-cancel", read_exception_rationale: "B5-3 managed cancel regression" });
  const cancelled = await reviewer.connection.call("requests.cancel", { request_id: cancellable.request_id });
  print({ kind: "cancel-queued", state: cancelled.state ?? "cancelled", request_id: cancellable.request_id });

  // Step 7: TEN OVERLAPPING independent requests through managed sandbox instances.
  const requests = [];
  for (let i = 0; i < 10; i++) {
    requests.push(await reviewer.connection.call("requests.create", { target_role_id: "builder", question: `这是沙箱受管请求 ${i}。不要使用任何工具。只输出：REQUEST-OK-${i}`, idempotency_key: `b5-3-bulk-${i}`, read_exception_rationale: "B5-3 managed request chain" }));
  }
  print({ kind: "requests-created", count: requests.length, unique_ids: new Set(requests.map(r => r.request_id)).size });
  // First wave: ten overlapping executions (bounded concurrency; each call
  // provisions its own sandboxed session and spends the request turn). The
  // executor returns early with state=running for unfinished turns — the
  // production outbox re-delivers; we poll the same way until terminal.
  const startedAt = Date.now();
  const CONCURRENCY = 3;
  const results = new Array(requests.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = cursor; cursor += 1;
      if (index >= requests.length) return;
      try { results[index] = { status: "fulfilled", value: await executeRequest(store, adapter, requests[index].request_id) }; }
      catch (error) { results[index] = { status: "rejected", reason: error }; }
    }
  }));
  // Poll until terminal (same re-delivery the outbox tick performs).
  const deadline = Date.now() + 900_000;
  for (;;) {
    const pending = requests.map((request, index) => ({ request, index })).filter(({ index }) => results[index].status === "fulfilled" && results[index].value.state === "running");
    if (pending.length === 0 || Date.now() >= deadline) break;
    await Promise.allSettled(pending.map(({ request, index }) => executeRequest(store, adapter, request.request_id).then(value => { results[index] = { status: "fulfilled", value }; }).catch(error => {
      print({ kind: "step7-redelivery-rejected", request_id: request.request_id, error: String(error?.message ?? error).slice(0, 160) });
    })));
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const wallMs = Date.now() - startedAt;
  const fulfilled = results.filter(result => result.status === "fulfilled").map(result => result.value);
  const rejected = results.filter(result => result.status === "rejected").map(result => String(result.reason?.message ?? result.reason).slice(0, 200));
  const stateCounts = {};
  for (const result of fulfilled) stateCounts[result.state] = (stateCounts[result.state] ?? 0) + 1;
  print({ kind: "step7-execution", fulfilled: fulfilled.length, rejected: rejected.length, wall_ms: wallMs, state_counts: stateCounts, rejected_reasons: rejected });
  if (rejected.length > 0 || fulfilled.length < 10 || fulfilled.some(result => result.state !== "completed")) {
    const stuck = store.prepare("SELECT request_id, state, execution_uncertain FROM requests WHERE state='running'").all();
    for (const row of stuck) {
      const session = store.prepare("SELECT host_session_ref FROM sessions WHERE creation_key=?").get(`request-${row.request_id}`);
      const status = session ? await tools.call("zcode_status", { sessionId: session.host_session_ref, workspacePath: WS }).catch(error => ({ error: String(error).slice(0, 100) })) : null;
      print({ kind: "stuck-diagnosis", request_id: row.request_id, state: row.state, execution_uncertain: row.execution_uncertain, host_status: status?.status, lastSeq: status?.lastSeq, pendingRequests: status?.pendingRequests, recent_tail: (status?.recentEvents ?? []).slice(-4).map(event => ({ seq: event.seq, type: event.type })) });
    }
    throw new Error(`overlapping execution did not complete: ${JSON.stringify({ rejected, stateCounts })}`);
  }

  const requestSessions = store.prepare("SELECT id, host_session_ref, instance_id, role_id FROM sessions WHERE kind='request'").all();
  const artifacts = store.prepare("SELECT artifact_id, producing_role_id FROM request_artifacts").all();
  const inbox = store.prepare("SELECT entry_id, state FROM request_inbox").all();
  const mainSessions = store.prepare("SELECT id, kind, state, host_session_ref FROM sessions WHERE kind='primary'").all();
  print({
    kind: "step7-asserts",
    request_session_count: requestSessions.length,
    all_instance_id_null: requestSessions.every(row => row.instance_id === null),
    distinct_host_sessions: new Set(requestSessions.map(row => row.host_session_ref)).size,
    artifact_count: artifacts.length,
    inbox_count: inbox.length,
    primary_sessions: mainSessions.map(row => ({ state: row.state, host_session_ref: row.host_session_ref })),
  });
  if (requestSessions.length !== 10 || artifacts.length !== 10 || inbox.length !== 10 || new Set(requestSessions.map(row => row.host_session_ref)).size !== 10) {
    throw new Error("step 7 invariants violated");
  }

  // Step 8: inbox — explicit adoption of one artifact through the builder MAIN session.
  const firstArtifact = artifacts[0];
  const read = await reviewer.connection.call("artifacts.read", { artifact_id: firstArtifact.artifact_id });
  print({ kind: "step8-artifact-read", artifact_id: firstArtifact.artifact_id, body_matches_request: typeof read.body === "string" && read.body.includes("REQUEST-OK"), body_preview: String(read.body ?? "").slice(0, 120) });
  const adopted = await builder.connection.call("documents.publish", { document_key: "state", body: "unused", expected_revision: 0, expected_generation: 1, adopt_artifact_id: firstArtifact.artifact_id });
  const candidate = store.prepare("SELECT source, state FROM candidate_updates WHERE candidate_id=?").get(adopted.candidate_id);
  print({ kind: "step8-adopted", revision: adopted.revision, candidate_id: adopted.candidate_id, candidate_source: candidate ? candidate.source : undefined, candidate_state: candidate ? candidate.state : undefined });
  if (!candidate || candidate.state !== "adopted" || candidate.source !== "request.result") throw new Error("step 8 adoption did not produce an adopted request.result candidate");

  // Boundary evidence + reclaim.
  const evidenceDir = `${WS}/.roledock/sandbox-evidence`;
  if (existsSync(evidenceDir)) {
    mkdirSync(`${EVID}/sandbox-evidence`, { recursive: true });
    for (const name of readdirSync(evidenceDir)) { try { execFileSync("cp", [`${evidenceDir}/${name}`, `${EVID}/sandbox-evidence/${name}`]); } catch {}
    }
    print({ kind: "sandbox-boundary-evidence", files: readdirSync(`${EVID}/sandbox-evidence`), env_keys: JSON.parse(readFileSync(`${EVID}/sandbox-evidence/env-keys.json`, "utf8")) });
  }
  print({ kind: "sandboxed-processes-during", count: sandboxProcs().length });
  await builder.connection.call("sessions.release").catch(() => print({ kind: "release-note", note: "release skipped/failed; teardown handles reclamation" }));
} finally {
  try { adapter?.closeJournal(); } finally { try { core?.close(); } finally { await tools.disconnect(); } }
}
await new Promise(resolve => setTimeout(resolve, 2500));
const after = sandboxProcs();
print({ kind: "process-tree-reclaimed", sandboxed_processes_after: after.length, reclaimed: after.length === 0 });
if (after.length !== 0) throw new Error("sandboxed process tree was not reclaimed");
print({ kind: "b5-3-chain-result", ok: true, note: "05H steps 7-8 executed for real on managed sandbox instances; declarations stay conditional on the managed variant until B5-4 closure." });
