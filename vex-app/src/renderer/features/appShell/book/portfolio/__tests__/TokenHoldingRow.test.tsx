/**
 * TokenHoldingRow module — unit coverage for the shared `filterDustTokens`
 * hide-dust helper (owner report: Solana spam airdrops price at $0.00 and
 * clutter the Balances card + All-assets screen).
 *
 * Pins:
 *   - a priced row below the sub-cent `MIN_DISPLAY_USD` threshold is hidden
 *     when `hideDust` is true,
 *   - a priced row at/above the threshold is always shown,
 *   - an UNPRICED row (`balanceUsd: null`) is ALWAYS shown regardless of
 *     `hideDust` — no price is not the same claim as zero value,
 *   - a negative dust balance (e.g. `-0.001`, |value| below the threshold)
 *     is hidden the same as a positive one,
 *   - `hideDust: false` is a no-op — every row passes through unchanged.
 */

import { describe, it, expect, vi } from "vitest";
import type { PositionTokenDto } from "@shared/schemas/portfolio.js";

// Every brand mark stubs to null, whatever its name: the marks are
// presentation-only here, and a hand-listed mock breaks the whole suite
// file each time a component references a new mark.
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

const { filterDustTokens, MIN_DISPLAY_USD } = await import(
  "../TokenHoldingRow.js"
);

function token(overrides: Partial<PositionTokenDto>): PositionTokenDto {
  return {
    chainId: 1,
    symbol: "TOK",
    balanceUsd: 1,
    amount: 1,
    ...overrides,
  };
}

describe("filterDustTokens", () => {
  it("hides a priced row below MIN_DISPLAY_USD when hideDust is true", () => {
    const dust = token({ symbol: "SEEYUH", balanceUsd: 0.001 });
    const result = filterDustTokens([dust], true);
    expect(result).toEqual([]);
  });

  it("shows a priced row at/above MIN_DISPLAY_USD when hideDust is true", () => {
    const real = token({ symbol: "USDC", balanceUsd: MIN_DISPLAY_USD });
    const result = filterDustTokens([real], true);
    expect(result).toEqual([real]);
  });

  it("always shows an unpriced (null balanceUsd) row, even when hideDust is true", () => {
    const unpriced = token({ symbol: "VEX", balanceUsd: null, amount: 5 });
    const result = filterDustTokens([unpriced], true);
    expect(result).toEqual([unpriced]);
  });

  it("hides a negative dust balance the same as a positive one", () => {
    const negativeDust = token({ symbol: "SPAM", balanceUsd: -0.001 });
    const result = filterDustTokens([negativeDust], true);
    expect(result).toEqual([]);
  });

  it("is a no-op when hideDust is false - every row passes through", () => {
    const tokens = [
      token({ symbol: "SEEYUH", balanceUsd: 0.001 }),
      token({ symbol: "SPAM", balanceUsd: -0.001 }),
      token({ symbol: "VEX", balanceUsd: null, amount: 5 }),
      token({ symbol: "USDC", balanceUsd: 100 }),
    ];
    expect(filterDustTokens(tokens, false)).toEqual(tokens);
  });

  it("filters a mixed list, keeping priced-above-threshold and unpriced rows in place", () => {
    const dust = token({ symbol: "SEEYUH", balanceUsd: 0.001 });
    const unpriced = token({ symbol: "VEX", balanceUsd: null, amount: 5 });
    const real = token({ symbol: "USDC", balanceUsd: 100 });
    const result = filterDustTokens([dust, unpriced, real], true);
    expect(result).toEqual([unpriced, real]);
  });
});
