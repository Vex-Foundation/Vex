/**
 * `dexscreener.orders` — the paid-order history for ONE token, plus the sibling
 * boost-payment ledger the same endpoint returns.
 *
 * Kept in its own module because it is the only DexScreener tool that is neither
 * a pair list nor a feed: it answers "has this specific token paid DexScreener
 * for visibility", which is a per-token spend question rather than a window
 * over the market.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { ProtocolHandler } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";
import { missingRequired } from "./missing-params.js";
import { resolveDexScreenerChain } from "../chain-param.js";
import { sourceObservation } from "./source-observation.js";

export const DEXSCREENER_ORDER_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.orders": async (p) => {
    const chainRaw = str(p, "chain"), tokenAddress = str(p, "tokenAddress");
    const missing = missingRequired("dexscreener.orders", { chain: chainRaw, tokenAddress });
    if (missing) return fail(missing);
    const chain = resolveDexScreenerChain(chainRaw);
    if (!chain.ok) return fail(`dexscreener__token_orders_list: ${chain.reason}`);
    const client = getDexScreenerClient();
    // The endpoint answers with BOTH the paid-order history and the
    // boost-payment ledger for the same token. Both are spend signals, so
    // both are surfaced; the ledger used to be discarded entirely.
    const result = await client.getOrders(chain.slug, tokenAddress);
    const asOfMs = Date.now();
    return ok({
      // Echoed under the param key the caller sent (`chain`), lowercased so it
      // agrees with the provider rows, which all carry a lowercase slug.
      chain: chain.slug.toLowerCase(),
      tokenAddress,
      sourceObservation: sourceObservation(client, result, asOfMs),
      orderCount: result.orders.length,
      orders: result.orders,
      boostPaymentCount: result.boostPayments.length,
      boostPayments: result.boostPayments,
      skippedOrders: result.skippedOrders,
      skippedBoostPayments: result.skippedBoostPayments,
    });
  },
};
