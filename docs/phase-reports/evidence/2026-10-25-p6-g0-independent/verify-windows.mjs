import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const evidence=fileURLToPath(new URL('./',import.meta.url));
const packageRoot=join(root,'packages/desktop');
const nodePath=join(packageRoot,'.cache/runtime/node-v22.23.2-linux-x64/node');
const packaged=join(packageRoot,'dist-app/linux-unpacked/roledock-desktop-probe');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const base=mkdtempSync(join(tmpdir(),'rd-g0-independent-packaged-'));
const env={...process.env,ROLEDOCK_PROBE_DIR:base};
delete env.ROLEDOCK_PROBE_NODE;delete env.ROLEDOCK_PROBE_DIALOG_FIXTURE;
const app=await _electron.launch({executablePath:packaged,cwd:tmpdir(),env});
let servicePid;
try{
 const win=await app.firstWindow();
 const prefs=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox};});
 assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);
 await win.click('#start');
 await win.waitForFunction(()=>document.querySelector('#status').textContent.includes('service.state=running'));
 const state=JSON.parse(readFileSync(join(base,'state.json'),'utf8'));servicePid=state.service.pid;
 await win.click('#run-checks');
 await win.waitForFunction(()=>document.querySelectorAll('#checks li').length===4,undefined,{timeout:60000});
 const checks=await win.locator('#checks li').allTextContents();
 assert.equal(checks.length,4);assert.ok(checks.every(row=>row.startsWith('✅')));assert.ok(checks[0].includes('source=packaged'));
 const status=await win.evaluate(()=>window.roledock.probe.getStatus());assert.equal(status.mode,'packaged');assert.equal(status.runtimeVersion,'v22.23.2');assert.equal(JSON.stringify(status).includes('"token"'),false);
 await win.screenshot({path:join(evidence,'packaged-window.png'),fullPage:true});
 console.log(JSON.stringify({kind:'independent_packaged_window',prefs,checks,packaged:true,runtimeVersion:status.runtimeVersion}));
}finally{
 await app.close();
 if(servicePid){let gone=false;for(let i=0;i<50;i++){try{process.kill(servicePid,0);}catch{gone=true;break;}await delay(100);}assert.equal(gone,true,'owned service not reaped');}
}
const nativeBase=mkdtempSync(join(tmpdir(),'rd-g0-independent-dialog-'));
const nativeEnv={...process.env,ROLEDOCK_PROBE_DIR:nativeBase,ROLEDOCK_PROBE_NODE:nodePath};delete nativeEnv.ROLEDOCK_PROBE_DIALOG_FIXTURE;
const native=await _electron.launch({args:[join(packageRoot,'dist-desktop/vendor/main.mjs')],cwd:packageRoot,env:nativeEnv});
try{
 const win=await native.firstWindow();
 await win.click('#pick');await delay(1500);
 const tree=execFileSync('xwininfo',['-root','-tree'],{encoding:'utf8',timeout:5000});
 const ownDialog=tree.split('\n').filter(line=>line.includes('RoleDock 探针：选择目录')).map(line=>line.trim());
 assert.ok(ownDialog.length>0,'native dialog not observed');
 console.log(JSON.stringify({kind:'independent_native_dialog_open',ownDialog,selection_roundtrip:'not verified; automated fixture roundtrip covered separately',serviceStarted:false}));
}finally{
 native.process().kill('SIGTERM');
 await Promise.race([new Promise(resolve=>native.process().once('exit',resolve)),delay(3000)]);
 if(native.process().exitCode===null&&native.process().signalCode===null)native.process().kill('SIGKILL');
}
