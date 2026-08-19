/**
 * The `direct-blue-call` verifier.
 *
 * EVERY TAMPER IS RE-ENCODED BY VIEM, never produced by editing bytes. That is
 * the pattern the E3b-1 bundle fixtures established and it matters: a hand-edited
 * hex string would be rejected by the ABI decoder before any of Vex's own checks
 * ran, so the test would pass while proving nothing. A properly encoded hostile
 * calldata proves the CHECK is what refuses it.
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import { blueAbi } from "@morpho-org/blue-sdk-viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import {
  buildMorphoDirectBorrow,
  buildMorphoDirectWithdraw,
} from "../../../tools/morpho/mutations/borrow-engine.js";
import { verifyMorphoBlueCall } from "../../../tools/morpho/mutations/blue-call-decoder.js";
import type {
  MorphoBorrowIntent,
  MorphoMarketIdentity,
} from "../../../tools/morpho/mutations/borrow-types.js";

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const ATTACKER = "0x00000000000000000000000000000000000bad00" as const;
const LOAN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const COLLATERAL = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;

const MARKET: MorphoMarketIdentity = {
  chainId: 8453,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
  loanToken: LOAN,
  loanDecimals: 6,
  loanSymbol: "USDC",
  collateralToken: COLLATERAL,
  collateralDecimals: 8,
  collateralSymbol: "cbBTC",
  oracle: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
  irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
  lltvRaw: "860000000000000000",
};

const PARAMS = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: MARKET.oracle,
  irm: MARKET.irm,
  lltv: 860_000_000_000_000_000n,
};

const AMOUNT = 500_000_000n;

function intent(overrides: Partial<MorphoBorrowIntent> = {}): MorphoBorrowIntent {
  return {
    operation: "borrow",
    market: MARKET,
    userAddress: WALLET,
    recipient: WALLET,
    amountRaw: AMOUNT,
    sharesRaw: null,
    repayMode: null,
    ...overrides,
  };
}

function borrowCalldata(args: {
  params?: typeof PARAMS; assets?: bigint; shares?: bigint; onBehalf?: string; receiver?: string;
} = {}) {
  return encodeFunctionData({
    abi: blueAbi,
    functionName: "borrow",
    args: [
      args.params ?? PARAMS,
      args.assets ?? AMOUNT,
      args.shares ?? 0n,
      (args.onBehalf ?? WALLET) as typeof WALLET,
      (args.receiver ?? WALLET) as typeof WALLET,
    ],
  });
}

function tx(data: `0x${string}`, overrides: { to?: string; value?: bigint } = {}) {
  return {
    to: (overrides.to ?? MORPHO_BLUE) as typeof MORPHO_BLUE,
    data,
    value: overrides.value ?? 0n,
  };
}

function refusal(run: () => unknown): VexError {
  try {
    run();
  } catch (error) {
    return error as VexError;
  }
  throw new Error("expected a refusal, got none");
}

describe("direct Blue call verifier", () => {
  it("accepts the borrow the engine itself built, round trip", () => {
    const built = buildMorphoDirectBorrow(intent(), PARAMS);
    const report = verifyMorphoBlueCall(built, intent(), PARAMS);

    expect(report.shape).toBe("direct-blue-call");
    expect(report.functionName).toBe("borrow");
    expect(report.verifiedAmountRaw).toBe(AMOUNT.toString());
    expect(report.onBehalf).toBe(WALLET.toLowerCase());
    expect(report.receiver).toBe(WALLET.toLowerCase());
    expect(report.valueRaw).toBe("0");
    expect(report.summary).toContain("6 decimals");
    expect(report.summary).toContain("no standing authorization");
  });

  it("refuses an onBehalf that is not the sender, the field the whole design rests on", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata({ onBehalf: ATTACKER })), intent(), PARAMS));

    expect(error).toBeInstanceOf(VexError);
    expect(error.code).toBe(ErrorCodes.MORPHO_BUNDLE_REJECTED);
    expect(error.message).toContain("onBehalf");
    expect(error.message).toContain("somebody else's debt");
  });

  it("refuses a receiver the intent did not name", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata({ receiver: ATTACKER })), intent(), PARAMS));
    expect(error.message).toContain("send the proceeds to");
    expect(error.message).toContain(ATTACKER.toLowerCase());
  });

  it("refuses an amount that does not match the intent", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata({ assets: AMOUNT * 2n })), intent(), PARAMS));
    expect(error.message).toContain("1000000000 raw units");
    expect(error.message).toContain("500000000");
  });

  it("refuses a SWAPPED ORACLE, which is the attack the market gate exists for", () => {
    // The five parameters ARE the market. A calldata naming a different oracle
    // acts on a different market than the one whose oracle was vouched for, even
    // though every other field still looks right.
    const hostile = { ...PARAMS, oracle: ATTACKER };
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata({ params: hostile })), intent(), PARAMS));

    expect(error.message).toContain("not the ones Vex vouched for");
    expect(error.message).toContain("oracle differ");
  });

  it("refuses a swapped IRM and a swapped LLTV, naming which differed", () => {
    const wrongIrm = { ...PARAMS, irm: ATTACKER };
    expect(refusal(() => verifyMorphoBlueCall(tx(borrowCalldata({ params: wrongIrm })), intent(), PARAMS)).message)
      .toContain("irm differ");

    const wrongLltv = { ...PARAMS, lltv: 980_000_000_000_000_000n };
    expect(refusal(() => verifyMorphoBlueCall(tx(borrowCalldata({ params: wrongLltv })), intent(), PARAMS)).message)
      .toContain("lltv differ");
  });

  it("refuses a borrow naming both assets and shares", () => {
    const error = refusal(() =>
      verifyMorphoBlueCall(tx(borrowCalldata({ assets: AMOUNT, shares: 5n })), intent(), PARAMS));
    expect(error.message).toContain("borrow shares alongside an asset amount");
  });

  it("refuses a call addressed anywhere but the pinned Morpho Blue", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata(), { to: ATTACKER }), intent(), PARAMS));
    expect(error.message).toContain("not to the chain's pinned Morpho Blue");
  });

  it("refuses any native value on the transaction", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata(), { value: 1n }), intent(), PARAMS));
    expect(error.message).toContain("1 wei of native currency");
  });

  it("refuses a DIFFERENT Blue function encoded correctly, such as a disguised repay", () => {
    const repayData = encodeFunctionData({
      abi: blueAbi,
      functionName: "repay",
      args: [PARAMS, AMOUNT, 0n, WALLET, "0x"],
    });
    const error = refusal(() => verifyMorphoBlueCall(tx(repayData), intent(), PARAMS));
    expect(error.message).toContain('calls Morpho Blue\'s "repay"');
    expect(error.message).toContain('must call "borrow"');
  });

  it("refuses the two operations that must go through Bundler3, not direct", () => {
    for (const operation of ["supply_collateral", "repay"] as const) {
      const error = refusal(() =>
        verifyMorphoBlueCall(tx(borrowCalldata()), intent({ operation, repayMode: operation === "repay" ? "assets" : null }), PARAMS));
      expect(error.message).toContain("routed through Bundler3");
    }
  });

  it("refuses calldata that does not decode against the Blue ABI, naming the real cause", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx("0xdeadbeef"), intent(), PARAMS));
    expect(error.message).toContain("did not decode against the Morpho Blue ABI");
  });

  it("accepts a withdrawCollateral, the shape the SDK itself emits directly", () => {
    const data = encodeFunctionData({
      abi: blueAbi,
      functionName: "withdrawCollateral",
      args: [PARAMS, 5_000_000n, WALLET, WALLET],
    });
    const report = verifyMorphoBlueCall(
      tx(data),
      intent({ operation: "withdraw_collateral", amountRaw: 5_000_000n }),
      PARAMS,
    );

    expect(report.functionName).toBe("withdrawCollateral");
    expect(report.verifiedAmountRaw).toBe("5000000");
    // The collateral leg carries the COLLATERAL token's scale, not the loan's.
    expect(report.summary).toContain("8 decimals");
    expect(report.summary).toContain("cbBTC");
  });
});

/**
 * THE SUPPLIER'S WITHDRAWAL, the third operation this shape carries.
 *
 * It exists as a direct Blue call for a MEASURED reason rather than a stylistic
 * one: the SDK's own `blue.withdraw()` builds a Bundler3 bundle whose single
 * requirement is `blueAuthorization`, the standing GeneralAdapter1 grant the
 * owner forbids (fixture `agents_dm/morpho-e3/fixtures/
 * base-market-supply-withdraw.json`, captures[1].requirements[0]). So Vex
 * encodes it, and then reads its own bytes back with the same suspicion it
 * applies to the SDK's.
 */
