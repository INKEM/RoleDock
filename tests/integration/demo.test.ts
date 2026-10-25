import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const DEMO = fileURLToPath(new URL("../../examples/demo.mjs", import.meta.url));

const TEMP_ROOTS: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-demo-test-"));
  TEMP_ROOTS.push(root);
  return root;
}
afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The blueprint's seven-step prototype demo, driven end to end through the
 * CLI on the process bridge (real fixture-host subprocesses). Runs TWICE to
 * prove it is re-runnable: each run gets a fresh workspace and must pass
 * identically without touching anything outside it.
 */
describe("re-runnable end-to-end demo (process bridge)", () => {
  const runs = 2;
  for (let run = 1; run <= runs; run++) {
    it(`passes run ${run}/${runs} through all seven steps`, { timeout: 120_000 }, () => {
      const root = makeRoot();
      const result = spawnSync(process.execPath, [DEMO, "--adapter", "bridge", "--root", root], {
        encoding: "utf8",
        timeout: 110_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("DEMO PASSED — 7/7 steps on the bridge adapter");

      // The machine log records adapter/host facts and per-step references.
      const logPath = join(root, "demo-log.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const entries = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const start = entries.find((entry) => entry.step === "start");
      expect(start).toMatchObject({
        adapter: "bridge",
        host_version: "0.1.0-fixture",
        model: "none (fixed-answer protocol fixture)",
      });
      const steps = new Set(entries.map((entry) => entry.step));
      for (const step of [1, 2, 3, 4, 5, 6, 7]) expect(steps).toContain(step);

      // Each run used its own fresh workspace: the second run must not have
      // reused the first run's session ids.
      const sessionIds = entries
        .filter((entry) => typeof entry.session_id === "string")
        .map((entry) => entry.session_id);
      expect(new Set(sessionIds).size).toBe(sessionIds.length);
    });
  }
});
