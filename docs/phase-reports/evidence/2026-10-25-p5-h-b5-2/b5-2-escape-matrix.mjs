// B5-2 escape-matrix driver. Launches the escape payload inside the
// production-identical sandbox launch (same buildBwrapArgs as the connector:
// readonly root, namespace set, whitelist topology, forwarder) and computes a
// verdict for every ADAPTER_SANDBOX_PLAN §4 matrix row that can be exercised
// without a model turn (rows 1,2,3,5,6,7). Rows 4 and 8 have dedicated
// scripts. Any row not intercepted ⇒ non-zero exit (REWORK signal).
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
const REPO = "/home/inkem/Personal/RoleDock";
const EVID = `${REPO}/docs/phase-reports/evidence/2026-10-25-p5-h-b5-2`;
const WS = "/tmp/b5-2-matrix-ws";
rmSync(WS, { recursive: true, force: true }); mkdirSync(`${WS}/.roledock/sandbox-evidence`, { recursive: true });
const print = value => process.stdout.write(JSON.stringify(value) + "\n");
const sandboxProcs = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  .split("\n").filter(line => line.includes("bwrap") && line.includes("b5-2-matrix-ws")).map(line => line.trim());

// Host-side baseline: forbidden targets must not exist before the run.
const forbiddenHostPaths = ["/etc/roledock-escape", "/usr/roledock-escape", "/opt/roledock-escape", "/var/roledock-escape", "/etc/ld.so.preload"];
for (const path of forbiddenHostPaths) { if (existsSync(path)) throw new Error(`forbidden host path already exists: ${path}`); }
const credentialsStatBefore = statSync(join(homedir(), ".zcode/v2/credentials.json"));

const HOST_LISTEN_PORT = 45990;
const listener = createServer(socket => socket.end("host-listener-reached"));
await new Promise(resolve => listener.listen(HOST_LISTEN_PORT, "127.0.0.1", resolve));
const hostLanIp = Object.values(networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && !entry.internal)?.address ?? "192.0.2.1";
const baselineSandbox = sandboxProcs();
print({ kind: "baseline", sandboxed_processes: baselineSandbox.length, host_lan_available: hostLanIp !== "192.0.2.1" });

const { createSandboxLaunch } = await import(`${REPO}/adapters/zcode/dist/sandbox.js`);
const evidenceDir = `${WS}/.roledock/sandbox-evidence`;
const launch = await createSandboxLaunch({
  workspaceRoot: WS,
  cliPath: `${EVID}/escape-payload.cjs`,
  nodeBin: process.execPath,
  egress: ["api.z.ai:443", "open.bigmodel.cn:443"],
  evidenceDir,
  extraEnv: { PAYLOAD_OUT: evidenceDir, HOST_LISTEN_PORT: String(HOST_LISTEN_PORT), HOST_LAN_IP: hostLanIp },
});
print({ kind: "sandbox-launched", runtime_dir: launch.runtimeDir });
const child = spawn(launch.command, launch.args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" }, cwd: WS });
let stderrTail = "";
child.stderr.on("data", chunk => { stderrTail = (stderrTail + String(chunk)).slice(-2000); });
const startedAt = Date.now();
const exitCode = await Promise.race([
  new Promise(resolve => child.on("exit", resolve)),
  new Promise(resolve => setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(-1); }, 120_000)),
]);
print({ kind: "payload-exit", exit_code: exitCode, wall_ms: Date.now() - startedAt, stderr_tail: stderrTail.slice(0, 400) });

const results = JSON.parse(readFileSync(`${evidenceDir}/escape-results.json`, "utf8"));
const verdicts = [];
const verdict = (row, attempt, intercepted, detail) => { verdicts.push({ row, attempt, intercepted, detail }); print({ kind: "matrix-verdict", row, attempt, intercepted, detail }); };
const observedOf = (list, name) => list.find(entry => entry.attempt === name)?.observed ?? "(missing)";

