/**
 * Virtuals agent projectors - the ONLY place raw Virtuals payload becomes
 * model-facing tool output. This is a COMPLETE trust boundary:
 *
 * - STRUCTURAL fields are narrowed into TRUSTED SHAPES via `trusted-fields.ts`:
 *   chain/status/factory/role through closed enums (unknown => null + a degrade
 *   note, never pass-through), timestamps re-serialized to canonical ISO,
 *   addresses through EVM-hex / Solana-base58 checks, genesis ids and statuses
 *   through strict identifier tokens, social URLs through an https-only
 *   strict-charset validator (invalid => dropped).
 * - FREE-TEXT fields (`name`, `symbol`, `category`, `description`, tokenomics
 *   entry names, social platform/handle) pass `sanitizeForSystemPrompt`
 *   (neutralizes fence / role-tag / chat-template escapes) AND hard length
 *   caps. `description` is reduced to a bounded excerpt; `overview`,
 *   `tokenUtility`, `roadmap` and `additionalDetails` are DROPPED.
 * - MARKDOWN AND EMBEDDED IMAGES ARE STRIPPED from the description before it is
 *   bounded. Live rows put a bare image tag in the field (agent 96200's whole
 *   description is `![Upload](https://s3.../vex_og_home.jpg)`), so a projection
 *   that only capped the length would hand the model a remote URL dressed as
 *   prose.
 *
 * THE PROJECTION IS A DECLARED CONTRACT, NOT A HABIT. Every one of the
 * provider's 84 row fields is either projected below or listed with its reason
 * in the DROPPED table of `src/tools/virtuals/Virtuals.md`. Two of them -
 * `creator.email` (masked, still a partial address) and `creator.username` (a
 * Privy DID) - never even reach this module: `@tools/virtuals/validation.ts`
 * refuses them at the boundary so no later change here can leak them.
 */

import { sanitizeForSystemPrompt } from "@vex-agent/engine/prompts/sanitize.js";
import type {
  VirtualsAgent,
  VirtualsChain,
  VirtualsGenesis,
  VirtualsPricePoint,
} from "@tools/virtuals/types.js";
import { computeAntiSniper, type AntiSniperStatus } from "./anti-sniper.js";
import {
  trustedAddress,
  trustedAgentStatus,
  trustedChain,
  trustedFactory,
  trustedHttpsUrl,
  trustedIdentifier,
  trustedIsoTimestamp,
  trustedRole,
  type TrustedAgentStatus,
  type TrustedFactory,
  type TrustedRole,
} from "./trusted-fields.js";

// ── Bounds ──────────────────────────────────────────────────────────

const NAME_MAX = 96;
const SYMBOL_MAX = 32;
const CATEGORY_MAX = 48;
const DESCRIPTION_EXCERPT_MAX = 280;
const TOKENOMICS_ENTRY_NAME_MAX = 48;
const MAX_TOKENOMICS_ALLOCATIONS = 6;
const MAX_CORES = 8;
/** The 24 h series is a chart, not a ledger; 96 points is 15-minute detail. */
const MAX_PRICE_POINTS = 96;
const MS_PER_DAY = 86_400_000;

/** `virtualTokenValue` is the price in VIRTUAL at 18 decimals (verified: the */
/** reported mcapInVirtual equals value/1e18 times the 1e9 supply). */
const VIRTUAL_TOKEN_VALUE_DECIMALS = 18;

// ── VIRTUAL quote token + venue tool by chain (on-chain verified) ──

/** VIRTUAL token address the graduated pool quotes against, per chain. */
const VIRTUAL_TOKEN_BY_CHAIN: Record<string, string> = {
  ROBINHOOD: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  BASE: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  ETH: "0x44ff8620b8cA30902395A7bD3F2407e1A091BF73",
  SOLANA: "3iQL8BFS2vE7mww4ehAqQHAsbmRNCrPxizWAT2Zfyr9y",
};

/** venue = the tool label the model uses; namespace = the ToolSearch namespace. */
const VENUE_BY_CHAIN: Record<string, { venue: string; namespace: string }> = {
  ROBINHOOD: { venue: "uniswap", namespace: "uniswap" },
  BASE: { venue: "kyberswap", namespace: "kyberswap" },
  ETH: { venue: "kyberswap", namespace: "kyberswap" },
  SOLANA: { venue: "jupiter", namespace: "solana" },
};

// ── Sanitizing / bounding helpers (free-text only) ─────────────────

