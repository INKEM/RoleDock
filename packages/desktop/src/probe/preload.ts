import { contextBridge, ipcRenderer } from "electron";
import { createBridgeApi } from "./shared/bridge.js";

/**
 * Sandboxed preload: exposes exactly the named probe methods (no generic RPC
 * channel, no credentials, no Node access in the renderer).
 */
contextBridge.exposeInMainWorld("roledock", {
  probe: createBridgeApi((channel, payload) => ipcRenderer.invoke(channel, payload)),
});
