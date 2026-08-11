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
 *   - `pre_sign_revert` — the chain refused the `swap`-role leg's PRE-SIGN
 *     `eth_estimateGas` and NOTHING was broadcast. Added 2026-07-30 after a
 *     live 4663 session failed twice on router revert `"Call failed"` with the
 *     fallback venue still locked. It closes an asymmetry that had it exactly
 *     backwards: the SAME calldata reverting once MINED already revealed
 *     (`swap_mined_revert`) even though gas was burned, while the pre-sign
 *     refusal — nothing signed, nothing spent, strictly stronger evidence that
 *     the venue cannot serve this trade — did not. Both call-site gates mirror
 *     the mined-revert rules and live in `kyberswap/failure-mapping.ts`'s
 *     `deriveKyberPreSignRevertRevealFailure`, not here: the leg role must be
 *     `swap` (R1 — an approve leg refused is an ERC-20 allowance condition,
 *     never venue evidence) and nothing may have been broadcast for it. The
 *     R2/R3 limits apply unchanged — it makes a separately-quoted venue a
 *     reasonable QUOTE candidate, it does not prove Kyber is at fault, and no
 *     execution follows automatically.
 *     ELIGIBLE FAILURE CODES ARE A CLOSED SET, not a deny-list:
 *     `simulation_reverted`, `route_not_found`, `insufficient_liquidity`.
 *     Deliberately excluded, for the same reason `KYBER_PRICE_FLOOR_VIOLATED`
 *     is excluded above — each is a price/wallet/staleness condition a
 *     genuinely fresh quote (or a corrected amount) can clear, so a second
 *     venue is not the remedy and its own guidance already says what is:
 *       - `slippage`            — the pool moved; re-quote at a higher tolerance.
 *       - `allowance_or_balance`— the wallet was short; no venue fixes that.
 *       - `deadline_expired`    — the quote went stale; re-quote promptly.
 *     Every other code (including `broadcast_error` and `chain_unsupported`,
 *     neither of which is a refusal of THIS route) stays ineligible by default.
 *   - `venue_unavailable` - KyberSwap failed to serve us AT ALL rather than
 *     refusing this trade, so no fresh quote and no corrected amount can clear
 *     it: that is the exact boundary the excluded conditions above sit on the
 *     other side of, and a second venue is the only remedy Vex has. Added
 *     2026-08-10 after a live user in Vietnam was answered HTTP 403 by
 *     KyberSwap's edge on the aggregator quote call and the fallback stayed
 *     locked. CLOSED REASON SET: `edge_refused` (401/403/451),
 *     `endpoint_missing` (404), `rate_limited` (429), `server_error` (5xx),
 *     `timeout`, `unreachable` (no HTTP response at all). Malformed params and
 *     trade-condition failures (slippage, balance, deadline, price floor) are
 *     NOT in the class. The R2/R3 limits apply unchanged: it makes a
 *     separately-quoted venue a reasonable QUOTE candidate, it does not prove
 *     Kyber is at fault for the trade, and no execution follows automatically.
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

import type { EvmRouterRevertFailureCode } from "@tools/evm-chains/router-revert-reason.js";

export type KyberRevealFailure =
  | { readonly kind: "chain_unsupported" }
  | { readonly kind: "kyber_code"; readonly code: number; readonly tokenInputsValidated?: boolean }
  | { readonly kind: "swap_mined_revert" }
  | { readonly kind: "unsafe_build" }
  | { readonly kind: "pre_sign_revert"; readonly failureCode: EvmRouterRevertFailureCode }
  | { readonly kind: "venue_unavailable"; readonly reason: KyberVenueUnavailableReason };

/**
 * Closed reason vocabulary for the availability class. Strings, never numbers:
 * putting an HTTP status into a numeric field is what made a 403 arrive as
 * "Kyber code 403" in the first place.
 */
export type KyberVenueUnavailableReason =
  | "edge_refused"      // 401 / 403 / 451
  | "endpoint_missing"  // 404
  | "rate_limited"      // 429
  | "server_error"      // 500-599
  | "timeout"           // KYBER_TIMEOUT, HTTP 408
  | "unreachable";      // no HTTP response at all

const ROUTE_NOT_FOUND_CODES: ReadonlySet<number> = new Set([4008, 4010]);
const TOKEN_NOT_FOUND_CODE = 4011;

/** Closed set — see the `pre_sign_revert` entry in the file header for why each admitted code is admitted and each excluded one is excluded. */
const REVEAL_ELIGIBLE_PRE_SIGN_FAILURE_CODES: ReadonlySet<EvmRouterRevertFailureCode> = new Set([
  "simulation_reverted",
  "route_not_found",
  "insufficient_liquidity",
]);

/**
 * Closed set, not "every reason". Every member is currently admitted, and the
 * set still exists so that narrowing it later is a one-line policy change with
 * a test, not a rewrite of a `return true`.
 */
const REVEAL_ELIGIBLE_UNAVAILABLE_REASONS: ReadonlySet<KyberVenueUnavailableReason> = new Set([
  "edge_refused", "endpoint_missing", "rate_limited", "server_error", "timeout", "unreachable",
]);

export function isRevealEligibleKyberFailure(failure: KyberRevealFailure): boolean {
  if (failure.kind === "chain_unsupported") return true;
  if (failure.kind === "swap_mined_revert") return true;
  if (failure.kind === "unsafe_build") return true;
  if (failure.kind === "pre_sign_revert") {
    return REVEAL_ELIGIBLE_PRE_SIGN_FAILURE_CODES.has(failure.failureCode);
  }
  if (failure.kind === "venue_unavailable") {
    return REVEAL_ELIGIBLE_UNAVAILABLE_REASONS.has(failure.reason);
  }
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
