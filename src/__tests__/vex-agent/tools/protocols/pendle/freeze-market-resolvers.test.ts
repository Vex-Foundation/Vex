/**
 * FREEZE LIST — Pendle market resolution, AMENDED ONCE for R5b.
 *
 * WHAT THIS FILE WAS. For tranche 1 it pinned a single rule: the shared
 * resolvers in `market-lookup.ts` are ACTIVE-ONLY, so the read-side work could
 * not reach the mutating lane by accident and unblock a must-revert redeem
 * fallback or a post-expiry LP removal before the execution-safety work landed.
 *
 * WHY IT CHANGED, ONCE, DELIBERATELY. That safety work IS the R5a card, and it
 * landed: the price floor binds every route, gas carries headroom, slippage is
 * rejected rather than clamped, and the `redeemPyToSy` fallback is gated on
 * proven maturity. The reason for the blanket freeze is therefore spent, and
 * keeping it would permanently strand the core fixed-yield product case — a
 * matured PT resolving to nothing, so `pendle.pt.redeem` cannot redeem
 * (G-02/D18). The R5b plan sanctions THIS file as the one amendment.
 *
 * WHAT IT PINS NOW: a MATRIX, cell by cell, in both directions.
 *
 *   | action                            | financial resolver    | on a matured market |
 *   |-----------------------------------|-----------------------|---------------------|
 *   | pt.redeem (quote/identity/execute) | active-then-inactive  | PROCEEDS            |
 *   | lp.remove (quote/identity/execute) | active-then-inactive  | PROCEEDS            |
 *   | claim (target selection)           | active-then-inactive  | INCLUDED            |
 *   | pt.buy / yt.buy / yt.sell          | ACTIVE-ONLY           | refuses BY NAME     |
 *   | py.mint / lp.add                   | ACTIVE-ONLY           | refuses BY NAME     |
 *   | pt.sell / py.redeem                | ACTIVE-ONLY           | refuses BY NAME     |
 *
 * The two lanes stay physically separate: `market-lookup.ts` never learns about
 * maturity, and the matured-capable resolver lives in its own module that only
 * the three exit actions import. The named refusals are sourced from the
 * READ-ONLY classification lane, which returns TEXT and therefore cannot feed a
 * quote output, a prequote identity, or an execution parameter.
 *
 * This is STILL a characterization test. If a future change makes it fail, that
 * change is a money-path behavior change and needs its own approval — do not
 * "fix" this file to match it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleMarket } from "@tools/pendle/types.js";

import { ErrorCodes } from "../../../../../errors.js";

const mockGetActiveMarkets = vi.fn();
const mockGetInactiveMarkets = vi.fn();
const mockClient = {
  getActiveMarkets: (...a: unknown[]) => mockGetActiveMarkets(...a),
  getInactiveMarkets: (...a: unknown[]) => mockGetInactiveMarkets(...a),
};
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => mockClient,
}));

const {
  resolveMarketByAddress,
  resolveMarketByPt,
  resolveMarketByYt,
  resolveYtForPt,
} = await import("@vex-agent/tools/protocols/pendle/market-lookup.js");
const {
  resolveExitMarketByAddress,
  resolveExitMarketByPt,
  resolveExitYtForPt,
} = await import("@vex-agent/tools/protocols/pendle/matured-market-lookup.js");

const CHAIN_ID = 1;
const NOW = new Date("2026-07-27T12:00:00.000Z");

function market(overrides: Partial<PendleMarket> & Pick<PendleMarket, "address">): PendleMarket {
  return {
    name: null,
    expiry: null,
    pt: null,
    yt: null,
    sy: null,
    underlyingAsset: null,
    details: {
      liquidity: null,
      impliedApy: null,
      pendleApy: null,
      aggregatedApy: null,
      maxBoostedApy: null,
      feeRate: null,
    },
    categoryIds: [],
    isNew: false,
    isPrime: false,
    ...overrides,
  };
}

/**
 * Live chain-1 identities (captured 2026-07-27):
 *   ACTIVE  — wstETH, expiry 2027-12-30, present in /v2/markets/all?isActive=true
 *   MATURED — srUSDe, expiry 2026-04-02, present ONLY under isActive=false
 * `getActiveMarkets` serves the active list and `getInactiveMarkets` the matured
 * one, exactly as the live endpoints do.
 */