// Row 1: writes outside the whitelist must fail (EROFS where the parent dir exists on the
// readonly root, ENOENT where it does not — both are "写失败，无落盘"); whitelisted areas work.
for (const entry of results.row1_writes) {
  const whitelisted = entry.attempt.includes("(whitelisted)");
  if (whitelisted) verdict("1", entry.attempt, entry.observed.startsWith("WRITTEN"), `${entry.observed} (positive control)`);
  else verdict("1", entry.attempt, entry.observed === "failed" && ["EROFS", "ENOENT", "EACCES"].includes(entry.errno), `${entry.observed} errno=${entry.errno}`);
}

// Row 2: owner-private reads must fail; the only readable /proc/1 is the sandbox's own init.
for (const entry of results.row2_reads) {
  if (entry.attempt === "read /proc/1/environ") {
    verdict("2", entry.attempt, !/credential|secret|apikey|token/i.test(entry.observed), `${entry.observed} (pidns init = supervisor, allowlisted env)`);
    continue;
  }
  if (entry.attempt.startsWith("list ")) {
    const noCredentials = !/credentials\.json/.test(entry.observed);
    verdict("2", entry.attempt, noCredentials, entry.observed);
    continue;
  }
  verdict("2", entry.attempt, entry.observed.startsWith("failed"), `${entry.observed} errno=${entry.errno}`);
}

// Row 3: non-whitelisted network must fail structurally; forwarder rejects bypass; whitelisted TLS works.
for (const entry of results.row3_network) {
  if (entry.attempt.startsWith("resolve api.z.ai")) {
    verdict("3", entry.attempt, entry.observed.includes("127.0.0.2"), `${entry.observed} (hosts pin positive control)`);
    continue;
  }
  if (entry.attempt.includes("positive control")) {
    const ok = entry.observed.includes("handshake OK") && entry.observed.includes("authorized=true");
    verdict("3", entry.attempt, ok, entry.observed);
    continue;
  }
  verdict("3", entry.attempt, entry.observed.startsWith("failed") || entry.observed.includes("closed by forwarder"), entry.observed);
}

// Row 5: every spawned level must report the same namespaces; nothing survives teardown.
const levelFiles = readdirSync(evidenceDir).filter(name => name.startsWith("row5-"));
const nsEntries = levelFiles.filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`${evidenceDir}/${name}`, "utf8")));
// N2 (B5-2 review §4-2): namespace strings look like "pid=pid:[402653…] net=net:[…]";
// the old regex `kind=\[…\]` never matched, silently degrading row 5 to an empty pass.
// Parse strictly now: any unparsable entry fails the row explicitly.
const identityOf = ns => {
  if (typeof ns !== "string") return null;
  const parts = ["pid", "net", "user"].map(kind => ns.match(new RegExp(`${kind}=\\w+:\\[[^\\]]+\\]`))?.[0]);
  return parts.every(Boolean) ? parts : null;
};
const identities = nsEntries.map(entry => identityOf(entry.ns));
const namespacesUniform = identities.length >= 3 && identities.every(Boolean) && new Set(identities.map(identity => identity.join("|"))).size === 1;
verdict("5", `nested tree namespaces uniform (${nsEntries.length} levels reported)`, namespacesUniform, identities.map(identity => identity ? identity.join(",") : "(unparsable — verdict false)").join(" | "));
verdict("5", "detached setsid child recorded inside boundary", existsSync(`${evidenceDir}/row5-detached.json`), existsSync(`${evidenceDir}/row5-detached.json`) ? "row5-detached.json present, same pid/net/user identity" : "missing");

