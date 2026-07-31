/**
 * Shared LOW-LEVEL secret-shape detectors.
 *
 * Pure pattern-matching only — no redaction POLICY (placeholder text, mask
 * format, hard-vs-soft classification, which fields get touched) lives
 * here. Each consumer owns its own policy on top of these shapes, because
 * Vex's redaction contracts are deliberately independent per surface:
 *   - `./text-redaction.ts` — two-tier (hard-redact / mask) prose redactor
 *     for the memory layer + diagnostic payloads. Imports these regexes
 *     directly (move-only extraction; behavior unchanged, see its tests).
 *   - `vex-app/src/main/database/messages/redaction.ts` — renderer tool-arg
 *     disclosure. Deliberately NOT wired to this module: its regexes are
 *     `^...$`-anchored whole-VALUE tests (a scalar tool-arg either IS a
 *     secret or ISN'T), not `/g`-flagged substring extraction over free
 *     prose. Anchored-vs-substring is a real semantic difference, not just
 *     a formatting one, so sharing the regex objects would risk silently
 *     changing which values that surface treats as secrets.
 *   - `vex-app/src/main/sessions/export-redaction.ts` — the session
 *     Markdown export's own conservative policy, built on these detectors
 *     plus `OPEN_ENDED_BASE64_CANDIDATE_RE` below.
 *
 * Every regex here operates over free-flowing prose (substring extraction,
 * global flag). Build a fresh `^...$`-anchored regex from a pattern's
 * `.source` instead of reusing these directly when testing a single
 * whole-string scalar value.
 */

import { BIP39_ENGLISH_WORDS } from "./bip39-english-wordlist.js";

// ── Hard-secret shapes ──────────────────────────────────────────────────

/**
 * Labelled private/seed/wallet/secret key: a key-ish word, `:` or `=`,
 * then 40-128 hex chars (optionally `0x`-prefixed, optionally quoted).
 */
export const PRIVATE_KEY_LABELLED_RE =
  /(private[_\s-]?key|seed[_\s-]?key|wallet[_\s-]?key|secret[_\s-]?key)\s*[:=]\s*['"`]?(0x)?[a-fA-F0-9]{40,128}['"`]?/gi;

/** Bare 64-hex without `0x` prefix following a key-ish label. */
export const RAW_HEX_KEY_RE =
  /(private[_\s-]?key|seed[_\s-]?key)\s*[:=]\s*[a-fA-F0-9]{64}/gi;

/** Known API key prefixes (OpenRouter, Anthropic, Stripe-shaped, etc.). */
export const API_KEY_PREFIX_RE =
  /\b(sk-[a-zA-Z0-9_-]{20,}|sk_live_[a-zA-Z0-9_-]{20,}|sk_test_[a-zA-Z0-9_-]{20,}|pk_live_[a-zA-Z0-9_-]{20,}|pk_test_[a-zA-Z0-9_-]{20,}|sk-or-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,})\b/g;

/** JWT: three base64url segments separated by dots. */
export const JWT_RE =
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;

/**
 * BIP39 mnemonic SHAPE pre-filter — 12-24 lowercase 3-8 char words.
 *
 * Shape alone is not evidence of a mnemonic: ordinary English prose hits it
 * routinely (reproduced 2026-07-30: "I want stable quotes here before agent
 * tries again since kyber gave that pre-sign gas estimate error" matched a
 * 12-word run and was hard-redacted). Callers MUST confirm a match with
 * `findBip39MnemonicRun` before redacting, and redact only the range it
 * returns.
 */
export const BIP39_HEURISTIC_RE = /\b(?:[a-z]{3,8}\s){11,23}[a-z]{3,8}\b/g;

/** Shortest phrase BIP39 defines (128-bit entropy). */
const MIN_MNEMONIC_WORDS = 12;

/**
 * Locate the mnemonic inside a `BIP39_HEURISTIC_RE` match, or return `null`
 * when the match carries no mnemonic evidence at all.
 *
 * Evidence is wordlist membership: every word of a real phrase comes from
 * the standard 2048-word English BIP39 list, which ordinary prose does not
 * satisfy for 12 words in a row. The returned range is the longest run of
 * >= 12 consecutive wordlist words — a range rather than a boolean because
 * the shape regex is greedy and routinely swallows leading prose words
 * ("here the seed <12 words>"); redacting the whole match would destroy that
 * prose, and requiring the WHOLE match to be wordlist words would let a real
 * phrase escape whenever a non-wordlist word abutted it.
 *
 * Offsets are relative to `match`.
 */
