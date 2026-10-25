// No ZCode/model/account. Tests only the diagnostic process cleanup boundary.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync(process.env.ROLEDOCK_ZCODE_TEST_PID_FILE,JSON.stringify({connector:process.pid,child:child.pid}));
process.stderr.write('fixture-private-diagnostic\n');
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);
  appendFileSync(process.env.ROLEDOCK_ZCODE_TEST_PID_FILE+'.events',message.method+'\n');
  if(message.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'process-fixture',version:'1.0.0'}}})+'\n');
  if(message.method==='tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[]}})+'\n');
});
