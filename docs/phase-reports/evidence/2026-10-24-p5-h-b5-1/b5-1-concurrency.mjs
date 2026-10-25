// B5-1 concurrency smoke: three independent managed sandbox instances run in
// parallel, each with its own connector process, sandbox runtime, egress
// forwarder, workspace and journal. Every instance completes a bare session
// plus one REAL model turn inside its sandbox; afterwards every sandboxed
// process must be reclaimed. This is the "并发 2–3 个沙箱实例烟测" exit
// condition evidence.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b5-1`;
const BASE = "/tmp/b5-1-concurrency";
rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true });
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const sandboxProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => line.includes("bwrap") && line.includes("b5-1-concurrency")).map(line => line.trim());
const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);

const baseline = sandboxProcs();
print({ kind: "process-baseline", sandboxed_processes: baseline.length });

async function runInstance(index) {
  const ws = `${BASE}/ws-${index}`, journal = `${BASE}/journal-${index}`;
  mkdirSync(ws, { recursive: true });
  const tools = await connectZCodeConnector({
    command: process.execPath,
    args: [
      `${REPO}/adapters/zcode/dist/reference-bin.js`,
      "--cli", "/opt/ZCode/resources/glm/zcode.cjs",
      "--credential-helper", `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b3/credential-helper.mjs`,
      "--model", "GLM-5.3",
      "--journal", `${journal}/connector-journal.sqlite`,
      "--sandbox",
      "--sandbox-egress", "api.z.ai:443",
      "--sandbox-egress", "open.bigmodel.cn:443",
    ],
    cwd: ws,
  });
  let adapter;
  try {
    adapter = new ZCodeAdapter({ tools, workspacePath: ws, stateDir: `${journal}/adapter` });
    const handle = await adapter.createSession({ creation_key: `b5-1-concurrent-${index}` });
    await adapter.runTurn(handle, { execution_key: `b5-1-concurrent-turn-${index}`, message: "这是并发沙箱烟测轮。不要使用任何工具。只输出：CONCURRENT-SANDBOX-OK", budget: { max_turns: 1, max_output_bytes: 512, deadline: new Date(Date.now() + 300000).toISOString() } });
    const deadline = Date.now() + 300000;
    let result;
    for (;;) {
      result = await adapter.getResult(handle);
      if (result.completed) break;
      if (result.needs_input || Date.now() >= deadline) throw new Error(`instance ${index}: turn did not complete`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const confirmed = typeof result.body === "string" && result.body.includes("CONCURRENT-SANDBOX-OK");
    const evidence = readdirSync(`${ws}/.roledock/sandbox-evidence`);
    return { index, session: handle.host_session_id, completed: result.completed, answer_confirmed: confirmed, evidence_files: evidence };
  } finally {
    try { adapter?.closeJournal(); } finally { await tools.disconnect(); }
  }
}

const started = Date.now();
const results = await Promise.all([runInstance(1), runInstance(2), runInstance(3)]);
print({ kind: "concurrent-results", instances: results, wall_ms: Date.now() - started });
const allOk = results.every(result => result.completed && result.answer_confirmed);
if (!allOk) throw new Error("concurrency smoke failed: not all instances completed their sandboxed model turn");

await new Promise(resolve => setTimeout(resolve, 3000));
const after = sandboxProcs();
print({ kind: "process-tree-reclaimed", sandboxed_processes_after: after, reclaimed: after.length === 0, baseline: baseline.length });
if (after.length !== 0) throw new Error("sandboxed process trees were not reclaimed");

const envKeys = JSON.parse(readFileSync(`${BASE}/ws-1/.roledock/sandbox-evidence/env-keys.json`, "utf8"));
print({ kind: "b5-1-concurrency-result", ok: true, instances: results.length, env_key_count: envKeys.length });
