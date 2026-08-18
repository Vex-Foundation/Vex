/**
 * Shared filter vocabulary for `trench.tokens`.
 *
 * `ProtocolParamDef` carries no enum/min/max — the allowed values and bounds
 * live in the description prose here and are ENFORCED by the shared reader
 * module (`protocols/runtime/list-params.ts`, reject-unknown `readEnum`). Kept
 * in its own file (split from day one) because the wide filter surface is the
 * part of the manifest that grows.
 *
 * Grounded in the live REST probe (2026-07-31): every filter maps to a field
 * that actually exists on the wire. Fields the API returns as 0/absent on every
 * token (holders, 24h volume, priceUsd, verified) are DELIBERATELY absent — a
 * filter over an always-zero field silently empties the result and invents a
 * dead market (the exact defect the DexScreener readers exist to prevent).
 */

import type { ProtocolParamDef } from "../../types.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { TRENCH_SORT_KEYS } from "@tools/trench-express/constants.js";

/** Server-side `status` → the API's boolean `launched` filter. */
export const TRENCH_STATUS_VALUES = ["curve", "launched", "all"] as const;
export type TrenchStatusValue = (typeof TRENCH_STATUS_VALUES)[number];

/** Server-side sort keys accepted by `/api/tokens`. */
export const TRENCH_SORT_VALUES = TRENCH_SORT_KEYS;

/**
 * Numeric bounds for the two numeric params. `limit` mirrors the DexScreener
 * window (min 1, no default, 200 ceiling above the provider's 30-row cap so the
 * bound is real without pretending the provider can serve more). `page` is
 * 1-based for the model and translated to the provider's 0-based index in the
 * handler.
 */
export const TRENCH_TOKENS_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: 200 },
  page: { domain: "nonNegative", integer: true, min: 1 },
  // Curve-progress bounds are percentages (0-100), fractional allowed. Enforced
  // by the shared reader; the 0-100 meaning also lives in the param prose below
  // because ProtocolParamDef carries no min/max.
  minCurveProgressPct: { domain: "nonNegative", min: 0, max: 100 },
  maxCurveProgressPct: { domain: "nonNegative", min: 0, max: 100 },
};

/**
 * Params the API structurally cannot support, rejected BY NAME so a silently
 * ignored filter never masquerades as an empty market. Each value the probe
 * confirmed is 0/absent on every token.
 */
export const TRENCH_UNSUPPORTED_PARAMS: Readonly<Record<string, string>> = {
  minHolders: "holder counts are 0 on every Trench token (unpopulated telemetry).",
  minVolume: "24h volume is 0 on every Trench token (unpopulated telemetry).",
  minVolume24h: "24h volume is 0 on every Trench token (unpopulated telemetry).",
  minLiquidityUsd: "Trench exposes no USD liquidity — the curve price has no USD quote asset.",
  minMarketCapUsd: "Trench exposes no priceUsd, so a USD market-cap floor cannot be computed.",
  priceUsd: "Trench token endpoints carry no priceUsd field.",
  verified: "Trench has no verified/badge field.",
  chainIds: "Trench is single-chain (Robinhood Chain 4663) — a chain filter is meaningless.",
};

export const TRENCH_TOKENS_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "status",
    type: "string",
    description:
      "Curve stage filter (server-side): curve (still on the bonding curve), launched (graduated into a pool), or all (default, no filter).",
  },
  {
    key: "sort",
    type: "string",
    description:
      "Sort order (server-side): time (orders by launchedAtMs, newest first, default), price, or bump (recent activity). Unknown values are rejected.",
  },
  {
    key: "limit",
    type: "number",
    description:
      "Max deduped tokens to return, 1-200 (no default — omitting returns the walked window). The provider caps each page at 30; higher limits page-walk and dedupe by address.",
  },
  {
    key: "page",
    type: "number",
    description:
      "1-based single-page index for browsing (min 1). When set, returns just that one provider page (≤30 rows) instead of page-walking.",
  },
  {
    key: "creator",
    type: "string",
    description:
      "Client-side filter: keep only tokens created by this wallet address (exact, case-insensitive).",
  },
  {
    key: "excludeRuggedFlagged",
    type: "boolean",
    description:
      "Client-side filter: drop tokens the launchpad flagged as a likely rug. Defaults to true; set false to include flagged tokens. The response echoes how many were filtered.",
  },
  {
    key: "explainDrops",
    type: "boolean",
    description:
      "When true, include a per-filter census of how many tokens each client-side filter removed. Default false.",
  },
  {
    key: "minCurveProgressPct",
    type: "number",
    description:
      "Client-side: keep only tokens at least this far toward graduating, 0-100, and not greater than maxCurveProgressPct (an inverted band is rejected by name). Curve progress is computed by Vex ON-CHAIN at ONE PINNED BLOCK, echoed as curveProgressBlock: each token's own ethReserve and fakeEth from fakepool_stats over the graduation reserve derived from the Diamond's live ethMcapThreshold — never a hard-coded threshold. Rows are read in Multicall3 batches of at most 30 (so a 600-row page walk costs at most 20 batched calls, not one unbounded call). Applies to bonding-curve tokens; a graduated token counts as 100. Rows whose on-chain read fails are DROPPED and counted; if the threshold itself cannot be read the filter is refused rather than guessed. Setting this (or maxCurveProgressPct/includeCurveProgress) turns the on-chain read on; leaving all three unset keeps the list a pure REST call.",
  },
  {
    key: "maxCurveProgressPct",
    type: "number",
    description:
      "Client-side: keep only tokens no further than this toward graduating, 0-100 (pair with minCurveProgressPct for a band; min must not exceed max). Same pinned-block on-chain curve read as minCurveProgressPct, in Multicall3 batches of at most 30 rows. Graduated tokens count as 100 and are excluded by any max below 100. Rows whose on-chain read fails are DROPPED and counted.",
  },
  {
    key: "includeCurveProgress",
    type: "boolean",
    description:
      "When true, enrich each returned row with curveProgressPct (0-100) WITHOUT filtering. Default false. Computed on-chain at one pinned block (echoed as curveProgressBlock) from each token's own reserves and the Diamond's live graduation threshold, read in Multicall3 batches of at most 30 rows. Graduated rows are 100; rows whose on-chain read fails are dropped and counted. Display/hunting-grade only — a token can graduate between this read and any trade.",
  },
];
