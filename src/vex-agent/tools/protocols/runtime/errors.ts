/**
 * Provider-safe error normalization/redaction (B-003) for the protocol runtime.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. A thrown handler/provider/SDK error can embed URLs,
 * request/response bodies, auth headers, and key material — none of which may
 * reach the tool output, the structured logs, or the renderer. This module is
 * the single owner of that redaction.
 *
 * `summarizeProtocolError(err).message` is the ONE sufficient entry point
 * (FIX4-SPINE C37 — Codex final-review round 3 finding 1): every venue's
 * output/log/persisted-reason text must route through it rather than through
 * a venue-local preprocessor, so a scrub-core fix (like this round's
 * Bearer-ordering / HTML-document / balanced-body hardening) protects every
 * caller at once instead of needing to be re-applied per venue.
 */

import { redact } from "@vex-agent/memory/redaction.js";

import { VexError, ErrorCodes } from "../../../../errors.js";

// ── Provider-safe error summarisation (B-003) ────────────────────
//
// A thrown handler error (or any provider/SDK error) can embed URLs, request /
// response bodies, auth headers, and key material. NONE of that may reach the
// tool output, the structured logs, or (downstream) the renderer. We emit ONLY:
//   - a coarse cause CATEGORY (transient vs permanent classification signal),
//   - a bounded message that has been run through the secret redactor AND
//     stripped of URLs, then length-capped.
// The original error is never logged or returned verbatim.

export type ErrorCategory =
  | "timeout"
  | "network"
  | "rate_limit"
  | "auth"
  /**
   * WE rejected the call before (or instead of) trusting it — a parameter the
   * caller or the model supplied did not survive our own validation. Distinct
   * from `provider_error` because the two imply opposite next actions: a
   * provider malfunction invites a retry, a bad parameter invites a FIX. Live
   * proof of the confusion this removes (2026-07-24): `uniswap.swap.quote
   * failed (provider_error): Cannot read decimals for 0x0000…0000 — not a
   * valid ERC-20 contract on this chain` — our own address validation,
   * reported to the agent as the provider's malfunction.
   */
  | "invalid_request"
  /**
   * A VEX SAFETY POLICY refused the call — our own money-path guard looked at
   * what was about to be signed and declined. Nothing was sent to the venue,
   * so nothing about the venue is being reported. Distinct from
   * `provider_error` for the same reason `invalid_request` is: labelling the
   * calldata price floor, the unsafe-build abort, or the provider-gas-limit
   * ceiling as a provider malfunction tells the agent to retry a trade Vex
   * stopped deliberately — and the retry reproduces it every time, because
   * nothing about the venue was ever wrong.
   *
   * Attribution ONLY. Whether retrying helps is `retryable`'s job; a refusal
   * can be either, and the two must not be read off one another.
   */
  | "policy_refusal"
  | "provider_error"
  | "unknown";

export interface SafeErrorSummary {
  readonly category: ErrorCategory;
  readonly message: string;
  /**
   * Present and `true` only when a thrown `VexError` marked itself retryable.
   * Surfaced to the agent as a "(retryable)" suffix so it knows a retry is sane.
   */
  readonly retryable?: boolean;
}

const MAX_SAFE_ERROR_MESSAGE = 200;

