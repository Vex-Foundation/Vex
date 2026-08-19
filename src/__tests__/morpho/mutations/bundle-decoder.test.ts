/**
 * The decoder's contract, asserted against REAL captured transactions.
 *
 * Every rejection is asserted BY NAME - the error code AND the words a reader
 * would need to know what was refused. A test that only checks "it threw" would
 * pass just as happily on a decoder that refused the valid deposit too.
 */

import { describe, it, expect } from "vitest";
import type { Address } from "viem";

import { VexError } from "../../../errors.js";
import { verifyMorphoVaultTransaction, describeMorphoBundleAllowlist } from "@tools/morpho/mutations.js";
import {
  BASE_GENERAL_ADAPTER_1,
  BASE_USDC,
  CAPTURED_AMOUNT_RAW,
  CAPTURED_USER,
  CAPTURED_V2_MAX_SHARE_PRICE,
  V1_DEPOSIT_INTENT,
  V1_DEPOSIT_TX,
  V1_WITHDRAW_INTENT,
  V1_WITHDRAW_TX,
  V2_DEPOSIT_INTENT,
  V2_DEPOSIT_TX,
  V2_GENEROUS_CEILING,
  V2_WITHDRAW_INTENT,
  V2_WITHDRAW_TX,
  VAULT_V2,

  pullLegWithReceiver,
  reencodeDepositBundle,
  tamper,
} from "./bundle-fixtures.js";

const BOUNDS = { maxSharePriceCeilingRaw: V2_GENEROUS_CEILING };

function expectRejection(run: () => unknown, code: string, ...phrases: string[]): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(VexError);
    const vexError = err as VexError;
    expect(vexError.code).toBe(code);
    for (const phrase of phrases) {
      expect(`${vexError.message} ${vexError.hint ?? ""}`.toLowerCase()).toContain(phrase.toLowerCase());
    }
    return;
  }
  throw new Error("expected a refusal, but the transaction was accepted");
}

describe("verifyMorphoVaultTransaction - the valid captured shapes", () => {
  it("accepts the real V2 deposit and names both legs", () => {
    const report = verifyMorphoVaultTransaction(V2_DEPOSIT_TX, V2_DEPOSIT_INTENT, BOUNDS);

    expect(report.shape).toBe("bundler3-multicall");
    expect(report.toRole).toBe("bundler3");
    expect(report.valueRaw).toBe("0");
    expect(report.legs).toHaveLength(2);
    expect(report.legs.map((leg) => leg.functionName)).toEqual(["erc20TransferFrom", "erc4626Deposit"]);
    expect(report.legs.every((leg) => leg.targetRole === "generalAdapter1")).toBe(true);
    expect(report.legs.every((leg) => leg.valueRaw === "0")).toBe(true);
    expect(report.legs.every((leg) => leg.skipRevert === false)).toBe(true);
    expect(report.maxSharePriceRaw).toBe(CAPTURED_V2_MAX_SHARE_PRICE.toString());
    expect(report.verifiedAmountRaw).toBe(CAPTURED_AMOUNT_RAW.toString());
    expect(report.verifiedRecipient).toBe(CAPTURED_USER.toLowerCase());
  });

  it("accepts the real V1 deposit, which is the same shape on a different vault", () => {
    const report = verifyMorphoVaultTransaction(V1_DEPOSIT_TX, V1_DEPOSIT_INTENT, {
      maxSharePriceCeilingRaw: 2_000_000_000_000_000n,
    });
    expect(report.shape).toBe("bundler3-multicall");
    expect(report.legs).toHaveLength(2);
  });

  it("accepts the real V2 withdrawal as a DIRECT vault call, not a bundle", () => {
    const report = verifyMorphoVaultTransaction(V2_WITHDRAW_TX, V2_WITHDRAW_INTENT);

    expect(report.shape).toBe("direct-vault-call");
    expect(report.toRole).toBe("vault");
    expect(report.to).toBe(VAULT_V2.toLowerCase());
    // A withdrawal has no share-price leg, so it carries no guard. Reported as
    // null rather than as a zero, which would read as "guard set to nothing".
    expect(report.maxSharePriceRaw).toBeNull();
    expect(report.verifiedAmountRaw).toBe(CAPTURED_AMOUNT_RAW.toString());
  });

  it("accepts the real V1 withdrawal, identical calldata on the V1 vault", () => {
    const report = verifyMorphoVaultTransaction(V1_WITHDRAW_TX, V1_WITHDRAW_INTENT);
    expect(report.shape).toBe("direct-vault-call");
  });

  it("publishes the allowlist it checked against", () => {
    const allowlist = describeMorphoBundleAllowlist();
    expect(allowlist.join(" ")).toContain("multicall");
    expect(allowlist.join(" ")).toContain("erc4626Deposit");
    expect(allowlist.join(" ")).toContain("erc20TransferFrom");
  });
});

