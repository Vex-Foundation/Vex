/**
 * Virtuals Protocol response validators (TOLERANT - undocumented Strapi API).
 *
 * The Virtuals API is unauthenticated + undocumented and its 84-field agent
 * payload drifts without notice. These validators are deliberately tolerant
 * (same philosophy as `dexscreener/validation/metas.ts`): a zod envelope narrows
 * the `{ data, meta }` wrapper, then pure defensive readers normalize the fields
 * the tools consume - missing / wrong-typed fields become `null` (never a
 * throw), and a non-object / non-array root degrades to "no data" so the handler
 * surfaces a clean unavailable result instead of crashing.
 *
 * TWO RULES THIS MODULE ENFORCES AT THE BOUNDARY, not downstream:
 *
 * 1. PII IS DROPPED HERE. `creator.email` (masked, but still a partial address)
 *    and `creator.username` (a Privy DID) never enter the domain shape, so no
 *    later change can leak them into a projection, a log or a prompt. Only the
 *    creator's numeric id and public wallet address survive.
 * 2. INTEGER-STRING MONEY FIELDS STAY STRINGS. `virtualTokenValue`,
 *    `totalValueLocked` and the three `initialPurchase*` fields are validated
 *    as decimal integers and carried verbatim; they are never parsed into a
 *    JS number (rule 90: never floating point for token amounts).
 *
 * All free-text is carried through RAW (see types.ts) - the protocol projector,
 * not this module, bounds and sanitizes it before the model sees it.
 */

import { z } from "zod";
import { isRecord } from "../../utils/validation-helpers.js";
import type {
  VirtualsAgent,
  VirtualsAgentGenesisRef,
  VirtualsCore,
  VirtualsCreator,
  VirtualsGenesesResult,
  VirtualsGenesis,
  VirtualsGenesisParameters,
  VirtualsLaunchInfo,
  VirtualsListResult,
  VirtualsPagination,
  VirtualsPricePoint,
  VirtualsSocial,
  VirtualsTokenomicsEntry,
  VirtualsTokenomicsStatus,
  VirtualsVibesInfo,
} from "./types.js";

// ── Field readers (defensive, null-normalizing) ────────────────────

/** Non-empty string else null. */
function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Finite number else null (rejects NaN / +-Infinity - metrics must be finite). */
function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Strict boolean else null. */
function readNullableBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * A decimal integer string, kept VERBATIM. Accepts an optional sign and any
 * length (these are raw on-chain scales), rejects decimals, exponents and
 * whitespace. A number arriving where a string was measured is accepted only
 * when it is a safe integer, and is re-serialised without exponent notation;
 * anything else is dropped rather than silently rounded.
 */
const INTEGER_STRING = /^-?\d{1,80}$/;
export function readIntegerString(v: unknown): string | null {
  if (typeof v === "string") return INTEGER_STRING.test(v) ? v : null;
  if (typeof v === "number") {
    return Number.isSafeInteger(v) ? String(v) : null;
  }
  return null;
}

// ── Sub-shape readers ──────────────────────────────────────────────

function readLaunchInfo(raw: unknown): VirtualsLaunchInfo | null {
  if (!isRecord(raw)) return null;
  return {
    launchMode: readNumber(raw.launchMode),
    antiSniperTaxType: readNumber(raw.antiSniperTaxType),
    airdropPercent: readNumber(raw.airdropPercent),
    needAcf: readNullableBool(raw.needAcf),
    isProject60days: readNullableBool(raw.isProject60days),
    launchRadarEnabled: readNullableBool(raw.launchRadarEnabled),
    isRobotics: readNullableBool(raw.isRobotics),
    feeDelegationType: readString(raw.feeDelegationType),
    feeDelegatedRecipient: readString(raw.feeDelegatedRecipient),
    feeDelegationVaultAddress: readString(raw.feeDelegationVaultAddress),
    feeDelegationClaimed: readNullableBool(raw.feeDelegationClaimed),
  };
}

/**
 * Verified socials only (impersonation-resistant). The API shape is
 * `{ VERIFIED_LINKS: { TWITTER: url }, VERIFIED_USERNAMES: { TWITTER: handle } }`.
 * Keyed off VERIFIED_USERNAMES (the handles); URL attached from VERIFIED_LINKS.
 * Capped so a hostile payload cannot balloon the output.
 */
