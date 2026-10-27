import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(),'rd-g1-windows-'));
const env={...process.env, ROLEDOCK_SHELL_USER_DATA:join(dir,'ud'),ROLEDOCK_SHELL_NODE:join(root,'packages/desktop/.cache/runtime/node-v22.23.2-linux-x64/node')};
const main=join(root,'packages/desktop/dist-desktop/shell/main.mjs');
const app=await _electron.launch({args:[main],env});
try {
 const win = await app.firstWindow(); await win.waitForLoadState();
 const prefs=await app.evaluate(({BrowserWindow})=> { const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return {nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox};});
 const ws=join(dir,'ws'); mkdirSync(ws);
 const opened=await win.evaluate(dir=>window.roledock.shell.workspace.open({dir}),ws);
 const ownedPid=opened.result.pid;
 const before=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
 await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()) w.close();});
 let closed; for(let i=0;i<60;i++){ closed=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length); if(closed===0) break; await new Promise(r=>setTimeout(r,50)); }
 const serviceAliveAfterClose=(()=>{try{process.kill(ownedPid,0);return true;}catch{return false;}})();
 let secondOutput='';
 const second=spawn(require('electron'),[main],{env,stdio:['ignore','pipe','pipe']});
 second.stdout.on('data',s=>{secondOutput+=s;});second.stderr.on('data',()=>{});
 const secondExit=await new Promise(resolve=>{const timer=setTimeout(()=>{second.kill('SIGTERM');resolve('timeout');},7000);second.once('exit',code=>{clearTimeout(timer);resolve(code);});});
 await new Promise(r=>setTimeout(r,700));
 const after=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
 console.log(JSON.stringify({prefs,ownedPid,serviceAliveAfterClose,windowsBeforeClose:before,windowsAfterClose:closed,relaunch:{exit:secondExit,stdout:secondOutput.trim()},windowsAfterRelaunch:after},null,2));
} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