// Whole embedded HTML documents (gateway/proxy error pages, e.g. an nginx/
// Cloudflare 502 page a provider's fetch client surfaced verbatim) — removed
// FIRST, in one shot, via plain regex (FIX4-SPINE C37 — Codex final-review
// round 3 finding 1). An HTML document has exactly one canonical <html>/
// </html> pair, unlike JSON bodies, so no balanced-nesting concern applies
// here. The DOCTYPE variant has no length limit on its tail (a truncated
// dump may never reach a closing </html>), so it consumes to end-of-string;
// the bare <html>/<body> variants require a real closing tag (non-greedy —
// stops at the FIRST close) to avoid swallowing unrelated trailing text that
// merely happens to contain a stray "<html"/"<body".
// Placeholder deliberately uses PARENS, not brackets: `stripBalancedBodies`
// runs immediately after this step and would otherwise treat a bracketed
// "[html]" placeholder as its own balanced `[..]` span and re-consume it.
//
// FAIL-CLOSED fallback (FIX5-SPINE — Codex final-review round 4 finding 1,
// :66): a TRUNCATED bare `<html`/`<body` — no matching close ANYWHERE in the
// text — previously matched NEITHER pattern above and was emitted verbatim.
// By the time the fallback pattern runs, every PROPERLY CLOSED span has
// already been consumed by the two patterns above, so any `<html`/`<body`
// still present is unclosed by definition; the fallback drops it and
// everything after it to end-of-string, same fail-safe posture as the
// DOCTYPE variant (prefer removing too much over emitting raw markup).
const HTML_DOCUMENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<!doctype\s+html\b[\s\S]*/gi, "(html)"],
  [/<html\b[\s\S]*?<\/html>/gi, "(html)"],
  [/<body\b[\s\S]*?<\/body>/gi, "(html)"],
  [/<(?:html|body)\b[\s\S]*/gi, "(html)"],
];

// Structured/sensitive fragments stripped from the message BEFORE it is
// surfaced anywhere. These cover the provider/SDK internals the B-003 note
// forbids emitting (URLs, request/response bodies, auth) while leaving short
// human-readable error phrases (e.g. "network down") intact. Each replaces the
// offending span with a coarse placeholder rather than deleting it, so the
// summary still signals "an internal was removed here".
//
// Ordering is load-bearing (FIX4-SPINE C37 — Codex final-review round 3
// finding 1): the Bearer pattern MUST run BEFORE the header-name pattern.
// The header-name pattern's value-match ALSO had to become fail-closed to
// end-of-line/segment (FIX5-SPINE — Codex final-review round 4 finding 1,
// :92): it originally consumed only ONE whitespace-delimited token (`\S+`),
// so on "Authorization: Bearer <tok>" it previously matched "Authorization:
// Bearer" ALONE (turning it into "[auth]") and left the raw "<tok>" sitting
// immediately after, unmatched by anything downstream — reproduced verbatim
// by Codex as "Authorization: Bearer ROUND3_CANARY_7f3b" →
// "[auth] ROUND3_CANARY_7f3b". The SAME one-token limit ALSO leaked
// multi-part values: "Authorization: Basic <base64>" (the scheme word
// "Basic" ate the token slot, leaving the base64 credential raw) and
// "Cookie: a=1; b=2" (only "a=1;" was consumed, leaving "b=2" raw). Running
// Bearer first still consumes "Bearer <tok>" as one unit; the header-name
// pattern's value now consumes the REST OF THE LINE (`[^\r\n]+`, not just one
// token) so no multi-word scheme or multi-part value can leave a raw tail —
// consistent with this module's "prefer removing too much" posture.
//
// The URL pattern is applied SEPARATELY, immediately before this list, because
// the two lanes below disagree about URLs and about nothing else. Its position
// in the pipeline is unchanged: it still runs first, so the Bearer-before-
// header-name ordering documented above still holds.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const SENSITIVE_FRAGMENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer tokens — BEFORE the header-name pattern below. See ordering note above.
  [/\bbearer\s+\S+/gi, "[auth]"],
  // Auth headers (header: value OR header=value) — value consumes to
  // end-of-line/segment, not just one token. See fail-closed note above.
  [/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "[auth]"],
  // Key/secret/token ASSIGNMENTS (key=value shape) — single-token value is
  // the established convention for this shape (unlike headers, an assignment
  // is not observed to carry multi-part semicolon-separated values).
  [/\b(api[_-]?key|apikey|access[_-]?token|secret|password|passwd|pwd|token|key)\s*[:=]\s*\S+/gi, "[auth]"],
];

