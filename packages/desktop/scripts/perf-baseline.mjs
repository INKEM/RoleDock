#!/usr/bin/env node
/**
 * P6-G7 performance baseline (DESKTOP_GUI_PLAN §15): seeds the documented
 * data set (50 roles, 200 external sessions, 1000 requests, 1000 document
 * revisions) into a THROWAWAY workspace, then samples the owner read views
 * and records p95/p50 latency, service CPU/memory and startup time.
 * The measured numbers are recorded AS MEASURED — no capacity or budget
 * claims are made. Usage: node scripts/perf-baseline.mjs [out-json]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Coordinator, WorkspaceAdmin, ExternalSessionAuthority } from "@roledock/core";
import { coordinatorStore, installRolePack } from "@roledock/core/testing";
import { MockHarnessAdapter } from "@roledock/adapter-mock";

const outJson = process.argv[2] ?? join(process.cwd(), "docs", "phase-reports", "evidence", "2026-10-28-p6-g7", "perf-baseline.json");
const step = message => process.stderr.write(`[perf] ${message}\n`);
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0; };

const root = mkdtempSync(join(tmpdir(), "roledock-g7-perf-"));
const adapter = new MockHarnessAdapter();
const startupStart = performance.now();
const coordinator = Coordinator.open({ root, adapter });
const startupMs = performance.now() - startupStart;
const store = coordinatorStore(coordinator);
const admin = WorkspaceAdmin.forCoordinator(coordinator);
const authority = new ExternalSessionAuthority(coordinator, adapter);

// -- seed ------------------------------------------------------------------
step("installing role packs (50 roles)");
// Inline minimal pack fixture (mirrors tests/helpers/packs.ts; a script
// cannot import the TS helper outside vitest).
const writePack = (options) => {
  const mk = mkdirSync;
  const wr = writeFileSync;
  mk(join(options.dir, "roles"), { recursive: true });
  mk(join(options.dir, "templates"), { recursive: true });
  const manifestRoles = options.roles.map((role) => ({
    id: role.id,
    title: role.id.toUpperCase(),
    instructions: `roles/${role.id}.md`,
    documents: (role.docs ?? []).map((doc) => ({
      key: doc.key, title: doc.key, template: `templates/${role.id}-${doc.key}.md`, visibility: doc.visibility,
    })),
    requested_capabilities: ["documents.read"],
  }));
  wr(join(options.dir, "rolepack.json"), JSON.stringify({ schema_version: "0.1", name: options.name ?? "tiny-pack", version: options.version ?? "0.1.0", requires_protocol: "0.1", roles: manifestRoles }, null, 2));
  for (const role of manifestRoles) {
    wr(join(options.dir, "roles", `${role.id}.md`), `# ${role.id}\n`);
    for (const doc of role.documents) wr(join(options.dir, "templates", `${role.id}-${doc.key}.md`), `# ${doc.key}\n\nmarker\n`);
  }
  return options.dir;
};
const packDir = join(root, "pack");
writePack({
  dir: packDir,
  name: "g7-perf-pack",
  roles: Array.from({ length: 50 }, (_, index) => ({ id: `role-${String(index).padStart(2, "0")}`, docs: [{ key: "state", visibility: "project" }] })),
});
installRolePack(store, { sourcePath: packDir });
const config = store.getConfig();
for (let index = 0; index < 50; index += 1) config.policy.grants[`role-${String(index).padStart(2, "0")}`] = ["documents.read", "documents.publish", "documents.propose", "requests.create", "requests.execute", "requests.read", "requests.reply", "requests.cancel", "artifacts.read"];
store.setConfig(config);

step("opening the writer primary session");
const writer = await coordinator.openSession({ role_id: "role-00" });

step("publishing 1000 document revisions (10 docs × 100 revisions)");
const publishStart = performance.now();
for (let round = 0; round < 100; round += 1) {
  for (let doc = 0; doc < 10; doc += 1) {
    await coordinator.publishDocument({ session_id: writer.session_id, document_key: "state", body: `role-00 state revision ${round}-${doc} ${"x".repeat(200)}`, expected_revision: round * 10 + doc, expected_generation: writer.generation });
  }
}
const publishMs = performance.now() - publishStart;

step("registering 200 external sessions");
const sessions = [];
for (let index = 0; index < 200; index += 1) {
  const host = `perf-host-${String(index).padStart(3, "0")}`;
  adapter.seedExternalSession(host, host);
  sessions.push(await authority.register({ host_session_id: host, connection_subject: host, capability_ceiling: ["documents.read"] }));
}

step("creating 1000 requests");
const createStart = performance.now();
for (let index = 0; index < 1000; index += 1) {
  await coordinator.createRequest({ session_id: writer.session_id, target_role_id: "role-00", question: `perf request ${index} ${"q".repeat(120)}`, idempotency_key: `perf-${index}`, read_exception_rationale: "perf seed" });
}
const createMs = performance.now() - createStart;

// -- measurement -------------------------------------------------------------
const memory = () => { const usage = process.memoryUsage(); return { rss_mb: Math.round(usage.rss / 1048576), heap_mb: Math.round(usage.heapUsed / 1048576) }; };
const timings = {};
for (const [name, input] of [
  ["documents.list", () => admin.documentList({ limit: 50 })],
  ["requests.listInbox", () => admin.requestInbox({ limit: 50 })],
  ["sessions.listBindings", () => authority.listBindings({ limit: 50 })],
  ["authorizations.confirmations", () => authority.listConfirmations({ limit: 50 })],
  ["checkpoints.list", () => admin.checkpointList({ limit: 50 })],
  ["requests.get", () => admin.requestGet({ request_id: (admin.requestInbox({ limit: 1 })).items[0].request_id })],
]) {
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    const start = performance.now();
    input();
    samples.push(performance.now() - start);
  }
  timings[name] = { p50_ms: Math.round(percentile(samples, 50) * 100) / 100, p95_ms: Math.round(percentile(samples, 95) * 100) / 100, samples: samples.length };
  step(`${name}: p50 ${timings[name].p50_ms}ms p95 ${timings[name].p95_ms}ms`);
}

const result = {
  kind: "perf-baseline",
  measured_at: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, note: "in-process coordinator with the mock adapter; NO model turns" },
  seed: { roles: 50, external_sessions: 200, requests: 1000, document_revisions: 1000, publish_ms: Math.round(publishMs), request_create_ms: Math.round(createMs) },
  service_startup_ms: Math.round(startupMs),
  process_memory: memory(),
  read_view_timings: timings,
  targets: { note: "plan §15 initial targets (p95≤500ms local query, page update ≤3s) are REFERENCE ONLY — the numbers above are measured as-is on this machine and make no capacity claim", p95_target_ms: 500 },
};
writeFileSync(outJson, JSON.stringify(result, null, 2) + "\n");
step(`written: ${outJson}`);
coordinator.close();
rmSync(root, { recursive: true, force: true });
const failing = Object.entries(timings).filter(([, value]) => value.p95_ms > 500);
if (failing.length > 0) step(`NOTE: p95 > 500ms reference target for: ${failing.map(([name]) => name).join(", ")} (recorded, not a failure)`);
