/**
 * The site RESOLVE family: 5 read-only tools on DexScreener's own website
 * channels, every one of which answers "which pair, exactly" rather than
 * "which pairs are moving".
 *
 *  - `dexscreener.pair.get`: one pair's full live state, from the single-pair
 *    WebSocket channel, with two optional side reads.
 *  - `dexscreener.spotlight`: the three paid-attention feeds in one document.
 *  - `dexscreener.pairs.batch`: many known identities refreshed in one frame.
 *  - `dexscreener.search`: text and address search over the v12 channel.
 *  - `dexscreener.tokenPairs`: one token's pools, deepest of the window first.
 *
 * IDENTITY CONTINUITY. `dexscreener.search` and `dexscreener.tokenPairs` are
 * RECLAIMED toolIds. The public-API tools that held them were retired whole in
 * S3.5 (owner decision D-DS2, total and alias-free) and these two answer the
 * same user questions off the website channel instead. The toolId is
 * deliberately unchanged, and so is the publicName: the question did not
 * change, only the channel that answers it, which is precisely the case the
 * immutable-toolId rule of `tool-surface-spec/identity-and-migration.md`
 * exists for. No deprecation alias row is created and none is wanted; a call
 * to one of the nine public names that did NOT survive falls through to the
 * ordinary unknown-tool path.
 *
 * WHAT CHANGED FOR A CALLER OF THE OLD TWO, stated once here because it is the
 * whole reason the reclaim is honest rather than cosmetic: search is now
 * chain-scopable SERVER-side (the public API could not do it at all), and the
 * token pool list is now bounded at the provider's 30-row window and says so
 * instead of implying it enumerated every pool.
 *
 * WHY THE DESCRIPTIONS READ THE WAY THEY DO. Every `description` here begins
 * from the model-visible draft in
 * `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` (owner decision
 * D-DS7) and extends it only with units, if-omitted semantics, and the shared
 * honesty clauses. No sentence of a draft is dropped or reworded.
 *
 * All 5 are `mutating: false`, `actionKind: "read"`, and need no API key.
 */

import type { ProtocolToolManifest, ProtocolParamDef } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { DEXSCREENER_RESOLVE_DISCOVERY } from "../../embeddings/dexscreener/resolve.js";
import { SCREEN_WINDOW_VALUES } from "./screen-params.js";
import {
  SCREEN_EXTERNAL_CONTENT_CLAUSE,
  SCREEN_SOURCE_OBSERVATION_CLAUSE,
  STRING_OR_ARRAY_CLAUSE,
} from "./screen-params/clauses.js";
import {
  BATCH_CLIENT_FILTER_CLAUSE,
  SEARCH_CLIENT_FILTER_CLAUSE,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MIN,
  SEARCH_SORT_KEYS,
  SPOTLIGHT_FEED_VALUES,
  SPOTLIGHT_FIELD_GROUPS,
  SPOTLIGHT_LIMIT_DEFAULT,
  SPOTLIGHT_LIMIT_MIN,
  SPOTLIGHT_MEASURED_FEED_SIZES,
  TOKEN_PAIRS_CLIENT_FILTER_CLAUSE,
  clientThresholdParams,
} from "./resolve-params.js";
import {
  SEARCH_DEFAULT_MAX_CHAINS,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_PROVIDER_WINDOW,
} from "@tools/dexscreener/endpoints/search.js";
import {
  BATCH_CHUNK_SIZE,
} from "@tools/dexscreener/endpoints/pairs-batch.js";
import {
  SCREEN_FIELD_GROUPS,
  SCREEN_HEAVIEST_FIELD_GROUPS,
} from "@tools/dexscreener/screen-core/fields.js";

/* ------------------------------------------------------------------ */
/* Shared param pieces                                                 */
/* ------------------------------------------------------------------ */

/**
 * The row `fields` param, shared with the screening family's vocabulary.
 *
 * Same GROUPS, same costs, same refusal on an unknown name: these tools return
 * the same `dex_screener_schema.Pair` rows through the same projection, so a
 * second spelling of the same vocabulary would be a second source of truth.
 */
