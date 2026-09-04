/**
 * Virtuals Protocol API vocabulary and domain shapes.
 *
 * The Virtuals API (https://api.virtuals.io) is an UNAUTHENTICATED, UNDOCUMENTED
 * Strapi backend. Its agent row carries 84 fields and can drift without notice,
 * so nothing here is a wire type: these are the NORMALIZED, tolerant domain
 * shapes `validation.ts` produces, and the CLOSED vocabularies `client.ts`
 * serialises into `filters[...]` / `sort[n]`.
 *
 * EVERY vocabulary below was MEASURED, not transcribed. The provenance is
 * `src/tools/virtuals/Virtuals.md`, which names the capture file behind each
 * value. The measurement that shapes the whole module: the API SILENTLY IGNORES
 * an unknown `filters[...]` key and returns the unfiltered population
 * (`f_bogus` -> the full 56,915 rows), and returns ZERO rows for an unknown
 * value inside a known key (`factory_bogus`, `role_bogus`, `cat_bogus`,
 * `vibes_bogus`). Both failure modes are invisible at the call site, which is
 * why every value the client can emit is a closed set held here.
 *
 * Free-text fields (`description`, `overview`, `tokenUtility`, `roadmap`,
 * tokenomics entry names, socials) are prompt-injection surface. They are
 * carried RAW for the protocol projector to bound + sanitize (or drop); they
 * MUST NOT reach the model without `sanitizeForSystemPrompt` and a length cap.
 */

// ── Chain enum (server-side filter values - EXACTLY these four) ─────

export const VIRTUALS_CHAINS = ["BASE", "SOLANA", "ROBINHOOD", "ETH"] as const;
export type VirtualsChain = (typeof VIRTUALS_CHAINS)[number];

// ── Status: NUMERIC, bare, or nothing (measured) ────────────────────

/**
 * `filters[status]` is the one filter with a documented-looking string form
 * that does NOTHING. Measured on BASE (56,915 rows in the population):
 *
 *   filters[status]=1                    -> 55,764   UNDERGRAD (on the curve)
 *   filters[status]=2                    -> 956      AVAILABLE (graduated)
 *   filters[status]=4                    -> 195      GENESIS (Base-only: the
 *                                          same 195 rows come back with no
 *                                          chain filter at all)
 *   filters[status]=AVAILABLE            -> 56,915   IGNORED
 *   filters[status]=UNDERGRAD            -> 56,915   IGNORED
 *   filters[status][$eq]=AVAILABLE       -> 56,915   IGNORED
 *   filters[status][$eq]=2               -> 56,915   IGNORED (operators too)
 *   filters[status][$in][0..1]=1,2       -> 56,915   IGNORED
 *   filters[status]=3 / 6 / 7            -> 56,915   IGNORED (no-op codes)
 *   filters[status]=0                    -> HTTP 401 Unauthorized
 *
 * So: the BARE numeric form is the only one that filters, 1/2/4 are the only
 * codes with a measured meaning, and 3/5/6/7 are recorded in `Virtuals.md` as
 * measured-but-unexplained and deliberately NOT exposed.
 */
export const VIRTUALS_STATUS_CODES = {
  /** On the bonding curve. */
  undergrad: 1,
  /** Graduated to an AMM pool. The model-facing spelling stays `graduated`. */
  graduated: 2,
  /** In a genesis points sale. */
  genesis: 4,
} as const;

export type VirtualsStatusFilter = keyof typeof VIRTUALS_STATUS_CODES;
export const VIRTUALS_STATUS_FILTERS = Object.keys(
  VIRTUALS_STATUS_CODES,
) as readonly VirtualsStatusFilter[];

/** The row's own `status` string, which IS returned even though it cannot filter. */
export const VIRTUALS_ROW_STATUSES = [
  "DRAFT",
  "GENESIS",
  "UNDERGRAD",
  "AVAILABLE",
  "INITIALIZED",
  "PROCESSING",
  "REJECTED",
] as const;
export type VirtualsRowStatus = (typeof VIRTUALS_ROW_STATUSES)[number];

