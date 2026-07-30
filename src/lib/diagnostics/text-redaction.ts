/**
 * Two-tier text redaction — shared between vex-agent (memory layer writes,
 * compact pipeline, knowledge ingestion) and vex-app (diagnostic/bug-report
 * payloads). This module is the single canonical implementation.
 *
 * src/vex-agent/memory/redaction.ts is now a thin re-export of this file so
 * call sites in the agent are unchanged and so vex-app does NOT have to
 * reach into the agent module graph to redact diagnostic input (which would
 * pull agent code into the renderer/main bundle via @vex-lib).
 *
 * Pure module: no Electron, no React, no DB, no I/O. Safe to import from
 * shared/, main/, preload/, renderer/, and root-side vex-agent code.
 *
 * Tier 1 — HARD REDACT
 *   Replaced with `[REDACTED:<class>]`. Secrets that would constitute a
 *   security incident if exfiltrated.
 *     - BIP39 mnemonic phrases (12/15/18/21/24-word sequences, heuristic)
 *     - Private keys (labelled hex / labelled base58 / raw 64-hex after key label)
 *     - Bearer tokens / API keys (well-known prefixes: sk-, sk_live_, sk-or-, sk-ant-, ...)
 *     - JWT
 *
 * Tier 2 — MASK
 *   Identifier shape preserved (`0xabcd…1234`) so downstream context still
 *   carries the semantic role. Reversible by structured queries.
 *     - Ethereum / EVM addresses (0x + 40 hex)
 *     - Solana addresses (base58 32-44 chars)
 *     - Transaction hashes (0x + 64 hex) and base58 signatures
 *
 * Counts of redactions per tier are reported alongside the redacted text so
 * callers can decide whether the payload retains enough signal to embed /
 * persist / surface, and whether to flag a high-redaction-count event.
 *
 * The Tier 1 / Tier 2 shape patterns below are the canonical source for
 * `./secret-detectors.ts`'s shared low-level regexes — this module imports
 * them back so there is exactly one definition of each shape. This is a
 * move-only extraction: the regex sources and application order here are
 * unchanged, so this module's behavior (and its existing test suite) is
 * unaffected.
 */

import {
  API_KEY_PREFIX_RE,
  BIP39_HEURISTIC_RE,
  EVM_ADDRESS_RE,
  findBip39MnemonicRun,
  JWT_RE,
  PRIVATE_KEY_LABELLED_RE,
  RAW_HEX_KEY_RE,
  SOLANA_ADDRESS_RE,
  TX_HASH_HEX_RE,
} from "./secret-detectors.js";

export interface RedactionResult {
  text: string;
  hardRedactCount: number;
  maskCount: number;
}

const HARD_PLACEHOLDER = "[REDACTED:";

// ── Public API ──────────────────────────────────────────────────

/**
 * Apply both redaction tiers to `text`. Returns the redacted output plus
 * counts for telemetry / chunk-rejection decisions.
 */
export function redact(text: string): RedactionResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", hardRedactCount: 0, maskCount: 0 };
  }

  let hardCount = 0;
  let maskCount = 0;
  let out = text;

  // Tier 1 first — labelled private keys.
  out = out.replace(PRIVATE_KEY_LABELLED_RE, () => {
    hardCount++;
    return `[REDACTED:private_key]`;
  });
  out = out.replace(RAW_HEX_KEY_RE, () => {
    hardCount++;
    return `[REDACTED:private_key]`;
  });
  out = out.replace(API_KEY_PREFIX_RE, () => {
    hardCount++;
    return `[REDACTED:api_key]`;
  });
  out = out.replace(JWT_RE, () => {
    hardCount++;
    return `[REDACTED:jwt]`;
  });
  out = out.replace(BIP39_HEURISTIC_RE, (match) => {
    // The 12-24-word shape alone also matches ordinary prose. Redact only
    // the run of real BIP39 wordlist words inside the match, and leave any
    // surrounding prose the greedy shape regex swallowed intact.
    const run = findBip39MnemonicRun(match);
    if (run === null) return match;
    hardCount++;
    return `${match.slice(0, run.start)}[REDACTED:mnemonic]${match.slice(run.end)}`;
  });

  // Tier 2 masks. Order: tx-hash first (longer), then EVM address (shorter),
  // then Solana (different alphabet).
  out = out.replace(TX_HASH_HEX_RE, (match) => {
    if (match.startsWith("[REDACTED:")) return match;
    maskCount++;
    return maskHex(match);
  });
  out = out.replace(EVM_ADDRESS_RE, (match) => {
    if (match.startsWith("[REDACTED:")) return match;
    maskCount++;
    return maskHex(match);
  });
  out = out.replace(SOLANA_ADDRESS_RE, (match) => {
    // Skip if the match is inside a redacted placeholder
    if (out.indexOf(HARD_PLACEHOLDER) >= 0 && out.includes(match) === false) {
      return match;
    }
    maskCount++;
    return maskBase58(match);
  });

  return { text: out, hardRedactCount: hardCount, maskCount };
}

/** `0xabcdef0123…1234` — preserves shape so the LLM still sees an address-like token. */
function maskHex(raw: string): string {
  if (raw.length <= 12) return raw;
  const prefix = raw.startsWith("0x") ? raw.slice(0, 6) : raw.slice(0, 4);
  const suffix = raw.slice(-4);
  return `${prefix}…${suffix}`;
}

/** `Abc…1234` style for base58 strings. */
function maskBase58(raw: string): string {
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/**
 * Apply redaction to every string field of an object (and string elements
 * of any array values). Returns a new object with the same keys; counts are
 * summed across all fields.
 *
 * Shallow: arrays of objects are passed through unchanged. Use `redactBugPayload`
 * in `./redactor.ts` for deep recursive redaction over diagnostic JSON.
 */
export function redactObject<T extends Record<string, unknown>>(
  input: T,
): { value: T; hardRedactCount: number; maskCount: number } {
  let hardTotal = 0;
  let maskTotal = 0;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    const v = input[key];
    if (typeof v === "string") {
      const r = redact(v);
      out[key] = r.text;
      hardTotal += r.hardRedactCount;
      maskTotal += r.maskCount;
    } else if (Array.isArray(v)) {
      const arr = v.map((item) => {
        if (typeof item === "string") {
          const r = redact(item);
          hardTotal += r.hardRedactCount;
          maskTotal += r.maskCount;
          return r.text;
        }
        return item;
      });
      out[key] = arr;
    } else {
      out[key] = v;
    }
  }

  return { value: out as T, hardRedactCount: hardTotal, maskCount: maskTotal };
}
