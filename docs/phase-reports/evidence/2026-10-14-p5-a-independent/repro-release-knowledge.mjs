import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from '../../../../packages/core/dist/index.js';
import { coordinatorStore } from '../../../../packages/core/dist/internal-store.js';
import { MockHarnessAdapter } from '../../../../adapters/mock/dist/index.js';
let entered, finish;
const ready = new Promise(r => { entered = r; });
const hold = new Promise(r => { finish = r; });
let held = false;
class Held extends MockHarnessAdapter {
  async loadExternalMaterials(input) {
    const ack = await super.loadExternalMaterials(input);
    if (input.host_session_id === 'successor' && !held) { held = true; entered(); await hold; }
    return ack;
  }
}
const root = mkdtempSync(join(tmpdir(), 'rd-independent-release-'));
const adapter = new Held();
const coordinator = Coordinator.open({ root, adapter });
try {
  await coordinator.installRolePack({ source_path: resolve('examples/demo-team') });
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  const caps = ['documents.read', 'documents.publish'];
  for (const capability of caps) admin.grant({ role_id: 'builder', capability });
  const authority = new ExternalSessionAuthority(coordinator, adapter);
  const store = coordinatorStore(coordinator);
  async function enroll(host, inherit) {
    adapter.seedExternalSession(host, host);
    const external = await authority.register({ host_session_id: host, connection_subject: host, capability_ceiling: caps });
    const auth = authority.recordOwnerAuthorization({ external_session_id: external.external_session_id, event_ref: host, actor_id: 'owner', role_id: 'builder', capabilities: caps, inherit, expires_at: new Date(Date.now() + 600000).toISOString() });
    const connection = authority.connect(external.external_session_id, host);
    return { connection, anchor: () => connection.call('sessions.anchor', { authorization_id: auth.authorization_id, idempotency_key: host }) };
  }
  const original = await enroll('original', 'initialize');
  const first = await original.anchor();
  const successor = await enroll('successor', 'takeover');
  const pending = successor.anchor(); await ready;
  await successor.connection.call('sessions.release');
  console.log('after-release', store.prepare('SELECT state FROM anchor_attempts WHERE idempotency_key = ?').get('successor'));
  await original.connection.call('documents.publish', { document_key: 'state', body: 'Knowledge changes after pending release', expected_revision: 0, expected_generation: 1 });
  finish();
  const result = await pending;
  const finalHead = store.prepare('SELECT generation, current_instance_id FROM role_heads WHERE role_id = ?').get('builder');
  const loads = adapter.peekExternal('successor').loads.length;
  console.log('final', JSON.stringify({ state: result.attempt.state, binding: result.binding, loads, head: finalHead }));
  if (result.attempt.state !== 'failed' || result.binding !== null) throw new Error('Released anchor revived after knowledge drift');
  if (loads !== 1 || finalHead.generation !== 1 || finalHead.current_instance_id !== first.binding.instance_id) throw new Error('Released anchor changed the original head or repeated the external load');
} finally { coordinator.close(); rmSync(root, { recursive: true, force: true }); }
