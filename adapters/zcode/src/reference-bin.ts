#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { runReferenceConnector } from "./reference-connector.js";
import { toErrorEnvelope } from "@roledock/protocol";

/**
 * roledock-zcode-reference-connector: MCP stdio server for docs/zcode-connector-tools.md.
 * The ZCode CLI entry is caller-injected (no default path); the optional
 * credential helper keeps credentials outside this repository.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cli: { type: "string" }, "credential-helper": { type: "string" }, provider: { type: "string" }, model: { type: "string" }, journal: { type: "string" }, sandbox: { type: "boolean", default: false }, "sandbox-egress": { type: "string", multiple: true } }, strict: true });
  const cli = values.cli ?? process.env.ZCODE_CLI_ENTRY;
  const credentialHelper = values["credential-helper"] ?? process.env.ROLEDOCK_ZCODE_CREDENTIAL_HELPER;
  const provider = values.provider ?? process.env.ZCODE_PROVIDER;
  const model = values.model ?? process.env.ZCODE_MODEL;
  if (!cli || !isAbsolute(cli)) throw new Error("Use --cli <absolute path to the ZCode CLI entry> (or ZCODE_CLI_ENTRY). Personal paths are never bundled.");
  const sandbox = values.sandbox === true ? { egress: values["sandbox-egress"] ?? [] } : undefined;
  await runReferenceConnector({ cliPath: cli, credentialHelper, provider, model, journal: values.journal, sandbox });
}
main().catch(error => { process.stderr.write(JSON.stringify(toErrorEnvelope(error)) + "\n"); process.exitCode = 1; });
