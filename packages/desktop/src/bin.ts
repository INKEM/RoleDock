#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ServiceClient } from "@roledock/service";
import type { ServiceCredential } from "@roledock/service";
import { toErrorEnvelope } from "@roledock/protocol";
import { startDesktopServer } from "./index.js";

/**
 * roledock-desktop-gmin: the G-min trusted owner confirmation surface.
 * Reads the owner credential file written by the workspace service, serves
 * the confirmation page on 127.0.0.1, and proxies exactly three calls
 * (externalSessions.list / roles.list / authorizations.submitHumanEvent).
 * The page never sees the credential (ADR-0007 boundary).
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { root: { type: "string" }, "owner-connection": { type: "string" }, port: { type: "string" } }, strict: true });
  const endpoint = values["owner-connection"] ? resolve(values["owner-connection"]) : values.root ? resolve(join(values.root, ".roledock", "owner-connection.json")) : undefined;
  if (!endpoint || !isAbsolute(endpoint)) throw new Error("Use --root <workspace root> (or --owner-connection <path to owner-connection.json>).");
  const stat = lstatSync(endpoint);
  if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Owner credential path is not an owned regular file.");
  if (stat.mode & 0o077) throw new Error("Owner credential file must not be group/world readable (chmod 600).");
  const credential = JSON.parse(readFileSync(endpoint, "utf8")) as ServiceCredential;
  if (typeof credential.socket_path !== "string" || typeof credential.token !== "string") throw new Error("Owner credential file does not contain a service credential.");
  const port = values.port !== undefined ? Number(values.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer between 0 and 65535.");
  const server = await startDesktopServer({ client: new ServiceClient(credential), port });
  process.stdout.write(JSON.stringify({ kind: "gmin-desktop", url: server.url }) + "\n");
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await server.close(); };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
}
main().catch(error => { process.stderr.write(JSON.stringify(toErrorEnvelope(error)) + "\n"); process.exitCode = 1; });
