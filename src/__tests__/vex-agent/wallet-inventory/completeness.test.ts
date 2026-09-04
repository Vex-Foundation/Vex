/**
 * The two completeness axes, tested at their owner.
 *
 * The invariant under test is the one the frozen contract exists to protect:
 * the axes are INDEPENDENT. A dead chain must not make the rows we did read
 * "unvalued", and a wallet full of unpriced dust must not make the enumeration
 * "incomplete". Both references ship the collapsed version of this, which is
 * why each direction gets its own case here rather than one combined test.
 */

import { describe, it, expect } from "vitest";

import {
  combineWalletCompleteness,
  computeWalletCompleteness,
  holdingState,
  sumDecimalStrings,
  type CompletenessRow,
  type InventorySource,
} from "@vex-agent/wallet-inventory/completeness.js";

const OBSERVED_AT = "2026-08-31T00:00:00.000Z";

function source(overrides: Partial<InventorySource> = {}): InventorySource {
  return {
    chainId: 1,
    source: "khalani_registry_scan",
    result: "read",
    exhaustive: true,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function row(overrides: Partial<CompletenessRow> = {}): CompletenessRow {
  return { balanceRaw: "1000", priceUsd: "2", valueUsd: "4", ...overrides };
}

function compute(overrides: Partial<Parameters<typeof computeWalletCompleteness>[0]> = {}) {
  return computeWalletCompleteness({
    rows: [row()],
    sources: [source()],
    tokenErrorCount: 0,
    accountErrorCount: 0,
    rejectedEntries: [],
    ...overrides,
  });
}

describe("holdingState", () => {
  it.each([
    ["1", "held"],
    ["0", "empty"],
    ["000", "empty"],
    ["", "unknown"],
    ["1.5", "unknown"],
    ["0x10", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ] as const)("classifies %o as %s", (raw, expected) => {
    expect(holdingState(raw)).toBe(expected);
  });

  it("never reports an unreadable amount as an empty holding", () => {
    // C3.3: `0` is a valid balance, not a missing one - and the reverse is just
    // as load-bearing, because "we could not size it" must not read as "none".
    expect(holdingState("not-a-number")).not.toBe("empty");
  });
});

describe("sumDecimalStrings", () => {
  it("adds at the widest scale seen, losing no digit any addend carried", () => {
    expect(sumDecimalStrings(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimalStrings(["1", "0.000000000001"])).toBe("1.000000000001");
  });

  it("beats float addition on a long dust list", () => {
    const dust = Array.from({ length: 10 }, () => "0.1");
    expect(sumDecimalStrings(dust)).toBe("1");
    // The float route this replaces does not produce "1".
    expect(dust.reduce((sum, value) => sum + Number(value), 0)).not.toBe(1);
  });

  it("keeps exactness past the float safe-integer range", () => {
    expect(sumDecimalStrings(["9007199254740993", "1"])).toBe("9007199254740994");
  });

  it("returns 0 for an empty list and skips unreadable values", () => {
    expect(sumDecimalStrings([])).toBe("0");
    expect(sumDecimalStrings(["1", "1e3", "abc"])).toBe("1");
  });
});

describe("computeWalletCompleteness - the axes are independent", () => {
  it("reports both complete for a fully read, fully priced wallet", () => {
    expect(compute()).toMatchObject({
      inventoryComplete: true,
      valuationComplete: true,
      totalUsdBasis: "complete",
      unpricedHeldCount: 0,
      pricedTotalUsd: "4",
      failedChainIds: [],
    });
    expect(compute().inventoryIncompleteReason).toBeUndefined();
  });

  it("a failed chain does NOT make the rows it did read unvalued", () => {
    const result = compute({
      sources: [source(), source({ chainId: 8453, result: "failed", observedAt: null })],
    });
    expect(result.inventoryComplete).toBe(false);
    expect(result.inventoryIncompleteReason).toBe("chain_read_failed");
    expect(result.failedChainIds).toEqual([8453]);
    // The axis that did not fail stays true; only the BASIS degrades.
    expect(result.valuationComplete).toBe(true);
    expect(result.totalUsdBasis).toBe("priced_only");
  });

  it("an unpriced holding does NOT make the enumeration incomplete", () => {
    const result = compute({
      rows: [row(), row({ priceUsd: null, valueUsd: null })],
    });
    expect(result.valuationComplete).toBe(false);
    expect(result.unpricedHeldCount).toBe(1);
    expect(result.totalUsdBasis).toBe("priced_only");
    expect(result.inventoryComplete).toBe(true);
    expect(result.inventoryIncompleteReason).toBeUndefined();
  });

  it("counts every unpriced held row, not just the ones a trim would drop", () => {
    const unpriced = Array.from({ length: 25 }, () => row({ priceUsd: null, valueUsd: null }));
    expect(compute({ rows: unpriced }).unpricedHeldCount).toBe(25);
  });

  it("does not count a zero-balance unpriced row as an unpriced HOLDING", () => {
    const result = compute({ rows: [row({ balanceRaw: "0", priceUsd: null, valueUsd: null })] });
    expect(result.unpricedHeldCount).toBe(0);
    expect(result.valuationComplete).toBe(true);
  });

  it("a held row whose amount could not be converted is unvalued, not empty", () => {
    // Priced, but `valueUsd` could not be derived: the value is unknown and the
    // valuation axis must say so even though a price feed exists.
    const result = compute({ rows: [row({ valueUsd: null })] });
    expect(result.valuationComplete).toBe(false);
    expect(result.unpricedHeldCount).toBe(0);
  });

  it("treats a zero price as a real feed, never as a missing one", () => {
    expect(compute({ rows: [row({ priceUsd: "0", valueUsd: "0" })] })).toMatchObject({
      unpricedHeldCount: 0,
      valuationComplete: true,
    });
  });

  it("sums only the rows that carried a value", () => {
    const result = compute({
      rows: [row({ valueUsd: "1.5" }), row({ valueUsd: null, priceUsd: null }), row({ valueUsd: "2.25" })],
    });
    expect(result.pricedTotalUsd).toBe("3.75");
  });
});

describe("computeWalletCompleteness - inventory reasons", () => {
  it("reports source_not_exhaustive for a clean read of a bounded source", () => {
    // Robinhood Chain (4663) until WP6b: seed ∪ pins, so a token outside the
    // set is invisible rather than absent.
    const result = compute({
      sources: [source({ chainId: 4663, source: "local_chain_seed_and_pins", exhaustive: false })],
    });
    expect(result.inventoryComplete).toBe(false);
    expect(result.inventoryIncompleteReason).toBe("source_not_exhaustive");
    expect(result.failedChainIds).toEqual([]);
  });

  it("reports token_read_failed and account_read_failed from their own counters", () => {
    expect(compute({ tokenErrorCount: 1 }).inventoryIncompleteReason).toBe("token_read_failed");
    expect(compute({ accountErrorCount: 1 }).inventoryIncompleteReason).toBe("account_read_failed");
  });

  it("names the worst cause when several apply", () => {
    const result = compute({
      sources: [source({ result: "failed", observedAt: null }), source({ chainId: 4663, exhaustive: false })],
      tokenErrorCount: 3,
      accountErrorCount: 2,
    });
    expect(result.inventoryIncompleteReason).toBe("chain_read_failed");
  });
});

describe("computeWalletCompleteness - decimals-only rejections (C1.2 amendment)", () => {
  it("keeps the inventory complete and makes the valuation incomplete when held", () => {
    const result = compute({ rejectedEntries: [{ balanceRaw: "500" }] });
    expect(result.inventoryComplete).toBe(true);
    expect(result.valuationComplete).toBe(false);
    expect(result.totalUsdBasis).toBe("priced_only");
  });

  it("does the same when the holding status is unknown", () => {
    const result = compute({ rejectedEntries: [{ balanceRaw: null }] });
    expect(result.inventoryComplete).toBe(true);
    expect(result.valuationComplete).toBe(false);
  });

  it("costs neither axis when the refused entry is an exact zero", () => {
    expect(compute({ rejectedEntries: [{ balanceRaw: "0" }] })).toMatchObject({
      inventoryComplete: true,
      valuationComplete: true,
      totalUsdBasis: "complete",
    });
  });
});

describe("combineWalletCompleteness", () => {
  it("requires both axes across every wallet for a complete basis", () => {
    const complete = compute();
    const unpriced = compute({ rows: [row({ priceUsd: null, valueUsd: null })] });
    const combined = combineWalletCompleteness([complete, unpriced], 0);
    expect(combined).toMatchObject({
      inventoryComplete: true,
      valuationComplete: false,
      unpricedHeldCount: 1,
      pricedTotalUsd: "4",
      totalUsdBasis: "priced_only",
    });
  });

  it("a wallet family that produced no snapshot outranks every per-wallet reason", () => {
    const failedChain = compute({
      sources: [source({ chainId: 10, result: "failed", observedAt: null })],
    });
    const combined = combineWalletCompleteness([failedChain], 1);
    expect(combined.inventoryComplete).toBe(false);
    expect(combined.inventoryIncompleteReason).toBe("wallet_read_failed");
    expect(combined.failedChainIds).toEqual([10]);
  });

  it("carries every wallet's sources and unions the failed chain ids", () => {
    const first = compute({ sources: [source({ chainId: 8453, result: "failed", observedAt: null })] });
    const second = compute({ sources: [source({ chainId: 1, result: "failed", observedAt: null })] });
    const combined = combineWalletCompleteness([first, second], 0);
    expect(combined.failedChainIds).toEqual([1, 8453]);
    expect(combined.inventorySources).toHaveLength(2);
  });

  it("sums priced totals exactly rather than through floats", () => {
    const a = compute({ rows: [row({ valueUsd: "0.1" })] });
    const b = compute({ rows: [row({ valueUsd: "0.2" })] });
    expect(combineWalletCompleteness([a, b], 0).pricedTotalUsd).toBe("0.3");
  });
});
