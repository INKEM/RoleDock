import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e-shell",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
});
