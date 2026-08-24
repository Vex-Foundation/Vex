import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_POSITION_READ_DISCOVERY } from "../../embeddings/morpho/position-reads.js";
import {
  MORPHO_ACTIVITY_SORT_KEYS,
  MORPHO_ACTIVITY_TYPE_KEYS,
  MORPHO_MAX_ACTIVITY_LIMIT,
  MORPHO_ORDERS,
} from "@tools/morpho/request.js";

/**
 * `morpho.markets.activity` - the transaction record of Morpho Blue markets.
 *
 * The description is long on purpose (owner decree) and its concrete claims come
 * from the 2026-08-14 live capture: the per-branch amount shapes, the mixed
 * BigInt serialisation, and the observed liquidation rows whose repaid and
 * seized legs sit at 6 and 18 decimals side by side.
 */
export const MORPHO_MARKETS_ACTIVITY_TOOL: ProtocolToolManifest = {
  toolId: "morpho.markets.activity",
  publicName: "morpho__markets_activity_list",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Read the TRANSACTION RECORD of Morpho Blue lending markets: every supply, withdraw, borrow, repay, collateral "
    + "movement and liquidation, filterable by market, chain, address, event type, time window, LIQUIDATOR address, "
    + "a minimum bad-debt or seized-collateral size, and by one TRANSACTION HASH. Use this when "
    + "the user asks what has been happening in a market, whether anyone still uses it, how often and how badly "
    + "borrowers are liquidated there, wants one address audited, or asks what a specific transaction did. "
    + "This is history, not a recommendation signal. Use "
    + "morpho__markets_discover to find a market, morpho__market_get for its current state, and morpho__positions_get "
    + "for what a wallet holds NOW. "
    + "LIQUIDATION ROWS carry `repaidAssets` (debt the liquidator cleared), `seizedAssets` (collateral taken), "
    + "`badDebtAssets` (debt nobody can repay) and `liquidatorAddress`, with `userAddress` naming the BORROWER whose "
    + "position was taken. Frequent or large liquidations are a risk signal about the MARKET, not only its "
    + "borrowers: they say its oracle or its liquidity already failed somebody. A liquidation leaving non-zero bad "
    + "debt is the strongest such signal, because that loss is socialised across everyone supplying the market. "
    + "AMOUNTS. There is no USD figure on any transaction row and this tool invents none: Morpho serves no price at "
    + "the block, and pricing an old amount at today's mark would report a number that never existed. Each amount "
    + "arrives as {raw, decimals, symbol, human} with the market leg it belongs to, and which leg that is DEPENDS ON "
    + "THE EVENT: supply, withdraw, borrow and repay move the LOAN asset; collateral movements move the COLLATERAL "
    + "asset; a liquidation moves both, repaid and bad debt in the loan asset, seized in the collateral asset. One "
    + "live liquidation carried a repaid amount at 6 decimals beside a seized amount at 18, so reading either with "
    + "the other's scale is a thousand-billion-fold error. `shares` are accounting units whose scale Morpho does not "
    + "serve, so each carries scale UNKNOWN and a null decimals; never show one as money. "
    + "FILTERS AND PAGING. Every filter that ran is echoed in `filtersApplied`, and a value outside the accepted set "
    + "is REJECTED BY NAME rather than dropped. `since` and `until` are unix SECONDS, and a milliseconds value is "
    + "refused by name. Morpho ranks and pages server-side over all matches, so `matched` is exact and `hasMore` comes "
    + `from offset plus returned against that total (max ${MORPHO_MAX_ACTIVITY_LIMIT} per page), never from a page `
    + "merely looking full: a live read returned fewer rows than the limit in the middle of a long history. "
    + "RETURNS one row per event: type, the union shape Morpho returned, transaction hash, chain, block number, log "
    + "index, unix and ISO time, the acting address, the liquidator where there is one, the market (marketId, asset "
    + "pair, LLTV percent, listed), both assets with decimals, the amounts and the share counts. Plus a "
    + "`pageBreakdown` counting types and liquidations across the RETURNED rows only, which is not a market's "
    + "liquidation rate. "
    + "LIMITS: a record of the past that says nothing about where a rate goes next. A quiet log on a large market "
    + "and a busy one on a tiny market are both normal, so read volume next to size. No SLA. Read-only - it signs "
    + "nothing and spends nothing.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "marketIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Morpho Blue market ids as a comma list OR an array, up to 20. A market id is a 0x-prefixed 64-hex hash, NOT a "
        + "contract address, and it is chain-scoped; read one from morpho__markets_discover. An address here is "
        + "rejected by name and told what it actually is.",
    },
    {
      key: "chainIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma-separated chains, an array of the same, or 'all'. Slugs or numeric chain ids; discovery ships the "
        + "supported slugs on this tool's `chains` metadata and an unsupported entry is rejected with the full set.",
    },
    {
      key: "walletAddress",
      type: "string",
      description:
        "Scope the history to ONE actor, 0x-prefixed and 40 hex. On liquidation rows this matches the BORROWER "
        + "whose position was taken, not the liquidator - which is what makes it the way to see who liquidated an "
        + "address and when.",
    },
    {
      key: "txHash",
      type: "string",
      description:
        "Look up ONE transaction by its 0x-prefixed 64-hex hash. Use it when the user pastes a hash and asks what it "
        + "did on Morpho; a single transaction can produce several rows, so expect more than one. Morpho declares no "
        + "list form of this filter, so it takes exactly one hash.",
    },
    {
      key: "liquidatorAddress",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma list or array of LIQUIDATOR addresses, up to 20. This is the other side of `walletAddress`, which "
        + "matches the borrower who was liquidated: use this one to profile who is doing the liquidating on a market. "
        + "It only ever matches liquidation rows, so pair it with `types: 'liquidation'` for a clean page.",
    },
    {
      key: "minBadDebtAssetsRaw",
      type: "string",
      description:
        "Keep only liquidations that left at least this much BAD DEBT, in the LOAN asset's RAW base units as a "
        + "quoted string (\"1000000\" is 1 USDC at 6 decimals). Bad debt is loss socialised across everyone supplying "
        + "the market, so this is the direct way to ask 'has this market ever lost lenders money'. Scope it to one "
        + "market or one asset, because a raw floor means different money in different markets. A human decimal "
        + "amount, or an unquoted number, is rejected by name rather than rounded.",
    },
    {
      key: "minSeizedAssetsRaw",
      type: "string",
      description:
        "Keep only liquidations that seized at least this much COLLATERAL, in the COLLATERAL asset's RAW base units "
        + "as a quoted string. Note the different asset from `minBadDebtAssetsRaw`: on one live row the two legs sat "
        + "at 18 and 6 decimals, so the same integer means wildly different money on each. Same by-name refusal of a "
        + "human decimal.",
    },
    {
      key: "types",
      type: "string",
      acceptsStringArray: true,
      description:
        `Event types as a comma list or an array: ${MORPHO_ACTIVITY_TYPE_KEYS.join(", ")}. Omit for every `
        + "type. 'liquidation' alone is the risk lens; 'borrow' and 'repay' show whether anyone actually uses the "
        + "market. A value outside this set is rejected by name.",
    },
    {
      key: "since",
      type: "number",
      description:
        "Only events at or after this unix timestamp, in SECONDS (10 digits today), not milliseconds. A "
        + "milliseconds value is rejected by name: it would select a window thousands of years out and return an "
        + "empty history that reads as a dead market.",
    },
    {
      key: "until",
      type: "number",
      description:
        "Only events at or before this unix timestamp, in SECONDS, not milliseconds. Earlier than `since` is "
        + "rejected by name, because nothing could match.",
    },
    {
      key: "sort",
      type: "string",
      enum: MORPHO_ACTIVITY_SORT_KEYS,
      description:
        `Ranking key, one of: ${MORPHO_ACTIVITY_SORT_KEYS.join(", ")}. Default timestamp. The last three rank `
        + "liquidations by size, the fastest way to the worst ones; they order non-liquidation rows arbitrarily, so "
        + "pair them with types 'liquidation'. Applied server-side over ALL matches.",
    },
    {
      key: "order",
      type: "string",
      enum: MORPHO_ORDERS,
      description:
        "Ranking direction, one of: desc (default, newest or largest first), asc. Anything else is rejected by "
        + "name.",
    },
    {
      key: "offset",
      type: "number",
      description: "Row offset for paging (default 0). Pair it with the `nextOffset` the reply returns.",
    },
    {
      key: "limit",
      type: "number",
      description:
        `Max transactions (default 25, maximum ${MORPHO_MAX_ACTIVITY_LIMIT}). A larger value is REJECTED by name `
        + "rather than clamped; `hasMore` and `nextOffset` report what is left.",
    },
  ],
  exampleParams: { chainIds: "base", types: "liquidation", limit: 25 },
  discovery: MORPHO_POSITION_READ_DISCOVERY["morpho.markets.activity"],
};
