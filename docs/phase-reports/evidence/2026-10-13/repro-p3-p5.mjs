import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const base = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const { Coordinator, executeRequest, buildCheckpoint, prepareHandoff }=await import(base+'/packages/core/dist/index.js');
const { coordinatorStore }=await import(base+'/packages/core/dist/internal-store.js');
const { MockHarnessAdapter }=await import(base+'/adapters/mock/dist/index.js');
const { ProcessBridgeAdapter }=await import(base+'/adapters/process-bridge/dist/index.js');
async function setup(adapterOptions={}, supplied) {
 const root=mkdtempSync('/tmp/rd-review-');
 const adapter=supplied ?? new MockHarnessAdapter(adapterOptions);
 const c=Coordinator.open({root,adapter});
 const pack=join(root,'pack');mkdirSync(join(pack,'roles'),{recursive:true});
 for(const id of ['a','b'])writeFileSync(join(pack,'roles',id+'.md'),'ROLE '+id+' instruction marker');
 writeFileSync(join(pack,'rolepack.json'),JSON.stringify({schema_version:'0.1',requires_protocol:'0.1',name:'audit-pack',version:'0.1.0',roles:['a','b'].map(id=>({id,title:id,instructions:'roles/'+id+'.md',requested_capabilities:[]}))}));
 await c.installRolePack({source_path:pack});
 const a=await c.openSession({role_id:'a',creation_key:'first-a'});const b=await c.openSession({role_id:'b',creation_key:'first-b'});
 return {root,adapter,c,store:coordinatorStore(c),a,b};
}
async function create(f,key,budget){return f.c.createRequest({session_id:f.a.session_id,target_role_id:'b',question:'actual question',idempotency_key:key,read_exception_rationale:'no documents',...(budget?{budget}:{})});}
function status(f,id){return f.store.prepare('SELECT state, execution_uncertain, result_artifact_id FROM requests WHERE request_id=?').get(id);}
const output=(label,value)=>console.log(JSON.stringify({label,...value}));
{
 const f=await setup({isolation:{context:false}});const r=await create(f,'restricted');const x=await executeRequest(f.store,f.adapter,r.request_id);
 output('no grants + restricted context still completed',{capabilities:f.adapter.getCapabilities(),policy:f.store.getConfig().policy,result:x,artifact:await f.c.readArtifact({session_id:f.a.session_id,artifact_id:x.artifact_id})});f.c.close();
}
{
 const f=await setup();const first=await f.c.openSession({role_id:'b',creation_key:'first-b'});
 const successor=await f.c.openSession({role_id:'b',inherit:'latest',creation_key:'next-b'});
 const replay=await f.c.openSession({role_id:'b',creation_key:'first-b'});
 const row=f.store.prepare('SELECT generation,state FROM agent_instances WHERE id=?').get(replay.instance_id);
 const host=f.store.prepare('SELECT adapter,host_session_ref FROM sessions WHERE id=?').get(first.session_id);
 const loaded=f.adapter.peek(f.store.prepare('SELECT host_session_ref FROM sessions WHERE id=?').get(successor.session_id).host_session_ref).bootstrap;
 output('first open unprovisioned + replay wrong generation + bootstrap markers absent',{first,successor,replay,actualInstance:row,firstHost:host,bootstrap:JSON.parse(loaded.payload)});f.c.close();
}
{
 const f=await setup({needsInputAfterTurns:1});const r=await create(f,'budget',{max_turns:1});await executeRequest(f.store,f.adapter,r.request_id);
 let failure;try{await f.c.replyToRequest({session_id:f.a.session_id,request_id:r.request_id,body:'reply'});}catch(e){failure=e.message;}
 const h=f.store.prepare("SELECT host_session_ref FROM sessions WHERE kind='request'").get().host_session_ref;
 output('budget exceeded after turn already executed',{state:status(f,r.request_id),turns:f.adapter.peek(h).transcript.length,closed:f.adapter.peek(h).closed,failure});f.c.close();
}
{
 const f=await setup({needsInputAfterTurns:1});const r=await create(f,'cancel-needs-input');
 const orig=f.adapter.getResult.bind(f.adapter);f.adapter.getResult=async h=>{await f.c.cancelRequest({session_id:f.a.session_id,request_id:r.request_id});return orig(h);};
 const x=await executeRequest(f.store,f.adapter,r.request_id);
 output('cancelled request revived by needs_input',{result:x,db:status(f,r.request_id)});f.c.close();
}
{
 const f=await setup();const deadline=Date.now()+5000;const r=await create(f,'deadline',{deadline:new Date(deadline).toISOString()});
 const orig=f.adapter.getResult.bind(f.adapter);f.adapter.getResult=async h=>{await delay(Math.max(1,deadline-Date.now()+50));return orig(h);};
 const x=await executeRequest(f.store,f.adapter,r.request_id);output('deadline elapsed during turn still completed',{result:x,db:status(f,r.request_id)});f.c.close();
}
{
 const f=await setup();const r=await create(f,'hostfail');f.adapter.runTurn=async()=>{throw new Error('host disconnected after side effect');};
 let err;try{await executeRequest(f.store,f.adapter,r.request_id);}catch(e){err=e.message;}
 let retry;try{await executeRequest(f.store,f.adapter,r.request_id);}catch(e){retry=e.message;}
 output('disconnect stuck running without uncertain flag',{err,retry,db:status(f,r.request_id)});f.c.close();
}
{
 const f=await setup({uncertainCreate:true,optional:{lookup_session_by_creation_key:false}});const r=await create(f,'uncertain');
 let err;try{await executeRequest(f.store,f.adapter,r.request_id);}catch(e){err=e.code;}
 output('uncertain flag hidden in public get',{err,db:status(f,r.request_id),public:await f.c.getRequest({session_id:f.a.session_id,request_id:r.request_id})});f.c.close();
}
{
 const f=await setup();const r=await create(f,'overlap');let creates=0;const orig=f.adapter.createSession.bind(f.adapter);f.adapter.createSession=async x=>{creates++;await delay(20);return orig(x);};
 const x=await Promise.allSettled([executeRequest(f.store,f.adapter,r.request_id),executeRequest(f.store,f.adapter,r.request_id)]);
 output('overlapping execution invokes host creation twice',{creates,results:x.map(y=>y.status==='fulfilled'?y.value:{error:y.reason.message}),db:status(f,r.request_id),artifacts:f.store.prepare('SELECT COUNT(*) n FROM request_artifacts').get()});f.c.close();
}
{
 const f=await setup();const prior=buildCheckpoint(f.store,{role_id:'b',summary_body:'persisted summary marker',todos:[{description:'must retain task',done:false}],sources:[]});
 const successor=await f.c.openSession({role_id:'b',inherit:'latest'});
 const ck=f.store.prepare('SELECT handoff_summary_json,todos_json,user_decision_refs_json FROM checkpoints WHERE checkpoint_id=?').get(successor.handoff.checkpoint_id);
 output('handoff replaced saved summary and todos with empty checkpoint',{priorSummary:prior.handoff_summary,priorTodos:prior.todos,successorCheckpoint:ck});f.c.close();
}
{
 const f=await setup();const prep=prepareHandoff(f.store,{role_id:'b'});
 f.store.prepare("INSERT INTO sessions(id,kind,adapter,state,creation_key,created_at)VALUES('sess-recovery','primary','mock','provisioning',?,?)").run(prep.creation_key,new Date().toISOString());
 let err;try{await f.c.openSession({role_id:'b',inherit:'latest',creation_key:prep.creation_key});}catch(e){err={code:e.code,message:e.message};}
 output('restart before host creation rehydrates empty payload',{err,head:f.store.prepare("SELECT generation FROM role_heads WHERE role_id='b'").get()});f.c.close();
}
