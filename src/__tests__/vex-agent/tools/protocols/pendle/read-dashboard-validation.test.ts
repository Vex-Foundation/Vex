/**
 * The read-lane dashboard validator, against two NON-EMPTY live wallets.
 *
 * The point of every case here is a field family the FROZEN money-path validator
 * drops. Each one costs something concrete: a YT position the agent can open but
 * never see, a claim preview with no numbers in it, SY holdings that do not
 * exist as far as the portfolio is concerned, an LP staked split that makes the
 * balance look wrong, and a data age that turned out to be 364 days.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";
import {
  PENDLE_DASHBOARD_ACTIVE_YT,
  PENDLE_DASHBOARD_FILTERED,
  PENDLE_DASHBOARD_MATURED,
} from "./dashboard-fixtures.js";
import { validatePendleDashboardPositions } from "@tools/pendle/read/validation/dashboard.js";
import { validatePositions } from "@tools/pendle/validation.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

const MATURED_MARKET = "0xafdc922d0059147486cc1f0f32e3a2354b0d35cc";

describe("validatePendleDashboardPositions — the fields the money path drops", () => {
  it("keeps NON-ZERO YT legs, which the frozen validator keeps and the projector discarded", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const ytLegs = chains.flatMap((c) => c.open.map((p) => p.yt)).filter((leg) => leg !== null);

    expect(ytLegs.length).toBeGreaterThan(0);
    for (const leg of ytLegs) expect(leg.balanceRaw).toMatch(/^[1-9]\d*$/);
  });

  it("keeps claimTokenAmounts as strict token + raw amount pairs", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const claimable = chains.flatMap((c) =>
      c.open.flatMap((p) => [p.pt, p.yt, p.lp].flatMap((leg) => leg?.claimable ?? [])),
    );

    expect(claimable.length).toBeGreaterThan(0);
    for (const entry of claimable) {
      expect(entry.token).toMatch(/^0x[0-9a-f]{40}$/);
      expect(entry.amountRaw).toMatch(/^\d+$/);
    }
  });

  it("keeps syPositions, which are invisible today", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const sy = chains.flatMap((c) => c.sy);

    expect(sy.length).toBeGreaterThan(0);
    for (const entry of sy) {
      expect(entry.sy).toMatch(/^0x[0-9a-f]{40}$/);
      expect(entry.balanceRaw).toMatch(/^[1-9]\d*$/);
    }
  });

  it("keeps the LP activeBalance split, and it really is a FRACTION of the balance", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const withSplit = chains
      .flatMap((c) => c.open.map((p) => p.lp))
      .filter((leg) => leg !== null && leg.activeBalanceRaw !== null && leg.activeBalanceRaw !== leg.balanceRaw);

    expect(withSplit.length).toBeGreaterThan(0);
    for (const leg of withSplit) {
      expect(BigInt(leg.activeBalanceRaw ?? "0")).toBeLessThan(BigInt(leg.balanceRaw));
    }
  });

  it("keeps updatedAt — the live wallets were 56 and 364 days stale", () => {
    const active = validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const matured = validatePendleDashboardPositions(PENDLE_DASHBOARD_MATURED);

    for (const chain of [...active.chains, ...matured.chains]) {
      expect(chain.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    const capture = Date.parse("2026-07-27T00:00:00.000Z");
    const oldest = Math.min(...matured.chains.map((c) => Date.parse(c.updatedAt ?? "")));
    expect((capture - oldest) / 86_400_000).toBeGreaterThan(300);
  });

  it("keeps the provider's own counts so our row count stays checkable", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_MATURED);
    const chain1 = chains.find((c) => c.chainId === 1);

    expect(chain1?.totalOpen).toBe(4);
    expect(chain1?.totalClosed).toBe(3);
    expect(chain1?.totalSy).toBe(1);
  });

  it("carries the matured market's live PT, YT and LP legs together", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_MATURED);
    const position = chains
      .find((c) => c.chainId === 1)
      ?.open.find((p) => p.market === MATURED_MARKET);

    expect(position?.pt?.balanceRaw).toBe("1056635259419805288");
    expect(position?.yt?.balanceRaw).toBe("18117721582359052161");
    expect(position?.lp?.balanceRaw).toBe("2565304199423659860");
  });
});

describe("validatePendleDashboardPositions — hygiene", () => {
  it("drops zero-balance legs rather than reporting empty positions", () => {
    const { chains } = validatePendleDashboardPositions(PENDLE_DASHBOARD_MATURED);
    const legs = chains.flatMap((c) => c.open.flatMap((p) => [p.pt, p.yt, p.lp]));

    for (const leg of legs) {
      if (leg !== null) expect(leg.balanceRaw).not.toBe("0");
    }
    // The provider returned four open rows on chain 1; all four carry a live leg.
    expect(chains.find((c) => c.chainId === 1)?.open).toHaveLength(4);
  });

  it("drops a claimable whose amount is not raw base units", () => {
    const raw = copy(PENDLE_DASHBOARD_ACTIVE_YT) as {
      positions: Array<{ openPositions: Array<Record<string, { claimTokenAmounts?: unknown[] }>> }>;
    };
    const leg = raw.positions
      .flatMap((c) => c.openPositions)
      .flatMap((p) => [p.pt, p.yt, p.lp])
      .find((l) => Array.isArray(l?.claimTokenAmounts) && l.claimTokenAmounts.length > 0);
    (leg?.claimTokenAmounts as Array<Record<string, unknown>>)[0]!.amount = 4979528302499125531;

    const { chains } = validatePendleDashboardPositions(raw);
    const total = chains.flatMap((c) =>
      c.open.flatMap((p) => [p.pt, p.yt, p.lp].flatMap((l) => l?.claimable ?? [])),
    );
    const original = validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const originalTotal = original.chains.flatMap((c) =>
      c.open.flatMap((p) => [p.pt, p.yt, p.lp].flatMap((l) => l?.claimable ?? [])),
    );
    expect(total).toHaveLength(originalTotal.length - 1);
  });

  it("RAISES when the root is not the documented `{positions: []}` envelope", () => {
    for (const bad of [null, [], { chains: [] }]) {
      expect(() => validatePendleDashboardPositions(bad)).toThrow(VexError);
    }
    try {
      validatePendleDashboardPositions({ chains: [] });
    } catch (err) {
      expect(err).toMatchObject({ code: ErrorCodes.PENDLE_INVALID_RESPONSE });
    }
  });

  it("RAISES when chain entries arrived but none carried a readable chain id", () => {
    expect(() => validatePendleDashboardPositions({ positions: [{ chain: "ethereum" }] })).toThrow(VexError);
  });

  it("returns a determined EMPTY result for a wallet with no Pendle history", () => {
    expect(validatePendleDashboardPositions({ positions: [] })).toEqual({ chains: [] });
  });

  it("reflects the SERVER-side filterUsd rather than filtering locally", () => {
    // Wallet A's four positions are all under $10, so `filterUsd=10` empties the
    // list at the provider. Proving it here keeps `minValueUsd` honest: it is a
    // server-side narrowing the agent asked for, not a client-side dust rule.
    const unfiltered = validatePendleDashboardPositions(PENDLE_DASHBOARD_MATURED);
    const filtered = validatePendleDashboardPositions(PENDLE_DASHBOARD_FILTERED);

    expect(unfiltered.chains.flatMap((c) => c.open).length).toBe(4);
    expect(filtered.chains.flatMap((c) => c.open).length).toBe(0);
  });
});

describe("the frozen money-path validator is unchanged and still drops these", () => {
  it("keeps only chainId + openPositions{marketId,pt,yt,lp} — no claimables, no SY, no updatedAt", () => {
    // The characterization half: R2 must not have widened the money path. If this
    // ever starts passing more fields, a money-path validator changed.
    const frozen = validatePositions(PENDLE_DASHBOARD_ACTIVE_YT);
    const serialized = JSON.stringify(frozen);

    expect(frozen.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("claimTokenAmounts");
    expect(serialized).not.toContain("syPositions");
    expect(serialized).not.toContain("activeBalance");
    expect(serialized).not.toContain("updatedAt");
    for (const chain of frozen) {
      expect(Object.keys(chain).sort()).toEqual(["chainId", "openPositions"]);
      for (const position of chain.openPositions) {
        expect(Object.keys(position).sort()).toEqual(["lp", "marketId", "pt", "yt"]);
      }
    }
  });
});
