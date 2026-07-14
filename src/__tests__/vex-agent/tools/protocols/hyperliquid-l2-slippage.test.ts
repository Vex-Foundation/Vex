/**
 * L2 slippage estimator for the Hyperliquid protection gate.
 *
 * Regression suite for the 2026-07-13 CASHCAT incident: the abs()-based,
 * unbounded-sweep estimator scored FAVORABLE limit fills as slippage and
 * produced four consecutive false-positive blocks with non-monotonic readings
 * (size 103 -> 1.15%, 80 -> 1.42%, 50 -> 2.19%, 10 -> 1.32% under a 1% cap).
 *
 * The corrected estimator is adverse-only and, for a limit order (hl_open),
 * walks only the depth priced at-or-better than the limit; the rest of the book
 * rests and is not slippage. For a market sweep (hl_twap) the walk is uncapped
 * and slippage is measured against the mid reference.
 */

import { describe, expect, it } from "vitest";

import { estimateSlippagePct } from "@vex-agent/tools/protocols/hyperliquid/protection-gate.js";

// [bids, asks]. Buy consumes asks (levels[1]); sell consumes bids (levels[0]).
function book(bids: ReadonlyArray<{ px: string; sz: string }>, asks: ReadonlyArray<{ px: string; sz: string }>) {
  return { levels: [bids, asks] };
}

describe("estimateSlippagePct — adverse-only, limit-capped walk", () => {
  it("(a) price-improving buy LIMIT above best ask reports 0 (the production 2.19% false positive)", () => {
    // CASHCAT shape (szDecimals 0): best ask 0.15063, model limit 0.154, size 50.
    // HEAD's abs()/unbounded form scored |0.15063 - 0.154| / 0.154 = 2.1883%.
    const cashcat = book([{ px: "0.15050", sz: "1000.0" }], [{ px: "0.15063", sz: "1000.0" }]);
    const estimate = estimateSlippagePct(cashcat, "50", "0.154", "buy", "0.154");
    expect(estimate?.toFixed(4)).toBe("0.0000");
  });

  it("(b) size beyond depth-below-limit fills the crossing portion and rests the remainder", () => {
    // Limit buy 100 @ 0.154; only 40 available at-or-below the limit (0.1506),
    // the next ask (0.1541) rests. avg over the fillable 40 is 0.1506 <= limit,
    // so adverse slippage is 0 and the order is allowed (remainder simply rests).
    const thin = book(
      [{ px: "0.1500", sz: "500" }],
      [{ px: "0.1506", sz: "40" }, { px: "0.1541", sz: "500" }],
    );
    const estimate = estimateSlippagePct(thin, "100", "0.154", "buy", "0.154");
    expect(estimate?.toFixed()).toBe("0");
  });

  it("(c) TWAP market sweep (uncapped) above the mid reference produces positive slippage", () => {
    // Mid reference 0.15; asks walk up above it. size 25 sweeps three levels:
    // (10*0.16 + 10*0.17 + 5*0.18) / 25 = 0.168 -> (0.168-0.15)/0.15 = 12%.
    const asks = book(
      [{ px: "0.149", sz: "100" }],
      [{ px: "0.16", sz: "10" }, { px: "0.17", sz: "10" }, { px: "0.18", sz: "10" }],
    );
    const estimate = estimateSlippagePct(asks, "25", "0.15", "buy", null);
    expect(estimate?.toFixed()).toBe("12");
    // ... and the gate still bites: 12% is far above a 1% policy cap.
    expect(estimate?.gt(1)).toBe(true);
  });

  it("(c') sell-side TWAP sweep below the mid reference is adverse and positive", () => {
    // Sell consumes bids. Mid 0.15; bids walk down. size 25:
    // (10*0.14 + 10*0.13 + 5*0.12)/25 = 0.132 -> (0.15-0.132)/0.15 = 12%.
    const bids = book(
      [{ px: "0.14", sz: "10" }, { px: "0.13", sz: "10" }, { px: "0.12", sz: "10" }],
      [{ px: "0.151", sz: "100" }],
    );
    expect(estimateSlippagePct(bids, "25", "0.15", "sell", null)?.toFixed()).toBe("12");
  });

  it("(d) fully-resting buy LIMIT below best ask reports 0 (nothing crosses)", () => {
    const above = book([{ px: "0.1500", sz: "500" }], [{ px: "0.1520", sz: "500" }]);
    // Limit 0.151 < best ask 0.152: the whole order rests, no adverse fill.
    expect(estimateSlippagePct(above, "50", "0.151", "buy", "0.151")?.toFixed()).toBe("0");
  });

  it("(e) larger size never yields LOWER adverse slippage than smaller size (monotonicity)", () => {
    // Uncapped sweep where the inversion would show if it existed.
    const sweep = book(
      [{ px: "0.149", sz: "500" }],
      [{ px: "0.16", sz: "10" }, { px: "0.17", sz: "10" }, { px: "0.18", sz: "10" }],
    );
    const sizes = ["5", "15", "25"];
    const estimates = sizes.map((s) => estimateSlippagePct(sweep, s, "0.15", "buy", null));
    expect(estimates.every((e) => e !== null)).toBe(true);
    for (let i = 1; i < estimates.length; i += 1) {
      expect(estimates[i]!.gte(estimates[i - 1]!)).toBe(true);
    }
    // Limit-capped opens against the same book are uniformly 0 (never inverted).
    const capped = sizes.map((s) => estimateSlippagePct(sweep, s, "0.18", "buy", "0.18")?.toFixed());
    expect(capped).toEqual(["0", "0", "0"]);
  });

  it("(f) malformed / insufficient books preserve the fail-closed null contract", () => {
    // Fewer than two level arrays.
    expect(estimateSlippagePct({ levels: [[{ px: "0.15", sz: "1" }]] }, "1", "0.15", "buy", "0.15")).toBeNull();
    // Selected side is not an array.
    expect(estimateSlippagePct({ levels: [null, null] }, "1", "0.15", "buy", "0.15")).toBeNull();
    // A crossing level we must read is unparseable.
    const malformed = book([{ px: "0.15", sz: "500" }], [{ px: "abc", sz: "500" }]);
    expect(estimateSlippagePct(malformed, "50", "0.16", "buy", "0.16")).toBeNull();
    // Uncapped sweep against an empty crossing side cannot be estimated.
    expect(estimateSlippagePct(book([{ px: "0.15", sz: "1" }], []), "1", "0.15", "buy", null)).toBeNull();
  });
});
