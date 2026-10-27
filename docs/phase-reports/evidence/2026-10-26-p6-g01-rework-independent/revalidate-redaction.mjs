import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const input={authorization_id:'auth-public',content_hash:'0123456789abcdef'.repeat(4),host_session_id:'abcdef0123456789'.repeat(2),event_ref:'event-'+'9876543210abcdef'.repeat(4), nested:[{content_hash:'fedcba9876543210'.repeat(4)}],owner_credential_token:'SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL',message:'Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL rejected'};
const results=[];
for(const path of ['packages/desktop/src/probe/shared/bridge.ts','packages/desktop/src/shell/shared/redact.ts']){
 const {code}=transformSync(readFileSync(path,'utf8'),{loader:'ts',format:'esm',target:'node22'});
 const {redact}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const output=redact(input);
 const checks={publicHashExact:output.content_hash===input.content_hash,hostIdExact:output.host_session_id===input.host_session_id,eventRefExact:output.event_ref===input.event_ref,nestedHashExact:output.nested[0].content_hash===input.nested[0].content_hash,secretRemoved:!('owner_credential_token' in output),labeledTextMasked:output.message==='Authorization: Bearer [masked] rejected'};
 if(!Object.values(checks).every(Boolean)) process.exitCode=1;
 results.push({path,output,checks});
}
console.log(JSON.stringify(results,null,2));
