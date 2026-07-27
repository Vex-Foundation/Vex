import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";
import { PENDLE_READ_MAX_ORDERBOOK_PRECISION } from "@tools/pendle/read/request.js";
import {
  PENDLE_ORDERBOOK_DEFAULT_LEVELS,
  PENDLE_ORDERBOOK_DEFAULT_PRECISION,
  PENDLE_ORDERBOOK_MAX_LEVELS,
} from "../market-read-params.js";

/**
 * `pendle.orderbook` — resting limit-order depth Vex cannot trade against.
 *
 * The description leads with that limitation because the tool's whole purpose is
 * disclosure: Vex pins `useLimitOrder: false` on every quote, and an agent that
 * mistook this depth for something it could hit would plan a trade that cannot
 * happen.
 *
 * Contract only; registration, passage and facet live where `market-get.ts` names them.
 */
export const PENDLE_ORDERBOOK_TOOL: ProtocolToolManifest = {
  toolId: "pendle.orderbook",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "Show the resting LIMIT-ORDER depth on one Pendle market: implied-APY levels with their sizes on the long-yield " +
    "and short-yield sides, plus the best level on each side. Vex CANNOT FILL these orders — every Pendle quote and " +
    "trade Vex builds routes through the AMM only, so this is the price quality being forgone, not a price you can " +
    "take. Use it to judge whether an AMM quote is competitive and how deep the market is around your size. A market " +
    "Pendle has not whitelisted for limit orders answers whitelisted:false, which means all of its liquidity is AMM " +
    "liquidity and the quote already sees it — that is an answer, not an error. Sizes are the market's PT/YT unit and " +
    "carry their decimals when Vex can resolve them, otherwise they are flagged unreadable rather than guessed. " +
    "Read-only; Vex never places, signs or cancels a limit order.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        "Chain slug or numeric id (e.g. 'ethereum', 'arbitrum', 42161). An unsupported chain is rejected by name.",
    },
    {
      key: "market",
      type: "string",
      required: true,
      description:
        "Market (LP) CONTRACT ADDRESS, 0x-prefixed 40-hex. Not the PT or YT — pendle.market.get resolves either to its market.",
    },
    {
      key: "precision",
      type: "number",
      description:
        `Decimal places the implied-APY axis is rounded to: whole number 0-${PENDLE_READ_MAX_ORDERBOOK_PRECISION} ` +
        `(default ${PENDLE_ORDERBOOK_DEFAULT_PRECISION}). Provider-required; anything outside the range is rejected ` +
        "by name. Coarser precision merges nearby levels into fewer, larger ones.",
    },
    {
      key: "limit",
      type: "number",
      description:
        `Levels to show per side: whole number 1-${PENDLE_ORDERBOOK_MAX_LEVELS} (default ` +
        `${PENDLE_ORDERBOOK_DEFAULT_LEVELS}); above that it is rejected by name. The response always reports how many ` +
        "levels exist, so nothing is dropped silently.",
    },
  ],
  exampleParams: { chain: "ethereum", market: "0xfce3f966a131c46a51b896ceea3917bc4c302577", precision: 2 },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.orderbook"],
};
