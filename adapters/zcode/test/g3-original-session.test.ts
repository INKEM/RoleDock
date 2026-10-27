import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeAdapter } from "../src/index.js";
import type { ZCodeToolCaller } from "../src/index.js";

/** G3 (ADR-0014 §9.1): the ORIGINAL session a user anchors can be either a
 * connector-created `sess_*` conversation or their PERSISTED DESKTOP session
 * (`session_<hex>`; spike evidence 2026-10-27-p6-g3/spike-discovery). Every
 * identity-bearing path — verifyExternalSession AND readHumanAuthorization —
 * must accept both and still refuse malformed references. The format guards
 * run before any connector/source interaction, so a source-less adapter
 * isolates them: valid id → NOT_IMPLEMENTED (no source wired), invalid id →
 * VALIDATION_FAILED. */
class VerifyFixture implements ZCodeToolCaller {
  readonly #workspace: string;
  readonly existing = new Set<string>();
  readonly tools = new Set(["zcode_verify_session"]);
  constructor(workspace: string) { this.#workspace = workspace; }
  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name === "zcode_verify_session") {
      const sessionId = String(input.sessionId);
      return { sessionId, exists: this.existing.has(sessionId), workspacePath: this.#workspace };
    }
    throw new Error(`unexpected: ${name}`);
  }
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function make(): { adapter: ZCodeAdapter; fixture: VerifyFixture; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rd-zcode-g3-verify-"));
  roots.push(root);
  const fixture = new VerifyFixture(root);
  return { adapter: new ZCodeAdapter({ tools: fixture, workspacePath: root, stateDir: join(root, "journal") }), fixture, root };
}

const DESKTOP = "session_37c8719351aeb2b6a17ee486deb0bbc5";

describe("G3 original-session identity formats", () => {
  it("verifies a persisted desktop session id and a connector session id", async () => {
    const { adapter, fixture } = make();
    fixture.existing.add(DESKTOP);
    fixture.existing.add("sess_connector-made-1");
    await expect(adapter.verifyExternalSession(DESKTOP, "desktop-event-bridge")).resolves.toBe(true);
    await expect(adapter.verifyExternalSession("sess_connector-made-1", "desktop-event-bridge")).resolves.toBe(true);
    // First successful verification binds host↔subject; a different subject is definitive false.
    await expect(adapter.verifyExternalSession(DESKTOP, "other-subject")).resolves.toBe(false);
  });

  it("readHumanAuthorization accepts desktop session ids (guard precedes source wiring)", async () => {
    const { adapter } = make();
    await expect(adapter.readHumanAuthorization(DESKTOP, "gui-x")).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(adapter.readHumanAuthorization("sess_fixture-1", "gui-x")).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("still refuses malformed references and unknown sessions honestly", async () => {
    const { adapter, fixture } = make();
    await expect(adapter.verifyExternalSession("not-a-session-id", "desktop-event-bridge")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(adapter.verifyExternalSession("session_", "desktop-event-bridge")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(adapter.readHumanAuthorization("not-a-session-id", "gui-x")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const absent = `session_${"f".repeat(32)}`;
    await expect(adapter.verifyExternalSession(absent, "desktop-event-bridge")).resolves.toBe(false);
  });
});