const ACTIVE = market({
  address: "0x34280882267ffa6383b363e278b027be083bbe3b",
  name: "wstETH",
  expiry: "2027-12-30T00:00:00.000Z",
  pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
  yt: "0x8f6c0cc0e0b6bda9b2ea67c1b8a1a6d3f2d94ef8",
});

const MATURED_PT = "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375";
const MATURED_YT = "0x31f9e6692e87d81ff8d64de1f475fce6880a030f";
const MATURED_MARKET = "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654";
const MATURED = market({
  address: MATURED_MARKET,
  name: "srUSDe",
  expiry: "2026-04-02T00:00:00.000Z",
  pt: MATURED_PT,
  yt: MATURED_YT,
  sy: "0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e",
  underlyingAsset: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveMarkets.mockResolvedValue([ACTIVE]);
  mockGetInactiveMarkets.mockResolvedValue([MATURED]);
});

// ── Lane 1: the frozen active-only resolver, unchanged ───────────────

describe("FREEZE: market-lookup.ts stays ACTIVE-ONLY (buy / sell / mint / add / py.redeem)", () => {
  it("reads ONLY the active-markets endpoint — it has grown no second source", async () => {
    await resolveMarketByPt(CHAIN_ID, ACTIVE.pt!);

    expect(mockGetActiveMarkets).toHaveBeenCalledWith(CHAIN_ID);
    // The matured catalogue exists on the client now, but THIS module must never
    // reach for it: that is the whole reason the exit resolver is a separate
    // module rather than a flag.
    expect(mockGetInactiveMarkets).not.toHaveBeenCalled();
  });

  it("resolveMarketByPt does NOT resolve a matured PT", async () => {
    await expect(resolveMarketByPt(CHAIN_ID, MATURED_PT)).resolves.toBeNull();
  });

  it("resolveMarketByYt does NOT resolve a matured YT", async () => {
    await expect(resolveMarketByYt(CHAIN_ID, MATURED_YT)).resolves.toBeNull();
  });

  it("resolveMarketByAddress does NOT resolve a matured market", async () => {
    await expect(resolveMarketByAddress(CHAIN_ID, MATURED_MARKET)).resolves.toBeNull();
  });

  it("resolveYtForPt yields null for a matured PT", async () => {
    await expect(resolveYtForPt(CHAIN_ID, MATURED_PT)).resolves.toBeNull();
  });

  it("still resolves ACTIVE markets by address / PT / YT (case-insensitively)", async () => {
    await expect(resolveMarketByAddress(CHAIN_ID, ACTIVE.address.toUpperCase())).resolves.toEqual(ACTIVE);
    await expect(resolveMarketByPt(CHAIN_ID, ACTIVE.pt!.toUpperCase())).resolves.toEqual(ACTIVE);
    await expect(resolveMarketByYt(CHAIN_ID, ACTIVE.yt!.toUpperCase())).resolves.toEqual(ACTIVE);
    await expect(resolveYtForPt(CHAIN_ID, ACTIVE.pt!)).resolves.toBe(ACTIVE.yt);
  });

  it("has no maturity logic of its own — the gate is the ENDPOINT", async () => {
    // Pins WHY the split works: a matured row served by the active endpoint would
    // resolve here, so this module can never be made matured-aware by reusing it.
    const maturedRow = market({ address: MATURED_MARKET, pt: MATURED_PT, yt: MATURED_YT, expiry: "2026-04-02T00:00:00.000Z" });
    mockGetActiveMarkets.mockResolvedValue([maturedRow]);

    await expect(resolveMarketByAddress(CHAIN_ID, MATURED_MARKET)).resolves.toEqual(maturedRow);
  });
});

// ── Lane 2: the exit resolver, matured-capable ───────────────────────