/**
 * Remove a balanced/nested `{..}`/`[..]` body span, replacing the WHOLE span
 * — however deeply nested — with a single `[body]` placeholder (FIX4-SPINE
 * C37 — Codex final-review round 3 finding 1). The previous single regex
 * (`[{[][^{}[\]]*[}\]]`) EXCLUDES braces/brackets from its own body, so it
 * can only ever match ONE level: for `{"a": {"b": 1}}` it matched just the
 * inner `{"b": 1}`, replaced it with `[body]`, and left the outer `{"a": ` +
 * `}` — real, unredacted payload structure — sitting in the output. JS regex
 * has no native balanced-match/recursion support, so this scans depth
 * manually instead. An unbalanced/truncated span (never reaches depth 0)
 * consumes to end-of-string, matching this module's general fail-safe
 * posture: prefer removing too much over leaking a partial dump.
 *
 * QUOTE/ESCAPE-AWARE (FIX5-SPINE — Codex final-review round 4 finding 1,
 * :109): the depth counter must NOT count a `{`/`[`/`}`/`]` that appears
 * INSIDE a JSON string VALUE — e.g. `{"message":"secret ] after"}` has a
 * literal `]` inside the string, which the naive counter treated as a real
 * closing delimiter, ending the scan early and leaking the tail
 * (` after"}`) as raw, unredacted text. This tracks whether the scan is
 * currently inside a double-quoted string and, while inside one, ignores
 * bracket/brace characters entirely; a backslash inside a string escapes
 * the NEXT character (so `\"` never ends the string, and `\\` — an escaped
 * backslash — is consumed as one two-character unit rather than letting the
 * following character be mis-treated as its own escape).
 */
function stripBalancedBodies(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      let depth = 1;
      let j = i + 1;
      let inString = false;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (inString) {
          if (c === "\\") {
            j += 2; // skip the escaped character entirely (handles \" and \\)
            continue;
          }
          if (c === "\"") inString = false;
          j++;
          continue;
        }
        if (c === "\"") inString = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
        j++;
      }
      out += "[body]";
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Error codes this repo throws from its OWN validation of caller/model-supplied
 * parameters — an address that is not an address, an amount that is not an
 * amount, a chain we do not serve, a token contract that does not answer
 * `decimals()`. Deliberately a CLOSED, small set: a code that is ALSO used to
 * carry a provider's verdict must stay out of it unless the provider-answered
 * case is separable, which `isLocallyAuthoredValidationFailure` handles below.
 *
 * `KYBER_TOKEN_NOT_FOUND` is in the set despite being reachable from both
 * sides: locally from `uniswap/erc20.ts`, `kyberswap/evm/erc20.ts` and
 * `kyberswap/helpers.ts`, and from KyberSwap's own code 4011 via
 * `mapAggregatorError` — which always stamps `externalName`, the discriminator
 * used below.
 */
const LOCAL_VALIDATION_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ErrorCodes.AGENT_VALIDATION_ERROR,
  ErrorCodes.INVALID_ADDRESS,
  ErrorCodes.SOLANA_INVALID_ADDRESS,
  ErrorCodes.INVALID_AMOUNT,
  ErrorCodes.CHAIN_MISMATCH,
  ErrorCodes.INVALID_SPENDER,
  ErrorCodes.KYBER_TOKEN_NOT_FOUND,
]);

/**
 * Error codes thrown by Vex's OWN money-path safety gates — a guard that
 * inspected what was about to be signed and refused. Nothing reaches the venue
 * on any of these paths, so none of them can carry a provider's opinion.
 *
 * Same CLOSED-set discipline as `LOCAL_VALIDATION_ERROR_CODES`, and the same
 * admission test: a code stays out unless every throw site in the tree is a
 * gate WE authored. That test excludes, for example,
 * `KYBER_FEE_EXCEEDS_AMOUNT` (produced by `mapAggregatorError` from KyberSwap's
 * own response) and `PENDLE_VALUATION_TOO_LOW/HIGH` (Pendle's 400 body,
 * re-worded by `tools/pendle/errors.ts`) — those are provider verdicts wearing
 * a Vex code.
 *
 * Distinct from `LOCAL_VALIDATION_ERROR_CODES`, which covers a BAD PARAMETER
 * ("fix your input"); these cover a REFUSAL of a well-formed request ("the
 * trade itself was not safe to sign").
 */
