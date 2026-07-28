/**
 * Which markets a `pendle.claim` income sweep will actually touch — and,
 * just as importantly, which eligible ones it will NOT.
 *
 * Extracted from `./handlers/yt.ts` (2026-07-25) so the selection rule and its
 * accounting have one owner; the handler keeps the signing/broadcast path.
 *
 * THE CAP IS REAL, SO IT IS REPORTED. `redeemDueInterestAndRewardsV2` sweeps
 * every YT and every market in ONE transaction: each extra leg adds calldata,
 * an SY allowance write, and gas, and the pre-sign decoder (`assertClaimSafe`)
 * must bind every one of them. An unbounded sweep is a transaction that can
 * revert on gas after the allowances have already been granted, so the sweep
 * stays bounded at {@link MAX_CLAIM_MARKETS}.
 *
 * What changes here is HONESTY, not the bound. The previous implementation
 * `break`ed out of the selection loop at the cap, so the result reported
 * neither how many markets were eligible nor which ones were left behind —
 * and because the selection order is the provider's own stable position
 * order, markets past the cap could never be reached by repeating the call.
 * Selection now walks EVERY eligible position, takes the first
 * {@link MAX_CLAIM_MARKETS}, and returns the remainder as an explicit skip
 * list so the caller can tell the agent exactly what was left and how to
 * reach it (`pendle.claim` with an explicit `market`, which bypasses the cap
 * entirely — see {@link buildPendleClaimTargets}).
 *
 * A market whose YT leg cannot be bound (no `yt`/`underlyingAsset`/`sy`) is
 * also a skip, not a silence: the fail-closed drop is deliberate, but the
 * agent is told it happened.
 */

import { getPendleClient } from "@tools/pendle/client.js";
import { stripChainPrefix } from "@tools/pendle/validation.js";
import type { PendleMarket } from "@tools/pendle/types.js";

import type { PendleClaimYtBind } from "./calldata.js";
import { resolveExitMarketByAddress } from "./matured-market-lookup.js";

/** Max markets a single unscoped claim will sweep (keeps the tx + CU spend bounded). */
export const MAX_CLAIM_MARKETS = 10;

/** Why an eligible-looking market is not part of this claim. */
export type PendleClaimSkipReason =
  /** Eligible, but past the per-transaction market cap — reachable via an explicit `market`. */
  | "market_cap"
  /** The market is missing the YT bind material (`yt`/`underlyingAsset`/`sy`) a safe interest claim requires. */
  | "unbindable_yt"
  /** An explicitly requested market is not an active Pendle market on this chain. */
  | "market_not_found"
  /** An explicitly requested market the wallet holds no claimable position in. */
  | "no_position";

export interface PendleClaimSkip {
  /** Lowercase market address (or the caller's raw input for `market_not_found`). */
  readonly market: string;
  readonly reason: PendleClaimSkipReason;
}

/** The wallet's intended claim sets on a chain, with the accounting behind them. */
export interface PendleClaimTargets {
  /** Lowercase YT address → bind material for the interest leg. */
  readonly intendedYts: Map<string, PendleClaimYtBind>;
  /** Lowercase market addresses whose LP rewards are being claimed. */
  readonly intendedMarkets: Set<string>;
  /** Markets on this chain with a non-zero YT or LP balance — the honest denominator. */
  readonly eligibleMarketCount: number;
  /** Markets contributing at least one leg to THIS claim. */
  readonly selectedMarketCount: number;
  /** Every eligible market left out, with the reason. Empty when nothing was dropped. */
  readonly skipped: readonly PendleClaimSkip[];
  /** The cap in force for an unscoped claim (`null` when an explicit market was requested — the cap does not apply). */
  readonly marketCap: number | null;
}

/**
 * Register one market's YT leg as claimable, WITH the bind material the claim
 * safety check needs: the market's underlyingAsset (the only allowed
 * tokenRedeemSy — the SDK redeems accrued SY interest into it) and its SY (the
 * only token an interest claim may approve). A market missing either cannot be
 * bound → its YT leg is skipped (fail-closed; LP rewards are unaffected).
 */
