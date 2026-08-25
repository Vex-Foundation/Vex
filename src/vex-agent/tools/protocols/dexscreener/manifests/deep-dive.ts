/**
 * The site DEEP-DIVE family: 4 read-only tools about ONE pool.
 *
 * Where the screening family answers "which pairs", these answer "what is true
 * about this pair": is it safe, what did the price do, who traded it, and who
 * traded the most of it. They are the first tools in this namespace that reach
 * wallet-level and contract-level facts at all.
 *
 * Every `description` here begins from the model-visible draft in
 * `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` sections 10 to
 * 13 (owner decision D-DS7) and extends it only with units, if-omitted
 * semantics and the shared honesty clauses. No sentence of the draft is
 * dropped or reworded.
 *
 * THREE CONTRACTS THE WHOLE FAMILY CARRIES, because each one is a measured
 * hazard rather than a style choice:
 *
 *  1. The pool's AMM id and quote token are RESOLVED, never parameters. A
 *     wrong AMM id answers HTTP 200 with zero rows and a wrong quote token
 *     returns a silently inverted price series.
 *  2. No trader field claims profit. The provider's own "pnl" and "unrealized"
 *     ranks measure net cash flow and current holding value; repeating those
 *     names in a schema would put the error in front of the model every call.
 *  3. A missing audit block is `unavailable` with a reason and never a pass.
 */

import type { ProtocolToolManifest, ProtocolParamDef } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { DEXSCREENER_DEEP_DIVE_DISCOVERY } from "../../embeddings/dexscreener/deep-dive.js";
import { SCREEN_SOURCE_OBSERVATION_CLAUSE } from "./screen-params/clauses.js";
import {
  BARS_DEADLINE_MS_CEILING,
  BARS_DEADLINE_MS_DEFAULT,
  BARS_MAX_PAGES_DEFAULT,
  BARS_PER_CALL,
  BAR_RESOLUTIONS,
  CANDLE_FIELD_GROUPS,
  CANDLE_LIMIT_DEFAULT,
  CANDLE_LIMIT_MAX,
  CANDLE_LIMIT_MIN,
  CANDLE_PRICE_BASES,
  CANDLE_SERIES,
  DEEP_DIVE_SUBJECT_CLAUSE,
  DETAILS_FIELD_GROUPS,
  TRADER_PROFILE_DEPTHS,
  TRADER_SEMANTICS_CLAUSE,
  TRADE_EVENT_TYPES,
  TRADE_LIMIT_DEFAULT,
  TRADE_LIMIT_MAX,
  TRADE_LIMIT_MIN,
  TRADE_MODES,
  TOP_TRADERS_PROVIDER_WINDOW,
  TOP_TRADER_LIMIT_DEFAULT,
  TOP_TRADER_LIMIT_MAX,
  TOP_TRADER_LIMIT_MIN,
  TOP_TRADER_SORTS,
  WALK_BOUNDS_CLAUSE,
} from "./deep-dive-params.js";

/* ------------------------------------------------------------------ */
/* Params shared by the three pair-keyed tools                         */
/* ------------------------------------------------------------------ */

const CHAIN_PARAM: ProtocolParamDef = {
  key: "chain",
  type: "string",
  required: true,
  description:
    "Chain slug the pool lives on, for example solana, ethereum, bsc, base or robinhood. "
    + `${CANONICAL_CHAIN_SENTENCE} A pair or token address is only unique within one chain, so `
    + "this is required; an unknown slug is refused by name with the nearest catalog matches "
    + "rather than answered with zero rows.",
};

const PAIR_ADDRESS_PARAM: ProtocolParamDef = {
  key: "pairAddress",
  type: "string",
  description:
    "The pool (pair) address. Give this when you already know the exact pool, from "
    + "dexscreener__pairs_search, a screening board, or dexscreener__pair_get. Either this or "
    + "tokenAddress is required. When both are given, pairAddress wins and the response says so "
    + "rather than silently ignoring the other.",
};

const TOKEN_ADDRESS_PARAM: ProtocolParamDef = {
  key: "tokenAddress",
  type: "string",
  description:
    "A token contract address, resolved to the deepest pool of the provider's bounded 30-row "
    + "search window on this chain. Use it when you have a token but not a pool. resolutionBasis "
    + "echoes that a resolution happened and resolutionNote states the bound: \"deepest\" means "
    + "deepest among at most 30 pools the provider chose to return, never a claim about every "
    + "pool the token trades in. For the full pool list call dexscreener__token_pairs_list.",
};

/* ------------------------------------------------------------------ */
/* Tool 10: pair details                                               */
/* ------------------------------------------------------------------ */

