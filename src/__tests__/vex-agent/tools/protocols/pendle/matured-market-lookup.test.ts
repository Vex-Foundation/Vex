/**
 * The MATURED-CAPABLE financial resolver (R5b, G-02 / D18).
 *
 * `market-lookup.ts` stays ACTIVE-ONLY and frozen. This is its deliberate,
 * separately-named counterpart: the only financial resolver allowed to return a
 * matured market, importable ONLY by the three exit actions the R5b matrix
 * permits (pt.redeem, lp.remove, claim). Keeping it in its own module is the
 * safety property — a handler cannot resolve a matured market by accident, it
 * has to import a module whose name says what it does.
 *
 * THE RULE THAT MAKES AN INACTIVE ROW TRUSTWORTHY: an inactive row resolves ONLY
 * when it carries a PARSEABLE `expiry` that is `<= now`. Missing, unparseable, or
 * still-in-the-future expiry on an inactive row is REFUSED BY NAME — never
 * trusted as matured just because the provider filed it under "inactive".
 * "Inactive" is the provider's bookkeeping; "matured" is an on-chain fact, and
 * only the second one may unlock a redeem.
 *
 * LIVE-VERIFIED 2026-07-27, `GET /v1/1/markets/inactive`: 420 rows, and
 * 420/420 carry a parseable past expiry — zero missing, zero unparseable, zero
 * future. So the refusal cases below CANNOT be captured from the live catalogue
 * today and are constructed in-test on purpose; they guard the day the provider
 * files a row differently, which is exactly when trusting the label would redeem
 * against a live market.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleMarket } from "@tools/pendle/types.js";

import { ErrorCodes } from "../../../../../errors.js";

const mockGetActiveMarkets = vi.fn();
const mockGetInactiveMarkets = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    getActiveMarkets: (...a: unknown[]) => mockGetActiveMarkets(...a),
    getInactiveMarkets: (...a: unknown[]) => mockGetInactiveMarkets(...a),
  }),
}));

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
    details: { liquidity: null, impliedApy: null, pendleApy: null, aggregatedApy: null, maxBoostedApy: null, feeRate: null },
    categoryIds: [],
    isNew: false,
    isPrime: false,
    ...overrides,
  };
}

/** Live chain-1 identities, captured 2026-07-27. */
const ACTIVE = market({
  address: "0x34280882267ffa6383b363e278b027be083bbe3b",
  name: "wstETH",
  expiry: "2027-12-30T00:00:00.000Z",
  pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
  yt: "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95",
});

/** srUSDe — present ONLY under /markets/inactive, expiry 2026-04-02 (past). */
const MATURED = market({
  address: "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
  name: "srUSDe",
  expiry: "2026-04-02T00:00:00.000Z",
  pt: "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375",
  yt: "0x31f9e6692e87d81ff8d64de1f475fce6880a030f",
  sy: "0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e",
  underlyingAsset: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
});

function expectNamedRefusal(p: Promise<unknown>, match: RegExp): Promise<void> {
  return p.then(
    () => {
      throw new Error("expected a named refusal, but the resolver returned");
    },
    (err: { code?: string; message?: string; hint?: string }) => {
      expect(err.code).toBe(ErrorCodes.PENDLE_MARKET_NOT_FOUND);
      expect(`${err.message} ${err.hint ?? ""}`).toMatch(match);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveMarkets.mockResolvedValue([ACTIVE]);
  mockGetInactiveMarkets.mockResolvedValue([MATURED]);
});

describe("active markets resolve first, and never pay for the inactive catalogue", () => {
  it("resolves an ACTIVE market by PT and reports maturity 'active'", async () => {
    const found = await resolveExitMarketByPt(CHAIN_ID, ACTIVE.pt!, NOW);
    expect(found).toEqual({ market: ACTIVE, maturity: "active" });
  });

  it("does NOT fetch the inactive catalogue when the active one answers", async () => {
    // chain 1 carries 61 active rows against 420 matured ones — the ordinary
    // lookup must not pay for the rare one.
    await resolveExitMarketByPt(CHAIN_ID, ACTIVE.pt!, NOW);
    expect(mockGetInactiveMarkets).not.toHaveBeenCalled();
  });

  it("resolves an ACTIVE market by address", async () => {
    const found = await resolveExitMarketByAddress(CHAIN_ID, ACTIVE.address, NOW);
    expect(found?.maturity).toBe("active");
  });

  it("matches case-insensitively, like the frozen resolvers", async () => {
    await expect(resolveExitMarketByPt(CHAIN_ID, ACTIVE.pt!.toUpperCase(), NOW)).resolves.toMatchObject({ maturity: "active" });
    await expect(resolveExitMarketByAddress(CHAIN_ID, ACTIVE.address.toUpperCase(), NOW)).resolves.toMatchObject({ maturity: "active" });
  });
});

describe("a matured market resolves — the case the redeem product exists for", () => {
  it("resolves the matured PT by PT address and reports maturity 'matured'", async () => {
    const found = await resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW);
    expect(found).toEqual({ market: MATURED, maturity: "matured" });
  });

  it("resolves the matured market by its market address (the lp.remove path)", async () => {
    const found = await resolveExitMarketByAddress(CHAIN_ID, MATURED.address, NOW);
    expect(found?.maturity).toBe("matured");
    expect(found?.market.sy).toBe(MATURED.sy);
  });

  it("resolves the YT for a matured PT (the redeem-identity path)", async () => {
    await expect(resolveExitYtForPt(CHAIN_ID, MATURED.pt!, NOW)).resolves.toBe(MATURED.yt);
  });

  it("carries the full bind material a redeem needs (yt, sy, underlying, expiry)", async () => {
    const found = await resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW);
    expect(found?.market).toMatchObject({
      yt: MATURED.yt,
      sy: MATURED.sy,
      underlyingAsset: MATURED.underlyingAsset,
      expiry: "2026-04-02T00:00:00.000Z",
    });
  });
});

