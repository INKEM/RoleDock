// B5-2 matrix row 8: runner lifecycle must fail closed.
// (a) probe unavailable ⇒ NOT_IMPLEMENTED envelope, no spawn;
// (b) broken CLI entry ⇒ honest startup failure, uncertain, no unsandboxed fallback;
// (c) runner dies mid-flight (SIGKILL bwrap during session/create) ⇒ the in-flight
//     call rejects with uncertain AND no unsandboxed zcode process ever appears;
// (d) teardown leaves nothing behind. No model turns are spent in any branch.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-25-p5-h-b5-2`;
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const connectorBin = fileURLToPath(new URL(`${REPO}/adapters/zcode/dist/reference-bin.js`, import.meta.url));
const zcodeProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => /zcode\.cjs app-server/.test(line) && !/bwrap/.test(line)).map(line => line.trim());
const verdicts = [];
const verdict = (attempt, pass, detail) => { verdicts.push({ attempt, pass, detail }); print({ kind: "row8-verdict", attempt, pass, detail }); };

// (a) probe unavailable: real connector binary, diagnostic override, empty PATH so nothing could spawn.
{
  const ws = join(tmpdir(), "b5-2-row8a");
  rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
  const outcome = await new Promise(resolve => {
    execFile(process.execPath, [connectorBin, "--sandbox", "--cli", "/opt/ZCode/resources/glm/zcode.cjs"], { env: { PATH: "/usr/bin:/bin", ROLEDOCK_SANDBOX_PROBE: "unavailable" }, cwd: ws }, (error, stdout, stderr) => resolve({ started: !error, stderr: String(stderr) }));
  });
  const envelope = outcome.stderr.trim().split("\n").filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(value => value !== undefined);
  verdict("(a) probe unavailable → NOT_IMPLEMENTED, refused to start", !outcome.started && envelope?.ok === false && envelope?.error?.code === "NOT_IMPLEMENTED", JSON.stringify(envelope?.error ?? outcome.stderr.slice(0, 120)));
}

// (b) broken CLI entry: sandbox probes fine, the app-server start fails honestly.
{
  const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);
  const ws = "/tmp/b5-2-row8b-ws", journal = "/tmp/b5-2-row8b-journal";
  rmSync(ws, { recursive: true, force: true }); rmSync(journal, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
  let outcome = "no-error";
  const tools = await connectZCodeConnector({
    command: process.execPath,
    args: [connectorBin, "--cli", "/opt/ZCode/resources/glm", "--journal", `${journal}/j.sqlite`, "--sandbox", "--sandbox-egress", "api.z.ai:443"],
    cwd: ws,
  });
  let adapter;
  try {
    adapter = new ZCodeAdapter({ tools, workspacePath: ws, stateDir: `${journal}/adapter` });
    try { await adapter.createSession({ creation_key: "row8-b" }); outcome = "SESSION CREATED (escape!)"; }
    catch (error) { outcome = { code: error.code, uncertain: Boolean(error.details?.uncertain), message: String(error.message).slice(0, 140) }; }
  } finally {
    try { adapter?.closeJournal(); } finally { await tools.disconnect(); }
  }
  verdict("(b) broken CLI → honest uncertain failure, no session", outcome !== "SESSION CREATED (escape!)" && outcome.uncertain === true, JSON.stringify(outcome));
}

// (c) runner dies mid-flight: SIGKILL bwrap while session/create is in flight.
{
  const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);
  const ws = "/tmp/b5-2-row8c-ws", journal = "/tmp/b5-2-row8c-journal";
  rmSync(ws, { recursive: true, force: true }); rmSync(journal, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
  const tools = await connectZCodeConnector({
    command: process.execPath,
    args: [connectorBin, "--cli", "/opt/ZCode/resources/glm/zcode.cjs", "--journal", `${journal}/j.sqlite`, "--sandbox", "--sandbox-egress", "api.z.ai:443", "--sandbox-egress", "open.bigmodel.cn:443"],
    cwd: ws,
  });
  let adapter;
  try {
    adapter = new ZCodeAdapter({ tools, workspacePath: ws, stateDir: `${journal}/adapter` });
    const killer = (async () => {
      for (let i = 0; i < 200; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        try { execFileSync("pkill", ["-9", "-f", "bwrap.*b5-2-row8c-ws"]); } catch {}
        if (i === 40) break; // bounded: stop trying after ~1s, let the rejection surface
      }
    })();
    let outcome = "no-error";
    try { await adapter.createSession({ creation_key: "row8-c" }); outcome = "SESSION CREATED (escape!)"; }
    catch (error) { outcome = { code: error.code, uncertain: Boolean(error.details?.uncertain), message: String(error.message).slice(0, 160) }; }
    await killer;
    const unsandboxed = zcodeProcs();
    verdict("(c) runner killed mid-flight → uncertain, never unsandboxed", outcome !== "SESSION CREATED (escape!)" && outcome.uncertain === true && unsandboxed.length === 0, `${JSON.stringify(outcome)} unsandboxed_zcode_procs=${unsandboxed.length}`);
  } finally {
    try { adapter?.closeJournal(); } finally { await tools.disconnect(); }
  }
}

await new Promise(resolve => setTimeout(resolve, 2000));
const leftovers = zcodeProcs();
verdict("(d) teardown leaves no zcode app-server behind", leftovers.length === 0, `leftover=${leftovers.length}`);
const failed = verdicts.filter(entry => !entry.pass);
print({ kind: "b5-2-row8-result", total: verdicts.length, failed: failed.length, ok: failed.length === 0 });
if (failed.length > 0) { for (const entry of failed) print({ kind: "REWORK-SIGNAL", ...entry }); process.exit(1); }
process.exit(0);
