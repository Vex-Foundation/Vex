/**
 * Log redaction — sanitize values before they hit electron-log files / Sentry.
 *
 * Phase 1 covers structured fields by name; M11 will add Sentry's beforeSend
 * with the same redactor so on-wire telemetry uses identical rules.
 *
 * Approach: structural recursion over plain objects/arrays/strings, replacing
 * any field whose key matches a sensitive name with "[REDACTED]". Strings are
 * scrubbed for inline secret patterns (0x-hex 64-char, base58 64-char, JWT-like).
 * Errors are unwrapped to {name, message, stack} with each component scrubbed.
 *
 * NEVER call this on the secret itself thinking the redactor will save you —
 * call sites must avoid logging raw secrets in the first place. This is
 * defense-in-depth, not the first line.
 */

const SENSITIVE_KEY_RE =
  /(password|passphrase|mnemonic|seed|phrase|private[_-]?key|secret|token|api[_-]?key|auth(?:orization)?|signature|sig\b|wallet|address|keystore|cipher|tag|salt|nonce|iv\b|jwt)/i;

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b0x[a-fA-F0-9]{64}\b/g, // EVM private key
  /\b0x[a-fA-F0-9]{40}\b/g, // EVM address
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
  /\b[A-Za-z0-9+/]{86}={0,2}\b/g, // 64-byte base64 (Solana secret etc.)
];

const REDACTED = "[REDACTED]";
const MAX_STRING_LEN = 4000;

/**
 * Stands in for a stack we could not read. Keeping the field (rather than
 * dropping it silently) tells whoever reads the log that a stack existed and
 * the read failed — otherwise a poisoned process looks identical to errors
 * that legitimately carry no stack.
 */
const STACK_UNAVAILABLE = "<stack unavailable>";

function scrubString(value: string): string {
  let out = value;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  if (out.length > MAX_STRING_LEN) {
    out = `${out.slice(0, MAX_STRING_LEN)}…[truncated ${out.length - MAX_STRING_LEN} chars]`;
  }
  return out;
}

/**
 * Reading `error.stack` CAN THROW: V8 computes it lazily through
 * `Error.prepareStackTrace`, so any dependency that installs a broken hook and
 * fails to restore it poisons that read for the whole process. That happened in
 * production — a CJS `bindings` shim inlined into the ESM main bundle read bare
 * `__filename` inside its hook — and because this redactor sits on the logging
 * path, the throw turned every HANDLED error into an unhandled rejection and
 * hid the real failure behind "[ReferenceError: __filename is not defined]".
 * A logger must never do that, so the read is fail-safe regardless of what a
 * future dependency does to the global hook.
 */
function readStack(error: Error): string | undefined {
  let raw: unknown;
  try {
    raw = error.stack;
  } catch {
    return STACK_UNAVAILABLE;
  }
  return typeof raw === "string" && raw.length > 0 ? scrubString(raw) : undefined;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 8) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return scrubString(value as string);
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return `[${t}]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: readStack(value),
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (t === "object") {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1, seen);
      }
    }
    return out;
  }

  return `[${t}]`;
}

export function redact<T>(value: T): T {
  return redactValue(value, 0, new WeakSet()) as T;
}

/**
 * Convenience for `log.error(...)` call sites: takes the same variadic shape
 * as electron-log and applies redaction to each argument.
 */
export function redactArgs(args: ReadonlyArray<unknown>): unknown[] {
  return args.map((a) => redact(a));
}
