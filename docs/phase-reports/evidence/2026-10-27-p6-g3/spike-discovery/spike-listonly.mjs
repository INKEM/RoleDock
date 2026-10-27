#!/usr/bin/env node
// P6-G3 discovery spike v3: does a PLAIN session/list on a fresh app-server
// instance (NO resume, NO create) enumerate the workspace's persisted sessions?
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const CLI = "/opt/ZCode/resources/glm/zcode.cjs";
const ROLEDOCK = "/home/inkem/Personal/RoleDock";
const child = spawn(process.execPath, [CLI, "app-server"], { cwd: ROLEDOCK, stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1; const waiting = new Map();
createInterface({ input: child.stdout }).on("line", line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && !msg.method && waiting.has(msg.id)) {
    const { resolve, reject, timer } = waiting.get(msg.id);
    clearTimeout(timer); waiting.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code ?? "?"})`)); else resolve(msg.result);
    return;
  }
  if (msg.method === "session/requestRuntimePreferences") { child.stdin.write(`${JSON.stringify({ id: msg.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } })}\n`); return; }
  if (msg.method === "interaction/requestOfficialMcpAuthHeaders") { child.stdin.write(`${JSON.stringify({ id: msg.id, result: { headers: {} } })}\n`); return; }
  if (msg.method === "interaction/requestProviderRuntimeHeaders") { child.stdin.write(`${JSON.stringify({ id: msg.id, result: { headersApplied: false, errorMessage: "spike" } })}\n`); return; }
});
const call = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
  waiting.set(id, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
try {
  const list = await call("session/list", { workspace: { workspacePath: ROLEDOCK, workspaceKey: ROLEDOCK } });
  const sessions = (list?.sessions ?? []).map(s => ({ sessionId: s?.sessionId, title: s?.title, status: s?.status, kind: s?.sessionKind }));
  console.log(JSON.stringify({ list_without_any_attach: { count: sessions.length, sessions } }, null, 2));
} catch (e) { console.log(JSON.stringify({ list_without_any_attach: { error: String(e.message) } })); }
finally { child.once("exit", () => process.exit(0)); child.kill("SIGTERM"); setTimeout(() => process.exit(0), 2000).unref?.(); }
