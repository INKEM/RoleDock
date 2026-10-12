import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/test/**/*.test.ts",
      "tests/conformance/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
  },
});
