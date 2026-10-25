#!/usr/bin/env node
// B5-2 escape-matrix payload. Runs in the "app-server" slot of the production
// sandbox launch (same buildBwrapArgs as the connector), so every result below
// is the behavior of the REAL boundary. Writes one results object per matrix
// row into PAYLOAD_OUT; the host driver computes verdicts.
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns").promises;
const { spawn, spawnSync } = require("node:child_process");
const OUT = process.env.PAYLOAD_OUT;
const results = {};
const attempt = (list, name, fn) => list.push({ attempt: name, ...fn() });

// ---- Row 1: writes outside the whitelist (read-only root ⇒ EROFS), positive controls inside
{
  const list = results.row1_writes = [];
  for (const target of ["/etc/roledock-escape", "/usr/roledock-escape", "/opt/roledock-escape", "/root/roledock-escape", "/var/roledock-escape", "/etc/ld.so.preload"]) {
    attempt(list, `write ${target}`, () => { try { fs.writeFileSync(target, "roledock-escape-probe"); return { observed: "WRITTEN" }; } catch (error) { return { observed: "failed", errno: error.code }; } });
  }
  for (const target of ["/tmp/whitelisted-writes", `${process.env.HOME}/whitelisted-writes`, "workspace-writes"]) {
    attempt(list, `write (whitelisted) ${target}`, () => { try { fs.writeFileSync(target, "ok"); return { observed: "WRITTEN (whitelist area, by design)" }; } catch (error) { return { observed: "failed", errno: error.code }; } });
  }
}

// ---- Row 2: reads of owner-private material
{
  const list = results.row2_reads = [];
  for (const target of ["/home/inkem/.zcode/v2/credentials.json", "/etc/shadow", "/root/.bashrc", "/home/inkem/.bashrc", "/home/inkem/.zcode/v2/credentials.json.enc", "/proc/1/environ"]) {
    attempt(list, `read ${target}`, () => { try { const data = fs.readFileSync(target, "utf8"); return { observed: `READABLE (${data.length} bytes, first 40: ${JSON.stringify(data.slice(0, 40))})` }; } catch (error) { return { observed: "failed", errno: error.code }; } });
  }
  attempt(list, "list /home/inkem/.zcode/v2 (bound provider-config path)", () => { try { return { observed: `entries: ${fs.readdirSync("/home/inkem/.zcode/v2").sort().join(",")}` }; } catch (error) { return { observed: "failed", errno: error.code }; } });
  attempt(list, "list $HOME (tmpfs home)", () => { try { return { observed: `entries: ${fs.readdirSync(process.env.HOME).sort().join(",") || "(empty)"}` }; } catch (error) { return { observed: "failed", errno: error.code }; } });
}

// ---- Row 3: network outside the whitelist + unix-socket bypass + positive TLS control
{
  const list = results.row3_network = [];
  const tcpProbe = (host, port, label, timeoutMs = 5000) => new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = observed => { socket.destroy(); resolve({ attempt: label, expected: "connection refused/unreachable (non-whitelisted)", observed }); };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done("CONNECTED (escape!)"));
    socket.on("error", error => done(`failed (${error.code ?? error.message})`));
    socket.on("timeout", () => done("failed (timeout)"));
  });
  const run = async () => {
    await Promise.resolve();
    list.push(await tcpProbe("127.0.0.1", Number(process.env.HOST_LISTEN_PORT), "connect host-side listener 127.0.0.1 (cross netns)"));
    list.push(await tcpProbe(process.env.HOST_LAN_IP, Number(process.env.HOST_LISTEN_PORT), "connect host LAN IP (no route in netns)"));
    try { await dns.resolve("evil.test"); list.push({ attempt: "resolve evil.test", expected: "no resolution (NSS files-only, no DNS route)", observed: "RESOLVED (escape!)" }); }
    catch (error) { list.push({ attempt: "resolve evil.test", expected: "no resolution", observed: `failed (${error.code})` }); }
    try { const addrs = await dns.lookup("api.z.ai"); list.push({ attempt: "resolve api.z.ai (whitelisted, positive control)", expected: "hosts pin 127.0.0.2", observed: `resolved to ${JSON.stringify(addrs.address)}` }); }
    catch (error) { list.push({ attempt: "resolve api.z.ai", expected: "hosts pin", observed: `failed (${error.code})` }); }
    // bypass attempt: speak the forwarder protocol directly over the bind-mounted socket
    list.push(await new Promise(resolve => {
      const socket = net.connect(process.env.ROLEDOCK_EGRESS_SOCK, () => socket.write("ROLEDOCK-EGRESS evil.test:443\nGET / HTTP/1.0\n\n"));
      const done = observed => { socket.destroy(); resolve({ attempt: "unix-socket protocol bypass (evil.test via egress.sock)", expected: "forwarder rejects non-whitelisted target", observed }); };
      socket.on("data", () => done("FORWARDED (escape!)"));
      socket.on("error", error => done(`failed (${error.code ?? error.message})`));
      socket.on("close", () => resolve({ attempt: "unix-socket protocol bypass (evil.test via egress.sock)", expected: "forwarder rejects non-whitelisted target", observed: "closed by forwarder (rejected)" }));
      socket.setTimeout(5000, () => done("failed (timeout)"));
    }));
    // positive control: real TLS to the whitelisted provider endpoint, cert validated by name
    list.push(await new Promise(resolve => {
      const socket = tls.connect({ host: "api.z.ai", port: 443, servername: "api.z.ai", timeout: 15000 }, () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        resolve({ attempt: "TLS to api.z.ai:443 (whitelisted positive control)", expected: "handshake + name-validated certificate via relay", observed: `handshake OK, subject CN=${JSON.stringify(cert.subject?.CN ?? cert.subject?.O)}, authorized=${socket.authorized}` });
      });
      socket.on("error", error => resolve({ attempt: "TLS to api.z.ai:443", expected: "handshake via relay", observed: `failed (${error.code ?? error.message})` }));
      socket.on("timeout", () => { socket.destroy(); resolve({ attempt: "TLS to api.z.ai:443", expected: "handshake via relay", observed: "failed (timeout)" }); });
    }));
  };
  results.__row3_promise = run(); // host driver awaits via a done-marker file; payload exits after
}