describe("verifyMorphoBlueCall: the supplier's direct withdrawal", () => {
  const withdrawIntent = intent({ operation: "withdraw" });

  function withdrawCalldata(args: {
    assets?: bigint; shares?: bigint; onBehalf?: string; receiver?: string;
  } = {}) {
    return encodeFunctionData({
      abi: blueAbi,
      functionName: "withdraw",
      args: [
        PARAMS,
        args.assets ?? AMOUNT,
        args.shares ?? 0n,
        (args.onBehalf ?? WALLET) as typeof WALLET,
        (args.receiver ?? WALLET) as typeof WALLET,
      ],
    });
  }

  it("accepts the bytes Vex's own encoder produced, and reads them in the LOAN token's scale", () => {
    const built = buildMorphoDirectWithdraw(withdrawIntent, PARAMS);
    const report = verifyMorphoBlueCall(built, withdrawIntent, PARAMS);

    expect(report.functionName).toBe("withdraw");
    expect(report.verifiedAmountRaw).toBe(AMOUNT.toString());
    expect(report.onBehalf).toBe(WALLET.toLowerCase());
    expect(report.receiver).toBe(WALLET.toLowerCase());
    // A withdrawal of SUPPLIED assets moves the loan token at 6 decimals, not
    // the 8-decimal collateral. Reading the wrong scale here would misreport the
    // size by a hundredfold.
    expect(report.summary).toContain("USDC (6 decimals)");
    expect(report.summary).not.toContain("cbBTC");
  });

  it("refuses a withdrawal credited to somebody else's supply position", () => {
    const error = refusal(() =>
      verifyMorphoBlueCall(tx(withdrawCalldata({ onBehalf: ATTACKER })), withdrawIntent, PARAMS));

    expect(error.code).toBe(ErrorCodes.MORPHO_BUNDLE_REJECTED);
    expect(error.message).toContain(ATTACKER.toLowerCase());
  });

  it("refuses a withdrawal paid to an address the intent never named", () => {
    const error = refusal(() =>
      verifyMorphoBlueCall(tx(withdrawCalldata({ receiver: ATTACKER })), withdrawIntent, PARAMS));

    expect(error.message).toContain(ATTACKER.toLowerCase());
  });

  it("refuses a withdrawal naming SUPPLY SHARES alongside an asset amount", () => {
    const error = refusal(() =>
      verifyMorphoBlueCall(tx(withdrawCalldata({ shares: 7n })), withdrawIntent, PARAMS));

    expect(error.message).toContain("supply shares alongside an asset amount");
  });

  it("refuses a withdrawal whose calldata moves a different amount than the intent", () => {
    const error = refusal(() =>
      verifyMorphoBlueCall(tx(withdrawCalldata({ assets: AMOUNT * 2n })), withdrawIntent, PARAMS));

    expect(error.message).toContain((AMOUNT * 2n).toString());
  });

  it("refuses a DIRECT Blue call for a market supply, which is a bundle in this lane", () => {
    const error = refusal(() =>
      verifyMorphoBlueCall(tx(withdrawCalldata()), intent({ operation: "supply" }), PARAMS));

    expect(error.message).toContain("routed through Bundler3");
  });

  it("refuses a withdrawal whose calldata calls `borrow` instead", () => {
    const error = refusal(() => verifyMorphoBlueCall(tx(borrowCalldata()), withdrawIntent, PARAMS));

    expect(error.message).toContain('must call "withdraw"');
  });
});
