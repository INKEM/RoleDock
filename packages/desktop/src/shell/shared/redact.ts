/**
 * Shell-side redaction — IDENTICAL layered rules to the probe copy
 * (src/probe/shared/bridge.ts; G0-R01 re-review requires both bridges to
 * behave the same). desktop-gui-contract §3.1:
 * 1. DTO field projection (authoritative, per implementing sub-phase):
 *    structured secret fields never enter a reply at all.
 * 2. redact() drops fields whose NAME is a known secret field; business
 *    identifiers and hashes (authorization_id, content_hash,
 *    host_session_id, event_ref, …) pass through VERBATIM.
 * 3. Display scrubbing applies ONLY to designated free-text keys (message/
 *    body/detail/error/note/reason/description/summary/output/text/log),
 *    masking labeled secret patterns (Bearer <value>, `key: value`).
 *    Unlabeled blobs are not masked; scrubbed text must never be presented
 *    as the bytes a content_hash was computed over.
 */

const SECRET_FIELD = /(^|_)(token|secret|password|bearer|api[_-]?key|private[_-]?key|access[_-]?key)(s)?$/i;
const FREE_TEXT_FIELD = /(^|_)(message|body|detail|error|note|reason|description|summary|output|text|log)(s)?$/i;
/**
 * Hash-paired payload bytes (G5 owner knowledge DTOs): a "body" string is
 * content-addressed — paired with content_hash / proposed_body_hash / the
 * handoff summary hash — so it must arrive VERBATIM. Scrubbing it would
 * silently rewrite the bytes and break the hash correspondence, violating
 * desktop-gui-contract §3.1 layer 4 (scrubbed display text must never be
 * presented as the bytes a content_hash was computed over). Free-text
 * DISPLAY fields that need scrubbing use other names (message/detail/note/
 * reason/question/…). R1 (P6-G5 review): keeping this bypass identical in
 * the probe bridge (G0-R01 parity).
 */
const BYTE_FAITHFUL_FIELD = new Set(["body"]);
const BEARER_SCHEME = /(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const KEY_VALUE_SECRET = /((?:authorization|token|api[_-]?key|secret|password)\s*[:=]\s*)([A-Za-z0-9._~+/=-]{12,})/gi;
const MASK = "[masked]";

/** Best-effort display scrubbing for free text (labeled secret patterns only). */
export function scrubDisplayText(text: string): string {
  return text.replace(BEARER_SCHEME, "$1" + MASK).replace(KEY_VALUE_SECRET, "$1" + MASK);
}

export function redact<T>(value: T, options: { freeText?: boolean } = {}): T {
  if (typeof value === "string") {
    return (options.freeText ? scrubDisplayText(value) : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(item => redact(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) continue;
      out[key] = typeof item === "string" && !BYTE_FAITHFUL_FIELD.has(key) && FREE_TEXT_FIELD.test(key) ? scrubDisplayText(item) : redact(item);
    }
    return out as unknown as T;
  }
  return value;
}
