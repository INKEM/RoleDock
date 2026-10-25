import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isRoleDockError } from "@roledock/protocol";
import { ProcessBridgeAdapter } from "../src/index.js";

const HOST_PROGRAM = fileURLToPath(new URL("../host/fixture-host.mjs", import.meta.url));
const PAYLOAD = "handoff bundle for bridge tests";
const BOOTSTRAP = {
  bundle_id: "b-1",
  role_id: "keeper",
  content_hash: createHash("sha256").update(PAYLOAD, "utf8").digest("hex"),
  payload: PAYLOAD,
};

const TEMP_DIRS: string[] = [];
function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "roledock-pb-bridge-"));
  TEMP_DIRS.push(dir);
  return dir;
}
afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** The single session directory of a one-session state dir. */
function onlySessionDir(stateDir: string): string {
  const sessionsRoot = join(stateDir, "sessions");
  const entries = readdirSync(sessionsRoot);
  expect(entries).toHaveLength(1);
  return join(sessionsRoot, entries[0] ?? "");
}

/** Run the fixture host directly with a lost ack (turn persisted, no reply). */
function crashTurn(sessionDir: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [HOST_PROGRAM, "turn", "--session-dir", sessionDir, "--chaos", "crash-turn"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    child.stdin.write(`${JSON.stringify({ message })}\n`);
    child.stdin.end();
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

describe("process bridge — real process mechanics", () => {
  it("treats a hostile-looking creation key as opaque data (no shell interpolation)", async () => {
    const stateDir = makeStateDir();
    const adapter = new ProcessBridgeAdapter({ stateDir });
    // The key contains shell metacharacters; structured argv must never let
    // a shell interpret them (prompts/05 task 1: no shell command strings).
    const hostileKey = "key;$(touch should-not-exist)";
    const handle = await adapter.createSession({ creation_key: hostileKey, bootstrap: BOOTSTRAP });
    expect(handle.host_session_id.startsWith("pb-")).toBe(true);
    expect(existsSync(join(process.cwd(), "should-not-exist"))).toBe(false);
    const found = await adapter.lookupSessionByCreationKey!(hostileKey);
    expect(found?.creation_key).toBe(hostileKey);
  }, 20000);

  it("survives a lost turn ack: the crash is reported and persisted state is the truth", async () => {
    const stateDir = makeStateDir();
    const first = new ProcessBridgeAdapter({ stateDir });
    const handle = await first.createSession({ creation_key: "disconnect-1", bootstrap: BOOTSTRAP });
    await first.runTurn(handle, { message: "before the crash" });

    // A turn whose ack is lost (host persists the turn, then dies) — what a
    // coordinator restart around a real host looks like. The bridge reports
    // the failure instead of guessing an outcome.
    const sessionDir = onlySessionDir(stateDir);
    await crashTurn(sessionDir, "a turn whose ack will be lost");

    // A fresh adapter instance over the same state dir recovers the
    // persisted truth by creation key: both turns completed in the fixture.
    const second = new ProcessBridgeAdapter({ stateDir });
    const recovered = await second.lookupSessionByCreationKey!("disconnect-1");
    expect(recovered).not.toBeNull();
    const result = await second.getResult(recovered!);
    expect(result.turn_count).toBe(2);
    expect(result.state).toBe("idle");
    expect(result.completed).toBe(true);
    expect(result.body).toContain("fixture answer #2");
  }, 20000);

  it("uncertain-create leaves a recoverable registry entry, not a duplicate", async () => {
    const adapter = new ProcessBridgeAdapter({
      stateDir: makeStateDir(),
      chaos: "uncertain-create",
    });
    await expect(
      adapter.createSession({ creation_key: "uncertain-1", bootstrap: BOOTSTRAP }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isRoleDockError(error) &&
        error.code === "INTERNAL" &&
        (error.details as { uncertain?: boolean }).uncertain === true,
    );
    // The recovery path the core uses: the dying host registered the session
    // before it confirmed, so the creation key still finds it.
    const recovered = await adapter.lookupSessionByCreationKey!("uncertain-1");
    expect(recovered?.creation_key).toBe("uncertain-1");
    expect(recovered?.host_session_id.length).toBeGreaterThan(0);
  }, 20000);

  it("crash-load is a hard failure with no host-side session left behind", async () => {
    const adapter = new ProcessBridgeAdapter({ stateDir: makeStateDir(), chaos: "crash-load" });
    await expect(
      adapter.createSession({ creation_key: "hard-fail-1", bootstrap: BOOTSTRAP }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isRoleDockError(error) &&
        error.code === "INTERNAL" &&
        (error.details as { stage?: string }).stage === "load",
    );
    expect(await adapter.lookupSessionByCreationKey!("hard-fail-1")).toBeNull();
  }, 20000);

  it("keeps concurrent sessions isolated: separate dirs, separate transcripts", async () => {
    const stateDir = makeStateDir();
    const adapter = new ProcessBridgeAdapter({ stateDir });
    const keys = ["concurrent-a", "concurrent-b", "concurrent-c"];
    const sessions = await Promise.all(
      keys.map((key) => adapter.createSession({ creation_key: key, bootstrap: BOOTSTRAP })),
    );
    expect(new Set(sessions.map((session) => session.host_session_id)).size).toBe(3);
    await Promise.all(
      sessions.map((session, index) =>
        adapter.runTurn(session, { message: `only for ${session.creation_key} #${index}` }),
      ),
    );
    for (const [index, session] of sessions.entries()) {
      const result = await adapter.getResult(session);
      expect(result.turn_count).toBe(1);
      const transcript = readFileSync(
        join(stateDir, "sessions", readdirSync(join(stateDir, "sessions"))[index] ?? "", "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain(`only for ${session.creation_key}`);
      expect(transcript).not.toContain("concurrent-" + (index === 0 ? "b" : "a"));
    }
    expect(readdirSync(join(stateDir, "sessions"))).toHaveLength(3);
  }, 30000);

  it("closeSession reclaims host scratch space and marks the session closed", async () => {
    const stateDir = makeStateDir();
    const adapter = new ProcessBridgeAdapter({ stateDir });
    const handle = await adapter.createSession({ creation_key: "reclaim-1", bootstrap: BOOTSTRAP });
    await adapter.runTurn(handle, { message: "work" });
    const sessionDir = onlySessionDir(stateDir);
    expect(existsSync(join(sessionDir, "tmp"))).toBe(true);

    await adapter.closeSession(handle);
    expect(existsSync(join(sessionDir, "tmp"))).toBe(false);
    const registry = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8")) as {
      status: string;
    };
    expect(registry.status).toBe("closed");
  }, 20000);
});
