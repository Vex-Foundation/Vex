/**
 * `pendle.claim` reports what it does NOT claim (2026-07-25).
 *
 * The sweep is capped at 10 markets per transaction (a real gas bound — one
 * `redeemDueInterestAndRewardsV2` carries every leg), but it used to `break`
 * at the cap and report neither the eligible total nor which markets were
 * dropped, while the manifest promised "every held market on the chain".
 * Because selection order is the provider's stable position order, markets
 * past the cap were unreachable by repeating the call.
 *
 * These tests pin the HONEST ACCOUNTING (eligible total + the exact skipped
 * set + the reachable path), not the cap value.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleMarket, PendleMarketPosition } from "@tools/pendle/types.js";

const mockGetPositions = vi.fn();
const mockGetActiveMarkets = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    getPositions: (...a: unknown[]) => mockGetPositions(...a),
    getActiveMarkets: (...a: unknown[]) => mockGetActiveMarkets(...a),
  }),
}));

const {
  MAX_CLAIM_MARKETS,
  buildPendleClaimTargets,
  describePendleClaimSkips,
} = await import("@vex-agent/tools/protocols/pendle/claim-targets.js");

const CHAIN_ID = 1;
const WALLET = "0x1111111111111111111111111111111111111111";

/** Deterministic per-index market address, e.g. index 3 → 0x...03. */
function marketAddress(i: number): string {
  return `0x${String(i).padStart(2, "0").repeat(20)}`.slice(0, 42);
}

function market(i: number, overrides: Partial<PendleMarket> = {}): PendleMarket {
  const address = marketAddress(i);
  return {
    address,
    name: `market-${i}`,
    expiry: "2027-01-01T00:00:00.000Z",
    pt: `${address}pt`,
    yt: `${address}yt`,
    sy: `${address}sy`,
    underlyingAsset: `${address}ua`,
    details: {} as PendleMarket["details"],
    categoryIds: [],
    isNew: false,
    isPrime: false,
    ...overrides,
  };
}

function ytPosition(i: number): PendleMarketPosition {
  return {
    marketId: `${CHAIN_ID}-${marketAddress(i)}`,
    pt: null,
    yt: { balance: "1000", valuationUsd: 10 },
    lp: null,
  };
}