function addYtTarget(intendedYts: Map<string, PendleClaimYtBind>, m: PendleMarket): boolean {
  if (!m.yt || !m.underlyingAsset || !m.sy) return false;
  intendedYts.set(m.yt.toLowerCase(), {
    tokenRedeemSy: m.underlyingAsset.toLowerCase(),
    sy: m.sy.toLowerCase(),
  });
  return true;
}

/**
 * Does the wallet hold a claimable (YT or LP) balance in this market, on THIS
 * chain? A read failure PROPAGATES rather than degrading to "no" or "yes" — the
 * caller must not claim blind, and must not be told a real position is absent.
 */
async function holdsClaimablePosition(
  chainId: number,
  wallet: string,
  marketAddress: string,
): Promise<boolean> {
  const positionsByChain = await getPendleClient().getPositions(wallet);
  const chainPositions = positionsByChain.find((p) => p.chainId === chainId);
  for (const pos of chainPositions?.openPositions ?? []) {
    const addr = stripChainPrefix(pos.marketId);
    if (!addr || addr.toLowerCase() !== marketAddress) continue;
    const hasYt = pos.yt != null && pos.yt.balance !== "0";
    const hasLp = pos.lp != null && pos.lp.balance !== "0";
    if (hasYt || hasLp) return true;
  }
  return false;
}

/**
 * Build the wallet's intended claim sets on one chain.
 *
 * With `explicitMarket`, the claim is scoped to that single market and the
 * cap does not apply — this is the escape hatch for anything the unscoped
 * sweep had to leave behind. Otherwise the sets are derived from the
 * dashboard positions (markets where the wallet holds a YT or LP balance),
 * bounded to {@link MAX_CLAIM_MARKETS} with every remaining eligible market
 * reported in `skipped`. Addresses are lowercased for the subset bind.
 */
export async function buildPendleClaimTargets(
  chainId: number,
  wallet: string,
  explicitMarket: string | null,
): Promise<PendleClaimTargets> {
  const intendedYts = new Map<string, PendleClaimYtBind>();
  const intendedMarkets = new Set<string>();

  if (explicitMarket) {
    // EXIT PATH (R5b): accrued income does not stop being the user's because the
    // market expired, so an explicitly requested MATURED market is claimable.
    const m = (await resolveExitMarketByAddress(chainId, explicitMarket))?.market ?? null;
    if (!m) {
      return {
        intendedYts, intendedMarkets,
        eligibleMarketCount: 0,
        selectedMarketCount: 0,
        skipped: [{ market: explicitMarket.toLowerCase(), reason: "market_not_found" }],
        marketCap: null,
      };
    }
    const address = m.address.toLowerCase();
    // HOLDING CHECK (G-40 / D13). The unscoped path derives its targets FROM the
    // dashboard positions, so it can never select a market the wallet is not in;
    // the explicit path used to add the market unconditionally and broadcast a
    // no-op sweep that burns gas and claims nothing (live-probed). The same
    // positions read the unscoped path already makes is the evidence, so the
    // claim is refused BY NAME before any allowance or signature exists.
    if (!(await holdsClaimablePosition(chainId, wallet, address))) {
      return {
        intendedYts, intendedMarkets,
        eligibleMarketCount: 0,
        selectedMarketCount: 0,
        skipped: [{ market: address, reason: "no_position" }],
        marketCap: null,
      };
    }
    const bound = addYtTarget(intendedYts, m);
    intendedMarkets.add(address);
    return {
      intendedYts, intendedMarkets,
      eligibleMarketCount: 1,
      selectedMarketCount: 1,
      skipped: bound ? [] : [{ market: address, reason: "unbindable_yt" }],
      marketCap: null,
    };
  }

  const client = getPendleClient();
  // EXIT PATH (R5b): the sweep indexes BOTH catalogues. A matured market used to
  // be dropped by `if (!m) continue` below — silently absent from eligible AND
  // from skipped, which broke the honesty invariant this module exists to keep
  // (G-02: "claim silently drops matured markets from both").
  const [positionsByChain, activeMarkets, maturedMarkets] = await Promise.all([
    client.getPositions(wallet),
    client.getActiveMarkets(chainId),
    client.getInactiveMarkets(chainId),
  ]);
  const marketByAddress = new Map<string, PendleMarket>();
  // Active LAST so a row present in both catalogues resolves as active.
  for (const m of [...maturedMarkets, ...activeMarkets]) marketByAddress.set(m.address.toLowerCase(), m);
  const chainPositions = positionsByChain.find((p) => p.chainId === chainId);

  const skipped: PendleClaimSkip[] = [];
  let eligibleMarketCount = 0;
  let selectedMarketCount = 0;

  // Walks EVERY position (no early `break`) so the eligible total and the
  // skip list are complete; only the ADDING is capped.
  for (const pos of chainPositions?.openPositions ?? []) {
    const marketAddr = stripChainPrefix(pos.marketId);
    const m = marketAddr ? marketByAddress.get(marketAddr.toLowerCase()) : undefined;
    if (!m) continue; // not an active market on this chain — nothing claimable
    const hasYt = pos.yt != null && pos.yt.balance !== "0";
    const hasLp = pos.lp != null && pos.lp.balance !== "0";
    if (!hasYt && !hasLp) continue;

    const address = m.address.toLowerCase();
    eligibleMarketCount += 1;
    if (selectedMarketCount >= MAX_CLAIM_MARKETS) {
      skipped.push({ market: address, reason: "market_cap" });
      continue;
    }

    let added = false;
    if (hasYt && addYtTarget(intendedYts, m)) added = true;
    if (hasLp) {
      intendedMarkets.add(address);
      added = true;
    }
    if (added) {
      selectedMarketCount += 1;
    } else {
      // YT-only position on a market with no bind material — fail-closed, but said out loud.
      skipped.push({ market: address, reason: "unbindable_yt" });
    }
  }

  return {
    intendedYts, intendedMarkets, eligibleMarketCount, selectedMarketCount, skipped,
    marketCap: MAX_CLAIM_MARKETS,
  };
}