const PAIR_DETAILS_PARAMS: readonly ProtocolParamDef[] = [
  CHAIN_PARAM,
  PAIR_ADDRESS_PARAM,
  {
    ...TOKEN_ADDRESS_PARAM,
    description:
      TOKEN_ADDRESS_PARAM.description
      + " On this tool the choice also changes the CACHE the provider answers from: the pair-id "
      + "route and the token-id route hold SEPARATE cache entries, and what they routinely differ "
      + "in is FRESHNESS rather than answers. Re-measured twice back to back, the two entries "
      + "carried the same holder counts and the same non-null block set while their underlying "
      + "analyses were 32 minutes and 4 hours 45 minutes apart, and the set of blocks present has "
      + "also been measured flapping between entries. The extreme is real but was seen once: 8,483 "
      + "holders against 351 for six minutes. subject.route names which one served the report, so "
      + "two reports that differ can be recognised as two different questions rather than a "
      + "contradiction.",
  },
  {
    key: "inverted",
    type: "boolean",
    description:
      "Report on the QUOTE token instead of the base token. Defaults to false. Use it when the "
      + "pool is quoted in the token you actually care about; subject.reportedToken always names "
      + "which token the report is about, so orientation is never inferred from the pool name.",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated row field GROUPS to return, not individual field names. Supported groups: "
      + `${DETAILS_FIELD_GROUPS.join(", ")}. Defaults to security, holders, liquidityLocks, `
      + "supply. security carries the per-provider audit blocks and their disagreements and is "
      + "always included. venues adds every venue GoPlus saw the token trading on (measured 26 for "
      + "PEPE), which answers \"where else does this trade\" without a second call. "
      + "suspiciousFunctionSource adds QuickIntel's verbatim Solidity for the functions it flagged "
      + "and is the heaviest group by far, which is why it is opt-in: it is the difference between "
      + "\"canMint: true\" and seeing the mint function. An unknown group name is refused with the "
      + "full list rather than ignored.",
  },
];

/* ------------------------------------------------------------------ */
/* Tool 11: candles                                                    */
/* ------------------------------------------------------------------ */

const CANDLES_PARAMS: readonly ProtocolParamDef[] = [
  CHAIN_PARAM,
  PAIR_ADDRESS_PARAM,
  TOKEN_ADDRESS_PARAM,
  {
    key: "resolution",
    type: "string",
    enum: [...BAR_RESOLUTIONS],
    description:
      `Bar size, one of the 18 the provider serves: ${BAR_RESOLUTIONS.join(", ")}. Defaults to 1h. `
      + "Second-scale series are SPARSE by nature and not a data gap: 5s bars were measured with a "
      + "median 50-second and maximum 1,600-second spacing, so summary.gapCount reports the bars "
      + "the provider did not emit inside the requested range rather than letting a sparse series "
      + "read as a continuous one. Which transport serves a resolution is a provider fact the tool "
      + "hides: daily and above, and 5s, exist only on the WebSocket channel.",
  },
  {
    key: "limit",
    type: "number",
    description:
      `How many bars to return, ${CANDLE_LIMIT_MIN} to ${CANDLE_LIMIT_MAX}. Defaults to `
      + `${CANDLE_LIMIT_DEFAULT}. ${CANDLE_LIMIT_MAX} is the PROVIDER's page size, not a Vex cap. `
      + "It bounds rows RETURNED; a wide startAtMs range is what triggers an internal page walk, "
      + "and the walk is reported separately in providerWindow. The two numbers measure different "
      + `things. ${BARS_PER_CALL} hourly bars decode to about 271 KB of provider bytes, which is `
      + "why the default is modest and the rows are column-oriented. When it holds back bars that "
      + "were inside the requested range, the answer reports truncated true with "
      + "barsWithheldByLimit and a nextBeforeBlock that continues from the OLDEST BAR RETURNED, "
      + "never from the oldest bar fetched: a cursor below the fetched floor would make the "
      + "withheld bars unreachable.",
  },
  {
    key: "endAtMs",
    type: "number",
    description:
      "Newest instant to cover, in epoch MILLISECONDS. Omit it for the latest bars. This is "
      + "resolved internally to a block through the nearest PRIOR trade, so an arbitrary "
      + "historical window costs two requests rather than a page walk (measured: a 90-day-old "
      + "window in 980 ms and 33 KB against 1,582 ms and 436 KB walking). The anchor is "
      + "APPROXIMATE by contract because trades are not evenly spaced: anchorResolvedAtMs and "
      + "anchorDistanceMs report where it actually landed (measured 393 seconds early on one "
      + "target), and an anchor that is missing or too far away falls back to walking backward "
      + "from now with anchorFallback set.",
  },
  {
    key: "startAtMs",
    type: "number",
    description:
      "Oldest instant to cover, in epoch MILLISECONDS. The provider is paged backward until this "
      + "is covered or a bound is hit. When given, it takes precedence over limit: with no "
      + `explicit limit the row bound becomes the provider's full ${CANDLE_LIMIT_MAX}-bar page `
      + "instead of the modest default, so a requested range is never quietly reduced to the "
      + "newest few bars. An explicit limit is still honoured, and every in-range bar it holds "
      + "back sets truncated true and moves nextBeforeBlock to the oldest bar returned, so the "
      + "rest is reached by asking again. coveredRange against requestedRange states exactly how "
      + "much of what you asked for arrived.",
  },
  {
    key: "series",
    type: "string",
    enum: [...CANDLE_SERIES],
    description:
      "price for the price series, marketCap for a market-capitalisation series. Defaults to "
      + "price. Market-cap bars need NO supply argument: the provider computes them, and no "
      + "circulating supply is sent or assumed.",
  },
  {
    key: "priceBasis",
    type: "string",
    enum: [...CANDLE_PRICE_BASES],
    description:
      "Which price columns to return: usd, native (the quote token), or both. Defaults to usd. "
      + "native is the pool's own arithmetic and has no exchange-rate dependence; usd is the one "
      + "most questions mean. Every value is a DECIMAL STRING, never a floating-point number.",
  },
  {
    key: "inverted",
    type: "boolean",
    description:
      "Quote per base instead of base per quote. Defaults to false. The inversion is applied "
      + "against the pool's OWN quote token, which the tool resolves: there is no quote parameter "
      + "because sending a wrong one returns a valid-looking, silently inverted series with no "
      + "marker of any kind (measured).",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated column GROUPS, not individual field names. Supported groups: "
      + `${CANDLE_FIELD_GROUPS.join(", ")}. Defaults to ohlc. volume adds the USD volume column; `
      + "blockRange adds each bar's first and last block, which is what an exact continuation is "
      + "built from. Base and quote token volumes and any volume-weighted average price are "
      + "deliberately NOT offered: the provider's token volumes are raw fixed-point strings and it "
      + "publishes no token decimals here, so all three would be wrong by a power of ten.",
  },
  {
    key: "maxPages",
    type: "number",
    description:
      `How many provider pages of up to ${BARS_PER_CALL} bars the backward walk may fetch. `
      + `Defaults to ${BARS_MAX_PAGES_DEFAULT}; raise it for a deep historical range. There is no `
      + "upper ceiling on it: deadlineMs is the real bound on a walk. Hitting either is reported "
      + "as truncated with the covered range and a nextBeforeBlock cursor, so every bar not "
      + "returned is reachable by asking again.",
  },
  {
    key: "deadlineMs",
    type: "number",
    description:
      `Wall-clock budget for the whole walk, in milliseconds. Defaults to `
      + `${BARS_DEADLINE_MS_DEFAULT}, ceiling ${BARS_DEADLINE_MS_CEILING}. Hitting it is reported `
      + "exactly like the page budget: covered range plus a cursor, never a short answer presented "
      + "as a complete one.",
  },
  {
    key: "beforeBlock",
    type: "number",
    description:
      "Continue a truncated answer: pass back its nextBeforeBlock value unchanged. It is the "
      + "provider's own EXCLUSIVE block anchor, so the continued walk starts at the bar below the "
      + "oldest one the previous answer returned and repeats nothing. It is the only continuation "
      + "this tool has, and it is refused together with endAtMs because both decide where the "
      + "walk starts and honouring one silently would answer a different window than the one "
      + "asked for.",
  },
];

