import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { Server as NetServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { RoleDockError } from "@roledock/protocol";

/**
 * Managed sandbox execution for the reference connector (ADR-0012,
 * docs/zcode-connector-tools.md §4.5; delivered by P5-H increment B5-1).
 *
 * Topology: the ZCode app-server child runs inside a bubblewrap sandbox with
 * its own user/pid/net/ipc/uts namespaces (fail-closed: no runner, no spawn).
 * Egress whitelist without slirp/iptables: whitelisted `host:port` entries are
 * pinned to fake loopback IPs (127.0.0.2+) via a generated /etc/hosts; an
 * in-sandbox relay accepts those TCP connections and forwards them over a
 * Unix socket (bind-mounted) to a host-side forwarder that validates the
 * target against the allowlist and pipes raw bytes — TLS stays end-to-end.
 * Everything else fails structurally: lo-only netns, no routes, no DNS.
 *
 * Credentials stay outside: env is cleared (--clearenv) and rebuilt from an
 * explicit allowlist; no home/credential files are ever bound in. Model API
 * headers still arrive over the connector's stdio RPC (B3 mechanism).
 * Sandbox boundary evidence (env key names, mountinfo) is written by the
 * in-sandbox supervisor into `<workspace>/.roledock/sandbox-evidence/`.
 */

export interface SandboxRunnerInfo {
  available: boolean;
  runner: "bubblewrap";
  version?: string;
  reason?: string;
}

const exec = (file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    execFile(file, [...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      const rawCode = (error as NodeJS.ErrnoException | null)?.code;
      const code = error ? (typeof rawCode === "number" ? rawCode : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Probe the local sandbox runner. Missing or failing → unavailable; managed
 * mode must then refuse (NOT_IMPLEMENTED), never degrade to unsandboxed.
 * ROLEDOCK_SANDBOX_PROBE=unavailable forces the stricter answer for tests and
 * diagnostics; it never forces an "available" answer.
 */
export async function probeSandboxRunner(deps: { exec?: typeof exec } = {}): Promise<SandboxRunnerInfo> {
  const run = deps.exec ?? exec;
  if (process.env.ROLEDOCK_SANDBOX_PROBE === "unavailable") {
    return { available: false, runner: "bubblewrap", reason: "ROLEDOCK_SANDBOX_PROBE=unavailable (diagnostic override)" };
  }
  const version = await run("bwrap", ["--version"]);
  if (version.code !== 0) return { available: false, runner: "bubblewrap", reason: `bwrap --version failed: ${version.stderr.trim() || "not found"}` };
  // Functional dry run with the exact namespace set the managed launch uses.
  const dry = await run("bwrap", ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--cap-add", "CAP_NET_BIND_SERVICE", "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "/bin/true"]);
  if (dry.code !== 0) return { available: false, runner: "bubblewrap", version: version.stdout.trim(), reason: `bwrap functional probe failed: ${dry.stderr.trim().slice(0, 300)}` };
  return { available: true, runner: "bubblewrap", version: version.stdout.trim() };
}

export interface EgressEntry { host: string; port: number; fakeIp: string }
export interface EgressPlan { entries: readonly EgressEntry[]; hostsFile: string }

/** Map whitelisted `host[:port]` entries to fake loopback IPs and a hosts file (pure). */
export function planEgress(egress: readonly string[]): EgressPlan {
  const entries: EgressEntry[] = [];
  for (const raw of egress) {
    const value = raw.trim();
    if (!/^[\w.-]+(:\d{1,5})?$/.test(value) || /^[\d.]+$/.test(value.split(":")[0] ?? "")) {
      throw new RoleDockError("VALIDATION_FAILED", `Invalid --sandbox-egress entry ${JSON.stringify(raw)}: expected host[:port]; raw IPs and IPv6 literals are not supported (pinning is by name).`);
    }
    const [host, portText] = value.split(":");
    const port = portText === undefined || portText === "" ? 443 : Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new RoleDockError("VALIDATION_FAILED", `Invalid --sandbox-egress entry ${JSON.stringify(raw)}.`);
    if (entries.some(entry => entry.host === host && entry.port === port)) continue;
    if (entries.length >= 253) throw new RoleDockError("VALIDATION_FAILED", "Too many --sandbox-egress entries (loopback mapping limit 253).");
    entries.push({ host, port, fakeIp: `127.0.0.${entries.length + 2}` });
  }
  const hostsFile = entries.map(entry => `${entry.fakeIp} ${entry.host}`).join("\n") + (entries.length ? "\n" : "");
  return { entries, hostsFile };
}

export interface SandboxLaunchConfig {
  /** Connector process cwd — the single workspace root bound read-write. */
  workspaceRoot: string;
  cliPath: string;
  nodeBin: string;
  providerBuiltinConfig?: string;
  providerPersonalConfig?: string;
  /** Per-spawn host directory holding supervisor/relay scripts, hosts and config. */
  runtimeDir: string;
  /** In-sandbox evidence sink, under the rw-bound workspace. */
  evidenceDir: string;
  homeDir: string;
  egressSocketPath: string;
  relay: readonly { fakeIp: string; port: number; upstreamHost: string; upstreamPort: number }[];
  /** Extra allowlisted env entries for the payload (explicit, never process.env). */
  extraEnv?: Readonly<Record<string, string>>;
}

/** Build the bubblewrap argv (pure; files must already exist). Exported for unit tests. */
export function buildBwrapArgs(config: SandboxLaunchConfig): string[] {
  const nodeBinDir = dirname(config.nodeBin);
  // bwrap applies mounts in argument order and later mounts shadow earlier
  // ones on the same subtree, so parents must precede children: the readonly
  // root tmpfs first, then tmpfs /tmp, the runtimeDir bind under it, and its
  // own tmpfs-mounted home.
  const args: string[] = [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    // Least privilege: only what binding the pinned loopback ports requires
    // (CAP_NET_BIND_SERVICE against the sandbox-owned netns).
    "--cap-add", "CAP_NET_BIND_SERVICE",
    "--die-with-parent", "--new-session",
    "--tmpfs", "/",
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--ro-bind", config.runtimeDir, config.runtimeDir,
    "--tmpfs", config.homeDir,
    // NOTE: bwrap's `--dev /dev` (tmpfs devtree) makes privileged-port binds
    // fail with EACCES on this kernel regardless of capabilities; the per-node
    // device binds below give the runtime what it needs without that quirk.
    "--ro-bind", "/usr", "/usr",
    "--dev-bind", "/dev/null", "/dev/null",
    "--dev-bind", "/dev/zero", "/dev/zero",
    "--dev-bind", "/dev/random", "/dev/random",
    "--dev-bind", "/dev/urandom", "/dev/urandom",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--ro-bind", join(config.runtimeDir, "hosts"), "/etc/hosts",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/passwd", "/etc/passwd",
    "--ro-bind-try", "/etc/group", "/etc/group",
    "--ro-bind-try", "/etc/machine-id", "/etc/machine-id",
    "--ro-bind", config.cliPath, config.cliPath,
  ];
  for (const providerConfig of [config.providerPersonalConfig, config.providerBuiltinConfig]) {
    if (providerConfig) args.push("--ro-bind", providerConfig, providerConfig);
  }
  args.push(
    "--ro-bind", nodeBinDir, nodeBinDir,
    "--bind", config.workspaceRoot, config.workspaceRoot,
    // B5-3: the content-addressed material whitelist is read-only inside the
    // sandbox (load turns only read; the adapter writes host-side). Shadows
    // the rw workspace bind for this subtree; skipped when not created yet.
    "--ro-bind-try", join(config.workspaceRoot, ".roledock/anchor-materials"), join(config.workspaceRoot, ".roledock/anchor-materials"),
    // Root goes read-only last (after every mount into it): anything outside
    // the whitelist above fails with EROFS; submounts keep their own flags.
    "--remount-ro", "/",
    "--clearenv",
    "--setenv", "PATH", `${nodeBinDir}:/usr/bin:/bin`,
    "--setenv", "HOME", config.homeDir,
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "XDG_CACHE_HOME", join(config.homeDir, ".cache"),
    "--setenv", "XDG_CONFIG_HOME", join(config.homeDir, ".config"),
    "--setenv", "XDG_DATA_HOME", join(config.homeDir, ".local/share"),
  );
  if (config.providerBuiltinConfig) args.push("--setenv", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", config.providerBuiltinConfig);
  if (config.providerPersonalConfig) args.push("--setenv", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", config.providerPersonalConfig);
  for (const [name, value] of Object.entries(config.extraEnv ?? {})) args.push("--setenv", name, value);
  args.push(config.nodeBin, join(config.runtimeDir, "supervisor.mjs"), join(config.runtimeDir, "sandbox-config.json"));
  return args;
}

export const RELAY_SOURCE = `#!/usr/bin/env node
// In-sandbox egress relay (roledock managed mode). Listens on the fake loopback
// IPs from the sandbox config and pipes each accepted TCP connection over the
// bind-mounted Unix socket to the host-side forwarder, prefixed with the
// mapped upstream host:port. Targets are fixed by the mapping; the forwarder
// re-validates against the allowlist.
import { connect, createServer } from "node:net";
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
let pending = config.relay.length;
if (pending === 0) process.stdout.write("RELAY-READY\\n");
for (const entry of config.relay) {
  const server = createServer(socket => {
    const upstream = connect(config.egressSocketPath, () => {
      upstream.write("ROLEDOCK-EGRESS " + entry.upstreamHost + ":" + entry.upstreamPort + "\\n");
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const fail = () => { socket.destroy(); upstream.destroy(); };
    upstream.on("error", fail);
    socket.on("error", fail);
  });
  server.listen(entry.port, entry.fakeIp, () => {
    pending -= 1;
    if (pending === 0) process.stdout.write("RELAY-READY\\n");
  });
  server.on("error", error => {
    process.stderr.write("relay-listen-failed " + entry.fakeIp + ":" + entry.port + " " + error.message + "\\n");
    process.exit(3);
  });
}
`;

export const SUPERVISOR_SOURCE = `#!/usr/bin/env node
// In-sandbox pidns init (roledock managed mode). bubblewrap auto-configures
// loopback in the new netns. Records boundary evidence (env key names,
// mountinfo), starts the relay, then runs the app-server as the only other
// workload. Its exit tears the pidns down together with every contained
// process.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const note = text => appendFileSync(config.evidenceDir + "/supervisor.log", text + "\\n");
writeFileSync(config.evidenceDir + "/env-keys.json", JSON.stringify(Object.keys(process.env).sort()));
const mounts = spawnSync("cat", ["/proc/self/mountinfo"], { encoding: "utf8" });
writeFileSync(config.evidenceDir + "/mounts.txt", mounts.stdout ?? "");
note("loopback-" + ((spawnSync("cat", ["/proc/net/dev"], { encoding: "utf8" }).stdout ?? "").includes("lo:") ? "present" : "missing"));
const relay = spawn(config.nodeBin, [config.runtimeDir + "/relay.mjs", process.argv[2]], { stdio: ["ignore", "pipe", "inherit"] });
let relayReady = false;
relay.stdout.on("data", chunk => {
  if (String(chunk).includes("RELAY-READY")) { relayReady = true; note("relay-ready"); }
});
relay.on("exit", code => {
  if (!relayReady) { note("relay-died-before-ready code=" + code); try { app.kill("SIGTERM"); } catch {} }
});
const app = spawn(config.nodeBin, [config.cliPath, "app-server"], { stdio: "inherit", env: process.env });
note("app-server-start pid=" + app.pid);
const shutdown = () => { try { app.kill("SIGTERM"); } catch {} try { relay.kill("SIGTERM"); } catch {} process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
app.on("exit", (code, signal) => {
  note("app-server-exit code=" + code + " signal=" + signal);
  try { relay.kill("SIGTERM"); } catch {}
  process.exit(code === null ? 1 : code);
});
`;

/** Host-side forwarder: validates ROLEDOCK-EGRESS targets against the allowlist, then pipes raw bytes. */
export class EgressForwarder {
  readonly #allow: ReadonlySet<string>;
  readonly #socketPath: string;
  #server: NetServer | undefined;
  #connections = 0;
  #rejected = 0;

  constructor(socketPath: string, allow: readonly { host: string; port: number }[]) {
    this.#socketPath = socketPath;
    this.#allow = new Set(allow.map(entry => `${entry.host}:${entry.port}`));
  }

  start(): Promise<void> {
    const server = createServer(socket => {
      this.#connections += 1;
      // Per-connection trace (diagnostics + escape-test evidence): every
      // egress connection attempt through the whitelist chain, host-side view.
      const log = (line: string): void => { try { appendFileSync(`${this.#socketPath}.log`, `${new Date().toISOString()} ${line}\n`); } catch { /* diagnostics only */ } };
      log(`connection #${this.#connections}`);
      let upstreamBytes = 0, downstreamBytes = 0;
      // Header framing is BYTE-ONLY: the payload after the header line is raw
      // TLS; any string round-trip (UTF-8) corrupts it (B5-3 finding — the
      // provider answered decode_error alerts on string-mangled handshakes).
      const buffer: Buffer[] = [];
      let bufferedBytes = 0;
      let headerDone = false;
      const fail = () => { this.#rejected += 1; log("rejected (non-whitelisted target)"); socket.destroy(); };
      socket.on("error", fail);
      socket.on("data", chunk => {
        if (headerDone) return;
        buffer.push(chunk); bufferedBytes += chunk.length;
        const combined = Buffer.concat(buffer);
        const newline = combined.indexOf("\n");
        if (newline === -1) {
          if (bufferedBytes > 4096) { headerDone = true; fail(); }
          return;
        }
        headerDone = true;
        const header = combined.subarray(0, newline).toString("utf8");
        const target = header.startsWith("ROLEDOCK-EGRESS ") ? header.slice("ROLEDOCK-EGRESS ".length).trim() : "";
        if (!this.#allow.has(target)) return fail();
        const [host, portText] = target.split(":");
        const upstream = createConnection({ host, port: Number(portText) });
        upstream.on("error", fail);
        const firstBytes = combined.subarray(newline + 1, newline + 17).toString("hex");
        log(`target=${target} payload_bytes=${combined.length - newline - 1} first16=${firstBytes}`);
        upstream.on("data", data => { downstreamBytes += data.length; });
        if (combined.length > newline + 1) upstream.write(combined.subarray(newline + 1));
        socket.on("data", data => { upstreamBytes += data.length; });
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.on("close", () => log(`close up=${upstreamBytes} down=${downstreamBytes}`));
      });
    });
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#socketPath, () => resolve());
    });
  }

  get stats(): { connections: number; rejected: number } {
    return { connections: this.#connections, rejected: this.#rejected };
  }

  stop(): void {
    this.#server?.close();
  }
}

export interface SandboxLaunch {
  command: string;
  args: string[];
  runtimeDir: string;
  forwarder: EgressForwarder;
  stop: () => void;
}

/**
 * Materialize one managed launch: runtime dir with scripts/hosts/config, the
 * host forwarder, and the bwrap argv. The caller owns the process lifecycle.
 */
export async function createSandboxLaunch(options: {
  workspaceRoot: string;
  cliPath: string;
  nodeBin: string;
  egress: readonly string[];
  providerBuiltinConfig?: string;
  providerPersonalConfig?: string;
  evidenceDir: string;
  extraEnv?: Readonly<Record<string, string>>;
  runner?: SandboxRunnerInfo;
}): Promise<SandboxLaunch> {
  const runner = options.runner ?? await probeSandboxRunner();
  if (!runner.available) {
    throw new RoleDockError("NOT_IMPLEMENTED", `Managed sandbox execution is unavailable on this machine (${runner.reason ?? "no sandbox runner"}); refusing to run without the sandbox boundary (fail-closed).`);
  }
  for (const [name, value] of [["workspaceRoot", options.workspaceRoot], ["cliPath", options.cliPath], ["nodeBin", options.nodeBin]] as const) {
    if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value)) throw new RoleDockError("VALIDATION_FAILED", `Sandbox launch ${name} must be an existing absolute path.`);
  }
  const egress = planEgress(options.egress);
  const runtimeDir = mkdtempSync(join(tmpdir(), "roledock-sandbox-"));
  const homeDir = join(runtimeDir, "home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(options.evidenceDir, { recursive: true });
  writeFileSync(join(runtimeDir, "hosts"), egress.hostsFile);
  writeFileSync(join(runtimeDir, "supervisor.mjs"), SUPERVISOR_SOURCE);
  writeFileSync(join(runtimeDir, "relay.mjs"), RELAY_SOURCE);
  const egressSocketPath = join(runtimeDir, "egress.sock");
  const forwarder = new EgressForwarder(egressSocketPath, egress.entries);
  await forwarder.start();
  const config: SandboxLaunchConfig = {
    workspaceRoot: options.workspaceRoot,
    cliPath: options.cliPath,
    nodeBin: options.nodeBin,
    providerBuiltinConfig: options.providerBuiltinConfig,
    providerPersonalConfig: options.providerPersonalConfig,
    runtimeDir,
    evidenceDir: options.evidenceDir,
    homeDir,
    egressSocketPath,
    relay: egress.entries.map(entry => ({ fakeIp: entry.fakeIp, port: entry.port, upstreamHost: entry.host, upstreamPort: entry.port })),
    extraEnv: { ROLEDOCK_EGRESS_SOCK: egressSocketPath, ...options.extraEnv },
  };
  writeFileSync(join(runtimeDir, "sandbox-config.json"), JSON.stringify(config));
  return { command: "bwrap", args: buildBwrapArgs(config), runtimeDir, forwarder, stop: () => forwarder.stop() };
}

/** Managed-mode spawn used by AppServerClient.start(); parent env never reaches the sandbox. */
export function spawnSandboxed(launch: SandboxLaunch): ChildProcess {
  return spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
}
