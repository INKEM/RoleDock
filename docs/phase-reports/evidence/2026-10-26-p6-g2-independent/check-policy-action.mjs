import { WorkspaceService,ServiceClient } from '@roledock/service';
import { MockHarnessAdapter } from '@roledock/adapter-mock';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'rd-g2-policy-')),adapter=new MockHarnessAdapter();
const caps=['documents.read'];const host='fixture-policy-conversation';adapter.seedExternalSession(host,host);
const service=await WorkspaceService.start({root,adapter,socketPath:join(root,'service.sock'),pollMs:25});
try{
 const owner=new ServiceClient(service.ownerCredential);
 await owner.call('roles.install',{source_path:resolve('examples/custom-role')});
 await owner.call('policy.grant',{role_id:'archivist',capability:'documents.read'});
 const trust=await owner.call('connections.trust',{subject:host,capability_ceiling:caps});const trusted=new ServiceClient(trust);
 const enrolled=await trusted.call('externalSessions.register',{host_session_id:host});
 adapter.seedHumanAuthorization({workspace_id:service.workspaceId,host_session_id:host,connection_subject:host,event_ref:'fixture-policy-event',actor_id:'fixture-user',role_id:'archivist',capabilities:caps,inherit:'initialize',expires_at:new Date(Date.now()+600000).toISOString()});
 const auth=await trusted.call('authorizations.recordHuman',{external_session_id:enrolled.external_session.external_session_id,event_ref:'fixture-policy-event'});
 const session=new ServiceClient(enrolled.credential);await session.call('sessions.anchor',{authorization_id:auth.authorization_id,idempotency_key:'fixture-policy-anchor'});
 const before=await session.call('documents.list');
 await owner.call('policy.revoke',{role_id:'archivist',capability:'documents.read'});
 let denied;
 try{await session.call('documents.list');denied={rejected:false};}catch(e){denied={rejected:true,code:e.code,message:e.message};}
 console.log(JSON.stringify({kind:'mock-policy-action-boundary',readBeforeRevokeSucceeded:!!before,nextReadAfterRevoke:denied},null,2));
 if(!denied.rejected)process.exitCode=1;
}finally{await service.close();rmSync(root,{recursive:true,force:true});}
