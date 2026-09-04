/**
 * The pre-sign comparison that holds a bridge execute to the Vex fee statement
 * its approval was granted on.
 *
 * The property under test is not "two objects are deep-equal". It is that every
 * way the money can move between the quote and the signature is NAMED: the
 * disposition flipping in either direction, the exact atomic amounts, the
 * treasury address, and the rate. A comparison that missed one of those would
 * let a fee nobody was shown reach a signature, which is the whole reason this
 * module exists.
 *
 * The comparison is pure, so this suite is a table over the two real shapes:
 * the persisted block a row carries (`VexFeePreview`) and the venue disclosure
 * a Relay or Khalani execute freshly derives (`BridgeFeeDisclosure`).
 */

import { describe, it, expect } from "vitest";

import {
  bridgeFeeStatementChangedMessage,
  checkBridgeFeeStatementUnchanged,
  missingBridgeFeeStatementMessage,
  unauthorizedBridgeQuoteMessage,
} from "@tools/bridge-fee/fee-revalidation.js";
import type { BridgeFeeDisclosure } from "@tools/bridge-fee/index.js";
import type { VexFeePreview } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

const TREASURY = "0xTREASURY";
const QUOTE_TOOL = "relay__bridge_quote_get";

/** The block a row carries after a charged quote: 25 bps of 1_000_000. */
function statedCharged(overrides: Partial<Extract<VexFeePreview, { charged: true }>> = {}): VexFeePreview {
  return {
    v: "vex-fee-v1",
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    receiver: TREASURY,
    totalDebitedRaw: "1000000",
    netAmountRaw: "997500",
    collection: "separate_transfer_after_success",
    ...overrides,
  };
}

/** The block a row carries when the quote declined the fee. */
function statedSkipped(overrides: Partial<Extract<VexFeePreview, { charged: false }>> = {}): VexFeePreview {
  return {
    v: "vex-fee-v1",
    charged: false,
    bps: 0,
    reason: "the origin token is fee-on-transfer (5% tax), so a treasury transfer would not deliver the stated amount",
    totalDebitedRaw: "1000000",
    netAmountRaw: "1000000",
    collection: "separate_transfer_after_success",
    ...overrides,
  };
}

/** What `relayFeeDisclosure` / `resolveKhalaniFeeDisclosure` derive at execute time. */
function derivedCharged(overrides: Partial<Extract<BridgeFeeDisclosure, { charged: true }>> = {}): BridgeFeeDisclosure {
  return {
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    feeUsdEstimate: "0.0025",
    receiver: TREASURY,
    bridgedAmountRaw: "997500",
    totalDebitedRaw: "1000000",
    note: "Vex charges 25 bps on the input token of every bridge.",
    ...overrides,
  };
}

function derivedSkipped(overrides: Partial<Extract<BridgeFeeDisclosure, { charged: false }>> = {}): BridgeFeeDisclosure {
  return {
    charged: false,
    bps: 0,
    reason: "the origin token is flagged as a honeypot, so Vex does not transfer it",
    bridgedAmountRaw: "1000000",
    totalDebitedRaw: "1000000",
    note: "No Vex bridge fee was taken on this bridge.",
    ...overrides,
  };
}

describe("checkBridgeFeeStatementUnchanged - the statement still holds", () => {
  it("passes when the fresh derivation states the same charged fee the card stated", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged(),
      derivedNow: derivedCharged(),
    })).toEqual({ ok: true });
  });

  it("passes when both sides agree no fee is taken, and ignores the two prose reasons", () => {
    // The card's reason and the executor's reason are different sentences for
    // the same decision (dust, fee-on-transfer, honeypot). Comparing prose would
    // refuse bridges over wording; the money is `charged` plus the amounts.
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedSkipped(),
      derivedNow: derivedSkipped(),
    })).toEqual({ ok: true });
  });

  it("passes on a block whose symbol and decimals are unknown, comparing raw figures only", () => {
    // A Solana source on Khalani can carry no readable symbol or decimals. The
    // human amount is unavailable; the atomic figures are not, and they are what
    // the comparison is made of.
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged({ tokenSymbol: null, tokenDecimals: null, feeAmountDecimal: null }),
      derivedNow: derivedCharged({ tokenSymbol: null, tokenDecimals: null, feeAmountDecimal: null }),
    })).toEqual({ ok: true });
  });
});

