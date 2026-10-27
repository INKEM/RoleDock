import { contextBridge, ipcRenderer } from "electron";
import { createShellApi } from "./shared/contract.js";

/**
 * Sandboxed preload: exposes exactly the shell namespaces/methods from the
 * manifest — no generic RPC channel, no credentials, no Node in the renderer.
 */
contextBridge.exposeInMainWorld("roledock", {
  shell: createShellApi((namespace, method, payload) => ipcRenderer.invoke(`roledock:${namespace}:${method}`, payload)),
});
