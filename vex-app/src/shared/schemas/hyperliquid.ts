/**
 * Renderer-safe Hyperliquid contracts.
 *
 * Financial values remain canonical decimal strings at this boundary. Main
 * parses database/provider values before constructing these DTOs; the renderer
 * never receives raw projection JSONB, wallet allow-lists, or exchange data.
 */

import { z } from "zod";

/**
 * Renderer transport mirror of the canonical main/agent policy schema.
 *
 * Shared code cannot import `src/lib`: the Electron boundary checker rejects
 * shared → runtime imports. This DTO protects IPC/event transport only; main
 * re-parses values with `src/lib/hyperliquid-policy.ts` before persistence or
 * policy resolution, which remains the authority for trading decisions.
 */
export const hyperliquidBuilderFeeConsentTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("approved"),
    maxFeeRate: z.string().regex(/^\d+(?:\.\d+)?%$/),
  }).strict(),
]);

export const hyperliquidPolicyTransportSchema = z.object({
  requireStopLoss: z.boolean().default(true),
  leverageCapDefault: z.number().int().min(1).default(3),
  perOrderNotionalPct: z.number().min(1).max(50).default(20),
  totalNotionalPct: z.number().min(10).max(200).default(100),
  maxSlippageEstPct: z.number().min(0.1).max(5).default(1),
  maintenanceHeadroomFloor: z.number().min(1.25).max(4).default(2),
  egressAlwaysApprove: z.boolean().default(true),
  marketMode: z.literal("all-core-perps").default("all-core-perps"),
  marketAllowlist: z.array(z.string().trim().min(1).max(64)).min(1).max(100).nullable().default(null),
  builderFeeConsent: hyperliquidBuilderFeeConsentTransportSchema.default({ kind: "none" }),
}).strict();
export type HyperliquidPolicyTransport = z.infer<typeof hyperliquidPolicyTransportSchema>;

const unsignedDecimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/, "Expected a canonical unsigned decimal string.");
const signedDecimal = z
  .string()
  .regex(/^(?:0|-?(?:(?:0|[1-9]\d*)\.\d*[1-9]|[1-9]\d*))$/, "Expected a canonical signed decimal string.");

export const hyperliquidProtectionStateSchema = z.enum([
  "FLAT",
  "OPENING",
  "CONSOLIDATING",
  "PROTECTED",
  "PARTIAL",
  "UNPROTECTED",
  "unprotected_by_user_choice",
]);
export type HyperliquidProtectionState = z.infer<typeof hyperliquidProtectionStateSchema>;

