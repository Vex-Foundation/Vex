/**
 * Which addresses KyberSwap's build may hand the swap INPUT to, and how much.
 *
 * Extracted from `swap-calldata-guard.ts` (move-only) because it is a distinct
 * question with its own evidence base: the guard's other checks read fields
 * that are self-describing (a router address, a fee line, a floor), whereas
 * this one can only be judged against the ROUTE the build was made from.
 *
 * `srcReceivers`/`srcAmounts` are the router's INPUT-side transfer list, and on
 * the exact path our builds take they are a live exfiltration primitive. In the
 * verified `MetaAggregationRouterV2`, `swap()` with `_SIMPLE_SWAP` (0x20) clear
 * — our builds carry `flags == 640`, so it IS clear — runs:
 *
 *     for (i in srcReceivers) { total += srcAmounts[i];
 *       _doTransferERC20(srcToken, msg.sender, srcReceivers[i], srcAmounts[i]); }
 *     require(total <= desc.amount, 'Exceeded desc.amount');
 *
 * A `transferFrom` out of the USER's wallet to an address taken verbatim from
 * the description. The router bounds only the TOTAL and never asks who the
 * receiver is, so a build can keep the pair, the amount, the `dstReceiver`, the
 * fee line and the floor all correct while diverting the input.
 */

import { getAddress, type Address } from "viem";

import { KYBERSWAP_FEE_BPS } from "../constants.js";

const ROUTER_BPS_BASE = 10_000n;

/**
 * A refusal is always a build-integrity failure, never a price one — the caller
 * maps it to its own verdict kind, so this module owns the rule and not the
 * recording policy.
 */
export type SourceTransferVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The decoded input-side transfer list. `amount` must ALREADY be bound to the
 * approved input and the fee line to the Vex constants by the caller — the
 * net-of-fee expectation below is derived from both.
 */
export interface SourceTransferList {
  readonly srcReceivers: readonly string[];
  readonly srcAmounts: readonly bigint[];
  readonly amount: bigint;
}

/**
 * What an honest build routes to the executor: the input net of the integrator
 * fee, derived the way the router derives it. `_takeFee` reassigns
 * `desc.amount = amount - floor(amount * bps / BPS)` BEFORE the transfer loop,
 * so the FEE floors, not the remainder. Measured, not assumed: at
 * `amount = 10000001` the provider embeds 9975001, where
 * `floor(amount * 9975 / 10000)` would give 9975000 — a one-unit error that
 * would refuse every honest swap.
 */
function expectedSourceNetAmount(amount: bigint): bigint {
  return amount - (amount * BigInt(KYBERSWAP_FEE_BPS)) / ROUTER_BPS_BASE;
}

// A local address normalisation, matching the pattern each `evm/` module
// already follows (`swap-settlement.ts` has its own `addressesEqual`). A shared
// `utils`-style bucket is deliberately not created for five lines. Returns
// `null` rather than throwing, so a malformed provider address is a refusal
// and never an exception on the pre-sign path.
function normalizeAddress(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  const left = normalizeAddress(a);
  return left !== null && left === normalizeAddress(b);
}

function refuse(reason: string): SourceTransferVerdict {
  return { ok: false, reason };
}

/** Sum amounts per destination, so a destination listed twice is one entry. */
function totalPerDestination(entries: Iterable<readonly [Address, bigint]>): ReadonlyMap<Address, bigint> {
  const totals = new Map<Address, bigint>();
  for (const [destination, amount] of entries) {
    totals.set(destination, (totals.get(destination) ?? 0n) + amount);
  }
  return totals;
}

function sameDestinations(a: ReadonlyMap<Address, bigint>, b: ReadonlyMap<Address, bigint>): boolean {
  if (a.size !== b.size) return false;
  for (const [destination, amount] of a) {
    if (b.get(destination) !== amount) return false;
  }
  return true;
}

/**
 * The first hop of one path in the QUOTED route: the pool that hop swaps in,
 * and the input the route says it swaps there.
 */
