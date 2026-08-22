import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";
import { PENDLE_READ_HISTORY_FIELDS } from "@tools/pendle/read/types.js";
import { PENDLE_HISTORY_DEFAULT_FIELDS, PENDLE_READ_MAX_SERIES_POINTS } from "../market-read-params.js";

/**
 * `pendle.market.history` — the time series behind a market's headline rate.
 *
 * The selectable field list is generated from the live-verified allowlist rather
 * than restated, so the description can never drift from what the endpoint
 * actually serves (it answers HTTP 400 for the documented-but-unserved fields).
 *
 * Contract only; registration, passage and facet live where `market-get.ts` names them.
 */
export const PENDLE_MARKET_HISTORY_TOOL: ProtocolToolManifest = {
  toolId: "pendle.market.history",
  publicName: "pendle__market_history_get",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "Time series for ONE Pendle market — implied APY, underlying APY, TVL, PT/YT/LP price, traded volume and pool " +
    "composition, at hourly, daily or weekly resolution. This is how you tell whether today's fixed rate is high or " +
    "low for this market before locking it until expiry; the current rate alone cannot answer that. Returns one row " +
    "per point with the unit in every field name (APYs as percent values, USD as exact decimal strings), plus min, " +
    "max, first, last and the relative change per requested field. The window is bounded: a request covering more " +
    `than ${PENDLE_READ_MAX_SERIES_POINTS} points is rejected by name so nothing is truncated silently. Historical ` +
    "rates describe the past and do not predict the rate you will get — quote the trade for that. Read-only.",
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
        "Market (LP) CONTRACT ADDRESS, 0x-prefixed 40-hex. Not the PT or YT - resolve those to their market with pendle__market_get first.",
    },
    {
      key: "timeFrame",
      type: "string",
      description: "Resolution: 'hour', 'day' (default) or 'week'. Anything else is rejected by name.",
    },
    {
      key: "fields",
      type: "string",
      description:
        `Comma-separated series fields. Default: ${PENDLE_HISTORY_DEFAULT_FIELDS.join(",")}. Selectable: ` +
        `${PENDLE_READ_HISTORY_FIELDS.join(", ")}. An unknown field is rejected by name — Pendle serves only these. ` +
        "Ask for fewer fields to spend fewer compute units.",
    },
    {
      key: "from",
      type: "string",
      description:
        "Window start as an ISO-8601 instant (e.g. '2026-07-20T00:00:00Z'). Omit to let Pendle choose the window. " +
        `Combined with timeFrame it must cover at most ${PENDLE_READ_MAX_SERIES_POINTS} points.`,
    },
    {
      key: "to",
      type: "string",
      description: "Window end as an ISO-8601 instant. Must be later than `from`. Omit for 'up to now'.",
    },
  ],
  exampleParams: {
    chain: "ethereum",
    market: "0x34280882267ffa6383b363e278b027be083bbe3b",
    timeFrame: "day",
    fields: "impliedApy,tvl",
    from: "2026-06-27T00:00:00Z",
  },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.market.history"],
};
