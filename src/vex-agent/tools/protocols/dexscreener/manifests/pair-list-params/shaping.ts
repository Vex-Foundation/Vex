/**
 * The params that SHAPE a DexScreener pair answer rather than filter it —
 * window/paging, projection, sorting, timeframe selection and the drop
 * diagnostics (split out of `../pair-list-params.ts` in 0R.16,
 * refactor-only). None of them can reach a row outside the provider's
 * at most 30.
 */

import type { ProtocolParamDef } from "../../../types.js";

/** Window / paging. Replaces every silent default. */
export const PAIR_WINDOW_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "limit",
    type: "number",
    description:
      "Max rows to return (1-200). Omit to receive EVERY row DexScreener returned (at most 30 — "
      + "its hard cap). Set this only to spend fewer tokens; 0 is rejected because it cannot mean "
      + "both 'none' and 'all'.",
  },
  {
    key: "offset",
    type: "number",
    description:
      "Skip this many rows of the SAME provider window (default 0). It cannot reach rows beyond "
      + "DexScreener's 30 — there is no pagination.",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated extra output fields, ADDED to the default lean row (identity is never "
      + "projected away). Use 'full' for every field — that is also how to discover the names, "
      + "since a misspelled one is rejected with the complete accepted list. Opt-in covers the "
      + "market-cap and FDV figures, the reserve amounts on each side of the pool, every "
      + "individual m5/h1/h6/h24 window, the info/social flags, the DexScreener link, and the "
      + "issuer-authored display names — which are the single most expensive field in this API "
      + "(one live pool's name is 34,090 characters).",
  },
];

/**
 * The drop-diagnostics param, shared verbatim by all three families.
 *
 * One key, one sentence, one meaning — the same rule that put `limit` and
 * `chainIds` in one place. The index caveat is not decoration: an index the
 * agent believes is stable becomes a row identity it will try to reuse on the
 * next call, against a window the provider has already re-chosen.
 */
export const EXPLAIN_DROPS_PARAM: ProtocolParamDef = {
  key: "explainDrops",
  type: "boolean",
  description:
    "Also emit droppedRows[]: at most 10 rejected rows, each carrying the FIRST filter that "
    + "rejected it, that row's own value, and the threshold you passed — which answers 'missed by "
    + "0.1 or by 100x?' in the same call. droppedByFilter stays the full census; this is a sample, "
    + "and droppedRowsTruncated states whether more were dropped than shown. providerRowIndex is "
    + "the row's 0-based position in THIS response before filtering. It is deterministic inside "
    + "this answer and NOT stable across calls, since DexScreener re-chooses its window every "
    + "time. rowId carries the row's own identifier — a pool address, a listed-asset address, or a "
    + "narrative slug — and that is the value worth keeping. Off by default, and it costs nothing "
    + "when off.",
};

/**
 * The subtractive-projection param for the PAIR family, which accepts no names.
 *
 * Declared rather than omitted so the refusal can carry the reason: an agent
 * told only "unknown parameter" tries the next spelling, while one told the
 * fields are already additive stops and uses `fields`.
 */
export const PAIR_OMIT_FIELDS_PARAM: ProtocolParamDef = {
  key: "omitFields",
  type: "string",
  description:
    "Comma-separated output fields for REMOVAL. Pair rows accept NO names here, deliberately: "
    + "every issuer-authored text field beyond the two symbols is already opt-in via \"fields\", so "
    + "omitting one is the same as simply not requesting it; the symbols themselves are row "
    + "identity; and every number here is financially consumed. Shrink a pair row with \"fields\" "
    + "and \"limit\" instead. A rejection names each refused field and repeats this reason. The "
    + "parameter does real work on the feed and narrative tools, where a mandatory description CAN "
    + "be dropped.",
};

/** Sorting. */
export const PAIR_SORT_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "sortBy",
    type: "string",
    description:
      "relevance | liquidityUsd | volumeUsd | turnoverRatio | marketCapUsd | fdvUsd | "
      + "pairAgeSeconds | priceChangePct | txnCount | buySellRatio. 'relevance' means 'as "
      + "DexScreener returned' — its order is neither a ranking nor stable. Sorting cannot recover "
      + "a pool outside the 30-row window.",
  },
  {
    key: "sortDir",
    type: "string",
    description: "desc (default) or asc. Rows whose sort metric is unknown always sort last.",
  },
];

/** Which timeframe the `*Selected` outputs and the flow filters read. */
export const PAIR_TIMEFRAME_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "window",
    type: "string",
    description:
      "m5 | h1 | h6 | h24 (default h24). Selects the window behind volumeUsdSelected, "
      + "priceChangePctSelected and the volume/txn/price-change filters. Measured coverage: volume "
      + "and txns carry all four windows on 100% of rows, but priceChange carries m5 on only 31% "
      + "of rows, h1 61%, h6 74%, h24 87% — a price-change filter has nothing to compare on the "
      + "rest, and drops them.",
  },
  {
    key: "includeAllWindows",
    type: "boolean",
    description:
      "Emit all four windows of volume, txns, price change, buy/sell ratio and turnover on every "
      + "row instead of just the selected one (adds roughly 250 B per row).",
  },
];
