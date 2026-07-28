/**
 * `resolveMarketForRead` — the READ lane's market resolver.
 *
 * The one behaviour that matters here is the one the money path must NOT have:
 * a MATURED market resolves, with `matured: true`, while the frozen mutating
 * resolvers in `market-lookup.ts` still cannot see it (G-02/G-18). Both halves
 * are asserted against the same live identity, in the same file, so the two
 * lanes can never quietly converge.
 *
 * Live coordinates (chain 1, captured 2026-07-27):
 *   MATURED  srUSDe  market 0xafb7d6…9654, expiry 2026-04-02 — isActive=false only
 *   ACTIVE   wstETH  market 0x342808…be3b, expiry 2027-12-30
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleReadMarket, PendleReadMarketCatalog } from "@tools/pendle/read/types.js";

const mockListMarkets = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({
    listMarkets: (...a: unknown[]) => mockListMarkets(...a),
  }),
}));

const mockGetActiveMarkets = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    getActiveMarkets: (...a: unknown[]) => mockGetActiveMarkets(...a),
  }),
}));

const { resolveMarketForRead } = await import("@vex-agent/tools/protocols/pendle/market-read.js");
const { resolveMarketByAddress, resolveMarketByPt } = await import(
  "@vex-agent/tools/protocols/pendle/market-lookup.js"
);

const CHAIN_ID = 1;
const NOW = Date.parse("2026-07-27T00:00:00.000Z");

function readMarket(overrides: Partial<PendleReadMarket> & Pick<PendleReadMarket, "address">): PendleReadMarket {
  return {
    chainId: CHAIN_ID,
    name: null,
    protocol: null,
    expiry: null,
    pt: null,
    yt: null,
    sy: null,
    underlyingAsset: null,
    accountingAsset: null,
    details: {
      liquidityUsd: null,
      totalTvlUsd: null,
      tradingVolumeUsd: null,
      impliedApy: null,
      underlyingApy: null,
      pendleApy: null,
      aggregatedApy: null,
      maxBoostedApy: null,
      ytFloatingApy: null,
      swapFeeApy: null,
      feeRate: null,
      ptRoi: null,
      ytRoi: null,
    },
    categoryIds: [],
    isNew: false,
    isPrime: false,
    ...overrides,
  };
}

const MATURED = readMarket({
  address: "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
  name: "srUSDe",
  expiry: "2026-04-02T00:00:00.000Z",
  pt: "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375",
  yt: "0x31f9e6692e87d81ff8d64de1f475fce6880a030f",
});

const ACTIVE = readMarket({
  address: "0x34280882267ffa6383b363e278b027be083bbe3b",
  name: "wstETH",
  expiry: "2027-12-30T00:00:00.000Z",
  pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
  yt: "0x8f6c0cc0e0b6bda9b2ea67c1b8a1a6d3f2d94ef8",
});

function catalog(markets: PendleReadMarket[], complete = true): PendleReadMarketCatalog {
  return { markets, total: markets.length, complete, pagesFetched: 1 };
}

/**
 * Serve the read client the way the live endpoint does: `ids` resolves either
 * maturity in one call, `isActive:true` sees only the active market and
 * `isActive:false` only the matured one.
 */