const ROW_FIELDS_PARAM: ProtocolParamDef = {
  key: "fields",
  type: "string",
  description:
    "Comma-separated row field GROUPS to return, not individual field names. Supported groups: "
    + `${SCREEN_FIELD_GROUPS.join(", ")}. Defaults to core, which carries the chain, dex, pair address, base-token address and symbols, the `
    + "selected window's price, volume, liquidity, market cap, age, counts and every derived "
    + `ratio. The two heaviest are ${SCREEN_HEAVIEST_FIELD_GROUPS[0]} (unbounded issuer-authored `
    + `prose and links) and ${SCREEN_HEAVIEST_FIELD_GROUPS[1]} (four times the per-row metric `
    + "payload). The `identity` group is NOT part of core and is what adds ammId, quoteTokenAddress, both tokens' decimals, priceNative and pairCreatedAtMs - the fields that let you tell a real pool from a mispriced one, so ask for it when the dollar columns are what you are judging. An unknown group name is refused with the full list rather than ignored.",
};

/**
 * The standing sentence about the issuer-text reporting BOUND on pair rows.
 *
 * One spelling, appended to every tool of this family that emits pair rows, so
 * the fact cannot drift between four descriptions. It exists because issuer
 * text arrives with no length limit at all: a live search window carried a
 * 34,090-character token name and a 9,575-character symbol on one row.
 */
const ROW_BOUNDED_TEXT_CLAUSE =
  "Issuer-authored display text on a row (token name, symbol, profile description) is bounded at "
  + "512 characters for names and symbols and 2,048 for descriptions, because a token issuer can "
  + "write any length they like and one row was measured at 34,090 characters. This is a BOUND and "
  + "never a silent cut: a row whose text was bounded carries `boundedText`, naming the field, the "
  + "length the issuer actually wrote, and the length returned. A row without that key is whole.";

const WINDOW_PARAM: ProtocolParamDef = {
  key: "window",
  type: "string",
  enum: [...SCREEN_WINDOW_VALUES],
  description:
    "Which stats window the single-window metrics report: m5, h1, h6 or h24. Defaults to h24. "
    + "The provider measures all four regardless; this selects which one the flat fields carry, "
    + "and the allWindows field group returns every one of them.",
};

/* ------------------------------------------------------------------ */
/* Tool 9: pair_get                                                    */
/* ------------------------------------------------------------------ */

/**
 * The two selection axes on pair_get, kept apart because they are two
 * different questions with two different costs.
 *
 * `fields` SHAPES rows this call already fetched and costs nothing. `include`
 * performs OPTIONAL SIDE READS, one extra provider request per value. Both
 * keys carry exactly the meanings `protocols/conventions.ts` gives them
 * namespace-wide, and the retrieval source words this tool the same way.
 *
 * They were briefly merged into `fields` alone after a caller sent
 * `fields=reactions,insight` and was refused while `include` sat unmentioned.
 * The lesson there was that an unmentioned key is a defect, not that the two
 * axes are one: a caller budgeting provider requests cannot read a key that
 * means "free projection" and "paid request" at once. Both keys are now
 * documented here, and each refuses the other's values BY NAME with the key
 * that takes them, so the original failure cannot recur in either direction.
 */
const PAIR_GET_FIELDS_PARAM: ProtocolParamDef = {
  key: "fields",
  type: "string",
  acceptsStringArray: true,
  description:
    "Comma-separated row field GROUPS to return, not individual field names, as a string or an array. "
    + `Groups: ${SCREEN_FIELD_GROUPS.join(", ")}, defaulting to core, which already carries `
    + "identity, the selected window's price, volume, liquidity, market cap, age, counts and every "
    + `derived ratio. profile (issuer links and description) and ${SCREEN_HEAVIEST_FIELD_GROUPS[1]} `
    + "(four times the per-row metric payload) are the two heaviest and are NOT in the default "
    + "projection. Every group here shapes data this call already fetched and costs no extra "
    + "request. The side reads reactions and insight are NOT groups: they go in \"include\", and "
    + "naming one here is refused by name with that remedy rather than silently performed, because "
    + "it would cost a request the caller did not ask for. An unknown group name is refused with "
    + "the full list rather than ignored.",
};