export interface RouteFirstHop {
  readonly pool: Address;
  readonly inputAmount: bigint;
}

/** The two `routeSummary.route[][]` fields this module reads. */
export interface RouteHopSource {
  readonly pool: string;
  readonly swapAmount: string;
}

/**
 * Read the route's own first hops — the ONLY pools a build may hand the input
 * to directly, and how much each is owed.
 *
 * Fails closed as a unit: if ANY path cannot be read (empty path, malformed
 * address, non-integer amount) the whole set is dropped, which leaves the
 * executor shape as the only accepted one — exactly the behaviour before pools
 * were admitted at all. A partial set would let a build match a smaller split
 * than the route actually describes.
 */
export function deriveRouteFirstHops(
  route: readonly (readonly RouteHopSource[])[],
): readonly RouteFirstHop[] {
  const hops: RouteFirstHop[] = [];
  for (const path of route) {
    const first = path[0];
    if (first === undefined) return [];
    const pool = normalizeAddress(first.pool);
    if (pool === null) return [];
    if (!/^\d+$/.test(first.swapAmount)) return [];
    hops.push({ pool, inputAmount: BigInt(first.swapAmount) });
  }
  return hops;
}

/**
 * Bind the input-token transfer list to the shapes honest builds use.
 *
 * This is the SOURCE-side counterpart to the `dstReceiver` check: without it a
 * build can satisfy every other assertion and still hand the user's input to a
 * third party. Fails closed — a shape not modelled here is refused, never
 * passed, because the router will execute it verbatim.
 *
 * ## The two honest shapes
 *
 * Measured across 278 real `/route/build` responses on 2026-07-25
 * (ethereum/base/arbitrum/bsc/robinhood, 1–19 paths, 1–3 hops, 25–300 bps, both
 * input kinds, default AND source-filtered routing):
 *
 *   native input  → BOTH arrays empty; the input rides in `msg.value` and the
 *                   transfer loop is a no-op for the native sentinel.
 *   EXECUTOR form → exactly one receiver, equal to `callTarget`, taking exactly
 *                   `amount - floor(amount * feeBps / 10000)`. 159 of 228 in the
 *                   widest sweep.
 *   ROUTE form    → one receiver per path, each the pool that path's FIRST hop
 *                   swaps in, each taking exactly that hop's `swapAmount`. 69 of
 *                   228.
 *
 * The route form is not an anomaly and not chain-specific: a UniswapV2-style
 * pair swaps against tokens it already holds, so `transfer`-then-call IS that
 * protocol's shape, and routing the input straight to the pair saves a hop.
 * Any path whose first hop is such a pool produces it — observed on the DEFAULT
 * source set (exactly what Vex requests) on Robinhood 4663 and on Ethereum
 * mainnet alike. An earlier version of this binding modelled only the executor
 * form and refused every one of these honest builds; a live 44.58 VIRTUAL → ETH
 * swap on 4663 was stranded pre-sign by it.
 *
 * Never observed in 278 builds, and therefore refused: a list MIXING the
 * executor with pools, a pool that is not a path's first hop, and any address
 * belonging to neither set.
 *
 * ## Why this still closes the split skim
 *
 * The proven exploit keeps the honest receiver and APPENDS a second one for the
 * attacker, leaving every other checked field identical — the router bounds
 * only the total, so it executes. That address is neither `callTarget` nor a
 * first-hop pool of the route the agent quoted, so it is refused on membership.
 * And because each pool's amount is pinned to the route's own `swapAmount` for
 * that hop, an attacker cannot skim INTO a legitimate route pool either: the
 * per-destination totals must reproduce the quoted split exactly. The total
 * bound is unchanged — it must EQUAL the input net of fee, never merely fit
 * under it.
 *
 * ## What it does NOT defend against, stated plainly
 *
 * `callTarget` and `route[].pool` both come from the same provider in the same
 * two-step flow, so this binds the BUILD to the ROUTE Vex quoted and approved —
 * it is not a defence against an aggregator that lies in both. That was already
 * true of `callTarget` alone. Router-address verification, the fee line and the
 * price floor are the separate checks that bound the rest.
 *
 * The two forms are ALTERNATIVES, not a function of the route: a route whose
 * pools are all readable may still be built through the executor, and 159 of
 * 228 measured builds are exactly that, so requiring the route form when pools
 * exist would refuse the majority of honest traffic. The consequence is that a
 * pool-form build rewritten into an executor-form one is accepted. It moves no
 * funds anywhere new — both forms pay only addresses the quoted trade names,
 * and `callTarget` is the contract the router goes on to call either way.
 */
