import type { ProtocolToolManifest } from "../../types.js";
import { VIRTUALS_MARKET_DISCOVERY } from "../../embeddings/virtuals/market.js";
import {
  GECKOTERMINAL_MAX_LIMIT,
  GECKOTERMINAL_TIMEFRAMES,
} from "@tools/virtuals/candles/geckoterminal.js";
import { VP_API_MAX_LIMIT } from "@tools/virtuals/trades/vp-api.js";

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
      "OHLCV price history for one Virtuals agent's pool, by numeric agent id. Use this when the user wants a price chart, a trend, or the high and low over a period for a Virtuals agent; call virtuals__agents_discover first if you do not have the id, and expect a typed refusal rather than an empty chart wherever the history does not exist. Returns candles oldest-bucket-first with open, high, low, close and volume as decimal strings, plus the network and pool the data came from and the exact `beforeTimestampSeconds` value that walks further back. Choose `timeframe` (minute, hour, day), `aggregate` (per timeframe: minute 1/5/15, hour 1/4/12, day 1 only) and `limit` (max 1000, also the provider's own ceiling), and `currency` usd or token. WHICH POOL, AND WHERE THE HISTORY DOES NOT EXIST, both measured: a GRADUATED agent charts from its AMM pool and works on base, robinhood and solana; a BONDING agent has only its curve pair, which is indexed on solana (a Meteora dynamic-bonding-curve pool) but NOT on any EVM chain - a live base curve pair answered 404 - so that cell returns `supported: false` naming the reason and pointing at virtuals__agent_trades_list and at the 24h price samples virtuals__agents_discover can attach with includePriceSeries. Virtuals' own klines endpoint is NOT used: it returned an empty series to every combination probed, including for an agent whose trade tape was live in the same session. The upstream chart provider rate-limits hard, so a 429 is reported as a retryable failure and never as an empty chart. Prices here are display-grade market data, never a quote. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "number", required: true, description: "Numeric Virtuals agent id, exactly as virtuals__agents_discover returns it." },
      { key: "timeframe", type: "string", enum: GECKOTERMINAL_TIMEFRAMES, description: "Bucket size: minute, hour (default) or day. The provider names these itself and rejects anything else." },
      { key: "aggregate", type: "number", description: "How many buckets each candle spans, and the legal set depends on the timeframe: minute accepts 1, 5 or 15; hour accepts 1, 4 or 12; day accepts only 1. Default 1. An illegal pairing is refused by name before the call is made." },
      { key: "limit", type: "number", description: `Candles to return (default 100, max ${GECKOTERMINAL_MAX_LIMIT} - the provider's own stated ceiling).` },
      { key: "beforeTimestampSeconds", type: "number", description: "Walk backwards: return buckets strictly before this unix-seconds mark. The reply hands you the value to use for the next page." },
      { key: "currency", type: "string", enum: ["usd", "token"], description: "Denominate the candles in usd (default) or in the pool's quote token." },
    ],
    exampleParams: { id: 96200, timeframe: "hour", limit: 100 },
    discovery: VIRTUALS_MARKET_DISCOVERY["virtuals.candles"],
  },
];
