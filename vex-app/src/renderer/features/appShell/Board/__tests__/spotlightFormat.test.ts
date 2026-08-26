/**
 * THE SPOTLIGHT'S DECISIONS ABOUT WORDS AND FIGURES.
 *
 * Four of these are honesty rules rather than formatting, and each is driven
 * as a table because a table is what makes a rule falsifiable:
 *
 *  - a lock share renders VERBATIM with the provider's own row tag, so a pool
 *    whose LP is burned reads "Locked 99.99% - Burned" rather than the far
 *    more dangerous "0% locked" that excluding burn rows would produce (C2);
 *  - a share whose SCALE the provider could not establish is words, never a
 *    number and never a filled bar (C3, A11 row 9);
 *  - a window with no trades has NO split, because "0% / 0%" claims a market
 *    was measured and found empty;
 *  - the two halves of the split always sum to 100.
 */

import { describe, expect, it } from "vitest";
import type {
  BoardLiquidityLocks,
  BoardPercent,
} from "@shared/schemas/board-details.js";
import type { BoardMomentumRow } from "@shared/schemas/board-spotlight.js";
import {
  LOCK_NONE_REPORTED_TEXT,
  LOCK_NOT_COVERED_TEXT,
  LOCK_UNVERIFIED_TEXT,
  analysisFragments,
  analysisLead,
  buySellView,
  formatBoardPercentUnit,
  formatSignedUsdNumber,
  formatTapeClock,
  formatUsdNumber,
  formatWholeCount,
  lockView,
  momentumBaseline,
  momentumView,
  tapeSideLabel,
} from "../spotlightFormat.js";

function percent(
  normalizedPct: number | null,
  unit: BoardPercent["unit"] = "percent",
  raw = "0",
): BoardPercent {
  return { raw, normalizedPct, unit };
}

function locks(overrides: Partial<BoardLiquidityLocks> = {}): BoardLiquidityLocks {
  return { lockedPct: percent(99.99, "percent", "99.99"), rows: [], ...overrides };
}

describe("lockView", () => {
  it("renders the share with the provider's row tag, burn included", () => {
    const view = lockView(
      locks({ rows: [{ tag: "Burned", share: percent(99.99) }] }),
    );
    expect(view).toEqual({
      kind: "locked",
      text: "Locked 99.99% - Burned",
      fillPct: 99.99,
    });
  });

  it("renders lockedPct and never a row's own share, tagless", () => {
    expect(lockView(locks({ rows: [{ tag: null, share: percent(89) }] }))).toEqual({
      kind: "locked",
      text: "Locked 99.99%",
      fillPct: 99.99,
    });
  });

  it("lists each distinct tag once, in provider order", () => {
    const view = lockView(
      locks({
        rows: [
          { tag: "Burned", share: percent(60) },
          { tag: "Team Finance", share: percent(30) },
          { tag: "Burned", share: percent(9.99) },
        ],
      }),
    );
    expect(view).toMatchObject({ text: "Locked 99.99% - Burned, Team Finance" });
  });

  it("says 'n/a - unverified' rather than a number when the unit is unverified", () => {
    const view = lockView(locks({ lockedPct: percent(89, "unverified", "0.89") }));
    expect(view).toEqual({ kind: "unverified", text: LOCK_UNVERIFIED_TEXT });
  });

  it("says 'n/a - unverified' when the provider sent no normalized value", () => {
    expect(lockView(locks({ lockedPct: percent(null, "percent") }))).toEqual({
      kind: "unverified",
      text: LOCK_UNVERIFIED_TEXT,
    });
  });

  it("names a chain with no lock index rather than reporting zero", () => {
    expect(lockView(null)).toEqual({
      kind: "unavailable",
      text: LOCK_NOT_COVERED_TEXT,
    });
  });

  it("names a pool the lock index carried no share for", () => {
    expect(lockView(locks({ lockedPct: null }))).toEqual({
      kind: "unavailable",
      text: LOCK_NONE_REPORTED_TEXT,
    });
  });

  it("trims a share to two places and drops trailing zeros", () => {
    expect(lockView(locks({ lockedPct: percent(89.0) }))).toMatchObject({
      text: "Locked 89%",
    });
    expect(lockView(locks({ lockedPct: percent(12.3456) }))).toMatchObject({
      text: "Locked 12.35%",
    });
  });

  it("clamps the bar without changing the printed figure", () => {
    const view = lockView(locks({ lockedPct: percent(140) }));
    expect(view).toEqual({ kind: "locked", text: "Locked 140%", fillPct: 100 });
  });
});

