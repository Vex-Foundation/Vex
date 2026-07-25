/**
 * EVM bridge fee leg — Vex's own transfer of the integrator fee to the
 * treasury.
 *
 * This is NOT a pull: the treasury never calls `transferFrom`, so no allowance
 * and no `approve` leg is involved. An ERC-20 input is a plain `transfer`; a
 * NATIVE input is a value transfer with no calldata (an ERC-20 call against a
 * native sentinel address would simply revert).
 */

import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { ERC20_ABI } from "../../constants/chain.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { BRIDGE_FEE_RECEIVER_EVM } from "./constants.js";

/**
 * The three native-input spellings the bridge venues use: Khalani's literal
 * `"native"`, the zero address (Relay's `RELAY_NATIVE_CURRENCY`), and the
 * `0xEeee…EEeE` sentinel. Matched case-insensitively.
 */
const NATIVE_EVM_TOKEN_ALIASES: ReadonlySet<string> = new Set([
  "native",
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

export function isNativeEvmFeeToken(token: string): boolean {
  return NATIVE_EVM_TOKEN_ALIASES.has(token.trim().toLowerCase());
}

/**
 * A ready-to-sign fee transfer. `data` is absent for the native branch so a
 * caller cannot accidentally send calldata with a value transfer.
 */
export type EvmBridgeFeeTransfer =
  | { readonly kind: "native"; readonly to: Address; readonly value: bigint }
  | { readonly kind: "erc20"; readonly to: Address; readonly data: Hex; readonly value: 0n };

/**
 * Build the fee transfer for `feeRaw` smallest units of `tokenAddress`.
 * `feeRaw` must be positive — a zero fee has no leg at all
 * (`BridgeFeeSplit.charged`), and building one anyway would burn gas to move
 * nothing.
 */
export function buildEvmBridgeFeeTransfer(tokenAddress: string, feeRaw: bigint): EvmBridgeFeeTransfer {
  if (feeRaw <= 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "Refusing to build a bridge fee transfer for a non-positive amount.",
    );
  }
  if (isNativeEvmFeeToken(tokenAddress)) {
    return { kind: "native", to: BRIDGE_FEE_RECEIVER_EVM, value: feeRaw };
  }
  return {
    kind: "erc20",
    to: getAddress(tokenAddress),
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [BRIDGE_FEE_RECEIVER_EVM, feeRaw],
    }),
    value: 0n,
  };
}
