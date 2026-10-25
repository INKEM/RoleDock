import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Coordinator, ExternalSessionAuthority } from '../../../../packages/core/dist/index.js';
import { MockHarnessAdapter } from '../../../../adapters/mock/dist/index.js';
const root = mkdtempSync(join(tmpdir(), 'rd-independent-event-'));
const adapter = new MockHarnessAdapter();
const coordinator = Coordinator.open({ root, adapter });
try {
  await coordinator.installRolePack({ source_path: resolve('examples/demo-team') });
  const authority = new ExternalSessionAuthority(coordinator, adapter);
  adapter.seedExternalSession('host', 'subject');
  const external = await authority.register({ host_session_id: 'host', connection_subject: 'subject', capability_ceiling: ['documents.read'] });
  const event = { workspace_id: coordinator.workspaceId, host_session_id: 'host', connection_subject: 'subject', event_ref: 'human-event', actor_id: 'human', role_id: 'builder', capabilities: ['documents.read'], inherit: 'initialize', expires_at: new Date(Date.now() + 600000).toISOString() };
  adapter.seedHumanAuthorization(event);
  const prior = await authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: event.event_ref });
  adapter.seedHumanAuthorization(Object.fromEntries(Object.entries(event).reverse()));
  const replay = await authority.recordHumanAuthorization({ external_session_id: external.external_session_id, event_ref: event.event_ref });
  if (replay.authorization_id !== prior.authorization_id) throw new Error('Reordered identical event created new authorization');
  console.log('same semantic human event with reordered object fields returned original authorization');
} finally { coordinator.close(); rmSync(root, { recursive: true, force: true }); }
