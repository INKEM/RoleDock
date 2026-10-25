// G-min acceptance runner: workspace service with the REAL zcode adapter,
// owner-connection bootstrap, desktop GUI confirm (entry=gui-confirm),
// recordHuman over the trusted channel, then the Agent-side sessions.anchor
// with a real material load turn. Scope: local evidence run only.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync, openSync, closeSync, fchmodSync, constants } from "node:fs";
const REPO = "/home/inkem/Personal/RoleDock";
const WS = "/tmp/gmin-ws", JOURNAL = "/tmp/gmin-journal", HELPER = `${REPO}/docs/phase-reports/evidence/2026-10-24-p5-h-b3/credential-helper.mjs`;
rmSync(WS, { recursive: true, force: true }); rmSync(JOURNAL, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const { ZCodeAdapter, connectZCodeConnector } = await import(`${REPO}/adapters/zcode/dist/index.js`);
const { WorkspaceService, ServiceClient } = await import(`${REPO}/packages/service/dist/index.js`);
const tools = await connectZCodeConnector({
  command: process.execPath,
  args: [`${REPO}/adapters/zcode/dist/reference-bin.js`, "--cli", "/opt/ZCode/resources/glm/zcode.cjs", "--credential-helper", HELPER, "--model", "GLM-5.3", "--journal", `${JOURNAL}/connector-journal.sqlite`],
  cwd: WS,
});
let service, gui;
try {
  // The load declarations are fixture-flipped for this run (B4 flips them in
  // production); human-origin declarations here are production (B2 evidence).
  class GminProbeAdapter extends ZCodeAdapter {
    getCapabilities() { const caps = super.getCapabilities(); return { ...caps, external: { ...caps.external, load_materials: true, reconcile_load: true } }; }
  }
  const adapter = new GminProbeAdapter({ tools, workspacePath: WS, stateDir: `${JOURNAL}/adapter` });
  service = await WorkspaceService.start({ root: WS, adapter, socketPath: `${WS}/.roledock/service.sock`, pollMs: 50 });
  const endpoint = `${WS}/.roledock/owner-connection.json`;
  const descriptor = openSync(endpoint, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try { fchmodSync(descriptor, 0o600); writeFileSync(descriptor, JSON.stringify(service.ownerCredential)); } finally { closeSync(descriptor); }
  const owner = new ServiceClient(service.ownerCredential);
  await owner.call("roles.install", { source_path: `${REPO}/examples/demo-team` });
  await owner.call("policy.grant", { role_id: "builder", capability: "documents.read" });
  const trustedCredential = await owner.call("connections.trust", { subject: "roledock-zcode-probe", capability_ceiling: ["documents.read"] });
  const trusted = new ServiceClient(trustedCredential);
  const created = await tools.call("zcode_create_session", { workspacePath: WS, mode: "plan" });
  const enrolled = await trusted.call("externalSessions.register", { host_session_id: created.sessionId });
  print({ kind: "registered", host_session_id: created.sessionId, external_session_id: enrolled.external_session.external_session_id });
  gui = spawn(process.execPath, [`${REPO}/packages/desktop/dist/bin.js`, "--owner-connection", endpoint, "--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  const url = await new Promise((resolve, reject) => {
    createInterface({ input: gui.stdout }).once("line", line => { try { resolve(JSON.parse(line).url); } catch { reject(new Error("desktop bin printed no URL")); } });
    gui.once("exit", code => reject(new Error(`desktop exited early (${code})`)));
  });
  print({ kind: "gui", url });
  const page = await (await fetch(url)).text();
  print({ kind: "gui-page", serves_confirmation_page: page.includes("gui-confirm") && page.includes("sessions.anchor"), bytes: page.length });
  const view = await (await fetch(`${url}api/sessions`)).json();
  print({ kind: "gui-view", sessions: view.external_sessions.length, active_authorization: view.external_sessions[0]?.active_authorization });
  const confirmed = await (await fetch(`${url}api/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ external_session_id: enrolled.external_session.external_session_id, role_id: "builder", capabilities: ["documents.read"], inherit: "initialize", expires_hours: 1 }) })).json();
  print({ kind: "gui-confirmed", ...confirmed });
  const auth = await trusted.call("authorizations.recordHuman", { external_session_id: enrolled.external_session.external_session_id, event_ref: confirmed.event_ref });
  print({ kind: "recorded", authorization_id: auth.authorization_id, source: auth.source, role_id: auth.role_id });
  const agent = new ServiceClient(enrolled.credential);
  const result = await agent.call("sessions.anchor", { authorization_id: auth.authorization_id, idempotency_key: "gmin-e2e" });
  print({ kind: "anchored", attempt_state: result.attempt.state, confirmation: result.attempt.confirmation, binding: { state: result.binding?.state, generation: result.binding?.generation, role_id: result.binding?.role_id }, load_declarations: "fixture-flipped (production flip lands with B4 acceptance)" });
  const after = await (await fetch(`${url}api/sessions`)).json();
  print({ kind: "gui-view-after", active_authorization: after.external_sessions[0]?.active_authorization });
  print({ kind: "gmin-e2e-complete" });
} finally {
  await service?.close();
  if (gui) gui.kill("SIGTERM");
  await tools.disconnect();
  rmSync(`${WS}/.roledock/owner-connection.json`, { force: true });
}
