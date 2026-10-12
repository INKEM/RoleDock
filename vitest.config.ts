import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "tests/conformance/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    // The store suite is fsync-bound (SQLite EXCLUSIVE locking writes the
    // journal on every open/transaction) and the integration suite spawns
    // processes. Under load — especially right after `npm ci`, mirroring
    // CI — individual operations can take seconds; give tests and hooks
    // budgets that survive cold, contended disks instead of trimming what
    // they verify.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run test files sequentially: the workspace-lock and store suites
    // contend for disk with parallel workers and time out under load.
    fileParallelism: false,
  },
});
