/**
 * Market resolution for the READ lane — the deliberate counterpart to
 * `market-lookup.ts`.
 *
 * `market-lookup.ts` resolves ACTIVE markets only and is frozen that way: every
 * mutating handler and the prequote redeem identity go through it, so teaching
 * it about matured markets would unblock a must-revert redeem fallback and a
 * post-expiry LP removal before the execution-safety work lands (G-02, G-40).
 *
 * A read tool has the opposite need. The single most important thing a
 * fixed-yield agent asks about is a MATURED position — "is my PT redeemable
 * yet?" — and today that position resolves to nothing, so the portfolio reports
 * it as `pt: null, expiry: null, redeemable: false` (G-18). This module answers
 * that question from the documented `/v2/markets/all` catalogue, which serves
 * both maturities, and is consumed EXCLUSIVELY by read handlers.
 *
 * It never imports the money-path client, and its result type carries no
 * calldata, no route and no amount — nothing a mutating path could act on.
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadMarket } from "@tools/pendle/read/types.js";
import { VexError, ErrorCodes } from "../../../../errors.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Which leg of the market the caller's address matched. */
export type PendleReadMarketMatch = "market" | "pt" | "yt";

/** Which catalogue read produced the row — provenance for the maturity call. */
export type PendleReadCatalogScope = "ids" | "active" | "inactive";

export interface PendleReadMarketFound {
  status: "found";
  market: PendleReadMarket;
  /**
   * TRUE once the market is past its expiry. Derived from `expiry` — an on-chain
   * fact — and only falls back to the catalogue the row came from when the
   * provider sent no readable expiry at all.
   */
  matured: boolean;
  matchedBy: PendleReadMarketMatch;
  catalogScope: PendleReadCatalogScope;
}

/**
 * The provider's catalogue was read to exhaustion and the address is not in it.
 * A DETERMINED negative — safe to report to the agent as "no such market".
 */
export interface PendleReadMarketNotFound {
  status: "not_found";
}

/**
 * The address was not found, but the catalogue walk did not finish, so absence
 * is UNPROVEN. Callers must say so rather than report "no such market": a
 * decoder that cannot prove what happened declines (rules/90).
 */
export interface PendleReadMarketIndeterminate {
  status: "indeterminate";
  reason: "catalog_page_budget_exhausted";
}

export type PendleReadMarketLookup =
  | PendleReadMarketFound
  | PendleReadMarketNotFound
  | PendleReadMarketIndeterminate;

function matches(market: PendleReadMarket, wanted: string): PendleReadMarketMatch | null {
  if (market.address === wanted) return "market";
  if (market.pt === wanted) return "pt";
  if (market.yt === wanted) return "yt";
  return null;
}

/**
 * Past expiry? `null` when the provider sent no readable expiry, which the
 * caller resolves from the catalogue the row came from instead of guessing.
 */
function isPastExpiry(market: PendleReadMarket, nowMs: number): boolean | null {
  if (market.expiry === null) return null;
  const expiryMs = Date.parse(market.expiry);
  return Number.isNaN(expiryMs) ? null : expiryMs <= nowMs;
}

function found(
  market: PendleReadMarket,
  matchedBy: PendleReadMarketMatch,
  catalogScope: PendleReadCatalogScope,
  nowMs: number,
): PendleReadMarketFound {
  const pastExpiry = isPastExpiry(market, nowMs);
  return {
    status: "found",
    market,
    matured: pastExpiry ?? catalogScope === "inactive",
    matchedBy,
    catalogScope,
  };
}

/**
 * Resolve a Pendle market for a READ, by market address, PT or YT, on one chain.
 *
 * Resolution order, cheapest first:
 *   1. an `ids` lookup, which reaches ONE market of EITHER maturity in a single
 *      2-CU call — this is the common case, because a portfolio read already
 *      holds the market address;
 *   2. the ACTIVE catalogue, for a PT/YT leg on a live market;
 *   3. the INACTIVE catalogue, for a PT/YT leg on a matured one.
 *
 * The two-step scan is what keeps a live lookup cheap: chain 1 carries 61 active
 * markets against 420 matured ones, so scanning them together would make every
 * ordinary lookup pay for the rare one.
 *
 * `nowMs` is injectable so maturity is testable without a clock.
 */
export async function resolveMarketForRead(
  chainId: number,
  address: string,
  nowMs: number = Date.now(),
): Promise<PendleReadMarketLookup> {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      "Pendle read: the market, PT or YT address is not a valid EVM address.",
      "Pass a 0x-prefixed 40-hex contract address.",
    );
  }
  const wanted = address.toLowerCase();
  const client = getPendleReadClient();

  const byId = await client.listMarkets({ chainId, ids: [`${chainId}-${wanted}`] });
  const idHit = byId.markets.find((m) => matches(m, wanted) !== null);
  if (idHit !== undefined) {
    return found(idHit, matches(idHit, wanted) ?? "market", "ids", nowMs);
  }

  let everyScanComplete = true;
  for (const scope of ["active", "inactive"] as const) {
    const catalog = await client.listMarkets({ chainId, isActive: scope === "active" });
    everyScanComplete = everyScanComplete && catalog.complete;
    for (const market of catalog.markets) {
      const matchedBy = matches(market, wanted);
      if (matchedBy !== null) return found(market, matchedBy, scope, nowMs);
    }
  }

  return everyScanComplete
    ? { status: "not_found" }
    : { status: "indeterminate", reason: "catalog_page_budget_exhausted" };
}