describe("checkBridgeFeeStatementUnchanged - each field that can move is named", () => {
  it("names `charged` when the card said a fee is taken and the executor now declines it", () => {
    const check = checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged(),
      derivedNow: derivedSkipped(),
    });
    expect(check).toEqual({
      ok: false,
      field: "charged",
      statedOnCard: "charged",
      derivedNow: "not charged",
    });
  });

  it("names `charged` in the other direction: the card said no fee and one would now be taken", () => {
    const check = checkBridgeFeeStatementUnchanged({
      statedOnCard: statedSkipped(),
      derivedNow: derivedCharged(),
    });
    expect(check).toEqual({
      ok: false,
      field: "charged",
      statedOnCard: "not charged",
      derivedNow: "charged",
    });
  });

  it("names `bps` when the rate the card stated is not the rate this execute would take", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged({ bps: 25 }),
      derivedNow: derivedCharged({ bps: 50 }),
    })).toEqual({ ok: false, field: "bps", statedOnCard: "25", derivedNow: "50" });
  });

  it("names `feeAmountRaw` when the exact atomic fee moved", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged(),
      derivedNow: derivedCharged({ feeAmountRaw: "2501", bridgedAmountRaw: "997499" }),
    })).toEqual({ ok: false, field: "feeAmountRaw", statedOnCard: "2500", derivedNow: "2501" });
  });

  it("names `receiver` when the treasury address this execute would pay is not the stated one", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged(),
      derivedNow: derivedCharged({ receiver: "0xSOMEWHEREELSE" }),
    })).toEqual({
      ok: false,
      field: "receiver",
      statedOnCard: TREASURY,
      derivedNow: "0xSOMEWHEREELSE",
    });
  });

  it("names `netAmountRaw` when the amount that would actually be bridged moved", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged(),
      derivedNow: derivedCharged({ bridgedAmountRaw: "990000" }),
    })).toEqual({ ok: false, field: "netAmountRaw", statedOnCard: "997500", derivedNow: "990000" });
  });

  it("names `totalDebitedRaw` when the total that would leave the wallet moved", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedCharged(),
      derivedNow: derivedCharged({ totalDebitedRaw: "2000000" }),
    })).toEqual({ ok: false, field: "totalDebitedRaw", statedOnCard: "1000000", derivedNow: "2000000" });
  });

  it("names `netAmountRaw` on the skipped arm too, where no fee amount exists to compare", () => {
    expect(checkBridgeFeeStatementUnchanged({
      statedOnCard: statedSkipped(),
      derivedNow: derivedSkipped({ bridgedAmountRaw: "999999" }),
    })).toEqual({ ok: false, field: "netAmountRaw", statedOnCard: "1000000", derivedNow: "999999" });
  });
});

describe("the refusal an agent reads", () => {
  it("says the statement no longer holds, names the field, and says nothing was signed", () => {
    const message = bridgeFeeStatementChangedMessage(
      { field: "charged", statedOnCard: "charged", derivedNow: "not charged" },
      QUOTE_TOOL,
    );
    expect(message).toContain("no longer holds");
    expect(message).toContain("would no longer be taken");
    expect(message).toContain("Nothing was signed and nothing was broadcast");
    expect(message).toContain(QUOTE_TOOL);
  });

  it("carries the two atomic figures when an amount moved, so the agent can see what changed", () => {
    const message = bridgeFeeStatementChangedMessage(
      { field: "feeAmountRaw", statedOnCard: "2500", derivedNow: "2501" },
      QUOTE_TOOL,
    );
    expect(message).toContain("2500 raw units");
    expect(message).toContain("2501 raw units");
  });

  it("never puts a treasury address in the text, even though the divergence carries both", () => {
    const message = bridgeFeeStatementChangedMessage(
      { field: "receiver", statedOnCard: TREASURY, derivedNow: "0xSOMEWHEREELSE" },
      QUOTE_TOOL,
    );
    expect(message).not.toContain(TREASURY);
    expect(message).not.toContain("0xSOMEWHEREELSE");
    expect(message).toContain("treasury address");
  });

  it("a bound row with no fee statement fails closed with its own sentence", () => {
    const message = missingBridgeFeeStatementMessage(QUOTE_TOOL);
    expect(message).toContain("no readable Vex fee statement");
    expect(message).toContain("Nothing was signed");
    expect(message).toContain(QUOTE_TOOL);
  });

  it("every row-refusal reason that a fresh quote can fix names the quote tool", () => {
    const reasons = [
      "no_quote", "not_executable",
      "approval_row_superseded", "approved_disclosure_changed", "approval_binding_missing",
    ] as const;
    for (const reason of reasons) {
      const message = unauthorizedBridgeQuoteMessage({ reason, eligibilityKind: undefined }, QUOTE_TOOL);
      expect(message).toContain(QUOTE_TOOL);
    }
  });

  it("a confirmed safety failure does NOT invite a fresh quote, because re-quoting cannot clear it", () => {
    const message = unauthorizedBridgeQuoteMessage(
      { reason: "safety_fail", eligibilityKind: undefined },
      QUOTE_TOOL,
    );
    expect(message).not.toContain(QUOTE_TOOL);
    expect(message).toContain("cannot clear it");
    expect(message).toContain("Nothing was signed or broadcast");
  });

  it("names the recorded eligibility when a newer row authorizes nothing", () => {
    const message = unauthorizedBridgeQuoteMessage(
      { reason: "not_executable", eligibilityKind: "insufficient_balance" },
      QUOTE_TOOL,
    );
    expect(message).toContain("insufficient_balance");
  });
});