describe("formatBoardPercentUnit", () => {
  it("refuses to print an unverified percent as a number", () => {
    expect(formatBoardPercentUnit(percent(3, "unverified"))).toBe(LOCK_UNVERIFIED_TEXT);
  });
  it("prints a verified percent", () => {
    expect(formatBoardPercentUnit(percent(3.5))).toBe("3.5%");
  });
  it("prints the dash for nothing at all", () => {
    expect(formatBoardPercentUnit(null)).toBe("-");
  });
});

describe("buySellView", () => {
  it("produces the mockup's split", () => {
    expect(buySellView(620, 380)).toEqual({
      kind: "split",
      buys: 620,
      sells: 380,
      buyPct: 62,
      sellPct: 38,
    });
  });

  it("always sums to 100, even where independent rounding would not", () => {
    for (const [buys, sells] of [
      [1, 2],
      [1235, 856],
      [7, 9],
      [1, 199],
    ] as const) {
      const view = buySellView(buys, sells);
      if (view.kind !== "split") throw new Error("expected a split");
      expect(view.buyPct + view.sellPct).toBe(100);
    }
  });

  it("treats a window with no trades as an absence, not a zero split", () => {
    expect(buySellView(0, 0).kind).toBe("unavailable");
    expect(buySellView(null, null).kind).toBe("unavailable");
  });

  it("counts the side that was reported when the other was not", () => {
    expect(buySellView(10, null)).toMatchObject({ buyPct: 100, sellPct: 0 });
    expect(buySellView(null, 10)).toMatchObject({ buyPct: 0, sellPct: 100 });
  });

  it("refuses a negative or non-finite count rather than inverting the bar", () => {
    expect(buySellView(-5, 5)).toMatchObject({ buyPct: 0, sellPct: 100 });
    expect(buySellView(Number.NaN, 5)).toMatchObject({ buyPct: 0, sellPct: 100 });
  });
});

describe("analysisLead and analysisFragments", () => {
  const assessment =
    "Price is up on thin liquidity · LP is burned, so the pool cannot be pulled · Holders are concentrated";

  it("takes the first middle-dot fragment for the line under the chip", () => {
    expect(analysisLead(assessment)).toBe("Price is up on thin liquidity");
  });

  it("keeps every fragment, in order, for the section that renders it whole", () => {
    expect(analysisFragments(assessment)).toEqual([
      "Price is up on thin liquidity",
      "LP is burned, so the pool cannot be pulled",
      "Holders are concentrated",
    ]);
  });

  it("splits on a line break as well, since the field admits them", () => {
    expect(analysisFragments("one\ntwo")).toEqual(["one", "two"]);
  });

  it("returns a single-fragment assessment whole", () => {
    expect(analysisLead("Just one observation")).toBe("Just one observation");
  });

  it("has nothing to say about an absent or empty assessment", () => {
    expect(analysisLead(null)).toBeNull();
    expect(analysisLead("   ")).toBeNull();
    expect(analysisFragments(null)).toEqual([]);
  });
});

