import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressForwarder, buildBwrapArgs, planEgress, probeSandboxRunner } from "../src/sandbox.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function launchConfig(overrides: Partial<Parameters<typeof buildBwrapArgs>[0]> = {}): Parameters<typeof buildBwrapArgs>[0] {
  return {
    workspaceRoot: "/tmp/ws",
    cliPath: "/opt/zcode/zcode.cjs",
    nodeBin: "/opt/node/bin/node",
    runtimeDir: "/tmp/roledock-sandbox-x",
    evidenceDir: "/tmp/ws/.roledock/sandbox-evidence",
    homeDir: "/tmp/roledock-sandbox-x/home",
    egressSocketPath: "/tmp/roledock-sandbox-x/egress.sock",
    relay: [{ fakeIp: "127.0.0.2", port: 443, upstreamHost: "api.example.test", upstreamPort: 443 }],
    ...overrides,
  };
}

describe("planEgress", () => {
  it("maps entries to fake loopback IPs in order and pins hosts by name", () => {
    const plan = planEgress(["api.example.test", "other.example.test:8443"]);
    expect(plan.entries).toEqual([
      { host: "api.example.test", port: 443, fakeIp: "127.0.0.2" },
      { host: "other.example.test", port: 8443, fakeIp: "127.0.0.3" },
    ]);
    expect(plan.hostsFile).toBe("127.0.0.2 api.example.test\n127.0.0.3 other.example.test\n");
  });
  it("deduplicates identical entries", () => {
    expect(planEgress(["a.test:443", "a.test", "a.test:443"]).entries).toHaveLength(1);
  });
  it("rejects raw IPs, IPv6 literals and garbage", () => {
    for (const bad of ["127.0.0.1", "10.0.0.1:443", "::1", "host name", "", "host:", "host:0", "host:99999"]) {
      expect(() => planEgress([bad])).toThrow();
    }
  });
});

describe("buildBwrapArgs", () => {
  const args = buildBwrapArgs(launchConfig());

  it("isolates namespaces with least-privilege capabilities", () => {
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-add", "CAP_NET_BIND_SERVICE"]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("--dev");
  });
  it("mounts a read-only root: whitelisted submounts stay writable, everything else is EROFS", () => {
    const tmpfsRootIndex = args.indexOf("--tmpfs");
    const remountIndex = args.indexOf("--remount-ro");
    expect(args[tmpfsRootIndex + 1]).toBe("/");
    expect(args[remountIndex + 1]).toBe("/");
    // Order: the root tmpfs precedes every other mount; the ro remount follows the workspace bind.
    expect(tmpfsRootIndex).toBeLessThan(args.indexOf("--tmpfs", tmpfsRootIndex + 1));
    expect(tmpfsRootIndex).toBeLessThan(args.indexOf("--ro-bind", tmpfsRootIndex));
    expect(remountIndex).toBeGreaterThan(args.indexOf("--bind"));
    expect(remountIndex).toBeLessThan(args.indexOf("--clearenv"));
  });
  it("provides devices per node instead of a tmpfs devtree", () => {
    for (const node of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]) {
      expect(args.filter((value, index) => value === "--dev-bind" && args[index + 1] === node)).toHaveLength(1);
    }
  });
  it("pins the generated hosts file and keeps provider config metadata read-only", () => {
    expect(args).toEqual(expect.arrayContaining(["--ro-bind", "/tmp/roledock-sandbox-x/hosts", "/etc/hosts", "--ro-bind", "/opt/zcode/zcode.cjs", "/opt/zcode/zcode.cjs"]));
  });
  it("binds the workspace read-write and homes as tmpfs, never the real home or credentials", () => {
    expect(args).toEqual(expect.arrayContaining(["--bind", "/tmp/ws", "/tmp/ws", "--tmpfs", "/tmp/roledock-sandbox-x/home"]));
    expect(args.join(" ")).not.toContain("credentials");
    expect(args).not.toContain("--dev");
    expect(args.filter((value, index) => value === "--dev-bind" && args[index + 1] === "/dev")).toHaveLength(0);
  });
  it("clears the environment and rebuilds it from an explicit allowlist", () => {
    expect(args).toContain("--clearenv");
    const cleared = args.slice(args.indexOf("--clearenv"));
    const value = (name: string): string | undefined => { const index = cleared.indexOf(name); return index === -1 ? undefined : cleared[index + 1]; };
    expect(value("PATH")).toBe("/opt/node/bin:/usr/bin:/bin");
    expect(value("HOME")).toBe("/tmp/roledock-sandbox-x/home");
    expect(value("TMPDIR")).toBe("/tmp");
    expect(value("LANG")).toBe("C.UTF-8");
    const config = launchConfig({ providerBuiltinConfig: "/home/u/.zcode/v2/runtime/provider/zcode-builtin.json", providerPersonalConfig: "/home/u/.zcode/v2/provider_config.json" });
    const withProviders = buildBwrapArgs(config).slice(buildBwrapArgs(config).indexOf("--clearenv"));
    expect(withProviders).toEqual(expect.arrayContaining(["--setenv", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "/home/u/.zcode/v2/runtime/provider/zcode-builtin.json", "--setenv", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "/home/u/.zcode/v2/provider_config.json"]));
  });
  it("ends with the supervisor as the sandboxed pidns init", () => {
    expect(args.slice(-3)).toEqual(["/opt/node/bin/node", "/tmp/roledock-sandbox-x/supervisor.mjs", "/tmp/roledock-sandbox-x/sandbox-config.json"]);
  });
});