// ── Factory (13 members, from the app bundle, each probed live) ─────

/**
 * Read out of `virtual.api-DGEEKqdb.js` in the app.virtuals.io bundle and then
 * sent live one by one. BASE row counts on 2026-09-04:
 * ERC20 30, BONDING 15,326, BONDING_V2 112, BONDING_V3 3, BONDING_V4 21,630,
 * BONDING_V5 19,473, ERC20_PRO 4, VIBES_BONDING_V2 47, SOL_METEORA 0
 * (98 on SOLANA), and all four ROBOTIC_* members 0.
 *
 * ROBOTIC NORMALISATION. The bundle emits `ROBOTIC_*` as QUERY values and then
 * rewrites the rows it gets back to the plain factory plus `isRobotics: true`.
 * Live, every `ROBOTIC_*` value returns zero rows on BASE while
 * `launchInfo.isRobotics=true` returns 520, so the stored factory is the plain
 * one and robotics is a `launchInfo` flag. The members stay in this enum
 * because they are legal wire values, and the tool surfaces `isRobotics` as the
 * filter that actually works; `Virtuals.md` records the measurement.
 */
export const VIRTUALS_FACTORIES = [
  "ERC20",
  "BONDING",
  "BONDING_V2",
  "BONDING_V3",
  "BONDING_V4",
  "BONDING_V5",
  "ERC20_PRO",
  "ROBOTIC_BONDING_V2",
  "ROBOTIC_BONDING_V3",
  "ROBOTIC_BONDING_V4",
  "ROBOTIC_ERC20_PRO",
  "VIBES_BONDING_V2",
  "SOL_METEORA",
] as const;
export type VirtualsFactory = (typeof VIRTUALS_FACTORIES)[number];

/** `OLD` appears on legacy ROWS but is not a legal FILTER value (0 rows live). */
export const VIRTUALS_ROW_ONLY_FACTORIES = ["OLD"] as const;

// ── Role and category (measured value sets) ─────────────────────────

/**
 * Sampled from 10,000 BASE rows: ENTERTAINMENT 194, INFORMATION 121,
 * ON_CHAIN 117, PRODUCTIVITY 92, CREATIVE 65, empty/null 9,410 (plus one
 * mixed-case `Information`, which the provider stores unnormalised). Live
 * counts for the whole chain: ON_CHAIN 3,392. `AGENT` and any unknown value
 * return zero rows, so this set is closed at our boundary.
 */
export const VIRTUALS_ROLES = [
  "ENTERTAINMENT",
  "INFORMATION",
  "ON_CHAIN",
  "PRODUCTIVITY",
  "CREATIVE",
] as const;
export type VirtualsRole = (typeof VIRTUALS_ROLES)[number];

/**
 * `category` is two different things at once. Rows carry a descriptive value
 * (`IP MIRROR` on 9,997 of 10,000 sampled rows, `FUNCTIONAL` on 3), while the
 * app uses the SAME key to include or exclude the two launch tags
 * (`X_LAUNCH`, `ACP_LAUNCH`; `filters[category]=X_LAUNCH` -> 60 rows on BASE).
 * The tool exposes the launch tags through `includeLaunchX` / `excludeLaunchX`
 * (the app's own semantics) rather than a raw string, so a caller cannot spell
 * a value that silently matches nothing.
 */
export const VIRTUALS_LAUNCH_TAG_CATEGORIES = ["X_LAUNCH", "ACP_LAUNCH"] as const;

// ── Sort (26 sortable attributes, machine-verified) ─────────────────

