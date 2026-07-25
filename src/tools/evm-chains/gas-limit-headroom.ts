/**
 * Gas-limit headroom policy for every EVM transaction Vex signs.
 *
 * This is a RISK POLICY, not a venue detail: KyberSwap and Relay reach it
 * through `kyberswap/evm/staged-broadcast.ts`'s `signStageBroadcast`, Uniswap
 * through `uniswap/execute.ts`'s `signUniswapTransaction`, Khalani through
 * `khalani/bridge-executor.ts`'s `signStageEvmLeg` (both the approval and the
 * bridge-deposit leg), Pendle through `pendle/erc20.ts`'s
 * `ensurePendleAllowanceExact`. It lives in one module because a per-venue
 * copy of the multiplier is precisely how the venues drift apart — the number
 * below is calibrated against on-chain forensic evidence, and a venue left
 * holding an older copy is under-protected with nothing failing to say so.
 *
 * This does NOT cache or hardcode a gas limit (the rule stated in
 * `evm-chains/evm-client.ts` and `uniswap/evm-client.ts`): the input must
 * always be a FRESH per-transaction `eth_estimateGas`. The only decisions made
 * here are how much headroom to sign ON TOP of that estimate, and how far above
 * it a PROVIDER's own figure may go before Vex refuses to sign at all.
 */

import { VexError, ErrorCodes } from "../../errors.js";

/**
 * Percentage of the node's `eth_estimateGas` result to sign as the gas limit.
 *
 * Signing the BARE estimate is what burned real funds on 2026-07-24: four
 * `kyberswap.swap.execute` transactions on Base mined-reverted having consumed
 * ~97.3% of their limit with zero logs — the EIP-150 63/64 signature of an
 * out-of-gas inside the router's executor sub-call, which
 * MetaAggregationRouterV2 reports as a generic `Error("Call failed")` rather
 * than an OOG. Replaying tx
 * `0x038e553fe2caaa5206bd1d90a5b1b1a352b8cd3934332a2f4721a95304d07f37` at its
 * own block proves the route itself was fine: it reverts at the signed limit
 * (1,026,236) and succeeds at 2,000,000, needing ~1,634,838.
 *
 * The estimate is not stale-but-close, it is structurally unreliable for
 * router calldata: re-running `eth_estimateGas` for that exact calldata across
 * twelve consecutive Base blocks returned 804,028–1,660,619, a 2.07x spread,
 * because how many liquidity ticks the swap crosses changes every block.
 * Anything under ~1.6x would still have lost that transaction, so the headroom
 * is deliberately generous.
 *
 * Cost of the headroom is bounded: the sender pays for gas USED, not the
 * limit. It costs extra only when a transaction genuinely consumes it — the
 * out-of-gas case this exists to prevent — at the price of requiring a larger
 * `value + gas * maxFeePerGas` balance to broadcast at all.
 */
const GAS_LIMIT_HEADROOM_PERCENT = 200n;

/** The gas limit to sign for a transaction whose fresh estimate is `gasEstimate`. */
export function gasLimitWithHeadroom(gasEstimate: bigint): bigint {
  return (gasEstimate * GAS_LIMIT_HEADROOM_PERCENT) / 100n;
}

/**
 * The CEILING on a provider-quoted gas figure, as a percentage of our OWN
 * fresh `eth_estimateGas` — the counterpart to the floor above.
 *
 * WHY A CEILING EXISTS AT ALL. Teaching the signer that a provider figure can
 * only RAISE the limit fixed one direction and opened the other: with no upper
 * bound, a compromised, buggy, or merely wrong provider could raise Vex's
 * signed gas exposure arbitrarily. The sender pays for gas USED, not the limit,
 * so an inflated limit is not an automatic loss — but it becomes one the moment
 * the call genuinely burns it, and it raises the `value + gas * maxFeePerGas`
 * balance needed to broadcast at all. Signing a number we cannot account for is
 * the thing the Vex money-path rules forbid.
 *
 * WHY 400 AND NOT SOMETHING TIGHTER. Measured, not guessed —
 * `./gas-limit-provider-ceiling-measurement.md` next to this file has the live
 * Base measurements, the derivation, and the command that reproduces them.
 * In summary: our own headroomed floor is already 2x the fresh estimate, and
 * 400% grants the provider exactly that much room again, while bounding what a
 * hostile response can make us sign to 4x a number we computed ourselves
 * against current chain state.
 *
 * REFUSE, NEVER CLAMP. Clamping down to our own floor would re-create the
 * out-of-gas burn this module exists to prevent, on a transaction we had
 * positive evidence needed more. Refusing costs nothing: no signature exists,
 * no row is staged, no fee is paid.
 */
export const GAS_LIMIT_PROVIDER_CEILING_PERCENT = 400n;

