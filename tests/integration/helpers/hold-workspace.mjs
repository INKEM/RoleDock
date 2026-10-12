#!/usr/bin/env node
// Test helper: hold a workspace's single-coordinator lock until killed.
// The process holds the WorkspaceStore open and waits; the test kills it
// with SIGKILL to prove the OS releases the file lock on process death.
import { WorkspaceStore } from "../../../packages/core/dist/index.js";

const root = process.argv[2];

const store = WorkspaceStore.open({ root });
console.log("held");
// Keep the event loop alive indefinitely; the test kills the process.
setInterval(() => {}, 1000);
