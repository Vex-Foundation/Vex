/**
 * Kyber-failure reveal eligibility (plan §11.2, Blocker B; REVISION 1 —
 * reveal-on-execute-revert design) — the COORDINATOR-FIXED classifier
 * deciding which Kyber quote/execute failures are allowed to reveal the
 * hidden `swap_quote_uniswap` / `swap_execute_uniswap` pair for a session.
 * Builders have no discretion to widen or narrow this set.
 *
 * Eligible:
 *   - `chain_unsupported` — the local venue-router gate determined, BEFORE any
 *     Kyber call, that this EVM chain has no Kyber aggregator support at all
 *     (`classifySwapFamily`'s `venue: "uniswap"` branch).
 *   - Kyber code `4008` / `4010` — both map to `KYBER_ROUTE_NOT_FOUND`
 *     (`src/tools/kyberswap/aggregator/errors.ts`).
 *   - Kyber code `4011` (`KYBER_TOKEN_NOT_FOUND`) — ONLY when the token inputs
 *     already passed address/native validation + on-chain metadata resolution.
 *     A 4011 for a malformed address that never got that far is NOT eligible.
 *   - `swap_mined_revert` — the `swap`-role leg of `kyberswap.swap.execute`'s
 *     staged broadcast was signed, broadcast, MINED, and reverted on-chain
 *     (`outcome.kind === "reverted"`). Produced ONLY for the `swap` role
 *     (REVISION 1 R1) — an `allowance`/`allowance_reset` leg reverting is an
 *     ERC-20 approve failure, categorically unrelated to route/venue
 *     selection, and must NEVER construct this signal; the role gate lives at
 *     the call site (`kyberswap/failure-mapping.ts`'s
 *     `deriveKyberMinedRevertRevealFailure`), not here. A failed receipt
 *     proves the exact signed tx was included and reverted — a materially
 *     different, terminal signal from a pre-broadcast/RPC failure — but it
 *     does NOT prove a venue-only root cause (REVISION 1 R2): eligibility
 *     here means "a terminal primary-venue transaction failure makes a
 *     separately-quoted venue a reasonable QUOTE candidate," never "the
 *     receipt proves the token/funds cannot be responsible." The reveal only
 *     unlocks `swap_quote_uniswap` (a read-only quote probe); no automatic
 *     fallback execution ever follows (REVISION 1 R3).
 *   - `unsafe_build` — the pre-sign calldata guard refused the build KyberSwap
 *     returned for this route (`KYBER_UNSAFE_BUILD`). Terminal for the venue in
 *     the same sense as a mined revert: nothing was signed, but the refusal is
 *     a property of the BUILD Kyber produces for this pair, so a re-quote can
 *     return the same shape and loop. Added 2026-07-25 after a live 4663 swap
 *     was stranded with no venue to fall back to. The same R2/R3 limits apply —
 *     it makes a separately-quoted venue a reasonable QUOTE candidate, it does
 *     not prove Kyber is at fault, and no execution follows automatically.
 *     Deliberately NOT extended to `KYBER_PRICE_FLOOR_VIOLATED`: that is a
 *     price condition a genuinely fresh quote can clear, and its own hint
 *     already tells the agent to re-quote.
 *
 * Never eligible: `4221` (`KYBER_WETH_NOT_CONFIGURED` — a config anomaly, not
 * route-not-found, even though it is numerically adjacent to the 4008/4010/4011
 * family) and every other code (malformed params, fee-exceeds-amount,
 * amount-too-large — none of these mean "route not found").
 *
 * Typed numeric comparison: `code` is a `number`. A numeric-looking STRING must
 * NOT satisfy the eligible branches — this classifier is called directly with
 * the raw response code, never re-parsed from redacted text, so a caller
 * passing the wrong type is a bug this module refuses to paper over.
 *
 * Pure, no IO — a closed classification function, not a re-derivation of
 * `mapAggregatorError`'s VexError mapping (that mapping is unchanged).
 */

export type KyberRevealFailure =
  | { readonly kind: "chain_unsupported" }
  | { readonly kind: "kyber_code"; readonly code: number; readonly tokenInputsValidated?: boolean }
  | { readonly kind: "swap_mined_revert" }
  | { readonly kind: "unsafe_build" };

const ROUTE_NOT_FOUND_CODES: ReadonlySet<number> = new Set([4008, 4010]);
const TOKEN_NOT_FOUND_CODE = 4011;

export function isRevealEligibleKyberFailure(failure: KyberRevealFailure): boolean {
  if (failure.kind === "chain_unsupported") return true;
  if (failure.kind === "swap_mined_revert") return true;
  if (failure.kind === "unsafe_build") return true;
  if (failure.kind !== "kyber_code") return false;

  // Typed numeric equality — `typeof` guards against a numeric-looking string
  // arriving through an untyped/`any` boundary and silently widening eligibility.
  if (typeof failure.code !== "number") return false;

  if (ROUTE_NOT_FOUND_CODES.has(failure.code)) return true;
  if (failure.code === TOKEN_NOT_FOUND_CODE) {
    // Omitted defaults to "not yet validated" — fail closed.
    return failure.tokenInputsValidated === true;
  }
  return false;
}
