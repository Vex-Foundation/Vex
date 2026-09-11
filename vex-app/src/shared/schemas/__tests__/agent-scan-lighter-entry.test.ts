/**
 * The Lighter arm's contract, probed at runtime: the invariants the type
 * system cannot carry alone. A closed market cannot carry details, an open
 * market may say "details unavailable", numbers are validated by shape and
 * not only by length, a rebate is a signed amount, and a cursor minted before
 * the second arm existed still parses.
 */

import { describe, expect, it } from "vitest";
import {
  agentScanCursorSchema,
  agentScanEntrySchema,
} from "../agent-scan-feed.js";
import {
  agentScanLighterFillEntrySchema,
  agentScanLighterPositionNowSchema,
  type AgentScanLighterFillEntry,
} from "../agent-scan-lighter-entry.js";

const OBSERVED_AT = "2026-09-11T14:49:46.033Z";

function fill(overrides: Partial<AgentScanLighterFillEntry> = {}): AgentScanLighterFillEntry {
  return {
    source: "lighter_fill",
    id: "1",
    createdAt: "2026-09-11T13:58:07.000Z",
    observedAt: "2026-09-11T13:58:08.249Z",
    environment: "rhc",
    marketIndex: 0,
    marketSymbol: "ETH",
    spot: false,
    side: "buy",
    tradeType: "trade",
    positionEffect: "open",
    baseSize: "0.0050",
    price: "2598.09",
    quoteNotional: "12.99045",
    usdAmount: "12.990450",
    blockHeight: "20430001",
    baseAsset: { symbol: "ETH", decimals: 4 },
    quoteAsset: { symbol: "USDG", decimals: 6 },
    positionSizeBefore: "0.0000",
    entryQuoteBefore: null,
    accountPnl: "0.000000",
    leverage: { initialMarginFraction: 1000, display: "10.00" },
    feeSide: "taker",
    integratorFee: {
      charged: null,
      estimate: {
        raw: "12990",
        symbol: "USDG",
        decimals: 6,
        basis: "quote_notional",
        tickSource: "observed",
        usd: "0.012990",
      },
      tickObserved: 1000,
      tickAuthorized: 1000,
    },
    exchangeFee: { charged: null, estimatedUsd: "0.004546", tickObserved: 350 },
    providerTradeId: "601535556",
    providerOrderId: "281475043993191",
    intentId: "lighter-exec-a5a46767-cae0-4a71-b8e0-f85f9c23010f",
    positionNow: {
      observedAt: OBSERVED_AT,
      open: true,
      position: {
        size: "0.0050",
        entryPrice: "2598.09",
        unrealizedPnl: "-0.007650",
        realizedPnl: "0.000000",
        liquidationPrice: "2365.9297570850204",
        leverage: { initialMarginFraction: 1000, display: "10.00" },
        marginMode: "isolated",
      },
    },
    ...overrides,
  };
}

describe("agentScanLighterFillEntrySchema", () => {
  it("accepts the measured ETH fill and round-trips it unchanged", () => {
    const entry = fill();
    expect(agentScanLighterFillEntrySchema.parse(entry)).toEqual(entry);
    expect(agentScanEntrySchema.parse(entry)).toEqual(entry);
  });

  it("validates numbers by shape, not only by length", () => {
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ baseSize: "garbage" })).success).toBe(false);
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ price: "-1" })).success).toBe(false);
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ blockHeight: "12.5" })).success).toBe(false);
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ providerTradeId: "0x1" })).success).toBe(false);
    // Signed where the ledger is signed: a short position before, a loss.
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ positionSizeBefore: "-0.0100" })).success).toBe(true);
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ accountPnl: "-0.019000" })).success).toBe(true);
  });

  it("keeps a rebate as a signed exchange fee amount and refuses a signed integrator amount", () => {
    const rebate = fill({
      exchangeFee: { charged: { raw: "-120", symbol: "USDG", decimals: 6 }, estimatedUsd: null, tickObserved: -10 },
    });
    expect(agentScanLighterFillEntrySchema.safeParse(rebate).success).toBe(true);
    const negativeIntegrator = fill({
      integratorFee: {
        charged: { raw: "-1", symbol: "USDG", decimals: 6 },
        estimate: null,
        tickObserved: null,
        tickAuthorized: null,
      },
    });
    expect(agentScanLighterFillEntrySchema.safeParse(negativeIntegrator).success).toBe(false);
  });

  it("tolerates vocabulary values this build has never heard of, bounded", () => {
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ positionEffect: "rebalanced" })).success).toBe(true);
    expect(agentScanLighterFillEntrySchema.safeParse(fill({ tradeType: "x".repeat(33) })).success).toBe(false);
  });

  it("refuses an unknown field: the payload is strict", () => {
    const withExtra = { ...fill(), txHash: "0xabc" } as unknown;
    expect(agentScanLighterFillEntrySchema.safeParse(withExtra).success).toBe(false);
  });
});

describe("agentScanLighterPositionNowSchema", () => {
  it("makes a closed market with details unrepresentable", () => {
    const closedWithDetails = {
      observedAt: OBSERVED_AT,
      open: false,
      position: { size: "0.0050", entryPrice: null, unrealizedPnl: null, realizedPnl: null, liquidationPrice: null, leverage: null, marginMode: null },
    };
    expect(agentScanLighterPositionNowSchema.safeParse(closedWithDetails).success).toBe(false);
    expect(agentScanLighterPositionNowSchema.safeParse({ observedAt: OBSERVED_AT, open: false, position: null }).success).toBe(true);
  });

  it("lets an open market say its details are unavailable, and refuses an unreadable size", () => {
    expect(agentScanLighterPositionNowSchema.safeParse({ observedAt: OBSERVED_AT, open: true, position: null }).success).toBe(true);
    const garbageSize = {
      observedAt: OBSERVED_AT,
      open: true,
      position: { size: "garbage", entryPrice: null, unrealizedPnl: null, realizedPnl: null, liquidationPrice: null, leverage: null, marginMode: null },
    };
    expect(agentScanLighterPositionNowSchema.safeParse(garbageSize).success).toBe(false);
  });
});

describe("agentScanCursorSchema with two arms", () => {
  it("parses a cursor minted before the second arm existed as the activity arm", () => {
    const parsed = agentScanCursorSchema.parse({
      createdAt: "2026-09-11T13:58:07.000000Z",
      sourceId: "42",
    });
    expect(parsed.sourceRank).toBe(0);
  });

  it("carries the Lighter arm's rank and refuses a third arm", () => {
    expect(
      agentScanCursorSchema.parse({ createdAt: "2026-09-11T13:58:07.000000Z", sourceId: "1", sourceRank: 1 }).sourceRank,
    ).toBe(1);
    expect(
      agentScanCursorSchema.safeParse({ createdAt: "2026-09-11T13:58:07.000000Z", sourceId: "1", sourceRank: 2 }).success,
    ).toBe(false);
  });
});

describe("agentScanEntrySchema union", () => {
  it("routes on source and refuses an entry without one", () => {
    const withoutSource = { ...fill() } as Record<string, unknown>;
    delete withoutSource.source;
    expect(agentScanEntrySchema.safeParse(withoutSource).success).toBe(false);
  });
});
