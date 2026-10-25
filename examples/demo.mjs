#!/usr/bin/env node
/**
 * RoleDock P5 end-to-end demo (re-runnable, blueprint §3.2).
 *
 * Drives the roledock CLI with --json envelopes through the seven demo steps:
 * publish knowledge, read receipts + isolated consultation requests, session
 * inheritance with unique successor routing, old-instance revocation,
 * cross-adapter knowledge migration, and a brand-new custom role — zero core
 * changes. Requests are executed through the core outbox-drain engine
 * (executeRequest), the same path a production scheduler would drive.
 *
 * Every run creates a FRESH workspace under a temp directory (or --root), so
 * nothing pre-existing is polluted. Machine facts (adapter/host versions,
 * request/artifact/bundle references) are appended as JSONL to demo-log.jsonl
 * inside the workspace; this console output is the human summary. The fixture
 * host has no model: logs say so explicitly.
 *
 * Usage:
 *   node examples/demo.mjs [--adapter mock|bridge] [--root <dir>] [--keep]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "packages", "cli", "dist", "bin.js");
const DEMO_TEAM = join(REPO, "examples", "demo-team");
const CUSTOM_ROLE = join(REPO, "examples", "custom-role");

function parseArgs(argv) {
  const args = { adapter: "bridge", keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--adapter") args.adapter = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
    else throw new Error(`unknown demo argument: ${argv[i]}`);
  }
  if (!["mock", "bridge"].includes(args.adapter)) {
    throw new Error(`--adapter must be "mock" or "bridge" (got "${args.adapter}")`);
  }
  return args;
}

const options = parseArgs(process.argv.slice(2));
const root = options.root ?? mkdtempSync(join(tmpdir(), "roledock-demo-"));
mkdirSync(root, { recursive: true });
const workspaceA = join(root, "ws-a");
const workspaceB = join(root, "ws-b");
const logPath = join(root, "demo-log.jsonl");

function log(entry) {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), adapter: options.adapter, ...entry })}\n`);
}

function cli(args, { session, adapter = options.adapter, root: ws = workspaceA } = {}) {
  const argv = [CLI, "--json", "--root", ws, "--adapter", adapter];
  if (session !== undefined) argv.push("--session", session);
  argv.push(...args);
  const result = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 30000 });
  const source = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
  let envelope;
  try {
    envelope = JSON.parse(source);
  } catch {
    throw new Error(`CLI did not return a JSON envelope for [${args.join(" ")}]: ${source.slice(0, 400)}`);
  }
  if (result.status !== 0 || envelope.ok !== true) {
    throw new Error(`CLI step failed [${args.join(" ")}]: ${JSON.stringify(envelope).slice(0, 400)}`);
  }
  return envelope.data;
}

function write(path, body) {
  writeFileSync(path, body, "utf8");
  return path;
}

async function drainRequest(requestId) {
  // The outbox drain path: the same executor a production scheduler drives.
  const { Coordinator } = await import(join(REPO, "packages", "core", "dist", "index.js"));
  const adapter =
    options.adapter === "bridge"
      ? new (await import(join(REPO, "adapters", "process-bridge", "dist", "index.js"))).ProcessBridgeAdapter({
          stateDir: join(workspaceA, ".roledock", "host-sessions"),
        })
      : new (await import(join(REPO, "adapters", "mock", "dist", "index.js"))).MockHarnessAdapter();
  const coordinator = Coordinator.open({ root: workspaceA, adapter });
  try {
    const { coordinatorStore } = await import(join(REPO, "packages", "core", "dist", "internal-store.js"));
    const { executeRequest } = await import(join(REPO, "packages", "core", "dist", "requests", "executor.js"));
    return await executeRequest(coordinatorStore(coordinator), adapter, requestId);
  } finally {
    coordinator.close();
  }
}

async function adapterFacts() {
  if (options.adapter !== "bridge") {
    const pkg = JSON.parse((await import("node:fs")).readFileSync(join(REPO, "adapters", "mock", "package.json"), "utf8"));
    return { adapter_version: pkg.version, host_version: "n/a (in-memory mock)", model: "none (state mechanics only)" };
  }
  const pkg = JSON.parse((await import("node:fs")).readFileSync(join(REPO, "adapters", "process-bridge", "package.json"), "utf8"));
  const { ProcessBridgeAdapter } = await import(join(REPO, "adapters", "process-bridge", "dist", "index.js"));
  const probe = new ProcessBridgeAdapter({ stateDir: join(root, "adapter-probe") });
  const hostVersion = await probe.hostVersion();
  return { adapter_version: pkg.version, host_version: hostVersion, model: "none (fixed-answer protocol fixture)" };
}

const step = (title) => console.log(`\n== ${title}`);
const facts = await adapterFacts();
console.log(`RoleDock demo — adapter: ${options.adapter} v${facts.adapter_version}, host: ${facts.host_version}`);
console.log(`Workspace A: ${workspaceA}\nWorkspace B: ${workspaceB}`);
log({ step: "start", ...facts, workspace_a: workspaceA, workspace_b: workspaceB });

// -- Step 1: builder opens its first primary session (generation 1). --------
step("1. builder opens its first primary session (generation 1)");
cli(["roles", "install", DEMO_TEAM]);
for (const role of cli(["roles", "list"]).roles) {
  for (const capability of ["documents.read", "documents.publish", "documents.propose", "requests.create", "requests.execute", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"]) {
    cli(["admin", "grant", role.role_id, capability]);
  }
}
const builder1 = cli(["sessions", "open", "builder"]);
if (builder1.generation !== 1) throw new Error(`expected generation 1, got ${builder1.generation}`);
log({ step: 1, session_id: builder1.session_id, instance_id: builder1.instance_id, generation: 1 });
console.log(`   builder session ${builder1.session_id} @ generation 1`);

// -- Step 2: builder publishes versioned knowledge. --------------------------
step("2. builder publishes versioned state and decisions");
const stateV1 = write(join(root, "state-v1.md"), "# State\n\nbuilder v1: the plan is documented here.\n");
const decisions = write(join(root, "decisions.md"), "# Decisions\n\n- demo runs on the bridge adapter\n");
const published = cli(["--session", builder1.session_id, "documents", "publish", "state", stateV1, "0", "1"]);
cli(["--session", builder1.session_id, "documents", "publish", "decisions", decisions, "0", "1"]);
log({ step: 2, state_revision: published.revision, knowledge_revision: published.knowledge_revision });
console.log(`   state r${published.revision}, knowledge_revision ${published.knowledge_revision}`);

// -- Step 3: explainer reads (receipt) and files two isolated requests. ------
step("3. explainer reads, then files two isolated consultation requests");
const explainer = cli(["sessions", "open", "explainer"]);
cli(["--session", explainer.session_id, "documents", "read", "builder", "state"]);
const questionA = write(join(root, "q-a.md"), "How does the state doc evolve?\n");
const questionB = write(join(root, "q-b.md"), "Where are decisions recorded?\n");
const requestA = cli(["--session", explainer.session_id, "requests", "create", "builder", questionA, "demo-req-a"]);
const requestB = cli(["--session", explainer.session_id, "requests", "create", "builder", questionB, "demo-req-b"]);
log({ step: 3, requests: [requestA.request_id, requestB.request_id], bindings: [requestA.binding, requestB.binding] });
console.log(`   ${requestA.request_id} + ${requestB.request_id} accepted at generation ${requestA.binding.target_generation}`);

const outcomeA = await drainRequest(requestA.request_id);
const outcomeB = await drainRequest(requestB.request_id);
if (outcomeA.state !== "completed" || outcomeB.state !== "completed") {
  throw new Error(`requests did not complete: ${JSON.stringify({ outcomeA, outcomeB })}`);
}
const inboxA = cli(["admin", "inbox", "builder"]);
if (inboxA.entries.length !== 2) throw new Error(`expected 2 inbox entries, got ${inboxA.entries.length}`);
log({ step: "3-execute", outcomes: [outcomeA, outcomeB], inbox_entries: inboxA.entries.length });
console.log(`   both completed: artifacts ${outcomeA.artifact_id}, ${outcomeB.artifact_id}; builder inbox has 2 unread entries`);

// -- Step 4: builder inherits as generation 2 (unique latest successor). -----
step("4. builder opens a new primary session — full handoff to generation 2");
const builder2 = cli(["sessions", "open", "builder", "latest"]);
if (builder2.generation !== 2 || builder2.predecessor_instance_id !== builder1.instance_id) {
  throw new Error(`unexpected handoff result: ${JSON.stringify(builder2)}`);
}
log({ step: 4, session_id: builder2.session_id, instance_id: builder2.instance_id, bundle_id: builder2.handoff.bundle_id });
console.log(`   successor ${builder2.session_id} @ generation 2, predecessor ${builder2.predecessor_instance_id}`);

// -- Step 5: routing across the handoff + old instance revocation. -----------
step("5. old request keeps its snapshot; new request binds generation 2; old session cannot publish");
const replayA = await drainRequest(requestA.request_id);
if (replayA.state !== "completed" || replayA.artifact_id !== outcomeA.artifact_id) {
  throw new Error("duplicate delivery must return the original terminal result without another artifact");
}
const stalePublish = spawnSync(
  process.execPath,
  [CLI, "--json", "--root", workspaceA, "--adapter", options.adapter, "--session", builder1.session_id, "documents", "publish", "state", stateV1, "2", "1"],
  { encoding: "utf8", timeout: 30000 },
);
const staleEnvelope = JSON.parse(stalePublish.stderr || stalePublish.stdout);
if (staleEnvelope.ok !== false || staleEnvelope.error.code !== "INVALID_STATE_TRANSITION") {
  throw new Error(`old session publish should be rejected, got: ${JSON.stringify(staleEnvelope)}`);
}
log({ step: 5, duplicate_outcome: replayA.state, replay_artifact_id: replayA.artifact_id, stale_publish_code: staleEnvelope.error.code });
console.log(`   duplicate delivery -> original ${replayA.state} artifact; old session publish -> ${staleEnvelope.error.code}`);

const stateV2 = write(join(root, "state-v2.md"), "# State\n\nbuilder v2, written by generation 2.\n");
const successor = cli(["--session", builder2.session_id, "documents", "read", "builder", "state"]);
cli(["--session", builder2.session_id, "documents", "publish", "state", stateV2, String(successor.revision), "2"]);
const requestC = cli(["--session", explainer.session_id, "requests", "create", "builder", questionA, "demo-req-c"]);
if (requestC.binding.target_generation !== 2) throw new Error(`new request should bind generation 2`);
const outcomeC = await drainRequest(requestC.request_id);
if (outcomeC.state !== "completed") throw new Error(`request C did not complete`);
log({ step: "5-new-request", request_id: requestC.request_id, binding: requestC.binding, outcome: outcomeC.state });
console.log(`   new request ${requestC.request_id} bound to generation 2 and completed`);

// -- Step 6: cross-adapter semantic knowledge migration. ----------------------
step("6. export knowledge from A, import into workspace B (cross-adapter)");
const exportResult = cli(["knowledge", "export", "share"]);
log({ step: 6, export_id: exportResult.export_id, entries: exportResult.entry_count, bundle: exportResult.bundle_dir });
console.log(`   exported ${exportResult.entry_count} shareable document(s) (${exportResult.export_id})`);
const mockAdapter = "mock";
cli(["roles", "install", DEMO_TEAM], { root: workspaceB, adapter: mockAdapter });
const importerB = cli(["knowledge", "import", exportResult.bundle_dir], { root: workspaceB, adapter: mockAdapter });
if (importerB.created_candidates.length !== exportResult.entry_count) {
  throw new Error(`import created ${importerB.created_candidates.length} candidates, expected ${exportResult.entry_count}`);
}
log({ step: "6-import", candidates: importerB.created_candidates.length, skipped: importerB.skipped.length });
console.log(`   workspace B (mock adapter) received ${importerB.created_candidates.length} candidate(s), 0 private entries`);

// -- Step 7: a completely different custom role, zero core changes. ----------
step("7. install custom-role (archivist) and open it — no core changes");
cli(["roles", "install", CUSTOM_ROLE]);
const archivist = cli(["sessions", "open", "archivist"]);
log({ step: 7, role: "archivist", session_id: archivist.session_id, generation: archivist.generation });
console.log(`   archivist session ${archivist.session_id} @ generation ${archivist.generation}`);

console.log(`\nDEMO PASSED — 7/7 steps on the ${options.adapter} adapter`);
console.log(`Machine log (JSONL): ${logPath}`);
if (!options.keep && !options.root) {
  rmSync(root, { recursive: true, force: true });
  console.log(`(temp workspace cleaned; pass --keep or --root <dir> to inspect)`);
}
