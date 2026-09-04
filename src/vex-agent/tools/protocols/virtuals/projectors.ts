/**
 * Virtuals agent projectors - the ONLY place raw Virtuals payload becomes
 * model-facing tool output. This is a COMPLETE trust boundary:
 *
 * - STRUCTURAL fields are narrowed into TRUSTED SHAPES via `trusted-fields.ts`:
 *   chain/status/factory through closed enums (unknown ⇒ null + degrade note,
 *   never pass-through), timestamps re-serialized to canonical ISO, addresses
 *   through EVM-hex / Solana-base58 checks, genesis ids/statuses through strict
 *   identifier tokens, social URLs through an https-only strict-charset
 *   validator (invalid ⇒ dropped).
 * - FREE-TEXT fields (`name`, `symbol`, `category`, `description`, tokenomics
 *   entry names, social platform/handle) pass `sanitizeForSystemPrompt`
 *   (neutralizes fence / role-tag / chat-template escapes) AND hard length
 *   caps. `description` is reduced to a short excerpt; `overview` and
 *   `tokenUtility` (the largest free-text blobs) are DROPPED entirely.
 *
 * Numeric metrics, validated addresses, the anti-sniper window, and the
 * trading-route hint carry the decision-relevant signal the model acts on.
 */

import { sanitizeForSystemPrompt } from "@vex-agent/engine/prompts/sanitize.js";
import type { VirtualsAgent, VirtualsChain, VirtualsGenesis } from "@tools/virtuals/types.js";
import { computeAntiSniper, type AntiSniperStatus } from "./anti-sniper.js";
import {
  trustedAddress,
  trustedAgentStatus,
  trustedChain,
  trustedFactory,
  trustedHttpsUrl,
  trustedIdentifier,
  trustedIsoTimestamp,
  type TrustedAgentStatus,
  type TrustedFactory,
} from "./trusted-fields.js";

// ── Bounds ──────────────────────────────────────────────────────────

const NAME_MAX = 96;
const SYMBOL_MAX = 32;
const CATEGORY_MAX = 48;
const DESCRIPTION_EXCERPT_MAX = 280;
const TOKENOMICS_ENTRY_NAME_MAX = 48;
const MAX_TOKENOMICS_ALLOCATIONS = 6;
const MS_PER_DAY = 86_400_000;

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

/** Sanitize + reduce free-text prose to a bounded excerpt with an ellipsis. */
function boundedExcerpt(raw: string | null, maxChars: number): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const sliced = collapsed.length > maxChars ? `${collapsed.slice(0, maxChars).trimEnd()}…` : collapsed;
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
  tokenAddress: string | null;
  preToken: string | null;
  migrateTokenAddress: string | null;
  lpAddress: string | null;
  lpCreatedAt: string | null;
  createdAt: string | null;
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
    tokenAddress: keep("tokenAddress", agent.tokenAddress, trustedAddress(agent.tokenAddress)),
    preToken: keep("preToken", agent.preToken, trustedAddress(agent.preToken)),
    migrateTokenAddress: keep(
      "migrateTokenAddress",
      agent.migrateTokenAddress,
      trustedAddress(agent.migrateTokenAddress),
    ),
    lpAddress: keep("lpAddress", agent.lpAddress, trustedAddress(agent.lpAddress)),
    lpCreatedAt: keep("lpCreatedAt", agent.lpCreatedAt, trustedIsoTimestamp(agent.lpCreatedAt)),
    createdAt: keep("createdAt", agent.createdAt, trustedIsoTimestamp(agent.createdAt)),
    dropped,
  };
}

function isGraduated(fields: TrustedAgentFields): boolean {
  return fields.status === "AVAILABLE" && fields.tokenAddress !== null && fields.lpAddress !== null;
}

// ── Trading route hint ──────────────────────────────────────────────

export interface VirtualsTradingRoute {
  tradable: boolean;
  venue: string | null;
  namespace: string | null;
  quoteToken: string | null;
  quoteSymbol: "VIRTUAL";
  note?: string;
}

/**
 * Which EXISTING venue tool executes a trade for this agent. Only graduated
 * tokens route through the standard venue tools; UNDERGRAD tokens live on the
 * bonding curve and are not routable via uniswap/kyberswap/solana swaps.
 */