/**
 * Every member below was accepted live in a `sort[n]=<field>:desc` probe;
 * `totalSupply` and `zzzNotAField` were REFUSED with the provider's own
 * sentence, which is what the table test pins:
 *
 *   400 "Attribute totalSupply not found on model api::virtual.virtual"
 *   400 "Attribute zzzNotAField not found on model api::virtual.virtual"
 *
 * So the provider validates the sort ATTRIBUTE but not the DIRECTION: an
 * unknown attribute is a 400, a missing direction is a 400
 * ("Cannot read properties of undefined (reading 'toLowerCase')"), and a
 * NONSENSE direction (`holderCount:sideways`) is accepted and silently treated
 * as `desc`. That last one is why `sortDirection` is a closed enum here.
 */
export const VIRTUALS_SORT_FIELDS = [
  "circulatingSupply",
  "createdAt",
  "devHoldingPercentage",
  "fdvInVirtual",
  "holderCount",
  "holderCountPercent24h",
  "launchedAt",
  "level",
  "liquidityUsd",
  "lpCreatedAt",
  "mcapInVirtual",
  "mindshare",
  "netVolume24h",
  "priceChangePercent1h",
  "priceChangePercent5m",
  "priceChangePercent6h",
  "priceChangePercent24h",
  "top10HolderPercentage",
  "totalValueLocked",
  "updatedAt",
  "virtualTokenValue",
  "virtualsPoolVol24h",
  "volume1h",
  "volume5m",
  "volume6h",
  "volume24h",
] as const;
export type VirtualsSortField = (typeof VIRTUALS_SORT_FIELDS)[number];

/** Refused live, and pinned by a table test so it cannot creep back in. */
export const VIRTUALS_NON_SORTABLE_FIELDS = ["totalSupply"] as const;

export const VIRTUALS_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type VirtualsSortDirection = (typeof VIRTUALS_SORT_DIRECTIONS)[number];

/** How a caller spells the address search. Mirrors the app's `searchScope`. */
export const VIRTUALS_SEARCH_SCOPES = ["text", "address", "any"] as const;
export type VirtualsSearchScope = (typeof VIRTUALS_SEARCH_SCOPES)[number];

/** The only `vibesInfo.status` the app filters on; anything else returns 0 rows. */
export const VIRTUALS_VIBES_STATUSES = ["PRECOMMIT"] as const;
export type VirtualsVibesStatus = (typeof VIRTUALS_VIBES_STATUSES)[number];

/**
 * Genesis lifecycle. FINALIZED (145) and CANCELLED (33) were counted live on
 * 2026-09-04; FAILED, PREPROCESSING, PROCESSING and STARTED come from the app
 * bundle's own equality checks and each returned a valid (currently empty)
 * response. An unknown value returns zero rows with no 400, which is why the
 * set is closed here.
 */
export const VIRTUALS_GENESIS_STATUSES = [
  "CANCELLED",
  "FAILED",
  "FINALIZED",
  "PREPROCESSING",
  "PROCESSING",
  "STARTED",
] as const;
export type VirtualsGenesisStatus = (typeof VIRTUALS_GENESIS_STATUSES)[number];

export const VIRTUALS_GENESIS_SORT_FIELDS = ["id", "startsAt", "endsAt"] as const;
export type VirtualsGenesisSortField = (typeof VIRTUALS_GENESIS_SORT_FIELDS)[number];

// ── Sub-shapes ─────────────────────────────────────────────────────

/** The full `launchInfo` object, every field the provider sends. */
export interface VirtualsLaunchInfo {
  launchMode: number | null;
  /** 0-5; see `protocols/virtuals/anti-sniper.ts` for the contract semantics. */
  antiSniperTaxType: number | null;
  airdropPercent: number | null;
  /** Automated Capital Formation: the 10 VIRTUAL launch-fee option. */
  needAcf: boolean | null;
  isProject60days: boolean | null;
  launchRadarEnabled: boolean | null;
  isRobotics: boolean | null;
  feeDelegationType: string | null;
  feeDelegatedRecipient: string | null;
  feeDelegationVaultAddress: string | null;
  feeDelegationClaimed: boolean | null;
}