// Row 6: plugin/MCP-equivalent child inherits the boundary; global config absent.
const fakeMcpPath = `${evidenceDir}/row6-fake-mcp.json`;
const fakeMcp = existsSync(fakeMcpPath) ? JSON.parse(readFileSync(fakeMcpPath, "utf8")) : null;
verdict("6", "global MCP/plugin config absent from tmpfs HOME", results.row6_plugins_mcp.some(entry => entry.attempt.includes("$HOME/.zcode") && /absent|\(empty\)/.test(entry.observed)), observedOf(results.row6_plugins_mcp, "global MCP/plugin config visibility ($HOME/.zcode)"));
verdict("6", "bound provider-config dir contains no credentials", results.row6_plugins_mcp.some(entry => entry.attempt.includes("literal provider-config") && !/credentials\.json/.test(entry.observed)), observedOf(results.row6_plugins_mcp, "literal provider-config dir contents (ro-bound)"));
if (fakeMcp) {
  verdict("6", "fake MCP write outside", fakeMcp.write === "EROFS", `write=${fakeMcp.write}`);
  verdict("6", "fake MCP read credentials", fakeMcp.read === "ENOENT", `read=${fakeMcp.read}`);
  verdict("6", "fake MCP network to host listener", fakeMcp.net !== "CONNECTED", `net=${fakeMcp.net}`);
} else {
  verdict("6", "fake MCP child results", false, "row6-fake-mcp.json missing");
}

// Row 7: escape primitives and surfaces.
const observed7 = name => observedOf(results.row7_escape_paths, name);
verdict("7", "mount -t tmpfs", observed7("mount -t tmpfs /mnt").includes("exit=32") || observed7("mount -t tmpfs /mnt").includes("EPERM"), observed7("mount -t tmpfs /mnt"));
verdict("7", "unshare --mount", !observed7("unshare --mount").includes("exit=0"), observed7("unshare --mount"));
verdict("7", "nsenter setns", !observed7("nsenter -t 1 -m (setns toward init)").includes("exit=0"), observed7("nsenter -t 1 -m (setns toward init)"));
verdict("7", "/proc/1 is sandbox pidns init (not host systemd)", /comm = (bwrap|node)/.test(observed7("/proc/1 identity (pidns init, not host init)")), `${observed7("/proc/1 identity (pidns init, not host init)")} (host init would be systemd)`);
verdict("7", "docker.sock absent", observed7("docker socket visibility").includes("absent"), observed7("docker socket visibility"));
verdict("7", "/sys absent", observed7("/sys visibility").includes("absent"), observed7("/sys visibility"));
verdict("7", "no host block devices in /dev", !/sd[a-z]|nvme/.test(observed7("host block devices")), observed7("host block devices"));
verdict("7", "CapEff = NET_BIND_SERVICE only + NoNewPrivs", /CapEff=0000000000000400.*NoNewPrivs=1/.test(observed7("capability set + NoNewPrivs")), observed7("capability set + NoNewPrivs"));

// Host-side aftermath: nothing landed, nothing leaked, tree reclaimed.
await new Promise(resolve => setTimeout(resolve, 1500));
const forbiddenAfter = forbiddenHostPaths.filter(existsSync);
verdict("1", "host-side: no forbidden file landed", forbiddenAfter.length === 0, forbiddenAfter.length ? forbiddenAfter.join(",") : "all absent");
const credentialsStatAfter = statSync(join(homedir(), ".zcode/v2/credentials.json"));
verdict("2", "host-side: credentials.json untouched (size/mtime)", credentialsStatAfter.size === credentialsStatBefore.size && credentialsStatAfter.mtimeMs === credentialsStatBefore.mtimeMs, `size=${credentialsStatAfter.size}`);
const survivors = sandboxProcs();
verdict("5", "host-side: sandboxed process tree reclaimed (incl. detached child)", baselineSandbox.length === 0 && survivors.length === 0, `before=${baselineSandbox.length} after=${survivors.length}`);

listener.close();
mkdirSync(`${EVID}/sandbox-evidence`, { recursive: true });
for (const name of readdirSync(evidenceDir)) copyFileSync(`${evidenceDir}/${name}`, `${EVID}/sandbox-evidence/${name}`);
print({ kind: "launch-args-note", runtime_dir: launch.runtimeDir, args_count: launch.args.length });

const failed = verdicts.filter(entry => !entry.intercepted);
print({ kind: "b5-2-matrix-result", rows_checked: ["1", "2", "3", "5", "6", "7"], total_verdicts: verdicts.length, failed: failed.length, ok: failed.length === 0 });
launch.stop();
if (failed.length > 0) { for (const entry of failed) print({ kind: "REWORK-SIGNAL", ...entry }); process.exit(1); }
process.exit(0);
