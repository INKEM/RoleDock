import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleDockError, isRoleDockError } from "@roledock/protocol";
import { WorkspaceStore } from "../src/index.js";
import { installRolePack } from "../src/roles/install.js";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-install-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function expectError(code: string, run: () => unknown): RoleDockError {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(isRoleDockError(error), `${code}: got ${String(error)}`).toBe(true);
    if (isRoleDockError(error)) {
      expect(error.code).toBe(code);
      return error;
    }
    throw new Error(`expected ${code}`);
  }
  throw new Error("unreachable");
}

describe("role pack installer", () => {
  it("installs a pack, copies content into the workspace, and seeds uninitialized heads", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "acme-pack", roles: [{ id: "worker" }, { id: "planner" }] });

    const store = WorkspaceStore.open({ root });
    const result = installRolePack(store, { sourcePath: packDir });
    expect(result.reinstalled).toBe(false);
    expect(result.pack).toEqual({ name: "acme-pack", version: "0.1.0", content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.roles.map((role) => role.id).sort()).toEqual(["planner", "worker"]);
    expect(result.roles.every((role) => role.initialized === false)).toBe(true);

    const stored = join(store.packsDir, "acme-pack", "0.1.0", "rolepack.json");
    expect(existsSync(stored)).toBe(true);

    const heads = store.prepare("SELECT role_id, generation, current_instance_id FROM role_heads ORDER BY role_id").all() as Array<{ role_id: string; generation: number; current_instance_id: string | null }>;
    expect(heads).toHaveLength(2);
    for (const head of heads) {
      expect(head.generation).toBe(0);
      expect(head.current_instance_id).toBeNull();
    }
    store.close();
  });

  it("reinstalling identical content is idempotent", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "acme-pack" });

    const store = WorkspaceStore.open({ root });
    const first = installRolePack(store, { sourcePath: packDir });
    const second = installRolePack(store, { sourcePath: packDir });
    expect(second.reinstalled).toBe(true);
    expect(second.pack.content_hash).toBe(first.pack.content_hash);
    const count = store.prepare("SELECT count(*) AS n FROM roles").get() as { n: number };
    expect(count.n).toBe(1);
    store.close();
  });

  it("rejects the same name+version with different content as IDEMPOTENCY_CONFLICT", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    const altDir = join(root, "alt-pack");
    writePack({ dir: packDir, name: "acme-pack" });
    writePack({ dir: altDir, name: "acme-pack", templateMarker: "changed content" });

    const store = WorkspaceStore.open({ root });
    installRolePack(store, { sourcePath: packDir });
    const error = expectError("IDEMPOTENCY_CONFLICT", () => installRolePack(store, { sourcePath: altDir }));
    expect(error.details).toMatchObject({ existing_content_hash: expect.any(String), new_content_hash: expect.any(String) });
    store.close();
  });

  it("rejects role id collisions across packs with ROLE_ALREADY_EXISTS", () => {
    const root = makeRoot();
    const packDirA = join(root, "pack-a");
    const packDirB = join(root, "pack-b");
    writePack({ dir: packDirA, name: "pack-a", roles: [{ id: "shared" }] });
    writePack({ dir: packDirB, name: "pack-b", roles: [{ id: "unique" }, { id: "shared" }] });

    const store = WorkspaceStore.open({ root });
    installRolePack(store, { sourcePath: packDirA });
    const error = expectError("ROLE_ALREADY_EXISTS", () => installRolePack(store, { sourcePath: packDirB }));
    expect(error.details).toMatchObject({ role_ids: ["shared"] });
    // pack-b must not be registered at all
    const packs = store.prepare("SELECT count(*) AS n FROM role_packs").get() as { n: number };
    expect(packs.n).toBe(1);
    store.close();
  });

  it("leaves no half-installed pack when the transaction fails mid-install", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "sabotage-pack", roles: [{ id: "worker" }] });

    // Sabotage: pre-seed a conflicting roles row (with its FK-satisfying pack
    // row) so the roles INSERT collides inside the install transaction.
    const store = WorkspaceStore.open({ root });
    store.tx(() => {
      store
        .prepare("INSERT INTO role_packs (name, version, content_hash, protocol_version, source_path, store_path, installed_at) VALUES ('seed-pack', '0.0.1', 'x', '0.1', 'seed', 'seed', 'now')")
        .run();
      store
        .prepare("INSERT INTO roles (role_id, pack_name, pack_version, title, instructions, definition_json) VALUES ('worker', 'seed-pack', '0.0.1', 'W', 'roles/worker.md', '{}')")
        .run();
    });

    expect(() => installRolePack(store, { sourcePath: packDir })).toThrow();

    // The sabotaged install must not have registered anything...
    const sabotaged = store
      .prepare("SELECT count(*) AS n FROM role_packs WHERE name = 'sabotage-pack'")
      .get() as { n: number };
    expect(sabotaged.n).toBe(0);
    const roles = store.prepare("SELECT count(*) AS n FROM roles").get() as { n: number };
    expect(roles.n).toBe(1); // only the seed row survives
    // ...and no staging leftovers either.
    const staged = readdirSync(store.packsDir).filter((name) => name.startsWith(".staging-"));
    expect(staged).toEqual([]);
    store.close();
  });

  it("rejects a workspace id mismatch", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir });
    const store = WorkspaceStore.open({ root });
    expectError("VALIDATION_FAILED", () => installRolePack(store, { sourcePath: packDir, workspaceId: "ws-ffffffff" }));
    store.close();
  });

  it("registers roles from packs installed before a restart (persistence)", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "persist-pack" });
    const store = WorkspaceStore.open({ root });
    installRolePack(store, { sourcePath: packDir });
    const workspaceId = store.workspaceId;
    store.close();

    const reopened = WorkspaceStore.open({ root });
    expect(reopened.workspaceId).toBe(workspaceId);
    const roles = reopened.prepare("SELECT role_id FROM roles").all() as Array<{ role_id: string }>;
    expect(roles.map((role) => role.role_id)).toEqual(["solo"]);
    reopened.close();
  });

  it("writes no grants from requested capabilities", () => {
    const root = makeRoot();
    const packDir = join(root, "src-pack");
    writePack({ dir: packDir, name: "grant-pack" });
    const store = WorkspaceStore.open({ root });
    installRolePack(store, { sourcePath: packDir });
    const config = store.getConfig();
    expect(config.policy.grants).toEqual({});
    store.close();
  });
});
