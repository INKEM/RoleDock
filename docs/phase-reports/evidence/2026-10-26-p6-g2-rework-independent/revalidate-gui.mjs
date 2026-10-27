import { _electron } from '@playwright/test';
import { ServiceClient } from '@roledock/service';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
const root=process.cwd(),dir=mkdtempSync(join(tmpdir(),'rd-g2-gui-')),ws=join(dir,'a'),ud=join(dir,'ud');mkdirSync(ws);mkdirSync(ud);
const node=join(root,'packages/desktop/.cache/runtime/node-v22.23.2-linux-x64/node'), bundle=join(root,'packages/desktop/dist-desktop/vendor/service-bundle.mjs');
const app=await _electron.launch({args:[join(root,'packages/desktop/dist-desktop/shell/main.mjs')],env:{...process.env,ROLEDOCK_SHELL_NODE:node,ROLEDOCK_SHELL_USER_DATA:ud,ROLEDOCK_SHELL_DIALOG_FIXTURE:ws}});
let external;const results={};
try{
 const win=await app.firstWindow();
 const call=(ns,method,payload)=>win.evaluate(async({ns,method,payload})=>window.roledock.shell[ns][method](payload),{ns,method,payload});
 const unwrap=r=>{if(!r.ok)throw new Error(r.error.message);return r.result;};
 await win.getByRole('button',{name:'选择目录并打开…'}).click();
 await win.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('running'));
 const a=unwrap(await call('workspace','status'));
 await win.locator('.remove-recent').click();
 const settingsAfter=unwrap(await call('settings','get'));
 results.recent={diskPaths:JSON.parse(readFileSync(join(ud,'settings.json'),'utf8')).recentWorkspaces.map(r=>r.path),afterRemovePaths:settingsAfter.recentWorkspaces.map(r=>r.path),stillRecorded:settingsAfter.recentWorkspaces.some(r=>r.path===ws),workspaceDirectoryExists:existsSync(ws)};
 await call('roles','install',{dir:resolve('examples/demo-team')});
 await win.evaluate(()=>location.hash='#/roles');await win.locator('button[data-role="reviewer"]').click();
 await win.waitForFunction(()=>document.querySelector('#details-title')?.textContent?.includes('reviewer'));
 results.roleDetails={rpc:unwrap(await call('roles','get',{role_id:'reviewer'})),visibleText:await win.locator('#details-body').innerText(),templateText:readFileSync('examples/demo-team/templates/reviews.md','utf8'),schema:JSON.parse(readFileSync('examples/demo-team/schemas/review-result.json','utf8'))};
 await call('workspace','stop');
 await win.evaluate(()=>location.hash='#/settings');
 await win.locator('#launcher-kind').selectOption('zcode');await win.locator('#launcher-cli').fill('/opt/ZCode/resources/glm/zcode.cjs');await win.locator('#launcher-save').click();await win.waitForFunction(()=>document.querySelector('#launcher-saved')?.textContent?.includes('已保存'));
 await win.evaluate(()=>location.hash='#/workspace');await win.locator('#mode').selectOption('zcode');await win.locator('#open-dir').click();
 await win.waitForFunction(async()=>{const d=await window.roledock.shell.workspace.diagnostics();return d.ok&&d.result.service.adapter==='zcode';},undefined,{timeout:40000});
 const before=unwrap(await call('workspace','diagnostics'));
 await win.locator('#restart').click();
 await win.waitForFunction(async oldPid=>{const d=await window.roledock.shell.workspace.diagnostics();return d.ok&&d.result.service.pid!==oldPid&&d.result.service.adapter==='zcode';},before.service.pid,{timeout:40000});
 const after=unwrap(await call('workspace','diagnostics'));
 results.restart={beforeAdapter:before.service.adapter,afterAdapter:after.service.adapter,sameWorkspace:before.workspace_id===after.workspace_id,status:unwrap(await call('workspace','status')),persistedKind:JSON.parse(readFileSync(join(ws,'.roledock/launcher-config.json'),'utf8')).kind};
 await call('workspace','stop');
 const b=join(dir,'b');mkdirSync(b);external=spawn(node,[bundle,'--mock-workspace',b],{env:{},stdio:'ignore'});
 let cred,bOwner,bInfo;
 for(let n=0;n<150;n++){
  try{cred=JSON.parse(readFileSync(join(b,'.roledock/owner-connection.json'),'utf8'));bOwner=new ServiceClient(cred);bInfo=await bOwner.call('workspace.info',{}, {timeoutMs:1000});break;}catch{} await new Promise(r=>setTimeout(r,100));
 }
 if(!bInfo)throw new Error('temporary B service not ready');
 const countBefore=(await bOwner.call('roles.list')).roles.length;const identityFilePresentAfterAStopped=existsSync(join(ws,'.roledock/workspace-id'));
 writeFileSync(join(ws,'.roledock/owner-connection.json'),JSON.stringify(cred),{mode:0o600});chmodSync(join(ws,'.roledock/owner-connection.json'),0o600);
 const wrong=unwrap(await call('workspace','open',{dir:ws,launcher:'mock'}));
 const installThroughA=await call('roles','install',{dir:resolve('examples/custom-role')});
 const bRoles=(await bOwner.call('roles.list')).roles.map(r=>r.role_id);
 results.identity={identityFilePresentAfterAStopped,installThroughA,directoryChosen:ws,expectedWorkspaceId:a.workspaceId,actualWorkspaceId:wrong.workspaceId,bWorkspaceId:bInfo.workspace_id,attached:wrong.state==='running',roleCountBeforeB:countBefore,rolesInBAfterInstallThroughA:bRoles};
 console.log(JSON.stringify(results,null,2));
}finally{
 await app.close().catch(()=>{});
 if(external&&external.exitCode===null&&external.signalCode===null){const exited=once(external,'exit');external.kill('SIGTERM');await exited;}
 rmSync(dir,{recursive:true,force:true});
}
