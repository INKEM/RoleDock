import { describe, expect, it } from "vitest";
import { ERROR_CODES, isRoleDockError } from "@roledock/protocol";
import type { ErrorCode } from "@roledock/protocol";
import { Coordinator, coordinatorOperations } from "../src/index.js";

const EXPECTED_OPERATIONS = [
  "activateHandoff",
  "cancelRequest",
  "createRequest",
  "exportKnowledge",
  "getRequest",
  "importKnowledge",
  "installRolePack",
  "listDocuments",
  "listRoles",
  "openSession",
  "prepareHandoff",
  "proposeDocumentUpdate",
  "publishDocument",
  "readArtifact",
  "readDocument",
  "replyToRequest",
  "resolveRole",
  "resumeSession",
].sort();

describe("coordinator operation surface", () => {
  it("exposes exactly the operations specified in docs/spec/sdk-operations.md", () => {
    expect(coordinatorOperations()).toEqual(EXPECTED_OPERATIONS);
  });
});

describe("P0 failure contract", () => {
  const coordinator = new Coordinator({ root: "/tmp/roledock-test" });
  type Op = (input: unknown) => Promise<unknown>;

  const operationMethod = (name: string): Op => {
    const method = (coordinator as unknown as Record<string, unknown>)[name];
    if (typeof method !== "function") throw new Error(`missing operation: ${name}`);
    return method.bind(coordinator) as Op;
  };

  for (const operation of coordinatorOperations()) {
    it(`rejects ${operation} with a NOT_IMPLEMENTED RoleDockError instead of faking success`, async () => {
      await expect(operationMethod(operation)({})).rejects.toSatisfy((error: unknown) => {
        return isRoleDockError(error) && error.code === "NOT_IMPLEMENTED";
      });
    });
  }

  it("includes a spec pointer in the error details", async () => {
    await expect(operationMethod("listRoles")({})).rejects.toSatisfy((error: unknown) => {
      return (
        isRoleDockError(error) &&
        error.details !== undefined &&
        (error.details as { spec?: string }).spec === "docs/spec/sdk-operations.md"
      );
    });
  });

  it("uses only registered error codes", async () => {
    const codes: ErrorCode[] = [];
    for (const operation of coordinatorOperations()) {
      try {
        await operationMethod(operation)({});
      } catch (error) {
        if (isRoleDockError(error)) codes.push(error.code);
      }
    }
    const registered: readonly string[] = Object.keys(ERROR_CODES);
    expect(codes.length).toBe(coordinatorOperations().length);
    for (const code of codes) expect(registered).toContain(code);
  });
});
