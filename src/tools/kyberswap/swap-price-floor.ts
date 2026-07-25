/**
 * Vex's OWN price floor for a KyberSwap aggregator swap.
 *
 * KyberSwap builds the swap calldata for us and embeds its own
 * `minReturnAmount` inside an opaque blob. Vex therefore re-derives the floor
 * that blob SHOULD carry — from the fresh route summary the build was made
 * from, at the caller's own `slippageBps` — and holds the decoded calldata to
 * it before anything is signed. This is the KyberSwap counterpart of Uniswap's
 * `applySlippage`, where the floor lands in calldata WE build.
 *
 * This module owns the arithmetic only. The on-chain assertion (decoding the
 * built calldata and comparing) lives in `./evm/swap-calldata-guard.ts`; the
 * Vex-wide slippage ceiling lives in
 * `@vex-agent/tools/protocols/slippage-policy.ts`.
 *
 * A second, quote-time floor used to be persisted on the prequote's
 * `route_ref` and compared against the build as well. Because both floors are
 * `out × (1 − slippage)` at the same slippage, that comparison reduced to
 * "the price must not have moved against the user between quote and build" —
 * a zero tolerance stacked on top of the caller's own, which a thin pair
 * breaks on every attempt and no re-quote can satisfy. Removed by owner
 * decision (2026-07-25): `slippageBps` is the price protection.
 *
 * All amounts are RAW atomic units carried as decimal strings / bigints —
 * never `number`, never floats.
 */

/**
 * The provider's own re-derivation slack, in raw output units.
 *
 * MEASURED (11 live captures on 2026-07-25 across base/ethereum/arbitrum/
 * polygon/bsc, 1–3 hops, 1–5 paths, native-in and native-out, at 25/50/100
 * bps): `POST /route/build` re-simulates the route summary it is handed and
 * returns `data.amountOut === routeSummary.amountOut - 1` in EVERY case, then
 * derives `minReturnAmount = floor(data.amountOut * (10000 - slippageBps) /
 * 10000)` EXACTLY.
 *
 * So a floor Vex computes from `routeSummary.amountOut` is deterministically 1
 * unit above the floor an HONEST build embeds. Without this allowance the
 * comparison refuses every still-market swap by one atomic unit. It is a
 * single output unit — the granularity of the floor arithmetic itself — never
 * a percentage.
 */
export const KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW = 1n;

/** Basis-point denominator. */
const BPS_DENOMINATOR = 10_000n;

/**
 * `floor(netOutRaw * (10000 - slippageBps) / 10000)` in exact bigint math.
 *
 * `netOutRaw` MUST be a non-negative base-10 integer string in raw atomic
 * units, and `slippageBps` MUST already be a validated whole basis-point value
 * in `[0, 10000]` (the caller owns that — see `slippage-policy.ts`). Both are
 * re-checked here because this function is the last step before a number
 * becomes a money floor: a bad input must throw, never silently clamp.
 */
export function computeApprovedMinOut(netOutRaw: string, slippageBps: number): bigint {
  const netOut = parseRawAmount(netOutRaw, "netOutRaw");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be a whole number of basis points in [0, 10000]: ${slippageBps}`);
  }
  return (netOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

/** Parse a raw atomic-unit decimal string. Never lexicographic, never float. */
export function parseRawAmount(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${label} is not a base-10 raw atomic-unit integer: ${value}`);
  }
  return BigInt(value);
}
