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
 const c=Coordinator.open({root,adapter});let initialClosed=false;
 try{
  await c.installRolePack({source_path:source});const store=coordinatorStore(c);const config=store.getConfig();for(const id of ['alpha','beta','gamma'])config.policy.grants[id]=capabilities;store.setConfig(config);
  const a=await c.openSession({role_id:'alpha',creation_key:'a'});const b=await c.openSession({role_id:'beta',creation_key:'b'});
  const ask=budget=>c.createRequest({session_id:b.session_id,target_role_id:'alpha',question:'INDEPENDENT-QUESTION',idempotency_key:'r',read_exception_rationale:'gap',...(budget?{budget}:{})});
  const session=req=>store.prepare('SELECT * FROM sessions WHERE creation_key=?').get('request-'+req.request_id);
  await check({root,c,store,adapter,a,b,ask,session,closeInitial:()=>{c.close();initialClosed=true;}});
 }finally{if(!initialClosed)c.close();rmSync(root,{recursive:true,force:true});}
}
for(const failingClose of [false,true]) {
 class FailedCancel extends MockHarnessAdapter {
  failures=failingClose?1:0; turns=0;
  async cancel(h){throw new Error('simulated adapter cancel failure');}
  async closeSession(h){if(this.failures-->0)throw new Error('simulated host close failure');return super.closeSession(h);}
  async runTurn(h,t){this.turns++;return super.runTurn(h,t);}
 }
 await fixture(new FailedCancel({needsInputAfterTurns:1}),async f=>{
  const req=await f.ask();assert.equal((await executeRequest(f.store,f.adapter,req.request_id)).state,'awaiting_input');
  const hostId=f.session(req).host_session_ref;
  assert.equal((await f.c.cancelRequest({session_id:f.b.session_id,request_id:req.request_id})).state,'cancelled');
  const row=f.store.prepare('SELECT state,cleanup_pending FROM requests WHERE request_id=?').get(req.request_id);
  assert.equal(row.state,'cancelled');assert.equal(row.cleanup_pending,failingClose?1:0);
  assert.equal(f.adapter.peek(hostId).closed,!failingClose);
  assert.equal(existsSync(join(f.root,'.roledock','requests',req.request_id,'tmp')),false);
  if(failingClose){
   f.closeInitial();const reopened=Coordinator.open({root:f.root,adapter:f.adapter});
   try{
    const store=coordinatorStore(reopened);
    assert.equal(store.prepare('SELECT cleanup_pending FROM requests WHERE request_id=?').get(req.request_id).cleanup_pending,1);
    assert.equal((await executeRequest(store,f.adapter,req.request_id)).state,'cancelled');
    assert.equal(store.prepare('SELECT cleanup_pending FROM requests WHERE request_id=?').get(req.request_id).cleanup_pending,0);
    assert.equal(f.adapter.peek(hostId).closed,true);
    assert.equal(store.prepare('SELECT count(*) AS n FROM request_artifacts').get().n,0);
   }finally{reopened.close();}
  }
  assert.equal(f.adapter.turns,1);assert.deepEqual(f.adapter.peek(hostId).transcript,['INDEPENDENT-QUESTION']);
  console.log(`PASS cancel failure ${failingClose?'persists close failure and retries after restart':'still closes host'} without a replayed turn`);
 });
}