export function findBip39MnemonicRun(
  match: string,
): { start: number; end: number } | null {
  let best: { start: number; end: number; words: number } | null = null;
  let run: { start: number; end: number; words: number } | null = null;

  for (const word of match.matchAll(/[a-z]+/g)) {
    if (!BIP39_ENGLISH_WORDS.has(word[0])) {
      run = null;
      continue;
    }
    const end = word.index + word[0].length;
    run =
      run === null
        ? { start: word.index, end, words: 1 }
        : { start: run.start, end, words: run.words + 1 };
    if (run.words >= MIN_MNEMONIC_WORDS && (best === null || run.words > best.words)) {
      best = run;
    }
  }

  return best === null ? null : { start: best.start, end: best.end };
}

// ── Public-identifier shapes (mask, don't hard-redact) ──────────────────

/** Ethereum/EVM address: `0x` + 40 hex. */
export const EVM_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;

/** Transaction hash: `0x` + 64 hex. Also matches an unlabelled raw private
 *  key in hex form — callers that hard-redact labelled keys first (see
 *  `PRIVATE_KEY_LABELLED_RE`) avoid that ambiguity for the labelled case. */
export const TX_HASH_HEX_RE = /\b0x[a-fA-F0-9]{64}\b/g;

/** Solana address: base58, 32-44 chars (base58 excludes `0OIl`). */
export const SOLANA_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// ── Open-ended base64 secret candidate ───────────────────────────────────

/**
 * Open-ended base64 secret-blob candidate: a run of >=20 base64-alphabet
 * characters (the alphanumeric core, NOT counting `=` padding) plus up to
 * two trailing `=` padding chars.
 *
 * Replaces a fixed `{86}`-length pattern that only matched one exact byte
 * length. 20 core chars is the alphanumeric length of a base64-encoded
 * 16-byte secret after its 2 padding chars are excluded — the shortest
 * length this module is expected to catch — so this floor is deliberately
 * low enough to cover 16-through-72-byte encoded secrets in one pattern.
 *
 * This regex is a pure SHAPE match — it also matches base58 strings (a
 * Solana address is well within the base64 alphabet). Callers MUST run
 * `looksLikeBase64Secret` on every candidate before treating it as a
 * secret; see that function for why the combination is safe.
 *
 * Bounded with lookaround, not `\b`: `+` and `/` are not `\w` characters,
 * so a secret that happens to start or end with one of them (a real
 * possibility — base64 output is effectively uniform over its alphabet)
 * would sit on a non-word/non-word boundary where `\b` never matches.
 */
export const OPEN_ENDED_BASE64_CANDIDATE_RE =
  /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9+/=])/g;

/** A candidate that is entirely `0x` + hex digits is an EVM address/tx-hash
 *  shape (already covered by `EVM_ADDRESS_RE` / `TX_HASH_HEX_RE`), not a
 *  base64 secret — exempt it regardless of length. */
const HEX_IDENTIFIER_RE = /^0x[a-fA-F0-9]+$/;

/**
 * Classify an `OPEN_ENDED_BASE64_CANDIDATE_RE` match as a likely real
 * base64-encoded secret rather than a public base58 identifier (Solana
 * address or transaction signature).
 *
 * Base64's alphabet and base58's alphabet share 58 characters; the 6 that
 * are base64-only are `+`, `/`, `=`, and the 3 letters/digit base58
 * excludes to avoid visual ambiguity (`0`, `O`, `I`, `l`). A genuine
 * base58 string can never contain any of the 6, so requiring at least one
 * turns "could this be a Solana address instead" from a length-based guess
 * into a structural impossibility for real base58 material — the
 * candidate is guaranteed not to be valid base58.
 *
 * Trade-off: a base64 secret that, by chance, uses only the 58 shared
 * characters is missed. That is accepted here (and only here — this is a
 * base64-specific heuristic, not a general secret classifier) because the
 * alternative — flagging on shape alone — would also flag every long
 * Solana address or transaction signature the export is supposed to keep
 * readable.
 */
export function looksLikeBase64Secret(candidate: string): boolean {
  if (HEX_IDENTIFIER_RE.test(candidate)) return false;
  return /[+/=0OIl]/.test(candidate);
}
