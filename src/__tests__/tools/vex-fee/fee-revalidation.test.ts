/**
 * The pre-sign comparison that decides whether a signature may proceed.
 *
 * The subject is `revalidateVexFeeStatement` alone: given the block a person
 * approved and the block this execution just derived, does it refuse, and does
 * the refusal say WHICH figure moved. The venue call sites - and the proof that
 * a refusal happens before any key is touched - live in the two handler suites.
 *
 * Both sides are built through the REAL projection (`toVexFeePreview`), so a
 * case here is a case the recorder would actually have persisted; a hand-written
 * block could assert equality against a shape production cannot produce.
 */

import { describe, expect, it } from "vitest";

import {
  revalidateVexFeeStatement,
  type VexFeeBoundField,
} from "@tools/vex-fee/fee-revalidation.js";
import {
  toVexFeePreview,
  type VexFeePreview,
} from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

const RECEIVER = "0x1111111111111111111111111111111111111111";

/** A charged statement as the Uniswap and KyberSwap builders emit one. */
function charged(overrides: Record<string, unknown> = {}): VexFeePreview {
  const block = toVexFeePreview("uniswap.swap.quote", {
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0x2222222222222222222222222222222222222222",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    receiver: RECEIVER,
    swappedAmountRaw: "997500",
    totalDebitedRaw: "1000000",
    note: "Vex charges 25 bps on the input token.",
    ...overrides,
  });
  if (block === undefined) throw new Error("fixture charged block does not project");
  return block;
}

/** A skipped statement: a dust amount, or a token Vex declines to skim. */
function skipped(overrides: Record<string, unknown> = {}): VexFeePreview {
  const block = toVexFeePreview("uniswap.swap.quote", {
    charged: false,
    bps: 0,
    reason: "the origin token is fee-on-transfer, so a treasury transfer would not deliver the stated amount",
    swappedAmountRaw: "1000000",
    totalDebitedRaw: "1000000",
    note: "No Vex fee was taken on this swap.",
    ...overrides,
  });
  if (block === undefined) throw new Error("fixture skipped block does not project");
  return block;
}

/** The fields a refusal named, or `null` when it did not refuse. */
function movedOn(approved: VexFeePreview, fresh: VexFeePreview): readonly VexFeeBoundField[] | null {
  const verdict = revalidateVexFeeStatement(approved, fresh);
  return verdict.ok ? null : verdict.movedFields;
}

describe("a statement that still holds", () => {
  it("passes when the two blocks are the same charged statement", () => {
    expect(revalidateVexFeeStatement(charged(), charged())).toEqual({ ok: true });
  });

  it("passes when the two blocks are the same skipped statement", () => {
    expect(revalidateVexFeeStatement(skipped(), skipped())).toEqual({ ok: true });
  });

  it("ignores descriptive metadata: a symbol or decimals that resolved differently is not a money change", () => {
    const approved = charged();
    const fresh = charged({ tokenSymbol: "USD Coin", tokenDecimals: 6, feeAmountDecimal: "0.002500" });

    expect(revalidateVexFeeStatement(approved, fresh)).toEqual({ ok: true });
  });

  it("accepts a checksum-casing difference in the receiver - the same EVM address, spelled differently", () => {
    const fresh = charged({ receiver: RECEIVER.toUpperCase().replace("0X", "0x") });

    expect(revalidateVexFeeStatement(charged(), fresh)).toEqual({ ok: true });
  });
});

describe("a statement that no longer holds names the figure that moved", () => {
  it("names the fee amount when only the amount moved", () => {
    // 2501 instead of 2500: one raw unit, and the whole point is that one raw
    // unit of someone else's money is still someone else's money.
    const fresh = charged({ feeAmountRaw: "2501", swappedAmountRaw: "997499" });

    expect(movedOn(charged(), fresh)).toEqual(["feeAmountRaw", "netAmountRaw"]);
    const verdict = revalidateVexFeeStatement(charged(), fresh);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("vex_fee_statement_changed");
    expect(verdict.summary).toContain("the Vex fee amount");
  });

  it("names the rate when the bps moved", () => {
    // 50 bps on the same total: a doubled fee, and a doubled remainder loss.
    const fresh = charged({ bps: 50, feeAmountRaw: "5000", swappedAmountRaw: "995000" });

    expect(movedOn(charged(), fresh)).toEqual(["bps", "feeAmountRaw", "netAmountRaw"]);
  });

  it("names the receiver when the fee would go somewhere else", () => {
    const fresh = charged({ receiver: "0x3333333333333333333333333333333333333333" });

    const verdict = revalidateVexFeeStatement(charged(), fresh);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.movedFields).toEqual(["receiver"]);
    // The figure is named; the address itself never reaches the message.
    expect(verdict.summary).toBe("the address the fee is paid to");
    expect(verdict.summary).not.toContain("0x");
  });

  it("names the amount sent to the venue when the split routes a different remainder", () => {
    // A split that still adds up, over a larger total: the same fee is taken,
    // but a different amount reaches the venue and a different amount leaves
    // the wallet. Both figures are named.
    const fresh = charged({ totalDebitedRaw: "1002500", swappedAmountRaw: "1000000" });

    expect(movedOn(charged(), fresh)).toEqual(["netAmountRaw", "totalDebitedRaw"]);
  });

  it("names the total debited when the wallet would be charged more overall", () => {
    const approved = charged();
    const fresh = charged({ feeAmountRaw: "5000", totalDebitedRaw: "1002500" });

    expect(movedOn(approved, fresh)).toEqual(["feeAmountRaw", "totalDebitedRaw"]);
  });
});

describe("the disposition itself flipping", () => {
  it("refuses a fee that appeared after a quote said none would be taken", () => {
    const verdict = revalidateVexFeeStatement(skipped(), charged());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("vex_fee_statement_changed");
    // `charged` carries the difference; the charged-only fields are not
    // reported beside it, because one of the two statements has no fee at all.
    expect(verdict.movedFields).toEqual(["charged", "bps", "netAmountRaw"]);
    expect(verdict.movedFields).not.toContain("feeAmountRaw");
    expect(verdict.movedFields).not.toContain("receiver");
    expect(verdict.summary).toContain("whether a Vex fee is taken at all");
  });

  it("refuses a fee that vanished after a quote said one would be taken", () => {
    const verdict = revalidateVexFeeStatement(charged(), skipped());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.movedFields).toContain("charged");
    expect(verdict.summary).toContain("whether a Vex fee is taken at all");
  });
});

describe("fail-closed states", () => {
  it("refuses when the approved row states no fee at all", () => {
    const verdict = revalidateVexFeeStatement(undefined, charged());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("vex_fee_statement_missing");
    expect(verdict.movedFields).toEqual([]);
  });

  it("refuses when this execution cannot state its own fee in the persisted shape", () => {
    const verdict = revalidateVexFeeStatement(charged(), undefined);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("vex_fee_statement_underivable");
    expect(verdict.movedFields).toEqual([]);
  });

  it("refuses when both are absent - an unstated fee is never equal to an unstated fee", () => {
    const verdict = revalidateVexFeeStatement(undefined, undefined);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("vex_fee_statement_missing");
  });
});

describe("amounts are compared by value, not by spelling", () => {
  it("treats a leading-zero amount as the same amount", () => {
    // A block that crossed JSONB can legitimately come back spelled with a
    // leading zero; refusing a swap for that would be a false refusal.
    const approved = charged();
    const fresh: VexFeePreview = { ...approved, feeAmountRaw: "0002500" };

    expect(revalidateVexFeeStatement(approved, fresh)).toEqual({ ok: true });
  });
});
