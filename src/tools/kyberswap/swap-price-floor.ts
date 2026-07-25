/**
 * Vex's OWN price floor for a KyberSwap aggregator swap.
 *
 * KyberSwap builds the swap calldata for us and embeds its own
 * `minReturnAmount` inside an opaque blob. Vex therefore computes an
 * INDEPENDENT floor at QUOTE time — from the output the user was actually
 * shown — persists it with the prequote, and holds the execute-time build to
 * it before anything is signed. This is the KyberSwap counterpart of Uniswap's
 * `applySlippage`, where the floor lands in calldata WE build.
 *
 * This module owns the arithmetic and the persisted payload contract only. The
 * on-chain assertion (decoding the built calldata and comparing) lives in
 * `./evm/swap-calldata-guard.ts`; the Vex-wide slippage ceiling lives in
 * `@vex-agent/tools/protocols/slippage-policy.ts`.
 *
 * All amounts are RAW atomic units carried as decimal strings / bigints —
 * never `number`, never floats.
 */

import { z } from "zod";

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
 * a percentage, and it is applied identically to both floor comparisons.
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

/**
 * The quote-time price floor, as persisted on the prequote row's `route_ref`.
 *
 * Structural-only and bounded (the `route_ref` data-exposure invariant): three
 * numeric facts, no provider text, no addresses, no route internals.
 */
export interface KyberApprovedPriceFloor {
  /** `routeSummary.amountOut` the quote was computed from — raw atomic units. */
  readonly quotedNetOutRaw: string;
  /** The slippage the floor was computed with (whole bps, default applied). */
  readonly slippageBps: number;
  /** `floor(quotedNetOutRaw * (10000 - slippageBps) / 10000)` — raw atomic units. */
  readonly approvedMinOutRaw: string;
}

/**
 * Build the persisted floor payload from a quote's raw net output. Returns
 * `null` when the quote's output is not a usable raw integer — the caller then
 * records no floor, and the execute refuses for want of one (fail-closed;
 * never a fabricated floor).
 */
export function buildApprovedPriceFloor(
  quotedNetOutRaw: unknown,
  slippageBps: number,
): KyberApprovedPriceFloor | null {
  if (typeof quotedNetOutRaw !== "string" || !/^\d+$/.test(quotedNetOutRaw)) return null;
  try {
    return {
      quotedNetOutRaw,
      slippageBps,
      approvedMinOutRaw: computeApprovedMinOut(quotedNetOutRaw, slippageBps).toString(),
    };
  } catch {
    return null;
  }
}

/**
 * The `route_ref` envelope. Namespaced under `priceFloor` so the column stays
 * open for other structural route facts without an ambiguous flat shape.
 */
const approvedPriceFloorSchema = z.object({
  quotedNetOutRaw: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(0).max(10_000),
  approvedMinOutRaw: z.string().regex(/^\d+$/),
});

const routeRefSchema = z.object({ priceFloor: approvedPriceFloorSchema });

/** Wrap a floor for the `route_ref` column. */
export function toRouteRef(floor: KyberApprovedPriceFloor): Record<string, unknown> {
  return { priceFloor: { ...floor } };
}

/**
 * Read a persisted floor back out of an UNTRUSTED `route_ref` (a DB row is an
 * untrusted boundary). Returns `null` for a missing/malformed payload — the
 * execute must then refuse rather than proceed with no floor.
 */
export function parseRouteRefPriceFloor(routeRef: unknown): KyberApprovedPriceFloor | null {
  const parsed = routeRefSchema.safeParse(routeRef);
  return parsed.success ? parsed.data.priceFloor : null;
}
