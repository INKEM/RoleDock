/**
 * P6-G0 probe named-IPC contract (DESKTOP_GUI_PLAN §4, ADR-0013 §1/§3).
 *
 * The preload exposes exactly the methods in PROBE_METHODS — there is no
 * generic `rpc(operation, input)` channel and no way for the renderer to
 * name an arbitrary operation.
 *
 * Layered reply hygiene (desktop-gui-contract §3.1, v3 per G0-R01 re-review);
 * the shell copy (src/shell/shared/redact.ts) is identical by requirement:
 *
 * 1. DTO field projection (authoritative, per implementing sub-phase):
 *    structured secret fields never enter a reply at all.
 * 2. redact() drops fields whose NAME is a known secret field (token,
 *    secret, password, api key, …). Business identifiers such as
 *    `authorization_id`, `content_hash`, `host_session_id` or `event_ref`
 *    are NOT secret fields — their string values pass through VERBATIM
 *    (hash comparison and session association depend on byte-exact values).
 * 3. Display scrubbing applies ONLY to the string values of designated
 *    free-text keys (message/body/detail/error/note/reason/description/
 *    summary/output/text/log): labeled secret patterns (Bearer <value>,
 *    `key: value`) are masked. UNLABELED blobs are not masked and must not
 *    exist as structured DTO fields (layer 1's job); scrubbed text must
 *    never be presented as the bytes a content_hash was computed over.
 */

export const PROBE_CHANNEL_PREFIX = "roledock:probe:";

export const PROBE_METHODS = ["getStatus", "startService", "stopService", "runChecks", "pickDirectory"] as const;
export type ProbeMethod = (typeof PROBE_METHODS)[number];

export function channelFor(method: ProbeMethod): string {
  return PROBE_CHANNEL_PREFIX + method;
}

export type BridgeInvoke = (channel: string, payload?: unknown) => Promise<unknown>;

/** Closed-vocabulary bridge: one function per manifest entry, nothing else. */
export function createBridgeApi(invoke: BridgeInvoke): Record<ProbeMethod, (payload?: unknown) => Promise<unknown>> {
  const api = {} as Record<ProbeMethod, (payload?: unknown) => Promise<unknown>>;
  for (const method of PROBE_METHODS) {
    api[method] = (payload?: unknown) => invoke(channelFor(method), payload);
  }
  return api;
}

/** Field NAMES whose value is a credential wherever they appear (exact suffix; not business identifiers). */
const SECRET_FIELD = /(^|_)(token|secret|password|bearer|api[_-]?key|private[_-]?key|access[_-]?key)(s)?$/i;

/** Keys whose STRING values are free text and therefore get display-scrubbed. */
const FREE_TEXT_FIELD = /(^|_)(message|body|detail|error|note|reason|description|summary|output|text|log)(s)?$/i;

const BEARER_SCHEME = /(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const KEY_VALUE_SECRET = /((?:authorization|token|api[_-]?key|secret|password)\s*[:=]\s*)([A-Za-z0-9._~+/=-]{12,})/gi;
const MASK = "[masked]";

/**
 * Best-effort display scrubbing for free text: masks LABELED secret
 * patterns only. It does not prove text is secret-free, and it never
 * touches structured identifier/hash values (they do not pass through
 * here — only free-text field values do).
 */
export function scrubDisplayText(text: string): string {
  return text.replace(BEARER_SCHEME, "$1" + MASK).replace(KEY_VALUE_SECRET, "$1" + MASK);
}

/** Layered hygiene for IPC replies (see module doc). */
export function redact<T>(value: T, options: { freeText?: boolean } = {}): T {
  if (typeof value === "string") {
    return (options.freeText ? scrubDisplayText(value) : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(item => redact(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) continue;
      out[key] = typeof item === "string" && FREE_TEXT_FIELD.test(key) ? scrubDisplayText(item) : redact(item);
    }
    return out as unknown as T;
  }
  return value;
}

export interface ProbeCheckResult {
  name: "runtime_version" | "workspace_info" | "sqlite_single_writer" | "mcp_subprocess";
  pass: boolean;
  detail: string;
}

export interface ProbeStateSnapshot {
  mode: "dev" | "packaged";
  runtimeNode: string;
  runtimeVersion: string | null;
  service: {
    state: "idle" | "starting" | "running" | "stopped" | "failed";
    pid: number | null;
    workspaceRoot: string | null;
    socketPath: string | null;
    workspaceId: string | null;
    error: string | null;
  };
  events: Array<{ at: string; event: string; detail?: string }>;
}

/**
 * Second-connection probe run inside the locked Node 22.23.2 runtime (the
 * Electron-bundled Node must NOT be used for the workspace writer). The
 * workspace store is opened with locking_mode=EXCLUSIVE, so a second
 * connection must fail on its first statement with errcode 5 (SQLITE_BUSY).
 */
export const SQLITE_BUSY_PROBE_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[1];
try {
  const db = new DatabaseSync(path, { timeout: 0 });
  try { db.exec("SELECT 1"); console.log(JSON.stringify({ ok: false, errcode: 0, message: "second connection unexpectedly succeeded" })); }
  finally { db.close(); }
} catch (error) {
  console.log(JSON.stringify({ ok: error.errcode === 5, errcode: error.errcode ?? null, code: error.code ?? null, message: String(error.message).slice(0, 200) }));
}
`;
