import { _electron } from '@playwright/test';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const [binary,out]=process.argv.slice(2),dir=mkdtempSync(join(tmpdir(),'rd-g2-pkg-')),ws=join(dir,'ws');mkdirSync(ws);
const app=await _electron.launch({executablePath:binary,args:[],env:{...process.env,ROLEDOCK_SHELL_USER_DATA:join(dir,'ud'),ROLEDOCK_SHELL_DIALOG_FIXTURE:ws}});
const result={};
try{
 const win=await app.firstWindow();await win.waitForLoadState();
 const call=(ns,method,payload)=>win.evaluate(({ns,method,payload})=>window.roledock.shell[ns][method](payload),{ns,method,payload});
 const mock=await call('workspace','open',{dir:ws,launcher:'mock'});result.mock=mock;
 await call('workspace','stop');
 await call('settings','set',{launcher:{kind:'zcode',cliPath:'/opt/ZCode/resources/glm/zcode.cjs',credentialHelper:null,provider:null,model:null,managedEgress:[]}});
 const preflight=await call('workspace','preflight');result.preflight=preflight;
 result.connectionTest=await call('workspace','testConnection');
 result.zcode=await call('workspace','open',{dir:ws,launcher:'zcode'});
 result.connectorPath=JSON.parse(readFileSync(join(ws,'.roledock/launcher-config.json'),'utf8')).connectorPath;
 await win.screenshot({path:out.replace(/\.json$/,'.png'),fullPage:true});
 console.log(JSON.stringify(result,null,2));
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
