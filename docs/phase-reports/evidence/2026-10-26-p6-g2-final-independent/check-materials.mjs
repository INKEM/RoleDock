import { WorkspaceService,ServiceClient } from '@roledock/service';
import { MockHarnessAdapter } from '@roledock/adapter-mock';
import { validateRolePack } from '@roledock/protocol';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir=mkdtempSync(join(tmpdir(),'rd-g2-material-')),root=join(dir,'ws'),source=join(dir,'source');mkdirSync(join(source,'materials'),{recursive:true});mkdirSync(root);
const manifest={schema_version:'0.1',name:'edge-material-pack',version:'0.1.0',requires_protocol:'0.1',roles:[{id:'custodian',title:'Custodian',instructions:'materials/guide',documents:[{key:'inventory',template:'materials/layout',visibility:'project'}],output_schemas:[{key:'inventory-result',schema:'materials/record'}],requested_capabilities:['documents.read']}]};
const instructions='# Custodian\n\nTrack provenance and inventory.';const template='# Inventory\n\n| Item | Origin |\n';const schema=JSON.stringify({type:'object',required:['origin'],properties:{origin:{type:'string'}},additionalProperties:false});
writeFileSync(join(source,'rolepack.json'),JSON.stringify(manifest));writeFileSync(join(source,'materials/guide'),instructions);writeFileSync(join(source,'materials/layout'),template);writeFileSync(join(source,'materials/record'),schema);
let service;
try{
 service=await WorkspaceService.start({root,adapter:new MockHarnessAdapter(),socketPath:join(root,'service.sock'),pollMs:25});const owner=new ServiceClient(service.ownerCredential);
 const installed=await owner.call('roles.install',{source_path:source});const details=await owner.call('roles.get',{role_id:'custodian'});
 writeFileSync(join(source,'materials/guide'),'SOURCE_EDIT_AFTER_INSTALL');const afterSourceEdit=await owner.call('roles.get',{role_id:'custodian'});
 const copy=join(root,'.roledock/packs/edge-material-pack/0.1.0/materials/guide');
 const failures=[];
 rmSync(copy);
 try{await owner.call('roles.get',{role_id:'custodian'});failures.push({kind:'missing',refused:false});}catch(e){failures.push({kind:'missing',refused:true,code:e.code,message:e.message});}
 mkdirSync(copy);
 try{await owner.call('roles.get',{role_id:'custodian'});failures.push({kind:'directory',refused:false});}catch(e){failures.push({kind:'directory',refused:true,code:e.code,message:e.message});}
 rmSync(copy,{recursive:true});writeFileSync(copy,instructions);
 const repaired=await owner.call('roles.get',{role_id:'custodian'});
 const checks={instructionsExact:details.instructions===instructions,templateExact:details.documents[0].template===template,schemaExact:details.output_schemas[0].schema===schema,installedSnapshotUnaffectedBySourceEdit:afterSourceEdit.instructions===instructions,missingOrNonFileExplicitError:failures.every(f=>f.refused&&f.code==='INTERNAL'),restoredCopyReadable:repaired.instructions===instructions};
 console.log(JSON.stringify({manifestValid:validateRolePack(manifest).ok,installed,expected:{instructions,template,schema},actual:details,failures,checks},null,2));
 if(!Object.values(checks).every(Boolean))process.exitCode=1;
}finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