export const hyperliquidPositionDtoSchema = z
  .object({
    coin: z.string().min(1).max(64),
    side: z.enum(["long", "short"]),
    size: unsignedDecimal,
    entryPx: unsignedDecimal,
    markPx: unsignedDecimal,
    leverage: unsignedDecimal.nullable(),
    marginMode: z.enum(["cross", "isolated", "unknown"]),
    liquidationPx: unsignedDecimal.nullable(),
    unrealizedPnl: signedDecimal,
    fundingAccrued: signedDecimal,
    slPrice: unsignedDecimal.nullable(),
    tpPrice: unsignedDecimal.nullable(),
    protectionState: hyperliquidProtectionStateSchema,
    /** Last reconciler-confirmed state, not a renderer clock. */
    confirmedAt: z.string().datetime({ offset: true }),
    /** Projection update time; can advance on a main mark-price push. */
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type HyperliquidPositionDto = z.infer<typeof hyperliquidPositionDtoSchema>;

export const hyperliquidPositionsReadInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type HyperliquidPositionsReadInput = z.infer<typeof hyperliquidPositionsReadInputSchema>;

/** Reconciler-confirmed account summary; null means that field was unavailable. */
export const hyperliquidAccountDtoSchema = z.object({
  equityUsd: unsignedDecimal.nullable(),
  withdrawableUsd: unsignedDecimal.nullable(),
  totalUnrealizedPnlUsd: signedDecimal.nullable(),
}).strict();
export type HyperliquidAccountDto = z.infer<typeof hyperliquidAccountDtoSchema>;

/** Main-owned market watchlist. Mid is refreshed from the public allMids poll. */
export const hyperliquidWatchlistItemDtoSchema = z.object({
  coin: z.string().min(1).max(64),
  midPx: unsignedDecimal,
  change24hPct: signedDecimal.nullable(),
  openInterestUsd: unsignedDecimal.nullable(),
}).strict();
export type HyperliquidWatchlistItemDto = z.infer<typeof hyperliquidWatchlistItemDtoSchema>;

export const hyperliquidPositionsDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    positions: z.array(hyperliquidPositionDtoSchema).max(100),
    /** Present on main reads/pushes; optional only for backward-compatible preload upgrades. */
    account: hyperliquidAccountDtoSchema.optional(),
    /** Present on main reads/pushes; empty only before the reconciler has a market slice. */
    watchlist: z.array(hyperliquidWatchlistItemDtoSchema).max(16).optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type HyperliquidPositionsDto = z.infer<typeof hyperliquidPositionsDtoSchema>;

export const hyperliquidCandleIntervalSchema = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export type HyperliquidCandleInterval = z.infer<typeof hyperliquidCandleIntervalSchema>;

export const hyperliquidCandlesReadInputSchema = z.object({
  sessionId: z.string().uuid(),
  coin: z.string().trim().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema.default("1h"),
}).strict();
export type HyperliquidCandlesReadInput = z.infer<typeof hyperliquidCandlesReadInputSchema>;

export const hyperliquidCandleDtoSchema = z.object({
  openTimeMs: z.number().int().nonnegative(),
  open: unsignedDecimal,
  high: unsignedDecimal,
  low: unsignedDecimal,
  close: unsignedDecimal,
  volume: unsignedDecimal,
}).strict();
export type HyperliquidCandleDto = z.infer<typeof hyperliquidCandleDtoSchema>;

export const hyperliquidCandlesDtoSchema = z.object({
  coin: z.string().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema,
  candles: z.array(hyperliquidCandleDtoSchema).max(1_000),
  fetchedAt: z.string().datetime({ offset: true }),
}).strict();
export type HyperliquidCandlesDto = z.infer<typeof hyperliquidCandlesDtoSchema>;

/**
 * Live WebSocket feed contracts.
 *
 * `watchLive`/`unwatchLive` are session-gated control calls: main owns one
 * shared SDK transport and refcounts a candle subscription per (coin, interval)
 * plus a single filtered allMids stream. `watchId` is a main-generated UUID the
 * renderer echoes back to release. The renderer never touches the socket.
 */
export const hyperliquidWatchLiveInputSchema = z.object({
  sessionId: z.string().uuid(),
  coin: z.string().trim().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema.default("1h"),
}).strict();
export type HyperliquidWatchLiveInput = z.infer<typeof hyperliquidWatchLiveInputSchema>;

export const hyperliquidWatchLiveDtoSchema = z.object({
  watchId: z.string().uuid(),
}).strict();
export type HyperliquidWatchLiveDto = z.infer<typeof hyperliquidWatchLiveDtoSchema>;

export const hyperliquidUnwatchLiveInputSchema = z.object({
  sessionId: z.string().uuid(),
  watchId: z.string().uuid(),
}).strict();
export type HyperliquidUnwatchLiveInput = z.infer<typeof hyperliquidUnwatchLiveInputSchema>;

export const hyperliquidUnwatchLiveDtoSchema = z.object({
  released: z.boolean(),
}).strict();
export type HyperliquidUnwatchLiveDto = z.infer<typeof hyperliquidUnwatchLiveDtoSchema>;

/** Pushed on each live candle tick for a watched (coin, interval). */
export const hyperliquidCandleUpdateEventSchema = z.object({
  coin: z.string().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema,
  candle: hyperliquidCandleDtoSchema,
}).strict();
export type HyperliquidCandleUpdateEvent = z.infer<typeof hyperliquidCandleUpdateEventSchema>;

export const hyperliquidMidsUpdateEntrySchema = z.object({
  coin: z.string().min(1).max(64),
  midPx: unsignedDecimal,
}).strict();
export type HyperliquidMidsUpdateEntry = z.infer<typeof hyperliquidMidsUpdateEntrySchema>;

/**
 * Coalesced allMids push, filtered to the coins with an active watch. The 64
 * cap bounds the payload — main never forwards the full allMids firehose.
 */
export const hyperliquidMidsUpdateEventSchema = z.object({
  mids: z.array(hyperliquidMidsUpdateEntrySchema).max(64),
}).strict();
export type HyperliquidMidsUpdateEvent = z.infer<typeof hyperliquidMidsUpdateEventSchema>;

export const hyperliquidMarketsReadInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();
export type HyperliquidMarketsReadInput = z.infer<typeof hyperliquidMarketsReadInputSchema>;

export const hyperliquidMarketDtoSchema = z.object({
  coin: z.string().min(1).max(64),
  maxLeverage: z.number().int().min(1),
  markPx: unsignedDecimal,
  change24hPct: signedDecimal.nullable(),
  openInterestUsd: unsignedDecimal,
  fundingRate8hPct: signedDecimal.nullable(),
  dayNtlVlmUsd: unsignedDecimal.nullable(),
  szDecimals: z.number().int().min(0).max(18),
}).strict();
export type HyperliquidMarketDto = z.infer<typeof hyperliquidMarketDtoSchema>;

/** Full Core perpetual universe; arrays avoid adding a redundant wrapper DTO. */
export const hyperliquidMarketsDtoSchema = z.array(hyperliquidMarketDtoSchema).max(500);
export type HyperliquidMarketsDto = z.infer<typeof hyperliquidMarketsDtoSchema>;

export const hyperliquidBookReadInputSchema = z.object({
  sessionId: z.string().uuid(),
  coin: z.string().trim().min(1).max(64),
}).strict();
export type HyperliquidBookReadInput = z.infer<typeof hyperliquidBookReadInputSchema>;

export const hyperliquidBookLevelDtoSchema = z.object({
  px: unsignedDecimal,
  sz: unsignedDecimal,
  n: z.number().int().nonnegative(),
}).strict();
export type HyperliquidBookLevelDto = z.infer<typeof hyperliquidBookLevelDtoSchema>;

export const hyperliquidBookDtoSchema = z.object({
  levels: z.object({
    bids: z.array(hyperliquidBookLevelDtoSchema).max(200),
    asks: z.array(hyperliquidBookLevelDtoSchema).max(200),
  }).strict(),
  time: z.number().int().nonnegative(),
}).strict();
export type HyperliquidBookDto = z.infer<typeof hyperliquidBookDtoSchema>;

/**
 * Read-only account registers (Open Orders / TWAP history / Trade History /
 * Funding History / Order History). The renderer supplies ONLY the sessionId;
 * main resolves the session's selected EVM wallet and validates every venue
 * response before mapping. Rows are capped (documented truncation, newest
 * first); financial values are canonical decimal strings.
 */
export const hyperliquidAccountReadInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type HyperliquidAccountReadInput = z.infer<typeof hyperliquidAccountReadInputSchema>;

const HYPERLIQUID_REGISTER_ROW_CAP = 100;

export const hyperliquidOpenOrderDtoSchema = z.object({
  oid: z.number().int(),
  coin: z.string().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  limitPx: unsignedDecimal,
  sz: unsignedDecimal,
  origSz: unsignedDecimal.nullable(),
  orderType: z.string().max(64).nullable(),
  reduceOnly: z.boolean(),
  isTrigger: z.boolean(),
  triggerPx: unsignedDecimal.nullable(),
  timestampMs: z.number().int().nonnegative(),
}).strict();
export type HyperliquidOpenOrderDto = z.infer<typeof hyperliquidOpenOrderDtoSchema>;
export const hyperliquidOpenOrdersDtoSchema = z.array(hyperliquidOpenOrderDtoSchema).max(HYPERLIQUID_REGISTER_ROW_CAP);
export type HyperliquidOpenOrdersDto = z.infer<typeof hyperliquidOpenOrdersDtoSchema>;

export const hyperliquidTwapFillDtoSchema = z.object({
  twapId: z.number().int(),
  coin: z.string().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  px: unsignedDecimal,
  sz: unsignedDecimal,
  closedPnl: signedDecimal,
  fee: signedDecimal,
  dir: z.string().max(64).nullable(),
  timeMs: z.number().int().nonnegative(),
}).strict();
export type HyperliquidTwapFillDto = z.infer<typeof hyperliquidTwapFillDtoSchema>;
export const hyperliquidTwapHistoryDtoSchema = z.array(hyperliquidTwapFillDtoSchema).max(HYPERLIQUID_REGISTER_ROW_CAP);
export type HyperliquidTwapHistoryDto = z.infer<typeof hyperliquidTwapHistoryDtoSchema>;

export const hyperliquidTradeFillDtoSchema = z.object({
  oid: z.number().int(),
  coin: z.string().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  px: unsignedDecimal,
  sz: unsignedDecimal,
  closedPnl: signedDecimal,
  fee: signedDecimal,
  dir: z.string().max(64).nullable(),
  timeMs: z.number().int().nonnegative(),
}).strict();
export type HyperliquidTradeFillDto = z.infer<typeof hyperliquidTradeFillDtoSchema>;
export const hyperliquidTradeHistoryDtoSchema = z.array(hyperliquidTradeFillDtoSchema).max(HYPERLIQUID_REGISTER_ROW_CAP);
export type HyperliquidTradeHistoryDto = z.infer<typeof hyperliquidTradeHistoryDtoSchema>;

export const hyperliquidFundingEntryDtoSchema = z.object({
  coin: z.string().min(1).max(64),
  usdc: signedDecimal,
  szi: signedDecimal,
  /** Venue fundingRate as a raw fraction (not a percentage). */
  fundingRate: signedDecimal,
  timeMs: z.number().int().nonnegative(),
}).strict();
export type HyperliquidFundingEntryDto = z.infer<typeof hyperliquidFundingEntryDtoSchema>;
export const hyperliquidFundingHistoryDtoSchema = z.array(hyperliquidFundingEntryDtoSchema).max(HYPERLIQUID_REGISTER_ROW_CAP);
export type HyperliquidFundingHistoryDto = z.infer<typeof hyperliquidFundingHistoryDtoSchema>;

export const hyperliquidOrderHistoryEntryDtoSchema = z.object({
  oid: z.number().int(),
  coin: z.string().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  limitPx: unsignedDecimal.nullable(),
  sz: unsignedDecimal,
  orderType: z.string().max(64).nullable(),
  reduceOnly: z.boolean(),
  status: z.string().min(1).max(64),
  timeMs: z.number().int().nonnegative(),
  statusTimeMs: z.number().int().nonnegative(),
}).strict();
export type HyperliquidOrderHistoryEntryDto = z.infer<typeof hyperliquidOrderHistoryEntryDtoSchema>;
export const hyperliquidOrderHistoryDtoSchema = z.array(hyperliquidOrderHistoryEntryDtoSchema).max(HYPERLIQUID_REGISTER_ROW_CAP);
export type HyperliquidOrderHistoryDto = z.infer<typeof hyperliquidOrderHistoryDtoSchema>;

/**
 * Settings may change only user-owned global controls. Market selection is a
 * fixed v1 product decision and builder-fee allowance is venue-reported after
 * the first-entry acknowledgement, so neither can be smuggled through generic
 * settings IPC.
 */
export const hyperliquidUserPolicyPatchSchema = z
  .object({
    requireStopLoss: z.boolean().optional(),
    leverageCapDefault: z.number().int().min(1).optional(),
    perOrderNotionalPct: z.number().min(1).max(50).optional(),
    totalNotionalPct: z.number().min(10).max(200).optional(),
    maxSlippageEstPct: z.number().min(0.1).max(5).optional(),
    maintenanceHeadroomFloor: z.number().min(1.25).max(4).optional(),
    egressAlwaysApprove: z.boolean().optional(),
  })
  .strict();
export type HyperliquidUserPolicyPatch = z.infer<typeof hyperliquidUserPolicyPatchSchema>;

export const hyperliquidSettingsUpdateInputSchema = z
  .object({ policy: hyperliquidUserPolicyPatchSchema })
  .strict();
export type HyperliquidSettingsUpdateInput = z.infer<typeof hyperliquidSettingsUpdateInputSchema>;

export const hyperliquidRiskAcknowledgementInputSchema = z
  .object({ acknowledged: z.literal(true) })
  .strict();

export const hyperliquidWorkspaceModeEventSchema = z.object({
  sessionId: z.string().uuid(),
  mode: z.enum(["hypervexing", "normal"]),
  requestedBy: z.literal("agent"),
  acknowledged: z.boolean(),
}).strict();
export type HyperliquidWorkspaceModeEvent = z.infer<typeof hyperliquidWorkspaceModeEventSchema>;

export const hyperliquidWorkspaceModeReadInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();
export type HyperliquidWorkspaceModeReadInput = z.infer<typeof hyperliquidWorkspaceModeReadInputSchema>;

export const hyperliquidWorkspaceModeDtoSchema = z.object({
  mode: z.enum(["hypervexing", "normal"]),
  acknowledged: z.boolean(),
  everEntered: z.boolean(),
}).strict();
export type HyperliquidWorkspaceModeDto = z.infer<typeof hyperliquidWorkspaceModeDtoSchema>;

/** Manual entry is main-gated to acknowledged sessions with prior entry. */
export const hyperliquidWorkspaceEnterInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();
export type HyperliquidWorkspaceEnterInput = z.infer<typeof hyperliquidWorkspaceEnterInputSchema>;

export const hyperliquidWorkspaceEnterAcceptedSchema = z.object({
  accepted: z.literal(true),
}).strict();
export type HyperliquidWorkspaceEnterAccepted = z.infer<typeof hyperliquidWorkspaceEnterAcceptedSchema>;

/** Manual exit remains available independently of manual-entry eligibility. */
export const hyperliquidWorkspaceExitInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();
export type HyperliquidWorkspaceExitInput = z.infer<typeof hyperliquidWorkspaceExitInputSchema>;

export const hyperliquidRiskAdjustmentSchema = z
  .object({
    leverageCapDefault: z.number().int().min(1).optional(),
    perOrderNotionalPct: z.number().min(1).max(50).optional(),
    totalNotionalPct: z.number().min(10).max(200).optional(),
  })
  .strict();
export type HyperliquidRiskAdjustment = z.infer<typeof hyperliquidRiskAdjustmentSchema>;

/** Direct user control of the three session-scoped Hyperliquid risk caps. */
export const hyperliquidSessionRiskPolicySetInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    leverageCapDefault: z.number().int().min(1),
    perOrderNotionalPct: z.number().min(1).max(50),
    totalNotionalPct: z.number().min(10).max(200),
  })
  .strict();
