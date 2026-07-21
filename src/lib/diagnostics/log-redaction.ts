/**
 * Transport-agnostic log redaction.
 *
 * This is the single write-boundary sanitizer for engine stderr, Electron
 * logs, and telemetry. Callers should still avoid logging secrets, but every
 * transport receives a recursively sanitized value as a final backstop.
 */

import {
  looksLikeBase64Secret,
  OPEN_ENDED_BASE64_CANDIDATE_RE,
} from "./secret-detectors.js";
import { redact as redactText } from "./text-redaction.js";

const SENSITIVE_KEY_RE =
  /(password|passphrase|mnemonic|seed|phrase|private[_-]?key|secret|token|api[_-]?key|auth(?:orization)?|signature|sig\b|wallet|address|keystore|cipher|tag|salt|nonce|iv\b|jwt)/i;

const BARE_HEX_SECRET_RE = /\b0x[a-fA-F0-9]{64}\b/g;
const LABELLED_BASE58_SECRET_RE =
  /(private[_\s-]?key|seed[_\s-]?key|wallet[_\s-]?key|secret[_\s-]?key)\s*[:=]\s*['"`]?[1-9A-HJ-NP-Za-km-z]{64,128}['"`]?/gi;
const TYPED_REDACTION_RE = /\[REDACTED:[^\]]+\]/g;

const REDACTED = "[REDACTED]";
const MAX_STRING_LEN = 4_000;
const MAX_DEPTH = 8;

function scrubString(value: string): string {
  let out = value
    .replace(BARE_HEX_SECRET_RE, REDACTED)
    .replace(LABELLED_BASE58_SECRET_RE, REDACTED)
    .replace(OPEN_ENDED_BASE64_CANDIDATE_RE, (candidate) =>
      looksLikeBase64Secret(candidate) ? REDACTED : candidate,
    );

  // Reuse the canonical prose redactor for API keys, JWTs, mnemonics, and
  // labelled keys. Logs intentionally use one generic marker so the marker
  // itself never reveals what class of secret was present.
  out = redactText(out).text.replace(TYPED_REDACTION_RE, REDACTED);

  if (out.length > MAX_STRING_LEN) {
    out = `${out.slice(0, MAX_STRING_LEN)}…[truncated ${out.length - MAX_STRING_LEN} chars]`;
  }
  return out;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === "string") return scrubString(value as string);
  if (valueType === "number" || valueType === "boolean" || valueType === "bigint") {
    return value;
  }
  if (valueType === "function" || valueType === "symbol") return `[${valueType}]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (valueType === "object") {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? REDACTED
        : redactValue(nested, depth + 1, seen);
    }
    return output;
  }

  return `[${valueType}]`;
}

export function redactLogValue<T>(value: T): T {
  return redactValue(value, 0, new WeakSet()) as T;
}

export function redactLogArgs(args: ReadonlyArray<unknown>): unknown[] {
  return args.map((arg) => redactLogValue(arg));
}
