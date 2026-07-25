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
 * always be a FRESH per-transaction `eth_estimateGas`. The only decision made
 * here is how much headroom to sign ON TOP of that estimate.
 */

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
 * The gas limit to sign for a call whose PROVIDER also quoted its own gas
 * figure — Khalani returns one inside each `eth_sendTransaction` approval it
 * hands us to sign.
 *
 * Signs `max(providerGas, gasLimitWithHeadroom(ownEstimate))`, because the two
 * inputs are unreliable in OPPOSITE directions:
 *   - A provider's number is a HINT, never a floor. KyberSwap's own quote
 *     reported `data.gas` of 356,167 for the Base call that measurably needed
 *     ~1,634,838 — a 4.6x lowball that would have burned the transaction just
 *     as surely as the bare node estimate did. So the headroomed estimate is
 *     the hard floor: a missing or lowballed provider figure can never lower
 *     what we sign.
 *   - Our own estimate cannot see everything the provider can (a settlement
 *     path that only the provider knows will be taken, a first-touch storage
 *     slot). So a provider asking for MORE than our headroomed figure is taken
 *     at its word rather than clamped down to ours.
 *
 * `ownEstimate` must be a FRESH per-transaction `eth_estimateGas` of the call
 * as it will actually run (same `to`/`data`/`value`), never a cached or
 * provider-supplied number.
 */
export function gasLimitForProviderHintedCall(
  ownEstimate: bigint,
  providerGas: bigint | undefined,
): bigint {
  const floor = gasLimitWithHeadroom(ownEstimate);
  return providerGas !== undefined && providerGas > floor ? providerGas : floor;
}
