import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "../../../packages/core/src/index.js";
import { testingOpenPrimarySession, executeRequest } from "../../../packages/core/src/testing.js";
import { coordinatorStore } from "../../../packages/core/src/internal-store.js";
import { ZCodeAdapter } from "../src/index.js";
import type { ZCodeToolCaller } from "../src/index.js";

// Connector fixtures prove refusal/journal/trace boundaries, never a real model.
class Fixture implements ZCodeToolCaller {
  calls: { name: string; input: Record<string, unknown> }[] = [];
  statuses: unknown[] = [];
  createError = false; sendError = false; accepted = true;
  createBarrier: Promise<void> | undefined;
  verifyAnswers: (Record<string, unknown> | Error)[] = [];
  declaredTools: ReadonlySet<string> | undefined;
  loadState: "loaded" | "unknown" | "absent" = "loaded";
  loadVersion = 1;
  closeAnswer: boolean | Error = true;
  get tools(): ReadonlySet<string> | undefined { return this.declaredTools; }
  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, input });
    if (name === "zcode_create_session") {
      await this.createBarrier;
      if (this.createError) throw new Error("accepted then disconnected");
      return { sessionId: "sess_fixture-1" };
    }
    if (name === "zcode_send") {
      if (this.sendError) throw new Error("lost confirmation");
      return { sessionId: input.sessionId, accepted: this.accepted };
    }
    if (name === "zcode_status") return this.statuses.shift() ?? { sessionId: "sess_fixture-1", status: "idle", lastSeq: 10 };
    if (name === "zcode_verify_session") {
      const answer = this.verifyAnswers.shift();
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("fixture verify answers exhausted");
      return { sessionId: input.sessionId, ...answer };
    }
    if (name === "zcode_load_material") return { sessionId: input.sessionId, loadKey: input.loadKey, accepted: true, marker: 100 };
    if (name === "zcode_lookup_load") {
      if (this.loadState !== "loaded") return { state: this.loadState };
      return { state: "loaded", confirmation: { host_session_id: input.sessionId, load_key: input.loadKey, content_hash: input.contentHash, load_version: this.loadVersion } };
    }
    if (name === "zcode_cancel") return { sessionId: input.sessionId, stop_signal_sent: true };
    if (name === "zcode_close") {
      if (this.closeAnswer instanceof Error) throw this.closeAnswer;
      return { sessionId: input.sessionId, closed: this.closeAnswer };
    }
    throw new Error("Unexpected fixture operation");
  }
}
const roots: string[] = [], journals: ZCodeAdapter[] = [], cores: Coordinator[] = [];
afterEach(() => { for (const core of cores.splice(0)) core.close(); for (const a of journals.splice(0)) a.closeJournal(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function setup(tools = new Fixture()) {
  const root = mkdtempSync(join(tmpdir(),"rd-zcode-contract-")); roots.push(root);
  const options = { tools, workspacePath: root, stateDir: join(root,"journal") };
  const adapter = new ZCodeAdapter(options); journals.push(adapter);
  return { root, tools, adapter, options };
}
function restart(context: ReturnType<typeof setup>) {
  context.adapter.closeJournal(); journals.splice(journals.indexOf(context.adapter),1);
  context.adapter = new ZCodeAdapter(context.options); journals.push(context.adapter);
}
function trace(body = "actual fixture answer") {
  return { sessionId: "sess_fixture-1", status: "idle", lastSeq: 14, pendingRequests: [], lastTurn: { type: "turn.completed", response: body }, recentEvents: [
    { seq:11,type:"turn.started" },{seq:12,type:"model.streaming"},{seq:13,type:"turn.completed",response:body},{seq:14,type:"session.titleUpdated"},
  ] };
}
describe("ZCode restricted connector contract (fixtures)",()=>{
  it("declares restricted capabilities and refuses scope/temp-dir before any host action", async()=>{
    const c=setup(); expect(c.adapter.getCapabilities()).toMatchObject({level:"restricted",external:{human_authorization_events:true,load_materials:true},optional:{cancel:true,native_resume:false}});
    for(const input of [{capability_scope:[]},{temp_dir:c.root}]) await expect(c.adapter.createSession({creation_key:"role",...input})).rejects.toMatchObject({code:"NOT_IMPLEMENTED"});
    await expect(c.adapter.createSession({creation_key:"tampered",bootstrap:{bundle_id:"b",role_id:"anything",payload:"body",content_hash:"0".repeat(64)}})).rejects.toMatchObject({code:"VALIDATION_FAILED"});
    expect(c.tools.calls).toHaveLength(0);
  });
  it("initializes a role through the core SDK with a fixture material load (B4 production declarations)",async()=>{
    const c=setup();c.tools.declaredTools=new Set(["zcode_create_session","zcode_verify_session","zcode_load_material","zcode_lookup_load"]);
    c.tools.statuses.push({sessionId:"sess_fixture-1",status:"idle",lastSeq:101,recentEvents:[{seq:101,type:"turn.completed"}]});
    const core=Coordinator.open({root:join(c.root,"core"),adapter:c.adapter}); cores.push(core);
    await core.installRolePack({source_path:resolve("examples/demo-team")});
    WorkspaceAdmin.forCoordinator(core).grant({role_id:"builder",capability:"documents.read"});
    const opened=await core.openSession({role_id:"builder",creation_key:"initial"});
    expect(opened.generation).toBe(1); expect(opened.handoff.performed).toBe(false);
    expect(c.tools.calls.filter(x=>x.name==="zcode_load_material")).toHaveLength(1);
    const head=coordinatorStore(core).prepare("SELECT generation,current_instance_id FROM role_heads WHERE role_id='builder'").get() as {generation:number};
    expect(head.generation).toBe(1);
  });
  it("ten overlapping RoleDock jobs are refused without spending a host turn or creating artifacts",async()=>{
    const c=setup(),core=Coordinator.open({root:join(c.root,"core"),adapter:c.adapter}); cores.push(core);
    await core.installRolePack({source_path:resolve("examples/demo-team")});
    const admin=WorkspaceAdmin.forCoordinator(core);
    admin.grant({role_id:"builder",capability:"requests.create"});
    admin.grant({role_id:"reviewer",capability:"requests.execute"}); admin.grant({role_id:"reviewer",capability:"documents.read"});
    const primary=testingOpenPrimarySession(core,{role_id:"builder"}); testingOpenPrimarySession(core,{role_id:"reviewer"});
    const requests=[]; for(let i=0;i<10;i++) requests.push(await core.createRequest({session_id:primary.session_id,target_role_id:"reviewer",question:`job ${i}`,idempotency_key:`q${i}`,read_exception_rationale:"No documents yet"}));
    const store=coordinatorStore(core); const results=await Promise.allSettled(requests.map(r=>executeRequest(store,c.adapter,r.request_id)));
    expect(results.every(r=>r.status==="rejected"&&r.reason.code==="ADAPTER_CAPABILITY_MISSING")).toBe(true);
    await new ExternalSessionAuthority(core,c.adapter).tick(); expect(c.tools.calls).toHaveLength(0);
    expect(store.prepare("SELECT count(*) n FROM request_artifacts").get()).toMatchObject({n:0});
    const rows=store.prepare("SELECT state,error_json,turns_reserved FROM requests").all() as {state:string;error_json:string;turns_reserved:number}[];
    expect(rows).toHaveLength(10); expect(rows.every(r=>r.state==="failed"&&JSON.parse(r.error_json).code==="ADAPTER_CAPABILITY_MISSING"&&r.turns_reserved===0)).toBe(true);
    expect(store.prepare("SELECT count(*) n FROM outbox_events WHERE state='done'").get()).toMatchObject({n:0});
  });
  it("coalesces creation overlap and restores the original confirmed mapping after restart",async()=>{
    const c=setup(); let release!:()=>void;c.tools.createBarrier=new Promise(r=>{release=r;});
    const a=c.adapter.createSession({creation_key:"one"}),b=c.adapter.createSession({creation_key:"one"}); release(); expect(await a).toEqual(await b);
    restart(c); expect((await c.adapter.createSession({creation_key:"one"})).host_session_id).toBe("sess_fixture-1");
    expect(c.tools.calls.filter(x=>x.name==="zcode_create_session")).toHaveLength(1); expect(await c.adapter.lookupSessionByCreationKey("absent")).toBeNull();
  });
  it("unknown accepted creation survives restart and cannot be blindly retried or returned absent",async()=>{
    const c=setup();c.tools.createError=true;
    await expect(c.adapter.createSession({creation_key:"unknown"})).rejects.toMatchObject({details:{uncertain:true}});restart(c);
    await expect(c.adapter.createSession({creation_key:"unknown"})).rejects.toMatchObject({details:{uncertain:true}});
    await expect(c.adapter.lookupSessionByCreationKey("unknown")).rejects.toMatchObject({details:{uncertain:true}});expect(c.tools.calls).toHaveLength(1);
  });
  it("stores a complete matching answer, replay spends no turn, and changed input conflicts",async()=>{
    const c=setup(),h=await c.adapter.createSession({creation_key:"one"}); await c.adapter.runTurn(h,{message:"q",execution_key:"turn"});c.tools.statuses.push(trace());
    expect(await c.adapter.getResult(h)).toMatchObject({completed:true,body:"actual fixture answer",execution_key:"turn",turn_count:1});
    restart(c);await c.adapter.runTurn(h,{message:"q",execution_key:"turn"}); expect((await c.adapter.getResult(h)).body).toBe("actual fixture answer");
    await expect(c.adapter.runTurn(h,{message:"changed",execution_key:"turn"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(c.tools.calls.filter(x=>x.name==="zcode_send")).toHaveLength(1);
  });
  it("lost send confirmation preserves intent across restart even if a later answer exists",async()=>{
    const c=setup(),h=await c.adapter.createSession({creation_key:"one"});c.tools.sendError=true;
    await expect(c.adapter.runTurn(h,{message:"q",execution_key:"turn"})).rejects.toMatchObject({details:{uncertain:true}});restart(c);c.tools.sendError=false;c.tools.statuses.push(trace());
    await expect(c.adapter.runTurn(h,{message:"q",execution_key:"turn"})).rejects.toMatchObject({details:{uncertain:true}});
    await expect(c.adapter.getResult(h)).rejects.toMatchObject({details:{uncertain:true}});expect(c.tools.calls.filter(x=>x.name==="zcode_send")).toHaveLength(1);
  });
  it.each(["gap","old","multiple","truncated","wrong-host"])("%s trace cannot masquerade as completed",async variant=>{
    const c=setup(),h=await c.adapter.createSession({creation_key:"one"});await c.adapter.runTurn(h,{message:"q",execution_key:"turn"}); const t=trace();
    if(variant==="gap")t.recentEvents=t.recentEvents.slice(1);
    if(variant==="old"){t.recentEvents=[{seq:9,type:"turn.completed",response:"old"}];t.lastSeq=14;}
    if(variant==="multiple")t.recentEvents[1]={seq:12,type:"turn.started"};
    if(variant==="truncated"){t.lastTurn.response="answer\n… (100 more characters)";t.recentEvents[2]={seq:13,type:"turn.completed",response:t.lastTurn.response};}
    if(variant==="wrong-host")t.sessionId="sess_other";
    c.tools.statuses.push(t);
    if(variant==="old")expect(await c.adapter.getResult(h)).toMatchObject({completed:false});else await expect(c.adapter.getResult(h)).rejects.toMatchObject({details:{uncertain:true}});
  });
  it("budget limits prevent new sends; actual oversize output and host close are never fake successes",async()=>{
    const c=setup(),h=await c.adapter.createSession({creation_key:"one"});
    await expect(c.adapter.runTurn(h,{message:"expired",execution_key:"expired",budget:{deadline:new Date(Date.now()-1000).toISOString()}})).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await c.adapter.runTurn(h,{message:"q",execution_key:"turn",budget:{max_output_bytes:1}});c.tools.statuses.push(trace());
    await expect(c.adapter.getResult(h)).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await expect(c.adapter.closeSession(h)).rejects.toMatchObject({code:"ADAPTER_CAPABILITY_MISSING"});expect(await c.adapter.lookupSessionByCreationKey("one")).toEqual(h);
    await expect(c.adapter.runTurn({...h,host_session_id:"sess_foreign"},{message:"q",execution_key:"x"})).rejects.toMatchObject({code:"NOT_FOUND"});expect(c.tools.calls.filter(x=>x.name==="zcode_send")).toHaveLength(1);
  });
});
describe("ZCode B1 session identity verification (fixtures)",()=>{
  const identity={declaredTools:new Set(["zcode_create_session","zcode_verify_session"])};
  it("refuses verification when the connector does not declare zcode_verify_session",async()=>{
    const c=setup();
    await expect(c.adapter.verifyExternalSession("sess_fixture-1","subject-a")).rejects.toMatchObject({code:"ADAPTER_CAPABILITY_MISSING",details:{capability:"current_session_identity"}});
    expect(c.tools.calls).toHaveLength(0);
  });
  it("verifies authoritatively, binds the subject once and treats a later conflict as definitive false",async()=>{
    const c=setup();c.tools.declaredTools=identity.declaredTools;
    c.tools.verifyAnswers=[{exists:true,workspacePath:c.root},{exists:true,workspacePath:c.root}];
    expect(await c.adapter.verifyExternalSession("sess_fixture-1","subject-a")).toBe(true);
    expect(await c.adapter.verifyExternalSession("sess_fixture-1","subject-a")).toBe(true);
    expect(c.tools.calls.filter(x=>x.name==="zcode_verify_session")).toHaveLength(2);
    expect(await c.adapter.verifyExternalSession("sess_fixture-1","subject-b")).toBe(false);
    expect(c.tools.calls.filter(x=>x.name==="zcode_verify_session")).toHaveLength(2);
  });
  it("absent sessions are definitive false; connector failures and malformed or mismatched answers stay uncertain",async()=>{
    const c=setup();c.tools.declaredTools=identity.declaredTools;
    c.tools.verifyAnswers=[{exists:false}];
    expect(await c.adapter.verifyExternalSession("sess_absent","subject-a")).toBe(false);
    c.tools.verifyAnswers=[new Error("connector exploded"),{exists:true,workspacePath:"/somewhere/else"},{exists:"yes"}];
    await expect(c.adapter.verifyExternalSession("sess_absent2","subject-a")).rejects.toMatchObject({details:{uncertain:true}});
    await expect(c.adapter.verifyExternalSession("sess_fixture-1","subject-a")).rejects.toMatchObject({details:{uncertain:true}});
    await expect(c.adapter.verifyExternalSession("sess_fixture-1","subject-a")).rejects.toMatchObject({details:{uncertain:true}});
  });
  it("keeps the subject binding across restart and never fabricates a negative from a failed connector",async()=>{
    const c=setup();c.tools.declaredTools=identity.declaredTools;
    c.tools.verifyAnswers=[{exists:true,workspacePath:c.root}];
    expect(await c.adapter.verifyExternalSession("sess_fixture-1","subject-a")).toBe(true);
    restart(c);
    expect(await c.adapter.verifyExternalSession("sess_fixture-1","subject-b")).toBe(false);
    expect(c.tools.calls.filter(x=>x.name==="zcode_verify_session")).toHaveLength(1);
  });
  it("registers a real session through the authority once identity is verified (B2 declaration flip)",async()=>{
    const c=setup();c.tools.declaredTools=identity.declaredTools;
    c.tools.verifyAnswers=[{exists:true,workspacePath:c.root}];
    const core=Coordinator.open({root:join(c.root,"core"),adapter:c.adapter}); cores.push(core);
    const external=await new ExternalSessionAuthority(core,c.adapter).register({host_session_id:"sess_fixture-1",connection_subject:"chat",capability_ceiling:["documents.read"]});
    expect(external).toMatchObject({adapter:"zcode",host_session_id:"sess_fixture-1",connection_subject:"chat"});
    expect(c.tools.calls.filter(x=>x.name==="zcode_verify_session")).toHaveLength(1);
  });
});
describe("ZCode B2 trusted-entry human events (fixtures)",()=>{
  const identity={declaredTools:new Set(["zcode_create_session","zcode_verify_session"])};
  it("fails honestly without a wired source and returns record facts through the wired store view",async()=>{
    const c=setup();
    await expect(c.adapter.readHumanAuthorization("sess_fixture-1","confirm-001")).rejects.toMatchObject({code:"NOT_IMPLEMENTED"});
    for (const [host,ref] of [["bad-id","ref"],["sess_fixture-1",""]] as const) await expect(c.adapter.readHumanAuthorization(host,ref)).rejects.toMatchObject({code:"VALIDATION_FAILED"});
    c.adapter.useHumanAuthorizationSource({
      async readEvent(host,ref){ return host==="sess_fixture-1" && ref==="confirm-001" ? { workspace_id:"ws", host_session_id:host, connection_subject:"chat", event_ref:ref, actor_id:"human", role_id:"builder", capabilities:["documents.read"], inherit:"initialize" as const, expires_at:"2099-01-01T00:00:00Z", entry:"cli-console" as const, recorded_at:"2026-10-24T00:00:00Z" } : null; },
    });
    expect(await c.adapter.readHumanAuthorization("sess_fixture-1","confirm-001")).toMatchObject({workspace_id:"ws",role_id:"builder",event_ref:"confirm-001"});
    expect(await c.adapter.readHumanAuthorization("sess_fixture-1","absent")).toBeNull();
  });
  it("completes the core recordHuman chain over the CLI-written store record with a fixture-flipped declaration",async()=>{
    const c=setup();c.tools.declaredTools=identity.declaredTools;
    c.tools.verifyAnswers=[{exists:true,workspacePath:c.root}];
    const core=Coordinator.open({root:join(c.root,"core"),adapter:c.adapter}); cores.push(core);
    const authority=new ExternalSessionAuthority(core,c.adapter);
    await core.installRolePack({source_path:resolve("examples/demo-team")});
    WorkspaceAdmin.forCoordinator(core).grant({role_id:"builder",capability:"documents.read"});
    const external=await authority.register({host_session_id:"sess_fixture-1",connection_subject:"chat",capability_ceiling:["documents.read"]});
    authority.submitHumanEvent({external_session_id:external.external_session_id,host_session_id:"sess_fixture-1",connection_subject:"chat",event_ref:"confirm-001",actor_id:"human-user",role_id:"builder",capabilities:["documents.read"],inherit:"initialize",expires_at:new Date(Date.now()+600000).toISOString(),entry:"cli-console",recorded_at:new Date().toISOString()});
    core.close(); cores.splice(cores.indexOf(core),1);
    c.adapter.closeJournal(); journals.splice(journals.indexOf(c.adapter),1);
    class FixtureChain extends ZCodeAdapter {
      override getCapabilities(){ const caps=super.getCapabilities(); return { ...caps, external:{ ...caps.external!, human_authorization_events:true } }; }
    }
    const chainAdapter=new FixtureChain(c.options); journals.push(chainAdapter);
    const chainCore=Coordinator.open({root:join(c.root,"core"),adapter:chainAdapter}); cores.push(chainCore);
    const auth=await new ExternalSessionAuthority(chainCore,chainAdapter).recordHumanAuthorization({external_session_id:external.external_session_id,event_ref:"confirm-001"});
    expect(auth.source).toMatchObject({kind:"human-event",event_ref:"confirm-001"});
    expect(chainAdapter.getCapabilities().external).toMatchObject({current_session_identity:true,human_authorization_events:true});
    expect(c.tools.calls.filter(x=>x.name==="zcode_create_session")).toHaveLength(0);
  });
});
describe("ZCode B3 anchor material load (fixtures)",()=>{
  const identity=new Set(["zcode_create_session","zcode_verify_session","zcode_load_material","zcode_lookup_load"]);
  class LoadProbe extends ZCodeAdapter {
    override getCapabilities(){ const caps=super.getCapabilities(); return { ...caps, external:{ ...caps.external!, load_materials:true, reconcile_load:true } }; }
  }
  const material={bundle_id:"bundle-b",role_id:"builder",payload:JSON.stringify({protocol_version:"0.1",materials:{}}),content_hash:createHash("sha256").update(JSON.stringify({protocol_version:"0.1",materials:{}})).digest("hex")};
  it("refuses material load when the connector does not declare the load tools",async()=>{
    const c=setup();
    await expect(c.adapter.loadExternalMaterials({host_session_id:"sess_fixture-1",connection_subject:"chat",load_key:"load-b3",bootstrap:material,capability_scope:["documents.read"]})).rejects.toMatchObject({code:"ADAPTER_CAPABILITY_MISSING"});
    await expect(c.adapter.lookupExternalLoad("sess_fixture-1","load-b3")).rejects.toMatchObject({code:"ADAPTER_CAPABILITY_MISSING"});
    expect(c.tools.calls).toHaveLength(0);
  });
  it("rejects a tampered payload before any host call and reports absent without local intent",async()=>{
    const c=setup();c.tools.declaredTools=identity;
    await expect(c.adapter.loadExternalMaterials({host_session_id:"sess_fixture-1",connection_subject:"chat",load_key:"load-b3",bootstrap:{...material,payload:"tampered"},capability_scope:[]})).rejects.toMatchObject({code:"VALIDATION_FAILED"});
    expect(c.tools.calls).toHaveLength(0);
    expect(await c.adapter.lookupExternalLoad("sess_fixture-1","load-b3")).toEqual({state:"absent"});
  });
  it("drives the full core anchor chain through a fixture load confirmation to CAS activation",async()=>{
    const c=setup();c.tools.declaredTools=identity;
    c.tools.verifyAnswers=[{exists:true,workspacePath:c.root}];
    c.tools.statuses.push({sessionId:"sess_fixture-1",status:"idle",lastSeq:101,recentEvents:[{seq:101,type:"turn.completed"}]});
    c.adapter.closeJournal(); journals.splice(journals.indexOf(c.adapter),1);
    const adapter=new LoadProbe({tools:c.tools,workspacePath:c.root,stateDir:join(c.root,"journal")}); journals.push(adapter);
    const core=Coordinator.open({root:join(c.root,"core"),adapter}); cores.push(core);
    const authority=new ExternalSessionAuthority(core,adapter);
    await core.installRolePack({source_path:resolve("examples/demo-team")});
    WorkspaceAdmin.forCoordinator(core).grant({role_id:"builder",capability:"documents.read"});
    const external=await authority.register({host_session_id:"sess_fixture-1",connection_subject:"chat",capability_ceiling:["documents.read"]});
    authority.submitHumanEvent({external_session_id:external.external_session_id,host_session_id:"sess_fixture-1",connection_subject:"chat",event_ref:"confirm-b3",actor_id:"human-user",role_id:"builder",capabilities:["documents.read"],inherit:"initialize",expires_at:new Date(Date.now()+600000).toISOString(),entry:"cli-console",recorded_at:"2026-10-24T00:00:00Z"});
    const auth=await authority.recordHumanAuthorization({external_session_id:external.external_session_id,event_ref:"confirm-b3"});
    const connection=authority.connect(external.external_session_id,"chat");
    const result=await connection.call("sessions.anchor",{authorization_id:auth.authorization_id,idempotency_key:"anchor-b3"}) as {attempt:{state:string;confirmation:{load_version:number;load_key:string}|null};binding:{state:string;generation:number}|null};
    expect(result.attempt.state).toBe("active");
    expect(result.attempt.confirmation).toMatchObject({host_session_id:"sess_fixture-1",load_version:1});
    expect(result.binding).toMatchObject({state:"active",generation:1});
    const head=coordinatorStore(core).prepare("SELECT generation,current_instance_id FROM role_heads WHERE role_id='builder'").get() as {generation:number};
    expect(head.generation).toBe(1);
    const stored=await adapter.lookupExternalLoad("sess_fixture-1",result.attempt.confirmation!.load_key);
    expect(stored).toMatchObject({state:"loaded"});
    expect(c.tools.calls.filter(x=>x.name==="zcode_load_material")).toHaveLength(1);
    expect(c.tools.calls.filter(x=>x.name==="zcode_lookup_load").length).toBeGreaterThanOrEqual(1);
  });
  it("an unconfirmed load surfaces as uncertain, never as a fake confirmation",async()=>{
    const c=setup();c.tools.declaredTools=identity;
    c.tools.statuses.push({sessionId:"sess_fixture-1",status:"idle",lastSeq:101,recentEvents:[{seq:101,type:"turn.completed"}]});
    c.tools.loadState="unknown";
    c.adapter.closeJournal(); journals.splice(journals.indexOf(c.adapter),1);
    const adapter=new LoadProbe({tools:c.tools,workspacePath:c.root,stateDir:join(c.root,"journal")}); journals.push(adapter);
    await expect(adapter.loadExternalMaterials({host_session_id:"sess_fixture-1",connection_subject:"chat",load_key:"load-b3",bootstrap:material,capability_scope:[]})).rejects.toMatchObject({details:{uncertain:true}});
    expect(await adapter.lookupExternalLoad("sess_fixture-1","load-b3")).toEqual({state:"unknown"});
  });
});
describe("ZCode B4 resource control and inheritance (fixtures)",()=>{
  const identity=new Set(["zcode_create_session","zcode_verify_session","zcode_load_material","zcode_lookup_load","zcode_cancel","zcode_close"]);
  class LoadProbe extends ZCodeAdapter {
    override getCapabilities(){ const caps=super.getCapabilities(); return { ...caps, external:{ ...caps.external!, load_materials:true, reconcile_load:true } }; }
  }
  it("closes a session authoritatively and refuses later operations on the closed handle",async()=>{
    const c=setup();c.tools.declaredTools=identity;
    const h=await c.adapter.createSession({creation_key:"one"});
    c.tools.closeAnswer=false;
    await expect(c.adapter.closeSession(h)).rejects.toMatchObject({details:{uncertain:true}});
    c.tools.closeAnswer=true;
    await c.adapter.closeSession(h);
    await expect(c.adapter.runTurn(h,{message:"q",execution_key:"x"})).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await expect(c.adapter.getResult(h)).resolves.toMatchObject({state:"closed",completed:false});
    await c.adapter.closeSession(h);
    expect(await c.adapter.lookupSessionByCreationKey("one")).toBeNull();
  });
  it("cancel is an honest stop signal and connector errors stay uncertain",async()=>{
    const c=setup();c.tools.declaredTools=identity;
    const h=await c.adapter.createSession({creation_key:"one"});
    await c.adapter.cancel(h);
    c.tools.closeAnswer=new Error("lost close confirmation");
    await expect(c.adapter.closeSession(h)).rejects.toMatchObject({details:{uncertain:true}});
  });
  it("hands off to a new material-loaded host session: generation 2, old primary superseded",async()=>{
    const c=setup();c.tools.declaredTools=identity;
    c.tools.verifyAnswers=[{exists:true,workspacePath:c.root}];
    c.tools.statuses.push({sessionId:"sess_fixture-1",status:"idle",lastSeq:101,recentEvents:[{seq:101,type:"turn.completed"}]});
    c.tools.statuses.push({sessionId:"sess_fixture-1",status:"idle",lastSeq:201,recentEvents:[{seq:201,type:"turn.completed"}]});
    c.adapter.closeJournal(); journals.splice(journals.indexOf(c.adapter),1);
    const adapter=new LoadProbe({tools:c.tools,workspacePath:c.root,stateDir:join(c.root,"journal")}); journals.push(adapter);
    const core=Coordinator.open({root:join(c.root,"core"),adapter}); cores.push(core);
    const authority=new ExternalSessionAuthority(core,adapter);
    await core.installRolePack({source_path:resolve("examples/demo-team")});
    WorkspaceAdmin.forCoordinator(core).grant({role_id:"builder",capability:"documents.read"});
    const external=await authority.register({host_session_id:"sess_fixture-1",connection_subject:"chat",capability_ceiling:["documents.read"]});
    authority.submitHumanEvent({external_session_id:external.external_session_id,host_session_id:"sess_fixture-1",connection_subject:"chat",event_ref:"confirm-b4",actor_id:"human-user",role_id:"builder",capabilities:["documents.read"],inherit:"initialize",expires_at:new Date(Date.now()+600000).toISOString(),entry:"cli-console",recorded_at:"2026-10-24T00:00:00Z"});
    const auth=await authority.recordHumanAuthorization({external_session_id:external.external_session_id,event_ref:"confirm-b4"});
    const first=authority.connect(external.external_session_id,"chat");
    const anchor=await first.call("sessions.anchor",{authorization_id:auth.authorization_id,idempotency_key:"anchor-b4"}) as {attempt:{state:string};binding:{generation:number;instance_id:string}|null};
    expect(anchor.attempt.state).toBe("active");
    const successor=await core.openSession({role_id:"builder",inherit:"latest",creation_key:"handoff-b4"});
    expect(successor.generation).toBe(2); expect(successor.predecessor_instance_id).toBe(anchor.binding!.instance_id);
    expect(successor.handoff.performed).toBe(true);
    expect(c.tools.calls.filter(x=>x.name==="zcode_load_material")).toHaveLength(2);
    // Spec semantics: succession supersedes the predecessor; the binding VIEW
    // (lazily recomputed on read) shows superseded for the old chat.
    const oldView = await first.call("sessions.binding") as { binding: { state: string } | null };
    expect(oldView.binding?.state).toBe("superseded");
    const oldInstance=coordinatorStore(core).prepare("SELECT state FROM agent_instances WHERE id=?").get(anchor.binding!.instance_id) as {state:string};
    expect(oldInstance.state).toBe("superseded");
  }, 60000);
});
describe("ZCode B5-3 managed request chain (fixtures)",()=>{
  const EGRESS=["api.z.ai:443","open.bigmodel.cn:443"];
  const declared=new Set(["zcode_create_session","zcode_sandbox_status","zcode_load_material","zcode_lookup_load","zcode_send","zcode_status","zcode_cancel","zcode_close"]);
  class ManagedFixture extends Fixture {
    sandboxed=true; egress=[...EGRESS]; nextId=0;
    readonly turnSent=new Set<string>();
    constructor(){ super(); this.declaredTools=declared; }
    override async call(name:string,input:Record<string,unknown>):Promise<unknown>{
      this.calls.push({name,input});
      if(name==="zcode_sandbox_status") return this.sandboxed?{sandboxed:true,runner:"bubblewrap",egress_entries:[...this.egress],workspace_root:"/ws"}:{sandboxed:false,runner:null,egress_entries:[],workspace_root:"/ws"};
      if(name==="zcode_create_session"){ this.nextId+=1; return {sessionId:`sess_fixture-${this.nextId}`}; }
      if(name==="zcode_status"){
        const sessionId=String(input.sessionId);
        if(input.afterSeq===100) return {sessionId,status:"idle",lastSeq:101,recentEvents:[{seq:101,type:"turn.completed"}]};
        if(!this.turnSent.has(sessionId)) return {sessionId,status:"idle",lastSeq:200,pendingRequests:[],recentEvents:[]};
        return {sessionId,status:"idle",lastSeq:204,pendingRequests:[],lastTurn:{type:"turn.completed",response:"REQUEST-OK"},recentEvents:[{seq:201,type:"turn.started"},{seq:202,type:"model.streaming"},{seq:203,type:"turn.completed",response:"REQUEST-OK"},{seq:204,type:"session.titleUpdated"}]};
      }
      if(name==="zcode_send"){ this.turnSent.add(String(input.sessionId)); return {sessionId:input.sessionId,accepted:true}; }
      if(name==="zcode_load_material") return {sessionId:input.sessionId,loadKey:input.loadKey,accepted:true,marker:100};
      return super.call(name,input);
    }
  }
  function managedSetup(){
    const tools=new ManagedFixture();
    const root=mkdtempSync(join(tmpdir(),"rd-zcode-managed-")); roots.push(root);
    const adapter=new ZCodeAdapter({tools,workspacePath:root,stateDir:join(root,"journal"),managed:{egress:EGRESS}}); journals.push(adapter);
    return {root,tools,adapter};
  }
  it("declares full isolation only in managed mode and keeps external declarations",()=>{
    const c=managedSetup();
    expect(c.adapter.getCapabilities()).toMatchObject({level:"full",isolation:{context:true,temp_writes:true,results:true,capability_scope:true},optional:{cancel:true,lookup_session_by_creation_key:true}});
  });
  it("verifies the sandbox once, accepts scope/temp_dir, records them, and never re-verifies",async()=>{
    const c=managedSetup();
    const tempDir=join(c.root,".roledock","requests","req-1","tmp");
    const h=await c.adapter.createSession({creation_key:"request-req-1",capability_scope:["documents.read"],temp_dir:tempDir});
    expect(h.host_session_id).toBe("sess_fixture-1");
    expect(c.tools.calls.filter(x=>x.name==="zcode_sandbox_status")).toHaveLength(1);
    expect(c.tools.calls.filter(x=>x.name==="zcode_create_session")).toHaveLength(1);
    expect(existsSync(tempDir)).toBe(true);
    const second=await c.adapter.createSession({creation_key:"request-req-2",capability_scope:["documents.read"],temp_dir:join(c.root,".roledock","requests","req-2","tmp")});
    expect(second.host_session_id).toBe("sess_fixture-2");
    expect(c.tools.calls.filter(x=>x.name==="zcode_sandbox_status")).toHaveLength(1);
  });
  it("refuses managed sessions when the connector is not sandboxed, before any host action",async()=>{
    const c=managedSetup(); c.tools.sandboxed=false;
    await expect(c.adapter.createSession({creation_key:"request-x",capability_scope:["documents.read"],temp_dir:join(c.root,"tmp")})).rejects.toMatchObject({code:"NOT_IMPLEMENTED"});
    expect(c.tools.calls.map(x=>x.name)).toEqual(["zcode_sandbox_status"]);
  });
  it("refuses managed sessions on an egress whitelist mismatch (fail-closed)",async()=>{
    const c=managedSetup(); c.tools.egress=["evil.test:443"];
    await expect(c.adapter.createSession({creation_key:"request-x",capability_scope:[],temp_dir:join(c.root,"tmp")})).rejects.toMatchObject({code:"NOT_IMPLEMENTED"});
    expect(c.tools.calls.map(x=>x.name)).toEqual(["zcode_sandbox_status"]);
  });
  it("refuses managed sessions when the connector cannot prove sandbox status",async()=>{
    const tools=new ManagedFixture(); tools.declaredTools=new Set([...declared].filter(name=>name!=="zcode_sandbox_status"));
    const root=mkdtempSync(join(tmpdir(),"rd-zcode-managed-")); roots.push(root);
    const adapter=new ZCodeAdapter({tools,workspacePath:root,stateDir:join(root,"journal"),managed:{egress:EGRESS}}); journals.push(adapter);
    await expect(adapter.createSession({creation_key:"request-x",capability_scope:[],temp_dir:join(root,"tmp")})).rejects.toMatchObject({code:"ADAPTER_CAPABILITY_MISSING"});
    expect(tools.calls).toHaveLength(0);
  });
  it("executes ten sequential RoleDock requests end-to-end through the executor gate",async()=>{
    const c=managedSetup(),core=Coordinator.open({root:join(c.root,"core"),adapter:c.adapter}); cores.push(core);
    await core.installRolePack({source_path:resolve("examples/demo-team")});
    const admin=WorkspaceAdmin.forCoordinator(core);
    admin.grant({role_id:"builder",capability:"requests.create"});
    for(const cap of ["requests.execute","documents.read","documents.propose"]) admin.grant({role_id:"reviewer",capability:cap});
    const primary=testingOpenPrimarySession(core,{role_id:"builder"}); testingOpenPrimarySession(core,{role_id:"reviewer"});
    const requests=[]; for(let i=0;i<10;i++) requests.push(await core.createRequest({session_id:primary.session_id,target_role_id:"reviewer",question:`job ${i}`,idempotency_key:`bulk-${i}`,read_exception_rationale:"B5-3 fixture chain"}));
    const store=coordinatorStore(core);
    for(const request of requests) expect((await executeRequest(store,c.adapter,request.request_id)).state).toBe("completed");
    expect(store.prepare("SELECT count(*) n FROM request_artifacts").get()).toMatchObject({n:10});
    expect(store.prepare("SELECT count(*) n FROM request_inbox").get()).toMatchObject({n:10});
    const rows=store.prepare("SELECT host_session_ref,instance_id FROM sessions WHERE kind='request'").all() as {host_session_ref:string;instance_id:string|null}[];
    expect(rows).toHaveLength(10);
    expect(rows.every(r=>r.instance_id===null)).toBe(true);
    expect(new Set(rows.map(r=>r.host_session_ref)).size).toBe(10);
    const firstRequest = requests[0]!;
    expect(c.adapter.requestScope(`request-${firstRequest.request_id}`)).toMatchObject({capability_scope:["documents.read","documents.propose"]});
    expect(c.adapter.requestScope("request-absent")).toBeNull();
    expect(c.tools.calls.filter(x=>x.name==="zcode_sandbox_status")).toHaveLength(1);
  }, 180000);
});
