import { describe } from "vitest";
import { MockHarnessAdapter } from "../src/index.js";
import { defineAdapterContractSuite } from "../../../tests/conformance/adapter-suite.js";

describe("adapter contract: in-memory mock", () => {
  defineAdapterContractSuite({
    name: "mock",
    adapterName: "mock",
    make: () => new MockHarnessAdapter(),
    makeRestricted: () => new MockHarnessAdapter({ isolation: { context: false } }),
  });
});
