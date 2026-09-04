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
 *   - the seven tool ids the channel now covers get NO args-derived line, so one
 *     card can never carry two derivations of one money figure;
 *   - a caller-supplied `fee` / `feeBps` / `feeReceiver` / `feeAmount` NEVER
 *     reaches the line that remains (the standing decree: a model-chosen fee is
 *     an overcharge vector);
 *   - a fee that cannot be known before signing (a Trench SELL) is stated as
 *     unknown rather than given a number.
 */

import { describe, it, expect } from "vitest";
import {
  describeApprovalVexFee,
  describeBoundVexFee,
} from "@vex-agent/engine/core/approval-vex-fee.js";
import type { VexFeePreview } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/index.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/index.js";
import { TRENCH_FEE_BPS } from "@tools/trench-express/fee/index.js";

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
    expect([KYBERSWAP_FEE_BPS, UNISWAP_FEE_BPS, BRIDGE_FEE_BPS, TRENCH_FEE_BPS]).toEqual([
      25, 25, 25, 25,
    ]);
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

describe("describeApprovalVexFee", () => {
  it("the seven tool ids the typed channel covers get NO args-derived line", () => {
    // Two derivations of one money figure is two figures. These ids are served
    // by `describeBoundVexFee` from the matched quote's own statement.
    for (const toolId of [
      "BridgeExecute",
      "BridgeExecuteRelay",
      "SwapExecuteUniswap",
      "uniswap.swap.execute",
      "kyberswap.swap.execute",
      "relay.bridge",
      "khalani.bridge",
    ]) {
      expect(
        describeApprovalVexFee(toolId, {
          chain: "base",
          tokenIn: "ETH",
          tokenOut: "0xdeadbeef",
          amountIn: "1.5",
          fromToken: "0xUSDC",
          amountRaw: "1000000",
        }),
      ).toBeUndefined();
    }
  });

  it("trench BUY - fee on the ETH spent, charged only after the trade confirms", () => {
    const line = describeApprovalVexFee("trench.trade_execute", {
      tokenIn: "ETH",
      tokenOut: "0xcurve",
      amountIn: "0.01",
    });
    expect(line).toContain("0.000025 ETH");
    expect(line).toContain("after the trade confirms");
  });

  it("trench SELL - the ETH proceeds do not exist yet, so NO number is claimed", () => {
    const line = describeApprovalVexFee("trench.trade_execute", {
      tokenIn: "0xcurve",
      tokenOut: "ETH",
      amountIn: "1000",
    });
    expect(line).toContain("ETH you receive");
    expect(line).toContain("not known until");
    expect(line).not.toMatch(/\d+\.\d+ ETH/);
  });

  it("solana.swap.execute is NOT covered here - Jupiter has its own feeDisclosure", () => {
    expect(
      describeApprovalVexFee("solana.swap.execute", { amountIn: "1", tokenIn: "SOL" }),
    ).toBeUndefined();
  });

  it("a fee-free venue (Pendle) and a read tool get no line at all", () => {
    expect(describeApprovalVexFee("pendle.pt.buy", { amountIn: "1" })).toBeUndefined();
    expect(describeApprovalVexFee("kyberswap.swap.quote", { amountIn: "1" })).toBeUndefined();
  });

  it("a missing or malformed amount yields NO line rather than a fabricated fee", () => {
    expect(describeApprovalVexFee("trench.trade_execute", { tokenIn: "ETH" })).toBeUndefined();
    expect(
      describeApprovalVexFee("trench.trade_execute", { tokenIn: "ETH", amountIn: "1e18" }),
    ).toBeUndefined();
  });

  it("a caller-supplied fee param can NEVER move the disclosed rate or amount", () => {
    const honest = describeApprovalVexFee("trench.trade_execute", {
      tokenIn: "ETH",
      amountIn: "1.5",
    });
    const spoofed = describeApprovalVexFee("trench.trade_execute", {
      tokenIn: "ETH",
      amountIn: "1.5",
      fee: "500",
      feeBps: 9999,
      feeAmount: "1.4",
      feeReceiver: "0xattacker",
    });
    expect(spoofed).toBe(honest);
    expect(spoofed).not.toContain("9999");
    expect(spoofed).not.toContain("0xattacker");
  });
});
