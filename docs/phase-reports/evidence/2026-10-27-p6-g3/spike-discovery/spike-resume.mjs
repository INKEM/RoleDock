#!/usr/bin/env node
/**
 * P6-G3 discovery spike v2: can a FRESH app-server instance resume a REAL
 * persisted desktop session (session_<hex> rows in ~/.zcode/cli/db/db.sqlite)?
 * Read-only: resume + read + list only. NO send, NO close, NO model turn.
 * Target: the user's own idle 2026-10-25 RoleDock session.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CLI = "/opt/ZCode/resources/glm/zcode.cjs";
const TARGET = process.argv[2];
const ROLEDOCK = "/home/inkem/Personal/RoleDock";
if (!TARGET || !/^session_[0-9a-f]+$/.test(TARGET)) { console.error("usage: node spike-resume.mjs session_<hex>"); process.exit(2); }

function client(label) {
  const child = spawn(process.execPath, [CLI, "app-server"], { cwd: ROLEDOCK, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method && waiting.has(msg.id)) {
      const { resolve, reject, timer } = waiting.get(msg.id);
      clearTimeout(timer); waiting.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || "error"} (${msg.error.code ?? "?"})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "session/requestRuntimePreferences") {
      child.stdin.write(`${JSON.stringify({ id: msg.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } })}\n`);
      return;
    }
    if (msg.method === "interaction/requestOfficialMcpAuthHeaders") {
      child.stdin.write(`${JSON.stringify({ id: msg.id, result: { headers: {} } })}\n`);
      return;
    }
    if (msg.method === "interaction/requestProviderRuntimeHeaders") {
      child.stdin.write(`${JSON.stringify({ id: msg.id, result: { headersApplied: false, errorMessage: "spike: no credential helper" } })}\n`);
      return;
    }
  });
  const call = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const stop = () => new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); setTimeout(resolve, 2000).unref?.(); });
  return { call, stop };
}

const slim = value => JSON.parse(JSON.stringify(value, (k, v) => (["messages", "slashCommands", "todos", "todoGroups", "settings", "runtime", "protocol"].includes(k) ? undefined : v)));
const ws = () => ({ workspacePath: ROLEDOCK, workspaceKey: ROLEDOCK });

try {
  const a = client("R");
  const resumed = await a.call("session/resume", { sessionId: TARGET, workspace: ws() }).then(v => ({ ok: true, v: slim(v) }), e => ({ ok: false, error: String(e.message) }));
  console.log("=== resume persisted desktop session (read-only) ===\n" + JSON.stringify(resumed, null, 2));
  if (resumed.ok) {
    const read = await a.call("session/read", { sessionId: TARGET }).then(v => ({ ok: true, v: slim(v) }), e => ({ ok: false, error: String(e.message) }));
    console.log("\n=== read (metadata only) ===\n" + JSON.stringify(read, null, 2));
    const list = await a.call("session/list", { workspace: ws() }).then(v => ({ ok: true, sessions: (v?.sessions ?? []).map(s => s?.sessionId) }), e => ({ ok: false, error: String(e.message) }));
    console.log("\n=== list after resume ===\n" + JSON.stringify(list, null, 2));
  }
  await a.stop();
  console.log("\nSUMMARY: " + (resumed.ok
    ? "RESUME-OK: a fresh app-server can attach a persisted desktop session by ID → paste-reference registration path is viable; listing is instance-scoped so GUI uses paste/selected-reference UX."
    : "RESUME-FAILED: " + resumed.error));
} catch (error) {
  console.error("FATAL", error);
  process.exitCode = 1;
}