const MAX_SOCIALS = 8;
function readSocials(raw: unknown): VirtualsSocial[] {
  if (!isRecord(raw)) return [];
  const usernames = isRecord(raw.VERIFIED_USERNAMES) ? raw.VERIFIED_USERNAMES : {};
  const links = isRecord(raw.VERIFIED_LINKS) ? raw.VERIFIED_LINKS : {};
  const out: VirtualsSocial[] = [];
  for (const [platform, handle] of Object.entries(usernames)) {
    if (typeof platform !== "string" || platform.length === 0) continue;
    if (typeof handle !== "string" || handle.length === 0) continue;
    const rawUrl = links[platform];
    out.push({
      platform,
      handle,
      url: typeof rawUrl === "string" && rawUrl.length > 0 ? rawUrl : null,
    });
    if (out.length >= MAX_SOCIALS) break;
  }
  return out;
}

const MAX_TOKENOMICS = 32;
function readTokenomics(raw: unknown): VirtualsTokenomicsEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .slice(0, MAX_TOKENOMICS)
    .map((e) => ({
      name: readString(e.name),
      amount: readNumber(e.amount),
      isLocked: readNullableBool(e.isLocked),
      startsAt: readString(e.startsAt),
    }));
}

function readTokenomicsStatus(raw: unknown): VirtualsTokenomicsStatus | null {
  if (!isRecord(raw)) return null;
  return {
    hasUnlocked: readNullableBool(raw.hasUnlocked),
    daysFromFirstUnlock: readNumber(raw.daysFromFirstUnlock),
  };
}

const MAX_CORES = 16;
function readCores(raw: unknown): VirtualsCore[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .slice(0, MAX_CORES)
    .map((c) => ({ coreId: readNumber(c.coreId), name: readString(c.name) }));
}

/**
 * The creator, with `email` and `username` REFUSED ENTRY (see the module
 * header). The wallet lives one level down in `userSocials[0].walletAddress`.
 */
function readCreator(raw: unknown): VirtualsCreator | null {
  if (!isRecord(raw)) return null;
  const socials = Array.isArray(raw.userSocials) ? raw.userSocials : [];
  const first = socials.find(isRecord);
  return {
    id: readNumber(raw.id),
    walletAddress: first ? readString(first.walletAddress) : null,
  };
}

function readVibesInfo(raw: unknown): VirtualsVibesInfo | null {
  if (!isRecord(raw)) return null;
  return {
    status: readString(raw.status),
    vaultAddress: readString(raw.vaultAddress),
    icoWalletAddress: readString(raw.icoWalletAddress),
    icoPoolPercentage: readNumber(raw.icoPoolPercentage),
    icoTargetFdv: readNumber(raw.icoTargetFdv),
    icoTargetPrice: readNumber(raw.icoTargetPrice),
    icoTotalTokenAmount: readNumber(raw.icoTotalTokenAmount),
    committedAt: readString(raw.committedAt),
    expectedRuggedAt: readString(raw.expectedRuggedAt),
  };
}

function readAgentGenesisRef(raw: unknown): VirtualsAgentGenesisRef | null {
  if (!isRecord(raw)) return null;
  return {
    id: readNumber(raw.id),
    genesisId: readString(raw.genesisId),
    status: readString(raw.status),
    startsAt: readString(raw.startsAt),
    endsAt: readString(raw.endsAt),
  };
}

/**
 * The `sparkline` array: `[{ timestamp, price }]` with unix SECONDS.
 *
 * DELIBERATELY UNBOUNDED HERE. The obvious move is a cap, and it is the wrong
 * one twice over: the whole response is already a parsed JS array by the time
 * this runs, so a cap saves no memory, and a cap that keeps the FIRST n points
 * silently discards the NEWEST ones - the only ones a price series is read for.
 * The single bounded-and-REPORTED cut lives in the projector
 * (`protocols/virtuals/projectors.ts`), which keeps the newest points and says
 * in its own output how many it dropped and out of how many.
 */
function readSparkline(raw: unknown): VirtualsPricePoint[] | null {
  if (!Array.isArray(raw)) return null;
  const out: VirtualsPricePoint[] = [];
  for (const point of raw) {
    if (!isRecord(point)) continue;
    const timestampSeconds = readNumber(point.timestamp);
    const price = readNumber(point.price);
    if (timestampSeconds === null || price === null) continue;
    out.push({ timestampSeconds, price });
  }
  return out;
}

