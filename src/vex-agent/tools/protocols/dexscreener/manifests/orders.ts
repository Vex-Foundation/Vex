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
import { DEXSCREENER_CHAIN_PARAM } from "../chain-param.js";

export const ORDERS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.orders",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Check paid promotional orders for a token — each with type, status, and paymentTimestampMs "
      + "(Unix epoch MILLISECONDS) — plus the token's boost-payment ledger (individual boost "
      + "purchases with amounts). This is a SPEND record: it shows what the project paid DEX "
      + "Screener for. Paying for promotion is not a quality or safety signal, and paying for none "
      + "is not a warning.",
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
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get latest DexScreener ad placements — type, duration, impressions. Monitor promotional "
      + "activity across the platform. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...AD_FEED_PARAMS],
    exampleParams: { chainIds: "solana", placedWithinSeconds: 86400, sortBy: "adImpressionCount" },
    discovery: DEXSCREENER_ORDERS_DISCOVERY["dexscreener.ads"],
  },
];
