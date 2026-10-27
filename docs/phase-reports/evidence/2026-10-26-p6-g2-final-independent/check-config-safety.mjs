import { transformSync } from 'esbuild';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,symlinkSync,rmSync,lstatSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const {code}=transformSync(readFileSync('packages/desktop/src/shell/shared/launcher.ts','utf8'),{loader:'ts',format:'esm',target:'node22'});
const {writeLauncherConfigFile}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const dir=mkdtempSync(join(tmpdir(),'rd-g2-safety-')),config={kind:'zcode',cliPath:'/synthetic/cli',connectorPath:'/synthetic/connector'};
const results={};
try{
 const normal=join(dir,'normal');mkdirSync(normal);const file=writeLauncherConfigFile(normal,config);const before=JSON.parse(readFileSync(file,'utf8'));writeLauncherConfigFile(normal,{...config,provider:'fixture'});
 results.normal={firstKind:before.kind,updatedProvider:JSON.parse(readFileSync(file,'utf8')).provider,mode:(lstatSync(file).mode&0o777).toString(8)};
 const ws=join(dir,'linked-file');mkdirSync(join(ws,'.roledock'),{recursive:true});const target=join(dir,'notes');writeFileSync(target,'SYNTHETIC_NOTES',{mode:0o640});const prior=lstatSync(target);const link=join(ws,'.roledock/launcher-config.json');symlinkSync(target,link);
 let refused=false;try{writeLauncherConfigFile(ws,config);}catch{refused=true;}
 results.fileLink={refused,contentPreserved:readFileSync(target,'utf8')==='SYNTHETIC_NOTES',modePreserved:lstatSync(target).mode===prior.mode,inodePreserved:lstatSync(target).ino===prior.ino,linkPreserved:lstatSync(link).isSymbolicLink()};
 const linkedDir=join(dir,'linked-dir'),targetDir=join(dir,'state-target');mkdirSync(linkedDir);mkdirSync(targetDir);symlinkSync(targetDir,join(linkedDir,'.roledock'));refused=false;try{writeLauncherConfigFile(linkedDir,config);}catch{refused=true;}
 results.directoryLink={refused,targetEmpty:readdirSync(targetDir).length===0};
 results.checks={normalFirstAndUpdate:results.normal.firstKind==='zcode'&&results.normal.updatedProvider==='fixture'&&results.normal.mode==='600',fileLink:Object.values(results.fileLink).every(Boolean),directoryLink:Object.values(results.directoryLink).every(Boolean)};
 console.log(JSON.stringify(results,null,2));if(!Object.values(results.checks).every(Boolean))process.exitCode=1;
}finally{rmSync(dir,{recursive:true,force:true});}
