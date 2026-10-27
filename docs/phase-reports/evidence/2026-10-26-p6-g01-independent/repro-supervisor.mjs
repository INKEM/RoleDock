import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ServiceClient } from '@roledock/service';
const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'rd-g1-review-'));
const bundle = join(temp, 'review.mjs');
symlinkSync(join(root,'node_modules'),join(temp,'node_modules'));
await build({ stdin: { contents: `export { WorkspaceSupervisor } from './packages/desktop/src/shell/supervisor.ts'; export { WorkspaceController } from './packages/desktop/src/shell/main/workspace-controller.ts';`, resolveDir: root }, external:['@roledock/*'],bundle:true,platform:'node',format:'esm',outfile:bundle,banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'} });
const { WorkspaceSupervisor, WorkspaceController } = await import(pathToFileURL(bundle).href);
const nodePath = join(root,'packages/desktop/.cache/runtime/node-v22.23.2-linux-x64/node');
const bundlePath = join(root,'packages/desktop/dist-desktop/vendor/service-bundle.mjs');
const children = [];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const alive = pid => { try { process.kill(pid,0); return true; } catch { return false; } };
const results = {};
let supervisor;
async function info(dir) {
 const credential = JSON.parse(readFileSync(join(dir,'.roledock/owner-connection.json'),'utf8'));
 return new ServiceClient(credential).call('workspace.info',{}, {timeoutMs:1000});
}
async function waitReady(dir) { for(let i=0;i<100;i++){ try{return await info(dir);}catch{} await sleep(100); } throw new Error('not ready'); }
try {
 const externalDir = mkdtempSync(join(temp,'ext-'));
 const child = spawn(nodePath,[bundlePath,'--mock-workspace',externalDir],{env:{},stdio:'ignore'}); children.push(child);
 await waitReady(externalDir);
 const sup = new WorkspaceSupervisor({nodePath,bundlePath}); const ctl = new WorkspaceController(sup);
 const attached = await ctl.open(externalDir);
 let diagnostics;
 try { diagnostics={ok:true,result:await ctl.diagnostics()}; } catch(e) {diagnostics={ok:false,error:e.message};}
 let roles;
 try { roles={ok:true,result:await ctl.confirmRoles()}; } catch(e) {roles={ok:false,error:e.message};}
 child.kill('SIGTERM'); await new Promise(r=>child.once('exit',r));
 const refreshed=await ctl.refresh();
 results.attach={attached,ownerClientPresent:!!sup.ownerClient(externalDir),diagnostics,roles,afterExternalExit:refreshed};
 const ownedDir=mkdtempSync(join(temp,'owned-'));
 supervisor = new WorkspaceSupervisor({nodePath,bundlePath});
 const first=await supervisor.open(ownedDir); children.push({pid:first.pid,kill:s=>{try{process.kill(first.pid,s);}catch{}}});
 const second=await supervisor.open(ownedDir);
 const reaped=await supervisor.reapOwned(500);
 results.reopen={first,second,reaped,originalProcessSurvivesQuit:alive(first.pid),writerStillAnswers:await info(ownedDir).then(()=>true,()=>false)};
 console.log(JSON.stringify(results,null,2));
} finally {
 for (const child of children) child.kill('SIGTERM');
 await sleep(500);
 for (const child of children) if (child.pid && alive(child.pid)) child.kill('SIGKILL');
 await sleep(100);
 rmSync(temp,{recursive:true,force:true});
}
