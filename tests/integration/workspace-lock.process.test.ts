import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Coordinator, WorkspaceStore } from "@roledock/core";
import { isRoleDockError } from "@roledock/protocol";

const HELPER = new URL("./helpers/hold-workspace.mjs", import.meta.url);
const CORE_DIST = fileURLToPath(new URL("../../packages/core/dist/index.js", import.meta.url));

const TEMP_ROOTS: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-lockproc-"));
  TEMP_ROOTS.push(root);
  return root;
}
afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function coreDistExists(): boolean {
  return existsSync(CORE_DIST);
}

describe("single-coordinator lock across real processes", () => {
  it("blocks a second coordinator while a child process holds the workspace, and recovers when it dies", async () => {
    expect(coreDistExists(), 'core is not built; root "test" script builds first').toBe(true);
    const root = makeRoot();

    // First process takes the lock via the real store implementation and
    // holds it until killed — no timing dependency in this test.
    const child = spawn(process.execPath, [HELPER.pathname, root], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const held = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`holder exited early: ${code}`)));
    });
    await held;

    // A different process must fail with a structured WORKSPACE_LOCKED error.
    const probe = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        `
        import { WorkspaceStore } from ${JSON.stringify(CORE_DIST)};
        try {
          WorkspaceStore.open({ root: process.argv[1] });
          console.log("UNEXPECTED-OPEN");
        } catch (error) {
          console.log(JSON.stringify({ code: error.code ?? null, message: error.message }));
        }
        `,
        root,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(probe.stdout).not.toContain("UNEXPECTED-OPEN");
    const reported = JSON.parse(probe.stdout.trim().split("\n").pop() ?? "{}") as {
      code: string | null;
    };
    expect(reported.code).toBe("WORKSPACE_LOCKED");

    // While still held, an in-process open fails with the same structured error.
    try {
      WorkspaceStore.open({ root });
      expect.unreachable("expected WORKSPACE_LOCKED while holder alive");
    } catch (error) {
      expect(isRoleDockError(error));
      expect(isRoleDockError(error) && error.code === "WORKSPACE_LOCKED").toBe(true);
    }

    // Kill the holder hard (SIGKILL, no cleanup possible): the OS releases
    // the file lock on process death, so there is no stale lock to clean up.
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const coordinator = Coordinator.open({ root });
    expect(coordinator.workspaceId).toMatch(/^ws-[0-9a-f]{8}$/);
    coordinator.close();
  }, 30000);
});
