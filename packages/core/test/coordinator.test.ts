import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ERROR_CODES, isRoleDockError } from "@roledock/protocol";
import type { ErrorCode } from "@roledock/protocol";
import { Coordinator, IMPLEMENTED_OPERATIONS, coordinatorOperations } from "../src/index.js";

import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];

function makeRootWithPack(): { root: string; packDir: string } {
  const root = mkdtempSync(join(tmpdir(), "roledock-coord-"));
  TEMP_ROOTS.push(root);
  const packDir = join(root, "src-pack");
  writePack({ dir: packDir, name: "coord-pack", roles: [{ id: "worker" }] });
  return { root, packDir };
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("coordinator operation surface", () => {
  it("exposes exactly the operations specified in docs/spec/sdk-operations.md", () => {
    expect(coordinatorOperations()).toEqual([
      "activateHandoff",
      "cancelRequest",
      "createRequest",
      "exportKnowledge",
      "getRequest",
      "importKnowledge",
      "installRolePack",
      "listDocuments",
      "listRoles",
      "listSessionInbox",
      "openSession",
      "prepareHandoff",
      "proposeDocumentUpdate",
      "publishDocument",
      "readArtifact",
      "readDocument",
      "replyToRequest",
      "resolveRole",
      "resumeSession",
    ].sort());
    expect(coordinatorOperations()).toHaveLength(19);
    expect(IMPLEMENTED_OPERATIONS).toEqual([
      "activateHandoff",
      "cancelRequest",
      "createRequest",
      "exportKnowledge",
      "getRequest",
      "importKnowledge",
      "installRolePack",
      "listDocuments",
      "listRoles",
      "listSessionInbox",
      "openSession",
      "prepareHandoff",
      "proposeDocumentUpdate",
      "publishDocument",
      "readArtifact",
      "readDocument",
      "replyToRequest",
      "resolveRole",
      "resumeSession",
    ]);
  });
});

describe("P1 implemented operations", () => {
  it("installs, lists and resolves roles on a real workspace", async () => {
    const { root, packDir } = makeRootWithPack();
    const coordinator = Coordinator.open({ root });
    try {
      const installed = await coordinator.installRolePack({ source_path: packDir });
      expect(installed.pack.name).toBe("coord-pack");
      expect(installed.roles.map((role) => role.id)).toEqual(["worker"]);

      const listed = await coordinator.listRoles({});
      expect(listed.roles).toHaveLength(1);
      expect(listed.roles[0]).toMatchObject({
        role_id: "worker",
        initialized: false,
        generation: 0,
        requested_capabilities: ["documents.read"],
        granted_capabilities: [],
      });

      const resolved = await coordinator.resolveRole({ role_id: "worker" });
      expect(resolved).toMatchObject({ role_id: "worker", initialized: false, current_instance_id: null });
    } finally {
      coordinator.close();
    }
  });

  it("resolves an unknown role with NOT_FOUND", async () => {
    const { root } = makeRootWithPack();
    const coordinator = Coordinator.open({ root });
    try {
      await expect(coordinator.resolveRole({ role_id: "ghost" })).rejects.toSatisfy(
        (error: unknown) => isRoleDockError(error) && error.code === "NOT_FOUND",
      );
    } finally {
      coordinator.close();
    }
  });

  it("validates operation input", async () => {
    const { root, packDir } = makeRootWithPack();
    const coordinator = Coordinator.open({ root });
    try {
      await expect(coordinator.installRolePack({})).rejects.toSatisfy(
        (error: unknown) => isRoleDockError(error) && error.code === "VALIDATION_FAILED",
      );
      await expect(coordinator.installRolePack({ source_path: packDir, workspace_id: "ws-00000000" })).rejects.toSatisfy(
        (error: unknown) => isRoleDockError(error) && error.code === "VALIDATION_FAILED",
      );
    } finally {
      coordinator.close();
    }
  });
});

describe("single-coordinator constraint", () => {
  it("fails a second open on the same workspace with WORKSPACE_LOCKED", () => {
    const { root } = makeRootWithPack();
    const first = Coordinator.open({ root });
    try {
      Coordinator.open({ root });
      expect.unreachable("expected WORKSPACE_LOCKED");
    } catch (error) {
      expect(isRoleDockError(error) && error.code).toBe("WORKSPACE_LOCKED");
    } finally {
      first.close();
    }
  });
});

describe("complete operation surface (P4)", () => {
  const coordinatorRoot = () => makeRootWithPack();

  it("implements every specified operation — none report NOT_IMPLEMENTED", async () => {
    const { root } = coordinatorRoot();
    const coordinator = Coordinator.open({ root, adapter: new MockHarnessAdapter() });
    expect(IMPLEMENTED_OPERATIONS).toHaveLength(coordinatorOperations().length);
    const methods = coordinator as unknown as Record<string, ((input: unknown) => Promise<unknown>) | undefined>;
    try {
      for (const operation of coordinatorOperations()) {
        const method = methods[operation];
        if (typeof method !== "function") throw new Error(`missing operation: ${operation}`);
        try {
          await method.call(coordinator, {});
        } catch (error) {
          // Validations may reject empty input; faking success or reporting
          // NOT_IMPLEMENTED would both be failures.
          expect(isRoleDockError(error) && error.code === "NOT_IMPLEMENTED", `${operation} reported NOT_IMPLEMENTED`).toBe(false);
        }
      }
    } finally {
      coordinator.close();
    }
  });

  it("uses only registered error codes across the surface", async () => {
    const { root } = coordinatorRoot();
    const coordinator = Coordinator.open({ root, adapter: new MockHarnessAdapter() });
    const codes: ErrorCode[] = [];
    const methods = coordinator as unknown as Record<string, ((input: unknown) => Promise<unknown>) | undefined>;
    try {
      for (const operation of coordinatorOperations()) {
        const method = methods[operation];
        if (typeof method !== "function") throw new Error(`missing operation: ${operation}`);
        try {
          await method.call(coordinator, {});
        } catch (error) {
          if (isRoleDockError(error)) codes.push(error.code);
        }
      }
    } finally {
      coordinator.close();
    }
    const registered: readonly string[] = Object.keys(ERROR_CODES);
    for (const code of codes) expect(registered).toContain(code);
    expect(codes.length).toBeGreaterThan(0);
  });
});