/** One verified social handle (impersonation-resistant "VERIFIED_*" only). */
export interface VirtualsSocial {
  platform: string;
  handle: string;
  url: string | null;
}

/** One tokenomics vesting allocation (names are free-text, sanitized downstream). */
export interface VirtualsTokenomicsEntry {
  name: string | null;
  amount: number | null;
  isLocked: boolean | null;
  startsAt: string | null;
}

export interface VirtualsTokenomicsStatus {
  hasUnlocked: boolean | null;
  daysFromFirstUnlock: number | null;
}

/** One agent capability slot ("Cognitive Core", coreId 0, ...). */
export interface VirtualsCore {
  coreId: number | null;
  name: string | null;
}

/**
 * The creator, REDUCED AT THE BOUNDARY. The provider sends
 * `{ username: "did:privy:...", email: "cm***mk@p***.com", displayName,
 *   socials, socialCount, id, userSocials: [{ walletAddress }], avatar }`.
 * `email` (masked but still a partial address) and `username` (the Privy DID,
 * an account identifier) are PII and never enter this shape - see the
 * projection table in `Virtuals.md`. The wallet address is public on-chain
 * data and is kept because it is what a creator filter matches on.
 */
export interface VirtualsCreator {
  id: number | null;
  walletAddress: string | null;
}

/** The `vibesInfo` block (ICO / pre-commit lane). */
export interface VirtualsVibesInfo {
  status: string | null;
  vaultAddress: string | null;
  icoWalletAddress: string | null;
  icoPoolPercentage: number | null;
  icoTargetFdv: number | null;
  icoTargetPrice: number | null;
  icoTotalTokenAmount: number | null;
  committedAt: string | null;
  expectedRuggedAt: string | null;
}

/** The genesis block as it appears NESTED on an agent row. */
export interface VirtualsAgentGenesisRef {
  id: number | null;
  genesisId: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

/** One `sparkline` sample: a unix-seconds timestamp and a VIRTUAL-denominated price. */
export interface VirtualsPricePoint {
  timestampSeconds: number;
  price: number;
}

// ── Normalized agent (list + detail share this shape) ──────────────

export interface VirtualsAgent {
  id: number | null;
  uid: string | null;
  /** The protocol's own agent id (`virtualId`), distinct from the API row id. */
  virtualId: string | null;
  /** RAW free-text - sanitize + bound before surfacing to the model. */
  name: string | null;
  symbol: string | null;
  chain: string | null;
  /** UNDERGRAD (bonding curve) | AVAILABLE (graduated) | GENESIS | ... */
  status: string | null;
  factory: string | null;
  category: string | null;
  role: string | null;
  level: number | null;

  // Addresses.
  /** Set once graduated; NULL on the curve, where `preToken` is the token. */
  tokenAddress: string | null;
  /** The bonding-curve token. Equals `tokenAddress` after graduation. */
  preToken: string | null;
  /** The bonding-curve FPairV2 pair - the trades/reserves key while bonding. */
  preTokenPair: string | null;
  migrateTokenAddress: string | null;
  /** The graduated AMM pool - the GeckoTerminal/DexScreener key. */
  lpAddress: string | null;
  /** The agent creator's wallet (the row's own `walletAddress`). */
  walletAddress: string | null;
  daoAddress: string | null;
  tbaAddress: string | null;
  veTokenAddress: string | null;
  sentientWalletAddress: string | null;
  stakingAddress: string | null;
  agentStakingContract: string | null;
  merkleDistributor: string | null;
  airdropMerkleDistributor: string | null;
  taxRecipient: string | null;
  revenueConnectWallet: string | null;
  usdcV3PoolAddress: string | null;

  // Times.
  createdAt: string | null;
  /** When the bonding pair started trading - the anti-sniper clock. */
  launchedAt: string | null;
  lpCreatedAt: string | null;

