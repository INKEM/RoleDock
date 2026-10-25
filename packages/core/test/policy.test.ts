import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, WorkspaceAdmin } from "../src/index.js";

import { installRolePack } from "../src/roles/install.js";
import { WorkspaceStore } from "../src/store/workspace.js";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-policy-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { root: string; roleId: string } {
  const root = makeRoot();
  const packDir = join(root, "src-pack");
  writePack({ dir: packDir, name: "policy-pack", roles: [{ id: "worker" }] });
  const store = WorkspaceStore.open({ root });
  installRolePack(store, { sourcePath: packDir });
  store.close();
  return { root, roleId: "worker" };
}

describe("capability policy", () => {
  it("keeps requested capabilities separate from grants after install", () => {
    const { root, roleId } = setup();
    const admin = WorkspaceAdmin.open({ root });
    const report = admin.showPolicy();
    expect(report.roles).toHaveLength(1);
    expect(report.roles[0]).toMatchObject({
      role_id: roleId,
      requested: ["documents.read"],
      granted: [],
    });
    admin.close();
  });

  it("denies a self-declared identity with no grant — declarations are not capabilities", () => {
    const { root, roleId } = setup();
    const store = WorkspaceStore.open({ root });
    const grants = store.getConfig().policy.grants;
    // An actor that merely claims to be the role has nothing: the pack
    // requested documents.read, but no owner grant exists.
    expect(evaluate(grants, roleId, "documents.read")).toBe(false);
    expect(evaluate(grants, roleId, "documents.publish")).toBe(false);
    store.close();
  });

  it("grants and revokes through the owner entry, and evaluate follows", () => {
    const { root, roleId } = setup();
    const admin = WorkspaceAdmin.open({ root });

    const granted = admin.grant({ role_id: roleId, capability: "documents.read" });
    expect(granted).toMatchObject({ granted: true, already_applied: false });

    // Re-grant is idempotent.
    expect(admin.grant({ role_id: roleId, capability: "documents.read" })).toMatchObject({
      already_applied: true,
    });

    const revoked = admin.revoke({ role_id: roleId, capability: "documents.read" });
    expect(revoked).toMatchObject({ granted: false, already_applied: false });
    expect(admin.showPolicy().roles[0]?.granted).toEqual([]);
    admin.close();

    // End-to-end: a fresh grant is visible to a later coordinator handle.
    const admin2 = WorkspaceAdmin.open({ root });
    admin2.grant({ role_id: roleId, capability: "documents.read" });
    admin2.close();
    const store = WorkspaceStore.open({ root });
    expect(evaluate(store.getConfig().policy.grants, roleId, "documents.read")).toBe(true);
    store.close();
  });

  it("rejects revoking a capability that was never granted", () => {
    const { root, roleId } = setup();
    const admin = WorkspaceAdmin.open({ root });
    try {
      admin.revoke({ role_id: roleId, capability: "documents.read" });
      expect.unreachable("expected NOT_FOUND");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("NOT_FOUND");
    }
    admin.close();
  });

  it("rejects grants for unknown roles and malformed capability names", () => {
    const { root } = setup();
    const admin = WorkspaceAdmin.open({ root });
    expect(() => admin.grant({ role_id: "nobody", capability: "documents.read" })).toThrow(
      /not installed/,
    );
    expect(() => admin.grant({ role_id: "worker", capability: "read" })).toThrow(/namespaced/);
    admin.close();
  });
});