describe("MATRIX: the three EXIT actions resolve matured markets", () => {
  it("pt.redeem — the matured PT resolves, flagged 'matured'", async () => {
    await expect(resolveExitMarketByPt(CHAIN_ID, MATURED_PT, NOW)).resolves.toEqual({
      market: MATURED,
      maturity: "matured",
    });
  });

  it("pt.redeem identity — the matured PT's YT resolves, so quote and gate still collide", async () => {
    await expect(resolveExitYtForPt(CHAIN_ID, MATURED_PT, NOW)).resolves.toBe(MATURED_YT);
  });

  it("lp.remove — the matured market resolves by address", async () => {
    await expect(resolveExitMarketByAddress(CHAIN_ID, MATURED_MARKET, NOW)).resolves.toMatchObject({
      maturity: "matured",
    });
  });

  it("claim — the matured market resolves for target selection", async () => {
    const resolved = await resolveExitMarketByAddress(CHAIN_ID, MATURED_MARKET, NOW);
    expect(resolved?.market.sy).toBe(MATURED.sy);
  });

  it("an ACTIVE market still resolves through the exit lane, flagged 'active'", async () => {
    await expect(resolveExitMarketByPt(CHAIN_ID, ACTIVE.pt!, NOW)).resolves.toEqual({
      market: ACTIVE,
      maturity: "active",
    });
  });

  it("the exit lane does NOT pay for the matured catalogue when active answers", async () => {
    await resolveExitMarketByPt(CHAIN_ID, ACTIVE.pt!, NOW);
    expect(mockGetInactiveMarkets).not.toHaveBeenCalled();
  });
});

// ── The inactive-row trust rule, in both directions ──────────────────

describe("MATRIX: an inactive row is believed ONLY on a parseable, past expiry", () => {
  async function expectRefusal(run: () => Promise<unknown>, match: RegExp): Promise<void> {
    await run().then(
      () => { throw new Error("expected a named refusal"); },
      (err: { code?: string; message?: string; hint?: string }) => {
        expect(err.code).toBe(ErrorCodes.PENDLE_MARKET_NOT_FOUND);
        expect(`${err.message} ${err.hint ?? ""}`).toMatch(match);
      },
    );
  }

  it("REFUSES an inactive row with no expiry", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: null })]);
    await expectRefusal(() => resolveExitMarketByPt(CHAIN_ID, MATURED_PT, NOW), /expiry/i);
  });

  it("REFUSES an inactive row with an unparseable expiry", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: "not-a-date" })]);
    await expectRefusal(() => resolveExitMarketByPt(CHAIN_ID, MATURED_PT, NOW), /expiry/i);
  });

  it("REFUSES an inactive row whose expiry is still in the future", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: "2027-12-30T00:00:00.000Z" })]);
    await expectRefusal(() => resolveExitMarketByPt(CHAIN_ID, MATURED_PT, NOW), /not matured/i);
  });

  it("the same rule applies to the by-address (lp.remove / claim) lane", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: null })]);
    await expectRefusal(() => resolveExitMarketByAddress(CHAIN_ID, MATURED_MARKET, NOW), /expiry/i);
  });

  it("an absent address is null, NOT a refusal — absence and untrustworthiness differ", async () => {
    await expect(resolveExitMarketByPt(CHAIN_ID, "0xdead000000000000000000000000000000000000", NOW)).resolves.toBeNull();
  });
});

// ── The refusal lane cannot become a resolution lane ─────────────────

describe("MATRIX: the read-only classification lane names refusals and nothing else", () => {
  it("exports ONLY a text explainer — no market object can reach a money path", async () => {
    const mod = await import("@vex-agent/tools/protocols/pendle/matured-refusal.js");
    expect(Object.keys(mod).sort()).toEqual(["explainUnresolvedPendleMarket"]);
  });

  it("the active-only resolver and the exit resolver are DIFFERENT modules", async () => {
    // A single module with a boolean would put the safety of ten call sites on
    // remembering to pass `false`. Pinning the separation keeps the default safe.
    const frozen = await import("@vex-agent/tools/protocols/pendle/market-lookup.js");
    const exit = await import("@vex-agent/tools/protocols/pendle/matured-market-lookup.js");
    expect(Object.keys(frozen)).not.toContain("resolveExitMarketByPt");
    expect(Object.keys(exit)).not.toContain("resolveMarketByPt");
  });
});
