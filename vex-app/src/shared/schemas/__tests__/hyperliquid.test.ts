import { describe, expect, it } from "vitest";

import {
  hyperliquidDisplayBlockSchema,
  hyperliquidPositionDtoSchema,
  hyperliquidPositionsDtoSchema,
  hyperliquidSettingsUpdateInputSchema,
  hyperliquidCandlesDtoSchema,
  hyperliquidMarketsDtoSchema,
  hyperliquidBookDtoSchema,
  hyperliquidWorkspaceModeDtoSchema,
  hyperliquidWorkspaceEnterAcceptedSchema,
  hyperliquidWorkspaceEnterInputSchema,
  hyperliquidWorkspaceExitInputSchema,
  hyperliquidWorkspaceModeEventSchema,
  hyperliquidSessionRiskPolicySetInputSchema,
  hyperliquidSessionRiskPolicyDtoSchema,
} from "../hyperliquid.js";
import { hyperliquidPolicyTransportSchema } from "../hyperliquid.js";

const ISO = "2026-07-11T12:00:00.000Z";

describe("Hyperliquid shared schemas", () => {
  it("accepts the renderer-safe position DTO and rejects noncanonical/raw fields", () => {
    const position = {
      coin: "BTC",
      side: "long",
      size: "0.01",
      entryPx: "100000",
      markPx: "100100",
      leverage: "3",
      marginMode: "isolated",
      liquidationPx: "75000",
      unrealizedPnl: "1.25",
      fundingAccrued: "-0.01",
      slPrice: "98000",
      tpPrice: null,
      protectionState: "PROTECTED",
      confirmedAt: ISO,
      updatedAt: ISO,
    };
    expect(hyperliquidPositionDtoSchema.safeParse(position).success).toBe(true);
    expect(hyperliquidPositionDtoSchema.safeParse({ ...position, markPx: "1.50" }).success).toBe(false);
    expect(hyperliquidPositionDtoSchema.safeParse({ ...position, rawProjection: {} }).success).toBe(false);
  });

  it("accepts main-owned account and market-watchlist fields on a positions snapshot", () => {
    expect(hyperliquidPositionsDtoSchema.safeParse({
      sessionId: "00000000-0000-4000-8000-000000000001",
      positions: [],
      account: { equityUsd: "1000", withdrawableUsd: null, totalUnrealizedPnlUsd: "-2.5" },
      watchlist: [{ coin: "BTC", midPx: "100000", change24hPct: "1.25", openInterestUsd: "1000000000" }],
      updatedAt: ISO,
    }).success).toBe(true);
  });

  it("limits generic settings IPC to user-owned policy controls", () => {
    expect(hyperliquidSettingsUpdateInputSchema.safeParse({
      policy: { requireStopLoss: false, egressAlwaysApprove: false },
    }).success).toBe(true);
    expect(hyperliquidSettingsUpdateInputSchema.safeParse({
      policy: { builderFeeConsent: { kind: "approved", maxFeeRate: "0.025%" } },
    }).success).toBe(false);
    expect(hyperliquidSettingsUpdateInputSchema.safeParse({
      policy: { marketMode: "all-core-perps" },
    }).success).toBe(false);
  });

  it("requires a typed display block rather than model-authored markdown", () => {
    expect(hyperliquidDisplayBlockSchema.safeParse({
      namespace: "hyperliquid",
      kind: "risk_proposal",
      proposal: {
        proposalId: "00000000-0000-4000-8000-000000000002",
        sessionId: "00000000-0000-4000-8000-000000000001",
        coin: "BTC",
        policy: hyperliquidPolicyTransportSchema.parse({}),
        proposedBy: "agent",
        status: "proposed",
        confirmedAt: null,
        expiresAt: null,
        createdAt: ISO,
      },
    }).success).toBe(true);
    expect(hyperliquidDisplayBlockSchema.safeParse({ kind: "markdown", content: "# Hyperliquid" }).success).toBe(false);
  });

  it("accepts bounded canonical candle snapshots only", () => {
    const snapshot = {
      coin: "BTC", interval: "1h", fetchedAt: ISO,
      candles: [{ openTimeMs: 1_700_000_000_000, open: "100", high: "110", low: "90", close: "105", volume: "12.5" }],
    };
    expect(hyperliquidCandlesDtoSchema.safeParse(snapshot).success).toBe(true);
    expect(hyperliquidCandlesDtoSchema.safeParse({ ...snapshot, candles: [{ ...snapshot.candles[0], close: "105.00" }] }).success).toBe(false);
  });

  it("round-trips strict main-owned workspace mode events", () => {
    const event = { sessionId: "00000000-0000-4000-8000-000000000001", mode: "hypervexing", requestedBy: "agent", acknowledged: false } as const;
    expect(hyperliquidWorkspaceModeEventSchema.parse(event)).toEqual(event);
    expect(hyperliquidWorkspaceModeEventSchema.safeParse({ ...event, requestedBy: "renderer" }).success).toBe(false);
    expect(hyperliquidWorkspaceModeEventSchema.safeParse({ ...event, extra: true }).success).toBe(false);
  });

  it("accepts only renderer-safe markets, book, and reconciled workspace DTOs", () => {
    expect(hyperliquidMarketsDtoSchema.safeParse([
      {
        coin: "BTC",
        maxLeverage: 50,
        markPx: "100000",
        change24hPct: "2.5",
        openInterestUsd: "1000000000",
        fundingRate8hPct: "0.008",
        dayNtlVlmUsd: "123456",
        szDecimals: 5,
      },
    ]).success).toBe(true);
    expect(hyperliquidMarketsDtoSchema.safeParse([{ coin: "BTC", maxLeverage: 50 }]).success).toBe(false);
    expect(hyperliquidBookDtoSchema.safeParse({
      levels: { bids: [{ px: "100", sz: "1.5", n: 2 }], asks: [] },
      time: 1_700_000_000_000,
    }).success).toBe(true);
    expect(hyperliquidBookDtoSchema.safeParse({ levels: { bids: [], asks: [] }, time: -1 }).success).toBe(false);
    expect(hyperliquidWorkspaceModeDtoSchema.safeParse({
      mode: "normal",
      acknowledged: true,
      everEntered: false,
    }).success).toBe(true);
    expect(hyperliquidWorkspaceModeDtoSchema.safeParse({ mode: "normal", acknowledged: true }).success).toBe(false);
  });

  it("requires strict session-scoped manual workspace enter and exit requests", () => {
    expect(hyperliquidWorkspaceEnterInputSchema.safeParse({
      sessionId: "00000000-0000-4000-8000-000000000001",
    }).success).toBe(true);
    expect(hyperliquidWorkspaceEnterInputSchema.safeParse({
      sessionId: "00000000-0000-4000-8000-000000000001",
      mode: "hypervexing",
    }).success).toBe(false);
    expect(hyperliquidWorkspaceExitInputSchema.safeParse({
      sessionId: "00000000-0000-4000-8000-000000000001",
    }).success).toBe(true);
    expect(hyperliquidWorkspaceExitInputSchema.safeParse({}).success).toBe(false);
    expect(hyperliquidWorkspaceExitInputSchema.safeParse({ sessionId: "not-a-session" }).success).toBe(false);
    expect(hyperliquidWorkspaceEnterAcceptedSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(hyperliquidWorkspaceEnterAcceptedSchema.safeParse({ accepted: false }).success).toBe(false);
  });

  it("retains idempotency in the strict workspace display-block contract", () => {
    expect(hyperliquidDisplayBlockSchema.safeParse({
      namespace: "hyperliquid",
      kind: "workspace_mode_request",
      mode: "hypervexing",
      requestedBy: "agent",
      alreadyActive: true,
    }).success).toBe(true);
    expect(hyperliquidDisplayBlockSchema.safeParse({
      namespace: "hyperliquid",
      kind: "workspace_mode_request",
      mode: "hypervexing",
      requestedBy: "agent",
    }).success).toBe(false);
  });

  it("accepts only bounded direct session-risk policy controls", () => {
    const input = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      leverageCapDefault: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    };
    expect(hyperliquidSessionRiskPolicySetInputSchema.safeParse(input).success).toBe(true);
    expect(hyperliquidSessionRiskPolicySetInputSchema.safeParse({ ...input, leverageCapDefault: 1.5 }).success).toBe(false);
    expect(hyperliquidSessionRiskPolicySetInputSchema.safeParse({ ...input, perOrderNotionalPct: 51 }).success).toBe(false);
    expect(hyperliquidSessionRiskPolicySetInputSchema.safeParse({ ...input, totalNotionalPct: 9 }).success).toBe(false);
    expect(hyperliquidSessionRiskPolicyDtoSchema.safeParse({
      policy: hyperliquidPolicyTransportSchema.parse({ leverageCapDefault: 3 }),
      source: "user",
    }).success).toBe(true);
  });
});
