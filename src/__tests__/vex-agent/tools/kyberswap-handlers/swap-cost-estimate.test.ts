/**
 * `estimateKyberSwapCostsUsd` — the durable USD cost breakdown a KyberSwap row
 * records (migration 050's `usd_network_gas_est` / `usd_vex_fee_est`).
 *
 * Sibling of `route-summary-costs.test.ts`, which pins the same two cost
 * concepts on the AGENT-facing projection. Both exist because the pre-050 row
 * stored `gasUsd` alone — L2 execution only — as if it were the whole cost.
 *
 * The contract under test is deliberately conservative: an input that cannot be
 * read as a finite number yields `undefined`, never 0 and never a partial sum,
 * because a NUMERIC column reads as complete once it holds anything at all.
 */

import { describe, expect, it } from "vitest";

import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { estimateKyberSwapCostsUsd } from "@vex-agent/tools/protocols/kyberswap/swap-cost-estimate.js";

describe("network gas includes the L1 data fee", () => {
  it("sums gasUsd and l1FeeUsd — the pre-050 bug was recording gasUsd alone", () => {
    const { usdNetworkGasEst } = estimateKyberSwapCostsUsd({
      gasUsd: "0.0412",
      l1FeeUsd: "0.0563",
      amountInUsd: "100",
    });
    expect(usdNetworkGasEst).toBe("0.0975");
  });

  it("an L1 fee that exceeds L2 execution is carried in full, not clamped", () => {
    // The `helpers.ts` note this migration acts on: on OP-stack chains l1FeeUsd
    // "can rival or exceed gasUsd".
    const { usdNetworkGasEst } = estimateKyberSwapCostsUsd({
      gasUsd: "0.01",
      l1FeeUsd: "0.25",
      amountInUsd: "100",
    });
    expect(usdNetworkGasEst).toBe("0.26");
  });

  it("falls back to gasUsd alone when the chain reports no L1 fee", () => {
    const { usdNetworkGasEst } = estimateKyberSwapCostsUsd({
      gasUsd: "1.5",
      l1FeeUsd: undefined,
      amountInUsd: "100",
    });
    expect(usdNetworkGasEst).toBe("1.5");
  });

  it("refuses rather than understating when l1FeeUsd is present but unreadable", () => {
    // Recording the L2 figure here would read as a complete gas cost while
    // silently omitting a component the provider said exists.
    const { usdNetworkGasEst } = estimateKyberSwapCostsUsd({
      gasUsd: "0.04",
      l1FeeUsd: "not-a-number",
      amountInUsd: "100",
    });
    expect(usdNetworkGasEst).toBeUndefined();
  });

  it("yields undefined when gasUsd itself is unreadable", () => {
    expect(
      estimateKyberSwapCostsUsd({ gasUsd: "", l1FeeUsd: "0.01", amountInUsd: "100" }).usdNetworkGasEst,
    ).toBeUndefined();
  });
});

describe("the Vex integrator fee", () => {
  it("is 25 bps of the input-side USD", () => {
    const { usdVexFeeEst } = estimateKyberSwapCostsUsd({
      gasUsd: "0.01",
      l1FeeUsd: undefined,
      amountInUsd: "1000",
    });
    expect(usdVexFeeEst).toBe("2.5");
  });

  it("tracks the product-owner constant rather than a hard-coded 25", () => {
    const amountInUsd = "4000";
    const { usdVexFeeEst } = estimateKyberSwapCostsUsd({ gasUsd: "0.01", l1FeeUsd: undefined, amountInUsd });
    expect(Number(usdVexFeeEst)).toBeCloseTo((Number(amountInUsd) * KYBERSWAP_FEE_BPS) / 10_000, 9);
  });

  it("is undefined — never 0 — when the provider gave no readable input USD", () => {
    // 0 would read as "Vex charged nothing", which is a different claim from
    // "the fee cannot be priced".
    const { usdVexFeeEst } = estimateKyberSwapCostsUsd({
      gasUsd: "0.01",
      l1FeeUsd: undefined,
      amountInUsd: "",
    });
    expect(usdVexFeeEst).toBeUndefined();
  });

  it("does not collapse a small-trade fee to zero at 6-decimal precision", () => {
    // $1 trade → 25 bps = $0.0025; a coarser rendering would round it away and
    // report a real fee as no fee.
    const { usdVexFeeEst } = estimateKyberSwapCostsUsd({
      gasUsd: "0.01",
      l1FeeUsd: undefined,
      amountInUsd: "1",
    });
    expect(usdVexFeeEst).toBe("0.0025");
  });

  it("is independent of gas — a failed gas read never suppresses the fee", () => {
    const { usdNetworkGasEst, usdVexFeeEst } = estimateKyberSwapCostsUsd({
      gasUsd: "oops",
      l1FeeUsd: undefined,
      amountInUsd: "200",
    });
    expect(usdNetworkGasEst).toBeUndefined();
    expect(usdVexFeeEst).toBe("0.5");
  });
});
