import { decodeFunctionData, decodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI as abi } from "./swap-calldata-guard.js";
import type { SwapOutputCallClient } from "@tools/evm-chains/swap-output-shortfall.js";
import { readSwapOutputWithinDeadline } from "@tools/evm-chains/swap-output-deadline.js";

/**
 * Diagnostic only, after a definitive pre-sign slippage refusal. The one-unit
 * floor is private to eth_call and never returned as a transaction. The
 * approved request stays refused and unchanged. No signer is accepted here.
 * Live Base/Robinhood probes confirmed minReturnAmount=0 itself reverts, while
 * one unit exposes returnAmount without changing the route or its fee fields.
 */
export async function observeRefusedKyberOutput(client: SwapOutputCallClient, account: Address,
  tx: { readonly to: Address; readonly data: Hex; readonly value?: bigint }): Promise<string | null> {
  try {
    const decoded = decodeFunctionData({ abi, data: tx.data });
    const data = decoded.functionName === "swapSimpleMode"
      ? encodeFunctionData({ abi, functionName: decoded.functionName, args: [decoded.args[0],
          { ...decoded.args[1], minReturnAmount: 1n }, decoded.args[2], decoded.args[3]] })
      : encodeFunctionData({ abi, functionName: decoded.functionName, args: [{ ...decoded.args[0],
          desc: { ...decoded.args[0].desc, minReturnAmount: 1n } }] });
    const result = await readSwapOutputWithinDeadline(client, { account, to: tx.to, data, value: tx.value ?? 0n });
    if (result.data === undefined) return null;
    return decodeAbiParameters(abi[0].outputs, result.data)[0].toString();
  } catch { return null; }
}
