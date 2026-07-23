/**
 * Kyber-failure reveal eligibility (plan §11.2, Blocker B) — the
 * COORDINATOR-FIXED classifier deciding which Kyber quote/execute failures are
 * allowed to reveal the hidden `swap_quote_uniswap` / `swap_execute_uniswap`
 * pair for a session. Builders have no discretion to widen or narrow this set.
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
  | { readonly kind: "kyber_code"; readonly code: number; readonly tokenInputsValidated?: boolean };

const ROUTE_NOT_FOUND_CODES: ReadonlySet<number> = new Set([4008, 4010]);
const TOKEN_NOT_FOUND_CODE = 4011;

export function isRevealEligibleKyberFailure(failure: KyberRevealFailure): boolean {
  if (failure.kind === "chain_unsupported") return true;
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