/**
 * The ceiling does not fire at all below this absolute gas figure.
 *
 * WHY A RATIO ALONE IS THE WRONG SHAPE, learned from the measurement rather
 * than assumed. The harm being bounded is ABSOLUTE — how much gas we could be
 * made to burn — but a pure ratio scales with the denominator, so it is
 * strictest exactly where the stakes are lowest. Two live findings force the
 * exemption:
 *   - Providers quote FLAT CONSTANTS. DeBridge's ERC-20 deposit leg quotes
 *     640,000 regardless of size, against a measured own estimate of 184,057 —
 *     a ratio of 3.477x on a leg whose entire exposure is under a million gas.
 *   - Our own estimate is the volatile half. The same calldata moved 2.07x
 *     across twelve consecutive Base blocks, so that 3.477x becomes ~7.2x
 *     whenever our estimate lands at the low end of its own swing. A pure 4x
 *     ceiling would refuse a legitimate, already-quoted bridge on nothing but
 *     estimator noise.
 *
 * 3,000,000 is above EVERY provider figure ever observed on a Khalani route
 * (largest: 640,000 — 4.7x of clearance) and above the largest gas limit Vex
 * has ever signed on any venue (2,052,472, the headroomed Base KyberSwap swap).
 * Below it, refusing costs more than it saves: a stranded autonomous mission
 * against a few cents of bounded exposure.
 */
export const GAS_LIMIT_PROVIDER_CEILING_MIN_GAS = 3_000_000n;

/**
 * The gas limit to sign for a call whose PROVIDER also quoted its own gas
 * figure — Khalani returns one inside some of the `eth_sendTransaction`
 * approvals it hands us to sign (live 2026-07-25: both native-deposit legs and
 * DeBridge's ERC-20 leg carry one; Hyperstream's and Across's ERC-20 legs carry
 * none at all).
 *
 * Signs `max(providerGas, gasLimitWithHeadroom(ownEstimate))` BOUNDED ABOVE by
 * `GAS_LIMIT_PROVIDER_CEILING_PERCENT`, because the two inputs are unreliable
 * in OPPOSITE directions and neither may be trusted without a bound:
 *   - A provider's number is a HINT, never a floor. KyberSwap's own quote
 *     reported `data.gas` of 356,167 for the Base call that measurably needed
 *     ~1,634,838 — a 4.6x lowball that would have burned the transaction just
 *     as surely as the bare node estimate did. So the headroomed estimate is
 *     the hard floor: a missing or lowballed provider figure can never lower
 *     what we sign.
 *   - Our own estimate cannot see everything the provider can (a settlement
 *     path that only the provider knows will be taken, a first-touch storage
 *     slot). So a provider asking for MORE than our headroomed figure is taken
 *     at its word — up to the ceiling, past which the figure is no longer
 *     extra headroom for the call we priced, and the call is REFUSED rather
 *     than signed or clamped.
 *
 * The ceiling is BOTH relative and absolute: it fires only when the provider's
 * figure exceeds `GAS_LIMIT_PROVIDER_CEILING_PERCENT` of our fresh estimate AND
 * exceeds `GAS_LIMIT_PROVIDER_CEILING_MIN_GAS`. See that constant for why a
 * ratio on its own refuses real bridges.
 *
 * `ownEstimate` must be a FRESH per-transaction `eth_estimateGas` of the call
 * as it will actually run (same `to`/`data`/`value`), never a cached or
 * provider-supplied number — the ceiling is only meaningful because it is
 * measured against our own current reading of the chain.
 */
export function gasLimitForProviderHintedCall(
  ownEstimate: bigint,
  providerGas: bigint | undefined,
): bigint {
  const floor = gasLimitWithHeadroom(ownEstimate);
  if (providerGas === undefined || providerGas <= floor) return floor;

  const ceiling = (ownEstimate * GAS_LIMIT_PROVIDER_CEILING_PERCENT) / 100n;
  if (providerGas > ceiling && providerGas > GAS_LIMIT_PROVIDER_CEILING_MIN_GAS) {
    // BUDGETED FOR 200 CHARACTERS. `summarizeProtocolError` joins message and
    // hint and then truncates the pair at `MAX_SAFE_ERROR_MESSAGE` (200), so
    // anything the agent must have has to be in the message and near the front:
    // the three numbers first, then that nothing was spent, then the action.
    // The venue handler adds the longer "what to do next" sentence around this,
    // where no cap applies.
    throw new VexError(
      ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE,
      `Refusing to sign: provider gas limit ${providerGas} exceeds Vex's ceiling ${ceiling} `
        + `(${GAS_LIMIT_PROVIDER_CEILING_PERCENT / 100n}x its own fresh estimate ${ownEstimate} for this exact call). `
        + "Nothing was signed or spent; re-quote.",
      "A gas estimate does not move with congestion, so this will not clear by waiting: if a fresh quote asks for "
        + "the same limit, use a different route rather than retrying this one.",
    );
  }
  return providerGas;
}
