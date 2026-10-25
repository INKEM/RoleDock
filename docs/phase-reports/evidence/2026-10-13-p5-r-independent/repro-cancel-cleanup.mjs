import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const local = path => import(pathToFileURL(join(process.cwd(),path)).href);
const {Coordinator}=await local('packages/core/dist/index.js');
const {coordinatorStore}=await local('packages/core/dist/internal-store.js');
const {executeRequest}=await local('packages/core/dist/requests/executor.js');
const {MockHarnessAdapter}=await local('adapters/mock/dist/index.js');
// All workspaces and role names below are temporary test data. No real host.
const capabilities=['documents.read','documents.propose','documents.publish','requests.create','requests.execute','requests.read','requests.reply','requests.cancel','artifacts.read'];
async function fixture(adapter,check){
 const root=mkdtempSync('/tmp/rd-independent-final-');const source=join(root,'pack');
 mkdirSync(join(source,'roles'),{recursive:true});mkdirSync(join(source,'templates'));
 writeFileSync(join(source,'rolepack.json'),JSON.stringify({schema_version:'0.1',name:'independent-pack',version:'0.1.0',requires_protocol:'0.1',roles:['alpha','beta','gamma'].map(id=>({id,title:id,instructions:`roles/${id}.md`,documents:[{key:'notes',template:`templates/${id}.md`,visibility:'project'}],requested_capabilities:['documents.read']}))}));
 for(const id of ['alpha','beta','gamma']){writeFileSync(join(source,'roles',id+'.md'),`INSTRUCTION-${id}`);writeFileSync(join(source,'templates',id+'.md'),'notes');}
 const c=Coordinator.open({root,adapter});
 try{
  await c.installRolePack({source_path:source});const store=coordinatorStore(c);const config=store.getConfig();for(const id of ['alpha','beta','gamma'])config.policy.grants[id]=capabilities;store.setConfig(config);
  const a=await c.openSession({role_id:'alpha',creation_key:'a'});const b=await c.openSession({role_id:'beta',creation_key:'b'});
  const ask=budget=>c.createRequest({session_id:b.session_id,target_role_id:'alpha',question:'INDEPENDENT-QUESTION',idempotency_key:'r',read_exception_rationale:'gap',...(budget?{budget}:{})});
  const session=req=>store.prepare('SELECT * FROM sessions WHERE creation_key=?').get('request-'+req.request_id);
  await check({root,c,store,adapter,a,b,ask,session});
 }finally{c.close();rmSync(root,{recursive:true,force:true});}
}
class FailedCancel extends MockHarnessAdapter {
 async cancel(h){throw new Error('simulated adapter cancel failure');}
}
await fixture(new FailedCancel({needsInputAfterTurns:1}),async f=>{
 const req=await f.ask();assert.equal((await executeRequest(f.store,f.adapter,req.request_id)).state,'awaiting_input');
 const state=await f.c.cancelRequest({session_id:f.b.session_id,request_id:req.request_id});
 const row=f.store.prepare('SELECT state,cleanup_pending FROM requests WHERE request_id=?').get(req.request_id);
 const closed=f.adapter.peek(f.session(req).host_session_ref).closed;
 console.log(JSON.stringify({returned:state.state,row,host_closed:closed,temp_exists:existsSync(join(f.root,'.roledock','requests',req.request_id,'tmp'))}));
 assert.equal(row.state,'cancelled');assert.equal(row.cleanup_pending,0);assert.equal(closed,false);
 console.log('REPRO R12: adapter cancel failure skips cleanup and leaves no durable retry marker');
});
