// Persistent fixture host state, never evidence of a real Harness.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from '../../../packages/core/dist/index.js';
import { MockHarnessAdapter } from '../../../adapters/mock/dist/index.js';
const [root, phase] = process.argv.slice(2);
const registry = join(root, 'fixture-loads.json');
class PersistentFixture extends MockHarnessAdapter {
  async loadExternalMaterials(input) {
    if (phase === 'before-load') { console.log('CRASH-POINT'); setInterval(() => {}, 1000); await new Promise(() => {}); }
    const records = existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')) : [];
    let record = records.find(item => item.load_key === input.load_key);
    if (!record) {
      record = { host_session_id: input.host_session_id, load_key: input.load_key, content_hash: input.bootstrap.content_hash, load_version: records.length + 1, payload: input.bootstrap.payload };
      records.push(record); writeFileSync(registry, JSON.stringify(records));
    }
    if (phase === 'after-load') { console.log('CRASH-POINT'); setInterval(() => {}, 1000); await new Promise(() => {}); }
    const { payload, ...confirmation } = record; return confirmation;
  }
  async lookupExternalLoad(host, key) {
    const record = (existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')) : []).find(item => item.host_session_id === host && item.load_key === key);
    if (!record) return { state: 'absent' };
    const { payload, ...confirmation } = record; return { state: 'loaded', confirmation };
  }
}
const adapter = new PersistentFixture(); adapter.seedExternalSession('fixture-original-chat', 'fixture-connection', ['PRIVATE-HISTORY']);
const coordinator = Coordinator.open({ root, adapter });
const authority = new ExternalSessionAuthority(coordinator, adapter);
await coordinator.installRolePack({ source_path: resolve('examples/custom-role') });
const role = (await coordinator.listRoles({})).roles[0].role_id;
WorkspaceAdmin.forCoordinator(coordinator).grant({ role_id: role, capability: 'documents.read' });
const external = await authority.register({ host_session_id: 'fixture-original-chat', connection_subject: 'fixture-connection', capability_ceiling: ['documents.read'] });
adapter.seedHumanAuthorization({ workspace_id: coordinator.workspaceId, host_session_id: 'fixture-original-chat', connection_subject: 'fixture-connection', event_ref: 'human-event', actor_id: 'fixture-person', role_id: role, capabilities: ['documents.read'], inherit: 'initialize', expires_at: '2099-01-01T00:00:00.000Z' });
const auth = await authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: 'human-event' });
const connection = authority.connect(external.external_session_id, 'fixture-connection');
const result = await connection.call('sessions.anchor', { authorization_id: auth.authorization_id, idempotency_key: 'same-logical-anchor' });
if (phase === 'after-activate') { console.log('CRASH-POINT'); setInterval(() => {}, 1000); await new Promise(() => {}); }
console.log(JSON.stringify({ ...result, loads: JSON.parse(readFileSync(registry, 'utf8')).length })); coordinator.close();