const PAIR_GET_INCLUDE_PARAM: ProtocolParamDef = {
  key: "include",
  type: "string",
  acceptsStringArray: true,
  enum: ["reactions", "insight"],
  description:
    "Optional SIDE READS to perform, as a comma-separated string or an array. Each value costs one "
    + "extra provider request, which is what separates this key from \"fields\": fields shapes rows "
    + "already in hand and is free, include goes and fetches more. reactions returns the crowd emoji "
    + "counters on this pair (a 142-byte call). insight returns a provider-generated text blurb about "
    + "the token, labelled as provider-generated, sanitized like any untrusted text, and never "
    + "evidence for an action. COVERAGE IS SOLANA-ONLY AND NARROW, measured from the provider's own "
    + "catalog: 1,218 of 1,218 insights are on solana, no token on any other chain has one, and "
    + "majors such as wrapped SOL have none either. On any non-Solana chain this request is a "
    + "provider call that is certain to come back empty, so do not spend it there. An absent blurb "
    + "is NORMAL and comes back carrying the provider's own reason code, never as an error, and the "
    + "answer distinguishes \"the provider has written nothing\" from \"the provider faulted\". Omit "
    + "this key and neither request is made. An unknown value is refused with the full list rather "
    + "than ignored.",
};

const PAIR_GET_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "chain",
    type: "string",
    required: true,
    description:
      "Chain slug the pair or token lives on, for example solana, ethereum, base or bsc. "
      + `${CANONICAL_CHAIN_SENTENCE} An unknown slug is refused by name with the nearest catalog `
      + "matches rather than answered as if the pair did not exist.",
  },
  {
    key: "pairAddress",
    type: "string",
    required: false,
    description:
      "Address of the pool itself. The direct route: it names the pair exactly and needs no "
      + "resolution step. Give this or tokenAddress; giving both uses pairAddress and says so. "
      + "EVM checksum casing is accepted and the address you get back is the provider's own. "
      + "MEASURED: the channel also accepts a TOKEN address here and answers with a pool of its "
      + "own choosing, on a rule it does not publish. That is not refused, but it is not hidden "
      + "either: resolvedPair is always the pool the answer describes, requestedPairAddress echoes "
      + "what you sent, and when they differ resolutionBasis reads provider_resolved_from_token "
      + "and says the pool was the provider's pick and not a deepest-pool claim. Pass a token as "
      + "tokenAddress instead when you want the deepest pool chosen and reported.",
  },
  {
    key: "tokenAddress",
    type: "string",
    required: false,
    description:
      "Token contract address, when the pool address is not known. Resolved to the deepest pool "
      + "of the provider's bounded search window, which is at most 30 pools and is NOT a global "
      + "claim about every pool the token trades in; resolvedFrom and resolutionBasis echo what "
      + "answered. Give this or pairAddress.",
  },
  WINDOW_PARAM,
  PAIR_GET_FIELDS_PARAM,
  PAIR_GET_INCLUDE_PARAM,
];

/* ------------------------------------------------------------------ */
/* Tool 15: spotlight_get                                              */
/* ------------------------------------------------------------------ */

const SPOTLIGHT_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "feed",
    type: "string",
    enum: [...SPOTLIGHT_FEED_VALUES],
    description:
      "Which feed to return: topBoosts (who has paid the most in total), recentBoosts (who just "
      + "bought a boost), latestProfiles (the newest issuer-published token profiles), or all. "
      + "Defaults to all. Every feed comes from the same single provider document, so asking for "
      + "one instead of all saves context, not a request.",
  },
  {
    key: "chainIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "Chain slugs to keep, comma-separated or as an array. Filtering happens HERE, over the "
      + "document the provider already sent, so narrowing cannot reveal rows beyond the feeds' "
      + `fixed sizes; clientFiltering.droppedByChain reports what it removed. ${CANONICAL_CHAIN_SENTENCE}`,
  },
  {
    key: "limit",
    type: "number",
    description:
      `How many rows per feed to return, ${SPOTLIGHT_LIMIT_MIN} or more. Defaults to `
      + `${SPOTLIGHT_LIMIT_DEFAULT}. There is no upper bound to refuse against: the feeds measured `
      + `${SPOTLIGHT_MEASURED_FEED_SIZES} rows, but that is a BOUND and not a promise (a `
      + "recent-boosts feed was measured at 28), and there is no continuation past whatever a feed "
      + "holds, so a larger limit returns everything that feed has rather than more. Rows a limit "
      + "left unshown are counted in notShownByLimit, separately from the chain filter.",
  },
  {
    key: "fields",
    type: "string",
    acceptsStringArray: true,
    description:
      "Comma-separated row field GROUPS to return, not individual field names, as a string or an "
      + `array. Supported groups: ${SPOTLIGHT_FIELD_GROUPS.join(", ")}. Defaults to core, which `
      + "carries chain, token address, symbol, feed rank and the boost amounts. description adds "
      + "the issuer-authored blurb and the provider's nsfw flag; links adds the issuer's claimed "
      + "website and socials. Both exist only on latestProfiles rows, both are issuer-authored text "
      + "kept out of the default projection for that reason, and both are claims to verify onward "
      + "rather than facts. media adds the provider's own image references: tokenImageUrl on a boost "
      + "row and iconId plus headerId on a profile row. Those are provider-hosted assets rather than "
      + "issuer text, and they are out of the default projection because a text model cannot read an "
      + "image; ask for them when something will render or fetch one. An unknown group name is "
      + "refused with the full list rather than ignored.",
  },
];