function momentumRow(overrides: Partial<BoardMomentumRow> = {}): BoardMomentumRow {
  return {
    window: "h1",
    hours: 1,
    volumeUsd: 1000,
    volumeBuyUsd: 600,
    volumeSellUsd: 400,
    buys: 60,
    sells: 40,
    priceChangePct: 5,
    volumeUsdPerHour: 1000,
    tradesPerHour: 100,
    buySharePct: 60,
    ...overrides,
  };
}

describe("momentumView", () => {
  it("reads buyer pressure as the trend, since a share needs no normalizing", () => {
    expect(momentumView(momentumRow({ buySharePct: 60 }), 1000).trend).toBe("up");
    expect(momentumView(momentumRow({ buySharePct: 40 }), 1000).trend).toBe("down");
    expect(momentumView(momentumRow({ buySharePct: 50 }), 1000).trend).toBe("flat");
    expect(momentumView(momentumRow({ buySharePct: null }), 1000).trend).toBe(
      "unknown",
    );
  });

  it("compares each window's hourly rate against the 24h baseline", () => {
    expect(
      momentumView(momentumRow({ volumeUsdPerHour: 5000 }), 1000).acceleration,
    ).toBe("faster");
    expect(
      momentumView(momentumRow({ volumeUsdPerHour: 100 }), 1000).acceleration,
    ).toBe("slower");
    expect(
      momentumView(momentumRow({ volumeUsdPerHour: 1000 }), 1000).acceleration,
    ).toBe("even");
  });

  it("says nothing about acceleration without a baseline", () => {
    expect(momentumView(momentumRow(), null).acceleration).toBe("unknown");
    expect(momentumView(momentumRow(), 0).acceleration).toBe("unknown");
  });

  it("takes the baseline from the 24h window alone", () => {
    expect(
      momentumBaseline([
        momentumRow({ window: "m5", volumeUsdPerHour: 9 }),
        momentumRow({ window: "h24", volumeUsdPerHour: 42 }),
      ]),
    ).toBe(42);
    expect(momentumBaseline([momentumRow({ window: "m5" })])).toBeNull();
  });
});

describe("provider doubles", () => {
  it("formats compactly by magnitude", () => {
    expect(formatUsdNumber(95_200)).toBe("$95.2K");
    expect(formatUsdNumber(521_600)).toBe("$521.6K");
    expect(formatUsdNumber(1_500_000)).toBe("$1.5M");
    expect(formatUsdNumber(2_000_000_000)).toBe("$2B");
    expect(formatUsdNumber(12.5)).toBe("$12.5");
  });

  it("signs a net flow so direction reads at a glance", () => {
    expect(formatSignedUsdNumber(1200)).toBe("+$1.2K");
    expect(formatSignedUsdNumber(-1200)).toBe("-$1.2K");
    expect(formatSignedUsdNumber(0)).toBe("$0");
  });

  it("prints the dash rather than a zero for a figure nobody reported", () => {
    expect(formatUsdNumber(null)).toBe("-");
    expect(formatSignedUsdNumber(null)).toBe("-");
    expect(formatWholeCount(null)).toBe("-");
    expect(formatWholeCount(982)).toBe("982");
    expect(formatWholeCount(1400)).toBe("1,400");
  });
});

describe("the tape's own formatting", () => {
  it("stamps a trade to the second, in UTC", () => {
    expect(formatTapeClock(Date.UTC(2026, 7, 26, 11, 11, 9))).toBe("11:11:09");
  });
  it("prints the dash for a trade with no clock", () => {
    expect(formatTapeClock(null)).toBe("-");
    expect(formatTapeClock(Number.NaN)).toBe("-");
  });
  it("names all four sides, including the two that are not trades", () => {
    expect(tapeSideLabel("buy")).toBe("Buy");
    expect(tapeSideLabel("sell")).toBe("Sell");
    expect(tapeSideLabel("add")).toBe("Add LP");
    expect(tapeSideLabel("remove")).toBe("Remove LP");
    expect(tapeSideLabel(null)).toBe("Unknown");
  });
});
