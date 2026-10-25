import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { RoleDockError, toErrorEnvelope } from "@roledock/protocol";

/**
 * G-min desktop confirmation surface (ADR-0011; DESKTOP_GUI_PLAN §8).
 *
 * Trust split: this Node process is the trusted owner client — it holds the
 * owner credential and is the only side that talks to the workspace service.
 * The served page is the rendering layer and receives neither the credential
 * nor any write path beyond the minimal confirm API (ADR-0007 boundary).
 * Technical baseline: Node's built-in http + a plain browser page bound to
 * 127.0.0.1; no desktop container and no new dependencies (P6-G proper
 * chooses the container).
 */

export interface RpcClient {
  call<T = unknown>(operation: string, input?: unknown): Promise<T>;
}

export const CONFIRM_ENTRY = "gui-confirm";
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CAP = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

interface SessionView { session: { external_session_id: string; host_session_id: string; connection_subject: string; created_at: string }; active_authorization: { authorization_id: string; role_id: string; expires_at: string; source: { kind: string; event_ref: string } } | null }
interface RoleView { role_id: string; title: string; initialized: boolean; requested_capabilities: string[] }

function confirmInput(sessions: SessionView[], roles: RoleView[], body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.external_session_id !== "string" || !ID.test(body.external_session_id)) throw new RoleDockError("VALIDATION_FAILED", "Invalid external_session_id.");
  if (typeof body.role_id !== "string" || !ID.test(body.role_id)) throw new RoleDockError("VALIDATION_FAILED", "Invalid role_id.");
  const view = sessions.find(item => item.session.external_session_id === body.external_session_id);
  if (!view) throw new RoleDockError("NOT_FOUND", "External session is not registered; the Agent must register it first.");
  if (view.active_authorization) throw new RoleDockError("INVALID_STATE_TRANSITION", "This session already has a live authorization; revoke it first or use a new conversation.");
  const role = roles.find(item => item.role_id === body.role_id);
  if (!role) throw new RoleDockError("NOT_FOUND", "Role is not installed.");
  const capabilities = Array.isArray(body.capabilities) && body.capabilities.every(item => typeof item === "string" && CAP.test(item)) ? [...new Set(body.capabilities as string[])] : null;
  if (!capabilities || capabilities.length === 0) throw new RoleDockError("VALIDATION_FAILED", "capabilities must be a non-empty array of dotted capability names.");
  if (body.inherit !== "initialize" && body.inherit !== "takeover") throw new RoleDockError("VALIDATION_FAILED", "inherit must be initialize or takeover.");
  if (!Number.isInteger(body.expires_hours) || (body.expires_hours as number) < 1 || (body.expires_hours as number) > 168) throw new RoleDockError("VALIDATION_FAILED", "expires_hours must be an integer between 1 and 168.");
  return {
    external_session_id: view.session.external_session_id,
    host_session_id: view.session.host_session_id,
    connection_subject: view.session.connection_subject,
    event_ref: `gui-${Date.now()}-${randomBytes(3).toString("hex")}`,
    actor_id: "owner",
    role_id: body.role_id,
    capabilities,
    inherit: body.inherit,
    expires_at: new Date(Date.now() + (body.expires_hours as number) * 3_600_000).toISOString(),
    entry: CONFIRM_ENTRY,
    recorded_at: new Date().toISOString(),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length;
    if (bytes > 262_144) throw new RoleDockError("VALIDATION_FAILED", "Request body exceeds 256 KiB.");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; }
  catch { throw new RoleDockError("VALIDATION_FAILED", "Malformed JSON body."); }
}