/* ------------------------------------------------------------------ */
/* Tool 17: pairs_batch_get                                            */
/* ------------------------------------------------------------------ */

const BATCH_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "pairs",
    type: "string",
    acceptsStringArray: true,
    description:
      "Pool identities to refresh, spelled chain:pairAddress, comma-separated or as an array, "
      + "across any mix of chains. There is no artificial ceiling on how many you may pass: a "
      + `live 300-input probe completed, and longer lists are split into chunks of ${BATCH_CHUNK_SIZE} `
      + "internally with the split reported in providerWindow. Give pairs, tokens, or both.",
  },
  {
    key: "tokens",
    type: "string",
    acceptsStringArray: true,
    description:
      "Token identities to refresh, spelled chain:tokenAddress, comma-separated or as an array. "
      + "MEASURED CAVEAT: a token resolves to ONE provider-canonical pair and it is not "
      + "necessarily the deepest (a WETH lookup answered with a 4.23M USD pool while a 117.31M "
      + "USD pool existed), so resolutionBasis reports provider_canonical. Use "
      + "dexscreener__pair_get when you want the deepest pool instead.",
  },
  WINDOW_PARAM,
  {
    key: "sortBy",
    type: "string",
    enum: ["volume", "txns", "liquidity", "marketCap", "priceChange", "pairAge"],
    description:
      "How the resolved rows are ordered: volume, txns, liquidity, marketCap, priceChange or "
      + "pairAge. Defaults to volume. The ordering runs on the provider over your own list, so "
      + "it ranks exactly the identities you passed and nothing else.",
  },
  {
    key: "sortDir",
    type: "string",
    enum: ["desc", "asc"],
    description:
      "Ranking direction: desc for the largest values first, asc for the smallest. Defaults to "
      + "desc.",
  },
  ...clientThresholdParams(BATCH_CLIENT_FILTER_CLAUSE),
  ROW_FIELDS_PARAM,
];


/* ------------------------------------------------------------------ */
/* Tools 7 and 8: the search-backed pair lookups                       */
/* ------------------------------------------------------------------ */

/**
 * The client-side thresholds `pairs_search` carries.
 *
 * Only four, and deliberately not the screening family's twenty-one. On a TEXT
 * search the returned window is a relevance sample the provider chose out of
 * the whole market, and offering the full vocabulary here would let an agent
 * write a twenty-clause screen, receive a filtered sample of thirty
 * provider-chosen rows, and believe it had screened the market. These four are
 * the ones whose meaning survives that.
 *
 * `token_pairs_list` DOES take the full family (plan 14.6 item 10) and the
 * difference is the question, not the channel: there the window is every pool
 * of ONE named address, so a threshold narrows a set the caller already
 * bounded rather than sampling a market. Its clause still says the window was
 * the provider's to cap.
 */
const SEARCH_THRESHOLD_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "minLiquidityUsd",
    type: "number",
    description: `Drop returned rows whose pool liquidity is below this many US dollars. ${SEARCH_CLIENT_FILTER_CLAUSE}`,
  },
  {
    key: "minVolumeUsd",
    type: "number",
    description:
      "Drop returned rows whose volume in the selected window is below this many US dollars. "
      + SEARCH_CLIENT_FILTER_CLAUSE,
  },
  {
    key: "minMarketCapUsd",
    type: "number",
    description: `Drop returned rows whose market cap is below this many US dollars. ${SEARCH_CLIENT_FILTER_CLAUSE}`,
  },
  {
    key: "minPairAgeSeconds",
    type: "number",
    description:
      "Drop returned rows younger than this many SECONDS, the usual way to push aside a freshly "
      + `deployed copycat of an established ticker. ${SEARCH_CLIENT_FILTER_CLAUSE}`,
  },
];

