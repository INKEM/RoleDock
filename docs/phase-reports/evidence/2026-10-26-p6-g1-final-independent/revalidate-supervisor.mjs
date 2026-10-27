import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { ServiceClient } from '@roledock/service';
import { SCHEMA_NAMES, validate } from '@roledock/protocol';
const root=process.cwd();
const temp=mkdtempSync(join(tmpdir(),'rd-g01-rr-'));
symlinkSync(join(root,'node_modules'),join(temp,'node_modules'));
const bundle=join(temp,'review.mjs');
await build({stdin:{contents:`export { WorkspaceSupervisor } from './packages/desktop/src/shell/supervisor.ts'; export { WorkspaceController } from './packages/desktop/src/shell/main/workspace-controller.ts';`,resolveDir:root},external:['@roledock/*'],bundle:true,platform:'node',format:'esm',outfile:bundle});
const { WorkspaceSupervisor,WorkspaceController }=await import(pathToFileURL(bundle).href);
const nodePath=join(root,'packages/desktop/.cache/runtime/node-v22.23.2-linux-x64/node');
const bundlePath=join(root,'packages/desktop/dist-desktop/vendor/service-bundle.mjs');
const livePids=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const makeDir=p=>mkdtempSync(join(temp,p));
const makeSup=()=>new WorkspaceSupervisor({nodePath,bundlePath});
async function info(dir){const c=JSON.parse(readFileSync(join(dir,'.roledock/owner-connection.json'),'utf8'));return new ServiceClient(c).call('workspace.info',{}, {timeoutMs:1500});}
async function ready(dir){for(let n=0;n<100;n++){try{return await info(dir);}catch{}await sleep(100);}throw new Error('service not ready');}
const results={};
try{
 const extDir=makeDir('ext-');const ext=spawn(nodePath,[bundlePath,'--mock-workspace',extDir],{env:{},stdio:'ignore'});livePids.add(ext.pid);await ready(extDir);
 const sup=makeSup(); const ctl=new WorkspaceController(sup);const attached=await ctl.open(extDir);
 const diagnostics=await ctl.diagnostics();const validInfo=await info(extDir); results.runtimeSchema={valid:validate('workspace-service-info',validInfo).ok,extraSecretRejected:!validate('workspace-service-info',{...validInfo,token:'SYNTHETIC_NOT_A_CREDENTIAL'}).ok,invalidPidRejected:!validate('workspace-service-info',{...validInfo,service:{...validInfo.service,pid:0}}).ok};const roles=await ctl.confirmRoles();const sessions=await ctl.confirmSessions();
 const extExited=once(ext,'exit');ext.kill('SIGTERM');await extExited;livePids.delete(ext.pid);
 results.attach={attached,diagnostics,roles,sessions,afterExit:await ctl.refresh()};
 const ownedSup=makeSup(), a=makeDir('a-'),b=makeDir('b-'),alias=join(temp,'a-alias');symlinkSync(a,alias);
 const first=await ownedSup.open(a); livePids.add(first.pid);
 const again=await ownedSup.open(a);const other=await ownedSup.open(b);livePids.add(other.pid);
 const back=await ownedSup.open(alias);const handles=ownedSup.list();const reaped=await ownedSup.reapOwned(1500);await sleep(100);
 results.ownedReopen={first,again,other,back,handleCount:handles.length,reaped,allOwnedPidsGone:[first.pid,other.pid].every(p=>!alive(p))};
 const concurrentSup=makeSup(), concurrentDir=makeDir('concurrent-');const started=Date.now();
 const opening=concurrentSup.open(concurrentDir);const concurrentOpening=concurrentSup.open(concurrentDir);
 for(const h of concurrentSup.list()) if(h.pid) livePids.add(h.pid);
 const second=await concurrentOpening;const secondMs=Date.now()-started;const clientAtSecondReturn=!!concurrentSup.ownerClient(concurrentDir);
 const firstReady=await opening;livePids.add(firstReady.pid);
 results.concurrentOpen={samePromise:opening===concurrentOpening,second,secondMs,clientAtSecondReturn,firstReady,firstReadyMs:Date.now()-started,handles:concurrentSup.list().length};
 await concurrentSup.reapOwned(1500);
 const crashSup=makeSup(),crashDir=makeDir('crash-');const original=await crashSup.open(crashDir);livePids.add(original.pid);
 process.kill(original.pid,'SIGKILL');for(let n=0;n<50&&crashSup.get(crashDir)?.state!=='disconnected';n++)await sleep(50);
 const afterCrash=crashSup.get(crashDir);const afterOpen=await crashSup.open(crashDir); if(afterOpen.pid)livePids.add(afterOpen.pid);
 results.crashReopen={original,afterCrash,afterOpen,rpcAnswers:await info(crashDir).then(()=>true,()=>false)};
 const failSup=makeSup(), failDir=makeDir('fail-');mkdirSync(join(failDir,'.roledock'));writeFileSync(join(failDir,'.roledock/service.sock'),'fixture-not-a-socket');
 const f1=failSup.open(failDir),f2=failSup.open(failDir);for(const h of failSup.list())if(h.pid)livePids.add(h.pid);
 const [failed1,failed2]=await Promise.all([f1,f2]);results.concurrentFailure={samePromise:f1===f2,first:failed1,second:failed2,sentinelPreserved:readFileSync(join(failDir,'.roledock/service.sock'),'utf8')==='fixture-not-a-socket'};
 const cleanup=[];
 for(const method of ['stop','reapOwned']){
  const deadSup=makeSup(),deadDir=makeDir('dead-');const deadHandle=await deadSup.open(deadDir);livePids.add(deadHandle.pid);process.kill(deadHandle.pid,'SIGKILL');
  for(let n=0;n<60&&deadSup.get(deadDir)?.state!=='disconnected';n++)await sleep(25);
  const t=Date.now();const value=method==='stop'?await deadSup.stop(deadDir,1500):await deadSup.reapOwned(1500);cleanup.push({method,elapsedMs:Date.now()-t,removed:!deadSup.get(deadDir),value});
 }
 results.deadCleanup=cleanup;
 results.checks={attachQueryWorks:diagnostics.workspace_id===attached.workspaceId&&roles.roles.length===0&&sessions.external_sessions.length===0,attachedDeathDetected:results.attach.afterExit.state==='disconnected',ownedPidPreserved:first.pid===again.pid&&first.pid===back.pid,ownedReaped:results.ownedReopen.allOwnedPidsGone,concurrentPromiseShared:opening===concurrentOpening,concurrentReady:second.state==='running'&&clientAtSecondReturn&&second.pid===firstReady.pid,crashRecovered:afterOpen.state==='running'&&afterOpen.pid!==original.pid&&afterOpen.workspaceId===original.workspaceId&&results.crashReopen.rpcAnswers,failedOpenShared:f1===f2&&failed1.state!=='running'&&failed2.state===failed1.state&&results.concurrentFailure.sentinelPreserved,deadCleanupPrompt:cleanup.every(c=>c.removed&&c.elapsedMs<1000),schemaChecks:Object.values(results.runtimeSchema).every(Boolean)};
 if(!Object.values(results.checks).every(Boolean))process.exitCode=1;
 results.protocol={schemaNames:SCHEMA_NAMES,workspaceInfoSchemas:SCHEMA_NAMES.filter(n=>/workspace|service.info/i.test(n))};
 console.log(JSON.stringify(results,null,2));
}finally{
 for(const pid of livePids){try{process.kill(pid,'SIGTERM');}catch{}}
 await sleep(200);
 for(const pid of livePids)if(alive(pid)){try{process.kill(pid,'SIGKILL');}catch{}}
 await sleep(100);rmSync(temp,{recursive:true,force:true});
}