/** `[low, high]`, both finite, low first. Anything else degrades to null. */
function readRange24h(raw: unknown): readonly [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const low = readNumber(raw[0]);
  const high = readNumber(raw[1]);
  if (low === null || high === null) return null;
  return low <= high ? [low, high] : [high, low];
}

/** The `image` relation, which arrives either as `{ url }` or as a full asset. */
function readImageUrl(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return readString(raw.url);
}

// ── Agent normalizer ───────────────────────────────────────────────

/** Normalize one raw agent record. Non-object -> null so callers can filter. */
export function normalizeAgent(raw: unknown): VirtualsAgent | null {
  if (!isRecord(raw)) return null;
  return {
    id: readNumber(raw.id),
    uid: readString(raw.uid),
    virtualId: readString(raw.virtualId),
    name: readString(raw.name),
    symbol: readString(raw.symbol),
    chain: readString(raw.chain),
    status: readString(raw.status),
    factory: readString(raw.factory),
    category: readString(raw.category),
    role: readString(raw.role),
    level: readNumber(raw.level),

    tokenAddress: readString(raw.tokenAddress),
    preToken: readString(raw.preToken),
    preTokenPair: readString(raw.preTokenPair),
    migrateTokenAddress: readString(raw.migrateTokenAddress),
    lpAddress: readString(raw.lpAddress),
    walletAddress: readString(raw.walletAddress),
    daoAddress: readString(raw.daoAddress),
    tbaAddress: readString(raw.tbaAddress),
    veTokenAddress: readString(raw.veTokenAddress),
    sentientWalletAddress: readString(raw.sentientWalletAddress),
    stakingAddress: readString(raw.stakingAddress),
    agentStakingContract: readString(raw.agentStakingContract),
    merkleDistributor: readString(raw.merkleDistributor),
    airdropMerkleDistributor: readString(raw.airdropMerkleDistributor),
    taxRecipient: readString(raw.taxRecipient),
    revenueConnectWallet: readString(raw.revenueConnectWallet),
    usdcV3PoolAddress: readString(raw.usdcV3PoolAddress),

    createdAt: readString(raw.createdAt),
    launchedAt: readString(raw.launchedAt),
    lpCreatedAt: readString(raw.lpCreatedAt),

    mcapInVirtual: readNumber(raw.mcapInVirtual),
    fdvInVirtual: readNumber(raw.fdvInVirtual),
    liquidityUsd: readNumber(raw.liquidityUsd),
    volume5m: readNumber(raw.volume5m),
    volume1h: readNumber(raw.volume1h),
    volume6h: readNumber(raw.volume6h),
    volume24h: readNumber(raw.volume24h),
    netVolume24h: readNumber(raw.netVolume24h),
    virtualsPoolVol5m: readNumber(raw.virtualsPoolVol5m),
    virtualsPoolVol1h: readNumber(raw.virtualsPoolVol1h),
    virtualsPoolVol6h: readNumber(raw.virtualsPoolVol6h),
    virtualsPoolVol24h: readNumber(raw.virtualsPoolVol24h),
    priceChangePercent5m: readNumber(raw.priceChangePercent5m),
    priceChangePercent1h: readNumber(raw.priceChangePercent1h),
    priceChangePercent6h: readNumber(raw.priceChangePercent6h),
    priceChangePercent24h: readNumber(raw.priceChangePercent24h),
    holderCount: readNumber(raw.holderCount),
    holderCountPercent24h: readNumber(raw.holderCountPercent24h),
    top10HolderPercentage: readNumber(raw.top10HolderPercentage),
    devHoldingPercentage: readNumber(raw.devHoldingPercentage),
    mindshare: readNumber(raw.mindshare),
    totalSupply: readNumber(raw.totalSupply),
    circulatingSupply: readNumber(raw.circulatingSupply),

    virtualTokenValue: readIntegerString(raw.virtualTokenValue),
    totalValueLocked: readIntegerString(raw.totalValueLocked),
    initialPurchase: readIntegerString(raw.initialPurchase),
    initialPurchasedAmount: readIntegerString(raw.initialPurchasedAmount),
    initialPairAmount: readIntegerString(raw.initialPairAmount),

    isVerified: raw.isVerified === true,
    isDevCommitted: readNullableBool(raw.isDevCommitted),
    hasMarginTrading: readNullableBool(raw.hasMarginTrading),
    showFounderVideo: readNullableBool(raw.showFounderVideo),
    displayRevenue: readNullableBool(raw.displayRevenue),
    allowUpdateLaunchDate: readNullableBool(raw.allowUpdateLaunchDate),
    shouldDisplayLaunchTime: readNullableBool(raw.shouldDisplayLaunchTime),
    isDelegatedOwner: readNullableBool(raw.isDelegatedOwner),

    acpAgentId: readString(raw.acpAgentId),
    v3AcpAgentId: readString(raw.v3AcpAgentId),

    imageUrl: readImageUrl(raw.image),
    cores: readCores(raw.cores),
    creator: readCreator(raw.creator),
    genesis: readAgentGenesisRef(raw.genesis),
    vibesInfo: readVibesInfo(raw.vibesInfo),
    launchInfo: readLaunchInfo(raw.launchInfo),
    socials: readSocials(raw.socials),

    sparkline: readSparkline(raw.sparkline),
    range24h: readRange24h(raw.range24h),

    description: readString(raw.description),
    overview: readString(raw.overview),
    tokenUtility: readString(raw.tokenUtility),
    roadmap: readString(raw.roadmap),
    additionalDetails: readString(raw.additionalDetails),
    tokenomics: readTokenomics(raw.tokenomics),
    tokenomicsStatus: readTokenomicsStatus(raw.tokenomicsStatus),
  };
}

