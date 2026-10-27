import { transformSync } from 'esbuild';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,symlinkSync,rmSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const src=readFileSync('packages/desktop/src/shell/shared/launcher.ts','utf8');
const {code}=transformSync(src,{loader:'ts',format:'esm',target:'node22'});
const {writeLauncherConfigFile}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const dir=mkdtempSync(join(tmpdir(),'rd-g2-file-'));
try{
 const workspace=join(dir,'ws');mkdirSync(join(workspace,'.roledock'),{recursive:true});
 const target=join(dir,'existing-notes.txt'),sentinel='SYNTHETIC_EXISTING_USER_NOTES';writeFileSync(target,sentinel,{mode:0o644});
 symlinkSync(target,join(workspace,'.roledock/launcher-config.json'));
 const config={kind:'zcode',cliPath:'/synthetic/zcode.cjs',connectorPath:'/synthetic/connector.mjs'};
 const path=writeLauncherConfigFile(workspace,config);
 console.log(JSON.stringify({returnedPath:path,targetBefore:sentinel,targetAfter:readFileSync(target,'utf8'),targetModeAfter:(statSync(target).mode&0o777).toString(8),targetPreserved:readFileSync(target,'utf8')===sentinel},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
