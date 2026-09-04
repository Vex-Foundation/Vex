import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VIRTUALS_CHAIN_SLUGS } from "../chain-param.js";
import { VIRTUALS_AGENTS_DISCOVERY } from "../../embeddings/virtuals/agents.js";
import { MAX_PAGE_SIZE, SORT_CHOICES } from "../list-params.js";
import {
  VIRTUALS_FACTORIES,
  VIRTUALS_GENESIS_SORT_FIELDS,
  VIRTUALS_GENESIS_STATUSES,
  VIRTUALS_ROLES,
  VIRTUALS_SEARCH_SCOPES,
  VIRTUALS_SORT_DIRECTIONS,
  VIRTUALS_VIBES_STATUSES,
} from "@tools/virtuals/types.js";

// Virtuals Protocol agent-token intelligence - READ-ONLY. Discovery surface for
// agent tokens on Base, Robinhood (chain 4663), Solana and Ethereum.
//
// EVERY FILTER BELOW IS SERVER-SIDE and was sent live at least once before it
// was declared; the provenance table is `src/tools/virtuals/Virtuals.md`. The
// reason the vocabulary is closed rather than free-text is measured: the API
// SILENTLY IGNORES an unknown filter key (returning the whole population) and
// returns ZERO rows for an unknown value inside a known key, so a typo is
// invisible in the response either way.
//
// Chain is the API's required filter over a CLOSED four-value set. The manifest
// advertises the canonical lowercase slugs like every other namespace; the
// provider's UPPERCASE spelling is translated inside `../chain-param.ts`, per
// SPEC section 1.1 ("per-provider translation stays in the adapter, never in
// the manifest").

/**
 * The `chain` param, shared by the chain-scoped tools so their accepted value
 * set cannot drift apart.
 */
const VIRTUALS_CHAIN_PARAM: ProtocolParamDef = {
  key: "chain",
  type: "string",
  required: true,
  enum: VIRTUALS_CHAIN_SLUGS,
  description:
    "REQUIRED. The one chain to list - Virtuals indexes exactly four: "
    + `${VIRTUALS_CHAIN_SLUGS.join(", ")}. ${CANONICAL_CHAIN_SENTENCE}`,
};

/** The page knob, under both accepted spellings. */
const PAGE_SIZE_PARAMS: ProtocolParamDef[] = [
  {
    key: "limit",
    type: "number",
    description:
      `Rows to return on this page (default 20, max ${MAX_PAGE_SIZE}). This is OUR bound, not the `
      + "provider's - it served a 10,000-row page live - because an agent row is large. Filtering is "
      + "server-side, so a smaller page is not a smaller search: `totalMatched` says how many rows the "
      + "filter found and `nextPage` reaches the rest. Out of range is rejected, not clamped.",
  },
  {
    key: "pageSize",
    type: "number",
    description:
      "Alias of `limit`, accepted for compatibility - the same knob now that filtering happens "
      + "server-side. Send either spelling, never both spellings in the same call.",
  },
];

const PAGE_PARAM: ProtocolParamDef = {
  key: "page",
  type: "number",
  description: "1-based provider page (default 1). The reply's `nextPage` names the next one.",
};