/** Ordering over the window the provider already chose. Shared by 7 and 8. */
const SEARCH_SORT_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "sortBy",
    type: "string",
    enum: [...SEARCH_SORT_KEYS],
    description:
      `How to order the returned rows: ${SEARCH_SORT_KEYS.join(", ")}. Sorting runs HERE, over the `
      + "rows the provider already sent, so it re-orders that window and never reaches past it. "
      + "relevance keeps the provider's own ranking untouched, which is the only ordering that "
      + "carries information about the text match itself.",
  },
  {
    key: "sortDir",
    type: "string",
    enum: ["desc", "asc"],
    description:
      "Ranking direction: desc for the largest values first, asc for the smallest. Defaults to "
      + "desc, except under sortBy relevance, where the provider's order is kept as sent and this "
      + "parameter is refused rather than silently reversing a ranking it does not own.",
  },
];

const PAIRS_SEARCH_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "query",
    type: "string",
    required: true,
    description:
      `What to search for: a token name, a ticker symbol, a token contract address, or a pool `
      + `address. At least ${SEARCH_MIN_QUERY_LENGTH} characters. An exact address is matched as an `
      + "address and returns that token's pools inside the same bounded window; anything else is "
      + "matched as text and ranked by the provider's own relevance. TWO MEASURED GRAMMAR RULES, "
      + "because neither is visible in the answer. A DOUBLE QUOTE KILLS THE QUERY: there is no "
      + "quoted-phrase syntax, the quote is not stripped, and a quoted query comes back completely "
      + "empty, which reads as \"no such token\" when it means \"that is not a query\". Never quote "
      + "the term. MULTI-WORD IS OR, NOT AND: a three-word query returns rows matching ANY of "
      + "its words, across chains, so it widens the search rather than narrowing it. Narrow with "
      + "chain and the thresholds instead of with more words.",
  },
  {
    key: "chain",
    type: "string",
    description:
      "One chain slug to scope the search to, for example solana, ethereum, base or bsc. This is "
      + "the one narrowing the PROVIDER honours: it spends the whole window on that chain instead "
      + `of on same-name tokens everywhere else. ${CANONICAL_CHAIN_SENTENCE} Omit it and one `
      + "unscoped cross-chain request is issued, which is a legitimate query and not a missing "
      + "parameter. Give chain or chainIds, not both.",
  },
  {
    key: "chainIds",
    type: "string",
    acceptsStringArray: true,
    description:
      `Several chain slugs to search. Each one costs its OWN bounded `
      + `provider request, issued sequentially, because the ${SEARCH_PROVIDER_WINDOW}-row window is `
      + "applied per request and filtering a single global window locally cannot find rows the "
      + "provider never sent. Every request is reported separately in perChain, so a chain that "
      + `came back empty is distinguishable from one that filled its window. How many may be named `
      + `at once is maxChains, which you may raise. ${STRING_OR_ARRAY_CLAUSE}`,
  },
  {
    key: "maxChains",
    type: "number",
    description:
      `How many chains this one call may fan out over, 1 or more. Defaults to `
      + `${SEARCH_DEFAULT_MAX_CHAINS}. There is NO hard ceiling: raise it and the wider fan-out is `
      + "issued, because the only real bound is the call's own deadline. What it costs is one "
      + "sequential provider request per chain, so a fan-out of twenty is twenty requests inside "
      + "one deadline and a timeout returns nothing rather than a partial board. requestsIssued "
      + "and perChain report exactly what was spent.",
  },
  WINDOW_PARAM,
  ...SEARCH_SORT_PARAMS,
  {
    key: "limit",
    type: "number",
    description:
      `How many rows to return, ${SEARCH_LIMIT_MIN} or more. Defaults to ${SEARCH_LIMIT_DEFAULT}. `
      + `The provider serves at most ${SEARCH_PROVIDER_WINDOW} rows PER chain requested and offers no `
      + "continuation of any kind, so a limit above what arrived returns everything that arrived "
      + "rather than reaching further. There is deliberately no offset parameter: this tool is "
      + "bounded and non-pageable, and an offset would advertise a page that cannot exist.",
  },
  ...SEARCH_THRESHOLD_PARAMS,
  ROW_FIELDS_PARAM,
];