/* ------------------------------------------------------------------ */
/* Tool 12: trades                                                     */
/* ------------------------------------------------------------------ */

const TRADES_PARAMS: readonly ProtocolParamDef[] = [
  CHAIN_PARAM,
  PAIR_ADDRESS_PARAM,
  TOKEN_ADDRESS_PARAM,
  {
    key: "mode",
    type: "string",
    enum: [...TRADE_MODES],
    description:
      "raw for the trade rows, aggregate for one summary block, both for the summary plus the "
      + "rows. Defaults to raw. All three come from the SAME fetch set, so aggregate costs no "
      + "extra requests over raw and both costs nothing over aggregate.",
  },
  {
    key: "eventType",
    type: "string",
    enum: [...TRADE_EVENT_TYPES],
    description:
      `Which events to return: ${TRADE_EVENT_TYPES.join(", ")}. Defaults to all. swap is buys and `
      + "sells together, liquidity is adds and removes together; both are the provider's own "
      + "combined filters and both are served on the WebSocket, because the HTTP channel refuses "
      + "every combined spelling with a structured 400 (measured). buy, sell, add and remove are "
      + "each served on the cheaper HTTP read. The provider validates this value and answers a "
      + "wrong one with a structured rejection rather than ignoring it, so an unsupported value is "
      + "refused here by name instead of quietly widening the query. add and remove are LIQUIDITY "
      + "events: they carry token amounts and no price or USD volume, so they are counted in the "
      + "aggregate's liquidityAdds and liquidityRemoves and are never filed as zero-dollar trades.",
  },
  {
    key: "afterBlock",
    type: "number",
    description:
      "Return only events STRICTLY ABOVE this BLOCK NUMBER. EXCLUSIVE, measured two-sided on a "
      + "boundary block carrying three events: the block you pass is the last one you have "
      + "ALREADY SEEN and none of its events come back, while passing block-minus-one returns all "
      + "three of them. This is the incremental-poll primitive: take the highest blockNumber from "
      + "a previous answer's rows and pass it back to ask what has traded since. MEASURED honoured "
      + "server-side (a lower bound of 25830000 returned 100 rows spanning blocks 25830786 down to "
      + "25830275) and it AND-combines with startAtMs, endAtMs and every other filter. It is a "
      + "BOUND, NOT A CURSOR: the rows inside the window still arrive newest-first, so it narrows "
      + "the window rather than streaming forward from it. The window is served newest-first under "
      + "the provider's 100-row page cap, so a busy pair returns only the newest slice of it: when "
      + "hasMore is true, page DEEPER INTO THE WINDOW with the returned cursor, which this build "
      + "expresses on both channels and which is the only way to reach the rows between afterBlock "
      + "and the oldest block returned. Advancing afterBlock instead would skip them permanently. "
      + "Use it instead of re-reading from the head of history: the provider's live trade push "
      + "acknowledges a subscription and then sends nothing (re-measured), so polling with "
      + "afterBlock and following hasMore is the gapless way to follow a pair.",
  },
  {
    key: "minVolumeUsd",
    type: "number",
    description:
      "Keep only trades of at least this many US dollars. Applied SERVER-side (measured exact: a "
      + "1,000 floor returned a minimum of 1,024). Omit for no floor.",
  },
  {
    key: "maxVolumeUsd",
    type: "number",
    description:
      "Keep only trades of at most this many US dollars. Applied server-side. Combine with "
      + "minVolumeUsd for a size band, which is how a whale filter and a retail filter are both "
      + "expressed.",
  },
  {
    key: "minBaseAmountIn",
    type: "string",
    description:
      "Lower bound on a trade's BASE-token amount, in HUMAN decimals, as a decimal STRING exactly "
      + "as the provider writes them (for example \"1000.5\"). A string and not a number because "
      + "token amounts must never round-trip through binary floating point. The In suffix marks "
      + "human decimals, which is this repository's amount grammar; it does NOT mean the buy side.",
  },
  {
    key: "maxBaseAmountIn",
    type: "string",
    description:
      "Upper bound on a trade's BASE-token amount, in HUMAN decimals, as a decimal string. Pair it "
      + "with minBaseAmountIn for a size band in token terms rather than in dollars.",
  },
  {
    key: "minQuoteAmountIn",
    type: "string",
    description:
      "Lower bound on a trade's QUOTE-token amount, in HUMAN decimals, as a decimal string. The "
      + "quote token is the pool's own and is named in the subject block.",
  },
  {
    key: "maxQuoteAmountIn",
    type: "string",
    description:
      "Upper bound on a trade's QUOTE-token amount, in HUMAN decimals, as a decimal string. Pair it "
      + "with minQuoteAmountIn for a size band measured in the quote token.",
  },
  {
    key: "startAtMs",
    type: "number",
    description:
      "Oldest instant to include, epoch MILLISECONDS. The provider honours this to the SECOND "
      + "(measured: a one-hour window returned 34 rows, every one inside it), so a sub-second "
      + "value is rounded down to the second the provider can actually apply.",
  },
  {
    key: "endAtMs",
    type: "number",
    description:
      "Newest instant to include, epoch MILLISECONDS, second-precise like startAtMs. Together the "
      + "two express \"what happened during that candle\", which is the usual follow-up to "
      + "dexscreener__candles_list.",
  },
  {
    key: "maker",
    type: "string",
    description:
      "A wallet address. Returns that wallet's history ON THIS PAIR and nothing else: transfers, "
      + "other pools and other venues are invisible to this channel, so an empty result is not "
      + "evidence the wallet is inactive.",
  },
  {
    key: "limit",
    type: "number",
    description:
      `How many trade rows to return, ${TRADE_LIMIT_MIN} to ${TRADE_LIMIT_MAX}. Defaults to `
      + `${TRADE_LIMIT_DEFAULT}. ${TRADE_LIMIT_MAX} is the provider's own page size, not a Vex `
      + "cap. Deeper history is reached with cursor, which pages to any depth. A limit below the "
      + "provider's page size withholds nothing: nextCursor is built from the LAST ROW THIS "
      + "ANSWER RETURNED, so the next call resumes at the row immediately after it, and "
      + "pagination reports rowsFetched, rowsReturned and rowsWithheldByLimit.",
  },
  {
    key: "cursor",
    type: "string",
    description:
      "Opaque continuation token from a previous call's nextCursor. It is built from the last row "
      + "that answer RETURNED, never from the oldest row it fetched, so no row is skipped at any "
      + "limit. It encodes the provider's "
      + "exact block, transaction index and event index, so a continued page resumes INSIDE the "
      + "boundary block rather than after it: a block-only cursor was measured skipping a real "
      + "buy that shared the boundary block. It is bound to the pair, orientation and filters of "
      + "the call that issued it and is refused if replayed against a different query.",
  },
  {
    key: "traderProfile",
    type: "string",
    enum: [...TRADER_PROFILE_DEPTHS],
    description:
      `How much counterparty detail each row carries: ${TRADER_PROFILE_DEPTHS.join(", ")}. `
      + "Defaults to compact (buys, sells, dollars in and out, retainedBoughtPct, newOnPair, "
      + "first trade time). full adds the raw balance and base-token volumes. none drops the "
      + "block entirely and is the cheapest shape when only the trades matter. "
      + TRADER_SEMANTICS_CLAUSE,
  },
  {
    key: "maxPages",
    type: "number",
    description:
      "How many provider pages the AGGREGATE mode may walk to cover the requested range. Defaults "
      + `to ${BARS_MAX_PAGES_DEFAULT} with no upper ceiling, because deadlineMs is the real bound `
      + "on a walk. Ignored in raw mode, which returns one page. When the bound "
      + "is hit the summary is renamed pageAggregate and carries rangeFullyCovered false with the "
      + "exact range it did cover, because a one-page summary presented as a range summary is the "
      + "silent cut this avoids.",
  },
  {
    key: "deadlineMs",
    type: "number",
    description:
      `Wall-clock budget for an aggregate walk, in milliseconds. Defaults to `
      + `${BARS_DEADLINE_MS_DEFAULT}, ceiling ${BARS_DEADLINE_MS_CEILING}. Reported exactly like `
      + "maxPages when it is reached.",
  },
];