/** 14 markets, all with a claimable YT balance — 4 past the cap of 10. */
function fourteenEligible(): { markets: PendleMarket[]; positions: PendleMarketPosition[] } {
  const indices = Array.from({ length: 14 }, (_, i) => i + 1);
  return {
    markets: indices.map((i) => market(i)),
    positions: indices.map((i) => ytPosition(i)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPendleClaimTargets — honest accounting past the cap", () => {
  it("reports the FULL eligible total and every market it left out, not just what it took", async () => {
    const { markets, positions } = fourteenEligible();
    mockGetActiveMarkets.mockResolvedValue(markets);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: positions }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    // The denominator is the truth, not the cap.
    expect(targets.eligibleMarketCount).toBe(14);
    expect(targets.selectedMarketCount).toBe(MAX_CLAIM_MARKETS);
    expect(targets.marketCap).toBe(MAX_CLAIM_MARKETS);
    // The exact skipped set, in selection order — markets 11..14.
    expect(targets.skipped).toEqual([11, 12, 13, 14].map((i) => ({
      market: marketAddress(i).toLowerCase(),
      reason: "market_cap",
    })));
    expect(targets.intendedYts.size).toBe(MAX_CLAIM_MARKETS);
  });

  it("names the reachable path for a capped market — repeating the call cannot reach it", async () => {
    const { markets, positions } = fourteenEligible();
    mockGetActiveMarkets.mockResolvedValue(markets);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: positions }]);

    const note = describePendleClaimSkips(await buildPendleClaimTargets(CHAIN_ID, WALLET, null));

    expect(note).toContain("10 of 14 eligible markets");
    expect(note).toContain(marketAddress(11).toLowerCase());
    expect(note).toContain("`market` param");
  });

  it("says nothing extra when every eligible market fits in one claim", async () => {
    mockGetActiveMarkets.mockResolvedValue([market(1), market(2)]);
    mockGetPositions.mockResolvedValue([
      { chainId: CHAIN_ID, openPositions: [ytPosition(1), ytPosition(2)] },
    ]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    expect(targets.eligibleMarketCount).toBe(2);
    expect(targets.selectedMarketCount).toBe(2);
    expect(targets.skipped).toEqual([]);
    expect(describePendleClaimSkips(targets)).toBeNull();
  });

  it("counts LP-only positions as eligible and claims their market rewards", async () => {
    mockGetActiveMarkets.mockResolvedValue([market(1)]);
    mockGetPositions.mockResolvedValue([{
      chainId: CHAIN_ID,
      openPositions: [{
        marketId: `${CHAIN_ID}-${marketAddress(1)}`,
        pt: null, yt: null, lp: { balance: "5", valuationUsd: 1 },
      }],
    }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    expect(targets.eligibleMarketCount).toBe(1);
    expect(targets.intendedMarkets.has(marketAddress(1).toLowerCase())).toBe(true);
    expect(targets.intendedYts.size).toBe(0);
    expect(targets.skipped).toEqual([]);
  });

  it("does not count zero-balance or unknown-market positions as eligible", async () => {
    mockGetActiveMarkets.mockResolvedValue([market(1)]);
    mockGetPositions.mockResolvedValue([{
      chainId: CHAIN_ID,
      openPositions: [
        { marketId: `${CHAIN_ID}-${marketAddress(1)}`, pt: null, yt: { balance: "0", valuationUsd: 0 }, lp: null },
        { marketId: `${CHAIN_ID}-${marketAddress(9)}`, pt: null, yt: { balance: "7", valuationUsd: 1 }, lp: null },
      ],
    }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    expect(targets.eligibleMarketCount).toBe(0);
    expect(targets.skipped).toEqual([]);
  });

  it("reports a fail-closed unbindable YT market instead of dropping it silently", async () => {
    mockGetActiveMarkets.mockResolvedValue([market(1, { sy: null })]);
    mockGetPositions.mockResolvedValue([{ chainId: CHAIN_ID, openPositions: [ytPosition(1)] }]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, null);

    expect(targets.eligibleMarketCount).toBe(1);
    expect(targets.selectedMarketCount).toBe(0);
    expect(targets.intendedYts.size).toBe(0); // still fail-closed
    expect(targets.skipped).toEqual([{ market: marketAddress(1).toLowerCase(), reason: "unbindable_yt" }]);
    expect(describePendleClaimSkips(targets)).toContain("YT interest was NOT claimed");
  });
});

describe("buildPendleClaimTargets — explicit market escape hatch", () => {
  it("scopes to the requested market with NO cap in force", async () => {
    mockGetActiveMarkets.mockResolvedValue([market(11)]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, marketAddress(11));

    expect(targets.marketCap).toBeNull();
    expect(targets.eligibleMarketCount).toBe(1);
    expect(targets.selectedMarketCount).toBe(1);
    expect(targets.intendedMarkets.has(marketAddress(11).toLowerCase())).toBe(true);
    expect(targets.intendedYts.size).toBe(1);
    expect(mockGetPositions).not.toHaveBeenCalled();
  });

  it("says the market is not active on this chain instead of 'nothing to claim'", async () => {
    mockGetActiveMarkets.mockResolvedValue([market(1)]);

    const targets = await buildPendleClaimTargets(CHAIN_ID, WALLET, marketAddress(99));

    expect(targets.intendedYts.size).toBe(0);
    expect(targets.intendedMarkets.size).toBe(0);
    expect(targets.skipped).toEqual([{ market: marketAddress(99).toLowerCase(), reason: "market_not_found" }]);
    expect(describePendleClaimSkips(targets)).toContain("not an active Pendle market");
  });
});
