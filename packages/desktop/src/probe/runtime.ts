import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Runtime resolution (DESKTOP_GUI_PLAN §4): the workspace service always runs
 * on the locked Node 22.23.2 binary — never on the Electron-bundled Node.
 * Packaged apps carry the official dist binary under resources/runtime/node;
 * dev runs point ROLEDOCK_PROBE_NODE at the verified cache copy.
 */
export function resolveRuntimeNode(options: { isPackaged: boolean; resourcesPath: string; envNode?: string }): { mode: "dev" | "packaged"; nodePath: string } {
  if (options.isPackaged) {
    const nodePath = join(options.resourcesPath, "runtime", "node", "node");
    assertExecutable(nodePath);
    return { mode: "packaged", nodePath };
  }
  const nodePath = options.envNode ?? "";
  if (!nodePath) {
    throw new Error("Dev probe needs ROLEDOCK_PROBE_NODE pointing at the verified Node 22.23.2 binary (run: npm run desktop:runtime).");
  }
  assertExecutable(nodePath);
  return { mode: "dev", nodePath };
}

function assertExecutable(nodePath: string): void {
  accessSync(nodePath, constants.X_OK);
}
