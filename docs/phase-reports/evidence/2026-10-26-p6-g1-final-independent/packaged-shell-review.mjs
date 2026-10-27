import { _electron } from '@playwright/test';
import { validate } from '@roledock/protocol';
import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const [binary,outFile]=process.argv.slice(2);
const dir=mkdtempSync(join(tmpdir(),'rd-g1-pkg-'));
const ws=join(dir,'ws');mkdirSync(ws);
const app=await _electron.launch({executablePath:binary,args:[],env:{...process.env,ROLEDOCK_SHELL_USER_DATA:join(dir,'ud'),ROLEDOCK_SHELL_DIALOG_FIXTURE:ws}});
let pid;
const alive=p=>{try{process.kill(p,0);return true;}catch{return false;}};
const result={};
try{
 const win=await app.firstWindow();
 await win.getByRole('button',{name:'选择目录并打开…'}).click();
 await win.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('running（本应用启动）'),undefined,{timeout:60000});
 const d=await win.evaluate(()=>window.roledock.shell.workspace.diagnostics());
 if(!d.ok)throw new Error(d.error.message);
 const projection={workspace_id:d.result.workspace_id,service:d.result.service};pid=projection.service.pid;
 const checked=validate('workspace-service-info',projection);
 const actualRuntime=readlinkSync(`/proc/${pid}/exe`);
 const expectedRuntime=resolve(binary,'..','resources/runtime/node/node');
 const prefs=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox};});
 const renderer=await win.evaluate(()=>({noProcess:typeof process==='undefined',noRequire:typeof require==='undefined'}));
 Object.assign(result,{projection,actualRuntime,expectedRuntime,prefs,renderer,schemaValid:checked.ok,checks:{schemaValid:checked.ok,lockedNode:projection.service.runtime==='v22.23.2',packagedRuntimeUsed:actualRuntime===expectedRuntime,rendererIsolated:!prefs.nodeIntegration&&prefs.contextIsolation&&prefs.sandbox&&renderer.noProcess&&renderer.noRequire}});
 await win.screenshot({path:outFile.replace(/\.json$/,'.png'),fullPage:true});
}finally{
 await app.close();
 if(pid){for(let n=0;n<100&&alive(pid);n++)await new Promise(r=>setTimeout(r,50));}
 result.ownedServiceGone=pid?!alive(pid):null;
 writeFileSync(outFile,JSON.stringify(result,null,2)+'\n');
 rmSync(dir,{recursive:true,force:true});
}
if(!result.ownedServiceGone||!Object.values(result.checks??{}).every(Boolean))process.exitCode=1;
