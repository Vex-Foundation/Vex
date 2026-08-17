/**
 * The leg keys a Morpho market result carries, which are the contract the app's
 * ledger draws its leg line from.
 *
 * THIS FIXES A LIVE DEFECT. Before these keys existed a confirmed Morpho
 * execution rendered NO leg line at all: the result carried the amounts and
 * never said which tokens they were in. Two properties are pinned here because
 * the renderer depends on both and neither is obvious:
 *
 *   1. ONE SIDE ONLY. A Blue market operation moves one token in one direction,
 *      so exactly one of `tokenIn`/`tokenOut` appears. Mirroring the absent side
 *      would claim a movement that never happened.
 *   2. DOTTED AMOUNTS. The renderer's amount grammar runs untrusted, so a bare
 *      integer is indistinguishable from a RAW base-unit amount and prints
 *      NOTHING rather than risk showing 5 base units as 5 tokens. The trailing
 *      `.0` is what tells them apart.
 */

import { describe, expect, it } from "vitest";

import type { MorphoBorrowLeg } from "../../../../../tools/morpho/mutations.js";
import {
  morphoMarketLegKeys,
  morphoSettledLegKeys,
} from "../../../../../vex-agent/tools/protocols/morpho/handlers/market-shared.js";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function legOf(over: Partial<MorphoBorrowLeg>): MorphoBorrowLeg {
  return {
    direction: "out",
    tokenAddress: USDC,
    tokenSymbol: "USDC",
    decimals: 6,
    amountRaw: "500000000",
    ...over,
  };
}

describe("morpho market leg keys", () => {
  it("names ONLY the side that moved, for a wallet that RECEIVES", () => {
    const keys = morphoMarketLegKeys(legOf({ direction: "out" }));
    expect(keys).toEqual({ tokenOut: "USDC", amountOut: "500.0" });
    expect(keys["tokenIn"]).toBeUndefined();
  });

  it("names ONLY the side that moved, for a wallet that SENDS", () => {
    const keys = morphoMarketLegKeys(legOf({ direction: "in" }));
    expect(keys).toEqual({ tokenIn: "USDC", amountIn: "500.0" });
    expect(keys["tokenOut"]).toBeUndefined();
  });

  it("falls back to the LOWER-CASE address when the chain gave no symbol", () => {
    const keys = morphoMarketLegKeys(legOf({ tokenSymbol: null }));
    expect(keys["tokenOut"]).toBe(USDC);
  });

  it("keeps a whole-token amount DOTTED so it cannot read as raw base units", () => {
    // 5 USDC at 6 decimals renders as "5" from formatUnits, which the renderer
    // would refuse to print at all.
    const keys = morphoMarketLegKeys(legOf({ amountRaw: "5000000" }));
    expect(keys["amountOut"]).toBe("5.0");
  });

  it("preserves a fractional amount exactly rather than re-rounding it", () => {
    const keys = morphoMarketLegKeys(legOf({ amountRaw: "1234567" }));
    expect(keys["amountOut"]).toBe("1.234567");
  });

  it("names the token but NO amount for a repayment by shares", () => {
    // The asset cost is decided on chain when the shares burn, so there is no
    // amount to state yet. A hopeful number here would be a claim the wallet
    // never authorised.
    const keys = morphoMarketLegKeys(legOf({ direction: "in", amountRaw: null }));
    expect(keys).toEqual({ tokenIn: "USDC" });
  });

  it("uses the PROVEN settled amount once the receipt has been read", () => {
    const keys = morphoSettledLegKeys(legOf({ direction: "in", amountRaw: null }), "500.005281");
    expect(keys).toEqual({ tokenIn: "USDC", amountIn: "500.005281" });
  });

  it("dots a whole-number settled amount too", () => {
    expect(morphoSettledLegKeys(legOf({}), "500")["amountOut"]).toBe("500.0");
  });

  it("reads an 8-decimal collateral leg at ITS OWN scale, not the loan token's", () => {
    // The market this lane was proven against pairs 8-decimal cbBTC collateral
    // against 6-decimal USDC debt. Reading one with the other's scale is the
    // hundredfold error rules/90 names.
    const keys = morphoMarketLegKeys(
      legOf({ direction: "in", tokenSymbol: "cbBTC", decimals: 8, amountRaw: "50000000" }),
    );
    expect(keys).toEqual({ tokenIn: "cbBTC", amountIn: "0.5" });
  });
});