function resolveTradingRoute(fields: TrustedAgentFields): VirtualsTradingRoute {
  const chain = fields.chain ?? "";
  const venue = VENUE_BY_CHAIN[chain] ?? null;
  const quoteToken = VIRTUAL_TOKEN_BY_CHAIN[chain] ?? null;
  if (!isGraduated(fields)) {
    return {
      tradable: false,
      venue: null,
      namespace: null,
      quoteToken: null,
      quoteSymbol: "VIRTUAL",
      note: "Pre-graduation bonding curve - not routable via standard venue tools yet.",
    };
  }
  return {
    tradable: true,
    venue: venue?.venue ?? null,
    namespace: venue?.namespace ?? null,
    quoteToken,
    quoteSymbol: "VIRTUAL",
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
  name: string | null;
  symbol: string | null;
  chain: VirtualsChain | null;
  status: TrustedAgentStatus | null;
  isUndergrad: boolean;
  warning: string | null;
  tokenAddress: string | null;
  preToken: string | null;
  lpAddress: string | null;
  holderCount: number | null;
  top10HolderPercentage: number | null;
  mcapInVirtual: number | null;
  volume24h: number | null;
  priceChangePercent24h: number | null;
  isVerified: boolean;
  antiSniper: AntiSniperStatus;
  ageDays: number | null;
  socials: ConciseSocial[];
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

/** Concise, injection-safe list row. */
export function projectVirtualsListItem(
  agent: VirtualsAgent,
  nowMs: number = Date.now(),
): ConciseVirtualsAgent {
  const fields = validateAgentFields(agent);
  return {
    id: agent.id,
    name: boundedText(agent.name, NAME_MAX),
    symbol: boundedText(agent.symbol, SYMBOL_MAX),
    chain: fields.chain,
    status: fields.status,
    isUndergrad: fields.status === "UNDERGRAD",
    warning: composeWarning(fields),
    tokenAddress: fields.tokenAddress,
    preToken: fields.preToken,
    lpAddress: fields.lpAddress,
    holderCount: agent.holderCount,
    top10HolderPercentage: agent.top10HolderPercentage,
    mcapInVirtual: agent.mcapInVirtual,
    volume24h: agent.volume24h,
    priceChangePercent24h: agent.priceChangePercent24h,
    isVerified: agent.isVerified,
    antiSniper: computeAntiSniper(agent.launchInfo?.antiSniperTaxType ?? null, fields.lpCreatedAt, nowMs),
    ageDays: ageDaysFrom(fields.createdAt, nowMs),
    socials: projectSocials(agent),
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
}

export interface ConciseTokenomics {
  totalSupply: number | null;
  allocations: ConciseTokenomicsAllocation[];
  hasUnlocked: boolean | null;
  daysFromFirstUnlock: number | null;
}

export interface DetailedVirtualsAgent extends ConciseVirtualsAgent {
  factory: TrustedFactory | null;
  category: string | null;
  fdvInVirtual: number | null;
  liquidityUsd: number | null;
  graduation: {
    graduated: boolean;
    tokenAddress: string | null;
    lpAddress: string | null;
    lpCreatedAt: string | null;
    migrateTokenAddress: string | null;
  };
  launchInfo: {
    launchMode: number | null;
    antiSniperTaxType: number | null;
    airdropPercent: number | null;
  } | null;
  tokenomics: ConciseTokenomics;
  descriptionExcerpt: string | null;
  tradingRoute: VirtualsTradingRoute;
}

function projectTokenomics(agent: VirtualsAgent): ConciseTokenomics {
  return {
    totalSupply: agent.totalSupply,
    allocations: agent.tokenomics.slice(0, MAX_TOKENOMICS_ALLOCATIONS).map((e) => ({
      name: boundedText(e.name, TOKENOMICS_ENTRY_NAME_MAX),
      amount: e.amount,
      isLocked: e.isLocked,
    })),
    hasUnlocked: agent.tokenomicsStatus?.hasUnlocked ?? null,
    daysFromFirstUnlock: agent.tokenomicsStatus?.daysFromFirstUnlock ?? null,
  };
}

/** Full, injection-safe detail projection. */
export function projectVirtualsDetail(
  agent: VirtualsAgent,
  nowMs: number = Date.now(),
): DetailedVirtualsAgent {
  const fields = validateAgentFields(agent);
  return {
    ...projectVirtualsListItem(agent, nowMs),
    factory: fields.factory,
    category: boundedText(agent.category, CATEGORY_MAX),
    fdvInVirtual: agent.fdvInVirtual,
    liquidityUsd: agent.liquidityUsd,
    graduation: {
      graduated: isGraduated(fields),
      tokenAddress: fields.tokenAddress,
      lpAddress: fields.lpAddress,
      lpCreatedAt: fields.lpCreatedAt,
      migrateTokenAddress: fields.migrateTokenAddress,
    },
    launchInfo: agent.launchInfo
      ? {
          launchMode: agent.launchInfo.launchMode,
          antiSniperTaxType: agent.launchInfo.antiSniperTaxType,
          airdropPercent: agent.launchInfo.airdropPercent,
        }
      : null,
    tokenomics: projectTokenomics(agent),
    descriptionExcerpt: boundedExcerpt(agent.description, DESCRIPTION_EXCERPT_MAX),
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
  totalVirtuals: number | null;
  agent: {
    id: number | null;
    name: string | null;
    symbol: string | null;
    chain: VirtualsChain | null;
    status: TrustedAgentStatus | null;
    tokenAddress: string | null;
    isVerified: boolean;
  } | null;
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
    totalVirtuals: genesis.totalVirtuals,
    agent: genesis.agent
      ? {
          id: genesis.agent.id,
          name: boundedText(genesis.agent.name, NAME_MAX),
          symbol: boundedText(genesis.agent.symbol, SYMBOL_MAX),
          chain: trustedChain(genesis.agent.chain),
          status: trustedAgentStatus(genesis.agent.status),
          tokenAddress: trustedAddress(genesis.agent.tokenAddress),
          isVerified: genesis.agent.isVerified,
        }
      : null,
  };
}
