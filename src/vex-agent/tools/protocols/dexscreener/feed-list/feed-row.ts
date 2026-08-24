/**
 * `AgentDexFeedRow` — the one row shape every DexScreener promotional / profile
 * feed emits, and the normalisation of five different provider shapes into it.
 *
 * WHAT THESE FEEDS ARE FOR
 *
 * They are the only endpoints in this API that surface tokens the agent has not
 * already named. `search`, `pairs`, `tokens` and `tokenPairs` all require an
 * identifier the agent must already possess; these six feeds do not. That makes
 * them the entire hunting surface, and it is why they matter far beyond their
 * "promotional" framing.
 *
 * WHAT A FEED ROW IS NOT
 *
 * It carries NO price, liquidity, volume, or pool address. A feed row is an
 * identity plus a signal, and the next call is always
 * `dexscreener.tokenPairs(chainId, tokenAddress)`. The envelope says so
 * (`PROVIDER_FEED_WINDOW_NOTE`) because a row that looks tradeable and is not is
 * how an agent ends up asserting a price it never read.
 *
 * THE UNION IS DELIBERATE
 *
 * Five provider shapes normalise into a DISCRIMINATED union rather than one wide
 * row of optional fields. `rules/03-clean-code-typescript.md` forbids optional
 * bags for domain state, and the states really are mutually exclusive: a boost
 * row has no claim date, a takeover row has no boost count, and an ad row has
 * neither. A single optional-everything row would let the projector emit
 * `claimedAt: null` on a boost feed, which reads as "this token was never claimed"
 * rather than "this feed does not report claims".
 *
 * TWO FIELDS WE HAVE BEEN PAYING FOR AND THROWING AWAY
 *
 * Both profile feeds sent `updatedAt` and `cto` on 30/30 rows when this card
 * landed (live 2026-07-27), and `validation/profiles.ts` discarded both on
 * `/token-profiles/latest/v1`. PROVIDER DRIFT, re-measured live 2026-08-21:
 * `/token-profiles/latest/v1` no longer sends `updatedAt` at all (0/30 rows;
 * `cto` still 30/30), while `/token-profiles/recent-updates/v1` still sends
 * both on 30/30. The `string | null` contract below absorbs the drift; the
 * recent-updates feed is now the only source of profile freshness. `cto` says
 * whether the project went through a community takeover — which we deleted
 * while maintaining a separate `communityTakeovers` tool to answer the same
 * question.
 *
 * `openGraph` also arrives on 30/30 rows of three feeds and is emitted NOWHERE,
 * by decision rather than oversight: its value is
 * `cdn.dexscreener.com/token-images/og/{chainId}/{tokenAddress}?timestamp=…`, a
 * pure function of two fields already on the row plus a cache-buster. It carries
 * zero information, costs ~120 B/row (~3.6 KB per call), and the model cannot see
 * an image regardless. `icon` and `header` are NOT derivable, so they survive as
 * opt-in `fields` — dropping them from the default row is what brings four of
 * these feeds down from 20-23 KB.
 */

import type {
  DexAd,
  DexBoost,
  DexCommunityTakeover,
  DexLink,
  DexProfileUpdate,
  DexTokenProfile,
  DexTrendingItem,
} from "@tools/dexscreener/types.js";

import { stripStructuralCharacters } from "../list-core/index.js";

import type { FeedFieldSelection } from "./feed-fields.js";

/** Which provider feed a row came from. Drives the projection, never a filter. */
export type FeedRowKind = "profile" | "boost" | "takeover" | "ad" | "attention";

/** Issuer-authored link, normalised. `label` is absent on most live rows. */
export interface AgentFeedLink {
  type: string | null;
  label: string | null;
  url: string;
}

/** Fields present on every feed row regardless of source. */
interface FeedRowIdentity {
  readonly chainId: string;
  readonly tokenAddress: string;
  /** Issuer-authored, delivered in FULL. Structural characters stripped only. */
  readonly description: string | null;
  readonly dexScreenerUrl: string | null;
  readonly iconUrl: string | null;
  readonly headerUrl: string | null;
  readonly links: readonly AgentFeedLink[] | null;
}

export type FeedSourceRow = FeedRowIdentity &
  (
    | {
        readonly kind: "profile";
        /**
         * ISO 8601, as the provider sends it. Provider drift measured live
         * 2026-08-21: 30/30 rows on recent-updates, 0/30 on latest (the field
         * vanished there) - hence nullable, never assumed.
         */
        readonly updatedAt: string | null;
        readonly communityTakeover: boolean | null;
      }
    | {
        readonly kind: "boost";
        /** Boost units in the most recent purchase. `null` on the whole `top` feed. */
        readonly boostCount: number | null;
        /** Cumulative active boost units. 30/30 rows on BOTH boost feeds. */
        readonly boostCountTotal: number | null;
      }
    | { readonly kind: "takeover"; readonly claimedAt: string | null }
    | {
        readonly kind: "ad";
        readonly adType: string;
        readonly adPlacedAt: string | null;
        readonly adDurationHours: number | null;
        readonly adImpressionCount: number | null;
      }
    | {
        readonly kind: "attention";
        readonly boostCount: number | null;
        readonly boostCountTotal: number | null;
        readonly hasProfile: boolean;
      }
  );

