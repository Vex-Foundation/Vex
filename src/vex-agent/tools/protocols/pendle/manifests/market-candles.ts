import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";
import { PENDLE_READ_MAX_SERIES_POINTS } from "../market-read-params.js";

/**
 * `pendle.market.candles` — OHLCV for one PT / YT / LP asset.
 *
 * The description names the endpoint's documented volume defect up front (LP
 * volume is always 0 here) so an agent never concludes "this pool does not
 * trade" from a structural zero.
 *
 * Contract only; registration, passage and facet live where `market-get.ts` names them.
 */
export const PENDLE_MARKET_CANDLES_TOOL: ProtocolToolManifest = {
  toolId: "pendle.market.candles",
  publicName: "pendle__market_candles_get",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "Price candles (open/high/low/close/volume) for ONE Pendle asset — a PT, a YT or an LP token — at hourly, daily " +
    "or weekly resolution. Use it to see how a PT's price has moved before buying or exiting one. Timestamps are " +
    "returned as ISO instants. A candle with no recorded trades reports volume null, never 0, and for LP assets " +
    "Pendle reports volume as 0 on this endpoint regardless — use pendle.market.history with the tradingVolume field " +
    `for a market's real traded volume. At most ${PENDLE_READ_MAX_SERIES_POINTS} rows are returned and any ` +
    "truncation is stated explicitly. These are provider price marks, not executable quotes: what you would receive " +
    "depends on the market's depth at your size. Read-only.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        "Chain slug or numeric id (e.g. 'ethereum', 'base', 8453). An unsupported chain is rejected by name.",
    },
    {
      key: "asset",
      type: "string",
      required: true,
      description:
        "PT, YT or LP CONTRACT ADDRESS, 0x-prefixed 40-hex. This endpoint covers those three only — it does not price SY or ordinary tokens. pendle.market.get lists a market's legs.",
    },
    {
      key: "timeFrame",
      type: "string",
      description: "Candle size: 'hour', 'day' (default) or 'week'. Anything else is rejected by name.",
    },
    {
      key: "from",
      type: "string",
      description:
        "Window start as an ISO-8601 instant (e.g. '2026-07-20T00:00:00Z'). Omit to let Pendle choose the window. " +
        `Combined with timeFrame it must cover at most ${PENDLE_READ_MAX_SERIES_POINTS} candles.`,
    },
    {
      key: "to",
      type: "string",
      description: "Window end as an ISO-8601 instant. Must be later than `from`. Omit for 'up to now'.",
    },
  ],
  exampleParams: {
    chain: "ethereum",
    asset: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
    timeFrame: "day",
    from: "2026-06-27T00:00:00Z",
  },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.market.candles"],
};
