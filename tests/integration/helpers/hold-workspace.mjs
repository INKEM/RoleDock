#!/usr/bin/env node
// Test helper: hold a workspace's single-coordinator lock until killed.
// The process holds the WorkspaceStore open and waits; the test kills it
// with SIGKILL to prove the OS releases the file lock on process death.
import { WorkspaceStore } from "../../../packages/core/dist/testing.js";

const root = process.argv[2];

const store = WorkspaceStore.open({ root });
// Keep the actual store reachable, not only the event loop: an unused
// top-level binding can be collected while the process remains alive,
// finalizing DatabaseSync and releasing its exclusive lock.
setInterval(() => { store.getConfig(); }, 1000);
// The integration test exposes GC to verify that the retained store still
// owns its lock even after collection, before advertising readiness.
global.gc?.();
console.log("held");
