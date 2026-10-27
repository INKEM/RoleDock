#!/usr/bin/env node
/**
 * P6-G3 discovery spike: does the app-server `session/list` enumerate
 * persisted workspace sessions across app-server INSTANCES, or only the
 * ones attached to the calling instance? This decides whether the desktop
 * GUI can offer "pick your open ZCode session" from a connector listing,
 * or must use a paste-the-session-reference path (DESKTOP_GUI_PLAN §11.6).
 *
 * Sequence:
 *   A. fresh app-server (instance 1): list -> create sessA -> list (attached)
 *   B. second fresh app-server (instance 2), same cwd/workspace:
 *      list (cross-instance enumeration?) -> read sessA (expect "not active")
 *      -> resume sessA -> list (attached after resume)
 * Zero model turns; no provider bootstrap needed for these methods.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CLI = "/opt/ZCode/resources/glm/zcode.cjs";
const workspace = join(import.meta.dirname, "workspace");
mkdirSync(workspace, { recursive: true });

function client(label) {
  const child = spawn(process.execPath, [CLI, "app-server"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
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
    // Same client-request answers the reference connector gives (reference-connector.ts:195-219);
    // interaction/* requests are parked (never auto-answered), which create/list/read do not need.
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
  child.stderr.on("data", c => process.stderr.write(`[${label}:stderr] ${c}`));
  const call = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const stop = () => new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2000).unref?.(); });
  return { call, stop };
}

const events = [];
const record = (step, value) => { events.push({ step, value }); console.log(`\n=== ${step} ===\n${JSON.stringify(value, null, 2)}`); };
const ws = () => ({ workspacePath: workspace, workspaceKey: workspace });

try {
  const a = client("A");
  const listA0 = await a.call("session/list", { workspace: ws() }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
  record("A1 list before create (instance 1)", listA0);
  const created = await a.call("session/create", { workspace: ws(), mode: "plan", persistence: "immediate" }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
  record("A2 session/create (instance 1)", created);
  const sessA = created.ok ? created.v?.session?.sessionId : null;
  const listA1 = await a.call("session/list", { workspace: ws() }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
  record("A3 list after create, same instance (attached case)", listA1);
  await a.stop();

  if (typeof sessA === "string") {
    const b = client("B");
    const listB0 = await b.call("session/list", { workspace: ws() }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
    record("B1 list on FRESH instance before any attach (cross-instance enumeration?)", listB0);
    const readB = await b.call("session/read", { sessionId: sessA }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
    record("B2 read foreign session without resume (expect not-active per connector comment)", readB);
    const resumeB = await b.call("session/resume", { sessionId: sessA, workspace: ws() }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
    record("B3 resume foreign session (identity oracle path)", resumeB);
    const listB1 = await b.call("session/list", { workspace: ws() }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
    record("B4 list after resume (attached after resume case)", listB1);
    const closed = await b.call("session/close", { sessionId: sessA }).then(v => ({ ok: true, v }), e => ({ ok: false, error: String(e.message) }));
    record("B5 close spike session (footprint cleanup)", closed);
    await b.stop();
  }
  record("SUMMARY", {
    question: "does session/list enumerate persisted workspace sessions across app-server instances?",
    A_listed_before_create: Array.isArray(listA0?.v?.sessions) ? listA0.v.sessions.length : listA0?.error ?? "no sessions field",
    A_created_session: sessA,
    A_listed_after_create_same_instance: Array.isArray(listA1?.v?.sessions) ? listA1.v.sessions.map(s => s?.sessionId) : listA1?.error,
    note: "B-step results above decide the G3 discovery path (zcode_list_sessions tool vs paste-reference UI).",
  });
} catch (error) {
  record("FATAL", { error: String(error?.stack ?? error) });
  process.exitCode = 1;
}
