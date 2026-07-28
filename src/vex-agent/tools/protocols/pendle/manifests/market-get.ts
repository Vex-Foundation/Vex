import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";

/**
 * `pendle.market.get` — one market's identity, accepted tokens and live rates.
 *
 * The description is written for an agent with NO conversation context, so it
 * says what the tool cannot do as plainly as what it can: a matured market has
 * no live rates, and every Pendle trade is exact-INPUT (`outputs` in Pendle's
 * convert API is a list of addresses with no amount field, so an exact-output
 * trade is not expressible at all).
 *
 * This module owns the tool's CONTRACT. Composition into `PENDLE_TOOLS` lives in
 * `manifest.ts`, the retrieval passage in `embeddings/pendle/market-reads.ts`,
 * and the navigation facet in `navigation/entries-market.ts`.
 */
export const PENDLE_MARKET_GET_TOOL: ProtocolToolManifest = {
  toolId: "pendle.market.get",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "Look up ONE Pendle market by its market (LP), PT or YT address and get everything needed before quoting it: " +
    "full leg identity (PT, YT, SY, underlying, accounting asset), expiry and days to maturity, whether it has " +
    "MATURED, the token lists the market accepts for minting/redeeming and for swap input/output (bounded per list, " +
    "each with its full `total` and a `truncated` flag — a token outside the shown slice may still be accepted), and " +
    "Pendle's own live rates (underlying↔PT, underlying↔YT, implied APY as a percent). Use the accepted-token lists to pick a " +
    "valid tokenIn/tokenOut before calling a quote — an off-list token is Pendle's most common 400. Works for MATURED " +
    "markets, which the trading tools cannot resolve; a matured market returns identity and accepted tokens with " +
    "rates: null, because Pendle serves no live rates once a market expires. Rates are pre-trade reference prices, " +
    "not a guaranteed fill, and Pendle trades are exact-INPUT only — you name amountIn and receive an estimate, never " +
    "a guaranteed amountOut. Read-only, no side effects.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        "Chain slug or numeric id — one of Pendle's supported chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc', 1, 42161). An unsupported chain is rejected by name. The same address on another chain is a different asset.",
    },
    {
      key: "market",
      type: "string",
      description:
        "Market (LP) CONTRACT ADDRESS, 0x-prefixed 40-hex. Pass exactly ONE of market, pt or yt — passing two is rejected by name rather than resolved.",
    },
    {
      key: "pt",
      type: "string",
      description:
        "Principal-token CONTRACT ADDRESS, 0x-prefixed 40-hex. Use this when you hold or are pricing a PT and do not know its market.",
    },
    {
      key: "yt",
      type: "string",
      description:
        "Yield-token CONTRACT ADDRESS, 0x-prefixed 40-hex. Use this when you hold or are pricing a YT and do not know its market.",
    },
  ],
  exampleParams: { chain: "ethereum", market: "0x34280882267ffa6383b363e278b027be083bbe3b" },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.market.get"],
};
