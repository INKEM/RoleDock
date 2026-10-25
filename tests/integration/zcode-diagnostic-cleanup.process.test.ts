import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const run=promisify(execFile);
function running(pid:number):boolean {
  try { return readFileSync(`/proc/${pid}/stat`,"utf8").split(") ")[1]?.[0] !== "Z"; } catch { return false; }
}
it("diagnostic constructor failure disconnects its owned connector process group without exposing stderr",async()=>{
  const root=mkdtempSync(join(tmpdir(),"rd-zcode-cleanup-")); const pidFile=join(root,"pids.json");const blocked=join(root,"not-a-directory");writeFileSync(blocked,"keep");
  let pids:{connector:number;child:number}|undefined;
  try {
    let failure:{code?:number;stdout?:string;stderr?:string}|undefined;
    try { await run(process.execPath,[resolve("adapters/zcode/dist/bin.js"),"--connector",resolve("tests/integration/helpers/zcode-connector-fixture.mjs"),"--workspace",root,"--state-dir",blocked],{env:{...process.env,ROLEDOCK_ZCODE_TEST_PID_FILE:pidFile},timeout:15000}); }
    catch(error) { failure=error as typeof failure; }
    pids=JSON.parse(readFileSync(pidFile,"utf8"));
    expect(failure?.code,JSON.stringify({failure,events:readFileSync(pidFile+'.events',"utf8")})).toBe(1);expect(failure?.stderr).not.toContain("fixture-private-diagnostic");expect(failure?.stdout).not.toContain("fixture-private-diagnostic");
    for(let i=0;i<20&&[pids!.connector,pids!.child].some(running);i++)await new Promise(r=>setTimeout(r,50));
    expect(running(pids!.connector)).toBe(false);expect(running(pids!.child)).toBe(false);
    expect(readFileSync(blocked,"utf8")).toBe("keep");
  } finally {
    if(pids?.connector&&running(pids.connector))try{process.kill(-pids.connector,"SIGKILL");}catch{/*Already stopped.*/}
    rmSync(root,{recursive:true,force:true});
  }
});