/* ------------------------------------------------------------------ */
/* Tool 13: top traders                                                */
/* ------------------------------------------------------------------ */

const TOP_TRADERS_PARAMS: readonly ProtocolParamDef[] = [
  CHAIN_PARAM,
  PAIR_ADDRESS_PARAM,
  TOKEN_ADDRESS_PARAM,
  {
    key: "sortBy",
    type: "string",
    enum: [...TOP_TRADER_SORTS],
    description:
      `Which column ranks the leaderboard: ${TOP_TRADER_SORTS.join(", ")}. Defaults to boughtUsd. `
      + "netCashFlowUsd maps to the provider's \"pnl\" rank and currentHoldingValueUsd to its "
      + "\"unrealized\" rank; both provider names are wrong about what they measure, so the names "
      + "here say what the column IS. Ranking runs on the provider over the whole pair, not "
      + "locally over a sample, and asc is a true full-population reverse rank rather than a "
      + "reversal of the top 100 (measured: zero maker overlap between the asc and desc pages of "
      + "the same sort). The sort also decides whether `currentHoldingValueUsd` is derivable at "
      + "all: the provider sends the balance it needs on some rankings and not others, and on "
      + "boughtUsd asc and netCashFlowUsd desc it was measured absent on 100 of 100 rows. Ask for "
      + "currentHoldingValueUsd when that column is the question; `balanceCoverage` on every "
      + "answer reports what actually arrived.",
  },
  {
    key: "sortDir",
    type: "string",
    enum: ["desc", "asc"],
    description:
      "desc for the largest values first, asc for the smallest. Defaults to desc. asc with "
      + "netCashFlowUsd surfaces the wallets that have put in the most and taken out the least on "
      + "this pair; that is a cash-flow statement and not a loss.",
  },
  {
    key: "lookbackDays",
    type: "number",
    description:
      "Rank only wallets active within this many days (the provider's maxDaysAgo), from 1 to 30. "
      + "MEASURED: 30 is the provider's own maximum AND its default. On a 2023-vintage pool with "
      + "no lookback sent, the oldest first trade on every sort was 30.01 days old; mda=30 "
      + "returned the same 100 wallets as omitting it; and mda=31, 60, 90 and 365 each answered "
      + "HTTP 400 with an empty body. So THIS LEADERBOARD IS A 30-DAY LEADERBOARD and cannot rank "
      + "a pair's whole history: a wallet that traded heavily more than 30 days ago does not "
      + "appear at all. A value above 30 is refused by name here rather than sent, because the "
      + "provider's 400 blames the route and would send you to debug an AMM id that is correct. "
      + "The window in force is echoed in filtersApplied on every answer. Measured working: a "
      + "1-day lookback returned 100 rows all with a last trade inside 0.952 days. "
      + "IT WINDOWS THE MONEY FIGURES, NOT ONLY WHO IS ELIGIBLE. Every per-wallet column - buys, sells, volumeUsdBuy, volumeUsdSell, amountBuy, amountSell, firstSwapAtMs, and therefore netCashFlowUsd and activeSpanSeconds - is RECOMPUTED over this window rather than being a lifetime total filtered by recency. Measured on the same wallet: at 30 days it reads buys 29 and volumeUsdBuy 246,836.60, at 1 day it reads buys 3 and 11,325.53, a 28x difference with no marker on the row. So \"how much has this wallet bought here\" is answered for the window in force and never for the pair's whole history.",
  },
  {
    key: "onlyKol",
    type: "boolean",
    description:
      "Restrict the leaderboard to wallets the provider labels as key opinion leaders. Defaults to "
      + "false. MEASURED CAVEAT: this filter returned ZERO rows on the probed pair, so an empty "
      + "result with it on is expected and is not evidence that no notable wallet traded the pair. "
      + "The provider's labelling is its own opaque classification.",
  },
  {
    key: "limit",
    type: "number",
    description:
      `How many wallets to return, ${TOP_TRADER_LIMIT_MIN} to ${TOP_TRADER_LIMIT_MAX}. Defaults `
      + `to ${TOP_TRADER_LIMIT_DEFAULT}. ${TOP_TRADER_LIMIT_MAX} is the provider's whole `
      + "leaderboard. There is NO offset and no cursor: this surface serves one bounded "
      + "leaderboard per sort and wallets beyond it are unreachable, which the envelope states "
      + "rather than hiding behind a page parameter that does nothing.",
  },
];

