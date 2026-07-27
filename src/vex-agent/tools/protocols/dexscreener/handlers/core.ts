/**
 * The four market-data handlers — `search`, `pairs`, `tokens`, `tokenPairs`.
 *
 * All four are thin: they resolve required identity params, call the client, and
 * hand the provider window to the shared list pipeline in `../pair-list/`, which
 * owns param validation, filtering with drop accounting, sorting, windowing, the
 * `AgentDexPair` projection and the provenance envelope. Everything agent-facing
 * about a pair list is defined there, once, so a filter and a sort cannot
 * disagree about what "24 h volume" means and `limit` cannot mean two things in
 * two handlers.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { ProtocolHandler } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";
import { readStringOrArrayParam } from "../list-core/index.js";
import {
  SEARCH_PROVIDER_RELEVANCE_NOTE,
  assessCrossPoolPrices,
  buildPairList,
  buildPairListFromRows,
  parsePairListQuery,
  toPairRows,
} from "../pair-list/index.js";
import { reconcileTokenBatchAddresses } from "../token-batch-addresses.js";
import { missingRequired } from "./missing-params.js";

export const DEXSCREENER_CORE_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.search": async (p) => {
    const query = str(p, "query");
    const missing = missingRequired("dexscreener.search", { query });
    if (missing) return fail(missing);
    // DexScreener answers a 1-character query with HTTP 400 and an HTML body, so
    // the transport-level message would be an opaque "HTTP 400". Refuse first,
    // with the actual reason.
    if (query.trim().length < 2) {
      return fail(
        'dexscreener.search: "query" must be at least 2 characters — DexScreener rejects shorter '
        + "queries with an HTTP 400 it does not explain.",
      );
    }
    const parsed = parsePairListQuery(p, { sortBy: "relevance", allowChainFilter: true });
    if (!parsed.ok) return fail(`dexscreener.search: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const result = await client.search(query);
    const list = buildPairList({
      endpoint: "/latest/dex/search",
      providerOrder: "relevance",
      providerPairs: Array.isArray(result.pairs) ? result.pairs : [],
      query: parsed.query,
      asOfMs: Date.now(),
    });

    return ok({
      query,
      // Normalised lowercase: the previous handler echoed the caller's `"BASE"`
      // while every row it returned said `"base"`, so the echo disagreed with
      // the data it described.
      chainIds: parsed.query.filters.chainIds,
      providerRelevanceNote: SEARCH_PROVIDER_RELEVANCE_NOTE,
      ...list,
    });
  },

  // `chainId` is echoed lowercase on the three single-chain tools so the echo
  // agrees with the rows (every provider row carries a lowercase slug). The value
  // sent UPSTREAM is left exactly as the caller wrote it — normalising the request
  // would change what we ask DexScreener, which is not this card's call to make.
  // Token and pair addresses are never case-folded: Solana base58 is
  // case-sensitive and folding one would corrupt an identifier.
  "dexscreener.pairs": async (p) => {
    const chainId = str(p, "chainId");
    // A comma string OR an array of addresses — one canonical comma-string
    // downstream, so the upstream request and the `requestedPairAddresses` echo
    // cannot disagree about what was asked for.
    const pairAddressRead = readStringOrArrayParam(p, "pairAddress");
    if (!pairAddressRead.ok) return fail(`dexscreener.pairs: ${pairAddressRead.reason}`);
    const pairAddress = pairAddressRead.value ?? "";
    const missing = missingRequired("dexscreener.pairs", { chainId, pairAddress });
    if (missing) return fail(missing);
    const parsed = parsePairListQuery(p, { sortBy: "relevance" });
    if (!parsed.ok) return fail(`dexscreener.pairs: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const result = await client.getPairs(chainId, pairAddress);
    const providerPairs = Array.isArray(result.pairs) ? result.pairs : [];
    const list = buildPairList({
      endpoint: "/latest/dex/pairs",
      providerOrder: "unspecified",
      providerPairs,
      query: parsed.query,
      asOfMs: Date.now(),
    });

    return ok({
      chainId: chainId.toLowerCase(),
      requestedPairAddresses: pairAddress.split(",").map((a) => a.trim()).filter(Boolean),
      // `pairs: []` with `success: true` used to cover both "bad address" and
      // "not indexed". `found` separates the answer from the absence of one.
      found: providerPairs.length > 0,
      ...list,
    });
  },

  "dexscreener.tokens": async (p) => {
    const chainId = str(p, "chainId");
    // ONE canonical address list feeds BOTH the upstream call and the
    // requested/resolved/unresolved reconciliation, so the echo can never
    // describe a different list from the one we sent. Casing is preserved:
    // Solana base58 is case-sensitive and folding one would corrupt it.
    const tokenAddressesRead = readStringOrArrayParam(p, "tokenAddresses");
    if (!tokenAddressesRead.ok) return fail(`dexscreener.tokens: ${tokenAddressesRead.reason}`);
    const tokenAddresses = tokenAddressesRead.value ?? "";
    const missing = missingRequired("dexscreener.tokens", { chainId, tokenAddresses });
    if (missing) return fail(missing);
    const parsed = parsePairListQuery(p, { sortBy: "relevance" });
    if (!parsed.ok) return fail(`dexscreener.tokens: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const result = await client.getTokens(chainId, tokenAddresses);
    // Reconciled against the PROVIDER's rows, before any Vex filter — otherwise
    // our own filtering would be indistinguishable from the provider dropping
    // addresses (40 requested → 30 returned, measured).
    const addresses = reconcileTokenBatchAddresses(tokenAddresses, result);
    const list = buildPairList({
      endpoint: "/tokens/v1",
      providerOrder: "unspecified",
      providerPairs: result,
      query: parsed.query,
      asOfMs: Date.now(),
    });

    return ok({ chainId: chainId.toLowerCase(), ...addresses, ...list });
  },

  "dexscreener.tokenPairs": async (p) => {
    const chainId = str(p, "chainId"), tokenAddress = str(p, "tokenAddress");
    const missing = missingRequired("dexscreener.tokenPairs", { chainId, tokenAddress });
    if (missing) return fail(missing);
    const parsed = parsePairListQuery(p, { sortBy: "liquidityUsd" });
    if (!parsed.ok) return fail(`dexscreener.tokenPairs: ${parsed.reason}`);

    const asOfMs = Date.now();
    const client = getDexScreenerClient();
    const result = await client.getTokenPairs(chainId, tokenAddress);

    // Cross-pool sanity over the FULL provider window: this is the one tool
    // whose rows are all pools of the same token, so a median price is
    // meaningful — and a single pool's `priceUsd` can be thousands of times
    // wrong while its liquidity/marketCap inherit the error.
    const rows = toPairRows(result, asOfMs);
    const priceSanity = assessCrossPoolPrices(rows);
    const list = buildPairListFromRows(rows, {
      endpoint: "/token-pairs/v1",
      providerOrder: "unspecified",
      providerPairs: result,
      query: parsed.query,
      asOfMs,
      priceSanity,
    });

    return ok({
      chainId: chainId.toLowerCase(),
      tokenAddress,
      priceUsdMedianAcrossPools: priceSanity.priceUsdMedianAcrossPools,
      pricePoolOutliers: priceSanity.pricePoolOutliers,
      ...list,
    });
  },
};
