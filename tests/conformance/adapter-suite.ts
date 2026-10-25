import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { isRoleDockError } from "@roledock/protocol";
import type { AdapterSessionHandle, HarnessAdapter } from "@roledock/core";

/**
 * Shared adapter contract suite (docs/spec/adapter-contract.md §4).
 *
 * The same applicable contract runs against every HarnessAdapter
 * implementation — currently the in-memory mock and the real process
 * bridge — so both prove identical observable behavior. Adapter-specific
 * mechanics (fault injection, real process spawn) live in each adapter's
 * own test files; passes here are protocol-conformance evidence, not
 * real-harness evidence.
 */
export interface AdapterSuiteFactory {
  /** Human-readable implementation name, e.g. "mock", "process-bridge". */
  name: string;
  /** A fresh adapter with default (full) capabilities. */
  make(): HarnessAdapter;
  /** The same adapter kind with at least one isolation scope missing. */
  makeRestricted(): HarnessAdapter;
  /** Adapter identifier the capabilities must report. */
  adapterName: string;
}

function bootstrapPayload(body: string) {
  return {
    bundle_id: "contract-bundle",
    role_id: "keeper",
    content_hash: createHash("sha256").update(body, "utf8").digest("hex"),
    payload: body,
  };
}

export function defineAdapterContractSuite(factory: AdapterSuiteFactory): void {
  const { name, make, makeRestricted, adapterName } = factory;

  let adapter: HarnessAdapter;
  let handle: AdapterSessionHandle;

  it(`[${name}] declares complete, well-formed capabilities`, () => {
    adapter = make();
    const capabilities = adapter.getCapabilities();
    expect(capabilities.adapter).toBe(adapterName);
    expect(["full", "restricted"]).toContain(capabilities.level);
    for (const scope of ["context", "temp_writes", "results", "capability_scope"] as const) {
      expect(capabilities.isolation).toHaveProperty(scope);
    }
    for (const optional of [
      "cancel",
      "lookup_session_by_creation_key",
      "native_resume",
      "native_fork",
    ] as const) {
      expect(capabilities.optional).toHaveProperty(optional);
    }
  });

  it(`[${name}] degrades to a restricted level when an isolation scope is missing`, () => {
    const restricted = makeRestricted();
    const capabilities = restricted.getCapabilities();
    expect(capabilities.level).toBe("restricted");
    expect(Object.values(capabilities.isolation).some((scope) => scope === false)).toBe(true);
  });

  it(`[${name}] creates a session with a bootstrap and confirms it host-side`, async () => {
    handle = await adapter.createSession({
      creation_key: `contract-${name}-1`,
      bootstrap: bootstrapPayload("the shared state"),
    });
    expect(handle.creation_key).toBe(`contract-${name}-1`);
    expect(handle.host_session_id.length).toBeGreaterThan(0);
  });

  it(`[${name}] is idempotent on the same creation key`, async () => {
    const again = await adapter.createSession({ creation_key: handle.creation_key });
    expect(again.host_session_id).toBe(handle.host_session_id);
  });

  it(`[${name}] rejects a tampered bootstrap bundle host-side`, async () => {
    await expect(
      adapter.createSession({
        creation_key: `contract-${name}-tampered`,
        bootstrap: { ...bootstrapPayload("original"), content_hash: "0".repeat(64) },
      }),
    ).rejects.toSatisfy((error: unknown) => isRoleDockError(error) && error.code === "VALIDATION_FAILED");
  });

  it(`[${name}] accepts a session without a bootstrap (optional at the port)`, async () => {
    const bare = await adapter.createSession({ creation_key: `contract-${name}-bare` });
    expect(bare.host_session_id.length).toBeGreaterThan(0);
    await adapter.closeSession(bare);
  });

  it(`[${name}] runs turns and reports them via getResult`, async () => {
    const turned = await adapter.runTurn(handle, { message: "first question" });
    expect(turned.accepted).toBe(true);
    await adapter.runTurn(handle, { message: "second question" });
    const result = await adapter.getResult(handle);
    expect(result.host_session_id).toBe(handle.host_session_id);
    expect(result.state).toBe("idle");
    expect(result.completed).toBe(true);
    expect(result.body?.length).toBeGreaterThan(0);
    expect(result.turn_count).toBe(2);
    expect(typeof result.output_bytes).toBe("number");
  });

  it(`[${name}] finds sessions by creation key and misses unknown keys`, async () => {
    const found = await adapter.lookupSessionByCreationKey!(handle.creation_key);
    expect(found?.host_session_id).toBe(handle.host_session_id);
    expect(await adapter.lookupSessionByCreationKey!("no-such-key")).toBeNull();
  });

  it(`[${name}] cancel prevents further spending and keyed turns do not replay`, async () => {
    const cancelling = make();
    const branch = await cancelling.createSession({ creation_key: `cancel-${name}` });
    await cancelling.runTurn(branch, { message: "one", execution_key: "turn-1" });
    await cancelling.runTurn(branch, { message: "one", execution_key: "turn-1" });
    expect((await cancelling.getResult(branch)).turn_count).toBe(1);
    await cancelling.cancel!(branch);
    await expect(cancelling.runTurn(branch, { message: "after cancel", execution_key: "turn-2" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect((await cancelling.getResult(branch)).turn_count).toBe(1);
    await cancelling.closeSession(branch);
  });

  it(`[${name}] closes sessions: state flips and further turns are rejected`, async () => {
    await adapter.closeSession(handle);
    const result = await adapter.getResult(handle);
    expect(result.state).toBe("closed");
    await expect(adapter.runTurn(handle, { message: "after close" })).rejects.toSatisfy(
      (error: unknown) => isRoleDockError(error) && error.code === "INVALID_STATE_TRANSITION",
    );
  });
}

