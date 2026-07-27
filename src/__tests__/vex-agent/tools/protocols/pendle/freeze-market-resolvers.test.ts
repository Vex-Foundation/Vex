/**
 * FREEZE LIST — the shared market resolvers in `protocols/pendle/market-lookup.ts`
 * stay ACTIVE-ONLY (Pendle tranche 1, plan §3).
 *
 * These resolvers are the single lookup for every MUTATING Pendle handler
 * (pt/yt/lp/py/shared/claim-targets) and for the prequote redeem identity. Making
 * them see matured markets would silently unblock `pt.redeem`'s must-revert
 * fallback and post-expiry `lp.remove` before the execution-safety work (G-40)
 * lands — a behavior change on a money path, deliberately deferred to T2.
 *
 * This file is a CHARACTERIZATION test: it asserts TODAY's behavior so the
 * read-side work (`market-read.ts`, which DOES resolve matured markets) cannot
 * reach the mutating lane by accident. If a future change makes these fail, that
 * change is a money-path behavior change and needs its own approval — do not
 * "fix" this file to match it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleMarket } from "@tools/pendle/types.js";

const mockGetActiveMarkets = vi.fn();
const mockClient = {
  getActiveMarkets: (...a: unknown[]) => mockGetActiveMarkets(...a),
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

const CHAIN_ID = 1;

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
 * `getActiveMarkets` serves the active list, exactly as the live endpoint does.
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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveMarkets.mockResolvedValue([ACTIVE]);
});

describe("FREEZE: mutating market resolvers are active-only", () => {
  it("reads ONLY the active-markets endpoint — no inactive/matured fetch exists", async () => {
    await resolveMarketByPt(CHAIN_ID, ACTIVE.pt!);

    expect(mockGetActiveMarkets).toHaveBeenCalledWith(CHAIN_ID);
    // Any other client method appearing here means the resolver grew a second
    // source — the exact change plan §3 freezes for T1.
    expect(Object.keys(mockClient)).toEqual(["getActiveMarkets"]);
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

  it("resolveYtForPt yields null for a matured PT (the redeem-identity path)", async () => {
    await expect(resolveYtForPt(CHAIN_ID, MATURED_PT)).resolves.toBeNull();
  });

  it("still resolves ACTIVE markets by address / PT / YT (case-insensitively)", async () => {
    await expect(resolveMarketByAddress(CHAIN_ID, ACTIVE.address.toUpperCase())).resolves.toEqual(ACTIVE);
    await expect(resolveMarketByPt(CHAIN_ID, ACTIVE.pt!.toUpperCase())).resolves.toEqual(ACTIVE);
    await expect(resolveMarketByYt(CHAIN_ID, ACTIVE.yt!.toUpperCase())).resolves.toEqual(ACTIVE);
    await expect(resolveYtForPt(CHAIN_ID, ACTIVE.pt!)).resolves.toBe(ACTIVE.yt);
  });

  it("a matured market served by the ACTIVE endpoint would resolve — the gate is the endpoint, not an expiry check", async () => {
    // Pins WHY the freeze holds: these resolvers have no maturity logic of their
    // own. `market-read.ts` therefore cannot make them matured-aware by reusing
    // them; it must (and does) read its own catalogue.
    const maturedRow = market({ address: MATURED_MARKET, pt: MATURED_PT, yt: MATURED_YT, expiry: "2026-04-02T00:00:00.000Z" });
    mockGetActiveMarkets.mockResolvedValue([maturedRow]);

    await expect(resolveMarketByAddress(CHAIN_ID, MATURED_MARKET)).resolves.toEqual(maturedRow);
  });
});