// ── Envelope (zod narrows the Strapi wrapper) ──────────────────────

const envelopeSchema = z
  .object({ data: z.unknown().optional(), meta: z.unknown().optional() })
  .passthrough();

function readPagination(meta: unknown): VirtualsPagination | null {
  if (!isRecord(meta)) return null;
  const p = meta.pagination;
  if (!isRecord(p)) return null;
  return {
    page: readNumber(p.page),
    pageSize: readNumber(p.pageSize),
    pageCount: readNumber(p.pageCount),
    total: readNumber(p.total),
  };
}

// ── Public validators ──────────────────────────────────────────────

/** `GET /api/virtuals/{id}` -> one agent. Non-`{data:object}` root -> null. */
export function validateVirtualDetail(raw: unknown): VirtualsAgent | null {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return null;
  return normalizeAgent(env.data.data);
}

/** `GET /api/virtuals?...` -> agents + pagination. Non-`{data:array}` -> empty. */
export function validateVirtualsList(raw: unknown): VirtualsListResult {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success || !Array.isArray(env.data.data)) {
    return { agents: [], pagination: null };
  }
  const agents = env.data.data
    .map(normalizeAgent)
    .filter((a): a is VirtualsAgent => a !== null);
  return { agents, pagination: readPagination(env.data.meta) };
}

function normalizeGenesis(raw: unknown): VirtualsGenesis | null {
  if (!isRecord(raw)) return null;
  return {
    id: readNumber(raw.id),
    genesisId: readString(raw.genesisId),
    status: readString(raw.status),
    startsAt: readString(raw.startsAt),
    endsAt: readString(raw.endsAt),
    totalParticipants: readNumber(raw.totalParticipants),
    totalPoints: readNumber(raw.totalPoints),
    totalVirtuals: readNumber(raw.totalVirtuals),
    genesisAddress: readString(raw.genesisAddress),
    genesisTx: readString(raw.genesisTx),
    agent: normalizeAgent(raw.virtual),
  };
}

/** `GET /api/geneses?...` -> geneses + pagination. Non-`{data:array}` -> empty. */
export function validateGeneses(raw: unknown): VirtualsGenesesResult {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success || !Array.isArray(env.data.data)) {
    return { geneses: [], pagination: null };
  }
  const geneses = env.data.data
    .map(normalizeGenesis)
    .filter((g): g is VirtualsGenesis => g !== null);
  return { geneses, pagination: readPagination(env.data.meta) };
}

/**
 * `GET /api/geneses/parameters` -> `{ data: { reserveAmountTiers: number[] } }`.
 * An unreadable payload degrades to an EMPTY tier list, which the handler
 * reports as "the provider did not state the tiers" rather than inventing them.
 */
export function validateGenesisParameters(raw: unknown): VirtualsGenesisParameters {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success || !isRecord(env.data.data)) return { reserveAmountTiers: [] };
  const tiers = env.data.data.reserveAmountTiers;
  if (!Array.isArray(tiers)) return { reserveAmountTiers: [] };
  return {
    reserveAmountTiers: tiers
      .map(readNumber)
      .filter((n): n is number => n !== null),
  };
}