  // Market metrics. Display-grade floats from the provider: mcap/fdv are
  // denominated in VIRTUAL, liquidity/volume in USD, and NONE of them is a
  // money-path input (rule 90: provider estimates are hints).
  mcapInVirtual: number | null;
  fdvInVirtual: number | null;
  liquidityUsd: number | null;
  volume5m: number | null;
  volume1h: number | null;
  volume6h: number | null;
  volume24h: number | null;
  netVolume24h: number | null;
  virtualsPoolVol5m: number | null;
  virtualsPoolVol1h: number | null;
  virtualsPoolVol6h: number | null;
  virtualsPoolVol24h: number | null;
  priceChangePercent5m: number | null;
  priceChangePercent1h: number | null;
  priceChangePercent6h: number | null;
  priceChangePercent24h: number | null;
  holderCount: number | null;
  holderCountPercent24h: number | null;
  top10HolderPercentage: number | null;
  devHoldingPercentage: number | null;
  mindshare: number | null;
  totalSupply: number | null;
  circulatingSupply: number | null;

  /**
   * Raw integer strings, kept EXACTLY as sent and never parsed into a float.
   * `virtualTokenValue` is the agent-token price in VIRTUAL at 18 decimals
   * (6576470588235294 / 1e18 = 0.0065765, which times the 1e9 supply is the
   * reported mcapInVirtual). `totalValueLocked` and the `initialPurchase*`
   * fields arrive as integer strings whose scale the provider does not
   * declare, so they travel raw with `decimals: null`; `Virtuals.md` records
   * what is and is not known about each.
   */
  virtualTokenValue: string | null;
  totalValueLocked: string | null;
  initialPurchase: string | null;
  initialPurchasedAmount: string | null;
  initialPairAmount: string | null;

  // Flags.
  /** Anti-impersonation badge - NOT a safety or quality gate. */
  isVerified: boolean;
  isDevCommitted: boolean | null;
  hasMarginTrading: boolean | null;
  showFounderVideo: boolean | null;
  displayRevenue: boolean | null;
  allowUpdateLaunchDate: boolean | null;
  shouldDisplayLaunchTime: boolean | null;
  isDelegatedOwner: boolean | null;

  acpAgentId: string | null;
  v3AcpAgentId: string | null;

  imageUrl: string | null;
  cores: VirtualsCore[];
  creator: VirtualsCreator | null;
  genesis: VirtualsAgentGenesisRef | null;
  vibesInfo: VirtualsVibesInfo | null;
  launchInfo: VirtualsLaunchInfo | null;
  socials: VirtualsSocial[];

  /** Present only when the request asked for `sparkline=true`. */
  sparkline: VirtualsPricePoint[] | null;
  /** `[low, high]` over 24 h; present only with `range24h=true`. */
  range24h: readonly [number, number] | null;

  // Free-text - carried RAW for the projector to bound + sanitize or drop.
  description: string | null;
  overview: string | null;
  tokenUtility: string | null;
  roadmap: string | null;
  additionalDetails: string | null;
  tokenomics: VirtualsTokenomicsEntry[];
  tokenomicsStatus: VirtualsTokenomicsStatus | null;
}

// ── Pagination + list result ───────────────────────────────────────

export interface VirtualsPagination {
  page: number | null;
  pageSize: number | null;
  pageCount: number | null;
  total: number | null;
}

export interface VirtualsListResult {
  agents: VirtualsAgent[];
  pagination: VirtualsPagination | null;
}

// ── Genesis (launch calendar) ──────────────────────────────────────

export interface VirtualsGenesis {
  id: number | null;
  genesisId: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  totalParticipants: number | null;
  totalPoints: number | null;
  totalVirtuals: number | null;
  /** The on-chain Genesis contract for this sale. */
  genesisAddress: string | null;
  /** The transaction that created it. */
  genesisTx: string | null;
  /** Nested agent metadata (partial). */
  agent: VirtualsAgent | null;
}

export interface VirtualsGenesesResult {
  geneses: VirtualsGenesis[];
  pagination: VirtualsPagination | null;
}

/** `GET /api/geneses/parameters` - the reserve tiers a genesis may target. */
export interface VirtualsGenesisParameters {
  reserveAmountTiers: readonly number[];
}

// ── Request params ─────────────────────────────────────────────────

/** One numeric bound pair. Both ends optional; both are server-side. */
export interface VirtualsRange {
  min?: number;
  max?: number;
}

/**
 * The full server-side filter surface. Every field maps to one measured
 * `filters[...]` expression in `client.ts`; nothing here is client-side.
 */
export interface VirtualsFilters {
  /** Free-text or address search. `searchScope` decides which clauses run. */
  query?: string;
  searchScope?: VirtualsSearchScope;
  /** Exact symbol match (`$eqi`). */
  symbol?: string;
  /** Matches EITHER `tokenAddress` or `preToken`, case-insensitively. */
  tokenAddress?: string;
  /** The agent creator's wallet (`walletAddress`, `$eqi`). */
  creatorWallet?: string;

