import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Coordinator, ExternalSessionAuthority, WorkspaceAdmin } from "@roledock/core";
import type { HarnessAdapter } from "@roledock/core";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { ProcessBridgeAdapter } from "@roledock/adapter-process-bridge";
import { RoleDockError, toErrorEnvelope } from "@roledock/protocol";
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
  roledock [--json] [--root <dir>] [--adapter mock|bridge] [--session <id>]
           <group> <operation> [args...]

Workspace selection: --root <dir> sets the workspace root (default: current
directory). State lives under <root>/.roledock/.

Host adapter (--adapter): "mock" (default) proves state mechanics in memory;
"bridge" runs a real fixture-host subprocess per operation (process-bridge
layer, docs/adapter-guide.md). Neither is a real model host.

Workspace and roles:
  roles install <pack-dir>               install a local role pack
  roles list                             list installed roles and capability state
  roles resolve <role-id>                show one role (uninitialized roles are explicit)
  admin policy                           owner view: requested vs granted capabilities
  admin grant <role> <cap>               owner entry: grant a capability to a role
  admin revoke <role> <cap>              owner entry: revoke a capability
  admin inbox [role]                     owner diagnostic: request inbox entries
  admin events                           owner diagnostic: pending-delivery event log
  admin submit-human-event <ext-session> <host-session> <subject> <event-ref>
         <actor> <role> <caps.csv> <initialize|takeover> <expires-at>
                                         owner trusted-entry write (ADR-0011): record
                                         a verbatim human confirmation (entry
                                         cli-console); storage alone grants nothing

Documents and knowledge:
  documents list [role]                  documents visible to the calling session
  documents read <role> <key> [rev]      read a document revision (records a receipt)
  documents propose <role> <key> <file>  propose a candidate update from a file
  documents publish <key> <file> <rev> <gen> [candidate-id]
                                         publish as the session's role (CAS checks)
  knowledge export [share|workspace] [role]
                                         export a knowledge bundle (owner-level)
  knowledge import <bundle-dir>          import a bundle as candidate updates

Sessions, handoffs, requests:
  sessions open <role-id> [latest]       open a primary session (first initializes;
                                         later opens run the handoff, inherit=latest)
  sessions resume <session-id>           resume via the adapter's native capability
  handoffs prepare [--session id]        freeze a bootstrap bundle (primary session)
  handoffs activate <bundle-id>          provision + CAS-activate a prepared bundle
  requests create <target-role> <question-file> <idempotency-key> [deadline]
  requests get <request-id>
  requests reply <request-id> <reply-file>
  requests cancel <request-id>
  artifacts read <artifact-id>           read a request result artifact

Session identity: session-bound operations require --session <id>. Sessions
are created by sessions.open (or the test-only SDK fixture); the CLI itself
does not mint them.

Every SDK operation specified by protocol 0.1 is wired. Requests carry
budgets (max_turns / max_output_bytes / deadline) and are executed by the
coordinator's adapter as isolated consultation branches.