export function verifySourceTransfers(
  list: SourceTransferList,
  callTarget: string,
  srcIsNative: boolean,
  routeFirstHops: readonly RouteFirstHop[],
): SourceTransferVerdict {
  const { srcReceivers, srcAmounts } = list;
  if (srcReceivers.length !== srcAmounts.length) {
    return refuse(
      `it lists ${srcReceivers.length} input receivers against ${srcAmounts.length} input amounts`,
    );
  }

  // A native sell forwards the input as `msg.value`; the transfer loop is a
  // no-op for the native sentinel, so an honest build leaves the list empty.
  // Anything in it is a shape we have never seen and cannot account for.
  if (srcIsNative) {
    if (srcReceivers.length !== 0) {
      return refuse(
        `it adds ${srcReceivers.length} input transfer(s) to a native sell, which needs none`,
      );
    }
    return { ok: true };
  }

  if (srcReceivers.length === 0) {
    return refuse("it moves none of the input, so the swap cannot be funded");
  }

  // Refusal reasons are BUDGETED: `summarizeProtocolError` joins message and
  // hint and caps the pair at 200 characters, truncating the tail — which is
  // the actionable part. Each reason below stays inside ~119 characters.

  // 1. Membership. Every destination must be an address the approved trade
  //    already names — the executor being called, or a pool the quoted route
  //    swaps its first hop in.
  const destinations: (readonly [Address, bigint])[] = [];
  for (const [index, receiver] of srcReceivers.entries()) {
    const amount = srcAmounts[index] ?? 0n;
    const normalized = normalizeAddress(receiver);
    const permitted = normalized !== null
      && (sameAddress(receiver, callTarget) || routeFirstHops.some((hop) => hop.pool === normalized));
    if (!permitted) {
      return refuse(`it sends ${amount} to ${receiver}, which the quoted route never names`);
    }
    destinations.push([normalized, amount]);
  }

  // 2. The amount bound, unchanged: the total must EQUAL the input net of the
  //    integrator fee. Not "at most" — the router's own `total <= desc.amount`
  //    is what the skim exploited.
  const net = expectedSourceNetAmount(list.amount);
  const total = srcAmounts.reduce((sum, amount) => sum + amount, 0n);
  if (total !== net) {
    return refuse(`it moves ${total} of the input where ${net} is approved net of fee`);
  }

  // 3. Shape. Exactly the executor, or exactly the route's own split.
  const moved = totalPerDestination(destinations);
  const executor = normalizeAddress(callTarget);
  if (moved.size === 1 && executor !== null && moved.get(executor) === net) {
    return { ok: true };
  }

  if (routeFirstHops.length > 0) {
    const quotedSplit = totalPerDestination(routeFirstHops.map((hop) => [hop.pool, hop.inputAmount] as const));
    if (sameDestinations(moved, quotedSplit)) return { ok: true };
    // Name the first pool whose share was moved, so the refusal says WHAT
    // diverged rather than that something did.
    for (const [pool, quoted] of quotedSplit) {
      const got = moved.get(pool) ?? 0n;
      if (got !== quoted) {
        return refuse(`it moves ${got} to ${pool}; the quoted route swaps ${quoted} there`);
      }
    }
  }

  return refuse(`it splits the input across ${moved.size} destinations the quoted route does not describe`);
}
