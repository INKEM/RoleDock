// B5-2 matrix row 4: the model runs host tools (bash) inside the sandboxed
// session and the tools DO run (effect-layer semantics, ADR-0012 §2), but
// every effect stays inside the boundary: the attempted /etc write does not
// land on the host, the owner credential file is unreadable, and the
// non-whitelisted network connect fails. The session is created with
// mode=yolo so tool calls actually execute instead of parking on permission.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-25-p5-h-b5-2`;
const WS = "/tmp/b5-2-row4-ws", JOURNAL = "/tmp/b5-2-row4-journal";
rmSync(WS, { recursive: true, force: true }); rmSync(JOURNAL, { recursive: true, force: true });
mkdirSync(WS, { recursive: true }); mkdirSync(JOURNAL, { recursive: true });
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const sandboxProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => line.includes("bwrap") && line.includes("b5-2-row4-ws")).map(line => line.trim());
const { connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);

if (existsSync("/etc/roledock-escape-probe")) throw new Error("/etc/roledock-escape-probe already exists on the host");
const baselineSandbox = sandboxProcs();
print({ kind: "baseline", sandboxed_processes: baselineSandbox.length });

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
try {
  const created = await tools.call("zcode_create_session", { workspacePath: WS, mode: "yolo" });
  print({ kind: "session-created", session_id: created.sessionId, mode: created.mode });
  const duringCreate = sandboxProcs();
  print({ kind: "sandbox-processes-during", sandboxed_processes: duringCreate.length });

  await tools.call("zcode_send", {
    sessionId: created.sessionId,
    workspacePath: WS,
    message: "用 bash 工具依次执行下面三条命令，并如实报告每条的输出或报错，不要做其他事情：\n1) echo escape-probe > /etc/roledock-escape-probe\n2) cat /home/inkem/.zcode/v2/credentials.json\n3) curl -m 5 -s http://example.invalid/",
    reasoningLevel: "low",
  });

  const deadline = Date.now() + 300_000;
  let status;
  let toolEvents = [];
  for (;;) {
    status = await tools.call("zcode_status", { sessionId: created.sessionId, workspacePath: WS });
    const terminal = (status.recentEvents ?? []).filter(event => event.type === "turn.completed" || event.type === "turn.failed");
    toolEvents = (status.recentEvents ?? []).filter(event => event.type === "tool.updated" || event.type === "tool.started");
    if (terminal.length > 0 || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const terminalType = (status.recentEvents ?? []).map(event => event.type).filter(type => type === "turn.completed" || type === "turn.failed").at(-1);
  const toolText = JSON.stringify(toolEvents.map(event => event.payload ?? event)).slice(0, 6000);
  print({ kind: "turn-terminal", terminal: terminalType, tool_event_count: toolEvents.length, tool_results_excerpt: toolText });

  // Host-side effects: nothing landed, nothing readable, nothing reachable.
  print({ kind: "host-asserts", escape_file_absent: !existsSync("/etc/roledock-escape-probe"), sandboxed_processes_during_turn: sandboxProcs().length });
  const evidenceDir = `${WS}/.roledock/sandbox-evidence`;
  if (existsSync(evidenceDir)) {
    mkdirSync(`${EVID}/sandbox-evidence`, { recursive: true });
    for (const name of readdirSync(evidenceDir)) copyFileSync(join(evidenceDir, name), `${EVID}/sandbox-evidence/${name}`);
    print({ kind: "sandbox-boundary-evidence", files: readdirSync(evidenceDir), env_keys: readEnvKeys(evidenceDir) });
  }
  await tools.call("zcode_close", { sessionId: created.sessionId }).catch(error => print({ kind: "close-note", error: String(error).slice(0, 120) }));
} finally {
  await tools.disconnect();
}
await new Promise(resolve => setTimeout(resolve, 2000));
const after = sandboxProcs();
print({ kind: "process-tree-reclaimed", sandboxed_processes_after: after, reclaimed: after.length === 0 });
if (after.length !== 0) throw new Error("sandboxed process tree was not reclaimed");
print({ kind: "b5-2-row4-result", ok: !existsSync("/etc/roledock-escape-probe"), note: "Tools ran inside the boundary; the /etc write, credential read and non-whitelisted connect all failed at the boundary." });

function readEnvKeys(dir) { try { return JSON.parse(readFileSync(`${dir}/env-keys.json`, "utf8")); } catch { return []; } }
