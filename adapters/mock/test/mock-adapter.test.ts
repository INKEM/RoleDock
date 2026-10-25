import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockHarnessAdapter } from "../src/index.js";
import { isRoleDockError } from "@roledock/protocol";

function bootstrap(overrides: Partial<{ bundle_id: string; payload: string }> = {}) {
  const payload = overrides.payload ?? "bundle payload";
  return {
    bundle_id: overrides.bundle_id ?? "bundle-x",
    role_id: "keeper",
    content_hash: createHash("sha256").update(payload, "utf8").digest("hex"),
    payload,
  };
}

describe("MockHarnessAdapter", () => {
  it("cannot reuse a stale handle after a new adapter reuses a numeric host id", async () => {
    const old = new MockHarnessAdapter();
    const stale = await old.createSession({ creation_key: "old-primary" });
    const fresh = new MockHarnessAdapter();
    const current = await fresh.createSession({ creation_key: "new-primary" });
    expect(current.host_session_id).toBe(stale.host_session_id);
    for (const action of [
      () => fresh.nativeResume(stale), () => fresh.runTurn(stale, { message: "must not enter new history" }),
      () => fresh.getResult(stale), () => fresh.cancel(stale), () => fresh.closeSession(stale),
    ]) await expect(action()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fresh.peek(current.host_session_id)).toMatchObject({ transcript: [], closed: false });
    await fresh.runTurn(current, { message: "normal current host turn" });
    expect((await fresh.getResult(current)).turn_count).toBe(1);
  });
  it("declares full capabilities by default", () => {
    const adapter = new MockHarnessAdapter();
    const capabilities = adapter.getCapabilities();
    expect(capabilities).toMatchObject({
      adapter: "mock",
      level: "full",
      optional: {
        cancel: true,
        lookup_session_by_creation_key: true,
        native_resume: true,
        native_fork: true,
      },
    });
  });

  it("reports restricted level when an isolation scope is missing", () => {
    const adapter = new MockHarnessAdapter({ isolation: { context: false } });
    const capabilities = adapter.getCapabilities();
    expect(capabilities.level).toBe("restricted");
    expect(capabilities.isolation.context).toBe(false);
  });

  it("creates sessions, records turns, reports results and closes", async () => {
    const adapter = new MockHarnessAdapter();
    const handle = await adapter.createSession({ creation_key: "k1", bootstrap: bootstrap() });
    await adapter.runTurn(handle, { message: "hello" });
    const result = await adapter.getResult(handle);
    expect(result).toMatchObject({ host_session_id: handle.host_session_id, state: "idle",
      completed: true, turn_count: 1 });
    await adapter.closeSession(handle);
    expect((await adapter.getResult(handle)).state).toBe("closed");
    await expect(adapter.runTurn(handle, { message: "x" })).rejects.toSatisfy((error: unknown) => {
      return isRoleDockError(error) && error.code === "INVALID_STATE_TRANSITION";
    });
  });

  it("verifies the bootstrap bundle hash before confirming a load", async () => {
    const adapter = new MockHarnessAdapter();
    const bad = bootstrap({ payload: "real payload" });
    bad.content_hash = "0".repeat(64);
    await expect(adapter.createSession({ creation_key: "k2", bootstrap: bad })).rejects.toSatisfy(
      (error: unknown) => isRoleDockError(error) && error.code === "VALIDATION_FAILED",
    );
    const good = await adapter.createSession({ creation_key: "k3", bootstrap: bootstrap() });
    expect(adapter.peek(good.host_session_id).bootstrap?.bundle_id).toBe("bundle-x");
  });

  it("supports the uncertain-create failure mode with creation-key recovery", async () => {
    const adapter = new MockHarnessAdapter({ uncertainCreateTimes: 1 });
    await expect(adapter.createSession({ creation_key: "k4" })).rejects.toSatisfy((error: unknown) => {
      return (
        isRoleDockError(error) &&
        (error.details as { uncertain?: unknown } | undefined)?.uncertain === true
      );
    });
    const recovered = await adapter.lookupSessionByCreationKey!("k4");
    expect(recovered).not.toBeNull();
    expect(adapter.peek(recovered!.host_session_id).transcript).toEqual([]);
    // After the configured uncertainty window, creation succeeds cleanly.
    const handle = await adapter.createSession({ creation_key: "k4b" });
    expect(handle.host_session_id).toBeTruthy();
  });

  it("supports a hard create failure with no host-side effect", async () => {
    const adapter = new MockHarnessAdapter({ failCreate: true });
    await expect(adapter.createSession({ creation_key: "k5" })).rejects.toSatisfy((error: unknown) => {
      return isRoleDockError(error) && error.code === "INTERNAL";
    });
    expect(await adapter.lookupSessionByCreationKey!("k5")).toBeNull();
  });

  it("rejects native forks that carry full private history across roles", async () => {
    const adapter = new MockHarnessAdapter();
    const handle = await adapter.createSession({ creation_key: "k6" });
    await adapter.runTurn(handle, { message: "private thought" });
    await expect(
      adapter.nativeFork!(handle, { share_scope: "full-private-history", target_role_id: "other" }),
    ).rejects.toSatisfy((error: unknown) => isRoleDockError(error) && error.code === "PERMISSION_DENIED");
    // Bundle-shareable forks are allowed and carry no transcript.
    const forked = await adapter.nativeFork!(handle, { share_scope: "bundle-shareable" });
    expect(adapter.peek(forked.host_session_id).transcript).toEqual([]);
  });

  it("records that the core never drove a native fork (invocation counter)", async () => {
    const adapter = new MockHarnessAdapter();
    expect(adapter.nativeForkInvocationCount()).toBe(0);
    const handle = await adapter.createSession({ creation_key: "k7" });
    await adapter.nativeFork!(handle, { share_scope: "bundle-shareable" });
    expect(adapter.nativeForkInvocationCount()).toBe(1);
  });
});
