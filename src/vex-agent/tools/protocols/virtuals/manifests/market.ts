import type { ProtocolToolManifest } from "../../types.js";
import { VIRTUALS_MARKET_DISCOVERY } from "../../embeddings/virtuals/market.js";
import {
  GECKOTERMINAL_MAX_LIMIT,
  GECKOTERMINAL_TIMEFRAMES,
} from "@tools/virtuals/candles/geckoterminal.js";
import { VP_API_MAX_LIMIT } from "@tools/virtuals/trades/vp-api.js";
import { VIRTUALS_CANDLE_SOURCES } from "../handlers/candles.js";

// The two market-history reads. Both RESOLVE THE AGENT FIRST from its numeric
// id and then choose the source from the agent's own chain and lifecycle stage,
// which is the only way to get this right: the same agent's history lives in
// two entirely different places before and after graduation, and one of the
// four chains has no tape at all.
//
// Both tools answer an unavailable cell with `supported: false` and the MEASURED
// reason, never with an empty list - an empty list here would read as "this
// agent has never traded", which is a different and much more expensive claim.

export const VIRTUALS_MARKET_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.trades",
    publicName: "virtuals__agent_trades_list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "The live BONDING-CURVE trade tape for one Virtuals agent, straight from the provider's own feed - the same feed app.virtuals.io renders under a bonding agent. Use this when the user asks who is trading a pre-graduation agent, how much is moving through its curve, or whether a fresh launch has any real flow behind it. Give it the numeric agent id; it resolves the chain and the curve token itself. Each trade carries txHash, txSender, isBuy, the agent-token and VIRTUAL amounts as whole-token decimal strings (NOT wei), the price in VIRTUAL per agent token, and a unix-seconds timestamp. Narrow with `side` (both, buys, sells) and `limit`. COVERAGE IS MEASURED AND PARTIAL, and the tool says so rather than returning an empty list: base and solana have the tape (the provider's own SDK numbers exactly those two chains, and both returned live rows); robinhood and ethereum have NO chain id in that feed - a live robinhood bonding agent returned an empty tape while its API row carried a full price series - so those two answer `supported: false` with that reason. A GRADUATED agent also returns an empty tape on every chain: this feed covers the curve only, and the reply says so explicitly so the emptiness is never read as 'no trading'. For a graduated agent use virtuals__agent_candles_list or the dexscreener tools. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "number", required: true, description: "Numeric Virtuals agent id, exactly as virtuals__agents_discover returns it." },
      { key: "limit", type: "number", description: `Trades to return, newest first (default 30, max ${VP_API_MAX_LIMIT}). Out of range is rejected, not clamped.` },
      { key: "side", type: "string", enum: ["both", "buys", "sells"], description: "Which side of the tape: both (default), buys only, or sells only. Applied by the provider." },
    ],
    exampleParams: { id: 135655, limit: 30 },
    discovery: VIRTUALS_MARKET_DISCOVERY["virtuals.trades"],
  },
  {
    toolId: "virtuals.candles",
    publicName: "virtuals__agent_candles_list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "OHLCV price history for one Virtuals agent, by numeric agent id, from whichever source actually has it. Use this when the user wants a price chart, a trend, or the high and low over a period for a Virtuals agent; call virtuals__agents_discover first if you do not have the id. Returns candles oldest-bucket-first with open, high, low, close and volume as decimal strings, the `source` and `denomination` the bars came from, a `coverage` block, and the exact `beforeTimestampSeconds` value that walks further back. A BONDING AGENT NOW CHARTS ON EVERY CHAIN THAT HAS A CURVE, which is the change here: the public chart provider indexes AMM pools, so it answered 404 for a base or robinhood bonding pair, and those bars are now BUILT instead. Source per lifecycle and chain, every cell measured: a GRADUATED agent charts from its AMM pool through the chart provider on base, robinhood and solana; a BONDING agent on solana also charts there, because its curve is an indexed Meteora dynamic-bonding-curve pool; a BONDING agent on base is built from the provider's own curve trade feed; a BONDING agent on robinhood is built from the curve pair's own on-chain Swap logs, which is the only source that exists there because that chain has no trade feed at all. Ethereum has no Virtuals curve. `source` overrides that choice and is refused by name when the requested source cannot serve the agent, so `onchain` gives the exact on-chain series on base too and `tape` gives the fast one. THE TWO CURVE SOURCES PRICE IN VIRTUAL PER AGENT TOKEN, exactly, as the ratio of the two token amounts each swap moved; `currency` applies only to the chart provider and is refused with the curve sources rather than answered in a unit you did not ask for. COVERAGE IS REPORTED, NEVER GUESSED, because each source stops for a different reason. The curve trade feed has no cursor of any kind (offset, page, skip and four spellings of a timestamp bound were each sent live and each silently ignored) and the provider caps it at 1000 trades, so when it comes back full that is a ceiling and not the start of the curve: `coverage.stopReason` says `tape_ceiling` and the answer points at the on-chain source, which has no such ceiling. A log scan reports the block range it covered, the windows it spent and whether a work budget stopped it early. Buckets with no trades are ABSENT rather than zero-filled: a curve that did not trade has no price, and a zero bar would assert one. Choose `timeframe` (minute, hour, day), `aggregate` (per timeframe: minute 1, 5 or 15; hour 1, 4 or 12; day 1 only) and `limit` (max 1000). An illegal timeframe and aggregate pairing is refused by name before any call is made, and the same sets apply whichever source answers, so one parameter contract holds across all three. For the individual trades behind a bar call virtuals__agent_trades_list. Prices are display-grade market data, never a quote: price a trade with the venue tool that would execute it. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "number", required: true, description: "Numeric Virtuals agent id, exactly as virtuals__agents_discover returns it." },
      { key: "timeframe", type: "string", enum: GECKOTERMINAL_TIMEFRAMES, description: "Bucket size: minute, hour (default) or day. The same three values whichever source answers." },
      { key: "aggregate", type: "number", description: "How many buckets each candle spans, and the legal set depends on the timeframe: minute accepts 1, 5 or 15; hour accepts 1, 4 or 12; day accepts only 1. Default 1. An illegal pairing is refused by name before the call is made." },
      { key: "limit", type: "number", description: `Candles to return (default 100, max ${GECKOTERMINAL_MAX_LIMIT}). Out of range is rejected by name, never clamped.` },
      { key: "beforeTimestampSeconds", type: "number", description: "Walk backwards: return buckets strictly before this unix-seconds mark. The reply hands you the value to use for the next page, and pages neither skip nor overlap." },
      { key: "currency", type: "string", enum: ["usd", "token"], description: "Denominate the candles in usd (default) or in the pool's quote token. Applies to the chart provider only; the curve sources price in VIRTUAL and refuse this by name." },
      { key: "source", type: "string", enum: VIRTUALS_CANDLE_SOURCES, description: "Which history to read: auto (default) picks by lifecycle and chain, geckoterminal reads the indexed pool, tape reads the provider's curve trade feed, onchain reads the curve pair's own Swap logs. A source that cannot serve the agent is refused by name." },
    ],
    exampleParams: { id: 135655, timeframe: "hour", limit: 100 },
    discovery: VIRTUALS_MARKET_DISCOVERY["virtuals.candles"],
  },
];