  status?: VirtualsStatusFilter;
  factory?: VirtualsFactory;
  role?: VirtualsRole;

  isVerified?: boolean;
  isDevCommitted?: boolean;
  hasMarginTrading?: boolean;
  hasFounderVideo?: boolean;
  /** `revenueConnectWallet` is set. */
  hasRevenueConnect?: boolean;
  /** `stakingAddress` OR `agentStakingContract` is set. */
  hasStaking?: boolean;
  /** `lpCreatedAt` is set - the server-side definition of "graduated". */
  hasGraduated?: boolean;
  /** `genesis.id` is set. */
  hasGenesis?: boolean;

  genesisStartsAfter?: string;
  genesisStartsBefore?: string;
  createdAfter?: string;
  launchedAfter?: string;

  mcapInVirtual?: VirtualsRange;
  holderCount?: VirtualsRange;
  volume24h?: VirtualsRange;
  priceChangePercent24h?: VirtualsRange;
  top10HolderPercentage?: VirtualsRange;
  liquidityUsd?: VirtualsRange;

  /** `launchInfo.antiSniperTaxType` is set and non-zero. */
  hasAntiSniperTax?: boolean;
  /** `launchInfo.airdropPercent > 0`. */
  hasAirdrop?: boolean;
  /** `launchInfo.needAcf` - the Automated Capital Formation option. */
  needAcf?: boolean;
  isProject60days?: boolean;
  launchRadarEnabled?: boolean;
  isRobotics?: boolean;

  vibesStatus?: VirtualsVibesStatus;

  /** Keep ONLY X_LAUNCH / ACP_LAUNCH rows. Mutually exclusive with the next. */
  includeLaunchX?: boolean;
  /** Drop X_LAUNCH / ACP_LAUNCH rows (`$notIn`). */
  excludeLaunchX?: boolean;
}

export interface ListVirtualsParams {
  chain: VirtualsChain;
  filters?: VirtualsFilters;
  /** Default `mcapInVirtual`. */
  sort?: VirtualsSortField;
  /** Default `desc`. The provider needs an explicit direction or it 400s. */
  sortDirection?: VirtualsSortDirection;
  page?: number;
  pageSize?: number;
  /** Drop six launch/tokenomics fields the provider computes per row. */
  skipStats?: boolean;
  /** Ask for the 24 h price series on each row. */
  sparkline?: boolean;
  /** Ask for the 24 h `[low, high]` on each row. */
  range24h?: boolean;
}

export interface GetVirtualParams {
  id: number | string;
  sparkline?: boolean;
  range24h?: boolean;
}

export interface ListGenesesParams {
  page?: number;
  pageSize?: number;
  status?: VirtualsGenesisStatus;
  /** Restrict to genesis sales whose agent is on this chain. */
  chain?: VirtualsChain;
  startsAfter?: string;
  startsBefore?: string;
  sort?: VirtualsGenesisSortField;
  sortDirection?: VirtualsSortDirection;
}