const POLICY_REFUSAL_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  // KyberSwap calldata guard: built `minReturnAmount` below the approved floor.
  ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED,
  // KyberSwap calldata guard: non-price divergence (router/spender/value/fee/flags).
  ErrorCodes.KYBER_UNSAFE_BUILD,
  // `tools/evm-chains/gas-limit-headroom.ts`: provider's gas limit far above our own estimate.
  ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE,
  // `tools/evm-chains/native-value-authorization`: tx.value not attributable to proven costs.
  ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
  // Pendle calldata guard + redeem fallback — the Pendle sibling of KYBER_UNSAFE_BUILD.
  ErrorCodes.PENDLE_UNSAFE_TX,
  // `solana-transaction/prepare.ts`: strict sole-signer check refused to sign.
  ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
  // `solana-transaction/prepare.ts`: blockhash evidence does not match the transaction.
  ErrorCodes.SOLANA_TX_BLOCKHASH_MISMATCH,
]);

/**
 * Evidence that a provider ANSWERED, which outranks any code we attached.
 * These two are the repo's only markers of a provider verdict: `httpStatus` is
 * set exclusively by `utils/http.ts` on a non-ok response, and `externalName`
 * exclusively by a provider error mapper (Khalani, KyberSwap) or by a
 * provider-supplied error code lifted from a response body.
 */
function carriesProviderVerdict(err: VexError): boolean {
  return err.httpStatus !== undefined || err.externalName !== undefined;
}

/**
 * True only when WE authored the rejection. Conservative by construction: any
 * evidence that a provider ANSWERED disqualifies the error, and an unrecognized
 * code keeps today's label rather than guessing.
 */
function isLocallyAuthoredValidationFailure(err: unknown): boolean {
  if (!(err instanceof VexError)) return false;
  if (carriesProviderVerdict(err)) return false;
  return LOCAL_VALIDATION_ERROR_CODES.has(err.code);
}

/** True only when one of Vex's own safety gates refused, with no provider verdict attached. */
function isVexAuthoredPolicyRefusal(err: unknown): boolean {
  if (!(err instanceof VexError)) return false;
  if (carriesProviderVerdict(err)) return false;
  return POLICY_REFUSAL_ERROR_CODES.has(err.code);
}

/** Coarse, non-sensitive classification from the error's shape/text. */
export function classifyError(raw: string, err: unknown): ErrorCategory {
  // Checked FIRST, ahead of the text heuristics: a typed code we ourselves
  // attached is direct evidence of who rejected the call, whereas the keyword
  // scans below are guesses about prose that a provider may have written.
  // The two sets are disjoint, so their order relative to each other is not
  // load-bearing — only their position ahead of the scans is.
  if (isLocallyAuthoredValidationFailure(err)) return "invalid_request";
  if (isVexAuthoredPolicyRefusal(err)) return "policy_refusal";
  const name = err instanceof Error ? err.name.toLowerCase() : "";
  const text = raw.toLowerCase();
  if (name.includes("abort") || text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (text.includes("rate limit") || text.includes("429") || text.includes("too many requests")) {
    return "rate_limit";
  }
  if (text.includes("unauthorized") || text.includes("forbidden") || text.includes("401") || text.includes("403")) {
    return "auth";
  }
  if (
    name.includes("fetch")
    || text.includes("econn")
    || text.includes("enotfound")
    || text.includes("network")
    || text.includes("socket")
  ) {
    return "network";
  }
  if (err instanceof Error) return "provider_error";
  return "unknown";
}

/**
 * A link that cannot carry a credential: `https`, a plain host, an optional
 * path, and NOTHING else — no userinfo (`user:pass@`), no query, no fragment.
 * Those three are where a token rides in a URL, so a link without them leaks
 * nothing by surviving. Used ONLY by the hint lane (see `scrub`).
 */
const CREDENTIAL_FREE_HTTPS_LINK =
  /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[a-z0-9._~%-]*)*\/?$/i;

/** Every URL collapses — the message may be provider-written, so nothing survives. */
function redactEveryUrl(): string {
  return "[url]";
}