export type HyperliquidSessionRiskPolicySetInput = z.infer<typeof hyperliquidSessionRiskPolicySetInputSchema>;

export const hyperliquidSessionRiskPolicyReadInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type HyperliquidSessionRiskPolicyReadInput = z.infer<typeof hyperliquidSessionRiskPolicyReadInputSchema>;

export const hyperliquidSessionRiskPolicyDtoSchema = z
  .object({
    policy: hyperliquidPolicyTransportSchema,
    source: z.enum(["user", "proposal", "defaults"]),
  })
  .strict();
export type HyperliquidSessionRiskPolicyDto = z.infer<typeof hyperliquidSessionRiskPolicyDtoSchema>;

export const hyperliquidRiskProposalDtoSchema = z
  .object({
    proposalId: z.string().uuid(),
    sessionId: z.string().uuid(),
    coin: z.string().min(1).max(64),
    policy: hyperliquidPolicyTransportSchema,
    proposedBy: z.enum(["agent", "user"]),
    status: z.enum(["proposed", "active", "expired", "revoked"]),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type HyperliquidRiskProposalDto = z.infer<typeof hyperliquidRiskProposalDtoSchema>;

export const hyperliquidRiskProposalsReadInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type HyperliquidRiskProposalsReadInput = z.infer<typeof hyperliquidRiskProposalsReadInputSchema>;

export const hyperliquidRiskProposalsDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    proposals: z.array(hyperliquidRiskProposalDtoSchema).max(20),
  })
  .strict();
