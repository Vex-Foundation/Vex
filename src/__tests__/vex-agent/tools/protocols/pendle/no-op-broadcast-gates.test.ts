/**
 * Two guards that stop Vex broadcasting a transaction which CANNOT succeed
 * (G-40 — D11 and D13). Both burn real gas for nothing, and until the receipt
 * wait lands (R5c) both are reported to the agent as a SUCCESS.
 *
 * D11 / P1-14 — `pt.redeem` degrades to the `redeemPyToSy` fallback on a
 * NON-matured PT. Any convert action other than `redeem-py` (including a
 * perfectly good `"swap"`, and any transport failure) takes the else branch,
 * approves only the PT, and sends `redeemPyToSy` — which pre-expiry needs the YT
 * as well and MUST revert on-chain. `market.expiry` is in hand at the call site
 * and was never checked. Masked today by the matured-market resolver gap;
 * becomes live the moment R5b unblocks it, which is why the gate lands first.
 *
 * D13 — `pendle.claim` with an explicit `market` the wallet holds no position in
 * builds and broadcasts a no-op sweep (live-probed). The unscoped path derives
 * its targets from the dashboard positions and so cannot do this; the explicit
 * path added the market unconditionally.
 *
 * An UNKNOWN maturity is refused too, never assumed either way — the same
 * doctrine R5b applies to inactive rows: a missing or unparseable expiry is not
 * evidence of maturity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleMarket, PendleMarketPosition } from "@tools/pendle/types.js";

import { assertPtMaturedForFallback } from "@vex-agent/tools/protocols/pendle/redeem-fallback.js";
import { ErrorCodes } from "../../../../../errors.js";

const mockGetPositions = vi.fn();
const mockGetActiveMarkets = vi.fn();
const mockGetInactiveMarketsSweep = vi.fn();
const mockResolveMarketByAddress = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    getPositions: (...a: unknown[]) => mockGetPositions(...a),
    getActiveMarkets: (...a: unknown[]) => mockGetActiveMarkets(...a),
    getInactiveMarkets: (...a: unknown[]) => mockGetInactiveMarketsSweep(...a),
  }),
}));
// R5b: claim target selection resolves through the matured-capable lane, so a
// matured market the wallet holds is claimable. Delegates to the same double.
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByAddress: async (...a: unknown[]) => {
    const m = await mockResolveMarketByAddress(...a);
    return m ? { market: m, maturity: "active" } : null;
  },
}));

const { buildPendleClaimTargets, describePendleClaimSkips } = await import(
  "@vex-agent/tools/protocols/pendle/claim-targets.js"
);

// ── D11: the pre-maturity fallback gate ──────────────────────────────

const NOW = new Date("2026-07-27T12:00:00.000Z");

function expectRefusal(fn: () => unknown, match: RegExp): void {
  try {
    fn();
    throw new Error("expected a refusal, but the call succeeded");
  } catch (err) {
    const e = err as { code?: string; message?: string; hint?: string };
    expect(e.code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
    expect(`${e.message} ${e.hint ?? ""}`).toMatch(match);
  }
}

describe("the redeemPyToSy fallback is refused BY NAME before maturity", () => {
  it("REFUSES a PT whose market expires in the future (the must-revert broadcast)", () => {
    expectRefusal(() => assertPtMaturedForFallback("2027-12-30T00:00:00.000Z", NOW), /matur/i);
  });

  it("refuses one second before expiry", () => {
    expectRefusal(
      () => assertPtMaturedForFallback(new Date(NOW.getTime() + 1000).toISOString(), NOW),
      /matur/i,
    );
  });

  it("ALLOWS a PT already past its expiry — the case the fallback exists for", () => {
    expect(() => assertPtMaturedForFallback("2026-04-02T00:00:00.000Z", NOW)).not.toThrow();
  });

  it("allows exactly at expiry (redemption opens at maturity)", () => {
    expect(() => assertPtMaturedForFallback(NOW.toISOString(), NOW)).not.toThrow();
  });

  it("refuses a MISSING expiry rather than assuming maturity", () => {
    expectRefusal(() => assertPtMaturedForFallback(null, NOW), /expiry/i);
  });

  it("refuses an UNPARSEABLE expiry rather than assuming maturity", () => {
    expectRefusal(() => assertPtMaturedForFallback("whenever", NOW), /expiry/i);
    expectRefusal(() => assertPtMaturedForFallback("", NOW), /expiry/i);
  });
});

// ── D13: the claim holding check ─────────────────────────────────────

const CHAIN_ID = 1;
const WALLET = "0x1111111111111111111111111111111111111111";
const MARKET = "0x2222222222222222222222222222222222222222";

function market(overrides: Partial<PendleMarket> = {}): PendleMarket {
  return {
    address: MARKET,
    name: "held-market",
    expiry: "2027-01-01T00:00:00.000Z",
    pt: `${MARKET}pt`,
    yt: `${MARKET}yt`,
    sy: `${MARKET}sy`,
    underlyingAsset: `${MARKET}ua`,
    details: {} as PendleMarket["details"],
    categoryIds: [],
    isNew: false,
    isPrime: false,
    ...overrides,
  };
}

function position(leg: "yt" | "lp", balance: string): PendleMarketPosition {
  return {
    marketId: `${CHAIN_ID}-${MARKET}`,
    pt: null,
    yt: leg === "yt" ? { balance, valuationUsd: 10 } : null,
    lp: leg === "lp" ? { balance, valuationUsd: 10 } : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMarketByAddress.mockResolvedValue(market());
  mockGetInactiveMarketsSweep.mockResolvedValue([]);
  mockGetActiveMarkets.mockResolvedValue([market()]);
});

describe("an explicitly requested claim market must actually be held", () => {
  it("REFUSES a market the wallet holds no position in — no gas is burned on a no-op", async () => {
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);

    expect(targets.intendedYts.size).toBe(0);
    expect(targets.intendedMarkets.size).toBe(0);
    expect(targets.selectedMarketCount).toBe(0);
    expect(targets.skipped).toEqual([{ market: MARKET.toLowerCase(), reason: "no_position" }]);
  });

  it("refuses a market whose only legs are ZERO balances", async () => {
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [position("yt", "0")] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);
    expect(targets.skipped).toEqual([{ market: MARKET.toLowerCase(), reason: "no_position" }]);
  });

  it("refuses when the wallet holds the market on a DIFFERENT chain", async () => {
    mockGetPositions.mockResolvedValue([{ chainId: 42161, openPositions: [position("yt", "1000")] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);
    expect(targets.skipped).toEqual([{ market: MARKET.toLowerCase(), reason: "no_position" }]);
  });

  it("tells the agent WHY nothing was claimed, naming the market", async () => {
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);
    const sentence = describePendleClaimSkips(targets);
    expect(sentence).toContain(MARKET.toLowerCase());
    expect(sentence).toMatch(/no .*position|hold/i);
  });

  it("PROCEEDS for a held YT position — the guard does not block a real claim", async () => {
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [position("yt", "1000")] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);

    expect(targets.intendedMarkets.has(MARKET.toLowerCase())).toBe(true);
    expect(targets.intendedYts.size).toBe(1);
    expect(targets.selectedMarketCount).toBe(1);
    expect(targets.skipped).toEqual([]);
  });

  it("PROCEEDS for a held LP position", async () => {
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [position("lp", "500")] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);
    expect(targets.intendedMarkets.has(MARKET.toLowerCase())).toBe(true);
    expect(targets.skipped).toEqual([]);
  });

  it("still reports market_not_found ahead of the holding check", async () => {
    mockResolveMarketByAddress.mockResolvedValue(null);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [] }]);
    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET);
    expect(targets.skipped).toEqual([{ market: MARKET.toLowerCase(), reason: "market_not_found" }]);
  });

  it("a positions-read FAILURE refuses rather than claiming blind", async () => {
    mockGetPositions.mockRejectedValue(new Error("dashboard unavailable"));
    await expect(buildPendleClaimTargets(CHAIN_ID, WALLET, MARKET)).rejects.toThrow();
  });
});

// ── R5b: matured markets are claimable, and the accounting stays honest ──

describe("claim includes MATURED markets (G-02) without breaking skip honesty", () => {
  /**
   * The defect: the sweep indexed `getActiveMarkets` only, so a matured market
   * the wallet held income in hit `if (!m) continue` — dropped from eligible AND
   * from skipped. It was silently absent, which is the one outcome this module's
   * whole accounting contract forbids.
   */
  const MATURED_ADDR = "0x3333333333333333333333333333333333333333";
  const maturedMarket = { ...market(), address: MATURED_ADDR, name: "srUSDe", expiry: "2026-04-02T00:00:00.000Z" };
  const maturedPosition = (): PendleMarketPosition => ({
    marketId: `${CHAIN_ID}-${MATURED_ADDR}`,
    pt: null,
    yt: { balance: "1000", valuationUsd: 10 },
    lp: null,
  });

  it("an unscoped sweep SELECTS a matured market the wallet earns income in", async () => {
    mockGetActiveMarkets.mockResolvedValue([]);
    mockGetInactiveMarketsSweep.mockResolvedValue([maturedMarket]);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [maturedPosition()] }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    expect(targets.eligibleMarketCount).toBe(1);
    expect(targets.selectedMarketCount).toBe(1);
    expect(targets.intendedYts.size).toBe(1);
    expect(targets.skipped).toEqual([]);
  });

  it("a matured market is NEVER silently absent — it appears in eligible or in skipped", async () => {
    mockGetActiveMarkets.mockResolvedValue([]);
    // No bind material → it must be SKIPPED with a reason, not dropped.
    mockGetInactiveMarketsSweep.mockResolvedValue([{ ...maturedMarket, yt: null, sy: null }]);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [maturedPosition()] }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    expect(targets.eligibleMarketCount).toBe(1);
    expect(targets.skipped).toEqual([{ market: MATURED_ADDR, reason: "unbindable_yt" }]);
    expect(describePendleClaimSkips(targets)).toContain(MATURED_ADDR);
  });

  it("an ACTIVE row wins when an address appears in both catalogues", async () => {
    const activeTwin = { ...maturedMarket, name: "still-active", expiry: "2027-12-30T00:00:00.000Z" };
    mockGetActiveMarkets.mockResolvedValue([activeTwin]);
    mockGetInactiveMarketsSweep.mockResolvedValue([maturedMarket]);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [maturedPosition()] }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);
    expect(targets.selectedMarketCount).toBe(1);
  });
});
