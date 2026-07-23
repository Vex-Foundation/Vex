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

import { VexError } from "../../../../errors.js";

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
const SENSITIVE_FRAGMENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // URLs — provider endpoints often carry tokens/ids in path or query.
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
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

/** Coarse, non-sensitive classification from the error's shape/text. */
export function classifyError(raw: string, err: unknown): ErrorCategory {
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
 * Reduce any thrown value to a `{ category, message }` summary that is safe to
 * log, return to the agent, and forward to the renderer. Bounded + redacted.
 */
export function summarizeProtocolError(err: unknown): SafeErrorSummary {
  const raw = err instanceof Error ? err.message : String(err);
  const category = classifyError(raw, err);

  // A VexError carries an authored, agent-actionable `hint` (e.g. "Pass the exact
  // contract address the quote returned, then retry."). Fold it into the SAME
  // redaction pipeline as the message, CONCATENATED BEFORE the cap — so the hint
  // is secret-redacted, internals-stripped (URLs/bodies/auth), and length-bounded
  // exactly like the message, never appended raw after the cap (B-003). Category
  // is classified on the message alone. Non-VexError throws are byte-unchanged.
  const hint = err instanceof VexError ? err.hint?.trim() : undefined;
  const combined = hint ? `${raw} — ${hint}` : raw;

  // Defense-in-depth, applied in order (FIX4-SPINE C37 hardened steps 2-3):
  //  1. redact known SECRET shapes (keys, JWTs, mnemonics, addresses),
  //  2. remove whole embedded HTML documents (gateway/proxy error pages),
  //  3. remove balanced/nested {..}/[..] bodies (JSON request/response payloads),
  //  4. strip remaining structured provider INTERNALS (URLs, auth headers,
  //     Bearer tokens, key/token/secret assignments) the B-003 note forbids
  //     emitting — placeholder-replaced, not just secret-matched,
  //  5. collapse whitespace and hard-cap the length (UNCHANGED cap semantics).
  // We never trust the provider not to embed internals, so we keep only this
  // bounded summary regardless of what the raw text contained.
  let cleaned = redact(combined).text;
  for (const [pattern, replacement] of HTML_DOCUMENT_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = stripBalancedBodies(cleaned);
  for (const [pattern, replacement] of SENSITIVE_FRAGMENT_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  const bounded = cleaned.length > MAX_SAFE_ERROR_MESSAGE
    ? `${cleaned.slice(0, MAX_SAFE_ERROR_MESSAGE)}…`
    : cleaned;

  const summary: SafeErrorSummary = { category, message: bounded || category };
  return err instanceof VexError && err.retryable === true
    ? { ...summary, retryable: true }
    : summary;
}
