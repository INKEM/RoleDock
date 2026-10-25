import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import { defineAdapterContractSuite } from "../../../tests/conformance/adapter-suite.js";
import { ZCodeAdapter } from "../src/index.js";
import type { ZCodeToolCaller } from "../src/index.js";

// B5-4: the MANAGED zcode variant enters the shared adapter contract suite
// (ADAPTER_SANDBOX_PLAN §3 B5-4; docs/spec/adapter-contract.md B5 §rule 4).
// The suite proves protocol conformance against a controlled connector
// fixture — it is NOT real-harness evidence; the real-harness chain evidence
// lives in docs/phase-reports/evidence/2026-10-25-p5-h-b5-*.
class ContractFixture implements ZCodeToolCaller {
  readonly declaredTools = new Set(["zcode_create_session", "zcode_sandbox_status", "zcode_load_material", "zcode_lookup_load", "zcode_send", "zcode_status", "zcode_cancel", "zcode_close"]);
  nextId = 0;
  /** Completed-turn count per session; each turn owns a disjoint seq window. */
  readonly turnCounts = new Map<string, number>();
  get tools(): ReadonlySet<string> { return this.declaredTools; }
  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name === "zcode_sandbox_status") return { sandboxed: true, runner: "bubblewrap", egress_entries: ["api.z.ai:443", "open.bigmodel.cn:443"], workspace_root: "/ws" };
    if (name === "zcode_create_session") { this.nextId += 1; return { sessionId: `sess_contract-${this.nextId}` }; }
    if (name === "zcode_status") {
      const sessionId = String(input.sessionId);
      // afterSeq 100 = anchor load turn probe.
      if (input.afterSeq === 100) return { sessionId, status: "idle", lastSeq: 101, recentEvents: [{ seq: 101, type: "turn.completed" }] };
      const turns = this.turnCounts.get(sessionId) ?? 0;
      if (turns === 0) return { sessionId, status: "idle", lastSeq: 200, pendingRequests: [], recentEvents: [] };
      // Turn n owns the disjoint window [base+1, base+4]; the adapter's afterSeq filtering keeps only this turn's events.
      const base = 200 + turns * 100;
      const response = `contract answer ${turns}`;
      return { sessionId, status: "idle", lastSeq: base + 4, pendingRequests: [], lastTurn: { type: "turn.completed", response }, recentEvents: [
        { seq: base + 1, type: "turn.started" }, { seq: base + 2, type: "model.streaming" }, { seq: base + 3, type: "turn.completed", response }, { seq: base + 4, type: "session.titleUpdated" },
      ] };
    }
    if (name === "zcode_send") { const sessionId = String(input.sessionId); this.turnCounts.set(sessionId, (this.turnCounts.get(sessionId) ?? 0) + 1); return { sessionId: input.sessionId, accepted: true }; }
    if (name === "zcode_load_material") return { sessionId: input.sessionId, loadKey: input.loadKey, accepted: true, marker: 100 };
    if (name === "zcode_lookup_load") return { state: "loaded", confirmation: { host_session_id: input.sessionId, load_key: input.loadKey, content_hash: input.contentHash, load_version: 1 } };
    if (name === "zcode_cancel") return { sessionId: input.sessionId, stop_signal_sent: true };
    if (name === "zcode_close") return { sessionId: input.sessionId, closed: true };
    throw new Error(`Unexpected contract operation: ${name}`);
  }
}

const EGRESS = ["api.z.ai:443", "open.bigmodel.cn:443"];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function makeAdapter(managed: boolean): ZCodeAdapter {
  const root = mkdtempSync(join(tmpdir(), "rd-zcode-contract-suite-"));
  roots.push(root);
  const adapter = new ZCodeAdapter({ tools: new ContractFixture(), workspacePath: root, stateDir: join(root, "journal"), ...(managed ? { managed: { egress: EGRESS } } : {}) });
  const originalClose = adapter.closeJournal.bind(adapter);
  adapter.closeJournal = () => { originalClose(); rmSync(root, { recursive: true, force: true }); };
  return adapter;
}

describe("adapter contract: zcode managed variant (sandboxed)", () => {
  defineAdapterContractSuite({
    name: "zcode-managed",
    adapterName: "zcode",
    make: () => makeAdapter(true),
    makeRestricted: () => makeAdapter(false),
  });
});
