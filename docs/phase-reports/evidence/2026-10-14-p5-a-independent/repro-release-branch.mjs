import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from '../../../../packages/core/dist/index.js';
import { coordinatorStore } from '../../../../packages/core/dist/internal-store.js';
import { executeRequest } from '../../../../packages/core/dist/requests/executor.js';
import { MockHarnessAdapter } from '../../../../adapters/mock/dist/index.js';
let entered, finish;
const ready = new Promise(r => { entered = r; });
const hold = new Promise(r => { finish = r; });
class Held extends MockHarnessAdapter {
  async runTurn(handle, input) { const ack = await super.runTurn(handle, input); entered(); await hold; return ack; }
  async closeSession() { throw new Error('Fixture cannot close live host'); }
}
const root = mkdtempSync(join(tmpdir(), 'rd-independent-branch-'));
const adapter = new Held();
const coordinator = Coordinator.open({ root, adapter });
try {
  await coordinator.installRolePack({ source_path: resolve('examples/demo-team') });
  const admin = WorkspaceAdmin.forCoordinator(coordinator);
  const caps = ['documents.read', 'documents.publish', 'documents.propose', 'requests.create', 'requests.execute'];
  for (const role_id of ['builder', 'reviewer']) for (const capability of caps) admin.grant({ role_id, capability });
  const authority = new ExternalSessionAuthority(coordinator, adapter);
  const store = coordinatorStore(coordinator);
  async function enroll(host, role_id) {
    adapter.seedExternalSession(host, host);
    const external = await authority.register({ host_session_id: host, connection_subject: host, capability_ceiling: caps });
    const auth = authority.recordOwnerAuthorization({ external_session_id: external.external_session_id, event_ref: host, actor_id: 'owner', role_id, capabilities: caps, inherit: 'initialize', expires_at: new Date(Date.now() + 600000).toISOString() });
    const connection = authority.connect(external.external_session_id, host);
    await connection.call('sessions.anchor', { authorization_id: auth.authorization_id, idempotency_key: host });
    return connection;
  }
  const initiator = await enroll('initiator', 'builder');
  const target = await enroll('target', 'reviewer');
  await target.call('documents.publish', { document_key: 'reviews', body: 'Fixed request document', expected_revision: 0, expected_generation: 1 });
  await initiator.call('documents.read', { target_role_id: 'reviewer', document_key: 'reviews' });
  const request = await initiator.call('requests.create', { target_role_id: 'reviewer', question: 'consult', idempotency_key: 'q' });
  const pending = executeRequest(store, adapter, request.request_id); await ready;
  await initiator.call('sessions.release');
  const branch = store.prepare('SELECT id, state FROM sessions WHERE creation_key = ?').get(`request-${request.request_id}`);
  const withdrawn = store.prepare('SELECT state, cleanup_pending FROM requests WHERE request_id = ?').get(request.request_id);
  console.log('after-release', withdrawn, branch);
  if (withdrawn.state !== 'failed' || withdrawn.cleanup_pending !== 1 || branch.state !== 'active') throw new Error('Fixture did not preserve the withdrawn task and unresolved host cleanup');
  let denied = false;
  try {
    const candidate = await coordinator.proposeDocumentUpdate({ session_id: branch.id, target_role_id: 'reviewer', document_key: 'reviews', body: 'AFTER-WITHDRAWAL', baseline_revision: 1 });
    console.log('post-release candidate committed', candidate);
  } catch (error) { console.log('post-release denied', error.code, error.message); if (error.code !== 'PERMISSION_DENIED') throw error; denied = true; }
  finish(); await pending;
  if (!denied) throw new Error('Withdrawn delegated branch still commits candidates');
} finally { coordinator.close(); rmSync(root, { recursive: true, force: true }); }
