import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator } from "../../packages/core/src/index.js";
import { coordinatorStore } from "../../packages/core/src/internal-store.js";
import { executeRequest, readObject } from "../../packages/core/src/testing.js";
import { ProcessBridgeAdapter } from "@roledock/adapter-process-bridge";
import { writePack } from "../helpers/packs.js";
import { grantFixtureCapabilities } from "../helpers/policy.js";

const roots: string[] = [];
const helper = fileURLToPath(new URL("./helpers/crash-runtime.mjs", import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rd-crash-runtime-")); roots.push(root);
  const adapter = new ProcessBridgeAdapter({ stateDir: join(root, ".roledock", "crash-host") });
  const c = Coordinator.open({ root, adapter });
  const source = writePack({ dir: join(root, "pack"), roles: [{ id: "alpha" }, { id: "beta" }] });
  await c.installRolePack({ source_path: source });
  grantFixtureCapabilities(coordinatorStore(c));
  const alpha = await c.openSession({ role_id: "alpha", creation_key: "first-alpha" });
  const beta = await c.openSession({ role_id: "beta", creation_key: "first-beta" });
  await c.publishDocument({ session_id: alpha.session_id, document_key: "notes", body: "CRASH-RECOVERY-KNOWLEDGE", expected_revision: 0, expected_generation: 1 });
  return { c, root, adapter, alpha, beta };
}
function crash(root: string, boundary: string, id?: string) {
  const child = spawnSync(process.execPath, [helper, root, boundary, ...(id ? [id] : [])], { encoding: "utf8", timeout: 20000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(({ "before-create": 71, "after-create": 72, "before-turn": 73, "after-turn": 74 } as Record<string, number>)[boundary]);
}
function registries(root: string) {
  const dir = join(root, ".roledock", "crash-host", "sessions");
  return readdirSync(dir).map((entry) => ({ dir: join(dir, entry), registry: JSON.parse(readFileSync(join(dir, entry, "session.json"), "utf8")) }));
}
describe("durable runtime recovery after real coordinator process exits", () => {
  it.each(["before-create", "after-create"])("restores immutable handoff payload %s without another host or generation", async (boundary) => {
    const f = await setup(); f.c.close();
    crash(f.root, boundary);
    const c = Coordinator.open({ root: f.root, adapter: f.adapter });
    try {
      expect((await c.resolveRole({ role_id: "alpha" })).generation).toBe(1);
      const opened = await c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "crash-successor" });
      expect(opened.generation).toBe(2);
      expect((await c.openSession({ role_id: "alpha", inherit: "latest", creation_key: "crash-successor" })).session_id).toBe(opened.session_id);
      const store = coordinatorStore(c);
      const row = store.prepare("SELECT host_session_ref FROM sessions WHERE id = ?").get(opened.session_id) as { host_session_ref: string };
      const bundle = store.prepare("SELECT payload_hash FROM bootstrap_bundles WHERE bundle_id = ?").get(opened.handoff.bundle_id!) as { payload_hash: string };
      expect(readObject(store, bundle.payload_hash)).toContain("CRASH-RECOVERY-KNOWLEDGE");
      const hosts = registries(f.root);
      expect(hosts).toHaveLength(3);
      const receiver = hosts.find((entry) => entry.registry.host_session_id === row.host_session_ref)!;
      expect(readFileSync(join(receiver.dir, "bootstrap.json"), "utf8")).toContain("CRASH-RECOVERY-KNOWLEDGE");
      expect(existsSync(join(receiver.dir, "transcript.jsonl"))).toBe(false);
    } finally { c.close(); }
  }, 60000);
  it.each(["before-turn", "after-turn"])("reconciles reserved request %s without replaying a side-effecting turn", async (boundary) => {
    const f = await setup();
    const request = await f.c.createRequest({ session_id: f.beta.session_id, target_role_id: "alpha", question: "CRASH-QUESTION", idempotency_key: "crash-request", read_exception_rationale: "test boundary", budget: { max_turns: 1 } });
    f.c.close(); crash(f.root, boundary, request.request_id);
    const c = Coordinator.open({ root: f.root, adapter: f.adapter });
    try {
      const store = coordinatorStore(c);
      expect((await c.getRequest({ session_id: f.beta.session_id, request_id: request.request_id })).execution_uncertain).toBe(true);
      const result = await executeRequest(store, f.adapter, request.request_id);
      const row = store.prepare("SELECT turns_reserved, result_content_hash FROM requests WHERE request_id = ?").get(request.request_id) as { turns_reserved: number; result_content_hash: string | null };
      expect(row.turns_reserved).toBe(1);
      const receiver = registries(f.root).filter((entry) => entry.registry.creation_key === `request-${request.request_id}`);
      expect(receiver).toHaveLength(1);
      const transcriptPath = join(receiver[0]!.dir, "transcript.jsonl");
      const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean) : [];
      expect(transcript).toHaveLength(boundary === "after-turn" ? 1 : 0);
      if (boundary === "after-turn") {
        expect(result.state).toBe("completed");
        expect(readObject(store, row.result_content_hash!)).toContain("CRASH-QUESTION");
        expect((await executeRequest(store, f.adapter, request.request_id)).artifact_id).toBe(result.artifact_id);
      } else {
        expect(result.state).toBe("running");
        expect((await c.getRequest({ session_id: f.beta.session_id, request_id: request.request_id })).execution_uncertain).toBe(true);
        await c.cancelRequest({ session_id: f.beta.session_id, request_id: request.request_id });
        expect((await c.getRequest({ session_id: f.beta.session_id, request_id: request.request_id })).state).toBe("cancelled");
      }
    } finally { c.close(); }
  }, 60000);
});
