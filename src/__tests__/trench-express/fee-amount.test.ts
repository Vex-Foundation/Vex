/**
 * Vex's 25 bps Trench fee — the arithmetic and the charge-base contract.
 *
 * REAL FUNDS on Robinhood Chain (4663). The number this module returns is
 * transferred on-chain to the Vex treasury as a SEPARATE leg that runs AFTER
 * the trade or launch confirms, so every property here is a property of money
 * that has already moved once.
 *
 * The single most important thing pinned here is the CHARGE BASE: the fee is
 * ALWAYS taken on the ETH leg — the ETH spent on a buy, the ETH RECEIVED on a
 * sell, and the full `msg.value` of a launch. The sell case is a deliberate,
 * owner-approved deviation from the repo-wide `currency_in` rule (see
 * `fee/constants.ts` for why) and a test that did not state it would let a
 * later "consistency fix" hand the treasury memecoins.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";
import {
  TRENCH_FEE_ACTIVITY_EVENT_ROLE,
  TRENCH_FEE_BPS,
  TRENCH_FEE_RECEIVER_EVM,
  buildTrenchFeeTransfer,
  splitTrenchEthForFee,
  trenchFeeBaseWei,
} from "@tools/trench-express/fee/index.js";

describe("Trench fee constants", () => {
  it("pins the product-owner rate at 25 bps, matching every other Vex venue", () => {
    expect(TRENCH_FEE_BPS).toBe(25);
  });

  it("pays the shared Vex EVM treasury, not a Trench-specific address", () => {
    expect(TRENCH_FEE_RECEIVER_EVM).toBe(VEX_TREASURY_EVM);
    expect(getAddress(TRENCH_FEE_RECEIVER_EVM)).toBe(TRENCH_FEE_RECEIVER_EVM);
  });

  it("records under its own `trench_fee` role — `bridge_fee` is barred by the kind↔role CHECK", () => {
    expect(TRENCH_FEE_ACTIVITY_EVENT_ROLE).toBe("trench_fee");
  });
});

describe("splitTrenchEthForFee — floor(baseWei × 25 / 10000)", () => {
  it("computes the exact floor and keeps fee + net === total", () => {
    const cases: ReadonlyArray<readonly [bigint, bigint]> = [
      [10n ** 18n, 2_500_000_000_000_000n], // 1 ETH → 0.0025 ETH
      [10n ** 16n, 25_000_000_000_000n], // 0.01 ETH
      [400n, 1n],
      [399n, 0n],
    ];
    for (const [base, expectedFee] of cases) {
      const split = splitTrenchEthForFee(base);
      expect(split.feeRaw, `fee for ${base}`).toBe(expectedFee);
      expect(split.feeRaw + split.netRaw).toBe(base);
      expect(split.totalRaw).toBe(base);
    }
  });

  it("FLOORS — a remainder is never rounded up into an overcharge", () => {
    expect(splitTrenchEthForFee(1599n).feeRaw).toBe(3n);
    expect(splitTrenchEthForFee(799n).feeRaw).toBe(1n);
  });

  it("DUST: a fee flooring to 0 reports charged:false so the leg is skipped entirely", () => {
    for (const dust of [1n, 5n, 100n, 399n]) {
      const split = splitTrenchEthForFee(dust);
      expect(split.feeRaw, `fee for ${dust}`).toBe(0n);
      expect(split.charged).toBe(false);
      expect(split.netRaw).toBe(dust);
    }
    expect(splitTrenchEthForFee(400n).charged).toBe(true);
  });

  it("REFUSES a non-positive base rather than silently charging nothing", () => {
    expect(() => splitTrenchEthForFee(0n)).toThrow();
    expect(() => splitTrenchEthForFee(-1n)).toThrow();
  });
});

describe("trenchFeeBaseWei — the ETH leg, on every side", () => {
  it("BUY: the base is the ETH SPENT (currency_in, consistent with every venue)", () => {
    expect(trenchFeeBaseWei({ basis: "buy_eth_in", ethInWei: 10n ** 18n })).toBe(10n ** 18n);
  });

  it("SELL: the base is the ETH RECEIVED — the owner-approved deviation from currency_in", () => {
    // `currency_in` on a sell is the memecoin. Charging it would make the
    // treasury accumulate possibly-taxing, possibly worthless tokens, and the
    // FoT/honeypot guard does NOT cover chain 4663.
    expect(trenchFeeBaseWei({ basis: "sell_eth_out", ethOutWei: 5n * 10n ** 17n })).toBe(5n * 10n ** 17n);
  });

  it("LAUNCH: the base is the FULL msg.value — creation fee AND prebuy", () => {
    const creationFee = 10n ** 15n; // 0.001 ETH
    const prebuy = 2n * 10n ** 16n;
    expect(trenchFeeBaseWei({ basis: "launch_msg_value", msgValueWei: creationFee + prebuy }))
      .toBe(creationFee + prebuy);
  });
});

describe("buildTrenchFeeTransfer", () => {
  it("is a NATIVE value transfer to the treasury with NO calldata", () => {
    const transfer = buildTrenchFeeTransfer(2_500_000_000_000_000n);
    expect(transfer).toEqual({ kind: "native", to: TRENCH_FEE_RECEIVER_EVM, value: 2_500_000_000_000_000n });
    expect(transfer).not.toHaveProperty("data");
  });

  it("REFUSES to build a leg for a non-positive fee — a zero transfer burns gas and moves nothing", () => {
    expect(() => buildTrenchFeeTransfer(0n)).toThrow();
    expect(() => buildTrenchFeeTransfer(-1n)).toThrow();
  });
});