/**
 * Hint lane: keep a credential-free https link, collapse anything else.
 *
 * WHY THE LANES DIFFER. A `VexError.hint` is FIRST-PARTY text — every hint in
 * this repo is a literal authored beside its `throw` (see `jupiter-auth.ts`,
 * `khalani/errors.ts`, `kyberswap/aggregator/errors.ts`); provider prose lands
 * in the MESSAGE, never here. Redaction exists to protect secrets and untrusted
 * provider text, and it was doing neither when it turned "Generate a key at
 * https://portal.jup.ag and add it through Vex setup" into "…at [url]…": the
 * agent was handed an instruction it had been made unable to follow.
 *
 * WHERE THE LINE IS DRAWN, and why it holds even if a hint were ever built from
 * untrusted text: the carve-out is a property of the LINK, not of who wrote it.
 * A link with no userinfo, no query and no fragment has nowhere to put a
 * credential, and `redact()` has already run over the whole hint, so a
 * key-shaped path segment is gone before this is reached. Everything else —
 * and every URL in the message lane — still collapses to `[url]`.
 */
function redactUnlessCredentialFreeLink(match: string): string {
  // A sentence-final "." or "," belongs to the prose, not the link; strip it
  // before judging, then give it back, so ordinary punctuation cannot force an
  // otherwise-safe link to be redacted.
  const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
  const link = trailing ? match.slice(0, match.length - trailing.length) : match;
  return CREDENTIAL_FREE_HTTPS_LINK.test(link) ? `${link}${trailing}` : "[url]";
}

/**
 * Defense-in-depth, applied in order (FIX4-SPINE C37 hardened steps 2-3):
 *  1. redact known SECRET shapes (keys, JWTs, mnemonics, addresses),
 *  2. remove whole embedded HTML documents (gateway/proxy error pages),
 *  3. remove balanced/nested {..}/[..] bodies (JSON request/response payloads),
 *  4. strip remaining structured provider INTERNALS (URLs, auth headers,
 *     Bearer tokens, key/token/secret assignments) the B-003 note forbids
 *     emitting — placeholder-replaced, not just secret-matched.
 * We never trust the provider not to embed internals, so we keep only this
 * bounded summary regardless of what the raw text contained.
 *
 * `urlReplacement` is the ONLY difference between the two lanes; every other
 * step, and their order, is identical for message and hint.
 */
function scrub(text: string, urlReplacement: (match: string) => string): string {
  let cleaned = redact(text).text;
  for (const [pattern, replacement] of HTML_DOCUMENT_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = stripBalancedBodies(cleaned);
  cleaned = cleaned.replace(URL_PATTERN, urlReplacement);
  for (const [pattern, replacement] of SENSITIVE_FRAGMENT_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned;
}

/**
 * Reduce any thrown value to a `{ category, message }` summary that is safe to
 * log, return to the agent, and forward to the renderer. Bounded + redacted.
 */
export function summarizeProtocolError(err: unknown): SafeErrorSummary {
  const raw = err instanceof Error ? err.message : String(err);
  const category = classifyError(raw, err);

  // A VexError carries an authored, agent-actionable `hint` (e.g. "Pass the exact
  // contract address the quote returned, then retry."). It is scrubbed on its own
  // lane and CONCATENATED BEFORE the cap — so the hint is secret-redacted,
  // internals-stripped, and length-bounded exactly like the message, never
  // appended raw after the cap (B-003). Category is classified on the message
  // alone. Non-VexError throws are byte-unchanged.
  const hint = err instanceof VexError ? err.hint?.trim() : undefined;
  const scrubbedMessage = scrub(raw, redactEveryUrl);
  const scrubbedHint = hint ? scrub(hint, redactUnlessCredentialFreeLink) : undefined;
  const combined = scrubbedHint ? `${scrubbedMessage} — ${scrubbedHint}` : scrubbedMessage;

  // Whitespace collapse + hard cap run on the JOINED text (UNCHANGED cap
  // semantics): the bound covers message and hint together, so a long hint can
  // never smuggle text past the limit.
  const cleaned = combined.replace(/\s+/g, " ").trim();
  const bounded = cleaned.length > MAX_SAFE_ERROR_MESSAGE
    ? `${cleaned.slice(0, MAX_SAFE_ERROR_MESSAGE)}…`
    : cleaned;

  const summary: SafeErrorSummary = { category, message: bounded || category };
  return err instanceof VexError && err.retryable === true
    ? { ...summary, retryable: true }
    : summary;
}
