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
 const f=await setup({uncertainCreate:true});const r=await create(f,'this-dependent-lookup');
 let err;try{await executeRequest(f.store,f.adapter,r.request_id);}catch(e){err={name:e.name,message:e.message};}
 output('uncertain reconciliation loses adapter method this',{err,db:status(f,r.request_id)});f.c.close();
}
