/**
 * The Vex fee line on the approval card, end to end.
 *
 * WHAT THIS BINDS. The fee a person approves must be the fee the executor
 * takes. Until this lane the card RECOMPUTED it from the tool's arguments while
 * the executor decided the real disposition afterwards, so the two could differ
 * and no revalidation could notice (Studio's whole-card rebuild recomputed the
 * identical wrong string). The fix makes the fee a statement ON THE QUOTE,
 * persisted in the row and carried to the card on a typed channel.
 *
 * So these experiments drive the REAL chain a person's card comes down:
 * `safety_detail` as it comes back out of JSONB -> the gate's own reader
 * (`vexFeeFromSafetyDetail`) -> the REAL approval gate (`evaluateApprovalGate`)
 * -> the REAL card builder (`buildApprovalIntentPreview`), and assert on the
 * rendered line. Nothing is faked: every one of those is the production
 * function, and the manifest is the production manifest.
 *
 * The `SwapExecute` case is the one the defect report named: that card carried
 * NO fee line whatsoever, because the old owner keyed on a tool name the alias
 * router had already resolved past.
 */

import { describe, it, expect } from "vitest";

import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { evaluateApprovalGate } from "@vex-agent/tools/protocols/runtime/gates.js";
import { buildApprovalIntentPreview } from "@vex-agent/engine/core/approval-runtime/enqueue.js";
import { vexFeeFromSafetyDetail } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

const TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SWAP_PARAMS = { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };

/**
 * The persisted block of a KyberSwap row, written as plain JSON because that is
 * how it comes back out of `safety_detail`. The gate's reader, not this
 * fixture, is what types it.
 */
const KYBER_FEE = {
  v: "vex-fee-v1",
  charged: true,
  bps: 25,
  chargedOn: "currency_in",
  tokenAddress: TOKEN_IN,
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  feeAmountRaw: "25000",
  feeAmountDecimal: "0.025",
  receiver: "0xTREASURY",
  totalDebitedRaw: "10000000",
  netAmountRaw: "9975000",
  collection: "inside_route",
};

/** The same row, but for a token whose decimals the venue could not read. */
const UNREADABLE_DECIMALS_FEE = {
  ...KYBER_FEE,
  tokenSymbol: null,
  tokenDecimals: null,
  feeAmountDecimal: null,
};

/** A quote that states the fee was NOT taken, and why. */
const SKIPPED_FEE = {
  v: "vex-fee-v1",
  charged: false,
  bps: 0,
  reason: "the origin token is fee-on-transfer (3% tax), so a treasury transfer would not deliver the stated amount",
  totalDebitedRaw: "10000000",
  netAmountRaw: "10000000",
  collection: "inside_route",
};

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "00000000-0000-4000-8000-000000000001",
  };
}

/**
 * Run one row's `safety_detail` down the whole card path under the tool name a
 * person's approval would actually be enqueued under, and hand back what they
 * would read.
 *
 * `enqueuedName` is deliberately separate from the manifest id: over MCP the
 * enqueued name is the ALIAS the model called, which is the whole reason the
 * channel must be name-independent.
 */
function cardFor(
  safetyDetail: Record<string, unknown>,
  options: { readonly manifestId?: string; readonly enqueuedName?: string } = {},
): Record<string, unknown> {
  const manifestId = options.manifestId ?? "kyberswap.swap.execute";
  const vexFee = vexFeeFromSafetyDetail(safetyDetail);
  const manifest = getProtocolManifest(manifestId);
  if (!manifest) throw new Error(`${manifestId} manifest missing`);
  const pending = evaluateApprovalGate(
    manifest,
    { toolId: manifestId },
    SWAP_PARAMS,
    ctx(),
    "pass",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vexFee,
  );
  if (pending === undefined) throw new Error("expected a pending-approval result");
  return buildApprovalIntentPreview({
    toolName: options.enqueuedName ?? manifestId,
    toolArgs: SWAP_PARAMS,
    result: pending,
  }).criticalArgs;
}

function feeLine(
  safetyDetail: Record<string, unknown>,
  options: { readonly manifestId?: string; readonly enqueuedName?: string } = {},
): string {
  const value = cardFor(safetyDetail, options).vexFee;
  if (typeof value !== "string") throw new Error("the card carried no Vex fee line");
  return value;
}

