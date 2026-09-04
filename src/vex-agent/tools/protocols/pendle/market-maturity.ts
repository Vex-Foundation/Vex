/**
 * "Has this Pendle market matured?" - the ONE place that reads an expiry.
 *
 * Two callers need this answer for different reasons, and they must never drift
 * apart:
 *   - `redeem-fallback.ts` gates the `redeemPyToSy` broadcast, which burns PT
 *     alone and MUST revert before expiry (P1-14);
 *   - `matured-market-lookup.ts` decides whether an INACTIVE catalogue row may
 *     be believed at all (R5b).
 *
 * They phrase their refusals differently, because a caller mid-redeem needs
 * different words from a caller whose market lookup just returned a suspicious
 * row - but the arithmetic is shared, so a future change to how an expiry is
 * read cannot fix one path and leave the other behind.
 *
 * `expiry` is provider text and therefore untrusted: it is `string | null` on
 * `PendleMarket`, and both "absent" and "present but unreadable" are real states
 * that must NOT collapse into "not matured". They collapse into `unreadable`,
 * which every caller refuses - a maturity we cannot prove is not a maturity we
 * may act on (rules/90).
 */

export type PendleExpiryClassification =
  /** Parseable expiry at or before the reference instant. */
  | { readonly state: "matured"; readonly expiresAtMs: number }
  /** Parseable expiry still in the future. */
  | { readonly state: "not_matured"; readonly expiresAtMs: number }
  /** No expiry, or one that does not parse. Never treated as either answer. */
  | { readonly state: "unreadable"; readonly reason: "missing" | "unparseable" };

/**
 * Classify a market's expiry against `now`.
 *
 * Maturity is inclusive of the expiry instant: redemption opens AT maturity, so
 * `expiry === now` is `matured`. `now` is a parameter, never `Date.now()` read
 * inside, so every caller's boundary is testable without a clock stub.
 */
export function classifyPendleExpiry(expiry: string | null, now: Date): PendleExpiryClassification {
  if (expiry === null || expiry === "") return { state: "unreadable", reason: "missing" };
  const expiresAtMs = Date.parse(expiry);
  if (Number.isNaN(expiresAtMs)) return { state: "unreadable", reason: "unparseable" };
  return expiresAtMs <= now.getTime()
    ? { state: "matured", expiresAtMs }
    : { state: "not_matured", expiresAtMs };
}