function installLiveShapedCatalog(): void {
  mockListMarkets.mockImplementation((query: Record<string, unknown>) => {
    const ids = query.ids as readonly string[] | undefined;
    if (ids !== undefined) {
      const wanted = new Set(ids.map((id) => id.toLowerCase()));
      const hit = [MATURED, ACTIVE].filter((m) => wanted.has(`${m.chainId}-${m.address}`));
      return Promise.resolve(catalog(hit));
    }
    if (query.isActive === true) return Promise.resolve(catalog([ACTIVE]));
    if (query.isActive === false) return Promise.resolve(catalog([MATURED]));
    return Promise.resolve(catalog([ACTIVE, MATURED]));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installLiveShapedCatalog();
  // The money-path client only ever serves the active list.
  mockGetActiveMarkets.mockResolvedValue([
    { address: ACTIVE.address, pt: ACTIVE.pt, yt: ACTIVE.yt, expiry: ACTIVE.expiry },
  ]);
});

describe("resolveMarketForRead", () => {
  it("resolves a MATURED market by its address, with matured: true", async () => {
    const lookup = await resolveMarketForRead(CHAIN_ID, MATURED.address, NOW);

    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.market.address).toBe(MATURED.address);
    expect(lookup.matured).toBe(true);
    expect(lookup.matchedBy).toBe("market");
    expect(lookup.market.pt).toBe(MATURED.pt);
    expect(lookup.market.yt).toBe(MATURED.yt);
  });

  it("the SAME matured market does NOT resolve through the frozen mutating resolvers", async () => {
    await expect(resolveMarketByAddress(CHAIN_ID, MATURED.address)).resolves.toBeNull();
    await expect(resolveMarketByPt(CHAIN_ID, MATURED.pt!)).resolves.toBeNull();

    // …and the read lane never reaches the money path's client to get there.
    await resolveMarketForRead(CHAIN_ID, MATURED.address, NOW);
    expect(mockGetActiveMarkets).toHaveBeenCalledTimes(2); // only the two frozen calls above
  });

  it("resolves an ACTIVE market with matured: false", async () => {
    const lookup = await resolveMarketForRead(CHAIN_ID, ACTIVE.address, NOW);

    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    expect(lookup.matured).toBe(false);
    expect(lookup.market.name).toBe("wstETH");
  });

  it("resolves by PT and by YT, reporting which leg matched", async () => {
    const byPt = await resolveMarketForRead(CHAIN_ID, MATURED.pt!, NOW);
    expect(byPt.status).toBe("found");
    if (byPt.status === "found") {
      expect(byPt.market.address).toBe(MATURED.address);
      expect(byPt.matchedBy).toBe("pt");
      expect(byPt.matured).toBe(true);
    }

    const byYt = await resolveMarketForRead(CHAIN_ID, ACTIVE.yt!, NOW);
    expect(byYt.status).toBe("found");
    if (byYt.status === "found") {
      expect(byYt.market.address).toBe(ACTIVE.address);
      expect(byYt.matchedBy).toBe("yt");
      expect(byYt.matured).toBe(false);
    }
  });

  it("is case-insensitive on the address it is given (checksummed form)", async () => {
    const checksummed = `0x${MATURED.address.slice(2).toUpperCase()}`;
    const lookup = await resolveMarketForRead(CHAIN_ID, checksummed, NOW);
    expect(lookup.status).toBe("found");
  });

  it("tries ACTIVE before INACTIVE, so a live market costs one catalogue read", async () => {
    await resolveMarketForRead(CHAIN_ID, ACTIVE.pt!, NOW);

    const scopes = mockListMarkets.mock.calls.map((c) => (c[0] as { isActive?: boolean }).isActive);
    expect(scopes).toEqual([undefined, true]); // ids probe, then the active scan — never the inactive one
  });

  it("reports NOT FOUND for an address Pendle does not know", async () => {
    const lookup = await resolveMarketForRead(CHAIN_ID, "0x1111111111111111111111111111111111111111", NOW);
    expect(lookup).toEqual({ status: "not_found" });
  });

  it("refuses to say NOT FOUND when the catalogue walk was incomplete", async () => {
    // The page budget ran out, so absence is unproven. Reporting "no such
    // market" here would be claiming more than the evidence supports.
    mockListMarkets.mockImplementation((query: Record<string, unknown>) => {
      if (query.ids !== undefined) return Promise.resolve(catalog([]));
      return Promise.resolve({ markets: [ACTIVE], total: 900, complete: false, pagesFetched: 12 });
    });

    const lookup = await resolveMarketForRead(CHAIN_ID, MATURED.pt!, NOW);
    expect(lookup).toEqual({ status: "indeterminate", reason: "catalog_page_budget_exhausted" });
  });

  it("treats an unparseable expiry as UNKNOWN maturity, falling back to the catalogue scope", async () => {
    const noExpiry = readMarket({ address: MATURED.address, expiry: null, pt: MATURED.pt, yt: MATURED.yt });
    mockListMarkets.mockImplementation((query: Record<string, unknown>) => {
      if (query.ids !== undefined) return Promise.resolve(catalog([]));
      if (query.isActive === true) return Promise.resolve(catalog([]));
      return Promise.resolve(catalog([noExpiry]));
    });

    const lookup = await resolveMarketForRead(CHAIN_ID, MATURED.address, NOW);
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") return;
    // Found only in the inactive catalogue ⇒ matured, even with no expiry to read.
    expect(lookup.matured).toBe(true);
    expect(lookup.catalogScope).toBe("inactive");
  });

  it("trusts the EXPIRY over the provider's active flag when they disagree", async () => {
    // A past-expiry row served by the active filter is still matured: expiry is
    // an on-chain fact, `isActive` is the provider's opinion.
    mockListMarkets.mockImplementation((query: Record<string, unknown>) => {
      if (query.ids !== undefined) return Promise.resolve(catalog([MATURED]));
      return Promise.resolve(catalog([MATURED]));
    });

    const lookup = await resolveMarketForRead(CHAIN_ID, MATURED.address, NOW);
    expect(lookup.status).toBe("found");
    if (lookup.status === "found") expect(lookup.matured).toBe(true);
  });

  it("rejects a malformed address before any network call", async () => {
    await expect(resolveMarketForRead(CHAIN_ID, "not-an-address", NOW)).rejects.toThrow();
    expect(mockListMarkets).not.toHaveBeenCalled();
  });
});
