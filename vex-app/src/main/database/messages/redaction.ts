/**
 * LOCAL tool-call args redaction for the messages DB repository.
 *
 * This is the LOCAL secret-word redaction used when reducing
 * `messages.tool_calls` JSONB to a renderer-visible display string. It is
 * deliberately independent of the diagnostics/bug-report redactor — do NOT
 * swap in `redactBugPayload` or any other redactor here. `sanitizeToolArgs`
 * stays behind `extractToolCalls` (see `./mappers.ts`) as the single place
 * tool args cross the boundary.
 */

// ── Tool-call args sanitization (renderer disclosure) ─────────────────
// The renderer reveals the params a tool was called with. Args can carry
// sensitive material, so this is the ONLY place they cross the boundary —
// and only as a redacted, size-capped JSON STRING (never raw JSONB). Two
// independent layers, defense in depth:
//   1. drop any key whose NAME indicates a secret (segment-aware so common
//      DeFi args like `tokenAddress` / `signer` are NOT false-dropped);
//   2. hard-redact any VALUE that looks like a secret (private key, JWT,
//      mnemonic, long base58/base64) while preserving public identifiers
//      (EVM/Solana addresses, amounts, chain ids).

/** Secret-indicating key segments (matched against camel/snake/kebab words). */
const SECRET_KEY_WORDS = new Set<string>([
  "secret",
  "seed",
  "mnemonic",
  "password",
  "passphrase",
  "passwd",
  "privatekey",
  "privkey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearer",
  "credential",
  "credentials",
  "jwt",
  "signature",
]);

/**
 * 32-byte hex — private-key shaped, but ALSO tx-hash shaped, and the two are
 * indistinguishable by value alone. The rule therefore applies to every value
 * EXCEPT one under a hash-named key (see `isHashKey`): `agent_scan`,
 * `chain_read` and the bridge-status flows take a transaction hash as a real
 * parameter, and a tx hash is public on-chain data — redacting it showed the
 * user `"txHash": "[redacted:key]"` for a value they can read in any explorer.
 * The exemption is narrow ON PURPOSE: it needs BOTH a hash-named key AND the
 * exact `0x`+64-hex SHAPE, and it exempts that pair from the value rules
 * wholesale — note that a 66-char hex string also matches `BASE64_LONG_RE`, so
 * skipping only `HEX32_RE` would redact it one line later anyway. Any OTHER
 * value under a hash-named key (a JWT, a long base58/base64 blob, a mnemonic)
 * still runs the full ladder, and the layer-1 secret-key drop is untouched.
 */
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * A Solana transaction signature is base58 of 64 bytes. `58^87 < 2^512 <=
 * 58^88`, so a full-width 64-byte value needs 88 base58 digits and a value
 * just under that boundary needs 87; a signature whose leading byte is zero
 * drops to 86. That gives the window below — the same exemption as the hex
 * one above, for the same reason (`agent_scan` / bridge-status flows take a
 * Solana signature as a real `txHash` parameter and it is public on-chain
 * data), gated the same narrow way: it needs BOTH a hash-named key AND a
 * base58 string inside the signature-length window.
 * ACCEPTED RISK, symmetric to the hex case: a base58-encoded 64-byte Solana
 * PRIVATE key is shape-identical to a signature and would also pass. The
 * double gate is the mitigation, and layer 1 still drops secret-NAMED keys
 * (`secret`, `privateKey`, `signature`, …) outright before any value rule
 * runs. Any other value under a hash-named key runs the full ladder.
 */
const SOLANA_SIGNATURE_MIN_BASE58 = 86;
const SOLANA_SIGNATURE_MAX_BASE58 = 88;
const BASE58_CHARS_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isSolanaSignatureShape(value: string): boolean {
  return (
    value.length >= SOLANA_SIGNATURE_MIN_BASE58 &&
    value.length <= SOLANA_SIGNATURE_MAX_BASE58 &&
    BASE58_CHARS_RE.test(value)
  );
}
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BASE58_LONG_RE = /^[1-9A-HJ-NP-Za-km-z]{50,}$/; // beyond Solana addr length
const BASE64_LONG_RE = /^[A-Za-z0-9+/=]{60,}$/;

const ARG_MAX_STRING = 256;
const ARG_MAX_ARRAY = 50;
const ARG_MAX_KEYS = 50;
const ARG_MAX_DEPTH = 4;
const ARGS_MAX_SERIALIZED = 2000;

function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

function isSecretKey(key: string): boolean {
  const words = splitKeyWords(key);
  for (const w of words) {
    if (SECRET_KEY_WORDS.has(w)) return true;
  }
  // Joined camelCase forms: privateKey→[private,key], apiKey→[api,key], …
  const joined = words.join("");
  return /(privatekey|privkey|apikey|accesstoken|refreshtoken|authtoken|secretkey|seedphrase)/.test(
    joined,
  );
}

/**
 * True when the key's word-split contains the exact word `hash` — covers
 * `txHash`, `transactionHash`, `tx_hash`, `originTxHash`, plain `hash`. A
 * substring match is deliberately NOT used: `hashish` is not a hash.
 */
function isHashKey(key: string): boolean {
  return splitKeyWords(key).includes("hash");
}

function redactScalarString(value: string, hashKey: boolean): string {
  if (HEX32_RE.test(value)) return hashKey ? value : "[redacted:key]";
  if (hashKey && isSolanaSignatureShape(value)) return value;
  if (JWT_RE.test(value)) return "[redacted:jwt]";
  if (BASE58_LONG_RE.test(value)) return "[redacted:secret]";
  if (BASE64_LONG_RE.test(value)) return "[redacted:secret]";
  // BIP39-like: >= 12 space-separated lowercase words.
  const words = value.trim().split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]+$/.test(w))) {
    return "[redacted:mnemonic]";
  }
  return value.length > ARG_MAX_STRING ? `${value.slice(0, ARG_MAX_STRING)}…` : value;
}

/**
 * `hashKey` is true ONLY for the immediate string value of a hash-named key.
 * It is not inherited by nested objects or array elements — a container's name
 * says nothing about what its members hold.
 */
function redactArgValue(value: unknown, depth: number, hashKey = false): unknown {
  if (depth > ARG_MAX_DEPTH) return "[…]";
  if (typeof value === "string") return redactScalarString(value, hashKey);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, ARG_MAX_ARRAY).map((v) => redactArgValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= ARG_MAX_KEYS) break;
      if (isSecretKey(k)) continue; // drop secret-named keys entirely
      out[k] = redactArgValue(v, depth + 1, isHashKey(k));
      count += 1;
    }
    return out;
  }
  return undefined; // functions / symbols / bigint — never expose
}

/**
 * Sanitize one tool call's `args` into a display string, or `null` when there
 * is nothing safe/meaningful to show.
 */
export function sanitizeToolArgs(rawArgs: unknown): string | null {
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return null;
  }
  const redacted = redactArgValue(rawArgs, 0);
  if (
    redacted === null ||
    typeof redacted !== "object" ||
    Object.keys(redacted as Record<string, unknown>).length === 0
  ) {
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted, null, 2);
  } catch {
    return null;
  }
  return serialized.length > ARGS_MAX_SERIALIZED
    ? `${serialized.slice(0, ARGS_MAX_SERIALIZED)}\n…(truncated)`
    : serialized;
}
