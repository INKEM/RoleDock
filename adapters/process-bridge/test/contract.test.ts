import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import { ProcessBridgeAdapter } from "../src/index.js";
import { defineAdapterContractSuite } from "../../../tests/conformance/adapter-suite.js";

const TEMP_DIRS: string[] = [];
function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "roledock-pb-contract-"));
  TEMP_DIRS.push(dir);
  return dir;
}
afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("adapter contract: process bridge (real subprocesses)", () => {
  defineAdapterContractSuite({
    name: "process-bridge",
    adapterName: "process-bridge",
    make: () => new ProcessBridgeAdapter({ stateDir: makeStateDir() }),
    makeRestricted: () =>
      new ProcessBridgeAdapter({ stateDir: makeStateDir(), isolation: { context: false } }),
  });
});
