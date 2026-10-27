import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceSupervisor } from "../supervisor.js";
import { resolveRuntimeNode, EXPECTED_RUNTIME } from "../runtime.js";
import { createShellWindow, registerShellIpc } from "./ipc.js";
import { WorkspaceController } from "./workspace-controller.js";
import { loadSettingsFile } from "../shared/settings.js";

/**
 * dist-desktop/shell/ — main bundle sits at <shell>/main.mjs, renderer at
 * <shell>/renderer/, preload at <shell>/preload.cjs; vendor bundles and
 * schemas live one level up (dev) or under resources/runtime (packaged).
 */
const SHELL_DIR = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = join(SHELL_DIR, "renderer");

// Stable identity across dev and packaged so the single-instance lock and
// settings persist per user, not per launch. E2E isolates via env override.
app.setName("roledock-desktop");
if (process.env.ROLEDOCK_SHELL_USER_DATA) {
  app.setPath("userData", process.env.ROLEDOCK_SHELL_USER_DATA);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  process.stdout.write(JSON.stringify({ kind: "shell-single-instance-refused" }) + "\n");
  app.exit(0);
} else {
  app.on("second-instance", () => {
    const windows = BrowserWindow.getAllWindows();
    // G1-R03: under the keep-service-in-background policy the process may be
    // alive with zero windows — a fresh launch must restore the shell UI
    // (same controller/supervisor, no second writer), not just focus.
    if (windows.length === 0) {
      createShellWindow(RENDERER_DIR);
      return;
    }
    for (const window of windows) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  let supervisor: WorkspaceSupervisor | undefined;

  app.whenReady().then(() => {
    const runtime = resolveRuntimeNode({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, envNode: process.env.ROLEDOCK_SHELL_NODE });
    const vendorDir = app.isPackaged ? join(process.resourcesPath, "runtime", "vendor") : join(dirname(SHELL_DIR), "vendor");
    const bundlePath = join(vendorDir, "service-bundle.mjs");
    // G2-R03: the connector entry must be loadable by the INDEPENDENT Node
    // (never an asar-internal path, which only Electron's fs shim can read).
    const connectorPath = join(vendorDir, "zcode-connector.mjs");
    supervisor = new WorkspaceSupervisor({ nodePath: runtime.nodePath, bundlePath });
    const controller = new WorkspaceController({ supervisor, settingsFile: join(app.getPath("userData"), "settings.json"), nodePath: runtime.nodePath, connectorPath });
    registerShellIpc({ rendererDir: RENDERER_DIR, controller, userDataDir: app.getPath("userData"), nodePath: runtime.nodePath, connectorPath });
    createShellWindow(RENDERER_DIR);
    process.stdout.write(JSON.stringify({ kind: "roledock-shell", mode: runtime.mode, runtime: EXPECTED_RUNTIME, userData: app.getPath("userData") }) + "\n");
  });

  // Window close keeps owned services running (default policy, surfaced in
  // the UI); the app quits only through the explicit quit action.
  app.on("window-all-closed", () => { /* keep running; an owned service may be active */ });

  // Exit policy: reap owned services (bounded) unless the user disabled it.
  // Externally attached services are never killed by this process.
  let reaping = false;
  app.on("before-quit", event => {
    if (reaping || !supervisor) return;
    if (!loadSettingsFile(join(app.getPath("userData"), "settings.json")).exitStopsOwnedServices) return;
    event.preventDefault();
    reaping = true;
    void supervisor.reapOwned(8000).then(result => {
      for (const item of result) process.stdout.write(JSON.stringify({ kind: "shell-reaped-owned-service", ...item }) + "\n");
      app.quit();
    });
  });
}