/**
 * Derived numbers shared by every feed row, so a filter and a sort cannot
 * disagree about what "fresh" means.
 */
export interface FeedRowMetrics {
  /**
   * Seconds since THE EVENT THIS FEED REPORTS — a profile update, a takeover
   * claim, an ad placement. One name across all six feeds so `sortBy` and the
   * freshness filters have one vocabulary; the provider-honest timestamp keeps
   * its own name alongside it.
   *
   * `null` on the boost feeds, which carry no timestamp of any kind, and on any
   * row whose timestamp is unparseable or in the future. An age we cannot state
   * is never an age of zero.
   */
  readonly eventAgeSeconds: number | null;
  readonly boostCount: number | null;
  readonly boostCountTotal: number | null;
  readonly adImpressionCount: number | null;
  readonly communityTakeover: boolean | null;
}

export interface FeedRow {
  readonly source: FeedSourceRow;
  readonly metrics: FeedRowMetrics;
}

/** The agent-facing row. Optional members are the `fields` opt-ins and the per-kind set. */
export interface AgentDexFeedRow {
  chainId: string;
  tokenAddress: string;
  description?: string | null;

  // Per-kind, always emitted for that kind.
  updatedAt?: string | null;
  communityTakeover?: boolean | null;
  claimedAt?: string | null;
  boostCount?: number | null;
  boostCountTotal?: number | null;
  adType?: string;
  adPlacedAt?: string | null;
  adDurationHours?: number | null;
  adImpressionCount?: number | null;
  hasProfile?: boolean;
  /** Uniform freshness. Absent on the boost feeds, which report no time at all. */
  eventAgeSeconds?: number | null;

  // Opt-in via `fields` — identical four names on every feed tool.
  dexScreenerUrl?: string | null;
  iconUrl?: string | null;
  headerUrl?: string | null;
  links?: readonly AgentFeedLink[] | null;
}

// ── Normalisation ────────────────────────────────────────────────

function displayText(value: string | null): string | null {
  return stripStructuralCharacters(value);
}

/** Empty string → `null`: the validators default `icon` to `""` when absent. */
function urlOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Issuer-authored links, kept whole.
 *
 * `label` and `type` are free text and go through the structural stripper; `url`
 * does NOT, for the same reason an address does not — silently altering a
 * destination is worse than a control character inside it, and the path is
 * enumerated in `externalContentFields` either way.
 */
function normaliseLinks(links: DexLink[] | null): readonly AgentFeedLink[] | null {
  if (!Array.isArray(links)) return null;
  return links.map((link) => ({
    type: displayText(link.type),
    label: displayText(link.label),
    url: link.url,
  }));
}

function identityOf(row: {
  chainId: string;
  tokenAddress: string;
  description: string | null;
  url: string | null;
  icon: string | null;
  header: string | null;
  links: DexLink[] | null;
}): FeedRowIdentity {
  return {
    chainId: row.chainId,
    tokenAddress: row.tokenAddress,
    description: displayText(row.description),
    dexScreenerUrl: urlOrNull(row.url),
    iconUrl: urlOrNull(row.icon),
    headerUrl: urlOrNull(row.header),
    links: normaliseLinks(row.links),
  };
}

/**
 * `/token-profiles/latest/v1` and `/token-profiles/recent-updates/v1`.
 *
 * ONE normaliser for both, because both feeds send the same ten fields — which is
 * the finding that made `updatedAt`/`cto` recoverable on the `latest` feed at all.
 * They are NOT the same data: measured 2026-07-27, the two 30-row windows shared
 * only 3 tokens, so neither is a superset of the other and both are worth calling.
 */
export function toProfileFeedRow(profile: DexTokenProfile | DexProfileUpdate): FeedSourceRow {
  const update = profile as Partial<DexProfileUpdate>;
  return {
    kind: "profile",
    ...identityOf(profile),
    updatedAt: typeof update.updatedAt === "string" ? update.updatedAt : null,
    communityTakeover: typeof update.cto === "boolean" ? update.cto : null,
  };
}

/** `/token-boosts/latest/v1` and `/token-boosts/top/v1`. */
export function toBoostFeedRow(boost: DexBoost): FeedSourceRow {
  return {
    kind: "boost",
    ...identityOf(boost),
    boostCount: boost.amount,
    boostCountTotal: boost.totalAmount,
  };
}

/** `/community-takeovers/latest/v1`. */
export function toTakeoverFeedRow(takeover: DexCommunityTakeover): FeedSourceRow {
  return {
    kind: "takeover",
    ...identityOf(takeover),
    claimedAt: typeof takeover.claimDate === "string" ? takeover.claimDate : null,
  };
}

/**
 * `/ads/latest/v1`.
 *
 * Ads carry no `description`, `icon`, `header` or `links` at all — the row is
 * identity plus placement metadata. Those fields normalise to `null` rather than
 * being omitted, so `fields: "links"` behaves the same on every feed tool.
 */
