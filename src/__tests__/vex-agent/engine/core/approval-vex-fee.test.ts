/**
 * Vex-fee approval disclosure - two owners, one figure, unspoofable.
 *
 * Pins the money-path invariants the disclosure exists to hold:
 *   - a fee-bearing venue's line is RENDERED FROM THE MATCHED QUOTE's own
 *     statement, never recomputed from arguments, so the card and the executor
 *     cannot state two different numbers;
 *   - the exact atomic figure always travels with what is needed to read it
 *     (symbol and decimals), and a figure the venue could not state is said to
 *     be unavailable rather than guessed;
 *   - the card can express a fee that is NOT taken (dust, fee-on-transfer,
 *     honeypot), which the args-derived line could not represent at all;
 *   - the card can express a fee that is NOT taken, which an args-derived line
 *     could not represent at all.
 *
 * THE ARGS-DERIVED LINE IS GONE, and so are its tests. `describeApprovalVexFee`
 * existed for the ONE tool whose fee could not be stated at quote time - a
 * Trench curve trade, whose sell proceeds do not exist before signing. Migration
 * 108 retired that protocol, its switch was left with no case, and a
 * second derivation of a money figure with no consumer is exactly the thing that
 * must not sit in the tree waiting to be reused. Every remaining fee-bearing
 * venue states its fee ON ITS QUOTE, which is what `describeBoundVexFee`
 * renders and what the cases below pin.
 */

import { describe, it, expect } from "vitest";
import { describeBoundVexFee } from "@vex-agent/engine/core/approval-vex-fee.js";
import type { VexFeePreview } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/index.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function chargedFee(
  overrides: Partial<Extract<VexFeePreview, { charged: true }>> = {},
): VexFeePreview {
  return {
    v: "vex-fee-v1",
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: USDC,
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    receiver: "0xTREASURY",
    totalDebitedRaw: "1000000",
    netAmountRaw: "997500",
    collection: "separate_transfer_after_success",
    ...overrides,
  };
}

function skippedFee(
  overrides: Partial<Extract<VexFeePreview, { charged: false }>> = {},
): VexFeePreview {
  return {
    v: "vex-fee-v1",
    charged: false,
    bps: 0,
    reason:
      "the origin token is fee-on-transfer (3% tax), so a treasury transfer would not deliver the stated amount",
    totalDebitedRaw: "1000000",
    netAmountRaw: "1000000",
    collection: "separate_transfer_after_success",
    ...overrides,
  };
}

describe("describeBoundVexFee", () => {
  it("every venue on this channel charges the SAME product-owner rate (25 bps)", () => {
    expect([KYBERSWAP_FEE_BPS, UNISWAP_FEE_BPS, BRIDGE_FEE_BPS]).toEqual([25, 25, 25]);
  });

  it("charged with decimals known: exact human amount, raw units and decimals together", () => {
    const line = describeBoundVexFee("relay.bridge", chargedFee());
    expect(line).toBe(
      "Vex fee 0.25% (25 bps): 0.0025 USDC | 2500 raw units | 6 decimals,"
      + " taken on the input token as a separate transfer after the bridge confirms;"
      + " 997500 raw units are bridged; paid to 0xTREASURY;"
      + " stated by the matched quote and re-checked before signing.",
    );
  });

  it("charged inside the route: the wording says so, and the noun follows the swap", () => {
    const line = describeBoundVexFee(
      "kyberswap.swap.execute",
      chargedFee({
        collection: "inside_route",
        feeAmountRaw: "25000",
        feeAmountDecimal: "0.025",
        totalDebitedRaw: "10000000",
        netAmountRaw: "9975000",
      }),
    );
    expect(line).toContain("taken on the input token inside this transaction");
    expect(line).toContain("9975000 raw units are swapped");
    expect(line).not.toContain("separate transfer");
  });

  it("charged with decimals unknown: the raw figure stands, and the gap is stated", () => {
    const line = describeBoundVexFee(
      "khalani.bridge",
      chargedFee({ tokenSymbol: null, tokenDecimals: null, feeAmountDecimal: null }),
    );
    expect(line).toContain("2500 raw units | human amount unavailable");
    // Never a guessed decimal, and never a bare number with no unit beside it.
    expect(line).not.toContain("0.0025");
  });

  it("skipped: the card says no fee was taken, why, and that the full amount moves", () => {
    const line = describeBoundVexFee("relay.bridge", skippedFee());
    expect(line).toBe(
      "Vex fee: none on this bridge (the origin token is fee-on-transfer (3% tax),"
      + " so a treasury transfer would not deliver the stated amount);"
      + " the full 1000000 raw units are bridged.",
    );
  });

  it("the operation noun comes from the EXECUTE TOOL ID, so the alias card reads correctly", () => {
    // `SwapExecute` is the name the MCP surface exports and the name the enqueue
    // stores; it carried NO fee line at all before this channel existed.
    expect(describeBoundVexFee("SwapExecute", chargedFee({ collection: "inside_route" })))
      .toContain("raw units are swapped");
    expect(describeBoundVexFee("BridgeExecute", chargedFee())).toContain("after the bridge confirms");
    expect(describeBoundVexFee("BridgeExecuteRelay", chargedFee())).toContain("raw units are bridged");
    expect(describeBoundVexFee("SwapExecuteUniswap", chargedFee())).toContain("after the swap confirms");
  });

  it("an unknown tool id still gets the whole disclosure, with a neutral noun", () => {
    // A fee statement is never dropped for want of a label.
    const line = describeBoundVexFee("some.future.execute", chargedFee());
    expect(line).toContain("2500 raw units");
    expect(line).toContain("997500 raw units are sent");
  });

  it("a symbol the venue could not state degrades to the token address, never to a bare number", () => {
    const line = describeBoundVexFee("relay.bridge", chargedFee({ tokenSymbol: null }));
    expect(line).toContain(`0.0025 ${USDC}`);
  });
});
