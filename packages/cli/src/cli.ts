import { Coordinator, WorkspaceAdmin } from "@roledock/core";
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
  roledock [--json] [--root <dir>] <group> <operation> [args...]

Workspace selection: --root <dir> sets the workspace root (default: current
directory). State lives under <root>/.roledock/.

Available operations (P1, backed by the local workspace):
  roles install <pack-dir>       install a local role pack
  roles list                     list installed roles and capability state
  roles resolve <role-id>        show one role (uninitialized roles are explicit)
  admin policy                   owner view: requested vs granted capabilities
  admin grant <role> <cap>       owner entry: grant a capability to a role
  admin revoke <role> <cap>      owner entry: revoke a capability

Specified but not implemented in this build (they fail with NOT_IMPLEMENTED):
  sessions open | resume
  documents list | read | propose | publish
  handoffs prepare | activate
  requests create | get | reply | cancel
  artifacts read
  knowledge export | import

Output is human-readable by default; pass --json for machine-readable
envelopes ({ok:true,...} or {ok:false,error:{code,...}}).
Exit codes: 0 success, 1 operational error, 2 usage error.`;

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

interface CommandSpec {
  /** Argument names consumed from positional args after group+operation. */
  readonly args?: readonly string[];
  /** Maps parsed positional args to the operation input object. */
  readonly buildInput: (positional: readonly string[]) => Record<string, unknown>;
}

/** "group operation" -> SDK/admin operation spec. */
const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["roles install", { args: ["source_path"], buildInput: namedArgs(["source_path"]) }],
  ["roles list", { buildInput: () => ({}) }],
  ["roles resolve", { args: ["role_id"], buildInput: namedArgs(["role_id"]) }],
  ["admin policy", { buildInput: () => ({}) }],
  ["admin grant", { args: ["role_id", "capability"], buildInput: namedArgs(["role_id", "capability"]) }],
  ["admin revoke", { args: ["role_id", "capability"], buildInput: namedArgs(["role_id", "capability"]) }],
  // Specified operations without a P1 implementation: input is not consumed.
  ["sessions open", { buildInput: () => ({}) }],
  ["sessions resume", { buildInput: () => ({}) }],
  ["documents list", { buildInput: () => ({}) }],
  ["documents read", { buildInput: () => ({}) }],
  ["documents propose", { buildInput: () => ({}) }],
  ["documents publish", { buildInput: () => ({}) }],
  ["handoffs prepare", { buildInput: () => ({}) }],
  ["handoffs activate", { buildInput: () => ({}) }],
  ["requests create", { buildInput: () => ({}) }],
  ["requests get", { buildInput: () => ({}) }],
  ["requests reply", { buildInput: () => ({}) }],
  ["requests cancel", { buildInput: () => ({}) }],
  ["artifacts read", { buildInput: () => ({}) }],
  ["knowledge export", { buildInput: () => ({}) }],
  ["knowledge import", { buildInput: () => ({}) }],
]);

function namedArgs(names: readonly string[]) {
  return (positional: readonly string[]): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    names.forEach((name, index) => {
      const value = positional[index];
      if (value !== undefined) input[name] = value;
    });
    return input;
  };
}

interface OperationTarget {
  readonly method: string;
  readonly admin: boolean;
}

const ADMIN_METHODS: ReadonlyMap<string, string> = new Map([
  ["admin policy", "showPolicy"],
  ["admin grant", "grant"],
  ["admin revoke", "revoke"],
]);

const SDK_METHODS: ReadonlyMap<string, string> = new Map([
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

function methodFor(command: string): OperationTarget | undefined {
  const adminMethod = ADMIN_METHODS.get(command);
  if (adminMethod !== undefined) return { method: adminMethod, admin: true };
  const sdkMethod = SDK_METHODS.get(command);
  if (sdkMethod !== undefined) return { method: sdkMethod, admin: false };
  return undefined;
}

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
  const spec = COMMANDS.get(commandKey);
  const target = methodFor(commandKey);
  if (spec === undefined || target === undefined) {
    const known = [...COMMANDS.keys()];
    const message = `unknown command "${commandKey}"; expected "<group> <operation>" from: ${known.join(", ")}`;
    emit(io, args.json, { ok: false, error: { code: "VALIDATION_FAILED", message } }, true);
    if (!args.json) io.stderr(`${USAGE}\n`);
    return { exitCode: 2 };
  }

  const input = spec.buildInput(args.positional.slice(2));
  const root = args.root ?? ".";

  try {
    let data: unknown;
    if (target.admin) {
      const admin = WorkspaceAdmin.open({ root });
      try {
        const handler = (admin as unknown as Record<string, ((input: unknown) => unknown) | undefined>)[
          target.method
        ];
        if (typeof handler !== "function") {
          emit(
            io,
            args.json,
            {
              ok: false,
              error: { code: "INTERNAL", message: `command ${commandKey} is wired to a missing admin method` },
            },
            true,
          );
          return { exitCode: 1 };
        }
        data = handler.call(admin, input);
      } finally {
        admin.close();
      }
    } else {
      const coordinator = Coordinator.open({ root });
      try {
        const handler = (coordinator as unknown as Record<string, (input: unknown) => Promise<unknown>>)[
          target.method
        ];
        if (typeof handler !== "function") {
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
        data = await handler.call(coordinator, input);
      } finally {
        coordinator.close();
      }
    }
    emit(io, args.json, { ok: true, data }, false);
    return { exitCode: 0 };
  } catch (error) {
    emit(io, args.json, toErrorEnvelope(error), true);
    return { exitCode: 1 };
  }
}