describe("an inactive row is trusted ONLY on a parseable, past expiry", () => {
  it("REFUSES an inactive row with NO expiry rather than assuming maturity", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: null })]);
    await expectNamedRefusal(resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW), /expiry/i);
  });

  it("REFUSES an inactive row with an UNPARSEABLE expiry", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: "soon" })]);
    await expectNamedRefusal(resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW), /expiry/i);
  });

  it("REFUSES an inactive row whose expiry is still in the FUTURE", async () => {
    // The dangerous one: the provider files a live market as inactive. Trusting
    // the label would redeem against a market that has not matured.
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: "2027-12-30T00:00:00.000Z" })]);
    await expectNamedRefusal(resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW), /not matured|has not matured/i);
  });

  it("names the market and the expiry it read, so the refusal is actionable", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: "2027-12-30T00:00:00.000Z" })]);
    await resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW).then(
      () => { throw new Error("expected refusal"); },
      (err: { message: string; hint?: string }) => {
        expect(`${err.message} ${err.hint ?? ""}`).toContain("2027-12-30");
      },
    );
  });

  it("resolves at EXACTLY the expiry instant (redemption opens at maturity)", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: NOW.toISOString() })]);
    await expect(resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW)).resolves.toMatchObject({ maturity: "matured" });
  });

  it("refuses one millisecond before expiry", async () => {
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: new Date(NOW.getTime() + 1).toISOString() })]);
    await expectNamedRefusal(resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW), /not matured/i);
  });

  it("an ACTIVE row is NEVER expiry-gated — the active catalogue is the authority there", async () => {
    // An active market legitimately has a future expiry; the gate exists only to
    // decide whether an INACTIVE label may be believed.
    const found = await resolveExitMarketByPt(CHAIN_ID, ACTIVE.pt!, NOW);
    expect(found?.maturity).toBe("active");
  });
});

describe("absence stays absence", () => {
  it("returns null for an address in neither catalogue", async () => {
    await expect(resolveExitMarketByPt(CHAIN_ID, "0xdead000000000000000000000000000000000000", NOW)).resolves.toBeNull();
    await expect(resolveExitMarketByAddress(CHAIN_ID, "0xdead000000000000000000000000000000000000", NOW)).resolves.toBeNull();
    await expect(resolveExitYtForPt(CHAIN_ID, "0xdead000000000000000000000000000000000000", NOW)).resolves.toBeNull();
  });

  it("a null (absent) answer is distinct from a refusal (present but untrustworthy)", async () => {
    // Absent → null, so the caller can say "not a Pendle PT".
    await expect(resolveExitMarketByPt(CHAIN_ID, "0xdead000000000000000000000000000000000000", NOW)).resolves.toBeNull();
    // Present with a bad expiry → THROWS, so the caller can never treat an
    // untrustworthy row as simple absence and fall through to another path.
    mockGetInactiveMarkets.mockResolvedValue([market({ ...MATURED, expiry: null })]);
    await expectNamedRefusal(resolveExitMarketByPt(CHAIN_ID, MATURED.pt!, NOW), /expiry/i);
  });
});
