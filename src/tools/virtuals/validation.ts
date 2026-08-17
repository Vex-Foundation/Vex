/**
 * Virtuals Protocol response validators (TOLERANT — undocumented Strapi API).
 *
 * The Virtuals API is unauthenticated + undocumented and its ~90-field agent
 * payload can drift without notice. These validators are deliberately tolerant
 * (same philosophy as `dexscreener/validation/metas.ts`): a zod envelope narrows
 * the `{ data, meta }` wrapper, then pure defensive readers normalize ONLY the
 * fields the tools consume — missing / wrong-typed fields become `null` (never a
 * throw), and a non-object / non-array root degrades to "no data" so the handler
 * surfaces a clean unavailable result instead of crashing.
 *
 * All free-text is carried through RAW (see types.ts) — the protocol projector,
 * not this module, is responsible for bounding + sanitizing it before the model
 * sees it.
 */

import { z } from "zod";
import { isRecord } from "../../utils/validation-helpers.js";
import type {
  VirtualsAgent,
  VirtualsGenesesResult,
  VirtualsGenesis,
  VirtualsLaunchInfo,
  VirtualsListResult,
  VirtualsPagination,
  VirtualsSocial,
  VirtualsTokenomicsEntry,
  VirtualsTokenomicsStatus,
} from "./types.js";

// ── Field readers (defensive, null-normalizing) ────────────────────

/** Non-empty string else null. */
function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Finite number else null (rejects NaN / ±Infinity — metrics must be finite). */
function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Strict boolean else null. */
function readNullableBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

// ── Sub-shape readers ──────────────────────────────────────────────

function readLaunchInfo(raw: unknown): VirtualsLaunchInfo | null {
  if (!isRecord(raw)) return null;
  return {
    launchMode: readNumber(raw.launchMode),
    antiSniperTaxType: readNumber(raw.antiSniperTaxType),
    airdropPercent: readNumber(raw.airdropPercent),
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
    }));
}

function readTokenomicsStatus(raw: unknown): VirtualsTokenomicsStatus | null {
  if (!isRecord(raw)) return null;
  return {
    hasUnlocked: readNullableBool(raw.hasUnlocked),
    daysFromFirstUnlock: readNumber(raw.daysFromFirstUnlock),
  };
}

// ── Agent normalizer ───────────────────────────────────────────────

/** Normalize one raw agent record. Non-object → null so callers can filter. */
export function normalizeAgent(raw: unknown): VirtualsAgent | null {
  if (!isRecord(raw)) return null;
  return {
    id: readNumber(raw.id),
    name: readString(raw.name),
    symbol: readString(raw.symbol),
    chain: readString(raw.chain),
    status: readString(raw.status),
    factory: readString(raw.factory),
    category: readString(raw.category),

    tokenAddress: readString(raw.tokenAddress),
    preToken: readString(raw.preToken),
    migrateTokenAddress: readString(raw.migrateTokenAddress),
    lpAddress: readString(raw.lpAddress),
    lpCreatedAt: readString(raw.lpCreatedAt),
    createdAt: readString(raw.createdAt),

    mcapInVirtual: readNumber(raw.mcapInVirtual),
    fdvInVirtual: readNumber(raw.fdvInVirtual),
    liquidityUsd: readNumber(raw.liquidityUsd),
    volume24h: readNumber(raw.volume24h),
    priceChangePercent24h: readNumber(raw.priceChangePercent24h),
    holderCount: readNumber(raw.holderCount),
    top10HolderPercentage: readNumber(raw.top10HolderPercentage),
    totalSupply: readNumber(raw.totalSupply),

    isVerified: raw.isVerified === true,

    launchInfo: readLaunchInfo(raw.launchInfo),
    socials: readSocials(raw.socials),

    description: readString(raw.description),
    overview: readString(raw.overview),
    tokenUtility: readString(raw.tokenUtility),
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

/** `GET /api/virtuals/{id}` → one agent. Non-`{data:object}` root → null. */
export function validateVirtualDetail(raw: unknown): VirtualsAgent | null {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return null;
  return normalizeAgent(env.data.data);
}

/** `GET /api/virtuals?...` → agents + pagination. Non-`{data:array}` → empty. */
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
    totalVirtuals: readNumber(raw.totalVirtuals),
    agent: normalizeAgent(raw.virtual),
  };
}

/** `GET /api/geneses?...` → geneses + pagination. Non-`{data:array}` → empty. */
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
