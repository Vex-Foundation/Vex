/**
 * `pendle.prices.assets` — USD marks for Pendle assets (PT, YT, LP, SY) on one
 * chain, including assets the wallet does not hold (G-08).
 *
 * WHAT THIS NUMBER IS, AND IS NOT. It is Pendle's own snapshot, refreshed on the
 * order of 15-60 seconds (its endpoint doc says "approximately every minute",
 * its FAQ says "every 15 seconds" — the honest range is both). It is for
 * display and portfolio arithmetic. It is NOT a pre-trade rate: Pendle routes
 * that to `swapping-prices`, surfaced by `pendle.market.get`, and its docs are
 * explicit that a quote endpoint is not a price oracle either.
 *
 * The endpoint answers with a MAP keyed by `chainId-address`, not an array —
 * a shape that reads as "no data" if mis-parsed. The read shelf decodes it; this
 * handler adds the half the map cannot express: which REQUESTED ids came back
 * with no price. Dropping them silently would let an unpriced asset read as a
 * worthless one.
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import type { ToolResult } from "../../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { usdString } from "../money-format.js";
import { parsePendleAssetPricesParams } from "../market-read-params.js";
import { failureDetail } from "./read-shared.js";

const TOOL_ID = "pendle.prices.assets";

const PRICE_NOTE =
  "These are Pendle's own USD marks, refreshed roughly every 15-60 seconds. They are display and portfolio figures, " +
  "NOT an executable quote — what a PT actually trades at depends on the market's depth at your size.";

export async function pendleAssetPrices(
  p: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<ToolResult> {
  const parsed = parsePendleAssetPricesParams(p);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const chain = pendleChainSlug(q.chainId) ?? String(q.chainId);

  let snapshot;
  try {
    snapshot = await getPendleReadClient().getAssetPrices({
      chainId: q.chainId,
      ...(q.ids === undefined ? {} : { ids: q.ids }),
      ...(q.types === undefined ? {} : { types: q.types }),
      skip: q.offset,
      limit: q.limit,
    });
  } catch (err) {
    return fail(`Pendle asset prices unavailable (${failureDetail(TOOL_ID, err)})`);
  }

  const asOf = new Date(nowMs).toISOString();
  const prices = snapshot.prices.map((price) => ({
    id: `${price.chainId}-${price.address}`,
    chain: pendleChainSlug(price.chainId) ?? String(price.chainId),
    chainId: price.chainId,
    address: price.address,
    // Exact decimal string: a provider float in agent-facing output is how a
    // portfolio total starts drifting.
    priceUsd: usdString(price.priceUsd),
  }));

  const returned = new Set(prices.map((price) => price.id));
  const missingIds = q.ids === undefined ? undefined : q.ids.filter((id) => !returned.has(id));
  const hasMore = q.ids === undefined && snapshot.skip + prices.length < snapshot.total;

  return ok({
    summary: summarize(chain, prices.length, missingIds?.length ?? 0, q.types),
    chain,
    asOf,
    note: PRICE_NOTE,
    filtersApplied: {
      ...(q.ids === undefined ? {} : { ids: q.ids }),
      ...(q.types === undefined ? {} : { types: q.types }),
      offset: q.offset,
      limit: q.limit,
    },
    count: prices.length,
    total: snapshot.total,
    hasMore,
    ...(hasMore ? { nextOffset: snapshot.skip + prices.length } : {}),
    ...(missingIds === undefined || missingIds.length === 0
      ? {}
      : {
          missingIds,
          missingNote:
            "Pendle does not price these ids on this chain. That is not a price of zero — the asset may not be a " +
            "Pendle PT/YT/LP/SY at all, or may live on another chain. Confirm it with pendle.market.get.",
        }),
    prices,
    nextStep:
      "For a market's tradable rate and implied APY call pendle.market.get; for the price history behind a mark call " +
      "pendle.market.candles. Do not size a trade off these figures — quote it with pendle.pt.quote or pendle.yt.quote.",
  });
}

function summarize(chain: string, count: number, missing: number, types: readonly string[] | undefined): string {
  const scope = types === undefined ? "Pendle assets" : `${types.join("/")} assets`;
  if (count === 0) {
    return `Pendle returned no USD marks for the requested ${scope} on ${chain}.`;
  }
  return (
    `${count} ${scope} priced on ${chain}` +
    (missing > 0 ? `; ${missing} requested id(s) came back unpriced — see missingIds` : "") +
    ". Provider marks, not executable quotes."
  );
}