export type HyperliquidRiskProposalsDto = z.infer<typeof hyperliquidRiskProposalsDtoSchema>;

export const hyperliquidRiskProposalConfirmInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    proposalId: z.string().uuid(),
    adjustments: hyperliquidRiskAdjustmentSchema.nullable().default(null),
  })
  .strict();
export type HyperliquidRiskProposalConfirmInput = z.infer<typeof hyperliquidRiskProposalConfirmInputSchema>;

/** Typed transcript payloads. Main validates these before the renderer brands a card. */
export const hyperliquidDisplayBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({
      namespace: z.literal("hyperliquid"),
      kind: z.literal("order_receipt"),
      coin: z.string().min(1).max(64),
      side: z.enum(["long", "short", "buy", "sell"]).nullable(),
      status: z.enum(["accepted", "partial", "rejected", "unprotected"]),
      protectionState: hyperliquidProtectionStateSchema.nullable(),
    })
    .strict(),
  z
    .object({
      namespace: z.literal("hyperliquid"),
      kind: z.literal("position_summary"),
      coin: z.string().min(1).max(64),
      side: z.enum(["long", "short"]),
      size: unsignedDecimal,
      markPx: unsignedDecimal,
      protectionState: hyperliquidProtectionStateSchema,
    })
    .strict(),
  z
    .object({
      namespace: z.literal("hyperliquid"),
      kind: z.literal("risk_proposal"),
      proposal: hyperliquidRiskProposalDtoSchema,
    })
    .strict(),
  z
    .object({
      namespace: z.literal("hyperliquid"),
      kind: z.literal("workspace_mode_request"),
      mode: z.enum(["hypervexing", "normal"]),
      requestedBy: z.literal("agent"),
      alreadyActive: z.boolean(),
    })
    .strict(),
]);
export type HyperliquidDisplayBlock = z.infer<typeof hyperliquidDisplayBlockSchema>;
