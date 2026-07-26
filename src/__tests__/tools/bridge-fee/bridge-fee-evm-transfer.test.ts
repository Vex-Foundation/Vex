/**
 * Vex bridge fee — the EVM transfer leg.
 *
 * Two properties carry real money: a NATIVE input must move value with NO
 * calldata (an ERC-20 `transfer` against a native sentinel would revert and
 * the fee would silently never arrive), and an ERC-20 input must encode a
 * plain `transfer` to the hard-coded treasury — never an `approve`, never a
 * `transferFrom`, never a model-supplied recipient.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress } from "viem";

import { ERC20_ABI } from "../../../constants/chain.js";
import { VEX_TREASURY_EVM } from "../../../lib/vex-treasury.js";
import {
  buildEvmBridgeFeeTransfer,
  isNativeEvmFeeToken,
} from "@tools/bridge-fee/evm-fee-transfer.js";
import { BRIDGE_FEE_RECEIVER_EVM } from "@tools/bridge-fee/constants.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FEE = 3750n;

describe("buildEvmBridgeFeeTransfer — receiver is the pinned treasury", () => {
  it("the receiver constant IS the Vex treasury (never derived from params)", () => {
    expect(BRIDGE_FEE_RECEIVER_EVM).toBe(VEX_TREASURY_EVM);
  });
});

describe("buildEvmBridgeFeeTransfer — ERC-20 input", () => {
  it("encodes transfer(treasury, fee) to the TOKEN contract with zero value", () => {
    const transfer = buildEvmBridgeFeeTransfer(USDC_BASE, FEE);
    expect(transfer.kind).toBe("erc20");
    if (transfer.kind !== "erc20") throw new Error("expected erc20");

    // The call target is the token, not the treasury.
    expect(transfer.to).toBe(getAddress(USDC_BASE));
    expect(transfer.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: transfer.data });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([VEX_TREASURY_EVM, FEE]);
  });

  it("is a plain transfer — NOT an approve (no allowance is involved: it is our own money leg)", () => {
    const transfer = buildEvmBridgeFeeTransfer(USDC_BASE, FEE);
    if (transfer.kind !== "erc20") throw new Error("expected erc20");
    // `approve(address,uint256)` selector.
    expect(transfer.data.startsWith("0x095ea7b3")).toBe(false);
    // `transfer(address,uint256)` selector.
    expect(transfer.data.startsWith("0xa9059cbb")).toBe(true);
  });

  it("checksums a lowercase token address rather than passing it through raw", () => {
    const transfer = buildEvmBridgeFeeTransfer(USDC_BASE.toLowerCase(), FEE);
    if (transfer.kind !== "erc20") throw new Error("expected erc20");
    expect(transfer.to).toBe(getAddress(USDC_BASE));
  });
});

describe("buildEvmBridgeFeeTransfer — NATIVE input", () => {
  it.each([
    ["native", "Khalani's literal sentinel"],
    ["NATIVE", "case-insensitive"],
    ["0x0000000000000000000000000000000000000000", "Relay's RELAY_NATIVE_CURRENCY"],
    ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "the 0xEeee… sentinel"],
  ])("%s (%s) produces a native VALUE transfer, not an ERC-20 call", (token) => {
    expect(isNativeEvmFeeToken(token)).toBe(true);

    const transfer = buildEvmBridgeFeeTransfer(token, FEE);
    expect(transfer.kind).toBe("native");
    if (transfer.kind !== "native") throw new Error("expected native");

    // Value goes straight to the treasury and there is NO calldata field at
    // all — the type makes an ERC-20-shaped native leg unrepresentable.
    expect(transfer.to).toBe(VEX_TREASURY_EVM);
    expect(transfer.value).toBe(FEE);
    expect("data" in transfer).toBe(false);
  });

  it("an ordinary ERC-20 is NOT mistaken for native", () => {
    expect(isNativeEvmFeeToken(USDC_BASE)).toBe(false);
    expect(buildEvmBridgeFeeTransfer(USDC_BASE, FEE).kind).toBe("erc20");
  });
});

describe("buildEvmBridgeFeeTransfer — refuses a non-positive fee", () => {
  it("never builds a zero-value leg (the caller must skip it instead)", () => {
    expect(() => buildEvmBridgeFeeTransfer(USDC_BASE, 0n)).toThrow();
    expect(() => buildEvmBridgeFeeTransfer("native", 0n)).toThrow();
    expect(() => buildEvmBridgeFeeTransfer(USDC_BASE, -1n)).toThrow();
  });
});