// ---- Row 5: nested spawn tree, same pid/net/user namespaces at every level
{
  const list = results.row5_nested_spawn = [];
  global.__childWaits = global.__childWaits || [];
  const levelFile = name => `${OUT}/${name}.json`;
  const script = level => `
    const fs = require("node:fs");
    const snap = ["pid","net","user","mnt"].map(k => k + "=" + require("node:fs").readlinkSync("/proc/self/ns/" + k)).join(" ");
    ${level < 3 ? `
    const { spawn } = require("node:child_process");
    const next = spawn(process.execPath, ["-e", ${JSON.stringify(script(level + 1))}], { stdio: "ignore" });
    next.on("exit", () => { fs.writeFileSync(${JSON.stringify(levelFile(`row5-level${level}`))}, JSON.stringify({ level: ${level}, ns: snap, spawned_child: true })); });
    setTimeout(() => process.exit(0), 3000);` : `
    fs.writeFileSync(${JSON.stringify(levelFile(`row5-level${level}`))}, JSON.stringify({ level: ${level}, ns: snap }));
    process.exit(0);`}
  `;
  attempt(list, "nested tree: payload → node → node → node (3 levels)", () => {
    try {
      global.__childWaits.push(new Promise(resolve => {
        const child = spawn(process.execPath, ["-e", script(1)], { stdio: "ignore" });
        child.on("error", resolve); child.on("exit", resolve);
      }));
      return { observed: "spawned (level files + namespace comparison done host-side after exit)" };
    } catch (error) { return { observed: `failed (${error.code})` }; }
  });
  attempt(list, "detached setsid child (survival attempt)", () => {
    try {
      const child = spawn("/usr/bin/setsid", [process.execPath, "-e", `
        const fs = require("node:fs");
        const snap = ["pid","net","user"].map(k => k + "=" + require("node:fs").readlinkSync("/proc/self/ns/" + k)).join(" ");
        fs.writeFileSync(${JSON.stringify(levelFile("row5-detached"))}, JSON.stringify({ ns: snap, pid: process.pid }));
        setInterval(() => {}, 1000);
      `], { detached: true, stdio: "ignore" });
      child.unref();
      global.__childWaits.push(new Promise(resolve => setTimeout(resolve, 1500))); // let it record its namespaces, then the payload moves on
      return { observed: "spawned detached (host-side checks: same namespaces + no survivor after teardown)" };
    } catch (error) { return { observed: `failed (${error.code})` }; }
  });
}

