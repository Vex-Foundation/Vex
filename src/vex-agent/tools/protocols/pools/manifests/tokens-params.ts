/**
 * Shared filter vocabulary for `pools.tokens`.
 *
 * Every enum and bound here was read back out of the provider's own zod
 * rejection messages during the probe, not guessed: an unknown `sortBy` answers
 * HTTP 400 listing all fourteen accepted keys, and the client surfaces that text
 * verbatim when a value still slips through.
 *
 * EVERY filter below is applied SERVER-SIDE. That matters for
 * honesty: a "0 rows" answer here means the provider found nothing matching, not
 * that Vex filtered a page down to nothing, and the handler echoes the active
 * filters so the emptiness is attributable either way.
 *
 * THE LAUNCHPAD'S OWN BADGES MAP ONTO THESE PARAMETERS, and the mapping was read
 * out of the pools.fun frontend bundle rather than guessed (`bundle/
 * index-Dvsce_I0.js`, functions `$Z`/`qZ`): its five scope chips are
 *   All   -> platform=all
 *   Pools -> platform=poolsfun
 *   Sushi -> platform=sushi
 *   Vex   -> platform=poolsfun + vexAttested=true
 *   Fees to holders -> platform=poolsfun + holderRewards=true
 * There is no `platform=vex`: sending one is HTTP 400 naming the three real
 * values. So `vexAttested` and `holderRewards` are separate boolean filters
 * here, combinable with any platform, exactly as the app sends them.
 *
 * Kept in its own file because the wide filter surface is the
 * part of a manifest that grows.
 */

import type { ProtocolParamDef } from "../../types.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import {
  POOLS_DISCOVER_LIMIT_CAP,
  POOLS_PLATFORMS,
  POOLS_SORT_KEYS,
  POOLS_SORT_ORDERS,
  POOLS_VOL_TIMEFRAMES,
} from "@tools/pools-fun/constants.js";

/**
 * Numeric bounds. `limit` mirrors the provider's real 100-row cap rather than
 * inventing a larger one, so the bound the agent is told is the bound that
 * exists. The market-cap, volume, transaction-count and age floors are open
 * upward - the provider imposes no ceiling on them and neither should we.
 */
export const POOLS_TOKENS_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: POOLS_DISCOVER_LIMIT_CAP },
  minMarketCapUsd: { domain: "nonNegative" },
  maxMarketCapUsd: { domain: "nonNegative" },
  minVolUsd: { domain: "nonNegative" },
  minTxCount24h: { domain: "nonNegative", integer: true, min: 0 },
  maxAgeHours: { domain: "nonNegative" },
};

/**
 * Filters the provider structurally cannot serve, answered BY NAME with the
 * fact that makes them meaningless rather than a bare "unknown parameter".
 *
 * Declared as the manifest's `rejectedParams`, NOT as params and NOT as a
 * handler-side check. The strict param boundary (`runtime/params.ts`) rejects
 * every undeclared key before a handler is entered, so a handler-side check for
 * these would be dead code in production; declaring them as real params would
 * advertise filters that do not work. `rejectedParams` is the one place the
 * explanation actually reaches the agent.
 */
export const POOLS_UNSUPPORTED_PARAMS: Readonly<Record<string, string>> = {
  minHolders: "pools.fun exposes no holder count on any endpoint.",
  minLiquidityUsd:
    "pools.fun exposes no liquidity figure - research pool liquidity with dexscreener, where these pools are indexed as sushiswap v3 on chain robinhood.",
  chainIds:
    "pools.fun is Robinhood Chain only (4663) and the chain is pinned inside Vex - there is nothing to select.",
  status:
    "pools.fun has NO bonding curve and no graduation: every token trades in a live pool from its first block, so there is no curve-versus-graduated stage. To find recent launches use maxAgeHours.",
  graduated:
    "pools.fun has NO graduation - a token is in a real pool from its first block. To find recent launches use maxAgeHours.",
};

