/**
 * The session Markdown export's own redaction policy.
 *
 * Deliberately NOT unified with `@vex-lib/diagnostics/text-redaction.js` or
 * `../database/messages/redaction.js` — each surface's policy contract is
 * independent (see `@vex-lib/diagnostics/secret-detectors.js`'s module
 * doc for why). This one is intentionally the most conservative of the
 * three: an export can include ARCHIVED historical content, which is
 * exactly where old accidental secret exposure lives, so it prefers
 * over-redaction to leakage.
 *
 * Policy, built on the shared low-level shapes:
 *   - Tier 1 secret shapes (labelled private keys, API keys, JWTs, BIP39
 *     mnemonic heuristic) and open-ended base64 secret blobs are HARD
 *     redacted to `[redacted]` — full removal, no shape preserved.
 *   - EVM/Solana addresses and transaction hashes are left UNTOUCHED. An
 *     export is for research notes / handoff / audit — the whole point is
 *     that a swap's tx hash or a wallet's address stays legible.
 *
 * MAINTAINER POLICY DECISION (2026-07-14): audit-first. Because a secret and
 * a public identifier can be shape-identical, no filter can simultaneously
 * guarantee removal of every unlabelled secret AND preserve every
 * same-shaped public identifier. This export chooses to keep identifiers
 * legible and treats redaction as BEST-EFFORT, stated verbatim in the
 * pre-save dialog ("review the file before sharing it"). Known accepted
 * limitations under this policy:
 *   - an unlabelled raw 64-hex private key is indistinguishable from a tx
 *     hash and will export legibly;
 *   - a base64 secret composed entirely of the base58-overlap alphabet can
 *     evade `looksLikeBase64Secret` (its base58 exclusion exists so Solana
 *     addresses stay legible);
 *   - a base64 secret placed in a URL's PATH is exempt from the base64 pass
 *     (2026-07-30, approved) so public explorer/DEX links stay legible; a
 *     secret in a URL's query or fragment is still redacted.
 *   - a path-shaped span (interior `/`, no empty segment, every segment
 *     <= 48 chars, no `+` and no `=` padding) is exempt from the base64
 *     pass (2026-07-30, approved) so bare repo/file paths — pervasive in
 *     Vex transcripts — stay legible. Consequence: an UNPADDED standard
 *     base64 secret that happens to carry interior slashes with short
 *     segments and no `+` can evade the export pass. The exemption does
 *     NOT apply inside a URL's query or fragment.
 * Revisit only as a deliberate policy change (privacy-first would redact
 * identifier-shaped values wholesale and gut the export's audit value).
 */

import {
  API_KEY_PREFIX_RE,
  BIP39_HEURISTIC_RE,
  findBip39MnemonicRun,
  JWT_RE,
  looksLikeBase64Secret,
  OPEN_ENDED_BASE64_CANDIDATE_RE,
  PRIVATE_KEY_LABELLED_RE,
  RAW_HEX_KEY_RE,
} from "@vex-lib/diagnostics/secret-detectors.js";

const REDACTED = "[redacted]";

/** An `http(s)` URL, up to the first whitespace or Markdown-link delimiter. */
const URL_RE = /\bhttps?:\/\/[^\s)<>"'`]+/gi;

export function redactForExport(text: string): string {
  let out = text;

  out = out.replace(PRIVATE_KEY_LABELLED_RE, () => REDACTED);
  out = out.replace(RAW_HEX_KEY_RE, () => REDACTED);
  out = out.replace(API_KEY_PREFIX_RE, () => REDACTED);
  out = out.replace(JWT_RE, () => REDACTED);
  out = out.replace(BIP39_HEURISTIC_RE, (match) => {
    // The 12-24-word shape alone also matches ordinary prose; redact only
    // the wordlist-validated run, leaving prose the greedy regex swallowed.
    const run = findBip39MnemonicRun(match);
    if (run === null) return match;
    return `${match.slice(0, run.start)}${REDACTED}${match.slice(run.end)}`;
  });
  // Runs last so it never re-scans text already replaced with `[redacted]`
  // above (the placeholder itself doesn't match the base64 alphabet class).
  const urlPaths = urlPathRanges(out);
  const urlQueries = urlQueryRanges(out);
  out = out.replace(
    OPEN_ENDED_BASE64_CANDIDATE_RE,
    (match: string, offset: number) => {
      if (!looksLikeBase64Secret(match)) return match;
      const end = offset + match.length;
      if (overlapsAny(offset, end, urlPaths)) return match;
      if (isPathShaped(match) && !overlapsAny(offset, end, urlQueries)) {
        return match;
      }
      return REDACTED;
    },
  );

  return out;
}

/**
 * Origin+path span of every URL in `text`, excluding any `?query` or
 * `#fragment`.
 *
 * `OPEN_ENDED_BASE64_CANDIDATE_RE` includes `/` in its alphabet, so a URL
 * path is shape-identical to a base64 blob and `looksLikeBase64Secret`
 * accepts it on the strength of the `/` alone — which destroyed public
 * explorer links (reproduced 2026-07-30:
 * `https://arbiscan.io/tx/0x3f2a…f708` → `https://arbiscan.[redacted]`),
 * defeating this export's own "tx hashes stay legible" policy above.
 *
 * A path segment of a public explorer/DEX link is public by construction,
 * so exempting it costs no real recall. Query strings and fragments are
 * deliberately NOT exempt: a token or key smuggled into a URL is a real
 * exposure and must still be redacted.
 */
function urlPathRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const url of text.matchAll(URL_RE)) {
    const queryStart = url[0].search(/[?#]/);
    const length = queryStart === -1 ? url[0].length : queryStart;
    ranges.push([url.index, url.index + length] as const);
  }
  return ranges;
}

/** `?query` / `#fragment` span of every URL in `text`, if it has one. */
function urlQueryRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const url of text.matchAll(URL_RE)) {
    const queryStart = url[0].search(/[?#]/);
    if (queryStart === -1) continue;
    ranges.push([url.index + queryStart, url.index + url[0].length] as const);
  }
  return ranges;
}

/** Longest plausible path segment (a file name); above this it reads as a blob. */
const MAX_PATH_SEGMENT = 48;

/**
 * True when a base64 candidate reads as a bare repo/file path rather than a
 * secret blob.
 *
 * `OPEN_ENDED_BASE64_CANDIDATE_RE` includes `/` in its alphabet and
 * `looksLikeBase64Secret` accepts a candidate on the strength of that `/`
 * alone, so ANY path of >=20 chars was hard-redacted (reproduced 2026-07-30:
 * `vex-app/src/main/sessions/export` -> `[redacted]`). Paths are pervasive in
 * Vex transcripts; the URL exemption above only covers spans behind an
 * `http(s)://` origin.
 *
 * The discriminators, all required:
 *   - an interior `/` with NO empty segment — real base64 of low-entropy or
 *     all-`0xFF` material produces `//` runs, and leading/trailing slashes are
 *     blob-shaped, not path-shaped;
 *   - every segment within `MAX_PATH_SEGMENT`;
 *   - no `+` and no `=` — neither can occur in a path, and both are distinctly
 *     base64 (`=` only ever appears as this regex's trailing padding).
 *
 * Callers must additionally exclude URL query/fragment spans: see the accepted
 * limitation in the module header.
 */
function isPathShaped(candidate: string): boolean {
  if (!candidate.includes("/")) return false;
  if (candidate.includes("+") || candidate.includes("=")) return false;
  return candidate
    .split("/")
    .every((segment) => segment.length > 0 && segment.length <= MAX_PATH_SEGMENT);
}

function overlapsAny(
  start: number,
  end: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}
