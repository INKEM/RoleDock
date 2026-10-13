import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleDockError, isRoleDockError } from "@roledock/protocol";
import { WorkspaceStore } from "../src/index.js";

const TEMP_ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-store-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function appendEvent(store: WorkspaceStore, kind: string): string {
  const id = `evt-${kind}`;
  // Single-statement insert; participates in the caller's transaction if one
  // is open, autocommits otherwise.
  store
    .prepare(
      "INSERT INTO outbox_events (id, workspace_id, kind, payload_json, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    )
    .run(id, store.workspaceId, kind, "{}", new Date().toISOString());
  return id;
}

describe("workspace store", () => {
  it("opens a fresh workspace, migrates once, and keeps a stable workspace id", () => {
    const root = makeRoot();
    const first = WorkspaceStore.open({ root });
    expect(first.workspaceId).toMatch(/^ws-[0-9a-f]{8}$/);
    first.close();

    const second = WorkspaceStore.open({ root });
    expect(second.workspaceId).toBe(first.workspaceId);
    const migrations = second.prepare("SELECT count(*) AS n FROM schema_migrations").get() as {
      n: number;
    };
    expect(migrations.n).toBe(4);
    second.close();
  });

  it("persists state across close and reopen", () => {
    const root = makeRoot();
    const first = WorkspaceStore.open({ root });
    appendEvent(first, "probe");
    first.close();

    const second = WorkspaceStore.open({ root });
    const row = second.prepare("SELECT kind FROM outbox_events").get() as { kind: string };
    expect(row.kind).toBe("probe");
    second.close();
  });

  it("rolls back a failed transaction without leaving rows", () => {
    const root = makeRoot();
    const store = WorkspaceStore.open({ root });
    expect(() =>
      store.tx(() => {
        appendEvent(store, "doomed");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const count = store.prepare("SELECT count(*) AS n FROM outbox_events").get() as { n: number };
    expect(count.n).toBe(0);
    store.close();
  });

  it("rejects a tampered migration checksum on reopen", () => {
    const root = makeRoot();
    const store = WorkspaceStore.open({ root });
    store.close();

    const raw = new DatabaseSync(join(root, ".roledock", "state.sqlite"));
    raw.prepare("UPDATE schema_migrations SET checksum = 'deadbeef'").run();
    raw.close();

    expect(() => WorkspaceStore.open({ root })).toThrow(RoleDockError);
    try {
      WorkspaceStore.open({ root });
    } catch (error) {
      expect(isRoleDockError(error));
      expect(isRoleDockError(error) && error.code === "VALIDATION_FAILED").toBe(true);
    }
  });

  it("rejects state written by a newer build (unknown migration id)", () => {
    const root = makeRoot();
    const store = WorkspaceStore.open({ root });
    store.close();

    const raw = new DatabaseSync(join(root, ".roledock", "state.sqlite"));
    raw
      .prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (99, 'x', 'now')")
      .run();
    raw.close();

    try {
      WorkspaceStore.open({ root });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isRoleDockError(error));
      expect(isRoleDockError(error) && error.code === "VALIDATION_FAILED").toBe(true);
    }
  });

  it("fails a second in-process open with WORKSPACE_LOCKED and recovers after close", () => {
    const root = makeRoot();
    const first = WorkspaceStore.open({ root });
    try {
      WorkspaceStore.open({ root });
      expect.unreachable("expected WORKSPACE_LOCKED");
    } catch (error) {
      expect(isRoleDockError(error));
      expect(isRoleDockError(error) && error.code === "WORKSPACE_LOCKED").toBe(true);
    }
    first.close();
    const reopened = WorkspaceStore.open({ root });
    expect(reopened.workspaceId).toBe(first.workspaceId);
    reopened.close();
  });
});
