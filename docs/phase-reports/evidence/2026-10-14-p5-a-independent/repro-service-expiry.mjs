import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { WorkspaceService, ServiceClient } from '../../../../packages/service/dist/index.js';
import { MockHarnessAdapter } from '../../../../adapters/mock/dist/index.js';
let entered, finish, cancellations = 0;
const ready = new Promise(r => { entered = r; });
const hold = new Promise(r => { finish = r; });
class Held extends MockHarnessAdapter {
  async runTurn(handle, input) { const ack = await super.runTurn(handle, input); entered(); await hold; return ack; }
  async cancel(handle) { cancellations++; return super.cancel(handle); }
}
const root = mkdtempSync(join(tmpdir(), 'rd-independent-expiry-'));
const adapter = new Held();
const service = await WorkspaceService.start({ root, adapter, socketPath: join(root, 'service.sock'), pollMs: 25 });
try {
  const owner = new ServiceClient(service.ownerCredential);
  await owner.call('roles.install', { source_path: resolve('examples/demo-team') });
  const caps = ['documents.read', 'requests.create', 'requests.execute', 'requests.read'];
  for (const role_id of ['builder', 'reviewer']) for (const capability of caps) await owner.call('policy.grant', { role_id, capability });
  async function enroll(host, role_id, expires_at) {
    adapter.seedExternalSession(host, host);
    const trusted = new ServiceClient(await owner.call('connections.trust', { subject: host, capability_ceiling: caps }));
    const registered = await trusted.call('externalSessions.register', { host_session_id: host });
    const auth = await owner.call('authorizations.recordOwner', { external_session_id: registered.external_session.external_session_id, event_ref: host, actor_id: 'owner', role_id, capabilities: caps, inherit: 'initialize', expires_at });
    const agent = new ServiceClient(registered.credential);
    await agent.call('sessions.anchor', { authorization_id: auth.authorization_id, idempotency_key: host });
    return agent;
  }
  const initiator = await enroll('initiator', 'builder', new Date(Date.now() + 600000).toISOString());
  const targetExpiresAt = new Date(Date.now() + 15000).toISOString();
  const target = await enroll('target', 'reviewer', targetExpiresAt);
  const request = await initiator.call('requests.create', { target_role_id: 'reviewer', question: 'consult', idempotency_key: 'q', read_exception_rationale: 'Target has no published documents' });
  await ready;
  if (Date.now() >= Date.parse(targetExpiresAt)) throw new Error('Fixture target expired before the pending-turn precondition');
  await new Promise(r => setTimeout(r, Date.parse(targetExpiresAt) - Date.now() + 500));
  const authorizations = await target.call('authorizations.get');
  const result = await initiator.call('requests.get', { request_id: request.request_id });
  console.log(JSON.stringify({ target_authorizations: authorizations, state: result.state, cancellations, execution_uncertain: result.execution_uncertain, error: result.error }));
  if (result.state !== 'failed' || cancellations < 1) throw new Error('Hanging execution blocked service expiry withdrawal');
} finally { finish(); await service.close(); rmSync(root, { recursive: true, force: true }); }