/**
 * One agent-facing sentence describing what this claim leaves behind, or
 * `null` when it leaves nothing behind. Always names the reachable path for a
 * capped market — repeating the bare call cannot reach it, because selection
 * order is the provider's stable position order.
 */
export function describePendleClaimSkips(targets: PendleClaimTargets): string | null {
  if (targets.skipped.length === 0) return null;
  const capped = targets.skipped.filter((s) => s.reason === "market_cap").map((s) => s.market);
  const unbindable = targets.skipped.filter((s) => s.reason === "unbindable_yt").map((s) => s.market);
  const notFound = targets.skipped.filter((s) => s.reason === "market_not_found").map((s) => s.market);
  const notHeld = targets.skipped.filter((s) => s.reason === "no_position").map((s) => s.market);
  const parts: string[] = [];
  if (capped.length > 0) {
    parts.push(
      `Claimed ${targets.selectedMarketCount} of ${targets.eligibleMarketCount} eligible markets — one claim is `
      + `capped at ${targets.marketCap ?? MAX_CLAIM_MARKETS} markets to keep the transaction within gas. `
      + `NOT claimed: ${capped.join(", ")}. Repeating this call selects the same markets again; claim each of `
      + "those by passing it as the `market` param, which is not capped.",
    );
  }
  if (unbindable.length > 0) {
    parts.push(
      `YT interest was NOT claimed on ${unbindable.join(", ")} — Pendle did not report the YT/SY/underlying `
      + "the safety check binds against for those markets (LP rewards, if any, were still claimed).",
    );
  }
  if (notFound.length > 0) {
    parts.push(`${notFound.join(", ")} is not an active Pendle market on this chain — nothing was claimed for it.`);
  }
  if (notHeld.length > 0) {
    parts.push(
      `The wallet holds no YT or LP position in ${notHeld.join(", ")} on this chain, so there is nothing to claim `
      + "and no transaction was sent. Check pendle.position.value for the markets this wallet is actually in.",
    );
  }
  return parts.join(" ");
}