export const VIRTUALS_AGENTS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.list",
    publicName: "virtuals__agents_discover",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Screen Virtuals Protocol agent tokens on ONE chain (base, robinhood, solana, ethereum). Use this to find or compare agent tokens rather than read one you can already name. EVERY FILTER RUNS SERVER-SIDE, so an empty result is a statement about your screen, not about a slice of the chain: the reply carries `count` (rows here), `totalMatched` (rows the filter found), `page`, `pageSize`, `pageCount`, `hasMore`, `nextPage` when there is one, and `filtersApplied` echoing exactly what ran. Each row carries id, virtualId, name, symbol, status (UNDERGRAD bonding-curve vs graduated AVAILABLE, with a warning on UNDERGRAD), factory, role, token/preToken/LP addresses, holderCount, top10HolderPercentage, devHoldingPercentage, mcapInVirtual (denominated in the VIRTUAL token, NOT USD), volume24h, priceChangePercent24h, the raw 18-decimal price in VIRTUAL, isVerified (anti-impersonation badge only), the anti-sniper tax window, ageDays, launchedAt and verified socials. Screen with any combination of: status, query + searchScope, symbol, tokenAddress (matches either the curve token or the graduated token), creatorWallet, factory, role, market-cap / holder / volume / liquidity / 24h-change / top-10-concentration ranges, createdAfter, launchedAfter, and the boolean screens isVerified, hasGraduated, hasGenesis, hasStaking, hasMarginTrading, hasFounderVideo, hasRevenueConnect, isDevCommitted, hasAntiSniperTax, hasAirdrop, needAcf, isProject60days, launchRadarEnabled, isRobotics, includeLaunchX / excludeLaunchX. Order with sortBy over the provider's 26 sortable attributes plus four convenience keywords, and sortDirection asc or desc. Set includePriceSeries for the provider's own 24h price samples on each row. Every unrecognised value is REJECTED by name rather than clamped or ignored - which matters here because the provider itself ignores an unknown filter key and returns everything. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      VIRTUALS_CHAIN_PARAM,
      {
        key: "status",
        type: "string",
        enum: ["undergrad", "graduated", "genesis", "all"],
        description:
          "Lifecycle stage, applied SERVER-SIDE: undergrad (still on the bonding curve), graduated "
          + "(AVAILABLE, trading on an AMM pool), genesis (in a points sale), or all (default, no filter). "
          + "An unrecognised value is rejected, not ignored.",
      },
      {
        key: "sortBy",
        type: "string",
        enum: SORT_CHOICES,
        description:
          "Order the provider applies. Accepts its 26 sortable attributes directly, plus four keywords "
          + "kept for compatibility: mcap (= mcapInVirtual, the default), volume (= volume24h), newest "
          + "(= createdAt) and recentGraduation (= lpCreatedAt, which ALSO restricts the result to "
          + "graduated agents, because ordering non-graduates by graduation time answers a different "
          + "question). The provider refuses an attribute it does not have, so an unlisted key is a "
          + "failed call rather than a default order.",
      },
      {
        key: "sort",
        type: "string",
        enum: SORT_CHOICES,
        description: "Alias of sortBy. Send either spelling, never both spellings in the same call.",
      },
      {
        key: "sortDirection",
        type: "string",
        enum: VIRTUALS_SORT_DIRECTIONS,
        description:
          "asc or desc (default desc). Declared as a closed set because the provider ACCEPTS a nonsense "
          + "direction and silently sorts descending, so a typo would be invisible.",
      },
      ...PAGE_SIZE_PARAMS,
      PAGE_PARAM,
      {
        key: "query",
        type: "string",
        description:
          "Free text or an address. By default it matches name, symbol, tokenAddress and preToken; "
          + "`searchScope` narrows that to one side or the other.",
      },
      {
        key: "searchScope",
        type: "string",
        enum: VIRTUALS_SEARCH_SCOPES,
        description:
          "What `query` matches: text (name and symbol only), address (exact token or preToken match, "
          + "case-insensitive), or any (default, both). Only meaningful alongside `query`.",
      },
      {
        key: "symbol",
        type: "string",
        description: "Exact ticker match, case-insensitive. Symbols are NOT unique - VEX matched 10 rows.",
      },
      {
        key: "tokenAddress",
        type: "string",
        description:
          "Find the agent that owns this address. Matches EITHER the graduated tokenAddress OR the "
          + "bonding preToken, because the same agent uses different columns before and after "
          + "graduation.",
      },
      {
        key: "creatorWallet",
        type: "string",
        description: "The wallet that launched the agent (the row's own walletAddress), case-insensitive.",
      },
      {
        key: "factory",
        type: "string",
        enum: VIRTUALS_FACTORIES,
        description:
          "The launch contract family. Live BASE counts on 2026-09-04: BONDING_V4 21,630, BONDING_V5 "
          + "19,473, BONDING 15,326, BONDING_V2 112, VIBES_BONDING_V2 47, ERC20 30, ERC20_PRO 4, "
          + "BONDING_V3 3, SOL_METEORA 0 (98 on solana). Every ROBOTIC_* member returned ZERO rows: a "
          + "robotics agent is stored under the plain factory with launchInfo.isRobotics true, so use "
          + "`isRobotics` for that screen.",
      },
      {
        key: "role",
        type: "string",
        enum: VIRTUALS_ROLES,
        description:
          "The agent's declared role. Most rows have none at all (9,410 of 10,000 sampled), so this is a "
          + "narrow screen: ON_CHAIN 3,392 rows chain-wide.",
      },
      {
        key: "vibesStatus",
        type: "string",
        enum: VIRTUALS_VIBES_STATUSES,
        description:
          "The vibes/ICO lane state. PRECOMMIT is the only value the provider matches (19 rows live); "
          + "anything else returns zero rows there, which is why the set is closed here.",
      },
      { key: "isVerified", type: "boolean", description: "Anti-impersonation badge only - NOT a safety or quality signal. 45 rows carry it on base." },
      { key: "hasGraduated", type: "boolean", description: "The provider's own definition of graduated: lpCreatedAt is set." },
      { key: "hasGenesis", type: "boolean", description: "The agent came through a genesis points sale (its genesis relation is set)." },
      { key: "hasStaking", type: "boolean", description: "The agent has a staking address or an agent staking contract." },
      { key: "hasMarginTrading", type: "boolean", description: "The agent is margin-tradable. Zero rows on base and robinhood when last measured." },
      { key: "hasFounderVideo", type: "boolean", description: "The agent published a founder video pitch." },
      { key: "hasRevenueConnect", type: "boolean", description: "The agent has a revenue-connect wallet configured." },
      { key: "isDevCommitted", type: "boolean", description: "The developer made the on-platform commitment." },
      {
        key: "hasAntiSniperTax",
        type: "boolean",
        description:
          "The launch configured a non-zero anti-sniper tax type. Note this is about CONFIGURATION, not "
          + "about the window being open right now - read each row's antiSniper block for that.",
      },
      { key: "hasAirdrop", type: "boolean", description: "The launch reserved a non-zero airdrop percentage." },
      { key: "needAcf", type: "boolean", description: "The launch used Automated Capital Formation (the 10 VIRTUAL launch-fee option)." },
      { key: "isProject60days", type: "boolean", description: "The launch is in the 60-day project programme." },
      { key: "launchRadarEnabled", type: "boolean", description: "The launch opted into Launch Radar." },
      { key: "isRobotics", type: "boolean", description: "A robotics agent. This is the working screen for robotics; the ROBOTIC_* factory values match nothing." },
      { key: "includeLaunchX", type: "boolean", description: "Keep ONLY X_LAUNCH and ACP_LAUNCH agents. Opposite of excludeLaunchX; send at most one." },
      { key: "excludeLaunchX", type: "boolean", description: "Drop X_LAUNCH and ACP_LAUNCH agents, as the provider's own UI does by default." },
      { key: "minMcapInVirtual", type: "number", description: "Market cap floor, denominated in VIRTUAL, not USD." },
      { key: "maxMcapInVirtual", type: "number", description: "Market cap ceiling, denominated in VIRTUAL, not USD." },
      { key: "minHolderCount", type: "number", description: "Floor on the holder count - the usual screen against an agent nobody holds." },
      { key: "maxHolderCount", type: "number", description: "Ceiling on the holder count, for finding agents that are still early." },
      { key: "minVolume24h", type: "number", description: "24h volume floor (USD, display-grade)." },
      { key: "maxVolume24h", type: "number", description: "24h volume ceiling (USD, display-grade)." },
      { key: "minLiquidityUsd", type: "number", description: "Liquidity floor (USD, display-grade)." },
      { key: "maxLiquidityUsd", type: "number", description: "Liquidity ceiling (USD, display-grade)." },
      { key: "minPriceChangePercent24h", type: "number", description: "24h change floor, in percent. Negative is legal: -20 means down no more than 20 percent." },
      { key: "maxPriceChangePercent24h", type: "number", description: "24h change ceiling, in percent. Negative is legal." },
      { key: "minTop10HolderPercentage", type: "number", description: "Top-10 concentration floor, 0-100." },
      { key: "maxTop10HolderPercentage", type: "number", description: "Top-10 concentration ceiling, 0-100 - the usual way to screen out concentrated supply." },
      { key: "createdAfter", type: "string", description: "Only agents created at or after this date (YYYY-MM-DD or full ISO)." },
      { key: "launchedAfter", type: "string", description: "Only agents whose bonding pair started trading at or after this date." },
      { key: "genesisStartsAfter", type: "string", description: "Only agents whose linked genesis sale starts at or after this date." },
      { key: "genesisStartsBefore", type: "string", description: "Only agents whose linked genesis sale starts at or before this date." },
      {
        key: "includePriceSeries",
        type: "boolean",
        description:
          "Ask the provider for its 24h price samples and 24h low/high on each row, returned as "
          + "`priceSeries24h`. These are irregularly spaced samples, not OHLC candles; for real candles "
          + "on a graduated agent use virtuals__agent_candles_list.",
      },
    ],
    // `sortBy`/`sort` and `limit`/`pageSize` are the SAME knob under two
    // spellings; accepting both and letting one win is the silent-drop pattern
    // this namespace removes everywhere else. `includeLaunchX`/`excludeLaunchX`
    // are opposites that can never both hold.
    atMostOne: [["sortBy", "sort"], ["limit", "pageSize"], ["includeLaunchX", "excludeLaunchX"]],
    exampleParams: { chain: "base", status: "undergrad", sortBy: "volume24h", maxTop10HolderPercentage: 30, limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.list"],
  },
  {
    toolId: "virtuals.get",
    publicName: "virtuals__agent_get",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Read ONE Virtuals agent token's full profile by its numeric id. Returns `agent` with everything the screening row carries plus: category, level, fdvInVirtual, liquidityUsd, the 5m/1h/6h volume and price-change series, mindshare, the raw totalValueLocked, a `graduation` block (graduated, tokenAddress, lpAddress, lpCreatedAt, migrateTokenAddress and the bonding preTokenPair), an `addresses` block (creator wallet, DAO, token-bound account, veToken, staking, distributors, tax recipient, revenue-connect wallet), the full `launchInfo` (launch mode, anti-sniper type, airdrop percent, ACF, 60-day project, launch radar, robotics, fee delegation and the raw initial-purchase integers), the linked `genesis` and `vibesInfo`, the agent's `cores`, a bounded `tokenomics` summary with its truncation stated, a sanitized `descriptionExcerpt` with markdown and embedded images stripped, `omittedFreeText` naming the large blobs this projection deliberately drops, and a `tradingRoute` hint saying whether the agent trades on its bonding CURVE or on a DEX pool and which existing tool reaches it. ALWAYS read the `antiSniper` block before a curve trade: the tax starts near 99 percent at launch and decays over 60 s, 600 s or 5880 s depending on the type. Personal data (the creator's email and account DID) is dropped at the provider boundary and never returned. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "number", required: true, description: "Numeric Virtuals agent id, exactly as virtuals__agents_discover returns it (e.g. 96200 for VEX). The string spelling \"96200\" is accepted too." },
    ],
    exampleParams: { id: 96200 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.get"],
  },
  {
    toolId: "virtuals.graduations",
    publicName: "virtuals__graduations_list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "The 'what just graduated' feed: Virtuals agent tokens that most recently left the bonding curve on ONE chain (base, robinhood, solana, ethereum), newest first by graduation time. Use this when the user asks what just graduated or wants to catch a fresh graduation. The graduated population is selected SERVER-SIDE (the provider's own lpCreatedAt-is-set definition) and ordered by lpCreatedAt descending, so the reply is a whole answer rather than a slice: `count`, `totalMatched`, `page`, `pageSize`, `pageCount`, `hasMore` and `nextPage` when there is one. Rows carry the same fields virtuals__agents_discover returns. Note that the anti-sniper tax runs on the BONDING CURVE and is long over by the time an agent graduates, so a fresh graduation is not a taxed buy - each row's antiSniper block says so explicitly. Out-of-range limit, pageSize or page is REJECTED by name, not clamped. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [VIRTUALS_CHAIN_PARAM, ...PAGE_SIZE_PARAMS, PAGE_PARAM],
    atMostOne: [["limit", "pageSize"]],
    exampleParams: { chain: "base", limit: 10 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.graduations"],
  },
  {
    toolId: "virtuals.geneses",
    publicName: "virtuals__genesis_launches_list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Browse the Virtuals GENESIS calendar - the points-sale events that precede an agent-token launch, mostly on Base. Use this when the user asks what is launching soon on Virtuals or wants the history of a sale; a token that already trades is virtuals__agents_discover instead. Returns `geneses` alongside count, totalMatched, page, pageSize, hasMore and `reserveAmountTiers`. Filter by `status` and by the agent's `chain`, order by id, startsAt or endsAt in either direction, and page with limit/pageSize and page. Each row carries id, genesisId, status, startsAt, endsAt, totalParticipants, totalPoints, totalVirtuals, the on-chain genesisAddress and genesisTx, and the linked `agent` (id, name, symbol, chain, status, token and preToken addresses, isVerified) or null. The reply also carries `reserveAmountTiers`, the VIRTUAL reserve targets a sale can be configured for, straight from the provider's own parameters endpoint. Continuation is `hasMore` plus `nextPage`; when the provider omits its own total, page or pageSize the reply OMITS both and carries a `continuationNote` naming the missing number - read that as UNKNOWN, never as the end of the calendar. Read a suspicious far-future date as spam rather than as a scheduled launch. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "status",
        type: "string",
        enum: VIRTUALS_GENESIS_STATUSES,
        description:
          "Sale lifecycle. Live counts on 2026-09-04: FINALIZED 145, CANCELLED 33. An unknown value "
          + "returns zero rows with no error upstream, which is why the set is closed here.",
      },
      {
        key: "chain",
        type: "string",
        enum: VIRTUALS_CHAIN_SLUGS,
        description: `Only sales whose agent is on this chain. ${CANONICAL_CHAIN_SENTENCE}`,
      },
      {
        key: "sortBy",
        type: "string",
        enum: VIRTUALS_GENESIS_SORT_FIELDS,
        description:
          "id (default), startsAt or endsAt. Closed on purpose: unlike the agents endpoint, this one "
          + "does NOT validate the sort attribute - an unknown key is accepted and silently ignored.",
      },
      { key: "sortDirection", type: "string", enum: VIRTUALS_SORT_DIRECTIONS, description: "asc or desc (default desc)." },
      ...PAGE_SIZE_PARAMS,
      PAGE_PARAM,
    ],
    atMostOne: [["limit", "pageSize"]],
    exampleParams: { status: "FINALIZED", limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.geneses"],
  },
];
