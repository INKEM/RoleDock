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
class Pending extends MockHarnessAdapter{async getResult(h){return {...await super.getResult(h),state:'running',completed:false};}}
await fixture(new Pending(),async f=>{
 const publish=(body,revision,candidate_id)=>f.c.publishDocument({session_id:f.a.session_id,document_key:'notes',body,expected_revision:revision,expected_generation:1,...(candidate_id?{candidate_id}:{})});
 await publish('V1',0);const req=await f.ask();await executeRequest(f.store,f.adapter,req.request_id);const branch=f.session(req).id;
 await publish('V2',1);assert.equal((await f.c.readDocument({session_id:branch,document_key:'notes'})).body,'V1');
 const list=await f.c.listDocuments({session_id:branch});assert.equal(list.documents.length,1);assert.equal(list.documents[0].latest_revision,1);
 const proposal=await f.c.proposeDocumentUpdate({session_id:branch,target_role_id:'alpha',document_key:'notes',body:'EDIT-OF-V1'});assert.equal(proposal.baseline_revision,1);
 await assert.rejects(publish('ignored',2,proposal.candidate_id),{code:'REVISION_CONFLICT'});
 await assert.rejects(f.c.proposeDocumentUpdate({session_id:branch,target_role_id:'alpha',document_key:'notes',body:'EDIT',baseline_revision:2}),{code:'PERMISSION_DENIED'});
 console.log('PASS fixed request read/list/proposal baseline and stale adoption');
});
await fixture(new Pending(),async f=>{
 const req=await f.ask();const primary=await f.c.openSession({role_id:'gamma',creation_key:'request-'+req.request_id});
 await executeRequest(f.store,f.adapter,req.request_id);const branch=f.session(req);assert.equal(branch.kind,'request');assert.equal(branch.role_id,'alpha');
 const main=f.store.prepare('SELECT host_session_ref FROM sessions WHERE id=?').get(primary.session_id);assert.deepEqual(f.adapter.peek(main.host_session_ref).transcript,[]);assert.equal(f.adapter.peek(main.host_session_ref).closed,false);
 console.log('PASS logical open key cannot alias request host or inject into primary');
});
for(const mode of ['refusal','missing-body']){
 class Edge extends MockHarnessAdapter{
  async runTurn(h,t){return mode==='refusal'?{host_session_id:h.host_session_id,accepted:false}:super.runTurn(h,t);}
  async getResult(h){const result=await super.getResult(h);if(mode==='missing-body')delete result.body;return result;}
 }
 await fixture(new Edge(),async f=>{
  const req=await f.ask();await assert.rejects(executeRequest(f.store,f.adapter,req.request_id),{code:mode==='refusal'?'INVALID_STATE_TRANSITION':'NOT_IMPLEMENTED'});
  const state=await f.c.getRequest({session_id:f.b.session_id,request_id:req.request_id});assert.equal(state.state,'failed');assert.equal(state.execution_uncertain,undefined);assert.equal(f.adapter.peek(f.session(req).host_session_ref).closed,true);
  assert.equal(f.store.prepare('SELECT count(*) AS n FROM request_artifacts').get().n,0);console.log(`PASS ${mode} remains a known failure with closed host and no artifact`);
 });
}
for(const operation of ['getRequest','replyToRequest','cancelRequest']){
 await fixture(new MockHarnessAdapter({needsInputAfterTurns:1}),async f=>{
  const deadline=new Date(Date.now()+20000).toISOString();const req=await f.ask({deadline});assert.equal((await executeRequest(f.store,f.adapter,req.request_id)).state,'awaiting_input');
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(deadline)-Date.now()+25)));
  const input={session_id:f.b.session_id,request_id:req.request_id,...(operation==='replyToRequest'?{body:'late reply'}:{})};
  if(operation==='getRequest')assert.equal((await f.c[operation](input)).state,'expired');else await assert.rejects(f.c[operation](input));
  assert.equal(f.store.prepare('SELECT state FROM requests WHERE request_id=?').get(req.request_id).state,'expired');assert.equal(f.adapter.peek(f.session(req).host_session_ref).closed,true);assert.equal(existsSync(join(f.root,'.roledock','requests',req.request_id,'tmp')),false);
  console.log(`PASS ${operation} commits expiry and reclaims waiting host`);
 });
}
console.log('PASS 7 independent boundary scenarios; mock-only, no real Harness claim');
