#!/usr/bin/env node
/**
 * G4 真机证据采集：导出 owner 只读视图的后端状态快照。
 * 用法：node collect-state.mjs <工作空间目录> [输出文件=backend-state.json]
 * 前置：该工作空间的 service 正在运行（shell 已打开）。凭据只在本进程使用，不打印。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ServiceClient } from "../../../../packages/service/dist/index.js";

const root = resolve(process.argv[2] ?? "");
if (!root) { console.error("用法: node collect-state.mjs <工作空间目录> [输出文件]"); process.exit(2); }
const out = resolve(process.argv[3] ?? join(root, "backend-state-g4.json"));
const credential = JSON.parse(readFileSync(join(root, ".roledock", "owner-connection.json"), "utf8"));
const owner = new ServiceClient(credential);

const state = { collected_at: new Date().toISOString(), workspace_id: null, external_sessions: null, confirmations: null, bindings: null, attempts: null, loads: null, runtime: null };
state.workspace_id = (await owner.call("workspace.info", {})).workspace_id;
state.runtime = await owner.call("workspace.runtimeStatus", {});
state.external_sessions = await owner.call("externalSessions.list", {});
state.confirmations = await owner.call("authorizations.confirmations", { limit: 200 });
state.bindings = await owner.call("sessions.listBindings", { limit: 200 });
state.attempts = await owner.call("sessions.listAttempts", { limit: 200 });
state.loads = await owner.call("sessions.listLoads", { limit: 200 });
writeFileSync(out, JSON.stringify(state, null, 2));
console.log(`written: ${out}`);