const TOKEN_PAIRS_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "chain",
    type: "string",
    required: true,
    description:
      "Chain slug the token lives on, for example solana, ethereum, base or bsc. Required, and "
      + "honoured by the provider: the same contract address exists on forked chains, so an "
      + `unscoped lookup would spend the window on the wrong chain's copies. ${CANONICAL_CHAIN_SENTENCE}`,
  },
  {
    key: "tokenAddress",
    type: "string",
    required: true,
    description:
      "The token's contract address. This tool takes an ADDRESS, never a ticker: a ticker is not "
      + "identity and resolving one here would silently pick a copycat's pools. Use "
      + "dexscreener__pairs_search first when only the name is known.",
  },
  WINDOW_PARAM,
  ...SEARCH_SORT_PARAMS,
  {
    key: "limit",
    type: "number",
    description:
      `How many pools to return, ${SEARCH_LIMIT_MIN} or more. Defaults to ${SEARCH_LIMIT_DEFAULT}. `
      + `The provider serves at most ${SEARCH_PROVIDER_WINDOW} pools for one token with no `
      + "continuation, so a token that trades in more pools than that is partially covered and "
      + "providerCapped says so. There is no offset: this tool is bounded and non-pageable.",
  },
  ...clientThresholdParams(TOKEN_PAIRS_CLIENT_FILTER_CLAUSE),
  ROW_FIELDS_PARAM,
];

/* ------------------------------------------------------------------ */
/* Manifests                                                           */
/* ------------------------------------------------------------------ */

