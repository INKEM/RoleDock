#!/usr/bin/env node
/**
 * G4 双授权并存写入（真机）：经 owner 面向已登记会话写一条 8h takeover
 * 确认事件（entry=cli-console），由受信桥在下一个轮询周期推进为第二条授权。
 * 用法：node submit-second-auth.mjs <工作空间目录>
 * GUI 确认面在已有存活授权时会拒绝二次确认（confirm.ts 守卫，属 G3 定档
 * 行为）；并存状态经 owner 显式写入产生，供 G4 撤销面观察与验证。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ServiceClient } from "../../../../packages/service/dist/index.js";

const root = resolve(process.argv[2] ?? "");
if (!root) { console.error("用法: node submit-second-auth.mjs <工作空间目录>"); process.exit(2); }
const credential = JSON.parse(readFileSync(join(root, ".roledock", "owner-connection.json"), "utf8"));
const owner = new ServiceClient(credential);

const sessions = await owner.call("externalSessions.list", {});
const list = Array.isArray(sessions) ? sessions : sessions.external_sessions ?? [];
const target = list.find(item => item.session.host_session_id.startsWith("session_")) ?? list[0];
if (!target) { console.error("没有已登记会话；先在 GUI 登记原会话。"); process.exit(1); }
const external = target.session;
if (target.active_authorization) console.log(`注意：${external.external_session_id} 已有存活授权 ${target.active_authorization.authorization_id}；本次写入将与之并存。`);

const event = {
  external_session_id: external.external_session_id,
  host_session_id: external.host_session_id,
  connection_subject: external.connection_subject,
  event_ref: `gui-manual-8h-${Date.now().toString(36)}`,
  actor_id: "owner",
  role_id: target.active_authorization?.role_id ?? (() => { console.error("无法确定角色；请传入 ROLE_ID 环境变量"); process.exit(1); })(),
  capabilities: [target.active_authorization ? "documents.read" : "documents.read"],
  inherit: "takeover",
  expires_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
  entry: "cli-console",
  recorded_at: new Date().toISOString(),
};
if (process.env.ROLE_ID) event.role_id = process.env.ROLE_ID;
if (process.env.EVENT_REF) event.event_ref = process.env.EVENT_REF;
const stored = await owner.call("authorizations.submitHumanEvent", event);
console.log(`事件已存储 event_ref=${stored.event_ref}（entry=${event.entry}，8h，takeover）。受信桥将在下一轮询周期推进为第二条授权；GUI 确认进度链可见。`);
