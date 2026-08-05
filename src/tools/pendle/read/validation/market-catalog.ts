/**
 * `GET /v2/markets/all` — the DOCUMENTED cross-chain market catalogue, and the
 * only market source in this tree that can see a MATURED market.
 *
 * Why this endpoint and not the per-chain `/v1/{chainId}/markets/active` the
 * money path uses: `markets/all` is absent from neither the OpenAPI document nor
 * the docs site (both per-chain forms are), it filters server-side
 * (`chainId`/`isActive`/`ids`/`order_by`), and it paginates honestly with
 * `{total, limit, skip}` so a partial answer can be reported as partial.
 *
 * STRICT ON THE ENVELOPE, tolerant on display fields. The envelope carries the
 * pagination arithmetic a caller uses to decide whether it has seen everything,
 * so a body that does not carry it RAISES rather than answering "0 of 0".
 */

import { pendleInvalidResponse } from "../../errors.js";
import type { PendleReadMarket, PendleReadMarketPage } from "../types.js";
import {
  chainIdFromCompositeId,
  isRecord,
  readDisplayBool,
  readDisplayNumber,
  readDisplayString,
  readDisplayStringList,
  requireAddress,
  requireChainId,
} from "./_shared.js";

const ENDPOINT = "markets catalogue";

function normalizeMarket(raw: unknown): PendleReadMarket | null {
  if (!isRecord(raw)) return null;
  // Identity is strict: a row we cannot address is a row we cannot use, and a
  // half-identified market is worse than a missing one.
  const address = requireAddress(raw.address);
  if (address === null) return null;
  const chainId = requireChainId(raw.chainId) ?? chainIdFromCompositeId(raw.address);
  if (chainId === null) return null;

  const details = isRecord(raw.details) ? raw.details : {};
  return {
    chainId,
    address,
    name: readDisplayString(raw.name),
    protocol: readDisplayString(raw.protocol),
    expiry: readDisplayString(raw.expiry),
    pt: requireAddress(raw.pt),
    yt: requireAddress(raw.yt),
    sy: requireAddress(raw.sy),
    underlyingAsset: requireAddress(raw.underlyingAsset),
    accountingAsset: requireAddress(raw.accountingAsset),
    details: {
      liquidityUsd: readDisplayNumber(details.liquidity),
      totalTvlUsd: readDisplayNumber(details.totalTvl),
      tradingVolumeUsd: readDisplayNumber(details.tradingVolume),
      impliedApy: readDisplayNumber(details.impliedApy),
      underlyingApy: readDisplayNumber(details.underlyingApy),
      pendleApy: readDisplayNumber(details.pendleApy),
      aggregatedApy: readDisplayNumber(details.aggregatedApy),
      maxBoostedApy: readDisplayNumber(details.maxBoostedApy),
      ytFloatingApy: readDisplayNumber(details.ytFloatingApy),
      swapFeeApy: readDisplayNumber(details.swapFeeApy),
      feeRate: readDisplayNumber(details.feeRate),
      ptRoi: readDisplayNumber(details.ptRoi),
      ytRoi: readDisplayNumber(details.ytRoi),
    },
    categoryIds: readDisplayStringList(raw.categoryIds),
    isNew: readDisplayBool(raw.isNew),
    isPrime: readDisplayBool(raw.isPrime),
  };
}

/**
 * `GET /v2/markets/all` → one validated page.
 *
 * A missing envelope, a non-array `results`, or a page where rows arrived and
 * NONE was readable all RAISE `PENDLE_INVALID_RESPONSE`. A genuinely empty
 * `results` with `total: 0` is a determined answer and passes through — the same
 * split `validateAssets` makes on the money path.
 */
export function validatePendleMarketPage(raw: unknown): PendleReadMarketPage {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(ENDPOINT, "expected a JSON object at the root");
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw pendleInvalidResponse(ENDPOINT, "the root carried no `results` array");
  }
  const total = readDisplayNumber(raw.total);
  const limit = readDisplayNumber(raw.limit);
  const skip = readDisplayNumber(raw.skip);
  if (total === null || limit === null || skip === null) {
    throw pendleInvalidResponse(ENDPOINT, "the pagination envelope (total/limit/skip) was absent or unreadable");
  }

  const markets = results.map(normalizeMarket).filter((m): m is PendleReadMarket => m !== null);
  if (markets.length === 0 && results.length > 0) {
    throw pendleInvalidResponse(ENDPOINT, "no row carried a readable market address and chain");
  }
  return { total, limit, skip, results: markets };
}