export const RESOLVE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.pair.get",
    publicName: "dexscreener__pair_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get one pair's full live state by `chain` plus `pairAddress` or `tokenAddress` "
      + "(a token resolves to the deepest pool of the provider's bounded search window, "
      + "with `resolvedFrom` and `resolutionBasis` echoed). Use this for "
      + "current-state questions about a known pair. Returns the complete windowed "
      + "metric set including buyers/sellers/makers and the buy/sell volume split "
      + "(fields the public API never had), derived flow ratios, and profile links. "
      + "Optional `fields: profile` (issuer links and description; not in the default "
      + "projection, and unbounded issuer prose, which is why it does not ship unless asked "
      + "for) and `include: reactions,insight` (side reads, each costing one extra provider "
      + "request: crowd emoji counters and a provider-generated text blurb, labelled as such). "
      + "`fields` shapes rows this call already fetched and is free; `include` performs extra "
      + "requests. Naming a side read in `fields`, or a field group in `include`, is refused by "
      + "name with the key that takes it. Profile links can be verified "
      + "onward: X/Twitter via the TwitterAccount tool, the website via WebResearch. "
      + "`insight` is provider-generated prose about the token, so it is "
      + "labelled provider-generated, sanitized like any untrusted text, and is never "
      + "evidence for an action. It exists only for roughly 1,200 Solana tokens (measured: "
      + "1,218 of 1,218 insights are on solana, majors included have none), so on any other "
      + "chain the answer is always absent and the request is not worth spending. An absent "
      + "blurb returns the provider's own reason code, not an error, and \"nothing was "
      + "written\" is reported apart from \"the provider faulted\". "
      + "One snapshot measures about one kilobyte, which is what makes this the right tool "
      + "for polling a position rather than a screening board. Use this when the pair or token "
      + "is already identified and the question is its state right now; use the screening tools "
      + "when the question is which pairs to look at in the first place. "
      + `${ROW_BOUNDED_TEXT_CLAUSE} ${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    // The empty call: legal against every individual param (only `chain` is
    // required) and unanswerable, because a chain alone names no pair.
    // Declared rather than left in prose so the runtime refuses it with the
    // list of what would have worked, and discovery shows the rule.
    atLeastOneOf: [["pairAddress", "tokenAddress"]],
    params: [...PAIR_GET_PARAMS],
    // A SOLANA pool, deliberately. The example used to name an ethereum pool
    // while also asking for `insight`, and insight coverage is Solana-only
    // (1,218 of 1,218 measured), so the shipped example demonstrated a side
    // read that was guaranteed to come back empty.
    exampleParams: {
      chain: "solana",
      pairAddress: "Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w",
      include: "reactions,insight",
    },
    discovery: DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.pair.get"],
  },

  {
    toolId: "dexscreener.spotlight",
    publicName: "dexscreener__spotlight_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get the spotlight feeds: `feed` selects `topBoosts`, `recentBoosts`, "
      + "`latestProfiles`, or `all` (default), optionally filtered by `chainIds`. Use "
      + "this for promotion and paid-attention questions. Returns per row the token "
      + "address, symbol, chain, boost totals, and for recent boosts the just-purchased "
      + "amount separately from the running total, so \"who just started paying\" is "
      + "answerable. Row counts are provider bounds, not promises: a feed can return "
      + "fewer. One call, about 23 KB, the same endpoint the website itself uses. "
      + "A boost is BOUGHT VISIBILITY: it is not demand, quality, or safety, and no row "
      + "here is ranked by anything except how much was paid. Organic movement lives in "
      + "the screening tools. "
      + `The feeds measured ${SPOTLIGHT_MEASURED_FEED_SIZES} rows and a fresh one measured 28: `
      + "the size is the provider's and no parameter raises it, `providerWindow.feedSizes` "
      + "reports what each feed actually held on this call, and there is no continuation, "
      + "so `hasMore` is false. `fields` decides how much of a profile row ships, including "
      + "`media` for the provider's own image references. TWO THINGS ARE NOT STABLE BETWEEN "
      + "CALLS and `providerWindow.repeatCallNote` says so on every answer: rows tied on the "
      + "same boost total reorder between reads, so a `feedRank` change on a tied row is "
      + "shuffling and not movement; and the `recentBoosts` feed diverges between cached "
      + "copies, so a later call can return an older document than the one before it and a "
      + "row that vanished was not withdrawn. Do not diff two calls of this tool and report "
      + "the difference as news. "
      + "Profile links are issuer claims and "
      + "can be verified onward with the TwitterAccount tool and WebResearch. Use this when the "
      + "question is who is advertising, boosting or promoting right now, and reach for "
      + "dexscreener__pairs_trending_list when the question is what is actually moving. "
      + `${ROW_BOUNDED_TEXT_CLAUSE} ${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...SPOTLIGHT_PARAMS],
    exampleParams: { feed: "recentBoosts", limit: 20 },
    discovery: DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.spotlight"],
  },

  {
    toolId: "dexscreener.pairs.batch",
    publicName: "dexscreener__pairs_batch_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get current rows for explicit `pairs` (`chain:pairAddress`) or `tokens` "
      + "(`chain:tokenAddress`) in one provider frame; no artificial input ceiling (a "
      + "live 300-input probe completed), large lists are chunked internally and the "
      + "chunking reported. Use this when the set is known and freshness is the "
      + "question. Returns full screening-family rows plus per-input accounting: "
      + "`resolved`, `invalid_format`, `duplicates`, and `provider_omitted` (a "
      + "syntactically valid identity the provider returned no row for; bonding-curve "
      + "launchpad pairs resolve normally since the batch lifts the provider's hidden "
      + "launchpad exclusion the way the screeners do). A token input resolves to ONE "
      + "provider-canonical pair which is not necessarily the deepest; "
      + "`resolutionBasis` says which pair answered. The provider pages this channel "
      + "at 500 rows with a true total; large lists chunk to that page size and page "
      + "walks are reported. "
      + "The four accounting buckets always sum to the number of identities you passed, "
      + "which is the guarantee that makes this safe for a watchlist: an identity the "
      + "provider drops in silence is reported by name instead of vanishing from a list "
      + "that still looks complete. "
      + "The full threshold family the screening tools use filters the resolved rows "
      + "here, over your own explicit list, so the filtering is exhaustive rather than a "
      + "sample and `droppedByFilter` accounts for every row removed. A row whose metric "
      + "the provider did not report is never treated as a zero: it is kept and counted "
      + "in `clientFiltering.notEvaluated`, so a missing measurement can never be read as "
      + "a value below your floor. "
      + `${ROW_BOUNDED_TEXT_CLAUSE} ${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...BATCH_PARAMS],
    // Two spellings of "what to refresh", neither required on its own and an
    // empty call answerable only with "nothing to do". Declared so the runtime
    // refuses it by name instead of the handler discovering it later.
    atLeastOneOf: [["pairs", "tokens"]],
    exampleParams: {
      pairs: "ethereum:0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      window: "h24",
    },
    discovery: DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.pairs.batch"],
  },
  {
    toolId: "dexscreener.search",
    publicName: "dexscreener__pairs_search",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Search by `query` (name, symbol, or address), optionally scoped by `chain` "
      + "(server-side). Use this when identity is not yet established. Returns up to 30 "
      + "rows per chain queried; the provider window is fixed at 30 with no "
      + "continuation, and the envelope sets `providerCapped` with narrowing advice "
      + "(scope by chain, or query an exact address). Multiple chains issue one bounded "
      + "request per chain and merge, reported per chain. Copycat names are common: "
      + "check `liquidityUsd`, `pairAgeSeconds`, and the address before treating a match "
      + "as the real token. "
      + `A call fans out over ${SEARCH_DEFAULT_MAX_CHAINS} chains unless \`maxChains\` says `
      + "otherwise, and there is no hard ceiling on that: each chain is one separate "
      + "provider request inside one deadline, so raising it buys coverage and spends "
      + "time. `requestsIssued` and `perChain` report what it cost. "
      + "`limit`, `sortBy`, `sortDir` and every threshold run HERE, over the window the "
      + "provider already returned, so they re-order and remove rows but can never reach "
      + "a row the provider did not send; `droppedByFilter` accounts for every row removed. "
      + "There is deliberately NO `offset`: this tool is bounded and non-pageable, and the "
      + "envelope says `truncated` with a narrowing action instead of offering a page that "
      + "cannot exist. "
      + "Once a row is chosen, continue with dexscreener__pair_get for its full live state "
      + "or dexscreener__token_pairs_list for every pool of that token. "
      + `${ROW_BOUNDED_TEXT_CLAUSE} ${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    // `chain` and `chainIds` are two spellings of one scoping decision.
    // Declared rather than left in prose so discovery can show the exclusion
    // and the runtime enforces it instead of the handler guessing which one
    // the fan-out should honour.
    exclusiveParamGroups: [["chain", "chainIds"]],
    params: [...PAIRS_SEARCH_PARAMS],
    exampleParams: { query: "PEPE", chain: "solana", limit: 10 },
    discovery: DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.search"],
  },

  {
    toolId: "dexscreener.tokenPairs",
    publicName: "dexscreener__token_pairs_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List the indexed pools for `tokenAddress` on `chain`, ordered by liquidity "
      + "descending; the provider serves a bounded window of at most 30 pools, so a "
      + "high-pool-count token is partially covered and the envelope says so. Use this to "
      + "pick the canonical venue before charting, trading, or deep analysis. Returns "
      + "per-pool `liquiditySharePct` and `volumeSharePct`, `venueCount`, "
      + "`totalLiquidityUsd`, and `deepestPair` as an explicit summary. `deepestPair` "
      + "means deepest among the returned window, never a global claim; `resolutionBasis` "
      + "is echoed. When the token trades in more pools than the window, `providerCapped` "
      + "is set with narrowing advice. A forked chain carrying the same address can "
      + "appear; rows are chain-tagged and a `chain` filter narrows server-side. "
      + "EVERY SHARE AND TOTAL IS OVER THE RETURNED WINDOW, never over the token's real "
      + "pool set: `liquiditySharePct` is a pool's share of `totalLiquidityUsd`, which is "
      + "the sum of the pools that came back, so on a capped window the shares add to 100 "
      + "percent of a sample and not of the market. `venueCount` counts distinct dexes in "
      + "the same window. This is the routing input, and routing on a sample that reads as "
      + "a survey is how a swap ends up in the wrong pool. "
      + "There is no `offset`: this channel has no continuation, so the tool is bounded "
      + "and non-pageable and says which of the two it is rather than paging into nothing. "
      + "The full threshold family the screening tools use is accepted here and runs over "
      + "the returned window: `filtersApplied` echoes what ran, `droppedByFilter` counts "
      + "every pool removed and by which threshold, and a pool whose metric the provider "
      + "did not report is kept and counted in `clientFiltering.notEvaluated` rather than "
      + "compared as a zero. "
      + `${ROW_BOUNDED_TEXT_CLAUSE} ${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    params: [...TOKEN_PAIRS_PARAMS],
    exampleParams: {
      chain: "ethereum",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
    discovery: DEXSCREENER_RESOLVE_DISCOVERY["dexscreener.tokenPairs"],
  },
];