describe("the approval card's Vex fee line", () => {
  it("states the rate, the exact amount, its units and where the money goes", () => {
    const line = feeLine({ vexFee: KYBER_FEE });
    expect(line).toContain("Vex fee 0.25% (25 bps)");
    // Rule 90: a raw amount never travels without what is needed to read it.
    expect(line).toContain("0.025 USDC | 25000 raw units | 6 decimals");
    expect(line).toContain("9975000 raw units are swapped");
    expect(line).toContain("paid to 0xTREASURY");
    // And what the number IS: the quote's own statement, re-checked at signing.
    expect(line).toContain("stated by the matched quote and re-checked before signing");
  });

  it("states WHEN the money leaves, which the args-derived line only implied", () => {
    expect(feeLine({ vexFee: KYBER_FEE })).toContain("inside this transaction");
    expect(
      feeLine({ vexFee: { ...KYBER_FEE, collection: "separate_transfer_after_success" } }),
    ).toContain("as a separate transfer after the swap confirms");
  });

  it("says the human amount is unavailable rather than guessing a scale", () => {
    const line = feeLine({ vexFee: UNREADABLE_DECIMALS_FEE });
    expect(line).toContain("25000 raw units | human amount unavailable");
    expect(line).not.toContain("0.025");
  });

  it("can say the fee was NOT taken, which the old card could not express at all", () => {
    // Dust, fee-on-transfer and honeypot skips were decided by the executor
    // AFTER approval; the card always claimed the fee was charged.
    const line = feeLine({ vexFee: SKIPPED_FEE });
    expect(line).toContain("Vex fee: none on this swap");
    expect(line).toContain("fee-on-transfer (3% tax)");
    expect(line).toContain("the full 10000000 raw units are swapped");
    expect(line).not.toContain("25 bps");
  });

  it("reaches the SwapExecute alias card, which carried no fee line at all", () => {
    // THE DEFECT: the MCP surface exports `SwapExecute`, the enqueue stores that
    // name, and the old owner keyed its fee table on the dotted venue id. A
    // person was asked to approve a swap whose 25 bps fee was itemised nowhere.
    const line = feeLine({ vexFee: KYBER_FEE }, { enqueuedName: "SwapExecute" });
    expect(line).toContain("Vex fee 0.25% (25 bps)");
    expect(line).toContain("9975000 raw units are swapped");
  });

  it("carries the same statement under the bridge aliases", () => {
    for (const enqueuedName of ["BridgeExecute", "BridgeExecuteRelay", "relay.bridge"]) {
      const line = feeLine(
        { vexFee: { ...KYBER_FEE, collection: "separate_transfer_after_success" } },
        { manifestId: "relay.bridge", enqueuedName },
      );
      expect(line).toContain("after the bridge confirms");
      expect(line).toContain("9975000 raw units are bridged");
    }
  });

  it("cannot be moved by a fee argument the model supplies", () => {
    // `vexFee` is not in PREVIEW_KEY_ALLOWLIST and the line is built from the
    // row, so a spoofed rate, amount or receiver reaches neither the fee line
    // nor any other field of the card.
    const manifest = getProtocolManifest("kyberswap.swap.execute");
    if (!manifest) throw new Error("kyberswap.swap.execute manifest missing");
    const spoofed = {
      ...SWAP_PARAMS,
      feeBps: 9999,
      feeReceiver: "0xattacker",
      vexFee: "Vex fee: none at all",
    };
    const pending = evaluateApprovalGate(
      manifest,
      { toolId: "kyberswap.swap.execute" },
      spoofed,
      ctx(),
      "pass",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      vexFeeFromSafetyDetail({ vexFee: KYBER_FEE }),
    );
    if (pending === undefined) throw new Error("expected a pending-approval result");
    const criticalArgs = buildApprovalIntentPreview({
      toolName: "kyberswap.swap.execute",
      toolArgs: spoofed,
      result: pending,
    }).criticalArgs;
    expect(String(criticalArgs.vexFee)).toContain("25000 raw units");
    expect(String(criticalArgs.vexFee)).not.toContain("9999");
    expect(String(criticalArgs.vexFee)).not.toContain("0xattacker");
    expect(String(criticalArgs.vexFee)).not.toContain("none at all");
    expect(criticalArgs).not.toHaveProperty("feeBps");
    expect(criticalArgs).not.toHaveProperty("feeReceiver");
  });

  it("grows no line at all when the row carries no statement", () => {
    // In production the gate refuses such a call, so no card is built; if one
    // ever were, it must state nothing rather than a fabricated or partial line.
    const criticalArgs = cardFor({});
    expect(criticalArgs.vexFee).toBeUndefined();
    expect(criticalArgs.safety).toBe("pass");
  });

  it("is rendered whole, never through the argument cutter", () => {
    // `coerceSummaryValue` cuts an allow-listed ARGUMENT at 200 characters. The
    // fee line is longer than that and must not travel that path: the tail is
    // where the receiver and the re-check promise are.
    const line = feeLine({ vexFee: KYBER_FEE });
    expect(line.length).toBeGreaterThan(200);
    expect(line).not.toContain("…");
    expect(line.endsWith("re-checked before signing.")).toBe(true);
  });
});