/** Sanitize + hard-cap a short identifier string. */
function boundedText(raw: string | null, maxChars: number): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const sliced = collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
  return sanitizeForSystemPrompt(sliced);
}

/**
 * Reduce provider markdown to plain prose BEFORE bounding: image embeds and
 * links become their label (or nothing), and heading / quote / emphasis
 * punctuation is dropped. Measured need: a live agent's entire `description` is
 * one `![Upload](https://s3.../file.jpg)` tag, and `tokenUtility` and `roadmap`
 * are blockquote-and-bullet markdown.
 */
function stripMarkdown(raw: string): string {
  return raw
    // `![alt](url)` - an embedded image. The URL is remote content the model
    // must not be handed as if it were the author's words; the alt text is
    // kept only when it says something.
    .replace(/!\[([^\]]*)]\([^)]*\)/g, (_m, alt: string) => (alt.trim().length > 0 ? alt : ""))
    // `[text](url)` - keep the text, drop the target.
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    // Bare autolinks and raw URLs.
    .replace(/<https?:\/\/[^>]*>/gi, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/`{1,3}/g, "")
    .replace(/^\s*[>#*-]+\s?/gm, "")
    .replace(/[*_]{1,3}/g, "");
}

/** Strip markdown, sanitize, and reduce prose to a bounded excerpt. */
function boundedExcerpt(raw: string | null, maxChars: number): string | null {
  if (!raw) return null;
  const collapsed = stripMarkdown(raw).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const sliced = collapsed.length > maxChars
    ? `${collapsed.slice(0, maxChars).trimEnd()}...`
    : collapsed;
  return sanitizeForSystemPrompt(sliced);
}

function ageDaysFrom(trustedIso: string | null, nowMs: number): number | null {
  if (!trustedIso) return null;
  const ms = Date.parse(trustedIso);
  if (!Number.isFinite(ms)) return null;
  return Math.round(((nowMs - ms) / MS_PER_DAY) * 10) / 10;
}

const UNDERGRAD_WARNING =
  "UNDERGRAD - bonding-curve pre-graduation: illiquid, LP not locked, may never graduate. Extreme caution; prefer graduated (AVAILABLE) agents.";

/** Degrade note when upstream sends structural values outside the trusted shapes. */
function unrecognizedFieldsNote(dropped: readonly string[]): string {
  return `Upstream sent unrecognized ${dropped.join("/")} value(s) - dropped; treat this row with caution.`;
}

// ── Trusted structural snapshot of one agent ───────────────────────

interface TrustedAgentFields {
  chain: VirtualsChain | null;
  status: TrustedAgentStatus | null;
  factory: TrustedFactory | null;
  role: TrustedRole | null;
  tokenAddress: string | null;
  preToken: string | null;
  preTokenPair: string | null;
  migrateTokenAddress: string | null;
  lpAddress: string | null;
  creatorWallet: string | null;
  lpCreatedAt: string | null;
  createdAt: string | null;
  launchedAt: string | null;
  /** Structural fields upstream sent but that failed shape validation. */
  dropped: string[];
}

function validateAgentFields(agent: VirtualsAgent): TrustedAgentFields {
  const dropped: string[] = [];
  const keep = <T>(label: string, raw: string | null, value: T | null): T | null => {
    if (raw !== null && value === null) dropped.push(label);
    return value;
  };
  return {
    chain: keep("chain", agent.chain, trustedChain(agent.chain)),
    status: keep("status", agent.status, trustedAgentStatus(agent.status)),
    factory: keep("factory", agent.factory, trustedFactory(agent.factory)),
    // An empty `role` is the common case (9,410 of 10,000 sampled rows), and
    // `readString` already turned "" into null, so no degrade note fires here.
    role: keep("role", agent.role, trustedRole(agent.role)),
    tokenAddress: keep("tokenAddress", agent.tokenAddress, trustedAddress(agent.tokenAddress)),
    preToken: keep("preToken", agent.preToken, trustedAddress(agent.preToken)),
    preTokenPair: keep("preTokenPair", agent.preTokenPair, trustedAddress(agent.preTokenPair)),
    migrateTokenAddress: keep(
      "migrateTokenAddress",
      agent.migrateTokenAddress,
      trustedAddress(agent.migrateTokenAddress),
    ),
    lpAddress: keep("lpAddress", agent.lpAddress, trustedAddress(agent.lpAddress)),
    creatorWallet: keep("walletAddress", agent.walletAddress, trustedAddress(agent.walletAddress)),
    lpCreatedAt: keep("lpCreatedAt", agent.lpCreatedAt, trustedIsoTimestamp(agent.lpCreatedAt)),
    createdAt: keep("createdAt", agent.createdAt, trustedIsoTimestamp(agent.createdAt)),
    launchedAt: keep("launchedAt", agent.launchedAt, trustedIsoTimestamp(agent.launchedAt)),
    dropped,
  };
}

function isGraduated(fields: TrustedAgentFields): boolean {
  return fields.status === "AVAILABLE" && fields.tokenAddress !== null && fields.lpAddress !== null;
}

// ── Trading route hint ──────────────────────────────────────────────

export interface VirtualsTradingRoute {
  /** True only when an EXISTING Vex tool can execute this trade today. */
  tradable: boolean;
  /** `curve` while on the bonding curve, `dex` once graduated. */
  market: "curve" | "dex";
  venue: string | null;
  namespace: string | null;
  /** The pool or pair the trade goes through, when one exists. */
  poolAddress: string | null;
  quoteToken: string | null;
  quoteSymbol: "VIRTUAL";
  note?: string;
}

/**
 * Which market an agent trades on, and which existing Vex tool reaches it.
 *
 * Three genuinely different cells, all measured:
 * - GRADUATED, any chain: an AMM pool at `lpAddress`, reachable through the
 *   venue tool for that chain exactly as before.
 * - BONDING on SOLANA: the curve is a Meteora DBC pool that Jupiter routes, so
 *   `solana__*` reaches it TODAY (live Jupiter quotes routed an UNDERGRAD
 *   agent through "Dynamic Bonding Curve").
 * - BONDING on an EVM chain: the curve is a Virtuals FPairV2 pair behind
 *   BondingV5/FRouterV3. No generic venue tool reaches it; the dedicated
 *   Virtuals curve-trade tools are a later lane, so the honest answer is
 *   `tradable: false` NAMING the pair rather than a venue that would fail.
 */
function resolveTradingRoute(fields: TrustedAgentFields): VirtualsTradingRoute {
  const chain = fields.chain ?? "";
  const venue = VENUE_BY_CHAIN[chain] ?? null;
  const quoteToken = VIRTUAL_TOKEN_BY_CHAIN[chain] ?? null;

  if (isGraduated(fields)) {
    return {
      tradable: true,
      market: "dex",
      venue: venue?.venue ?? null,
      namespace: venue?.namespace ?? null,
      poolAddress: fields.lpAddress,
      quoteToken,
      quoteSymbol: "VIRTUAL",
    };
  }

  if (fields.chain === "SOLANA") {
    return {
      tradable: true,
      market: "curve",
      venue: "jupiter",
      namespace: "solana",
      poolAddress: fields.preTokenPair,
      quoteToken,
      quoteSymbol: "VIRTUAL",
      note:
        "Pre-graduation, but on Solana the curve is a Meteora Dynamic Bonding Curve pool that "
        + "Jupiter routes, so the solana tools reach it today. Expect thin liquidity and high price "
        + "impact on the curve.",
    };
  }

  return {
    tradable: false,
    market: "curve",
    venue: null,
    namespace: null,
    poolAddress: fields.preTokenPair,
    quoteToken,
    quoteSymbol: "VIRTUAL",
    note:
      "Pre-graduation on an EVM chain: this agent trades on a Virtuals bonding-curve pair "
      + "(BondingV5 / FRouterV3), not on an AMM pool, so no generic swap tool can reach it. Read "
      + "the antiSniper block before considering a curve trade - the tax starts near 99 percent.",
  };
}

// ── Price series ────────────────────────────────────────────────────

export interface VirtualsPriceSeries {
  /** Oldest first. Unix seconds; price is in VIRTUAL per agent token. */
  points: readonly { readonly timestampSeconds: number; readonly price: number }[];
  /** Provider-reported `[low, high]` over the same 24 h, when asked for. */
  range24h: readonly [number, number] | null;
  returned: number;
  /** True when the provider sent more points than the bound above keeps. */
  truncated: boolean;
  note: string;
}

const PRICE_SERIES_NOTE =
  "The provider's own 24 h sparkline: irregularly spaced samples, not OHLC candles, and "
  + "display-grade (no decimals metadata). Point spacing is whatever the provider chose. For real "
  + "candles on a graduated agent use virtuals__agent_candles_list.";

function projectPriceSeries(
  sparkline: readonly VirtualsPricePoint[] | null | undefined,
  range24h: readonly [number, number] | null | undefined,
): VirtualsPriceSeries | null {
  // `undefined` as well as `null`: a hand-built agent object (a fixture, or a
  // caller that predates the field) simply has no series, and that is the same
  // answer as the provider not sending one.
  if (sparkline === null || sparkline === undefined || !Array.isArray(sparkline)) return null;
  const ordered = [...sparkline].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  const kept = ordered.slice(-MAX_PRICE_POINTS);
  return {
    points: kept,
    range24h: range24h ?? null,
    returned: kept.length,
    truncated: kept.length < ordered.length,
    note: kept.length < ordered.length
      ? `${PRICE_SERIES_NOTE} The oldest ${ordered.length - kept.length} of ${ordered.length} points `
        + `were dropped to keep the row bounded; the newest ${kept.length} are here.`
      : PRICE_SERIES_NOTE,
  };
}

// ── Concise list projection ─────────────────────────────────────────

export interface ConciseSocial {
  platform: string | null;
  handle: string | null;
  /** https-only, strict-charset validated; invalid upstream URLs are dropped. */
  url: string | null;
}

export interface ConciseVirtualsAgent {
  id: number | null;
  /** The protocol's own agent id, distinct from the API row id above. */
  virtualId: string | null;
  name: string | null;
  symbol: string | null;
  chain: VirtualsChain | null;
  status: TrustedAgentStatus | null;
  isUndergrad: boolean;
  warning: string | null;
  factory: TrustedFactory | null;
  role: TrustedRole | null;
  tokenAddress: string | null;
  preToken: string | null;
  lpAddress: string | null;
  holderCount: number | null;
  top10HolderPercentage: number | null;
  devHoldingPercentage: number | null;
  mcapInVirtual: number | null;
  volume24h: number | null;
  priceChangePercent24h: number | null;
  /** Raw integer string at 18 decimals; the price in VIRTUAL per agent token. */
  priceInVirtualRaw: string | null;
  priceInVirtualDecimals: number | null;
  isVerified: boolean;
  antiSniper: AntiSniperStatus;
  ageDays: number | null;
  launchedAt: string | null;
  socials: ConciseSocial[];
  /** Present only when the caller asked for the 24 h series. */
  priceSeries24h?: VirtualsPriceSeries;
}

function projectSocials(agent: VirtualsAgent): ConciseSocial[] {
  return agent.socials.map((s) => ({
    platform: boundedText(s.platform, SYMBOL_MAX),
    handle: boundedText(s.handle, NAME_MAX),
    url: trustedHttpsUrl(s.url),
  }));
}

function composeWarning(fields: TrustedAgentFields): string | null {
  const parts: string[] = [];
  if (fields.status === "UNDERGRAD") parts.push(UNDERGRAD_WARNING);
  if (fields.dropped.length > 0) parts.push(unrecognizedFieldsNote(fields.dropped));
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The anti-sniper clock, from the fields the row actually carries.
 * `launchedAt` is the bonding pair's trading start (the contract's own anchor);
 * `createdAt` is the fallback for legacy rows that predate it.
 */
function antiSniperFor(
  agent: VirtualsAgent,
  fields: TrustedAgentFields,
  nowMs: number,
): AntiSniperStatus {
  return computeAntiSniper({
    antiSniperTaxType: agent.launchInfo?.antiSniperTaxType ?? null,
    launchedAtIso: fields.launchedAt ?? fields.createdAt,
    graduated: isGraduated(fields),
    nowMs,
  });
}

/** Concise, injection-safe list row. */
export function projectVirtualsListItem(
  agent: VirtualsAgent,
  nowMs: number = Date.now(),
): ConciseVirtualsAgent {
  const fields = validateAgentFields(agent);
  const series = projectPriceSeries(agent.sparkline, agent.range24h);
  return {
    id: agent.id,
    virtualId: trustedIdentifier(agent.virtualId, 32),
    name: boundedText(agent.name, NAME_MAX),
    symbol: boundedText(agent.symbol, SYMBOL_MAX),
    chain: fields.chain,
    status: fields.status,
    isUndergrad: fields.status === "UNDERGRAD",
    warning: composeWarning(fields),
    factory: fields.factory,
    role: fields.role,
    tokenAddress: fields.tokenAddress,
    preToken: fields.preToken,
    lpAddress: fields.lpAddress,
    holderCount: agent.holderCount,
    top10HolderPercentage: agent.top10HolderPercentage,
    devHoldingPercentage: agent.devHoldingPercentage,
    mcapInVirtual: agent.mcapInVirtual,
    volume24h: agent.volume24h,
    priceChangePercent24h: agent.priceChangePercent24h,
    priceInVirtualRaw: agent.virtualTokenValue,
    priceInVirtualDecimals: agent.virtualTokenValue === null
      ? null
      : VIRTUAL_TOKEN_VALUE_DECIMALS,
    isVerified: agent.isVerified,
    antiSniper: antiSniperFor(agent, fields, nowMs),
    ageDays: ageDaysFrom(fields.createdAt, nowMs),
    launchedAt: fields.launchedAt,
    socials: projectSocials(agent),
    ...(series ? { priceSeries24h: series } : {}),
  };
}

export function projectVirtualsList(
  agents: readonly VirtualsAgent[],
  nowMs: number = Date.now(),
): ConciseVirtualsAgent[] {
  return agents.map((a) => projectVirtualsListItem(a, nowMs));
}

// ── Detail projection ───────────────────────────────────────────────

export interface ConciseTokenomicsAllocation {
  name: string | null;
  amount: number | null;
  isLocked: boolean | null;
  startsAt: string | null;
}

export interface ConciseTokenomics {
  totalSupply: number | null;
  circulatingSupply: number | null;
  allocations: ConciseTokenomicsAllocation[];
  /** True when the provider sent more allocations than the bound keeps. */
  truncated: boolean;
  totalAllocations: number;
  hasUnlocked: boolean | null;
  daysFromFirstUnlock: number | null;
}

export interface DetailedVirtualsAgent extends ConciseVirtualsAgent {
  category: string | null;
  level: number | null;
  fdvInVirtual: number | null;
  liquidityUsd: number | null;
  netVolume24h: number | null;
  volume5m: number | null;
  volume1h: number | null;
  volume6h: number | null;
  priceChangePercent5m: number | null;
  priceChangePercent1h: number | null;
  priceChangePercent6h: number | null;
  holderCountPercent24h: number | null;
  mindshare: number | null;
  /** Integer string with an UNDECLARED scale - see Virtuals.md. */
  totalValueLockedRaw: string | null;
  graduation: {
    graduated: boolean;
    tokenAddress: string | null;
    lpAddress: string | null;
    lpCreatedAt: string | null;
    migrateTokenAddress: string | null;
    /** The curve pair - the trades and reserves key while still bonding. */
    preTokenPair: string | null;
  };
  addresses: {
    creatorWallet: string | null;
    dao: string | null;
    tokenBoundAccount: string | null;
    veToken: string | null;
    staking: string | null;
    agentStakingContract: string | null;
    merkleDistributor: string | null;
    airdropMerkleDistributor: string | null;
    taxRecipient: string | null;
    revenueConnectWallet: string | null;
  };
  launchInfo: {
    launchMode: number | null;
    antiSniperTaxType: number | null;
    airdropPercent: number | null;
    needAcf: boolean | null;
    isProject60days: boolean | null;
    launchRadarEnabled: boolean | null;
    isRobotics: boolean | null;
    feeDelegationType: string | null;
    feeDelegationClaimed: boolean | null;
    /** Integer strings; the provider does not declare their scale. */
    initialPurchaseRaw: string | null;
    initialPurchasedAmountRaw: string | null;
    initialPairAmountRaw: string | null;
  } | null;
  genesis: {
    id: number | null;
    genesisId: string | null;
    status: string | null;
    startsAt: string | null;
    endsAt: string | null;
  } | null;
  vibesInfo: {
    status: string | null;
    vaultAddress: string | null;
    icoPoolPercentage: number | null;
    icoTargetFdv: number | null;
    icoTargetPrice: number | null;
    committedAt: string | null;
  } | null;
  cores: { coreId: number | null; name: string | null }[];
  creator: { id: number | null; walletAddress: string | null } | null;
  flags: {
    isDevCommitted: boolean | null;
    hasMarginTrading: boolean | null;
    hasFounderVideo: boolean | null;
    displayRevenue: boolean | null;
  };
  imageUrl: string | null;
  tokenomics: ConciseTokenomics;
  descriptionExcerpt: string | null;
  /** Which large free-text fields the provider sent and this projection drops. */
  omittedFreeText: string[];
  tradingRoute: VirtualsTradingRoute;
}

function projectTokenomics(agent: VirtualsAgent): ConciseTokenomics {
  const all = agent.tokenomics;
  const kept = all.slice(0, MAX_TOKENOMICS_ALLOCATIONS);
  return {
    totalSupply: agent.totalSupply,
    circulatingSupply: agent.circulatingSupply,
    allocations: kept.map((e) => ({
      name: boundedText(e.name, TOKENOMICS_ENTRY_NAME_MAX),
      amount: e.amount,
      isLocked: e.isLocked,
      startsAt: trustedIsoTimestamp(e.startsAt),
    })),
    truncated: kept.length < all.length,
    totalAllocations: all.length,
    hasUnlocked: agent.tokenomicsStatus?.hasUnlocked ?? null,
    daysFromFirstUnlock: agent.tokenomicsStatus?.daysFromFirstUnlock ?? null,
  };
}

/**
 * The large free-text blobs this projection deliberately drops, named so the
 * omission is VISIBLE (rule 05: bounded processing is reported, never silent).
 * They are marketing prose from an untrusted author, they run to multiple KB,
 * and none of them carries a decision the agent should act on.
 */
const DROPPED_FREE_TEXT: readonly (readonly [keyof VirtualsAgent, string])[] = [
  ["overview", "overview"],
  ["tokenUtility", "tokenUtility"],
  ["roadmap", "roadmap"],
  ["additionalDetails", "additionalDetails"],
];

function omittedFreeTextOf(agent: VirtualsAgent): string[] {
  return DROPPED_FREE_TEXT
    .filter(([key]) => {
      const value = agent[key];
      return typeof value === "string" && value.length > 0;
    })
    .map(([, label]) => label);
}

/** Full, injection-safe detail projection. */
export function projectVirtualsDetail(
  agent: VirtualsAgent,
  nowMs: number = Date.now(),
): DetailedVirtualsAgent {
  const fields = validateAgentFields(agent);
  return {
    ...projectVirtualsListItem(agent, nowMs),
    category: boundedText(agent.category, CATEGORY_MAX),
    level: agent.level,
    fdvInVirtual: agent.fdvInVirtual,
    liquidityUsd: agent.liquidityUsd,
    netVolume24h: agent.netVolume24h,
    volume5m: agent.volume5m,
    volume1h: agent.volume1h,
    volume6h: agent.volume6h,
    priceChangePercent5m: agent.priceChangePercent5m,
    priceChangePercent1h: agent.priceChangePercent1h,
    priceChangePercent6h: agent.priceChangePercent6h,
    holderCountPercent24h: agent.holderCountPercent24h,
    mindshare: agent.mindshare,
    totalValueLockedRaw: agent.totalValueLocked,
    graduation: {
      graduated: isGraduated(fields),
      tokenAddress: fields.tokenAddress,
      lpAddress: fields.lpAddress,
      lpCreatedAt: fields.lpCreatedAt,
      migrateTokenAddress: fields.migrateTokenAddress,
      preTokenPair: fields.preTokenPair,
    },
    addresses: {
      creatorWallet: fields.creatorWallet,
      dao: trustedAddress(agent.daoAddress),
      tokenBoundAccount: trustedAddress(agent.tbaAddress),
      veToken: trustedAddress(agent.veTokenAddress),
      staking: trustedAddress(agent.stakingAddress),
      agentStakingContract: trustedAddress(agent.agentStakingContract),
      merkleDistributor: trustedAddress(agent.merkleDistributor),
      airdropMerkleDistributor: trustedAddress(agent.airdropMerkleDistributor),
      taxRecipient: trustedAddress(agent.taxRecipient),
      revenueConnectWallet: trustedAddress(agent.revenueConnectWallet),
    },
    launchInfo: agent.launchInfo
      ? {
          launchMode: agent.launchInfo.launchMode,
          antiSniperTaxType: agent.launchInfo.antiSniperTaxType,
          airdropPercent: agent.launchInfo.airdropPercent,
          needAcf: agent.launchInfo.needAcf,
          isProject60days: agent.launchInfo.isProject60days,
          launchRadarEnabled: agent.launchInfo.launchRadarEnabled,
          isRobotics: agent.launchInfo.isRobotics,
          feeDelegationType: trustedIdentifier(agent.launchInfo.feeDelegationType, 32),
          feeDelegationClaimed: agent.launchInfo.feeDelegationClaimed,
          initialPurchaseRaw: agent.initialPurchase,
          initialPurchasedAmountRaw: agent.initialPurchasedAmount,
          initialPairAmountRaw: agent.initialPairAmount,
        }
      : null,
    genesis: agent.genesis
      ? {
          id: agent.genesis.id,
          genesisId: trustedIdentifier(agent.genesis.genesisId, 40),
          status: trustedIdentifier(agent.genesis.status, 32),
          startsAt: trustedIsoTimestamp(agent.genesis.startsAt),
          endsAt: trustedIsoTimestamp(agent.genesis.endsAt),
        }
      : null,
    vibesInfo: agent.vibesInfo
      ? {
          status: trustedIdentifier(agent.vibesInfo.status, 32),
          vaultAddress: trustedAddress(agent.vibesInfo.vaultAddress),
          icoPoolPercentage: agent.vibesInfo.icoPoolPercentage,
          icoTargetFdv: agent.vibesInfo.icoTargetFdv,
          icoTargetPrice: agent.vibesInfo.icoTargetPrice,
          committedAt: trustedIsoTimestamp(agent.vibesInfo.committedAt),
        }
      : null,
    cores: agent.cores.slice(0, MAX_CORES).map((c) => ({
      coreId: c.coreId,
      name: boundedText(c.name, CATEGORY_MAX),
    })),
    creator: agent.creator
      ? { id: agent.creator.id, walletAddress: trustedAddress(agent.creator.walletAddress) }
      : null,
    flags: {
      isDevCommitted: agent.isDevCommitted,
      hasMarginTrading: agent.hasMarginTrading,
      hasFounderVideo: agent.showFounderVideo,
      displayRevenue: agent.displayRevenue,
    },
    imageUrl: trustedHttpsUrl(agent.imageUrl),
    tokenomics: projectTokenomics(agent),
    descriptionExcerpt: boundedExcerpt(agent.description, DESCRIPTION_EXCERPT_MAX),
    omittedFreeText: omittedFreeTextOf(agent),
    tradingRoute: resolveTradingRoute(fields),
  };
}

// ── Genesis projection ──────────────────────────────────────────────

export interface ConciseGenesis {
  id: number | null;
  genesisId: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  totalParticipants: number | null;
  totalPoints: number | null;
  totalVirtuals: number | null;
  genesisAddress: string | null;
  genesisTx: string | null;
  agent: {
    id: number | null;
    name: string | null;
    symbol: string | null;
    chain: VirtualsChain | null;
    status: TrustedAgentStatus | null;
    tokenAddress: string | null;
    preToken: string | null;
    isVerified: boolean;
  } | null;
}

/** A transaction hash: 0x + 64 hex, or a Solana base58 signature. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
function trustedTxHash(raw: string | null): string | null {
  if (!raw) return null;
  return TX_HASH.test(raw) || SOLANA_SIGNATURE.test(raw) ? raw : null;
}

export function projectGenesis(genesis: VirtualsGenesis): ConciseGenesis {
  return {
    id: genesis.id,
    // Strict identifier tokens - genesis statuses (FINALIZED/CANCELLED/...) and
    // ids are machine identifiers; anything outside the shape is dropped.
    genesisId: trustedIdentifier(genesis.genesisId, 40),
    status: trustedIdentifier(genesis.status, 32),
    startsAt: trustedIsoTimestamp(genesis.startsAt),
    endsAt: trustedIsoTimestamp(genesis.endsAt),
    totalParticipants: genesis.totalParticipants,
    totalPoints: genesis.totalPoints,
    totalVirtuals: genesis.totalVirtuals,
    genesisAddress: trustedAddress(genesis.genesisAddress),
    genesisTx: trustedTxHash(genesis.genesisTx),
    agent: genesis.agent
      ? {
          id: genesis.agent.id,
          name: boundedText(genesis.agent.name, NAME_MAX),
          symbol: boundedText(genesis.agent.symbol, SYMBOL_MAX),
          chain: trustedChain(genesis.agent.chain),
          status: trustedAgentStatus(genesis.agent.status),
          tokenAddress: trustedAddress(genesis.agent.tokenAddress),
          preToken: trustedAddress(genesis.agent.preToken),
          isVerified: genesis.agent.isVerified,
        }
      : null,
  };
}
