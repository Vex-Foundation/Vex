/**
 * Token symbol sanitizer — the trust boundary for display-only token labels
 * sourced from provider/capture data (agent-activity / token-history
 * trade-capture JSON, portfolio balance rows). These strings are attacker-influenceable: any on-chain
 * token can self-declare arbitrary metadata, including a symbol that
 * impersonates a well-known asset ("SOL", "USDC", …). Every captured/provider
 * symbol MUST pass through `sanitizeTokenSymbol` before it is used as
 * display text or handed to a symbol-keyed icon lookup (e.g. `TokenIcon`).
 *
 * Pure, dependency-free (no main/renderer/electron imports) so BOTH the main
 * process (`agent-scan-db-mappers.ts` / `token-history-db-mappers.ts`,
 * extracting from capture JSON) and the untrusted renderer
 * (`token-leg-display.ts`, `PositionChains.tsx`, `TokenHoldingRow.tsx`,
 * rendering provider-supplied symbols) consume one sanitizer and can never
 * drift.
 *
 * Strategy: allowlist, not blocklist. Real token tickers are short ASCII
 * strings. Restricting to `[A-Za-z0-9._$-]` (starting with an alphanumeric)
 * rejects, in one pass and WITHOUT a Unicode confusables database:
 *   - control characters (the original narrower capture-side regex this
 *     replaced covered only this class);
 *   - bidi control characters (RLO/LRO/embeddings/isolates, U+061C ALM);
 *   - zero-width characters (ZWSP/ZWNJ/ZWJ, BOM/ZWNBSP, word joiner);
 *   - Unicode confusables (Cyrillic/Greek/other lookalike glyphs) — none of
 *     them are ASCII, so none pass the allowlist.
 * Surrounding whitespace is trimmed before the check so legitimate captures
 * like `"  SOL  "` still resolve; internal whitespace/control content is
 * rejected outright rather than stripped, so a partially-hostile string
 * never silently degrades into a look-alike survivor.
 */

/** Shared bound: capture-item/provider symbols are extracted length-bounded
 * at 64 chars server-side (the feed SQL's `LEFT(...)`) and validated again here
 * and at the IPC schema boundary — all three sites must agree on one number. */
export const TOKEN_SYMBOL_MAX_LENGTH = 64;

const SAFE_TOKEN_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._$-]*$/;

// Strip ONLY ASCII surrounding whitespace. Deliberately NOT
// `String.prototype.trim`, which also removes exotic Unicode whitespace —
// crucially U+FEFF (BOM/zero-width no-break space) — and would silently
// let a spoofing character slip past the allowlist by trimming it away.
const ASCII_EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/**
 * Returns the trimmed symbol when it is a non-empty, length-bounded, ASCII
 * allowlisted string; `null` otherwise (wrong type, empty, over-length, or
 * containing any character outside the allowlist — including control,
 * bidi-control, zero-width, and Unicode-confusable characters anywhere in
 * the value).
 */
export function sanitizeTokenSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(ASCII_EDGE_WHITESPACE, "");
  if (trimmed.length === 0 || trimmed.length > TOKEN_SYMBOL_MAX_LENGTH) {
    return null;
  }
  return SAFE_TOKEN_SYMBOL.test(trimmed) ? trimmed : null;
}
