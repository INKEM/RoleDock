import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Locked-runtime resolution (desktop-gui-contract §8): the workspace service
 * always runs on the locked Node 22.23.2 binary — never the Electron-bundled
 * Node. Packaged shells carry the official dist binary under
 * resources/runtime/node; dev runs point ROLEDOCK_SHELL_NODE at the verified
 * cache copy. (Shell-owned copy; the G0 probe module stays frozen.)
 */
export const EXPECTED_RUNTIME = "v22.23.2";

export function resolveRuntimeNode(options: { isPackaged: boolean; resourcesPath: string; envNode?: string }): { mode: "dev" | "packaged"; nodePath: string } {
  if (options.isPackaged) {
    const nodePath = join(options.resourcesPath, "runtime", "node", "node");
    assertExecutable(nodePath);
    return { mode: "packaged", nodePath };
  }
  const nodePath = options.envNode ?? "";
  if (!nodePath) throw new Error(`开发模式需要 ROLEDOCK_SHELL_NODE 指向已校验的 ${EXPECTED_RUNTIME} 二进制（运行 npm run desktop:runtime）。`);
  assertExecutable(nodePath);
  return { mode: "dev", nodePath };
}

function assertExecutable(nodePath: string): void {
  accessSync(nodePath, constants.X_OK);
}
