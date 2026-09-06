/**
 * Vex's 25 bps on a curve trade: the buy split, the sell's settlement basis, and
 * the two ways a fee can be declined.
 *
 * The owner policy this pins (plan v3 section 1, F1/F2):
 *
 *   BUY  - 25 bps of the VIRTUAL the user COMMITS, deducted from the input:
 *          `committed = curveAmount + vexFee`, integer floor.
 *   SELL - 25 bps of the PROVEN executed VIRTUAL output, taken after the sale
 *          settles. A quote may show an ESTIMATE; it may never show a charge.
 */

import { describe, expect, it } from "vitest";

import {
  resolveVirtualsCurveBuyFee,
  resolveVirtualsCurveSellFee,
  virtualsCurveSellFeeFromProceeds,
  VIRTUALS_CURVE_FEE_BPS,
  VIRTUALS_CURVE_FEE_RECEIVER_EVM,
} from "@tools/virtuals/curve/fee.js";
import { virtualsCurveDeployment } from "@tools/virtuals/curve/deployments.js";
import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";
import { definedValue } from "../_test-value-guards.js";

const base = definedValue(virtualsCurveDeployment("base"), "the base curve deployment");

describe("the fee constants are product constants", () => {
  it("charges the same 25 bps every other Vex venue charges", () => {
    expect(VIRTUALS_CURVE_FEE_BPS).toBe(25);
  });

  it("pays the Vex treasury and nothing else", () => {
    // The receiver is a constant, never a parameter: `checkForbiddenTradeParams`
    // is what makes a caller-supplied one a named refusal rather than a silent
    // drop, and this is the value it protects.
    expect(VIRTUALS_CURVE_FEE_RECEIVER_EVM).toBe(VEX_TREASURY_EVM);
  });
});

describe("resolveVirtualsCurveBuyFee - committed = curveAmount + fee", () => {
  it("splits the committed VIRTUAL so the two parts sum to exactly what leaves the wallet", () => {
    const committed = 1_000_000_000_000_000_000n; // 1 VIRTUAL
    const fee = resolveVirtualsCurveBuyFee({ deployment: base, committedRaw: committed });
    expect(fee.feeRaw).toBe(2_500_000_000_000_000n); // 0.0025 VIRTUAL
    expect(fee.curveAmountRaw).toBe(997_500_000_000_000_000n);
    expect(fee.curveAmountRaw + (fee.feeRaw ?? 0n)).toBe(committed);
    expect(fee.committedRaw).toBe(committed);
  });

  it("floors the fee, so a remainder is never rounded up onto the user", () => {
    // 399 * 25 / 10000 = 0.9975 -> 0 fee, and the whole amount reaches the curve.
    const fee = resolveVirtualsCurveBuyFee({ deployment: base, committedRaw: 399n });
    expect(fee.feeRaw).toBeNull();
    expect(fee.curveAmountRaw).toBe(399n);
    // 400 * 25 / 10000 = 1 exactly.
    const charged = resolveVirtualsCurveBuyFee({ deployment: base, committedRaw: 400n });
    expect(charged.feeRaw).toBe(1n);
    expect(charged.curveAmountRaw).toBe(399n);
  });

  it("says WHY when a dust amount takes no fee, rather than reporting a zero fee", () => {
    const fee = resolveVirtualsCurveBuyFee({ deployment: base, committedRaw: 1n });
    expect(fee.disclosure.charged).toBe(false);
    if (fee.disclosure.charged === false) {
      expect(fee.disclosure.reason).toMatch(/rounds to zero/);
      expect(fee.disclosure.netAmountRaw).toBe("1");
      expect(fee.disclosure.totalDebitedRaw).toBe("1");
    }
  });

  it("discloses the charged arm with exact raw and decimal amounts and the receiver", () => {
    const fee = resolveVirtualsCurveBuyFee({ deployment: base, committedRaw: 10n ** 18n });
    expect(fee.disclosure.charged).toBe(true);
    if (fee.disclosure.charged === true) {
      expect(fee.disclosure.chargedOn).toBe("currency_in");
      expect(fee.disclosure.tokenAddress).toBe(base.virtual);
      expect(fee.disclosure.tokenSymbol).toBe("VIRTUAL");
      expect(fee.disclosure.feeAmountDecimal).toBe("0.0025");
      expect(fee.disclosure.receiver).toBe(VEX_TREASURY_EVM);
      expect(fee.disclosure.collectedWhen).toBe("separate_transfer_after_success");
      // The disclosure must state that the transfer runs AFTER the trade, or a
      // reader cannot tell it from a fee taken inside the swap.
      expect(fee.disclosure.note).toMatch(/AFTER the buy confirms/);
    }
  });

  it("refuses a non-positive amount rather than charging nothing quietly", () => {
    expect(() => resolveVirtualsCurveBuyFee({ deployment: base, committedRaw: 0n })).toThrow();
  });
});

describe("resolveVirtualsCurveSellFee - a rate now, an amount after settlement", () => {
  it("never reports the sell fee as charged", () => {
    const fee = resolveVirtualsCurveSellFee({ deployment: base, estimatedProceedsRaw: 10n ** 18n });
    expect(fee.disclosure.charged).toBe("after_settlement");
    if (fee.disclosure.charged === "after_settlement") {
      expect(fee.disclosure.chargedOn).toBe("currency_out");
      expect(fee.disclosure.estimatedFeeAmountRaw).toBe("2500000000000000");
      expect(fee.disclosure.note).toMatch(/ESTIMATE/);
      // The honest tail: an undecodable settlement means no fee at all.
      expect(fee.disclosure.note).toMatch(/Vex takes no fee at all/);
    }
  });

  it("takes the fee from the PROVEN proceeds, not from a gross figure", () => {
    // A sell whose router gross was 1 VIRTUAL but whose wallet net was 0.99
    // after the curve's tax: charging 25 bps of the gross would overcharge.
    const grossFee = virtualsCurveSellFeeFromProceeds(10n ** 18n);
    const netFee = virtualsCurveSellFeeFromProceeds(990_000_000_000_000_000n);
    expect(netFee).toBeLessThan(grossFee);
    expect(netFee).toBe(2_475_000_000_000_000n);
  });

  it("returns zero rather than throwing when there are no proceeds to charge on", () => {
    // Called after a CONFIRMED trade: a throw here would report a settled trade
    // as failed.
    expect(virtualsCurveSellFeeFromProceeds(0n)).toBe(0n);
    expect(virtualsCurveSellFeeFromProceeds(-1n)).toBe(0n);
    // Dust proceeds floor to no fee at all.
    expect(virtualsCurveSellFeeFromProceeds(399n)).toBe(0n);
  });
});
