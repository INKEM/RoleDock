import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const probe = `import {WorkspaceStore} from '/home/inkem/Personal/RoleDock/packages/core/dist/testing.js'; try {const s=WorkspaceStore.open({root:process.argv[1]}); console.log('OPEN'); s.close();}catch(e){console.log(e.code);}`;
for (const mode of ['unused','retained']) {
 const root = mkdtempSync(join(tmpdir(),'rd-lock-gc-'));
 const child=spawn(process.execPath,['--expose-gc',`/tmp/rd-holder-${mode}.mjs`,root],{stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',c=>errors+=c);
 try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(new Error('early exit '+code+errors)));});
  await new Promise(r=>setTimeout(r,500));
  const p=spawnSync(process.execPath,['--input-type=module','-e',probe,root],{encoding:'utf8',timeout:5000});
  console.log(JSON.stringify({mode,holder_alive:child.exitCode===null&&child.signalCode===null,probe:p.stdout.trim(),status:p.status,stderr:p.stderr}));
 }finally{child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));rmSync(root,{recursive:true,force:true});}
}