describe("verifyMorphoVaultTransaction - refusals, each by name", () => {
  it("refuses a deposit whose entry point is not the pinned Bundler3", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction({ ...V2_DEPOSIT_TX, to: BASE_GENERAL_ADAPTER_1 }, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "not the Bundler3",
      "nothing was signed",
    );
  });

  it("refuses a deposit whose entry selector is not multicall", () => {
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(
          { ...V2_DEPOSIT_TX, data: `0xdeadbeef${V2_DEPOSIT_TX.data.slice(10)}` },
          V2_DEPOSIT_INTENT,
          BOUNDS,
        ),
      "MORPHO_BUNDLE_REJECTED",
      "entry selector",
    );
  });

  it("refuses a leg that targets anything but the pinned GeneralAdapter1", () => {
    // Re-encoded rather than string-patched: the deposit leg is moved onto an
    // unrelated contract with its arguments untouched, which is exactly the
    // attack the target check exists for.
    const tampered = reencodeDepositBundle((legs) => [
      legs[0],
      { ...legs[1], to: "0x00000000000000000000000000000000000000ff" as Address },
    ]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "not the pinned generaladapter1",
    );
  });

  it("refuses a leg marked skipRevert, which Bundler3 would let fail silently", () => {
    const tampered = reencodeDepositBundle((legs) => [legs[0], { ...legs[1], skipRevert: true }]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "skiprevert",
    );
  });

  it("refuses a leg that would move native value even when the outer call does not", () => {
    const tampered = reencodeDepositBundle((legs) => [{ ...legs[0], value: 1n }, legs[1]]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "native currency",
    );
  });

  it("refuses a bundle with no leg that actually deposits into the vault", () => {
    const tampered = reencodeDepositBundle((legs) => [legs[0]]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "carries 1 legs where the captured build",
    );
  });

  // ── The bundle-shape attacks. Every leg below is individually allowlisted,
  // which is exactly why leg-by-leg checking alone was not enough: the harm is
  // in the SHAPE of the list, not in any one entry.

  it("refuses a SECOND pull leg, which would debit the wallet twice for one deposit", () => {
    // The attack in full: two valid erc20TransferFrom legs plus the real
    // deposit. Every leg passes on its own, and with a pre-existing allowance
    // covering both pulls the second debit succeeds and strands its amount in
    // the adapter. Refused on leg count before any of that can happen.
    const tampered = reencodeDepositBundle((legs) => [legs[0], legs[0], legs[1]]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "carries 3 legs where the captured build",
      "second debit of the wallet",
    );
  });

  it("refuses the captured legs in the wrong order", () => {
    const tampered = reencodeDepositBundle((legs) => [legs[1], legs[0]]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "the leg order is part of the shape",
    );
  });

  it("refuses a pull whose destination is not the adapter that then deposits", () => {
    // The right token, the right amount, the wrong address: a total loss of the
    // deposit with nothing else in the bundle looking wrong.
    const tampered = reencodeDepositBundle((legs) =>
      pullLegWithReceiver(legs, "0x000000000000000000000000000000000000dEaD"));
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "pull destination",
      "0x000000000000000000000000000000000000dead",
    );
  });

  it("refuses an extra allowlisted leg appended to an otherwise correct bundle", () => {
    const tampered = reencodeDepositBundle((legs) => [legs[0], legs[1], legs[1]]);
    expectRejection(
      () => verifyMorphoVaultTransaction(tampered, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "carries 3 legs where the captured build",
    );
  });

  it("refuses a leg carrying a selector outside the allowlist", () => {
    // erc4626Mint is a REAL GeneralAdapter1 function and still not allowlisted:
    // the allowlist is what was observed, not what the adapter can do.
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(
          { ...V2_DEPOSIT_TX, data: tamper(V2_DEPOSIT_TX.data, "6ef5eeae", "39029ab6") },
          V2_DEPOSIT_INTENT,
          BOUNDS,
        ),
      "MORPHO_BUNDLE_REJECTED",
      "unknown selector",
    );
  });

  it("refuses an outer transaction that would move native value", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction({ ...V2_DEPOSIT_TX, value: 1n }, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "native currency",
    );
  });

  it("refuses a deposit whose amount is not the amount that was asked for", () => {
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(V2_DEPOSIT_TX, { ...V2_DEPOSIT_INTENT, amountRaw: 999_999n }, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "does not do what was asked",
    );
  });

  it("refuses a deposit whose share recipient is not the intent's", () => {
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(
          V2_DEPOSIT_TX,
          { ...V2_DEPOSIT_INTENT, recipient: "0x000000000000000000000000000000000000dEaD" },
          BOUNDS,
        ),
      "MORPHO_BUNDLE_REJECTED",
      "recipient",
    );
  });

  it("refuses a deposit whose price guard exceeds the ceiling Vex derived", () => {
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(V2_DEPOSIT_TX, V2_DEPOSIT_INTENT, {
          maxSharePriceCeilingRaw: CAPTURED_V2_MAX_SHARE_PRICE - 1n,
        }),
      "MORPHO_BUNDLE_REJECTED",
      "worse price than was authorised",
    );
  });

  it("refuses a deposit when Vex computed no ceiling of its own to check against", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction(V2_DEPOSIT_TX, V2_DEPOSIT_INTENT, {}),
      "MORPHO_BUNDLE_REJECTED",
      "no `maxshareprice` ceiling",
    );
  });

  it("refuses a deposit that arrives in the shape of a withdrawal", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction(V2_WITHDRAW_TX, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "not the Bundler3",
    );
  });

  it("refuses a withdrawal that does not call the vault the request named", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction({ ...V2_WITHDRAW_TX, to: BASE_USDC }, V2_WITHDRAW_INTENT),
      "MORPHO_BUNDLE_REJECTED",
      "rather than the vault",
    );
  });

  it("refuses a withdrawal whose share owner is somebody else", () => {
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(V2_WITHDRAW_TX, {
          ...V2_WITHDRAW_INTENT,
          userAddress: "0x000000000000000000000000000000000000dEaD",
        }),
      "MORPHO_BUNDLE_REJECTED",
      "share owner",
    );
  });

  it("refuses calldata too short to carry a selector at all", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction({ ...V2_DEPOSIT_TX, data: "0x00" }, V2_DEPOSIT_INTENT, BOUNDS),
      "MORPHO_BUNDLE_REJECTED",
      "no readable function selector",
    );
  });

  it("refuses a multicall payload that does not decode", () => {
    expectRejection(
      () =>
        verifyMorphoVaultTransaction(
          { ...V2_DEPOSIT_TX, data: `${V2_DEPOSIT_TX.data.slice(0, 10)}00ff` },
          V2_DEPOSIT_INTENT,
          BOUNDS,
        ),
      "MORPHO_BUNDLE_REJECTED",
      "did not decode",
    );
  });

  it("refuses when the chain has no pinned Morpho contracts at all", () => {
    expectRejection(
      () => verifyMorphoVaultTransaction(V2_DEPOSIT_TX, { ...V2_DEPOSIT_INTENT, chainId: 999_999 }, BOUNDS),
      "MORPHO_CONTRACT_UNAVAILABLE",
      "no bundler3 address on chain 999999",
    );
  });
});
