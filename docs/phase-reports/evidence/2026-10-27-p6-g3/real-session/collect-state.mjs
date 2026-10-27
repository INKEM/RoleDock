#!/usr/bin/env node
/** P6-G3 real-session evidence collector: dumps the workspace backend truth
 * (identifiers, confirmation chain, binding) via the owner connection, plus
 * credential-file metadata. Redacts nothing — output contains only protocol
 * projections (no bearer); the owner file itself is read locally. */
import { readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceClient } from "@roledock/service";

const ws = process.argv[2];
const outFile = process.argv[3];
if (!ws) { console.error("usage: node collect-state.mjs <workspace-dir> [out.json]"); process.exit(2); }

const credential = JSON.parse(readFileSync(join(ws, ".roledock", "owner-connection.json"), "utf8"));
const client = new ServiceClient(credential);
const envFile = join(ws, ".roledock", "mcp-session.env");
const dump = {
  collected_at: new Date().toISOString(),
  workspace: await client.call("workspace.info", {}),
  runtime: await client.call("workspace.runtimeStatus", {}),
  roles: await client.call("roles.list", {}),
  external_sessions: await client.call("externalSessions.list", {}),
  confirmations: await client.call("authorizations.confirmations", { limit: 50 }),
  pending_events: "(trusted-only; not readable here by design)",
  mcp_env_file: existsSync(envFile)
    ? { path: envFile, mode: statSync(envFile).mode & 0o777, keys: readFileSync(envFile, "utf8").split("\n").filter(Boolean).map(line => line.split("=")[0]) }
    : null,
};
const text = JSON.stringify(dump, null, 2);
if (outFile) writeFileSync(outFile, text);
console.log(text);
process.exit(0);
