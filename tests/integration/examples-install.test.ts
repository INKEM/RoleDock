import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, WorkspaceAdmin } from "@roledock/core";

import { isRoleDockError } from "@roledock/protocol";
import type { RoleSummary } from "@roledock/core";

const DEMO_TEAM = fileURLToPath(new URL("../../examples/demo-team", import.meta.url));
const CUSTOM_ROLE = fileURLToPath(new URL("../../examples/custom-role", import.meta.url));

const TEMP_ROOTS: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-examples-"));
  TEMP_ROOTS.push(root);
  return root;
}
afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("example role packs install end to end", () => {
  it("installs both example packs and survives a restart", async () => {
    const root = makeRoot();
    const coordinator = Coordinator.open({ root });
    const demo = await coordinator.installRolePack({ source_path: DEMO_TEAM });
    const custom = await coordinator.installRolePack({ source_path: CUSTOM_ROLE });
    expect(demo.pack).toMatchObject({ name: "demo-team", version: "0.1.0" });
    expect(custom.pack).toMatchObject({ name: "solo-archivist", version: "0.1.0" });
    expect(demo.roles.map((role) => role.id).sort()).toEqual(["builder", "explainer", "reviewer"]);
    expect(custom.roles.map((role) => role.id)).toEqual(["archivist"]);

    const listed = await coordinator.listRoles({});
    const ids = listed.roles.map((role: RoleSummary) => role.role_id).sort();
    expect(ids).toEqual(["archivist", "builder", "explainer", "reviewer"]);
    expect(new Set(ids).size).toBe(4);
    const workspaceId = coordinator.workspaceId;
    coordinator.close();

    // Restart: state and content persist, new coordinator sees the same roles.
    const reopened = Coordinator.open({ root });
    expect(reopened.workspaceId).toBe(workspaceId);
    const again = await reopened.listRoles({});
    expect(again.roles).toHaveLength(4);
    const archivist = await reopened.resolveRole({ role_id: "archivist" });
    expect(archivist).toMatchObject({
      role_id: "archivist",
      initialized: false,
      generation: 0,
      knowledge_revision: 0,
      current_instance_id: null,
      pack: { name: "solo-archivist", version: "0.1.0" },
    });

    // Capability declarations stay requests, never grants.
    expect(archivist.requested_capabilities).toEqual(["documents.read", "documents.propose"]);
    expect(archivist.granted_capabilities).toEqual([]);
    reopened.close();
  });

  it("reinstalling identical example packs is idempotent", async () => {
    const root = makeRoot();
    const coordinator = Coordinator.open({ root });
    await coordinator.installRolePack({ source_path: DEMO_TEAM });
    const again = await coordinator.installRolePack({ source_path: DEMO_TEAM });
    expect(again.reinstalled).toBe(true);
    const roles = await coordinator.listRoles({});
    expect(roles.roles).toHaveLength(3);
    coordinator.close();
  });

  it("the owner can grant a requested capability through the admin entry", async () => {
    const root = makeRoot();
    const coordinator = Coordinator.open({ root });
    await coordinator.installRolePack({ source_path: DEMO_TEAM });
    coordinator.close();

    const admin = WorkspaceAdmin.open({ root });
    const report = admin.showPolicy();
    const builder = report.roles.find((role) => role.role_id === "builder");
    expect(builder?.requested).toContain("documents.publish");
    expect(builder?.granted).toEqual([]);
    admin.grant({ role_id: "builder", capability: "documents.read" });
    const after = admin.showPolicy().roles.find((role) => role.role_id === "builder");
    expect(after?.granted).toEqual(["documents.read"]);
    admin.close();
  });

  it("keeps workspaces isolated from each other", async () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const coordinatorA = Coordinator.open({ root: rootA });
    await coordinatorA.installRolePack({ source_path: DEMO_TEAM });
    const workspaceA = coordinatorA.workspaceId;
    coordinatorA.close();

    const coordinatorB = Coordinator.open({ root: rootB });
    // B sees nothing of A.
    try {
      await coordinatorB.resolveRole({ role_id: "builder" });
      expect.unreachable("expected NOT_FOUND");
    } catch (error) {
      expect(isRoleDockError(error));
      expect(isRoleDockError(error) && error.code === "NOT_FOUND").toBe(true);
    }
    // Claiming A's workspace id does not cross the boundary either.
    try {
      await coordinatorB.resolveRole({ role_id: "builder", workspace_id: workspaceA });
      expect.unreachable("expected VALIDATION_FAILED");
    } catch (error) {
      expect(isRoleDockError(error));
      expect(isRoleDockError(error) && error.code === "VALIDATION_FAILED").toBe(true);
    }
    coordinatorB.close();
  });
});