describe("probeSandboxRunner", () => {
  it("reports unavailable when the runner binary is missing (machine-independent)", async () => {
    const info = await probeSandboxRunner({ exec: () => Promise.resolve({ code: -1, stdout: "", stderr: "spawn bwrap ENOENT" }) });
    expect(info).toMatchObject({ available: false, runner: "bubblewrap" });
    expect(info.reason).toContain("bwrap");
  });
  it("reports unavailable when the functional dry run fails", async () => {
    let calls = 0;
    const info = await probeSandboxRunner({ exec: (_file, args) => { calls += 1; return Promise.resolve(calls === 1 ? { code: 0, stdout: "bubblewrap 0.6.1", stderr: "" } : { code: 1, stdout: "", stderr: "bwrap: Can't create user namespace" }); void args; } });
    expect(info).toMatchObject({ available: false, version: "bubblewrap 0.6.1" });
    expect(info.reason).toContain("functional probe failed");
  });
  it("reports available on a working runner and honors the diagnostic override", async () => {
    const info = await probeSandboxRunner({ exec: () => Promise.resolve({ code: 0, stdout: "bubblewrap 0.6.1\n", stderr: "" }) });
    expect(info).toMatchObject({ available: true, runner: "bubblewrap", version: "bubblewrap 0.6.1" });
    process.env.ROLEDOCK_SANDBOX_PROBE = "unavailable";
    try {
      expect((await probeSandboxRunner()).available).toBe(false);
    } finally {
      delete process.env.ROLEDOCK_SANDBOX_PROBE;
    }
  });
});

describe("EgressForwarder", () => {
  it("forwards allowlisted targets and rejects everything else", async () => {
    const root = mkdtempSync(join(tmpdir(), "rd-fwd-")); roots.push(root);
    const upstream = createServer(socket => { socket.write("upstream-reply"); socket.end(); });
    await new Promise<void>(resolve => upstream.listen(45988, "127.0.0.1", resolve));
    const forwarder = new EgressForwarder(join(root, "egress.sock"), [{ host: "localhost", port: 45988 }]);
    await forwarder.start();
    const { connect } = await import("node:net");

    const ask = (target: string) => new Promise<string>(resolve => {
      const socket = connect(join(root, "egress.sock"), () => { socket.write(`ROLEDOCK-EGRESS ${target}\npayload\n`); });
      socket.on("data", chunk => resolve(String(chunk)));
      socket.on("error", error => resolve("error:" + (error as NodeJS.ErrnoException).code));
      socket.on("close", () => resolve("closed-empty"));
      setTimeout(() => resolve("timeout"), 2000);
    });

    expect(await ask("localhost:45988")).toBe("upstream-reply");
    expect(await ask("evil.test:45988")).not.toBe("upstream-reply");
    expect(forwarder.stats).toEqual({ connections: 2, rejected: 1 });
    forwarder.stop();
    upstream.close();
  }, 10_000);
});
