// B5-1: managed sandbox execution on the REAL zcode host. The app-server
// child runs inside a bubblewrap sandbox (own user/pid/net/ipc/uts
// namespaces); egress is restricted to the two provider endpoint hosts via
// fake-loopback hosts pinning + a Unix-socket forwarder. One real model turn
// completes inside the sandbox; boundary evidence (env keys, mountinfo) is
// collected by the in-sandbox supervisor; the whole process tree must be
// reclaimed after disconnect. No owner credentials enter the sandbox.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b5-1`;
const WS = "/tmp/b5-1-chain-ws", JOURNAL = "/tmp/b5-1-chain-journal";
rmSync(WS, { recursive: true, force: true }); rmSync(JOURNAL, { recursive: true, force: true }); mkdirSync(WS, { recursive: true }); mkdirSync(JOURNAL, { recursive: true });
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const sandboxProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => line.includes("bwrap") && line.includes("b5-1-chain-ws")).map(line => line.trim());
const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);

const baselineSandbox = sandboxProcs();
print({ kind: "process-baseline", sandboxed_processes: baselineSandbox.length });

const tools = await connectZCodeConnector({
  command: process.execPath,
  args: [
    `${REPO}/adapters/zcode/dist/reference-bin.js`,
    "--cli", "/opt/ZCode/resources/glm/zcode.cjs",
    "--credential-helper", `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b3/credential-helper.mjs`,
    "--model", "GLM-5.3",
    "--journal", `${JOURNAL}/connector-journal.sqlite`,
    "--sandbox",
    "--sandbox-egress", "api.z.ai:443",
    "--sandbox-egress", "open.bigmodel.cn:443",
  ],
  cwd: WS,
});
let adapter;
try {
  adapter = new ZCodeAdapter({ tools, workspacePath: WS, stateDir: `${JOURNAL}/adapter` });
  const capabilities = adapter.getCapabilities();
  print({ kind: "capabilities", level: capabilities.level, isolation: capabilities.isolation, note: "Isolation declarations stay false in B5-1; this chain is technical validation only." });

  const running = sandboxProcs();
  print({ kind: "sandbox-launched", sandboxed_processes: running });

  const handle = await adapter.createSession({ creation_key: "b5-1-sandbox-bare" });
  print({ kind: "bare-session-created", host_session_id: handle.host_session_id });

  await adapter.runTurn(handle, { execution_key: "b5-1-sandbox-turn", message: "这是沙箱受管执行的技术验证轮。不要使用任何工具。只输出：SANDBOX-MODEL-TURN-OK", budget: { max_turns: 1, max_output_bytes: 2048, deadline: new Date(Date.now() + 300000).toISOString() } });
  const deadline = Date.now() + 300000;
  let result;
  for (;;) {
    result = await adapter.getResult(handle);
    if (result.completed) break;
    if (result.needs_input || Date.now() >= deadline) throw new Error(`Turn did not complete: ${JSON.stringify({ state: result.state, needs_input: result.needs_input })}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const answerOk = typeof result.body === "string" && result.body.includes("SANDBOX-MODEL-TURN-OK");
  print({ kind: "sandbox-model-turn", completed: result.completed, turn_count: result.turn_count, execution_key: result.execution_key, answer_confirmed: answerOk, body_preview: String(result.body ?? "").slice(0, 200) });

  const status = await tools.call("zcode_status", { sessionId: handle.host_session_id, workspacePath: WS });
  print({ kind: "host-evidence", model: status.model, mode: status.mode, usage: status.lastTurn?.usage });

  const evidenceDir = `${WS}/.roledock/sandbox-evidence`;
  const entries = readdirSync(evidenceDir);
  const envKeys = JSON.parse(readFileSync(`${evidenceDir}/env-keys.json`, "utf8"));
  const mounts = readFileSync(`${evidenceDir}/mounts.txt`, "utf8").split("\n").filter(line => line.trim());
  const forbiddenMounts = mounts.filter(line => line.includes("credentials") || line.includes("owner-connection"));
  print({
    kind: "sandbox-boundary-evidence",
    evidence_files: entries,
    env_keys: envKeys,
    env_key_count: envKeys.length,
    mount_count: mounts.length,
    mounts: mounts.map(line => line.split(" ")[4] ?? line.slice(0, 60)),
    forbidden_mount_hits: forbiddenMounts,
    note: "env keys only (values never leave the sandbox); mounts list is the in-sandbox mountinfo view of the boundary.",
  });
  mkdirSync(`${EVID}/sandbox-evidence`, { recursive: true });
  for (const file of entries) execFileSync("cp", [`${evidenceDir}/${file}`, `${EVID}/sandbox-evidence/${file}`]);

  const duringTurn = sandboxProcs();
  print({ kind: "process-tree-during", sandboxed_processes: duringTurn.length });
  await adapter.closeSession(handle);
  print({ kind: "session-closed" });
} finally {
  try { adapter?.closeJournal(); } finally { await tools.disconnect(); }
}
await new Promise(resolve => setTimeout(resolve, 2000));
const after = sandboxProcs();
print({ kind: "process-tree-reclaimed", sandboxed_processes_after: after, reclaimed: after.length === 0, baseline: baselineSandbox.length });
if (after.length !== 0) throw new Error("sandboxed process tree was not reclaimed");
print({ kind: "b5-1-chain-result", ok: true });
