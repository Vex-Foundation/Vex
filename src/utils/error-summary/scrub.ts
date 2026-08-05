/**
 * The sanitizer half of `../error-summary.ts` (B-003): every step that removes
 * bytes from a thrown error before it may reach a tool output, a structured
 * log, or the renderer.
 *
 * Extracted verbatim as part of a façade-preserving structural split (SPEC
 * wave 0R.1) and moved here with the rest of the pipeline to neutral ground.
 * `../error-summary.ts` remains the public entry point; nothing outside this
 * folder imports this file directly except its siblings.
 */

import { redact } from "../../lib/diagnostics/text-redaction.js";

/**
 * The message-body cap. Raised 200 → 320 in W1 (SPEC §1.5): 200 is too tight
 * once a stable code, an HTTP status, a provider sentence and a field-level
 * reason must coexist. The remediation is still appended OUTSIDE the cap.
 */
export const MAX_SAFE_ERROR_MESSAGE = 320;

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
  // Long hex blobs — calldata, signatures, raw tx payloads a node/SDK echoes
  // back inside its error. `redact()` above already masks the two hex shapes
  // that carry IDENTITY (0x+40 address, 0x+64 tx hash) and deliberately keeps
  // their shape; both are `\b`-anchored, so neither matches a blob LONGER than
  // 64 hex, which is exactly what a reverted-calldata dump is. Absorbed here
  // from `trench/handlers/failure.ts` (owner decree 2026-08-02) when that
  // venue's byte-clone sanitizer was routed through this module: the guarantee
  // it held must not be lost by the consolidation, and every other venue gains
  // it. 80 (not 65) keeps the threshold clear of any near-hash-length shape.
  [/\b0x[a-fA-F0-9]{80,}/gi, "[hex]"],
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
 * A link that cannot carry a credential: `https`, a plain host, an optional
 * path, and NOTHING else — no userinfo (`user:pass@`), no query, no fragment.
 * Those three are where a token rides in a URL, so a link without them leaks
 * nothing by surviving. Used ONLY by the hint lane (see `scrub`).
 */
const CREDENTIAL_FREE_HTTPS_LINK =
  /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[a-z0-9._~%-]*)*\/?$/i;

/** Every URL collapses — the message may be provider-written, so nothing survives. */
export function redactEveryUrl(): string {
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
export function redactUnlessCredentialFreeLink(match: string): string {
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
export function scrub(text: string, urlReplacement: (match: string) => string): string {
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

/** Whitespace collapse + the hard cap, applied to message and hint JOINTLY. */
export function collapseAndCap(combined: string): string {
  const cleaned = combined.replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_SAFE_ERROR_MESSAGE
    ? `${cleaned.slice(0, MAX_SAFE_ERROR_MESSAGE)}…`
    : cleaned;
}
