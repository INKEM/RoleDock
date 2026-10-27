import { _electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const [binary,out]=process.argv.slice(2);
const dir=mkdtempSync(join(tmpdir(),'rd-g2-rework-pkg-')),ws=join(dir,'ws'),ud=join(dir,'ud');mkdirSync(ws);
const env={...process.env,ROLEDOCK_SHELL_USER_DATA:ud,ROLEDOCK_SHELL_DIALOG_FIXTURE:ws};
let app;
const result={};
const unwrap=r=>{if(!r.ok)throw new Error(JSON.stringify(r.error));return r.result;};
try {
 app=await _electron.launch({executablePath:resolve(binary),args:[],cwd:dir,env});
 let win=await app.firstWindow();await win.waitForLoadState();
 const call=async(ns,method,payload)=>unwrap(await win.evaluate(async({ns,method,payload})=>await window.roledock.shell[ns][method](payload),{ns,method,payload}));
 result.mock=await call('workspace','open',{dir:ws,launcher:'mock'});
 await call('roles','install',{dir:resolve('examples/demo-team')});
 const details=await call('roles','get',{role_id:'reviewer'});
 result.standardMaterials={instructionsExact:details.instructions===readFileSync('examples/demo-team/roles/reviewer.md','utf8'),templateExact:details.documents[0].template===readFileSync('examples/demo-team/templates/reviews.md','utf8'),schemaExact:details.output_schemas[0].schema===readFileSync('examples/demo-team/schemas/review-result.json','utf8')};
 await call('workspace','stop');
 await call('settings','set',{launcher:{kind:'zcode',cliPath:'/opt/ZCode/resources/glm/zcode.cjs',credentialHelper:null,provider:null,model:null,managedEgress:[]}});
 result.preflight=await call('workspace','preflight');
 result.connectionTest=await call('workspace','testConnection');
 result.zcode=await call('workspace','open',{dir:ws,launcher:'zcode'});
 result.before=await call('workspace','diagnostics');
 result.connectorPath=JSON.parse(readFileSync(join(ws,'.roledock/launcher-config.json'),'utf8')).connectorPath;
 result.restart=await call('workspace','restart');
 result.after=await call('workspace','diagnostics');
 await call('workspace','stop');
 result.reopenWithoutLauncher=await call('workspace','open',{dir:ws});
 result.reopenDiagnostics=await call('workspace','diagnostics');
 await call('workspace','removeRecent',{path:ws});
 result.recent={after:(await call('settings','get')).recentWorkspaces,disk:JSON.parse(readFileSync(join(ud,'settings.json'),'utf8')).recentWorkspaces,workspaceExists:existsSync(ws)};
 await win.screenshot({path:out.replace(/\.json$/,'.png'),fullPage:true});
 await app.close();app=null;
 app=await _electron.launch({executablePath:resolve(binary),args:[],cwd:dir,env});
 win=await app.firstWindow();await win.waitForLoadState();
 result.recent.afterAppRelaunch=(await call('settings','get')).recentWorkspaces;
 result.openAfterAppRelaunch=await call('workspace','open',{dir:ws});
 result.afterAppRelaunchDiagnostics=await call('workspace','diagnostics');
 // This PID belongs to the service just created in this isolated test workspace.
 process.kill(result.openAfterAppRelaunch.pid,'SIGKILL');
 let killed;
 for(let i=0;i<50;i++){killed=await call('workspace','status');if(killed.state==='disconnected')break;await new Promise(r=>setTimeout(r,100));}
 if(killed.state!=='disconnected')throw new Error('Owned service exit was not observed');
 result.crashReopen=await call('workspace','open',{dir:ws});
 result.crashDiagnostics=await call('workspace','diagnostics');
 await call('workspace','stop');
 const configPath=join(ws,'.roledock/launcher-config.json'),config=JSON.parse(readFileSync(configPath,'utf8'));
 writeFileSync(configPath,JSON.stringify({...config,cliPath:join(dir,'missing-cli.cjs')}));
 result.invalidConfigOpen=await call('workspace','open',{dir:ws});
 // Reopen an existing real workspace with an invalid config endpoint. The
 // reference target is synthetic and remains inside this disposable fixture.
 const referencePath=join(dir,'saved-config.json');writeFileSync(referencePath,JSON.stringify(config));
 rmSync(configPath);symlinkSync(referencePath,configPath);
 result.linkedConfigOpen=await call('workspace','open',{dir:ws});
 result.linkedConfig={endpointStillLink:lstatSync(configPath).isSymbolicLink(),targetUnchanged:readFileSync(referencePath,'utf8')===JSON.stringify(config)};
 if(result.linkedConfigOpen.state==='running')result.linkedConfigDiagnostics=await call('workspace','diagnostics');
 result.checks={mockRunning:result.mock.state==='running',zcodeRunning:result.zcode.state==='running'&&result.before.service.adapter==='zcode',restartKeptZcode:result.after.service.adapter==='zcode',restartSameWorkspace:result.before.workspace_id===result.after.workspace_id,reopenKeptZcode:result.reopenDiagnostics.service.adapter==='zcode',appRelaunchKeptZcode:result.afterAppRelaunchDiagnostics.service.adapter==='zcode',crashReopenKeptZcode:result.crashDiagnostics.service.adapter==='zcode',invalidConfigFailedWithoutMock:result.invalidConfigOpen.mode==='zcode'&&result.invalidConfigOpen.state!=='running',externalConnector:result.connectorPath.includes('/resources/runtime/vendor/'),recentRemoved:[result.recent.after,result.recent.disk,result.recent.afterAppRelaunch].every(items=>!items.some(i=>i.path===ws)),workspacePreserved:result.recent.workspaceExists};
 console.log(JSON.stringify(result,null,2));
 if(Object.values(result.checks).some(v=>!v)||Object.values(result.standardMaterials).some(v=>!v))process.exitCode=1;
} finally { if(app)await app.close();rmSync(dir,{recursive:true,force:true}); }