export const POOLS_TOKENS_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "platform",
    type: "string",
    enum: [...POOLS_PLATFORMS],
    description:
      "Which launcher to list, poolsfun (default, the pools.fun PartyFactory), sushi (the older SushiLaunchpad on the same chain), or all. These are two different launchers whose tokens sit side by side on Robinhood Chain; the row echoes which one produced it.",
  },
  {
    key: "sortBy",
    type: "string",
    enum: [...POOLS_SORT_KEYS],
    description:
      "Server-side ranking key. Accepts marketCapUsd (default), vol1m, vol5m, vol1h, vol6h, vol24h, txCount24h, priceChange1m, priceChange5m, priceChange1h, priceChange6h, priceChange24h, lastTradeAt, deployedAt. Sort by deployedAt for the newest launches and by vol1h or txCount24h for what is actually being traded right now.",
  },
  {
    key: "order",
    type: "string",
    enum: [...POOLS_SORT_ORDERS],
    description:
      "Ranking direction: desc (default, biggest or newest first) or asc. Pair it with sortBy - asc on deployedAt walks the oldest launches, desc gives the freshest.",
  },
  {
    key: "limit",
    type: "number",
    description:
      `Maximum rows returned, 1-${POOLS_DISCOVER_LIMIT_CAP} (the provider's own cap). Omitting it leaves the page size to the provider. Use the returned cursor to walk further rather than asking for more than the cap.`,
  },
  {
    key: "cursor",
    type: "string",
    description:
      "Opaque pagination token: pass back the nextCursor from a previous reply to fetch the following page. Keep every other filter identical between pages or the cursor walks a different result set.",
  },
  {
    key: "query",
    type: "string",
    description:
      "Free-text match against token names and symbols, applied by the launchpad alongside every other filter here. Reach for it when a name has to be combined with filters - a name plus an age or volume floor, say. When the name is all you have, the dedicated pools name-lookup tool is the shorter path.",
  },
  {
    key: "live",
    type: "boolean",
    description:
      "When true, restrict the list to the provider's live feed of recently active tokens instead of the whole market. Default false, which lists everything matching the other filters.",
  },
  {
    key: "minMarketCapUsd",
    type: "number",
    description:
      "Keep only tokens whose market capitalisation in US dollars is at least this. The figure is the provider's own display-grade estimate, not an executable valuation.",
  },
  {
    key: "maxMarketCapUsd",
    type: "number",
    description:
      "Keep only tokens whose market capitalisation in US dollars is at most this. Pair with minMarketCapUsd to bracket a size band; the figure is display-grade.",
  },
  {
    key: "minVolUsd",
    type: "number",
    description:
      "Keep only tokens whose traded volume in US dollars over volTimeframe is at least this. It REQUIRES volTimeframe - a volume floor without a window has no meaning and is rejected by name rather than silently applied to some default window.",
  },
  {
    key: "volTimeframe",
    type: "string",
    enum: [...POOLS_VOL_TIMEFRAMES],
    description:
      "The window the minVolUsd floor is measured over: 1m, 5m, 1h, 6h or 24h. Supply it together with minVolUsd; on its own it filters nothing and is rejected.",
  },
  {
    key: "minTxCount24h",
    type: "number",
    description:
      "Keep only tokens with at least this many trades in the last 24 hours. A whole number; useful for separating tokens with real flow from ones whose market cap moved on a single fill.",
  },
  {
    key: "maxAgeHours",
    type: "number",
    description:
      "Keep only tokens launched within this many hours. This is the fresh-launch filter on pools.fun: there is no bonding curve or graduation stage to filter on, so age is what separates a brand new token from an established one.",
  },
  {
    key: "vexAttested",
    type: "boolean",
    description:
      "true keeps only tokens the launchpad marks as carrying a Vex attestation. This is an OPT-IN SWITCH, not a two-sided filter: the launchpad accepts only true, so false (or omitting it) means the filter is not applied and there is no way to ask for the tokens WITHOUT an attestation. The flag is the launchpad's own claim about its index; the attestation itself is a signature Vex published for a launch it made.",
  },
  {
    key: "holderRewards",
    type: "boolean",
    description:
      "true keeps only tokens that stream their fees to holders (fees to holders, opted in at launch and locked from then on). Same opt-in switch as vexAttested: only true is accepted, false or omitted means unfiltered, and the complement cannot be requested. Rows that match carry holderRewardsMode (token, paired or both) and holderRewardsDistributor. Combining it with vexAttested asks for tokens that are BOTH, which matched nothing when this was measured - that is a fact about the market, not a rejected filter.",
  },
  {
    key: "deployerAddress",
    type: "string",
    description:
      "Keep only tokens deployed by this wallet address, matched server-side. Use it to see everything one launcher has created.",
  },
  {
    key: "feeRecipientAddress",
    type: "string",
    description:
      "Keep only tokens whose creator fee stream is directed at this wallet address, matched server-side. On pools.fun the fee recipient can differ from the deployer, so this answers who EARNS from a token rather than who deployed it.",
  },
];
