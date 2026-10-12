import { Coordinator, coordinatorOperations } from "@roledock/core";
import { toErrorEnvelope } from "@roledock/protocol";
import type { Envelope } from "@roledock/protocol";

export const VERSION = "0.1.0-alpha.0";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliResult {
  /** 0 success, 1 operational error, 2 usage error. */
  exitCode: 0 | 1 | 2;
}

const USAGE = `roledock — RoleDock command line interface (protocol 0.1)

Usage:
  roledock --version
  roledock --help
  roledock [--json] [--root <dir>] <group> <operation> [input...]

Groups and operations mirror the SDK surface:
  roles      install | list | resolve
  sessions   open | resume
  documents  list | read | propose | publish
  handoffs   prepare | activate
  requests   create | get | reply | cancel
  artifacts  read
  knowledge  export | import

Output is human-readable by default; pass --json for machine-readable
envelopes ({ok:true,...} or {ok:false,error:{code,...}}).

Exit codes: 0 success, 1 operational error, 2 usage error.
All state-changing operations are specified in docs/spec/sdk-operations.md;
in this build every operation reports NOT_IMPLEMENTED instead of faking success.`;

interface ParsedArgs {
  json: boolean;
  help: boolean;
  version: boolean;
  root?: string;
  positional: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = { json: false, help: false, version: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--root": {
        const value = argv[i + 1];
        if (value === undefined) return undefined;
        parsed.root = value;
        i++;
        break;
      }
      default:
        if (arg.startsWith("--")) return undefined;
        parsed.positional.push(arg);
    }
  }
  return parsed;
}

function emit(io: CliIo, json: boolean, envelope: Envelope, stderr: boolean): void {
  if (json) {
    (stderr ? io.stderr : io.stdout)(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (envelope.ok) {
    io.stdout(`${JSON.stringify(envelope.data ?? {}, null, 2)}\n`);
  } else {
    const { code, message } = envelope.error;
    (stderr ? io.stderr : io.stdout)(`error: ${code} — ${message}\n`);
  }
}

/** Dispatch table: "group operation" -> Coordinator method name. */
const COMMANDS: ReadonlyMap<string, string> = new Map([
  ["roles install", "installRolePack"],
  ["roles list", "listRoles"],
  ["roles resolve", "resolveRole"],
  ["sessions open", "openSession"],
  ["sessions resume", "resumeSession"],
  ["documents list", "listDocuments"],
  ["documents read", "readDocument"],
  ["documents propose", "proposeDocumentUpdate"],
  ["documents publish", "publishDocument"],
  ["handoffs prepare", "prepareHandoff"],
  ["handoffs activate", "activateHandoff"],
  ["requests create", "createRequest"],
  ["requests get", "getRequest"],
  ["requests reply", "replyToRequest"],
  ["requests cancel", "cancelRequest"],
  ["artifacts read", "readArtifact"],
  ["knowledge export", "exportKnowledge"],
  ["knowledge import", "importKnowledge"],
]);

export async function runCli(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const args = parseArgs(argv);
  if (args === undefined) {
    io.stderr(`${USAGE}\n`);
    return { exitCode: 2 };
  }

  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return { exitCode: 0 };
  }

  if (args.version) {
    if (args.json) {
      emit(io, true, { ok: true, data: { name: "roledock", version: VERSION } }, false);
    } else {
      io.stdout(`${VERSION}\n`);
    }
    return { exitCode: 0 };
  }

  if (args.positional.length === 0) {
    io.stderr(`${USAGE}\n`);
    return { exitCode: 2 };
  }

  const commandKey = args.positional.slice(0, 2).join(" ");
  const method = COMMANDS.get(commandKey);
  if (method === undefined) {
    const known = [...COMMANDS.keys()];
    const message = `unknown command "${commandKey}"; expected "<group> <operation>" from: ${known.join(", ")}`;
    emit(
      io,
      args.json,
      { ok: false, error: { code: "VALIDATION_FAILED", message } },
      true,
    );
    if (!args.json) io.stderr(`${USAGE}\n`);
    return { exitCode: 2 };
  }

  const coordinator = new Coordinator({ root: args.root ?? ".roledock" });
  const operation = commandKey.replace(" ", ".");
  const handler = (coordinator as unknown as Record<string, (input: unknown) => Promise<never>>)[
    method
  ];
  if (handler === undefined || typeof handler !== "function" || !coordinatorOperations().includes(method)) {
    emit(
      io,
      args.json,
      {
        ok: false,
        error: { code: "INTERNAL", message: `command ${commandKey} is wired to a missing SDK method` },
      },
      true,
    );
    return { exitCode: 1 };
  }

  try {
    await handler.call(coordinator, { positional: args.positional.slice(2), root: args.root });
    // Unreachable while every operation rejects; guards against a future
    // implementation silently returning undefined as success.
    emit(io, args.json, { ok: false, error: { code: "INTERNAL", message: "operation returned without a result" } }, true);
    return { exitCode: 1 };
  } catch (error) {
    emit(io, args.json, toErrorEnvelope(error), true);
    return { exitCode: 1 };
  }
}
