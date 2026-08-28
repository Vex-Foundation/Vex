/**
 * Uniswap late-fill adapter. The handler's decoder treats a missing token
 * address as native; Kyber's "both addresses required" gate must not be copied
 * here or a VEX→ETH row declines as "missing a token".
 *
 * Native-out executed amounts are omitted when the row stored no token address:
 * the AgentScan mapper only withholds native-out for the 0xeee/zero sentinels,
 * and a NULL address would go out as an unverifiable ERC-20 claim.
 *
 * A native sentinel (0xeee / zero) is passed to the decoder as `null` — that is
 * its contract for "read this leg from the router's WETH Deposit/Withdrawal".
 * Passing the sentinel through would checksum it as an ERC-20 and miss the wrap
 * events. A throw from checksum or an unknown chain is a named decline, never a
 * throw that would kill the sweep.
 */
import { decodeUniswapExecutedLegs } from "@tools/uniswap/receipt-decoder.js";
import type { ConfirmActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";

import type { VenueDecodeInput, VenueDecodeResult } from "./venue-dispatch.js";

const NATIVE_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

function isNativeStored(address: string | null): boolean {
  return address === null || address.length === 0 || NATIVE_SENTINELS.has(address.toLowerCase());
}

/** Decoder input: NULL / empty / sentinel → native leg (`null`). */
function asDecoderToken(address: string | null): string | null {
  if (address === null || address.length === 0) return null;
  if (NATIVE_SENTINELS.has(address.toLowerCase())) return null;
  return address;
}

export function decodeUniswapRow(input: VenueDecodeInput): VenueDecodeResult {
  const { row } = input;
  const walletAddress = row.walletAddress;
  if (!walletAddress) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "the row carries no wallet address",
    };
  }

  const tokenInAddress = row.tokenInAddress;
  const tokenOutAddress = row.tokenOutAddress;
  let decoded;
  try {
    decoded = decodeUniswapExecutedLegs({
      receipt: { logs: input.logs },
      chainId: row.chainId,
      walletAddress,
      tokenInAddress: asDecoderToken(tokenInAddress),
      tokenOutAddress: asDecoderToken(tokenOutAddress),
    });
  } catch {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "the row's addresses or chain could not be resolved for the uniswap decoder",
    };
  }

  const amounts: ConfirmActivityEventInput = {};
  if (decoded.executedAmountInRaw !== undefined) {
    amounts.executedAmountInRaw = decoded.executedAmountInRaw.toString();
  }
  if (decoded.executedAmountOutRaw !== undefined && !isNativeStored(tokenOutAddress)) {
    amounts.executedAmountOutRaw = decoded.executedAmountOutRaw.toString();
  }

  if (amounts.executedAmountInRaw === undefined && amounts.executedAmountOutRaw === undefined) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "the uniswap decoder proved no reportable executed leg from this receipt",
    };
  }
  return { kind: "decoded", amounts };
}
