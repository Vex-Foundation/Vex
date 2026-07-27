/**
 * `dexscreener.orders` — the paid-order history for ONE token, plus the sibling
 * boost-payment ledger the same endpoint returns.
 *
 * Kept in its own module because it is the only DexScreener tool that is neither
 * a pair list nor a feed: it answers "has this specific token paid DexScreener
 * for visibility", which is a per-token legitimacy question rather than a window
 * over the market.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { ProtocolHandler } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";

export const DEXSCREENER_ORDER_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.orders": async (p) => {
    const chainId = str(p, "chainId"), tokenAddress = str(p, "tokenAddress");
    if (!chainId || !tokenAddress) return fail("Missing required: chainId, tokenAddress");
    const client = getDexScreenerClient();
    // The endpoint answers with BOTH the paid-order history and the
    // boost-payment ledger for the same token. Both are legitimacy signals, so
    // both are surfaced; the ledger used to be discarded entirely.
    const result = await client.getOrders(chainId, tokenAddress);
    return ok({
      chainId,
      tokenAddress,
      orderCount: result.orders.length,
      orders: result.orders,
      boostPaymentCount: result.boostPayments.length,
      boostPayments: result.boostPayments,
      skippedOrders: result.skippedOrders,
      skippedBoostPayments: result.skippedBoostPayments,
    });
  },
};