export function startDesktopServer(options: { client: RpcClient; port?: number; host?: string }): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => { void handle(request, response, options.client).catch(error => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify(toErrorEnvelope(error))); }); });
  return new Promise(resolve => {
    const host = options.host ?? "127.0.0.1";
    server.listen(options.port ?? 0, host, () => resolve({ url: `http://${host}:${(server.address() as { port: number }).port}/`, close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())) }));
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, client: RpcClient): Promise<void> {
  const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (request.method === "GET" && url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(PAGE); return; }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const listed = await client.call<SessionView[] | { external_sessions?: SessionView[] }>("externalSessions.list", {});
      return json(200, { external_sessions: Array.isArray(listed) ? listed : listed.external_sessions ?? [] });
    }
    if (request.method === "GET" && url.pathname === "/api/roles") return json(200, await client.call("roles.list", {}));
    if (request.method === "POST" && url.pathname === "/api/confirm") {
      const body = await readJson(request);
      const [sessions, roles] = await Promise.all([
        client.call<{ external_sessions?: SessionView[] } | SessionView[]>("externalSessions.list", {}),
        client.call<{ roles?: RoleView[] }>("roles.list", {}),
      ]);
      const sessionViews = Array.isArray(sessions) ? sessions : sessions.external_sessions ?? [];
      const roleViews = (roles.roles ?? []).map((role: RoleView) => role);
      const input = confirmInput(sessionViews, roleViews, body);
      const record = await client.call("authorizations.submitHumanEvent", input);
      return json(200, { ok: true, event_ref: (record as { event_ref: string }).event_ref, entry: CONFIRM_ENTRY, note: "Confirmation stored. The conversation's trusted channel completes recordHuman; the Agent anchors explicitly." });
    }
    return json(404, toErrorEnvelope(new RoleDockError("VALIDATION_FAILED", "Unknown desktop endpoint.")));
  } catch (error) {
    const status = error instanceof RoleDockError && ["NOT_FOUND", "VALIDATION_FAILED", "INVALID_STATE_TRANSITION", "PERMISSION_DENIED"].includes(error.code) ? 400 : 500;
    return json(status, toErrorEnvelope(error));
  }
}

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>RoleDock 授权确认(G-min)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a2e; }
  h1 { font-size: 1.2rem; }
  .note { background: #f4f4f8; padding: .6rem .8rem; border-left: 3px solid #6c63d2; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: .45rem .6rem; font-size: .85rem; text-align: left; vertical-align: top; }
  select, input { font-size: .8rem; }
  .caps { width: 16rem; }
  button { font-size: .8rem; padding: .3rem .7rem; }
  .auth { color: #1b7f4d; }
  .log { margin-top: 1rem; font-size: .8rem; white-space: pre-wrap; background: #f8f8fc; padding: .6rem; min-height: 2rem; }
</style>
</head>
<body>
<h1>RoleDock 授权确认(G-min,受信所有者入口)</h1>
<p class="note">确认将以 <b>entry=gui-confirm</b> 写入一条真人授权事件(内容寻址存储)。存储本身不授权:授权由该会话受信通道的 recordHuman 链产生,锚定由 Agent 显式调用 sessions.anchor 完成。拒绝=不操作。</p>
<table id="sessions">
  <thead><tr><th>外部会话</th><th>宿主会话 / 主体</th><th>现存有效授权</th><th>确认角色</th><th>能力(逗号分隔)</th><th>继承</th><th>有效期</th><th></th></tr></thead>
  <tbody></tbody>
</table>
<div class="log" id="log">正在加载…</div>
<script>
const $ = sel => document.querySelector(sel);
const log = message => { $("#log").textContent += message + "\\n"; };
let roles = [];
async function load() {
  const [sessions, roleList] = await Promise.all([
    fetch("/api/sessions").then(r => r.json()),
    fetch("/api/roles").then(r => r.json()),
  ]);
  roles = roleList.roles ?? [];
  const rows = document.querySelectorAll("#sessions tbody tr");
  rows.forEach(row => row.remove());
  for (const item of (sessions.external_sessions ?? [])) {
    const tr = document.createElement("tr");
    const roleSelect = roles.map(role => \`<option value="\${role.role_id}" data-caps="\${(role.requested_capabilities ?? []).join(",")}">\${role.role_id}(\${role.initialized ? "takeover" : "initialize"})</option>\`).join("");
    tr.innerHTML = \`<td>\${item.session.external_session_id}</td>
      <td>\${item.session.host_session_id}<br>\${item.session.connection_subject}</td>
      <td>\${item.active_authorization ? \`<span class="auth">\${item.active_authorization.role_id} @ \${item.active_authorization.expires_at}</span>\` : "—"}</td>
      <td><select class="role">\${roleSelect}</select></td>
      <td><input class="caps" /></td>
      <td><select class="inherit"><option value="initialize">initialize</option><option value="takeover">takeover</option></select></td>
      <td><select class="hours"><option value="1">1 小时</option><option value="8">8 小时</option><option value="24">24 小时</option><option value="168">7 天</option></select></td>
      <td><button>确认</button></td>\`;
    const capsInput = tr.querySelector(".caps");
    const syncCaps = () => { const selected = roles.find(role => role.role_id === tr.querySelector(".role").value); capsInput.value = (selected?.requested_capabilities ?? []).join(","); };
    tr.querySelector(".role").addEventListener("change", syncCaps); syncCaps();
    tr.querySelector("button").addEventListener("click", async () => {
      const payload = {
        external_session_id: item.session.external_session_id,
        role_id: tr.querySelector(".role").value,
        capabilities: capsInput.value.split(",").map(item => item.trim()).filter(item => item.length > 0),
        inherit: tr.querySelector(".inherit").value,
        expires_hours: Number(tr.querySelector(".hours").value),
      };
      const reply = await fetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await reply.json();
      log((result.ok ? "已确认 " : "失败 ") + JSON.stringify(result));
      await load();
    });
    $("#sessions tbody").appendChild(tr);
  }
  if ((sessions.external_sessions ?? []).length === 0) log("当前没有已注册的外部会话;Agent 在外部 Harness 注册会话后会出现在这里。");
}
load().catch(error => log("加载失败:" + error.message));
</script>
</body>
</html>`;
