/**
 * The unit-suffix registry, shared by every DexScreener naming-law test.
 *
 * Declared once so the pair, feed and narrative rows are held to ONE law. Two
 * copies would drift, and the first thing to drift would be the exemption list —
 * which is the part that has to be argued for.
 */

/**
 * A unit token, optionally followed by the window it applies to.
 *
 * `volumeUsdH24` and `priceChangePctSelected` both satisfy the law: the unit is
 * present and the trailing segment is a recognised window, not an escape hatch.
 *
 * `Hours` joined the registry for `adDurationHours`, where the provider reports
 * hours and converting to seconds to satisfy a shorter list would put a number in
 * the payload that DexScreener never sent. The law is "the name carries the unit",
 * not "the name uses one of seven tokens".
 */
export const UNIT_SUFFIX = /(Usd|Pct|Ms|Seconds|Hours|Count|CountTotal|Ratio|Tokens)(Selected|M5|H1|H6|H24)?$/;