Output is human-readable by default; pass --json for machine-readable
envelopes ({ok:true,...} or {ok:false,error:{code,...}}) that another agent
can parse verbatim. Exit codes: 0 success, 1 operational error, 2 usage error.`;

interface ParsedArgs {
  json: boolean;
  help: boolean;
  version: boolean;
  root?: string;
  session?: string;
  adapter?: string;
  adoptArtifact?: string;
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
      case "--session": {
        const value = argv[i + 1];
        if (value === undefined) return undefined;
        parsed.session = value;
        i++;
        break;
      }
      case "--adapter": {
        const value = argv[i + 1];
        if (value === undefined) return undefined;
        parsed.adapter = value;
        i++;
        break;
      }
      case "--adopt-artifact": {
        const value = argv[i + 1];
        if (value === undefined) return undefined;
        parsed.adoptArtifact = value;
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
  /**
   * Maps parsed positional args to the operation input object. Session-bound
   * commands receive the --session value (or throw) via the context; the
   * --adopt-artifact value rides along for documents.publish.
   */
  readonly buildInput: (
    positional: readonly string[],
    context: { session?: string; adoptArtifact?: string },
  ) => Record<string, unknown>;
}

function requireSession(context: { session?: string }): string {
  if (context.session === undefined) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      "documents.* operations require a trusted session: pass --session <id>.",
    );
  }
  return context.session;
}

/** "group operation" -> SDK/admin operation spec. */
const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["roles install", { args: ["source_path"], buildInput: namedArgs(["source_path"]) }],
  ["roles list", { buildInput: () => ({}) }],
  ["roles resolve", { args: ["role_id"], buildInput: namedArgs(["role_id"]) }],
  ["admin policy", { buildInput: () => ({}) }],
  ["admin grant", { args: ["role_id", "capability"], buildInput: namedArgs(["role_id", "capability"]) }],
  ["admin revoke", { args: ["role_id", "capability"], buildInput: namedArgs(["role_id", "capability"]) }],
  ["admin inbox", { buildInput: (p: readonly string[]) => (p.length > 0 ? { owner_role_id: p[0] } : {}) }],
  ["admin events", { buildInput: () => ({}) }],
  [
    "admin submit-human-event",
    {
      buildInput: (p: readonly string[]) => {
        if (p.length !== 9) throw new RoleDockError("VALIDATION_FAILED", "admin submit-human-event takes 9 arguments: <ext-session> <host-session> <subject> <event-ref> <actor> <role> <caps.csv> <initialize|takeover> <expires-at>.");
        const caps = p[6]!.split(",").map(item => item.trim()).filter(item => item.length > 0);
        return { external_session_id: p[0], host_session_id: p[1], connection_subject: p[2], event_ref: p[3], actor_id: p[4], role_id: p[5], capabilities: caps, inherit: p[7], expires_at: p[8], entry: "cli-console", recorded_at: new Date().toISOString() };
      },
    },
  ],
  ["documents list", { buildInput: (p: readonly string[], ctx: { session?: string }) => (p.length > 0 ? { session_id: requireSession(ctx), role_id: p[0] } : { session_id: requireSession(ctx) }) }],
  [
    "documents read",
    {
      buildInput: (p: readonly string[], ctx: { session?: string }) => {
        const input: Record<string, unknown> = {
          session_id: requireSession(ctx),
          target_role_id: requirePositional(p, 0, "target role id"),
          document_key: requirePositional(p, 1, "document key"),
        };
        const revision = p[2];
        if (revision !== undefined) {
          const parsedRevision = Number.parseInt(revision, 10);
          if (Number.isNaN(parsedRevision)) {
            throw new RoleDockError("VALIDATION_FAILED", `Revision must be an integer, got "${revision}".`);
          }
          input.revision = parsedRevision;
        }
        return input;
      },
    },
  ],
  [
    "documents propose",
    {
      buildInput: (p: readonly string[], ctx: { session?: string }) => ({
        session_id: requireSession(ctx),
        target_role_id: requirePositional(p, 0, "target role id"),
        document_key: requirePositional(p, 1, "document key"),
        body: readBodyFile(requirePositional(p, 2, "body file")),
      }),
    },
  ],
  [
    "documents publish",
    {
      buildInput: (p: readonly string[], ctx: { session?: string; adoptArtifact?: string }) => {
        const input: Record<string, unknown> = {
          session_id: requireSession(ctx),
          document_key: requirePositional(p, 0, "document key"),
          body: readBodyFile(requirePositional(p, 1, "body file")),
          expected_revision: parseInteger(requirePositional(p, 2, "expected revision")),
          expected_generation: parseInteger(requirePositional(p, 3, "expected generation")),
        };
        const candidateId = p[4];
        if (candidateId !== undefined) input.candidate_id = candidateId;
        if (ctx.adoptArtifact !== undefined) {
          if (candidateId !== undefined) {
            throw new RoleDockError(
              "VALIDATION_FAILED",
              "Pass either a candidate-id positional or --adopt-artifact, not both.",
            );
          }
          input.adopt_artifact_id = ctx.adoptArtifact;
        }
        return input;
      },
    },
  ],
  [
    "knowledge export",
    {
      buildInput: (p: readonly string[]) => {
        const input: Record<string, unknown> = {};
        const scope = p[0];
        if (scope !== undefined) {
          if (scope !== "share" && scope !== "workspace") {
            throw new RoleDockError("VALIDATION_FAILED", 'Scope must be "share" or "workspace".');
          }
          input.scope = scope;
        }
        const role = p[1];
        if (role !== undefined) input.role_id = role;
        return input;
      },
    },
  ],
  ["knowledge import", { buildInput: (p: readonly string[]) => ({ bundle_dir: requirePositional(p, 0, "bundle directory") }) }],
  // Specified operations without an implementation yet: input is not consumed.
  ["sessions open", { buildInput: (p: readonly string[]) => ({ role_id: requirePositional(p, 0, "role id"), ...(p[1] !== undefined ? { inherit: p[1] } : { inherit: "latest" }) }) }],
  ["sessions resume", { buildInput: (p: readonly string[]) => ({ session_id: requirePositional(p, 0, "session id") }) }],
  ["handoffs prepare", { buildInput: (p: readonly string[], ctx: { session?: string }) => ({ session_id: requireSession(ctx), ...(p[0] !== undefined ? { role_id: p[0] } : {}) }) }],
  ["handoffs activate", { buildInput: (p: readonly string[]) => ({ bundle_id: requirePositional(p, 0, "bundle id") }) }],
  [
    "requests create",
    {
      buildInput: (p: readonly string[], ctx: { session?: string }) => {
        const input: Record<string, unknown> = {
          session_id: requireSession(ctx),
          target_role_id: requirePositional(p, 0, "target role id"),
          question: readBodyFile(requirePositional(p, 1, "question file")),
          idempotency_key: requirePositional(p, 2, "idempotency key"),
        };
        const deadline = p[3];
        if (deadline !== undefined) input.budget = { deadline };
        return input;
      },
    },
  ],
  ["requests get", { buildInput: (p: readonly string[], ctx: { session?: string }) => ({ session_id: requireSession(ctx), request_id: requirePositional(p, 0, "request id") }) }],
  [
    "requests reply",
    {
      buildInput: (p: readonly string[], ctx: { session?: string }) => ({
        session_id: requireSession(ctx),
        request_id: requirePositional(p, 0, "request id"),
        body: readBodyFile(requirePositional(p, 1, "reply file")),
      }),
    },
  ],
  ["requests cancel", { buildInput: (p: readonly string[], ctx: { session?: string }) => ({ session_id: requireSession(ctx), request_id: requirePositional(p, 0, "request id") }) }],
  ["artifacts read", { buildInput: (p: readonly string[], ctx: { session?: string }) => ({ session_id: requireSession(ctx), artifact_id: requirePositional(p, 0, "artifact id") }) }],
]);

function requirePositional(args: readonly string[], index: number, what: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new RoleDockError("VALIDATION_FAILED", `Missing required argument: ${what}.`);
  }
  return value;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new RoleDockError("VALIDATION_FAILED", `Expected an integer, got "${value}".`);
  }
  return parsed;
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new RoleDockError("VALIDATION_FAILED", `Cannot read body file "${path}": ${(error as Error).message}`);
  }
}

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
  /** B2: runs on the ExternalSessionAuthority over an opened coordinator. */
  readonly authority?: boolean;
}

const ADMIN_METHODS: ReadonlyMap<string, string> = new Map([
  ["admin policy", "showPolicy"],
  ["admin grant", "grant"],
  ["admin revoke", "revoke"],
  ["admin inbox", "showInbox"],
  ["admin events", "showEvents"],
]);

const AUTHORITY_METHODS: ReadonlyMap<string, string> = new Map([
  ["admin submit-human-event", "submitHumanEvent"],
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
  const authorityMethod = AUTHORITY_METHODS.get(command);
  if (authorityMethod !== undefined) return { method: authorityMethod, admin: true, authority: true };
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

  let input: Record<string, unknown>;
  try {
    input = spec.buildInput(args.positional.slice(2), {
      session: args.session,
      adoptArtifact: args.adoptArtifact,
    });
  } catch (error) {
    emit(io, args.json, toErrorEnvelope(error), true);
    return { exitCode: 1 };
  }
  const root = args.root ?? ".";

  let adapter: HarnessAdapter | undefined;
  if (args.adapter !== undefined && args.adapter !== "mock") {
    if (args.adapter !== "bridge") {
      emit(
        io,
        args.json,
        {
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: `Unknown adapter "${args.adapter}"; --adapter accepts "mock" (default) or "bridge".`,
          },
        },
        true,
      );
      return { exitCode: 2 };
    }
    adapter = new ProcessBridgeAdapter({ stateDir: join(root, ".roledock", "host-sessions") });
  }

  try {
    let data: unknown;
    if (target.authority === true) {
      // ADR-0011 trusted-entry face: the authority is constructed over the same
      // coordinator/adapter pair; submit itself never touches the host.
      const authorityAdapter = adapter ?? new MockHarnessAdapter();
      const coordinator = Coordinator.open({ root, adapter: authorityAdapter });
      try {
        data = new ExternalSessionAuthority(coordinator, authorityAdapter).submitHumanEvent(input);
      } finally {
        coordinator.close();
      }
    } else if (target.admin) {
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
      const coordinator = Coordinator.open({ root, adapter: adapter ?? new MockHarnessAdapter() });
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