export function toAdFeedRow(ad: DexAd): FeedSourceRow {
  return {
    kind: "ad",
    ...identityOf({
      chainId: ad.chainId,
      tokenAddress: ad.tokenAddress,
      description: null,
      url: ad.url,
      icon: null,
      header: null,
      links: null,
    }),
    adType: ad.type,
    adPlacedAt: typeof ad.date === "string" ? ad.date : null,
    adDurationHours: ad.durationHours,
    adImpressionCount: ad.impressions,
  };
}

/** The synthetic profiles×boosts merge behind `dexscreener.attention`. */
export function toAttentionFeedRow(item: DexTrendingItem): FeedSourceRow {
  return {
    kind: "attention",
    ...identityOf({
      chainId: item.chainId,
      tokenAddress: item.tokenAddress,
      description: item.description,
      url: item.url,
      icon: item.icon,
      header: item.header,
      links: item.links,
    }),
    boostCount: item.boostAmount,
    boostCountTotal: item.boostTotalAmount,
    hasProfile: item.hasProfile,
  };
}

// ── Metrics ──────────────────────────────────────────────────────

/** ISO 8601 → age in whole seconds, or `null` when it cannot be stated. */
function ageSecondsFromIso(iso: string | null, asOfMs: number): number | null {
  if (iso === null) return null;
  const parsedMs = Date.parse(iso);
  if (!Number.isFinite(parsedMs)) return null;
  const elapsedMs = asOfMs - parsedMs;
  if (elapsedMs < 0) return null;
  return Math.floor(elapsedMs / 1000);
}

/** The event timestamp for each kind. Boost feeds report none. */
function eventTimestampOf(source: FeedSourceRow): string | null {
  switch (source.kind) {
    case "profile":
      return source.updatedAt;
    case "takeover":
      return source.claimedAt;
    case "ad":
      return source.adPlacedAt;
    case "boost":
    case "attention":
      return null;
  }
}

export function computeFeedRowMetrics(source: FeedSourceRow, asOfMs: number): FeedRowMetrics {
  const hasBoost = source.kind === "boost" || source.kind === "attention";
  return {
    eventAgeSeconds: ageSecondsFromIso(eventTimestampOf(source), asOfMs),
    boostCount: hasBoost ? source.boostCount : null,
    boostCountTotal: hasBoost ? source.boostCountTotal : null,
    adImpressionCount: source.kind === "ad" ? source.adImpressionCount : null,
    communityTakeover: source.kind === "profile" ? source.communityTakeover : null,
  };
}

/** Pair a normalised provider row with its derived numbers. */
export function toFeedRows(sources: readonly FeedSourceRow[], asOfMs: number): FeedRow[] {
  return sources.map((source) => ({ source, metrics: computeFeedRowMetrics(source, asOfMs) }));
}

// ── Projection ───────────────────────────────────────────────────

/**
 * Project one feed row for the agent.
 *
 * The per-kind fields are always emitted for their kind — they are the SIGNAL,
 * they are a few bytes each, and making them opt-in would mean a `boosts` call
 * with default params returned no boost counts. The four opt-ins are the same
 * four names on every feed tool: two CDN images the model cannot see, the human
 * DexScreener link, and the issuer's link list.
 */
export function projectAgentFeedRow(
  row: FeedRow,
  fields: FeedFieldSelection,
): AgentDexFeedRow {
  const { source, metrics } = row;
  const projected: AgentDexFeedRow = {
    chainId: source.chainId,
    tokenAddress: source.tokenAddress,
  };

  if (fields.has("description")) projected.description = source.description;

  switch (source.kind) {
    case "profile":
      projected.updatedAt = source.updatedAt;
      projected.eventAgeSeconds = metrics.eventAgeSeconds;
      projected.communityTakeover = source.communityTakeover;
      break;
    case "boost":
      projected.boostCount = source.boostCount;
      projected.boostCountTotal = source.boostCountTotal;
      break;
    case "takeover":
      projected.claimedAt = source.claimedAt;
      projected.eventAgeSeconds = metrics.eventAgeSeconds;
      break;
    case "ad":
      projected.adType = source.adType;
      projected.adPlacedAt = source.adPlacedAt;
      projected.eventAgeSeconds = metrics.eventAgeSeconds;
      projected.adDurationHours = source.adDurationHours;
      projected.adImpressionCount = source.adImpressionCount;
      break;
    case "attention":
      projected.boostCount = source.boostCount;
      projected.boostCountTotal = source.boostCountTotal;
      projected.hasProfile = source.hasProfile;
      break;
  }

  if (fields.has("dexScreenerUrl")) projected.dexScreenerUrl = source.dexScreenerUrl;
  if (fields.has("iconUrl")) projected.iconUrl = source.iconUrl;
  if (fields.has("headerUrl")) projected.headerUrl = source.headerUrl;
  if (fields.has("links")) projected.links = source.links;

  return projected;
}
