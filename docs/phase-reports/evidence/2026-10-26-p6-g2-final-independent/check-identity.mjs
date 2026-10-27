import { build } from 'esbuild';
import { ServiceClient } from '@roledock/service';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,existsSync,rmSync,symlinkSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const root=process.cwd(),dir=mkdtempSync(join(tmpdir(),'rd-g2-id-')),a=join(dir,'a'),b=join(dir,'b');mkdirSync(a);mkdirSync(b);symlinkSync(join(root,'node_modules'),join(dir,'node_modules'));
const compiled=join(dir,'review.mjs');await build({stdin:{contents:`export { WorkspaceSupervisor } from './packages/desktop/src/shell/supervisor.ts'; export { WorkspaceController } from './packages/desktop/src/shell/main/workspace-controller.ts';`,resolveDir:root},bundle:true,external:['@roledock/*'],platform:'node',format:'esm',outfile:compiled});
const {WorkspaceSupervisor,WorkspaceController}=await import(pathToFileURL(compiled).href);
const nodePath=join(root,'packages/desktop/.cache/runtime/node-v22.23.2-linux-x64/node'),bundlePath=join(root,'packages/desktop/dist-desktop/vendor/service-bundle.mjs');
const children=[];let supervisor;const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function start(ws){const child=spawn(nodePath,[bundlePath,'--mock-workspace',ws],{env:{},stdio:'ignore'});children.push(child);for(let n=0;n<100;n++){try{const credential=JSON.parse(readFileSync(join(ws,'.roledock/owner-connection.json'),'utf8'));const owner=new ServiceClient(credential);const info=await owner.call('workspace.info',{}, {timeoutMs:1000});if(existsSync(join(ws,'.roledock/workspace-id')))return{child,credential,owner,info};}catch{}await pause(100);}throw new Error('fixture not ready');}
try{
 const A=await start(a),B=await start(b);
 const exit=once(A.child,'exit');A.child.kill('SIGTERM');await exit;
 const identityFileAfterStop=existsSync(join(a,'.roledock/workspace-id'));
 writeFileSync(join(a,'.roledock/owner-connection.json'),JSON.stringify(B.credential),{mode:0o600});chmodSync(join(a,'.roledock/owner-connection.json'),0o600);
 supervisor=new WorkspaceSupervisor({nodePath,bundlePath});const controller=new WorkspaceController({supervisor,settingsFile:join(dir,'settings.json'),nodePath,connectorPath:join(root,'packages/desktop/dist-desktop/vendor/zcode-connector.mjs')});
 const opened=await controller.open(a,'mock');let install;
 try{install={ok:true,result:await controller.rolesInstall(resolve('examples/custom-role'))};}catch(e){install={ok:false,message:e.message};}
 const bRoles=await B.owner.call('roles.list');
 const identity=join(a,'.roledock/workspace-id');
 const variants=[];
 for(const [kind,setup] of [
  ['missing',()=>rmSync(identity)],
  ['malformed',()=>writeFileSync(identity,'not-a-workspace-id')],
  ['symlink',()=>{rmSync(identity);symlinkSync(join(b,'.roledock/workspace-id'),identity);}]
 ]){
  setup();const view=await controller.open(a,'mock');let writeRefused=false;try{await controller.rolesInstall(resolve('examples/custom-role'));}catch{writeRefused=true;}
  variants.push({kind,state:view.state,error:view.error,writeRefused,bRoles:(await B.owner.call('roles.list')).roles.map(r=>r.role_id)});
 }
 rmSync(identity);writeFileSync(identity,A.info.workspace_id,{mode:0o600});
 writeFileSync(join(a,'.roledock/owner-connection.json'),JSON.stringify(A.credential),{mode:0o600});
 const recoveredA=await controller.open(a,'mock');await controller.rolesInstall(resolve('examples/custom-role'));
 const rolesA=(await controller.rolesList()).roles;
 const correctB=await controller.open(b,'mock');await controller.rolesInstall(resolve('examples/demo-team'));
 const rolesB=(await controller.rolesList()).roles;
 const returnA=await controller.open(a,'mock');const afterSwitchA=(await controller.rolesList()).roles;
 const checks={identitySurvivesStop:identityFileAfterStop,foreignEndpointRejected:opened.state==='conflict'&&!install.ok,bUnchanged:bRoles.roles.length===0,variantsRejected:variants.every(v=>v.state==='conflict'&&v.writeRefused&&v.bRoles.length===0),recoverOriginalA:recoveredA.state==='running'&&recoveredA.workspaceId===A.info.workspace_id,correctBAttached:correctB.state==='running'&&correctB.workspaceId===B.info.workspace_id&&!correctB.owned,returnAKeepsIdentity:returnA.workspaceId===A.info.workspace_id,roleSeparation:rolesA.some(r=>r.role_id==='archivist')&&afterSwitchA.length===rolesA.length&&!rolesB.some(r=>r.role_id==='archivist')};
 console.log(JSON.stringify({expectedAId:A.info.workspace_id,bId:B.info.workspace_id,identityFileAfterStop,opened,installThroughA:install,rolesInB:bRoles.roles.map(r=>r.role_id),variants,recoveredA,correctB,returnA,rolesA,rolesB,afterSwitchA,checks},null,2));
 if(!Object.values(checks).every(Boolean))process.exitCode=1;
}finally{
 await supervisor?.reapOwned(1000);
 for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}}
 rmSync(dir,{recursive:true,force:true});
}
