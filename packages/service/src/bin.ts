#!/usr/bin/env node
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, rmSync, openSync, closeSync, fchmodSync, constants, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { MockHarnessAdapter } from "@roledock/adapter-mock";
import { ZCodeAdapter, connectZCodeConnector } from "@roledock/adapter-zcode";
import type { HarnessAdapter, HumanAuthorizationSource } from "@roledock/core";
import { WorkspaceService } from "./index.js";

/**
 * G3: fixture attester mirroring the reference adapter's B2 behavior — when
 * its own fixture map has no event, read the owner-written store source so
 * the product chain (GUI confirm → bridge recordHuman → MCP anchor) runs on
 * the mock workspace. The bare MockHarnessAdapter elsewhere keeps its
 * strict fixture-only attestation semantics.
 */
class AttestingMockAdapter extends MockHarnessAdapter {
  #source: HumanAuthorizationSource | undefined;
  useHumanAuthorizationSource(source: HumanAuthorizationSource): void { this.#source = source; }
  override async readHumanAuthorization(hostSessionId: string, eventRef: string) {
    const own = await super.readHumanAuthorization(hostSessionId, eventRef);
    if (own) return own;
    const record = await this.#source?.readEvent(hostSessionId, eventRef);
    return record
      ? { workspace_id: record.workspace_id, host_session_id: record.host_session_id, connection_subject: record.connection_subject, event_ref: record.event_ref, actor_id: record.actor_id, role_id: record.role_id, capabilities: [...record.capabilities], inherit: record.inherit, expires_at: record.expires_at }
      : null;
  }
}

/** Launcher configuration written by the desktop shell (0600, non-sensitive:
 * paths and identifiers only — credentials stay with the credential helper). */
interface ZcodeLauncherConfig {
  kind: "zcode";
  cliPath: string;
  connectorPath: string;
  credentialHelper?: string;
  provider?: string;
  model?: string;
  managed?: { egress: string[] };
  journalPath?: string;
}

const USAGE = "Usage: roledock-service --mock-workspace <root> | --workspace-config <config.json> <root>";

function requireAbsolute(value: string, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${field} must be an absolute path.`);
  return value;
}

/** Real ZCode launcher: connector handshake (lazy app-server, zero sessions,
 * zero model turns) → adapter construction → shared WorkspaceService.start.
 * The connector runs in its own process group and is disconnected on stop. */
async function startZcode(root: string, configPath: string): Promise<{ adapter: HarnessAdapter; shutdown: () => Promise<void> }> {
  const raw = JSON.parse(readFileSync(resolve(configPath), "utf8")) as ZcodeLauncherConfig;
  if (raw.kind !== "zcode") throw new Error(`Unsupported launcher kind "${String(raw.kind)}".`);
  const cliPath = requireAbsolute(raw.cliPath, "cliPath");
  const connectorPath = requireAbsolute(raw.connectorPath, "connectorPath");
  const connectorArgs = [connectorPath, "--cli", cliPath];
  if (raw.credentialHelper) connectorArgs.push("--credential-helper", requireAbsolute(raw.credentialHelper, "credentialHelper"));
  if (raw.provider) connectorArgs.push("--provider", raw.provider);
  if (raw.model) connectorArgs.push("--model", raw.model);
  const journalPath = raw.journalPath ? requireAbsolute(raw.journalPath, "journalPath") : join(root, ".roledock", "zcode-connector.sqlite");
  connectorArgs.push("--journal", journalPath);
  if (raw.managed?.egress?.length) {
    connectorArgs.push("--sandbox");
    for (const entry of raw.managed.egress) connectorArgs.push("--sandbox-egress", entry);
  }
  const tools = await connectZCodeConnector({ command: process.execPath, args: connectorArgs, cwd: root });
  const adapter = new ZCodeAdapter({
    tools,
    workspacePath: root,
    stateDir: join(root, ".roledock", "zcode-adapter"),
    managed: raw.managed?.egress?.length ? { egress: raw.managed.egress } : undefined,
  });
  return {
    adapter,
    shutdown: async () => {
      try { adapter.closeJournal(); } catch { /* already closed */ }
      await tools.disconnect().catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let root: string;
  let adapter: HarnessAdapter;
  let shutdown: () => Promise<void>;
  if (args.length === 2 && args[0] === "--mock-workspace") {
    root = resolve(args[1]!);
    const mock = new AttestingMockAdapter();
    mock.seedExternalSession("mock-existing-conversation", "mock-fixture-subject");
    // G3: a second fixture matching the desktop bridge subject lets the shell
    // E2E exercise the full product registration path (discover → register →
    // bridge recordHuman → MCP anchor) without a real host.
    mock.seedExternalSession("mock-desktop-original", "desktop-event-bridge");
    // G6: a second bridge-subject fixture lets the shell E2E anchor both the
    // initiating and the target role primaries without a real host.
    mock.seedExternalSession("mock-desktop-second", "desktop-event-bridge");
    adapter = mock;
    shutdown = async () => undefined;
  } else if (args.length === 3 && args[0] === "--workspace-config") {
    root = resolve(args[2]!);
    ({ adapter, shutdown } = await startZcode(root, args[1]!));
  } else {
    console.error(`${USAGE} (the --workspace-config mode launches a real configured adapter; mock is diagnostics only)`);
    process.exitCode = 2;
    return;
  }
  const endpoint = join(root, ".roledock", "owner-connection.json");
  let service: WorkspaceService | undefined;
  try {
    service = await WorkspaceService.start({ root, adapter, socketPath: join(root, ".roledock", "service.sock") });
    // Owner bootstrap only. Agent MCP gets a separately issued session credential.
    try {
      const prior = lstatSync(endpoint);
      if (!prior.isFile() || prior.uid !== process.getuid?.()) throw new Error("Owner credential path is not an owned regular file.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const descriptor = openSync(endpoint, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(descriptor, 0o600); writeFileSync(descriptor, JSON.stringify(service.ownerCredential)); } finally { closeSync(descriptor); }
    // Persisted workspace identity (G2-R01): lets launchers bind a directory
    // to the workspace_id WITHOUT touching the locked SQLite writer.
    const idFile = join(root, ".roledock", "workspace-id");
    const idDescriptor = openSync(idFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(idDescriptor, 0o600); writeFileSync(idDescriptor, service.workspaceId); } finally { closeSync(idDescriptor); }
    console.error(`RoleDock service (${adapter.getCapabilities().adapter}): ${service.workspaceId}; owner connection: ${endpoint}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await service!.close();
      rmSync(endpoint, { force: true });
      // The identity file is intentionally KEPT across normal stops (G2-R01
      // re-review): it is the directory's stable workspace record, which
      // launchers must still verify against after the service is gone.
      await shutdown();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    await service?.close();
    await shutdown();
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