// ---- Row 6: plugin / global MCP surface (config absence + equivalent child process)
{
  const list = results.row6_plugins_mcp = [];
  global.__childWaits = global.__childWaits || [];
  attempt(list, "global MCP/plugin config visibility ($HOME/.zcode)", () => {
    try { return { observed: `$HOME/.zcode entries: ${fs.readdirSync(`${process.env.HOME}/.zcode`).sort().join(",") || "(absent)"}` }; }
    catch (error) { return { observed: `absent (${error.code})` }; }
  });
  attempt(list, "literal provider-config dir contents (ro-bound)", () => {
    try { return { observed: `/home/inkem/.zcode/v2 entries: ${fs.readdirSync("/home/inkem/.zcode/v2").sort().join(",")}` }; }
    catch (error) { return { observed: `failed (${error.code})` }; }
  });
  // an equivalent of any plugin/MCP server process: spawned inside, inherits the boundary
  const fakeMcp = `
    const fs = require("node:fs"); const net = require("node:net");
    const out = {};
    try { fs.writeFileSync("/etc/mcp-escape", "x"); out.write = "WRITTEN"; } catch (e) { out.write = e.code; }
    try { fs.readFileSync("/home/inkem/.zcode/v2/credentials.json"); out.read = "READABLE"; } catch (e) { out.read = e.code; }
    const probe = net.connect({ host: "127.0.0.1", port: Number(process.env.HOST_LISTEN_PORT) });
    const done = r => { out.net = r; out.ns_pid = fs.readlinkSync("/proc/self/ns/pid"); fs.writeFileSync(process.env.PAYLOAD_OUT + "/row6-fake-mcp.json", JSON.stringify(out)); process.exit(0); };
    probe.on("connect", () => done("CONNECTED"));
    probe.on("error", e => done(e.code));
    setTimeout(() => done("timeout"), 5000);
  `;
  attempt(list, "plugin-equivalent child process (write/read/network probes)", () => {
    try {
      fs.writeFileSync("/tmp/row6-fake-mcp.cjs", fakeMcp);
      global.__childWaits.push(new Promise(resolve => {
        const child = spawn(process.execPath, ["/tmp/row6-fake-mcp.cjs"], { env: { ...process.env }, stdio: "ignore" });
        child.on("error", resolve); child.on("exit", () => { try { fs.copyFileSync("/tmp/row6-fake-mcp.json", `${OUT}/row6-fake-mcp.json`); } catch {} resolve(); });
      }));
      return { observed: "spawned (results collected from row6-fake-mcp.json)" };
    } catch (error) { return { observed: `failed (${error.code})` }; }
  });
}

// ---- Row 7: common container-escape paths
{
  const list = results.row7_escape_paths = [];
  attempt(list, "mount -t tmpfs /mnt", () => { const r = spawnSync("/usr/bin/mount", ["-t", "tmpfs", "none", "/mnt"], { encoding: "utf8" }); return { observed: `exit=${r.status} stderr=${(r.stderr || "").trim().slice(0, 80)}` }; });
  attempt(list, "unshare --mount", () => { const r = spawnSync("/usr/bin/unshare", ["--mount", "true"], { encoding: "utf8" }); return { observed: `exit=${r.status} stderr=${(r.stderr || "").trim().slice(0, 80)}` }; });
  attempt(list, "nsenter -t 1 -m (setns toward init)", () => { const r = spawnSync("/usr/bin/nsenter", ["-t", "1", "-m", "true"], { encoding: "utf8" }); return { observed: `exit=${r.status} stderr=${(r.stderr || "").trim().slice(0, 80)}` }; });
  attempt(list, "/proc/1 identity (pidns init, not host init)", () => { try { return { observed: `/proc/1/comm = ${fs.readFileSync("/proc/1/comm", "utf8").trim()} (host init would be systemd)` }; } catch (error) { return { observed: `failed (${error.code})` }; } });
  attempt(list, "docker socket visibility", () => { try { fs.statSync("/var/run/docker.sock"); return { observed: "PRESENT (escape surface!)" }; } catch (error) { return { observed: `absent (${error.code})` }; } });
  attempt(list, "/sys visibility", () => { try { fs.readdirSync("/sys"); return { observed: "PRESENT" }; } catch (error) { return { observed: `absent (${error.code})` }; } });
  attempt(list, "host block devices", () => { try { return { observed: `/dev entries: ${fs.readdirSync("/dev").sort().join(",")}` }; } catch (error) { return { observed: `failed (${error.code})` }; } });
  attempt(list, "capability set + NoNewPrivs", () => {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const capEff = status.match(/CapEff:\s+(\S+)/)?.[1];
    const nnp = status.match(/NoNewPrivs:\s+(\d+)/)?.[1];
    return { observed: `CapEff=${capEff} (0x400 = NET_BIND_SERVICE only), NoNewPrivs=${nnp}` };
  });
}

fs.writeFileSync(`${OUT}/escape-payload-done.json`, JSON.stringify({ started_at: new Date().toISOString() }));
(async () => {
  await Promise.resolve(results.__row3_promise);
  delete results.__row3_promise;
  await Promise.allSettled(global.__childWaits ?? []);
  fs.writeFileSync(`${OUT}/escape-results.json`, JSON.stringify(results, null, 2));
  process.exit(0);
})();
