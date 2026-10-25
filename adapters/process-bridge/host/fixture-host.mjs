#!/usr/bin/env node
/**
 * RoleDock process-bridge fixture host (fixed-answer protocol fixture).
 *
 * This program plays the HOST side of the process-bridge message protocol so
 * the bridge can be tested against a real operating-system process: every
 * adapter operation spawns this program with structured argv (never a shell
 * string), exchanges one framed request over stdin/argv, and reads one JSON
 * reply from stdout.
 *
 * It is a PROTOCOL FIXTURE, not a model and not a real harness: answers are
 * deterministic and state lives in plain files inside the session directory.
 * Its passes must never be reported as real-harness evidence
 * (docs/spec/adapter-contract.md §4).
 *
 * Session directory layout (all host state, written through by the host):
 *   session.json     registry entry: creation_key, status, role_id, ...
 *   bootstrap.json   the loaded BootstrapLoad payload (verified on load)
 *   transcript.jsonl one JSON line per turn: { index, message, answer }
 *   result.json      latest host-reported result snapshot
 *   tmp/             host-private scratch (removed on close)
 *
 * Commands (one JSON reply on stdout; non-zero exit + JSON on stderr on failure):
 *   load    --session-dir D [--chaos uncertain-create|crash-load]
 *           Verify and confirm the bootstrap bundle. `uncertain-create`
 *           writes the registry and then dies before confirming: the host
 *           session may exist, the outcome is unknown to the caller.
 *   turn    --session-dir D   (request JSON on stdin: { message })
 *           Append the message to the transcript, answer deterministically.
 *           `crash-turn` persists the turn and then dies before the ack.
 *   result  --session-dir D   Report { state, turn_count, output_bytes, needs_input }.
 *   close   --session-dir D   Mark closed and reclaim tmp/.
 *   lookup  --state-dir D --creation-key K
 *           Report { found, status, session_dir } for the registry entry.
 *   version                     Report the host program version.
 *
 * Environment knob (bridge passes it explicitly as argv, never a shell var):
 *   ROLEDOCK_FIXTURE_NEEDS_INPUT_AT=<n>  getResult reports needs_input when
 *   turn_count equals exactly n (mirrors the in-memory mock's option).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";

const HOST_VERSION = "0.1.0-fixture";
const PROTOCOL_VERSION = 1;

function fail(code, message, details = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message, ...details } })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[arg.slice(2)] = true;
      } else {
        args[arg.slice(2)] = next;
        i++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function sessionPaths(sessionDir) {
  return {
    dir: sessionDir,
    session: join(sessionDir, "session.json"),
    bootstrap: join(sessionDir, "bootstrap.json"),
    transcript: join(sessionDir, "transcript.jsonl"),
    result: join(sessionDir, "result.json"),
    tmp: join(sessionDir, "tmp"),
  };
}

function readSession(paths) {
  if (!existsSync(paths.session)) {
    fail("NOT_FOUND", `no host session at ${paths.dir}`);
  }
  return JSON.parse(readFileSync(paths.session, "utf8"));
}

function readTranscript(paths) {
  if (!existsSync(paths.transcript)) return [];
  return readFileSync(paths.transcript, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeResultSnapshot(paths, session, turns, extra = {}) {
  const lastAnswer = turns.length > 0 ? turns[turns.length - 1].answer : "";
  const needsInputAt = Number(process.env.ROLEDOCK_FIXTURE_NEEDS_INPUT_AT ?? Number.NaN);
  const snapshot = {
    host_session_id: session.host_session_id,
    state: session.status === "closed" ? "closed" : "idle",
    completed: turns.length > 0 && turns.length !== needsInputAt,
    body: lastAnswer,
    execution_key: turns.at(-1)?.execution_key,
    turn_count: turns.length,
    output_bytes: Buffer.byteLength(lastAnswer, "utf8"),
    ...(Number.isFinite(needsInputAt) && turns.length === needsInputAt ? { needs_input: true } : {}),
    ...extra,
  };
  writeFileSync(paths.result, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

function deterministicAnswer(session, turnCount, message) {
  // Fixed-answer policy: no model is involved; the answer is a function of
  // the turn number and the bootstrap the session loaded.
  return `fixture answer #${turnCount} for "${message.slice(0, 64)}" (role ${session.role_id})`;
}

function cmdLoad(args) {
  const chaos = args.chaos ?? "";
  const sessionDir = args["session-dir"];
  if (typeof sessionDir !== "string") fail("VALIDATION_FAILED", "--session-dir is required");
  const paths = sessionPaths(sessionDir);

  // bootstrap is optional at the port: a session may exist without a bundle
  // to load. When present, the host verifies the hash before confirming.
  let bootstrap = null;
  if (existsSync(paths.bootstrap)) {
    bootstrap = JSON.parse(readFileSync(paths.bootstrap, "utf8"));
    const actual = createHash("sha256").update(bootstrap.payload, "utf8").digest("hex");
    if (actual !== bootstrap.content_hash) {
      fail(
        "VALIDATION_FAILED",
        "Bootstrap bundle failed its content hash check; host refuses the load.",
        { bundle_id: bootstrap.bundle_id, expected: bootstrap.content_hash, actual },
      );
    }
  }

  const registry = {
    creation_key: args["creation-key"] ?? "",
    host_session_id: `pb-${basename(sessionDir)}`,
    role_id: bootstrap ? bootstrap.role_id : "unknown",
    bundle_id: bootstrap ? bootstrap.bundle_id : "",
    capability_scope: args["capability-scope"] ? JSON.parse(args["capability-scope"]) : [],
    temp_dir: args["temp-dir"] ?? null,
    status: "active",
    host_version: HOST_VERSION,
    protocol: PROTOCOL_VERSION,
    created_at: new Date().toISOString(),
  };
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(paths.session, `${JSON.stringify(registry, null, 2)}\n`);

  if (chaos === "uncertain-create") {
    // The host session EXISTS on disk from here on, but the caller never
    // learns the outcome: the process dies before confirming. Recovery is
    // lookup-by-creation-key, exactly like a crashed real host.
    process.stderr.write(`${JSON.stringify({ ok: false, chaos: "uncertain-create" })}\n`);
    process.exit(1);
  }
  if (chaos === "crash-load") {
    // Hard failure with no host-side effect is not possible past the registry
    // write, so crash-load removes the session dir before dying: the caller
    // sees a plain failure with no session left behind.
    rmSync(sessionDir, { recursive: true, force: true });
    process.stderr.write(`${JSON.stringify({ ok: false, chaos: "crash-load" })}\n`);
    process.exit(1);
  }

  mkdirSync(join(sessionDir, "tmp"), { recursive: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    host_session_id: registry.host_session_id,
    host_version: HOST_VERSION,
    protocol: PROTOCOL_VERSION,
    role_id: registry.role_id,
  })}\n`);
}

function cmdTurn(args) {
  const chaos = args.chaos ?? "";
  const sessionDir = args["session-dir"];
  if (typeof sessionDir !== "string") fail("VALIDATION_FAILED", "--session-dir is required");
  const paths = sessionPaths(sessionDir);
  const session = readSession(paths);
  if (session.status === "closed") fail("INVALID_STATE_TRANSITION", "host session is closed");

  if (existsSync(join(sessionDir, "cancel.requested"))) fail("INVALID_STATE_TRANSITION", "host session was cancelled");
  let message = "";
  let executionKey;
  try {
    const input = JSON.parse(readStdin());
    message = input.message ?? "";
    executionKey = input.execution_key;
  } catch {
    fail("VALIDATION_FAILED", "stdin did not carry a JSON turn request");
  }
  const turns = readTranscript(paths);
  const previous = executionKey && turns.find((entry) => entry.execution_key === executionKey);
  if (previous) {
    process.stdout.write(`${JSON.stringify({ ok: true, accepted: true, turn_index: previous.index })}\n`);
    return;
  }
  const turn = {
    execution_key: executionKey,
    index: turns.length + 1,
    message,
    answer: deterministicAnswer(session, turns.length + 1, String(message)),
    at: new Date().toISOString(),
  };
  turns.push(turn);
  writeFileSync(
    paths.transcript,
    turns.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );

  if (chaos === "crash-turn") {
    // The turn IS persisted host-side; the ack is lost (process death). The
    // caller must treat the turn outcome as unknown, not blindly resend.
    process.stderr.write(`${JSON.stringify({ ok: false, chaos: "crash-turn" })}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    host_session_id: session.host_session_id,
    accepted: true,
    turn_index: turn.index,
  })}\n`);
}

function cmdResult(args) {
  const sessionDir = args["session-dir"];
  if (typeof sessionDir !== "string") fail("VALIDATION_FAILED", "--session-dir is required");
  const paths = sessionPaths(sessionDir);
  const session = readSession(paths);
  const turns = readTranscript(paths);
  const snapshot = writeResultSnapshot(paths, session, turns);
  process.stdout.write(`${JSON.stringify({ ok: true, ...snapshot })}\n`);
}

function cmdClose(args) {
  const sessionDir = args["session-dir"];
  if (typeof sessionDir !== "string") fail("VALIDATION_FAILED", "--session-dir is required");
  const paths = sessionPaths(sessionDir);
  const session = readSession(paths);
  session.status = "closed";
  session.closed_at = new Date().toISOString();
  writeFileSync(paths.session, `${JSON.stringify(session, null, 2)}\n`);
  rmSync(paths.tmp, { recursive: true, force: true });
  const turns = readTranscript(paths);
  writeResultSnapshot(paths, session, turns);
  process.stdout.write(`${JSON.stringify({ ok: true, host_session_id: session.host_session_id })}\n`);
}

function cmdLookup(args) {
  const stateDir = args["state-dir"];
  const creationKey = args["creation-key"];
  if (typeof stateDir !== "string" || typeof creationKey !== "string") {
    fail("VALIDATION_FAILED", "--state-dir and --creation-key are required");
  }
  const sessionsDir = join(stateDir, "sessions");
  if (!existsSync(sessionsDir)) {
    process.stdout.write(`${JSON.stringify({ ok: true, found: false })}\n`);
    return;
  }
  // Registry lookup is by the sanitized directory name; the authoritative
  // creation key lives inside session.json.
  for (const entry of readdirSync(sessionsDir)) {
    const sessionPath = join(sessionsDir, entry, "session.json");
    if (!existsSync(sessionPath)) continue;
    const registry = JSON.parse(readFileSync(sessionPath, "utf8"));
    if (registry.creation_key !== creationKey) continue;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      found: true,
      status: registry.status,
      host_session_id: registry.host_session_id,
      session_dir: join(sessionsDir, entry),
      host_version: registry.host_version ?? HOST_VERSION,
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, found: false })}\n`);
}

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
if (command === "version") {
  process.stdout.write(`${JSON.stringify({ ok: true, host_version: HOST_VERSION, protocol: PROTOCOL_VERSION })}\n`);
} else if (command === "load") {
  cmdLoad(args);
} else if (command === "turn") {
  cmdTurn(args);
} else if (command === "result") {
  cmdResult(args);
} else if (command === "close") {
  cmdClose(args);
} else if (command === "lookup") {
  cmdLookup(args);
} else {
  fail("VALIDATION_FAILED", `unknown fixture-host command "${command ?? ""}"`);
}