/* ------------------------------------------------------------------ */
/* The manifests                                                       */
/* ------------------------------------------------------------------ */

export const DEEP_DIVE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.pair.details",
    publicName: "dexscreener__pair_details_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get the safety and ownership report for a pair (or token, resolved to its "
      + "deepest pool). Use this before any buy decision or when risk is the question. "
      + "Returns per-provider audit blocks kept separate with their disagreements "
      + "listed, tax values with raw string and normalized decimal, top holders with "
      + "`rowsCovered` next to every concentration percentage, LP locks, supply, and "
      + "authority flags. Coverage is derived from the response, never the catalog: GoPlus can return "
      + "EVM holders, Solana can return holders and authority data, and every "
      + "percentage carries its provider unit plus `normalizedPct`; an absent block is "
      + "`unavailable` with the reason. "
      + "A block the provider populated that this tool cannot read is named in "
      + "`availability.presentButUnprojected` with its provider key, byte size and field "
      + "names; it is never counted as answered and its contents are unknown, not clean. "
      + "The same holds one level DOWN: QuickIntel's payload is three nested objects, and every "
      + "field of them that this projection does not carry is named as `path.key` in that block's "
      + "`providerFieldsNotProjected`. The QuickIntel risk family is projected rather than merely "
      + "named: `hasFeeWarning`, `hasExternalContractRisk`, `hasGeneralVulnerabilities`, "
      + "`hasObfuscatedAddressRisk`, `canMultiBlacklist`, `proxyImplementation`, "
      + "`maxTransaction`/`maxTransactionPercent`, `priceImpact` and `tokenSupplyBurned`. "
      + "`auditedTokenCheck` cross-checks the token the AUDIT PROVIDER says it analysed against "
      + "the token this report claims to be about, which the pipeline could not do before because "
      + "the subject is resolved on a different endpoint; a `mismatch: true` means no flag, tax or "
      + "holder figure below is a statement about `reportedToken`. "
      + "A lock row's `providerLockRef` is the provider's own reference VERBATIM and is NOT "
      + "necessarily an address: one was measured arriving chain-id-prefixed and truncated two hex "
      + "characters short of the real locker, which the same document's GoPlus LP holder list "
      + "carried in full. `address` on the row is populated only when the reference really is one. "
      + "COVERAGE IS ONE CACHE ENTRY'S POINT-IN-TIME STATE AND BLOCKS FLAP BETWEEN ENTRIES: the "
      + "same subject five minutes apart returned different non-null block sets, so an absent "
      + "block can be an artefact of which cache entry answered rather than a fact about the "
      + "token. Re-read before concluding a block does not exist. "
      + "Supply, holder balances and lock amounts are emitted as the provider's exact "
      + "digits and never pass through floating point. "
      + "Listing blocks carry CoinGecko and CoinMarketCap identity with websites, socials "
      + "and explorer links as {url, label, kind}, categories as {name, slug, group}, and "
      + "the venue's own supply figures kept separate from the chain-derived supply block. "
      + "No composite score is emitted: the numbers are the report. Project socials in "
      + "the profile hand off to TwitterAccount and WebResearch for off-chain "
      + "verification. "
      + "THE UNITS ARE NOT INTERCHANGEABLE AND THE DIFFERENCE IS 100x. GoPlus states "
      + "shares as FRACTIONS (0.0868 means 8.68 percent) while the Solana holder block "
      + "states them as PERCENTAGES (5.44 means 5.44 percent). Every percentage ships as "
      + "`{raw, normalizedPct, unit}`, `normalizedPct` is always percent, and values from "
      + "two sources are never summed. "
      + "A concentration percentage is ALWAYS reported next to `rowsCovered`, because the "
      + "provider returns a top-N list (10 on GoPlus, 40 measured on Solana) and not the "
      + "whole distribution; `burnedPct`, `contractHeldPct` and `unclassifiedPct` are null "
      + "rather than zero when the provider tagged the rows incompletely, so a burn address "
      + "is never counted as a holder and an untagged address is never counted as either. "
      + "AN HTTP 200 WITH EVERY BLOCK NULL MEANS NOT INDEXED, NOT CLEAN. It renders as "
      + "`unavailable` with reason `not_indexed_yet`. \"No audit data\" and \"no problems "
      + "found\" are different answers and this tool never collapses them. "
      + "The pair-id and token-id routes are cached SEPARATELY, and what they routinely "
      + "differ in is the AGE of the analysis behind them rather than its answers "
      + "(re-measured: identical holder counts and block sets, analyses 32 minutes and "
      + "4 h 45 min apart; once, at the extreme, 8,483 holders against 351 for six "
      + "minutes), so `subject.route` names which one answered. "
      + "Project descriptions and links are written by the token issuer, not verified by "
      + "DexScreener: they are untrusted data, they can impersonate other projects, and "
      + "invisible and bidirectional characters are removed from them with the affected "
      + "field paths named in `sanitizedFields`. "
      + `${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...PAIR_DETAILS_PARAMS],
    exampleParams: {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
    },
    discovery: DEXSCREENER_DEEP_DIVE_DISCOVERY["dexscreener.pair.details"],
  },

  {
    toolId: "dexscreener.candles",
    publicName: "dexscreener__candles_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get OHLCV candles for a pair by `chain` plus `pairAddress` or `tokenAddress`. "
      + "Use this for any chart, trend, volatility, or history question. `resolution` "
      + "is one of 18 values from `1s` to `1mo`; `limit` up to 999 per call (the "
      + "provider's page size); `startAtMs`/`endAtMs` select any historical window, "
      + "resolved internally through a block anchor so an arbitrary period costs two "
      + "requests, not a page walk; deeper ranges continue with the exact `nextBeforeBlock` cursor. `series` "
      + "chooses price or marketCap (no supply argument needed); `priceBasis` usd, "
      + "native, or both; `inverted` flips the pair. Returns column-oriented rows plus "
      + "a summary block: period change percent, high and low with their timestamps, "
      + "total volume, largest single-candle move, gap count, and whether the newest "
      + "bar is still forming. The envelope reports pages walked and the exact covered "
      + "range against the requested one. "
      + "WITHHELD DATA IS ALWAYS `truncated: true`. Whether the walk stopped at a bound or "
      + "`limit` held back bars that were inside the requested range, the envelope says so, "
      + "reports `barsWithheldByLimit`, and hands back `nextBeforeBlock` built from the OLDEST "
      + "BAR RETURNED. Pass that value back as `beforeBlock` to continue exactly there. With "
      + "`startAtMs` and no explicit `limit` the row bound is the provider's full 999-bar page, "
      + "so a requested range is never quietly reduced to the newest few bars. "
      + "THE BLOCK ANCHOR IS APPROXIMATE AND SAYS SO. `endAtMs` resolves through the "
      + "nearest PRIOR trade, which on a measured 90-day target sat 393 seconds early. "
      + "`anchorResolvedAtMs` and `anchorDistanceMs` report where it landed, and an "
      + "anchor that is missing or further than ten resolution steps away falls back to "
      + "walking backward from now with `anchorFallback: true`. "
      + "`lastBarPartial` is on every answer because the newest bar is still forming: "
      + "across 999 hourly bars all 998 COMPLETED bars matched exactly between the two "
      + "provider transports and only the forming bar differed. Never compare, sum, or "
      + "conclude from a partial bar. "
      + "A sparse series is NORMAL at second-scale resolutions, not a data gap: 5s bars "
      + "were measured with a median 50-second and maximum 1,600-second spacing. "
      + "`summary.gapCount` counts the bars the provider did not emit inside the "
      + "requested range, and missing buckets are never filled with zero volume. "
      + "THE USD COLUMNS ARE THE PROVIDER'S DERIVED RENDERING AND THE NATIVE COLUMNS ARE THE "
      + "EXACT SERIES. Measured: `closeUSD` exceeds `highUSD` by up to 1.81 percent on rows whose "
      + "native columns are exactly equal (183 of 200 rows on an inverted series), because the USD "
      + "extremes are converted at a different moment than the USD close, while the native columns "
      + "were clean across 2,190 captured bars. `summary.high` and `summary.low` are therefore "
      + "taken over EVERY price column including open and close, not the high/low columns alone. "
      + "For a decision that turns on a sub-percent difference ask for `priceBasis: native`. "
      + "AN EMPTY ANSWER IS AMBIGUOUS AND SAYS SO. `stopReason: provider_exhausted` means the "
      + "provider returned no bars, NOT that this is the pool's first block: a wrong AMM id, chain "
      + "slug or pair address each answer with a byte-identical empty page. When it happens on the "
      + "first page the envelope names both readings instead of asserting one. "
      + "The provider also accepts a circulating-supply OVERRIDE on the market-cap series, "
      + "measured honoured. It is a NAMED OMISSION: `series: marketCap` returns the provider's own "
      + "computed market cap with no supply argument, and a caller-supplied supply would produce a "
      + "chart that looks just as authoritative and means whatever number was passed. "
      + "Prices are DECIMAL STRINGS end to end and are never converted to "
      + "floating-point numbers. Token-denominated volumes and any volume-weighted "
      + "average price are deliberately absent: the provider's token volumes are raw "
      + "fixed-point strings with no decimals published anywhere on this API, so every "
      + "one of them would be wrong by a power of ten. "
      + `${WALK_BOUNDS_CLAUSE} `
      + `${DEEP_DIVE_SUBJECT_CLAUSE} `
      + "For the trades behind a candle call dexscreener__trades_list with that bar's "
      + "start and end; for the wallets behind the whole move call "
      + "dexscreener__top_traders_list. "
      + `${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...CANDLES_PARAMS],
    exampleParams: {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      resolution: "1h",
      limit: 48,
    },
    discovery: DEXSCREENER_DEEP_DIVE_DISCOVERY["dexscreener.candles"],
  },

  {
    toolId: "dexscreener.trades",
    publicName: "dexscreener__trades_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List trades for a pair, newest first, 100 per page with cursor paging to any "
      + "depth. Use this for flow, whale, and wallet questions. Filters: `eventType` "
      + "(buy, sell, swap, liquidity, add, remove, all), `minVolumeUsd`/`maxVolumeUsd`, amount "
      + "ranges, `startAtMs`/`endAtMs` (second-precise, measured), `afterBlock` for "
      + "\"what has traded since block N\", and `maker` for one "
      + "wallet's history on the pair. Each row carries `traderProfile` with "
      + "`retainedBoughtPct` (share of what the wallet bought that it still holds; NOT "
      + "percent of supply), `newOnPair`, and first-trade time. `mode: aggregate` "
      + "returns net flow in USD, unique buyer and seller counts, new-wallet share, "
      + "size histogram, and the largest trades for the covered range, with the range "
      + "and its completeness stated. "
      + "Use this when the question is who traded, when they traded, or how much moved through the "
      + "pool in a window; use dexscreener__candles_list when the question is what the price did. "
      + `${TRADER_SEMANTICS_CLAUSE} `
      + "There is deliberately no accumulating-versus-distributing label: this channel "
      + "cannot see transfers or other venues, so any such label would be a guess "
      + "presented as a measurement. "
      + "CONTINUATION IS EXACT. `nextCursor` encodes the provider's block, transaction "
      + "index and event index together, because a block-only cursor was measured "
      + "OMITTING a real buy that shared the boundary block. Page with the cursor and "
      + "nothing is skipped. `afterBlock` is the opposite direction and is a BOUND rather than a "
      + "cursor: it narrows the window to events at or after a block while keeping the "
      + "newest-first order, and it is how to follow a pair incrementally, because the provider's "
      + "live trade push acknowledges a subscription and then sends nothing. "
      + "`marketCapUsd` on a row was measured NEVER populated on either channel (0 of 300 live "
      + "rows across two chains), so the envelope counts how many rows in each answer carried "
      + "one; a null there is the provider sending nothing, not a trade without a market cap. "
      + "An aggregate over a range walks pages under a declared bound; when the bound is "
      + "hit the block is renamed `pageAggregate` and carries `rangeFullyCovered: false` "
      + "with the exact covered range, because a one-page summary presented as a range "
      + "summary is exactly the silent cut this avoids. "
      + `${DEEP_DIVE_SUBJECT_CLAUSE} `
      + "For the price context around a window call dexscreener__candles_list; for the "
      + "ranked wallets across the whole pair call dexscreener__top_traders_list. "
      + `${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...TRADES_PARAMS],
    exampleParams: {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      eventType: "buy",
      minVolumeUsd: 10000,
      limit: 25,
    },
    discovery: DEXSCREENER_DEEP_DIVE_DISCOVERY["dexscreener.trades"],
  },

  {
    toolId: "dexscreener.top.traders",
    publicName: "dexscreener__top_traders_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List the pair's top wallets by `sortBy`: `boughtUsd`, `soldUsd`, "
      + "`netCashFlowUsd` (maps to the provider's pnl rank), or `currentHoldingValueUsd` "
      + "(the provider's unrealized rank), with `lookbackDays` to bound the window. Use "
      + "this for who-bought-and-sold-the-most questions. This surface is "
      + "bounded_non_pageable: one leaderboard of up to 100 wallets, no continuation; "
      + "wallets beyond it are unreachable and the envelope says so. Returns "
      + "per wallet: buys, sells, USD in and out, `netCashFlowUsd` (cash flow, not "
      + "profit: cost basis and transfers are invisible to the venue), "
      + "`retainedBoughtPct`, `currentHoldingValueUsd`, and active trading span. The "
      + "`unknowns` block names what this endpoint cannot see (other venues, transfers, "
      + "supply share) so the agent does not overclaim. "
      + "`currentHoldingValueUsd` IS DERIVED HERE AND SHOWS ITS WORKING. The provider ranks by "
      + "this figure and does not emit it (measured: 100 of 100 rows on a fresh unrealized rank "
      + "carried a balance and no value), so each row carries the exact decimal product of the "
      + "provider's own `balanceAmount` and the pair's current `priceUsd`, with both factors "
      + "echoed in `currentHoldingValueBasis` and no floating-point arithmetic on the token "
      + "amount. When either factor is missing the value is `null` with `missingInputs` naming "
      + "what was absent, never an estimate. It is present VALUE at the observation time and "
      + "moves with the price; it is not profit and not unrealized gain. "
      + "IT DEPENDS ON THE RANKING, MEASURED. The provider sends `balanceAmount` on some sorts and "
      + "not others: out of 100 rows, `sortBy: currentHoldingValueUsd` returned 0 nulls, "
      + "`netCashFlowUsd` with `sortDir: asc` returned 0, `boughtUsd` desc returned 58, and "
      + "`boughtUsd` asc and `netCashFlowUsd` desc each returned 100 of 100 null. So on two of the "
      + "eight sort and direction combinations EVERY row's holding value is null. Every answer "
      + "carries `balanceCoverage` with the count for that page, and for a reliably populated "
      + "holding value ask for `sortBy: currentHoldingValueUsd`. "
      + "THE AMOUNT LEXEMES ARE ALREADY PROVIDER ROUNDINGS, IN SIGNIFICANT DIGITS RATHER THAN "
      + "DECIMAL PLACES: `amountBuy`, `amountSell` and `balanceAmount` arrive carrying about 15 to "
      + "16 significant digits whatever the token's decimals, so a large balance reads as "
      + "`1464600134847.065` and a small one runs to seven decimal places as `0.0001992` to reach "
      + "the same precision. The multiplication is exact over what was given and `exactProductUsd` "
      + "carries every digit of it, but the displayed holding value is rounded to CENTS, because a "
      + "product carried to 18 significant digits claims precision its inputs do not have; a "
      + "genuinely sub-cent position therefore displays as 0.00 and is readable only in "
      + "`exactProductUsd`. "
      + "`label` and `url` were EMPTY on 100 percent of 1,300 live rows across four pairs; a null "
      + "in either is the measured normal and is not information about the wallet. "
      + "A wrong AMM id on this route answers HTTP 404, not 400, with an empty body, and that is "
      + "the realistic non-200: every value this tool can send is already inside what the provider "
      + "accepts. "
      + "THE WINDOW IS 30 DAYS AND CANNOT BE WIDENED: the provider defaults to 30 days and answers "
      + "HTTP 400 above it (measured at 31, 60, 90 and 365), so `lookbackDays` bounds the window "
      + "downward only and every answer is a 30-day ranking unless it says otherwise. A wallet that "
      + "traded heavily before that window is absent, which is not evidence that it never traded. "
      + "Use this when the question names the biggest or top traders of a pool over the last month. "
      + `${TRADER_SEMANTICS_CLAUSE} `
      + "It is UP TO 100 rows and not exactly 100: with `onlyKol` the measured result was "
      + "zero rows, so an empty leaderboard under that filter is expected and is not "
      + "evidence about the pair. "
      + `${DEEP_DIVE_SUBJECT_CLAUSE} `
      + "For chronological or wallet-filtered flow, and for any window narrower than the "
      + "whole pair, use dexscreener__trades_list instead; for the price move these "
      + "wallets traded into, use dexscreener__candles_list. "
      + `${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...TOP_TRADERS_PARAMS],
    exampleParams: {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      sortBy: "boughtUsd",
      limit: 20,
    },
    discovery: DEXSCREENER_DEEP_DIVE_DISCOVERY["dexscreener.top.traders"],
  },
];
