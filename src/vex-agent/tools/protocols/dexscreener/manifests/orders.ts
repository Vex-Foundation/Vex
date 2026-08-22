/**
 * `dexscreener.orders` (per-token paid history) and `dexscreener.ads` (the ad
 * placement feed).
 *
 * They share a manifest module for historical reasons rather than because they are
 * alike: `ads` is a FEED and takes the shared feed vocabulary from
 * `./feed-list-params.ts`, while `orders` answers a question about one named token
 * and takes no window params at all — there is nothing to filter in a 7-row answer
 * about a token the caller already chose.
 *
 * That split is why only `ads` carries the shared feed-window disclosure: `orders`
 * has no window, so claiming one would be its own falsehood.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { DEXSCREENER_ORDERS_DISCOVERY } from "../../embeddings/dexscreener/orders.js";
import { AD_FEED_PARAMS, FEED_DESCRIPTION_WINDOW_CLAUSE } from "./feed-list-params.js";
import { SOURCE_OBSERVATION_CLAUSE } from "./pair-list-params.js";
import { DEXSCREENER_CHAIN_PARAM } from "../chain-param.js";

export const ORDERS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.orders",
    publicName: "dexscreener__token_orders_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Check paid promotional orders for a token — each with type, status, and paymentTimestampMs "
      + "(Unix epoch MILLISECONDS) — plus the token's boost-payment ledger (individual boost "
      + "purchases with amounts). This is a SPEND record: it shows what the project paid DEX "
      + "Screener for. Paying for promotion is not a quality or safety signal, and paying for none "
      + "is not a warning. Use this when you already have one exact chain + token address and want "
      + "to know what that project bought, after a feed or a search has named it. RETURNS chain, "
      + "tokenAddress, orderCount and orders (each chainId, tokenAddress, type, status, "
      + "paymentTimestampMs), plus boostPaymentCount and boostPayments (each chainId, tokenAddress, "
      + "id, amount, paymentTimestampMs), and skippedOrders / skippedBoostPayments counting rows "
      + "the provider sent in an unreadable shape. It answers about ONE token, so it has no window, "
      + "no filters and no paging."
      + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [
      DEXSCREENER_CHAIN_PARAM,
      { key: "tokenAddress", type: "string", required: true, description: "Token contract address." },
    ],
    exampleParams: { chain: "solana", tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    discovery: DEXSCREENER_ORDERS_DISCOVERY["dexscreener.orders"],
  },
  {
    toolId: "dexscreener.ads",
    publicName: "dexscreener__ads_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get latest PAID DexScreener ad placements. An ad is bought visibility, never demand, "
      + "legitimacy, or safety. Field reality, measured live on 30 rows: adType was 'tokenAd' on "
      + "30/30, adDurationHours null on 30/30, and adImpressionCount a constant 10000 - a package "
      + "tier, NOT delivered reach. Use this when the user asks what is currently being advertised "
      + "on DexScreener, or wants the paid-placement window as a starting list. RETURNS one row per "
      + "placement: chainId, tokenAddress, description, adType, adPlacedAt, eventAgeSeconds, "
      + "adDurationHours and adImpressionCount, plus the provenance envelope (filtersApplied, "
      + "droppedByFilter, totalMatched, returned, offset, hasMore). For one exact token's paid "
      + "history use dexscreener__token_orders_list. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...AD_FEED_PARAMS],
    // Not sortBy: "adImpressionCount" - measured a constant 10000 on 30/30 rows,
    // so that sort is a guaranteed no-op and an example teaches harder than prose.
    exampleParams: { chainIds: "solana", placedWithinSeconds: 86400, limit: 15 },
    discovery: DEXSCREENER_ORDERS_DISCOVERY["dexscreener.ads"],
  },
];
